/**
 * fleetExec.ts — P2 `fleet_exec` tool (fast direct exec + spool fallback).
 *
 * DIRECT path (default): inject via `client.session.promptAsync` into the
 * target session (same daemon, live), then poll `client.session.messages`
 * for the new assistant DONE: line. Never sets noReply — the delegation
 * must land as a normal user bubble so manual takeover keeps working.
 *
 * On SessionBusyError with abortOnBusy: best-effort `client.session.abort`
 * then retry promptAsync once.
 *
 * On direct failure (not found / unreachable → owning daemon asleep):
 * falls back to SPOOL `writeReq` + `readRes` + `cleanupReq` so the owning
 * daemon's inbox watcher can pick it up.
 *
 * mode="spool" skips DIRECT and goes straight to spool.
 * Never throws — all failures render as readable text.
 */

import { tool } from "@opencode-ai/plugin";
import { buildInjectText, parseFleetModel } from "../inbox.js";
import { atomicWriteJson, cleanupReq, readRes, writeReq } from "../fileTransport.js";
import type { FleetEnvelope } from "../fileTransport.js";
import { notifyPath } from "../notify.js";
import { canExecDetail, denyText } from "../auth.js";
import { listRegistry } from "../registry.js";

export interface FleetToolDeps {
  // biome-ignore lint/suspicious/noExplicitAny: v1 plugin client is untyped at the boundary.
  client?: any;
  serverUrl?: string | URL;
}

export const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
export const MAX_EXEC_TIMEOUT_MS = 600_000;
/** Poll cadence for the DIRECT reply wait (matches RESPONSE_POLL_MS). */
export const DIRECT_POLL_MS = 500;

function selfIdOf(context: any): string {
  return (context?.sessionID ?? context?.sessionId ?? "") as string;
}

function toReadableError(err: unknown): string {
  if (err instanceof Error) return err.message || String(err);
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function isBusyError(err: unknown): boolean {
  if (err instanceof Error) {
    const hay = `${err.name} ${err.message}`.toLowerCase();
    return hay.includes("busy");
  }
  try {
    return JSON.stringify(err).toLowerCase().includes("busy");
  } catch {
    return false;
  }
}

/** Direct unreachable signals → owning daemon asleep → spool fallback. */
function isUnreachableError(err: unknown): boolean {
  const hay = (
    err instanceof Error ? `${err.name} ${err.message}` : toReadableError(err)
  ).toLowerCase();
  return (
    hay.includes("not found") ||
    hay.includes("no session") ||
    hay.includes("unknown session") ||
    hay.includes("unreachable") ||
    hay.includes("econnrefused") ||
    hay.includes("fetch failed") ||
    hay.includes("network")
  );
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

function clampTimeoutMs(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : NaN;
  if (Number.isNaN(n)) return DEFAULT_EXEC_TIMEOUT_MS;
  if (n < 1000) return 1000;
  if (n > MAX_EXEC_TIMEOUT_MS) return MAX_EXEC_TIMEOUT_MS;
  return n;
}

function doneLineOf(text: string): string | null {
  const re = /^DONE:\s*(.+?)\s*$/gm;
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) last = m[1];
  return last;
}

function assistantTextOf(
  messages: Array<{ info: any; parts: any[] }>,
  since: number,
): string | null {
  let latest: string | null = null;
  for (const m of messages ?? []) {
    const info = m?.info as any;
    if (!info || info.role !== "assistant") continue;
    const created = typeof info?.time?.created === "number" ? (info.time.created as number) : 0;
    if (created < since) continue;
    const texts: string[] = [];
    for (const p of m?.parts ?? []) {
      if (p && (p as any).type === "text" && typeof (p as any).text === "string") {
        texts.push((p as any).text as string);
      }
    }
    if (texts.length > 0) latest = texts.join("\n");
  }
  return latest;
}

function snippetOf(text: string, max = 200): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max)}…`;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      const err = new Error("aborted");
      err.name = "AbortError";
      reject(err);
    };
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function fleetExecHandler(args: any, context: any, deps?: FleetToolDeps): Promise<string> {
  const client = (deps?.client ?? context?.client ?? (context as any)?.["client"]) as any;
  try {
    const sessionId = typeof args?.sessionId === "string" ? args.sessionId.trim() : "";
    const message = typeof args?.message === "string" ? args.message : "";
    if (sessionId === "") return "fleet_exec failed: sessionId must be a non-empty string";
    if (message.trim() === "") return "fleet_exec failed: message must be a non-empty string";
    const timeoutMs = clampTimeoutMs(args?.timeoutMs);
    const mode = args?.mode === "spool" ? "spool" : "direct";
    const abortOnBusy = args?.abortOnBusy === undefined ? true : args.abortOnBusy !== false;
    const selfId = selfIdOf(context);
    const signal = context?.abort as AbortSignal | undefined;
    const force = args?.force === true;

    // P5 auth gate (role matrix): hold queues, deny renders readable text.
    const freshForAuth = await listRegistry({ includeSelf: true }).catch(() => []);
    try {
      const verdict = await canExecDetail(selfId, sessionId, freshForAuth, { force });
      if (verdict.allowed === "hold") {
        const reqId = `exec-${Date.now()}-${randomSuffix()}`;
        const heldEnvelope = {
          reqId,
          fromCommander: selfId,
          targetSessionId: sessionId,
          message,
          createdAt: Date.now(),
          held: true,
        };
        try {
          await writeReq(reqId, heldEnvelope as FleetEnvelope);
          await atomicWriteJson(notifyPath(reqId), {
            reqId,
            targetSessionId: sessionId,
            fromCommander: selfId,
            done: "",
            replySnippet: "held for approval",
            createdAt: Date.now(),
            held: true,
          });
        } catch {
          // best-effort queue writes
        }
        return `${sessionId} | held for approval, use fleet_allow`;
      }
      if (verdict.allowed === false) {
        return `fleet_exec ${denyText(verdict.reason)}`;
      }
    } catch {
      // auth never blocks on its own failure — fall through to exec.
    }

    const fresh = await listRegistry({ includeSelf: true });
    const entry = fresh.find((e) => e.sessionId === sessionId);
    if (!entry) {
      return `fleet_exec failed: ${sessionId} not in registry (suggest fleet_discover to find live sessions)`;
    }

    const reqId = `exec-${Date.now()}-${randomSuffix()}`;
    const modelRaw = (args as any)?.model as FleetEnvelope["model"];
    const envelope: FleetEnvelope = {
      reqId,
      fromCommander: selfId,
      targetSessionId: sessionId,
      targetDaemonId: entry.daemonId,
      message,
      createdAt: Date.now(),
      hop: 0,
      ...(typeof args?.agent === "string" && args.agent !== "" ? { agent: args.agent } : {}),
      ...(modelRaw !== undefined && modelRaw !== null && modelRaw !== "" ? { model: modelRaw } : {}),
      ...(typeof args?.variant === "string" && args.variant !== "" ? { variant: args.variant } : {}),
      ...(typeof args?.system === "string" && args.system !== "" ? { system: args.system } : {}),
    };
    const inject = buildInjectText(envelope);
    const parsedModel = parseFleetModel(envelope.model);

    if (mode === "direct") {
      const direct = await tryDirect(client, sessionId, inject, envelope, timeoutMs, abortOnBusy, signal);
      if (direct.ok) return direct.text;
      // Fall through to spool only when direct looks like an asleep-daemon
      // failure. Busy/timeout/abort stays a direct error (no spool point:
      // same daemon already failed live).
      if (!direct.fallbackToSpool) return direct.text;
    }

    return await spoolFallback(sessionId, envelope, timeoutMs, signal);
  } catch (err) {
    return `fleet_exec failed: ${toReadableError(err)}`;
  }
}

async function tryDirect(
  client: any,
  sessionId: string,
  inject: string,
  envelope: FleetEnvelope,
  timeoutMs: number,
  abortOnBusy: boolean,
  signal?: AbortSignal,
): Promise<{ ok: boolean; text: string; fallbackToSpool: boolean }> {
  const fail = (text: string, fallbackToSpool: boolean) => ({ ok: false as const, text, fallbackToSpool });
  try {
    if (!client?.session?.promptAsync) {
      return fail(
        `${sessionId} | via:direct | error: direct unavailable (no session.promptAsync on client)`,
        true,
      );
    }
    const body: Record<string, unknown> = {
      parts: [{ type: "text", text: inject }],
    };
    if (envelope.agent) body["agent"] = envelope.agent;
    if (parsedModelOf(envelope)) body["model"] = parsedModelOf(envelope);
    if (envelope.variant) body["variant"] = envelope.variant;
    if (envelope.system) body["system"] = envelope.system;
    // NOTE: never set noReply — delegation must land as a normal user bubble.
    const beforeTime = Date.now();
    try {
      await client.session.promptAsync({ path: { id: sessionId }, body });
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) {
        return fail(`${sessionId} | via:direct | error: aborted`, false);
      }
      if (isBusyError(err) && abortOnBusy) {
        // Best-effort abort then retry once.
        try {
          if (typeof client.session.abort === "function") {
            await client.session.abort({ path: { id: sessionId } });
          }
        } catch {
          // best-effort only
        }
        try {
          await client.session.promptAsync({ path: { id: sessionId }, body });
        } catch (retryErr) {
          if (isAbortError(retryErr) || signal?.aborted) {
            return fail(`${sessionId} | via:direct | error: aborted`, false);
          }
          return fail(
            `${sessionId} | via:direct | error: retry after busy failed: ${toReadableError(retryErr)}`,
            isUnreachableError(retryErr),
          );
        }
      } else {
        return fail(
          `${sessionId} | via:direct | error: promptAsync failed: ${toReadableError(err)}`,
          isUnreachableError(err),
        );
      }
    }
    const reply = await pollDirectReply(client, sessionId, beforeTime, timeoutMs, signal);
    if (reply === null) {
      return fail(
        `${sessionId} | via:direct | error: timeout after ${timeoutMs}ms waiting for DONE: reply`,
        false,
      );
    }
    const done = doneLineOf(reply);
    if (done === null || done.trim() === "") {
      return fail(`${sessionId} | via:direct | error: no trailing DONE: line found`, false);
    }
    return {
      ok: true,
      text: `${sessionId} | via:direct | ok | DONE:${done.trim()} | ${snippetOf(reply)}`,
      fallbackToSpool: false,
    };
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) {
      return fail(`${sessionId} | via:direct | error: aborted`, false);
    }
    return fail(
      `${sessionId} | via:direct | error: ${toReadableError(err)}`,
      isUnreachableError(err),
    );
  }
}

function parsedModelOf(envelope: FleetEnvelope) {
  return parseFleetModel(envelope.model);
}

async function pollDirectReply(
  client: any,
  sessionId: string,
  beforeTime: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string | null> {
  const deadline = beforeTime + timeoutMs;
  for (;;) {
    if (signal?.aborted) throw new Error("aborted");
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    try {
      const raw = await client.session.messages({
        path: { id: sessionId },
        query: { limit: 10 },
      });
      const list = Array.isArray(raw) ? raw : ((raw as any)?.messages ?? (raw as any)?.data ?? []);
      const text = assistantTextOf(Array.isArray(list) ? list : [], beforeTime);
      if (text !== null && doneLineOf(text) !== null) return text;
    } catch (err) {
      if (isUnreachableError(err)) throw err;
      // Transient poll errors: keep polling until the deadline.
    }
    try {
      await abortableSleep(Math.min(DIRECT_POLL_MS, Math.max(0, remaining)), signal);
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) throw err;
    }
    if (Date.now() >= deadline) return null;
  }
}

async function spoolFallback(
  sessionId: string,
  envelope: FleetEnvelope,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  try {
    await writeReq(envelope.reqId, envelope);
  } catch (err) {
    return `${sessionId} | via:spool | error: write failed: ${toReadableError(err)}`;
  }
  try {
    const res = await readRes(envelope.reqId, timeoutMs, signal);
    if (res === null) {
      return `${sessionId} | via:spool | error: timeout after ${timeoutMs}ms waiting for reply (req ${envelope.reqId})`;
    }
    if (res.ok) {
      const reply = (res.reply ?? "").trim();
      const done = doneLineOf(reply);
      if (done === null || done.trim() === "") {
        return `${sessionId} | via:spool | error: no trailing DONE: line found (req ${envelope.reqId})`;
      }
      return `${sessionId} | via:spool | ok | DONE:${done.trim()} | ${snippetOf(reply)}`;
    }
    return `${sessionId} | via:spool | error: ${res.error ?? "worker reported failure with no error text"}`;
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) {
      return `${sessionId} | via:spool | error: aborted`;
    }
    return `${sessionId} | via:spool | error: ${toReadableError(err)}`;
  } finally {
    await cleanupReq(envelope.reqId);
  }
}

export function makeFleetExecTool(deps?: FleetToolDeps) {
  return tool({
    description:
      "Execute a self-contained task on one fleet worker fast via direct promptAsync, falling back to file-spool when the owning daemon is asleep. Returns sessionId | via | ok | DONE line | snippet.",
    args: {
      sessionId: tool.schema.string().describe("Target worker session id (must be in registry)"),
      message: tool.schema
        .string()
        .describe("Self-contained task (goal + files + constraints + done criteria)"),
      agent: tool.schema.string().optional().describe("Optional agent hint replayed on the target"),
      model: tool.schema
        .union([
          tool.schema.string(),
          tool.schema.object({
            providerID: tool.schema.string(),
            modelID: tool.schema.string(),
          }),
        ])
        .optional()
        .describe('Optional model hint ("provider/model" or {providerID, modelID})'),
      variant: tool.schema.string().optional().describe("Optional variant hint replayed on the target"),
      system: tool.schema.string().optional().describe("Optional system prompt replayed on the target"),
      timeoutMs: tool.schema
        .number()
        .optional()
        .describe("Wait for the DONE: reply (default 60000, max 600000)"),
      mode: tool.schema
        .union([tool.schema.literal("direct"), tool.schema.literal("spool")])
        .optional()
        .describe('Exec mode: "direct" (default, with spool fallback) or "spool" (spool only)'),
      abortOnBusy: tool.schema
        .boolean()
        .optional()
        .describe("On SessionBusyError, best-effort abort then retry once (default true)"),
      force: tool.schema
        .boolean()
        .optional()
        .describe("Override commander->commander deny (default false)"),
    },
    execute: async (args, context) => fleetExecHandler(args, context, deps),
  });
}

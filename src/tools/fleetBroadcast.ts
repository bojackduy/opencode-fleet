/**
 * fleetBroadcast.ts — Phase 3 `fleet_broadcast` tool.
 *
 * Fans a self-contained task out to registry workers: one `.req.json`
 * envelope per target via `writeReq()`, then polls for the `.res.json`
 * reply via `readRes()` and cleans up with `cleanupReq()`.
 *
 * Rules:
 * - The message always carries a `DONE:` instruction (appended when missing)
 *   so the worker's InboxWatcher can resolve the reply reliably.
 * - Per-target failures (not in registry, timeout, abort) are captured as
 *   `{ok:false, error}` text — the tool never throws to the commander.
 * - `context.abort` is forwarded to `readRes()` so aborting the commander
 *   turn stops the wait promptly.
 */

import { tool } from "@opencode-ai/plugin";
import { DONE_FOOTER } from "../inbox.js";
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

export const DEFAULT_BROADCAST_TIMEOUT_MS = 60_000;
export const MAX_BROADCAST_TIMEOUT_MS = 600_000;

interface TargetResult {
  sessionId: string;
  ok: boolean;
  reply?: string;
  error?: string;
}

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

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

/** Append the DONE: instruction when the commander's message lacks one. */
export function ensureDoneInstruction(message: string): string {
  if (/DONE:/.test(message)) return message;
  return `${message}\n${DONE_FOOTER}`;
}

function clampTimeoutMs(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : NaN;
  if (Number.isNaN(n)) return DEFAULT_BROADCAST_TIMEOUT_MS;
  if (n < 1000) return 1000;
  if (n > MAX_BROADCAST_TIMEOUT_MS) return MAX_BROADCAST_TIMEOUT_MS;
  return n;
}

function formatResult(r: TargetResult): string {
  if (r.ok) return `${r.sessionId}: ok\n${r.reply ?? ""}`;
  return `${r.sessionId}: error: ${r.error ?? "unknown error"}`;
}

export async function fleetBroadcastHandler(
  args: any,
  context: any,
  deps?: FleetToolDeps,
): Promise<string> {
  void deps;
  try {
    const message = typeof args?.message === "string" ? args.message : "";
    if (message.trim() === "") return "fleet_broadcast failed: message must be a non-empty string";
    const timeoutMs = clampTimeoutMs(args?.timeoutMs);
    const selfId = selfIdOf(context);
    const signal = context?.abort as AbortSignal | undefined;
    const force = args?.force === true;

    // P5 auth gate: broadcast-level check (from must be commander).
    const freshAuth = await listRegistry({ includeSelf: true }).catch(() => []);
    try {
      const verdict = await canExecDetail(selfId, "broadcast", freshAuth, { force });
      if (verdict.allowed === false) {
        return `fleet_broadcast ${denyText(verdict.reason)}`;
      }
      if (verdict.allowed === "hold") {
        const freshHold = await listRegistry({ includeSelf: true });
        const targetsHold = holdTargets(freshHold.map((e) => e.sessionId));
        if (targetsHold.length === 0) return "no workers registered";
        const heldLines = await Promise.all(targetsHold.map((id) => queueHeld(id)));
        return heldLines.join("\n");
      }
    } catch {
      // auth never blocks on its own failure — fall through to broadcast.
    }

    const fresh = await listRegistry({ includeSelf: true });
    const byId = new Map(fresh.map((e) => [e.sessionId, e]));

    function holdTargets(allIds: string[]): string[] {
      const onlyRawInner = Array.isArray(args?.only) ? (args.only as unknown[]) : undefined;
      const onlyInner =
        onlyRawInner && onlyRawInner.length > 0
          ? onlyRawInner.filter((s): s is string => typeof s === "string" && s !== "")
          : undefined;
      if (!onlyInner) return allIds.filter((id) => id !== selfId);
      return onlyInner;
    }

    async function queueHeld(targetSessionId: string): Promise<string> {
      const reqId = `req-${Date.now()}-${randomSuffix()}`;
      try {
        await writeReq(reqId, {
          reqId,
          fromCommander: selfId,
          targetSessionId,
          message: ensureDoneInstruction(message),
          createdAt: Date.now(),
          held: true,
        } as FleetEnvelope);
        await atomicWriteJson(notifyPath(reqId), {
          reqId,
          targetSessionId,
          fromCommander: selfId,
          done: "",
          replySnippet: "held for approval",
          createdAt: Date.now(),
          held: true,
        });
      } catch {
        // best-effort queue writes
      }
      return `${targetSessionId}: held for approval, use fleet_allow`;
    }

    const onlyRaw = Array.isArray(args?.only) ? (args.only as unknown[]) : undefined;
    const only =
      onlyRaw && onlyRaw.length > 0
        ? onlyRaw.filter((s): s is string => typeof s === "string" && s !== "")
        : undefined;

    if (!only) {
      const defaults = fresh.filter((e) => e.sessionId !== selfId);
      if (defaults.length === 0) return "no workers registered";
      return (await Promise.all(defaults.map((e) => sendToOne(e.sessionId, e.daemonId)))).map(
        formatResult,
      ).join("\n");
    }

    const results = await Promise.all(
      only.map(async (id): Promise<TargetResult> => {
        const entry = byId.get(id);
        if (!entry) return { sessionId: id, ok: false, error: "not in registry" };
        return sendToOne(entry.sessionId, entry.daemonId);
      }),
    );
    return results.map(formatResult).join("\n");

    async function sendToOne(targetSessionId: string, targetDaemonId: string): Promise<TargetResult> {
      // P5 per-target role check (commander->commander needs force).
      try {
        const per = await canExecDetail(selfId, targetSessionId, fresh, { force });
        if (per.allowed === "hold") {
          await queueHeld(targetSessionId);
          return { sessionId: targetSessionId, ok: false, error: "held for approval, use fleet_allow" };
        }
        if (per.allowed === false) {
          return { sessionId: targetSessionId, ok: false, error: denyText(per.reason) };
        }
      } catch {
        // auth never blocks on its own failure — fall through to send.
      }
      const reqId = `req-${Date.now()}-${randomSuffix()}`;
      const envelope: FleetEnvelope = {
        reqId,
        fromCommander: selfId,
        targetSessionId,
        targetDaemonId,
        message: ensureDoneInstruction(message),
        createdAt: Date.now(),
        hop: 0,
        ...(typeof args?.agent === "string" && args.agent !== "" ? { agent: args.agent } : {}),
        ...(typeof args?.model === "string" && args.model !== "" ? { model: args.model } : {}),
        ...(typeof args?.variant === "string" && args.variant !== "" ? { variant: args.variant } : {}),
        ...(typeof args?.system === "string" && args.system !== "" ? { system: args.system } : {}),
      };
      try {
        await writeReq(reqId, envelope);
      } catch (err) {
        return { sessionId: targetSessionId, ok: false, error: `write failed: ${toReadableError(err)}` };
      }
      try {
        const res = await readRes(reqId, timeoutMs, signal);
        if (res === null) {
          return {
            sessionId: targetSessionId,
            ok: false,
            error: `timeout after ${timeoutMs}ms waiting for reply (req ${reqId})`,
          };
        }
        if (res.ok) return { sessionId: targetSessionId, ok: true, reply: res.reply ?? "" };
        return {
          sessionId: targetSessionId,
          ok: false,
          error: res.error ?? "worker reported failure with no error text",
        };
      } catch (err) {
        if (isAbortError(err) || signal?.aborted) {
          return { sessionId: targetSessionId, ok: false, error: "aborted" };
        }
        return { sessionId: targetSessionId, ok: false, error: toReadableError(err) };
      } finally {
        await cleanupReq(reqId);
      }
    }
  } catch (err) {
    return `fleet_broadcast failed: ${toReadableError(err)}`;
  }
}

export function makeFleetBroadcastTool(deps?: FleetToolDeps) {
  return tool({
    description:
      "Broadcast a self-contained task to fleet workers and wait for their DONE: replies. Returns one result line per target worker.",
    args: {
      message: tool.schema
        .string()
        .describe("Self-contained task (goal + files + constraints + done criteria)"),
      only: tool.schema
        .array(tool.schema.string())
        .optional()
        .describe("Target session ids; defaults to all registered workers except self"),
      agent: tool.schema.string().optional().describe("Optional agent hint replayed by the worker"),
      model: tool.schema
        .string()
        .optional()
        .describe('Optional model hint ("provider/model") replayed by the worker'),
      variant: tool.schema.string().optional().describe("Optional variant hint replayed by the worker"),
      system: tool.schema.string().optional().describe("Optional system prompt replayed by the worker"),
      timeoutMs: tool.schema
        .number()
        .optional()
        .describe("Per-target wait for the reply (default 60000, max 600000)"),
      force: tool.schema
        .boolean()
        .optional()
        .describe("Override commander->commander deny per target (default false)"),
    },
    execute: async (args, context) => fleetBroadcastHandler(args, context, deps),
  });
}

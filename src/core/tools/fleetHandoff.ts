/**
 * fleetHandoff.ts — P3 `fleet_handoff_back` + `fleet_thread` tools.
 *
 * fleet_handoff_back: worker → commander reverse delegation. Finds the most
 * recent inbound `.req.json` where targetSessionId == self (the commander's
 * original delegation) and sends a correction back to fromCommander:
 * DIRECT via client.session.promptAsync when reachable, else SPOOL writeReq.
 * Returns "handed back to <id> via:direct/spool".
 *
 * fleet_thread: lists .req/.res/.notify triples for a thread as a compact
 * table reqId|from->to|done|snippet. Filter: same reqId (or prefix) or the
 * message carries a `Re: <reqId>` thread ref.
 *
 * Both handlers never throw — all failures render as readable text.
 * Peer text is untrusted (rendered as plain text, never eval'd, no DB writes).
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { depsOf, z } from "../toolDef.js";
import type { ToolDef } from "../toolDef.js";
import type { Runtime } from "../runtime.js";
import { buildInjectText, DONE_FOOTER } from "../inbox.js";
import { chainRefsOf, hopOf, isHopExceeded, loopGuardText, messagesDir, readReq, writeReq } from "../fileTransport.js";
import type { FleetEnvelope } from "../fileTransport.js";
import { listRegistry, fleetKeyOf } from "../registry.js";
import { readNotify } from "../notify.js";
import { passwordForUrl, v2PromptRemote } from "../v2transport.js";
import { callerIdentity } from "./fleetAssign.js";
import {
  gateHandoffSend,
  readHandoffOrigin,
  validateHandoffDelivery,
} from "../ownershipControl.js";

export interface FleetToolDeps {
  // biome-ignore lint/suspicious/noExplicitAny: v1 plugin client is untyped at the boundary.
  client?: any;
  serverUrl?: string | URL;
  rt?: Runtime;
}

export const DEFAULT_THREAD_LIMIT = 10;
export const MAX_THREAD_LIMIT = 50;

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

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

function clampLimit(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : NaN;
  if (Number.isNaN(n)) return DEFAULT_THREAD_LIMIT;
  if (n < 1) return 1;
  if (n > MAX_THREAD_LIMIT) return MAX_THREAD_LIMIT;
  return n;
}

function doneLineOf(text: string): string | null {
  const re = /^DONE:\s*(.+?)\s*$/gm;
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) last = m[1];
  return last;
}

function snippetOf(text: string, max = 80): string {
  const one = (text ?? "").replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max)}…`;
}

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

/** Most recent inbound envelope where targetSessionId == selfId. */
async function findLatestInbound(selfId: string): Promise<FleetEnvelope | null> {
  let files: string[];
  try {
    files = await readdir(messagesDir());
  } catch {
    return null;
  }
  let best: FleetEnvelope | null = null;
  for (const f of files) {
    if (!f.endsWith(".req.json")) continue;
    const reqId = f.slice(0, -".req.json".length);
    let env: FleetEnvelope | null = null;
    try {
      env = await readReq(reqId);
    } catch {
      continue;
    }
    if (!env) continue;
    if (env.targetSessionId !== selfId) continue;
    if (!best || (env.createdAt ?? 0) > (best.createdAt ?? 0)) best = env;
  }
  return best;
}

export async function fleetHandoffBackHandler(
  args: any,
  context: any,
  deps?: FleetToolDeps,
): Promise<string> {
  const client = (deps?.client ?? context?.client ?? (context as any)?.["client"]) as any;
  try {
    const message = typeof args?.message === "string" ? args.message : "";
    if (message.trim() === "") return "fleet_handoff_back failed: message must be a non-empty string";
    const doneRaw = typeof args?.done === "string" ? args.done.trim() : "";
    const selfId = selfIdOf(context);

    const inbound = await findLatestInbound(selfId);
    // Phase B2 durable handoff routing: the worker identity comes from the
    // tool context composite (no spoofing via envelope fields or explicit
    // args — this handler takes no target args), and the handoff routes to
    // the CURRENT owner (transfer-aware) via gateHandoffSend. The persisted
    // origin survives commander-side .req cleanup; the inbound envelope's
    // fromCommander is kept as audit only. When the assignment is gone
    // (unassign raced the handoff) the gate returns a readable unassigned
    // error — never a fallback route to the old origin commander.
    const workerIdent = callerIdentity(context as any, deps?.rt);
    const workerKey =
      workerIdent.sessionId !== "" && workerIdent.daemonId !== ""
        ? fleetKeyOf(workerIdent)
        : null;
    let origin: Awaited<ReturnType<typeof readHandoffOrigin>> = null;
    if (workerKey) {
      try {
        origin = await readHandoffOrigin(workerKey);
      } catch {
        origin = null;
      }
    }
    if (!inbound && !origin) {
      return `fleet_handoff_back failed: no inbound delegation found for this session (no .req.json targeting self${selfId ? ` ${selfId}` : ""} and no durable handoff origin)`;
    }
    // Reverse send gate: resolves the CURRENT owner by composite key,
    // rejecting ambiguity, stale owners, and unassigned workers (fail-closed).
    const gate = await gateHandoffSend(context as any, deps?.rt);
    if (!gate.ok) {
      return `fleet_handoff_back failed: ${gate.error}`;
    }
    // No live .req (commander cleaned up after reading) but a durable
    // origin persists: hand back against the origin thread.
    const threadReqId = origin?.reqId ?? inbound?.reqId ?? "";
    const commanderId = gate.targetSessionId;
    const auditOrigin = origin?.fromCommanderSession ?? inbound?.fromCommander ?? "";

    // Target daemon + runtime come from the gate's composite resolution
    // (never a bare-sessionId scan that could pick a colliding row).
    const targetDaemonId: string | undefined = gate.targetDaemonId;
    const commanderRuntime: "v1" | "v2" = gate.targetRuntime;
    let commanderUrl = "";
    try {
      const fresh = await listRegistry({ includeSelf: true });
      const entry = fresh.find((e) => fleetKeyOf(e) === gate.commanderKey);
      const urlRaw = (entry as { endpoint?: { url?: unknown } } | undefined)?.endpoint?.url;
      if (typeof urlRaw === "string" && urlRaw.trim() !== "") commanderUrl = urlRaw.trim();
      if (commanderUrl === "" && gate.targetDaemonId.startsWith("v2:")) {
        commanderUrl = gate.targetDaemonId.slice("v2:".length);
      }
    } catch {
      // registry is best-effort; spool still works without commanderUrl.
    }

    // P5 loop guard: the reverse handoff extends the chain by one hop.
    // NOTE: handoff_back intentionally bypasses the commander role check
    // (worker->commander reverse is always allowed) but stays loop-guarded.
    // Origin-only handoffs (no live .req) start the chain at hop 1.
    const hop = (inbound ? hopOf(inbound) : 0) + 1;
    if (isHopExceeded({ hop })) {
      return `fleet_handoff_back ${loopGuardText(`handoff-after-${threadReqId}`, hop)}`;
    }

    const reqId = `handoff-${Date.now()}-${randomSuffix()}`;
    const raw =
      `${message.trim()}\nRe: ${threadReqId}` +
      (doneRaw !== "" ? `\nSuggested result: DONE:${doneRaw}` : "") +
      (auditOrigin !== "" && auditOrigin !== commanderId ? `\n(origin: ${auditOrigin})` : "");
    const envelope: FleetEnvelope = {
      reqId,
      kind: "handoff",
      fromCommander: selfId,
      targetSessionId: commanderId,
      ...(targetDaemonId ? { targetDaemonId } : {}),
      // Reverse stamp: workerKey = the sending worker, commanderKey = the
      // current owner at send time, generation = assignment CAS. The
      // receiving commander's watcher revalidates all three plus the durable
      // origin before delivery; only valid handoffs bypass the regular
      // worker-delivery stamp.
      workerKey: gate.workerKey,
      commanderKey: gate.commanderKey,
      generation: gate.generation,
      ...(threadReqId !== "" ? { originReqId: threadReqId } : {}),
      message: raw,
      createdAt: Date.now(),
      hop,
      ...(typeof args?.agent === "string" && args.agent !== "" ? { agent: args.agent } : {}),
      ...(args?.model !== undefined && args.model !== null && args.model !== ""
        ? { model: args.model as FleetEnvelope["model"] }
        : {}),
      ...(typeof args?.variant === "string" && args.variant !== "" ? { variant: args.variant } : {}),
    };
    const inject = buildInjectText(envelope);
    const rt = deps?.rt;

    // Part 2 transports by TARGET (commander) runtime, fire-and-forget:
    // (1) same v2 process → in-process promptLocal (lands as user bubble);
    // (2) remote v2 service → HTTP prompt; (3) v1 same-daemon → promptAsync;
    // (4) spool fallback (claimed by the owning daemon's watcher).
    //
    // Each live prompt revalidates the reverse stamp immediately before
    // injecting (same gate the commander's spool watcher runs at delivery).
    // Narrow unavoidable TOCTOU: once the target runtime ACCEPTS the prompt,
    // a concurrent unassign/transfer cannot recall the injected user bubble —
    // only queued (spool) handoffs are reliably rejected after the move.
    const handoffReceiver = {
      runtime: gate.targetRuntime,
      daemonId: gate.targetDaemonId,
      sessionId: gate.targetSessionId,
    } as const;
    async function reverseGateOk(): Promise<string | null> {
      try {
        const verdict = await validateHandoffDelivery(envelope, { receiver: { ...handoffReceiver } });
        if (!verdict.ok) return `fleet_handoff_back failed: ${verdict.error}`;
        return null;
      } catch {
        return "fleet_handoff_back failed: handoff revalidation failed; refusing (fail-closed)";
      }
    }
    if (commanderRuntime === "v2" && rt?.kind === "v2" && targetDaemonId !== undefined && rt.daemonId === targetDaemonId) {
      const denied = await reverseGateOk();
      if (denied) return denied;
      try {
        await rt.promptLocal(commanderId, inject);
        return `handed back to ${commanderId} via:in-process (req ${reqId} Re: ${threadReqId})`;
      } catch {
        // fall through to remote/spool
      }
    }
    if (commanderRuntime === "v2" && commanderUrl !== "" && !commanderUrl.startsWith("pid:")) {
      const denied = await reverseGateOk();
      if (denied) return denied;
      try {
        const pw = await passwordForUrl(commanderUrl).catch(() => "");
        if (pw !== "" && (await v2PromptRemote(commanderUrl, pw, commanderId, inject))) {
          return `handed back to ${commanderId} via:v2-http (req ${reqId} Re: ${threadReqId})`;
        }
      } catch {
        // fall through to spool
      }
    }

    // DIRECT first when the client can reach the commander live.
    if (client?.session?.promptAsync) {
      const denied = await reverseGateOk();
      if (denied) return denied;
      try {
        const body: Record<string, unknown> = {
          parts: [{ type: "text", text: inject }],
        };
        if (envelope.agent) body["agent"] = envelope.agent;
        if (envelope.model) body["model"] = envelope.model;
        if (envelope.variant) body["variant"] = envelope.variant;
        // NOTE: never set noReply — handoff must land as a normal user bubble.
        await client.session.promptAsync({ path: { id: commanderId }, body });
        try {
          await client?.app?.log?.({
            body: { service: "fleet", level: "info", message: `fleet handoff ${reqId} Re:${threadReqId} direct → ${commanderId}` },
          });
        } catch {
          // best-effort
        }
        return `handed back to ${commanderId} via:direct (req ${reqId} Re: ${threadReqId})`;
      } catch (err) {
        if (!isUnreachableError(err) && client?.session?.promptAsync) {
          // Non-unreachable direct errors (busy/timeout): still fall back to
          // spool only when it looks like an asleep-daemon failure; otherwise
          // report the direct error readably. Per spec we spool on
          // unreachable; keep the same rule here.
          try {
            await client?.app?.log?.({
              body: { service: "fleet", level: "warn", message: `fleet handoff ${reqId} direct failed, spooling: ${toReadableError(err)}` },
            });
          } catch {
            // best-effort
          }
        }
        // fall through to spool
      }
    }

    try {
      await writeReq(reqId, envelope);
    } catch (err) {
      return `fleet_handoff_back failed: spool write failed: ${toReadableError(err)}`;
    }
    return `handed back to ${commanderId} via:spool (req ${reqId} Re: ${threadReqId})`;
  } catch (err) {
    return `fleet_handoff_back failed: ${toReadableError(err)}`;
  }
}

export async function fleetThreadHandler(
  args: any,
  _context: any,
  deps?: FleetToolDeps,
): Promise<string> {
  void deps;
  try {
    const filterRaw = typeof args?.reqId === "string" ? args.reqId.trim() : "";
    const filter = filterRaw !== "" ? filterRaw : null;
    const limit = clampLimit(args?.limit);

    let files: string[];
    try {
      files = await readdir(messagesDir());
    } catch {
      return "no thread entries (no messages dir yet)";
    }
    const envs: FleetEnvelope[] = [];
    for (const f of files) {
      if (!f.endsWith(".req.json")) continue;
      const reqId = f.slice(0, -".req.json".length);
      let env: FleetEnvelope | null = null;
      try {
        env = await readReq(reqId);
      } catch {
        continue;
      }
      if (!env) continue;
      if (filter) {
        const msg = env.message ?? "";
        const same = env.reqId === filter || env.reqId.startsWith(filter);
        const ref = msg.includes(`Re: ${filter}`);
        if (!same && !ref) continue;
      }
      envs.push(env);
    }
    envs.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    const slice = envs.slice(0, limit);
    if (slice.length === 0) {
      return filter
        ? `no thread entries for reqId ${filter}`
        : "no thread entries";
    }
    const lines = ["reqId|from->to|hop|chain|done|snippet"];
    for (const env of slice) {
      let done = "-";
      // Prefer the notify sidecar, fall back to the .res.json reply.
      try {
        const note = await readNotify(env.reqId);
        if (note && note.done && note.done.trim() !== "") done = note.done.trim();
      } catch {
        // best-effort
      }
      if (done === "-") {
        try {
          const raw = await readFile(join(messagesDir(), `${env.reqId}.res.json`), "utf8");
          const res = JSON.parse(raw) as { ok?: boolean; reply?: string; error?: string };
          if (typeof res?.reply === "string") {
            const d = doneLineOf(res.reply);
            if (d && d.trim() !== "") done = d.trim();
            else if (res.ok) done = "ok";
            else done = `err:${snippetOf(res.error ?? "failed", 40)}`;
          } else if (res && res.ok === false) {
            done = `err:${snippetOf(res.error ?? "failed", 40)}`;
          }
        } catch {
          // no .res.json yet — stays "-"
        }
      }
      void DONE_FOOTER;
      const from = env.fromCommander ?? "?";
      const to = env.targetSessionId ?? "?";
      const hop = hopOf(env);
      const chain = chainRefsOf(env.message ?? "");
      lines.push(`${env.reqId}|${from}->${to}|${hop}|${chain.length > 0 ? chain.join(",") : "-"}|${done}|${snippetOf(env.message ?? "")}`);
    }
    return lines.join("\n");
  } catch (err) {
    return `fleet_thread failed: ${toReadableError(err)}`;
  }
}

export const fleetHandoffBackDef: ToolDef = {
  name: "fleet_handoff_back",
  description:
    "Hand a delegation back to the commander that sent it (routes to the CURRENT owner after transfers; survives .req cleanup via the durable handoff origin). Reverse delegation via direct promptAsync with spool fallback. Returns who it handed back to and via which path.",
  args: {
    message: z
      .string()
      .describe("Correction / follow-up for the commander (self-contained, plain text)"),
    done: z
      .string()
      .optional()
      .describe("Suggested one-line DONE: result for the commander"),
    agent: z.string().optional().describe("Optional agent hint replayed on the commander"),
    model: z
      .union([
        z.string(),
        z.object({
          providerID: z.string(),
          modelID: z.string(),
        }),
      ])
      .optional()
      .describe('Optional model hint ("provider/model" or {providerID, modelID})'),
    variant: z.string().optional().describe("Optional variant hint replayed on the commander"),
  },
  run: (args, callCtx, rt) => fleetHandoffBackHandler(args, callCtx, depsOf(rt)),
};

export const fleetThreadDef: ToolDef = {
  name: "fleet_thread",
  description:
    "List a fleet thread (.req/.res/.notify triples) as a compact reqId|from->to|done|snippet table. Filter by reqId or Re: thread ref.",
  args: {
    reqId: z
      .string()
      .optional()
      .describe("Thread filter: exact/prefix reqId or the Re: ref (omit for all, newest-capped)"),
    limit: z
      .number()
      .optional()
      .describe("Max rows (default 10, max 50)"),
  },
  run: (args, callCtx, rt) => fleetThreadHandler(args, callCtx, depsOf(rt)),
};

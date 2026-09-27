/**
 * fleetWatch.ts — Phase B1 per-commander `fleet_watch` + `fleet_ack`.
 *
 * Exactly ONE controlling commander per worker (see ../assignments.ts).
 * `fleet_watch` delivers ONLY the calling commander's own assignment events
 * (readAssignmentEvents for the caller's composite key) — never a global
 * roster/DONE broadcast, never another commander's DONE. Unassigned joins
 * stay discoverable via `fleet_unassigned` (global roster join notifies are
 * untouched for discovery); scoped watch stays silent for unassigned work.
 *
 * Caller identity ALWAYS comes from the tool context sessionID plus the
 * runtime/daemonId (see fleetAssign.callerIdentity) — never from explicit
 * args. Non-commanders, forks, unknown callers, and ambiguous identities
 * are denied with readable text (no global fallback, no since=0 replay).
 *
 * Events carry stable `<at>-<seq>` ids; explicit `fleet_ack` (eventId only,
 * caller derived from context) advances the cursor. `fleet_watch` blocks up
 * to timeoutMs (max 2min, abort-aware) for new unacked events. A corrupt /
 * unreadable journal fails CLOSED with an error (never a misleading
 * "no events"). Never throws — failures render as readable text.
 */

import { z } from "../toolDef.js";
import type { ToolDef } from "../toolDef.js";
import type { CallCtx, Runtime } from "../runtime.js";
import { abortableSleep } from "../fileTransport.js";
import { callerIdentity } from "./fleetAssign.js";
import type { FleetIdentity } from "../assignments.js";
import {
  checkCommander,
  freshEntries,
  readAuthStrict,
  readRegistryStrict,
} from "../assignments.js";
import { fleetKeyOf } from "../registry.js";
import {
  ackAssignmentEvent,
  readAssignmentEvents,
} from "../notify.js";
import type { AssignmentEvent } from "../notify.js";

function toReadableError(err: unknown): string {
  if (err instanceof Error) return err.message || String(err);
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function clampTimeout(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : NaN;
  if (Number.isNaN(n)) return 30_000;
  if (n < 0) return 0;
  if (n > 120_000) return 120_000;
  return n;
}

function clampLimit(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : NaN;
  if (Number.isNaN(n)) return 100;
  if (n < 1) return 1;
  if (n > 100) return 100;
  return n;
}

function shortOf(key: string): string {
  try {
    const parts = String(key ?? "").split("\u0000");
    return parts[2] ?? key;
  } catch {
    return key;
  }
}

type CommanderResolution =
  | { ok: true; caller: FleetIdentity; callerKey: string }
  | { ok: false; error: string };

/**
 * Resolve + authorize the calling commander. Denies empty/ambiguous
 * identities, unknown sessions, forks, and non-commanders. Never throws.
 */
async function resolveCallingCommander(
  callCtx: CallCtx,
  rt?: Runtime,
): Promise<CommanderResolution> {
  try {
    const caller = callerIdentity(callCtx, rt);
    if (caller.sessionId.trim() === "") {
      return { ok: false, error: "could not determine current session id (ambiguous identity); refusing" };
    }
    if (caller.daemonId.trim() === "") {
      return { ok: false, error: "could not determine current daemon id (ambiguous identity); refusing" };
    }
    const callerKey = fleetKeyOf(caller);
    const [reg, auth] = await Promise.all([readRegistryStrict(), readAuthStrict()]);
    if (reg.status === "corrupt" || reg.status === "error") {
      return { ok: false, error: `registry state unreadable (${reg.error ?? reg.status}); refusing (fail-closed)` };
    }
    if (auth.status === "corrupt" || auth.status === "error") {
      return { ok: false, error: `auth state unreadable (${auth.error ?? auth.status}); refusing (fail-closed)` };
    }
    const fresh = freshEntries(reg.entries);
    const entry = fresh.find((e) => fleetKeyOf(e) === callerKey);
    const chk = checkCommander(entry, auth.commanders);
    if (!chk.ok) return { ok: false, error: chk.error };
    return { ok: true, caller, callerKey };
  } catch {
    return { ok: false, error: "commander resolution failed; refusing (fail-closed)" };
  }
}

function formatEvent(e: AssignmentEvent): string {
  try {
    const worker = shortOf(e.workerKey);
    const data = String(e.data ?? "");
    return `${e.id} | ${e.type} ${worker} gen ${e.generation} at ${e.at}${data !== "" ? ` ${data}` : ""}`;
  } catch {
    return String((e as { id?: unknown })?.id ?? "?");
  }
}

export async function fleetWatchHandler(
  args: unknown,
  context: unknown,
  deps?: { rt?: Runtime },
): Promise<string> {
  try {
    const a = (args ?? {}) as { timeoutMs?: unknown; limit?: unknown; since?: unknown };
    if (a["since"] !== undefined && a["since"] !== null) {
      // since-replay is retired: per-commander cursors + explicit ack own
      // delivery (no since=0 global replay, which would leak cross-commander
      // history). The arg is ignored.
    }
    const timeoutMs = clampTimeout(a["timeoutMs"]);
    const limit = clampLimit(a["limit"]);
    const callCtx = context as CallCtx;
    const res = await resolveCallingCommander(callCtx, deps?.rt);
    if (!res.ok) return `fleet_watch failed: ${res.error}`;
    const abort = (context as { abort?: AbortSignal } | null)?.abort;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (abort?.aborted) return "fleet_watch aborted";
      const read = await readAssignmentEvents(res.callerKey, limit);
      if (read.status === "corrupt" || read.status === "error") {
        return `fleet_watch failed: ${read.error ?? "assignment event journal unreadable"}; refusing (fail-closed)`;
      }
      if (read.events.length > 0) {
        const lines = read.events.map(formatEvent);
        lines.push(`ack required: fleet_ack <eventId> (total unacked: ${read.total})`);
        return lines.join("\n");
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return "no new fleet events (ack required to advance: fleet_ack <eventId>)";
      try {
        await abortableSleep(Math.min(1000, remaining), abort);
      } catch {
        return "fleet_watch aborted";
      }
    }
  } catch (err) {
    return `fleet_watch failed: ${toReadableError(err)}`;
  }
}

export async function fleetAckHandler(
  args: unknown,
  context: unknown,
  deps?: { rt?: Runtime },
): Promise<string> {
  try {
    const a = (args ?? {}) as { eventId?: unknown };
    const eventId = typeof a["eventId"] === "string" ? a.eventId.trim() : "";
    if (eventId === "") return "fleet_ack failed: eventId must be a non-empty string";
    const callCtx = context as CallCtx;
    const res = await resolveCallingCommander(callCtx, deps?.rt);
    if (!res.ok) return `fleet_ack failed: ${res.error}`;
    const read = await readAssignmentEvents(res.callerKey, 500);
    if (read.status === "corrupt" || read.status === "error") {
      return `fleet_ack failed: ${read.error ?? "assignment event journal unreadable"}; refusing (fail-closed)`;
    }
    const ok = await ackAssignmentEvent(res.callerKey, eventId);
    if (!ok) return `fleet_ack failed: unknown event id ${eventId}`;
    return `acked ${eventId}`;
  } catch (err) {
    return `fleet_ack failed: ${toReadableError(err)}`;
  }
}

export const fleetWatchDef: ToolDef = {
  name: "fleet_watch",
  description:
    "Watch your own assigned fleet workers: blocks up to timeoutMs for your unacked assignment events (join/leave/idle/done/role/transfer). Per-commander scoped; explicit fleet_ack required to advance.",
  args: {
    timeoutMs: z
      .number()
      .optional()
      .describe("Max time to block waiting for your events (default 30000, max 120000)"),
    limit: z
      .number()
      .optional()
      .describe("Max events to return (default 100, max 100)"),
  },
  run: (args, callCtx, rt) => fleetWatchHandler(args, callCtx, { rt }),
};

export const fleetAckDef: ToolDef = {
  name: "fleet_ack",
  description:
    "Acknowledge one of your assignment events by stable event id (advances your cursor; prunes acked history beyond retention).",
  args: {
    eventId: z.string().describe("Stable assignment event id from fleet_watch (e.g. 0000000000000-0000)"),
  },
  run: (args, callCtx, rt) => fleetAckHandler(args, callCtx, { rt }),
};

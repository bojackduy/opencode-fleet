/**
 * ownershipEvents.ts — Phase B1 scoped ownership event routing.
 *
 * Exactly ONE controlling commander per worker (see assignments.ts). Every
 * durable event is appended AFTER the state transition with the owner
 * resolved at event time (one owner only):
 *
 *   - resolve the current assignment row for the composite workerKey
 *     (runtime, daemonId, sessionId via fleetKeyOf — NEVER a bare sessionId);
 *   - unassigned workers produce NO scoped event (global roster join
 *     notifications stay untouched for discovery; scoped watch never leaks);
 *   - on transfer races, the generation is re-read at emit time so the
 *     CURRENT owner wins (Phase A already writes per-owner transfer
 *     event(s); this module is for idle/done/leave/join/role).
 *
 * Dedup: re-beats must not spam. Before appending, the target commander's
 * journal is checked: when its most recent event for the same workerKey has
 * the identical type+data, the emit is skipped (returns null, counted as
 * suppressed). Same-millisecond appends stay lossless via the journal's
 * `<at>-<seq>` ids (see notify.ts).
 *
 * Data carries only a short snippet (<=200 chars, lastDone style) — never
 * raw prompts. File notification alone never wakes an idle model (no
 * automatic AI prompts are injected here).
 *
 * IMPORTANT: appendAssignmentEvent handles its own withStateLock. Callers
 * must NEVER hold withStateLock when calling emit* (no nested locks).
 * All exports never throw.
 */

import { fleetKeyOf } from "./registry.js";
import {
  appendAssignmentEvent,
  readAssignmentEvents,
} from "./notify.js";
import type { AssignmentEvent, AssignmentEventType } from "./notify.js";
import { readAssignments } from "./assignments.js";

export type { AssignmentEvent, AssignmentEventType } from "./notify.js";

function shortSessionOf(key: string): string {
  try {
    const parts = String(key ?? "").split("\u0000");
    return parts[2] ?? key;
  } catch {
    return key;
  }
}

function snippetOf(text: string, max = 200): string {
  try {
    const one = String(text ?? "").replace(/\s+/g, " ").trim();
    if (one === "") return "";
    return one.length <= max ? one : `${one.slice(0, max)}…`;
  } catch {
    return "";
  }
}

/** Last DONE:<...> line in a text blob, or "" when absent. Never throws. */
export function doneLineOf(text: string): string {
  try {
    const re = /^DONE:\s*(.+?)\s*$/gm;
    let last = "";
    let m: RegExpExecArray | null;
    while ((m = re.exec(text ?? "")) !== null) last = (m[1] ?? "").trim();
    return last;
  } catch {
    return "";
  }
}

export interface OwnerSnapshot {
  workerKey: string;
  commanderKey: string;
  generation: number;
}

/**
 * Snapshot the current owner(s) for a bare sessionId WITHOUT selecting by
 * bare id: every assignment whose workerKey session part equals sessionId
 * is returned (0, 1, or N on v1/v2 collisions — each routes to its own
 * owner). Fail-closed: corrupt/unreadable assignment state yields
 * { error } and no snapshots. Never throws.
 */
export async function snapshotOwnersForSession(
  sessionId: string,
): Promise<{ owners: OwnerSnapshot[] } | { error: string }> {
  try {
    const sid = String(sessionId ?? "").trim();
    if (sid === "") return { owners: [] };
    const asg = await readAssignments();
    if (asg.status === "corrupt" || asg.status === "error") {
      return { error: `assignment state unreadable (${asg.error ?? asg.status}); refusing (fail-closed)` };
    }
    const owners: OwnerSnapshot[] = [];
    for (const a of Object.values(asg.state.assignments)) {
      if (shortSessionOf(a.workerKey) === sid) {
        owners.push({
          workerKey: a.workerKey,
          commanderKey: a.commanderKey,
          generation: asg.state.generation,
        });
      }
    }
    return { owners };
  } catch {
    return { error: "owner snapshot failed" };
  }
}

/**
 * Emit one scoped event to the CURRENT owner of workerKey (resolved at emit
 * time via a fresh assignments read, so a transfer racing the notification
 * routes to the new owner). Unassigned -> null (no delivery). Dedup: when
 * the owner's most recent event for this worker has identical type+data,
 * the emit is suppressed -> null. Never throws; never nests withStateLock.
 */
export async function emitOwnershipEvent(
  workerKey: string,
  type: AssignmentEventType,
  data: string,
  at?: number,
): Promise<AssignmentEvent | null> {
  try {
    const wk = String(workerKey ?? "");
    if (wk === "") return null;
    const asg = await readAssignments();
    if (asg.status === "corrupt" || asg.status === "error") return null;
    const assignment = asg.state.assignments[wk];
    if (!assignment) return null; // unassigned: scoped watch stays silent
    const commanderKey = assignment.commanderKey;
    const generation = asg.state.generation;
    const note = snippetOf(data);
    // Dedup on re-beat: skip when the owner's latest event for this worker
    // already carries the identical type+data.
    try {
      const read = await readAssignmentEvents(commanderKey, 500);
      if (read.status === "ok" || read.status === "missing") {
        // Check the full journal tail (readAssignmentEvents returns only
        // unacked; cursor-acked history may hold the duplicate). Read via
        // the unacked slice + cursor is enough for the same-transition
        // case; a same type+data as the newest unacked-or-acked event
        // suppresses. We inspect unacked newest first.
        const all = read.events.filter((e) => e.workerKey === wk);
        if (all.length > 0) {
          const latest = all[all.length - 1];
          if (latest.type === type && latest.data === note) return null;
        }
      }
    } catch {
      // Dedup is best-effort; fall through to append.
    }
    const ev = await appendAssignmentEvent(commanderKey, {
      workerKey: wk,
      generation,
      type,
      data: note,
      ...(typeof at === "number" && Number.isFinite(at) ? { at } : {}),
    }).catch(() => null);
    return ev;
  } catch {
    return null;
  }
}

/**
 * Emit to every CURRENT owner whose worker session part equals sessionId
 * (handles v1/v2 bare-id collisions by routing each composite key to its
 * own owner; never picks one owner by bare id). Returns the stored events.
 * Never throws.
 */
export async function emitToOwnersOfSession(
  sessionId: string,
  type: AssignmentEventType,
  data: string,
  at?: number,
): Promise<AssignmentEvent[]> {
  try {
    const snap = await snapshotOwnersForSession(sessionId);
    if ("error" in snap) return [];
    const out: AssignmentEvent[] = [];
    for (const o of snap.owners) {
      const ev = await emitOwnershipEvent(o.workerKey, type, data, at);
      if (ev) out.push(ev);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Emit a scoped event for one exact composite worker identity
 * (runtime, daemonId, sessionId). The key is built with fleetKeyOf so the
 * stored row is matched exactly — no bare-id ambiguity. The worker stays
 * addressable even when its registry row is stale/gone (the assignment row
 * alone routes the event; used for deletion leaves snapshotted BEFORE
 * removeSessionScoped). Never throws.
 */
export async function emitForWorkerIdentity(
  ident: { runtime: "v1" | "v2"; daemonId: string; sessionId: string },
  type: AssignmentEventType,
  data: string,
  at?: number,
): Promise<AssignmentEvent | null> {
  try {
    const key = fleetKeyOf({
      runtime: ident.runtime,
      daemonId: String(ident.daemonId ?? ""),
      sessionId: String(ident.sessionId ?? ""),
    });
    return await emitOwnershipEvent(key, type, data, at);
  } catch {
    return null;
  }
}

/** Build an idle note from a lastDone snippet (no raw prompts). Never throws. */
export function idleNoteFor(lastDone: string): string {
  try {
    const d = snippetOf(lastDone);
    return d === "" ? "idle" : `idle DONE:${d}`;
  } catch {
    return "idle";
  }
}

/** Build a done note from a DONE line / reply (snippet only). Never throws. */
export function doneNoteFor(replyOrDone: string): string {
  try {
    const raw = String(replyOrDone ?? "");
    const line = doneLineOf(raw);
    const use = line !== "" ? line : raw;
    const s = snippetOf(use);
    return s === "" ? "done" : `DONE:${s}`;
  } catch {
    return "done";
  }
}

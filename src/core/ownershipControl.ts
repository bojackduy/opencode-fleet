/**
 * ownershipControl.ts — Phase B2 exclusive-ownership control plane.
 *
 * Exactly ONE controlling commander per worker (see assignments.ts).
 * Every send path (fleet_exec direct/in-process/HTTP/spool, fleet_broadcast
 * per-target spool/in-process, fleet_handoff_back reverse) and every delivery
 * path (v1 daemon watcher, v2 spool watcher, legacy inbox watcher) goes
 * through the SAME gate — no try/catch fallthrough that silently bypasses
 * authentication (fail CLOSED on corrupt/unreadable state).
 *
 * Order per send:
 *   1. resolveCallingCommander (context composite identity, fail-closed;
 *      unknown/ambiguous/fork/non-commander denied, no global fallback).
 *   2. resolveTargetEntry (bare sessionId ONLY when unambiguous across
 *      v1/v2; collisions require the full composite selector via the
 *      runtime + daemonId params).
 *   3. Ownership: target must be owned-by-caller (exact workerKey match).
 *      `force:true` NEVER bypasses ownership — it only ever governed the
 *      pre-existing commander->commander auth semantic, which is DENIED
 *      under exclusive ownership (commanders are not workers; use the
 *      handoff path instead).
 *   4. Global inbound policy (commander-only|accept|hold|refuse) AFTER
 *      ownership. Fail closed on corrupt auth/registry/assignments.
 *   5. Stamp the FleetEnvelope with workerKey + commanderKey + generation
 *      (CAS value read at pre-send time).
 *
 * Delivery (TOCTOU-safe): each inbox/remote path revalidates the envelope
 * against CURRENT assignment state at delivery time, bound to the ACTUAL
 * receiving session (explicit receiver identity from the watcher): the
 * stamped workerKey must equal the receiver's composite key, the envelope
 * target must be consistent with the receiver, and the bare fromCommander
 * must match the stamped commanderKey. A transfer/unassign racing a queued
 * request makes the queued envelope STALE -> rejected with a readable
 * error, never orphan-delivered. Legacy envelopes without the ownership
 * stamp are rejected under the default commander-only policy with an
 * actionable re-send error. Handoff (worker->commander reverse) envelopes
 * carry kind:"handoff" and validate via the reverse gate only (sender
 * binding + durable origin + current-owner check); they never pass the
 * worker-delivery gate, and forward envelopes never pass the handoff gate.
 *
 * Residual race (documented): when a DIRECT/in-process/HTTP prompt was
 * already ACCEPTED by the target runtime before a transfer lands, the live
 * session will still process the injected user bubble — delivery-time
 * validation cannot recall an accepted prompt. Only QUEUED (spool/held)
 * requests are reliably rejected after transfer.
 *
 * Handoff origins: worker-side delivery persists the delegating
 * origin/thread per worker (separate from .req.json, which the commander
 * cleans up after a successful read) so a later manual takeover can still
 * hand back. handoff_back routes to the CURRENT owner (transfer-aware),
 * preserving the original commander/reqId as audit only, and derives the
 * worker identity from the tool context composite (no spoofing).
 *
 * Nothing here throws to callers — every public op returns a result object.
 */

import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import {
  checkCommander,
  freshEntries,
  readAssignments,
  readAuthStrict,
  readRegistryStrict,
  resolveSessionKey,
} from "./assignments.js";
import type { FleetIdentity, SessionSelector } from "./assignments.js";
import { callerIdentity } from "./tools/fleetAssign.js";
import { fleetKeyOf, runtimeOf, stateDir, ensureStateMigrated } from "./registry.js";
import type { FleetRuntime, RegistryEntry } from "./registry.js";
import { sameDaemon, withV1Marker } from "./v1.js";
import type { CallCtx, Runtime } from "./runtime.js";
import type { FleetEnvelope } from "./fileTransport.js";
import { getPolicy } from "./auth.js";

export function shortSessionOf(key: string): string {
  try {
    const parts = String(key ?? "").split("\u0000");
    return parts[2] ?? key;
  } catch {
    return key;
  }
}

// ---- caller resolution (fail-closed, no global fallback) ----

export type CallerResolution =
  | { ok: true; caller: FleetIdentity; callerKey: string }
  | { ok: false; error: string; code: string };

/**
 * Resolve + authorize the calling commander from tool context + runtime.
 * Denies empty/ambiguous identities, unknown sessions, forks, and
 * non-commanders. Never throws.
 */
export async function resolveCallingCommander(
  callCtx: CallCtx,
  rt?: Runtime,
): Promise<CallerResolution> {
  try {
    const caller = callerIdentity(callCtx, rt);
    if (caller.sessionId.trim() === "") {
      return {
        ok: false,
        code: "unknown-caller",
        error: "could not determine current session id (ambiguous identity); refusing",
      };
    }
    if (caller.daemonId.trim() === "") {
      return {
        ok: false,
        code: "unknown-caller",
        error: "could not determine current daemon id (ambiguous identity); refusing",
      };
    }
    const callerKey = fleetKeyOf(caller);
    const [reg, auth] = await Promise.all([readRegistryStrict(), readAuthStrict()]);
    if (reg.status === "corrupt" || reg.status === "error") {
      return {
        ok: false,
        code: "state-unreadable",
        error: `registry state unreadable (${reg.error ?? reg.status}); refusing (fail-closed)`,
      };
    }
    if (auth.status === "corrupt" || auth.status === "error") {
      return {
        ok: false,
        code: "state-unreadable",
        error: `auth state unreadable (${auth.error ?? auth.status}); refusing (fail-closed)`,
      };
    }
    const fresh = freshEntries(reg.entries);
    const entry = fresh.find((e) => fleetKeyOf(e) === callerKey);
    const chk = checkCommander(entry, auth.commanders);
    if (!chk.ok) return { ok: false, code: chk.code, error: chk.error };
    return { ok: true, caller, callerKey };
  } catch {
    return { ok: false, code: "internal", error: "commander resolution failed; refusing (fail-closed)" };
  }
}

// ---- scoped read views ----

export interface ScopedView {
  ok: boolean;
  callerKey: string;
  ownedKeys: Set<string>;
  generation: number;
  error?: string;
}

/**
 * Owned worker keys for the calling commander (fresh rows only).
 * Fail-closed: corrupt/unreadable state denies the view (never a
 * misleading empty/global list). Never throws.
 */
export async function scopedViewFor(
  callCtx: CallCtx,
  rt?: Runtime,
): Promise<ScopedView> {
  try {
    const res = await resolveCallingCommander(callCtx, rt);
    if (!res.ok) {
      return { ok: false, callerKey: "", ownedKeys: new Set(), generation: 0, error: res.error };
    }
    const asg = await readAssignments();
    if (asg.status === "corrupt" || asg.status === "error") {
      return {
        ok: false,
        callerKey: res.callerKey,
        ownedKeys: new Set(),
        generation: 0,
        error: `assignment state unreadable (${asg.error ?? asg.status}); refusing (fail-closed)`,
      };
    }
    const owned = new Set<string>();
    for (const a of Object.values(asg.state.assignments)) {
      if (a.commanderKey === res.callerKey) owned.add(a.workerKey);
    }
    return { ok: true, callerKey: res.callerKey, ownedKeys: owned, generation: asg.state.generation };
  } catch {
    return { ok: false, callerKey: "", ownedKeys: new Set(), generation: 0, error: "scoped view failed; refusing (fail-closed)" };
  }
}

export type ScopedEntries =
  | {
    ok: true;
    caller: FleetIdentity;
    callerKey: string;
    /** Fresh registry rows owned by the caller (stale rows excluded). */
    owned: RegistryEntry[];
    generation: number;
  }
  | { ok: false; error: string; code: string };

/**
 * Fresh registry rows owned by the calling commander (fail-closed: corrupt
 * / unreadable registry or assignment state denies the view, never a
 * misleading empty/global list). Never throws.
 */
export async function scopedRegistryEntries(
  callCtx: CallCtx,
  rt?: Runtime,
): Promise<ScopedEntries> {
  try {
    const view = await scopedViewFor(callCtx, rt);
    if (!view.ok) {
      return { ok: false, code: "unknown-caller", error: view.error ?? "commander resolution failed; refusing (fail-closed)" };
    }
    const reg = await readRegistryStrict();
    if (reg.status === "corrupt" || reg.status === "error") {
      return {
        ok: false,
        code: "state-unreadable",
        error: `registry state unreadable (${reg.error ?? reg.status}); refusing (fail-closed)`,
      };
    }
    const fresh = freshEntries(reg.entries);
    const byKey = new Map(fresh.map((e) => [fleetKeyOf(e), e]));
    const owned: RegistryEntry[] = [];
    for (const k of view.ownedKeys) {
      const e = byKey.get(k);
      if (e) owned.push(e);
    }
    owned.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    // Re-derive the caller identity for detail rows (best-effort).
    let caller: FleetIdentity = { runtime: "v1", daemonId: "", sessionId: "" };
    try {
      caller = callerIdentity(callCtx, rt);
    } catch {
      // keep empty caller; callerKey below is authoritative
    }
    return { ok: true, caller, callerKey: view.callerKey, owned, generation: view.generation };
  } catch {
    return { ok: false, code: "internal", error: "scoped entries failed; refusing (fail-closed)" };
  }
}

// ---- send-time gate ----
export type SendGate =
  | {
      ok: true;
      callerKey: string;
      workerKey: string;
      generation: number;
      targetDaemonId: string;
    }
  | { ok: false; error: string; code: string; held?: boolean };

/**
 * Pre-send CAS gate for fleet_exec / fleet_broadcast per-target sends.
 * Selector supports bare sessionId (only when unambiguous) or the full
 * composite (runtime + daemonId + sessionId). Never throws; `force` never
 * bypasses ownership.
 */
export async function gateSendToWorker(
  callCtx: CallCtx,
  rt: Runtime | undefined,
  sel: SessionSelector,
  opts?: { force?: boolean },
): Promise<SendGate> {
  try {
    void opts; // force intentionally ignored for ownership (see header).
    const caller = await resolveCallingCommander(callCtx, rt);
    if (!caller.ok) return { ok: false, code: caller.code, error: caller.error };
    const [reg, asg] = await Promise.all([readRegistryStrict(), readAssignments()]);
    if (reg.status === "corrupt" || reg.status === "error") {
      return {
        ok: false,
        code: "state-unreadable",
        error: `registry state unreadable (${reg.error ?? reg.status}); refusing (fail-closed)`,
      };
    }
    if (asg.status === "corrupt" || asg.status === "error") {
      return {
        ok: false,
        code: "state-unreadable",
        error: `assignment state unreadable (${asg.error ?? asg.status}); refusing (fail-closed)`,
      };
    }
    const fresh = freshEntries(reg.entries);
    const tres = resolveSessionKey(fresh, sel);
    if (!tres.ok) {
      if (tres.code === "ambiguous") {
        return {
          ok: false,
          code: "ambiguous",
          error: `${tres.error}`,
        };
      }
      return { ok: false, code: tres.code, error: tres.error };
    }
    // Commander->commander targeting is denied under exclusive ownership,
    // even with force:true (commanders are not workers).
    try {
      const auth = await readAuthStrict();
      if (auth.status === "corrupt" || auth.status === "error") {
        return {
          ok: false,
          code: "state-unreadable",
          error: `auth state unreadable (${auth.error ?? auth.status}); refusing (fail-closed)`,
        };
      }
      const targetChk = checkCommander(
        fresh.find((e) => fleetKeyOf(e) === tres.key),
        auth.commanders,
      );
      if (targetChk.ok) {
        return {
          ok: false,
          code: "commander-target",
          error: `${sel.sessionId} is a commander; commander->commander exec is denied under exclusive ownership (use fleet_handoff_back from the worker instead)`,
        };
      }
    } catch {
      return { ok: false, code: "state-unreadable", error: "auth state unreadable; refusing (fail-closed)" };
    }
    const assignment = asg.state.assignments[tres.key];
    if (!assignment) {
      return {
        ok: false,
        code: "not-owned",
        error: `${sel.sessionId} is not assigned to you (unassigned; claim it with fleet_assign first)`,
      };
    }
    const workerStillThere = fresh.some((e) => fleetKeyOf(e) === tres.key);
    if (!workerStillThere) {
      return {
        ok: false,
        code: "stale",
        error: `${sel.sessionId} has a stale assignment (worker row gone); release or re-claim via fleet_assign`,
      };
    }
    if (assignment.commanderKey !== caller.callerKey) {
      return {
        ok: false,
        code: "owned-by-other",
        error: `${sel.sessionId} is owned by ${shortSessionOf(assignment.commanderKey)}; only the owning commander can target it`,
      };
    }
    // Global inbound policy AFTER ownership (fail closed on unreadable).
    try {
      const policy = await getPolicy().catch(() => "commander-only" as const);
      if (policy === "refuse") {
        return { ok: false, code: "refused", error: "denied: policy=refuse, ask commander to fleet_allow" };
      }
      if (policy === "hold") {
        return { ok: false, code: "held", held: true, error: "held for approval, use fleet_allow" };
      }
    } catch {
      return { ok: false, code: "state-unreadable", error: "auth state unreadable; refusing (fail-closed)" };
    }
    return {
      ok: true,
      callerKey: caller.callerKey,
      workerKey: tres.key,
      generation: assignment.generation,
      targetDaemonId: tres.entry.daemonId,
    };
  } catch {
    return { ok: false, code: "internal", error: "send gate failed; refusing (fail-closed)" };
  }
}

/** Stamp ownership proof onto an outbound envelope (CAS value). Never throws. */
export function stampEnvelope(
  envelope: FleetEnvelope,
  gate: Extract<SendGate, { ok: true }>,
): FleetEnvelope {
  try {
    return {
      ...envelope,
      fromCommander: shortSessionOf(gate.callerKey),
      workerKey: gate.workerKey,
      commanderKey: gate.callerKey,
      generation: gate.generation,
    };
  } catch {
    return envelope;
  }
}

// ---- delivery-time gate (TOCTOU-safe revalidation) ----

export type DeliveryVerdict =
  | { ok: true; workerKey: string; commanderKey: string; generation: number }
  | { ok: false; error: string; stale: boolean };

/** Receiver identity for delivery-time binding (validated by v1/v2 watchers). */
export interface DeliveryReceiver {
  runtime: FleetRuntime;
  daemonId: string;
  sessionId: string;
}

/**
 * Composite key the receiver row is stored under. v1 watcher daemonIds are
 * raw getDaemonId() values while registry rows carry the `:v1` marker, so
 * v1 receiver daemons are marker-normalized (idempotent) before keying.
 */
function receiverKeyOf(r: DeliveryReceiver): string {
  try {
    const daemon = r.runtime === "v1" ? withV1Marker(r.daemonId) : String(r.daemonId ?? "");
    return fleetKeyOf({ runtime: r.runtime, daemonId: daemon, sessionId: r.sessionId });
  } catch {
    return "";
  }
}

async function failClosedPolicy(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const auth = await readAuthStrict();
    if (auth.status === "corrupt" || auth.status === "error") {
      return {
        ok: false,
        error: `auth state unreadable (${auth.error ?? auth.status}); refusing delivery (fail-closed)`,
      };
    }
    // The live policy is authoritative even when the file is merely missing
    // (missing reads as empty allowlist + default commander-only below).
    const { readAuth } = await import("./auth.js");
    const state = await readAuth();
    if (state.policy === "refuse") {
      return { ok: false, error: "denied: policy=refuse at delivery, ask commander to fleet_allow" };
    }
    if (state.policy === "hold") {
      return { ok: false, error: "held for approval at delivery, use fleet_allow" };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "auth state unreadable at delivery; refusing (fail-closed)" };
  }
}

/**
 * Revalidate a FORWARD (commander->worker) envelope against CURRENT
 * assignment state at delivery time (each v1/v2 inbox + remote path), with
 * the ACTUAL receiving session bound as an explicit parameter.
 *
 * Binds the stamp to the receiver: the stamped workerKey must equal the
 * composite key of the session about to be prompted, the envelope's
 * targetSessionId/targetDaemonId must be consistent with that receiver, and
 * the bare fromCommander must match the stamped commanderKey (forged senders
 * rejected). A sender that stamps W1's ownership but targets W2 is rejected
 * here. Handoff (worker->commander reverse) envelopes never pass this gate —
 * they must use validateHandoffDelivery. Legacy envelopes without the
 * ownership stamp are rejected, never interpreted as allowed. Auth policy is
 * checked fail-closed. Never throws.
 */
export async function validateDelivery(
  envelope: FleetEnvelope,
  opts?: { receiver?: DeliveryReceiver },
): Promise<DeliveryVerdict> {
  try {
    const kind = String((envelope as { kind?: unknown })?.kind ?? "exec");
    if (kind === "handoff") {
      return {
        ok: false,
        stale: true,
        error:
          `stale envelope (req ${(envelope as { reqId?: unknown })?.reqId ?? "?"}): handoff envelope presented to the worker-delivery gate; ` +
          `reverse delegations must validate via the handoff path`,
      };
    }
    const workerKey = String((envelope as { workerKey?: unknown })?.workerKey ?? "");
    const commanderKey = String((envelope as { commanderKey?: unknown })?.commanderKey ?? "");
    const generationRaw = (envelope as { generation?: unknown })?.generation;
    const generation =
      typeof generationRaw === "number" && Number.isFinite(generationRaw)
        ? Math.floor(generationRaw)
        : NaN;
    if (workerKey === "" || commanderKey === "" || Number.isNaN(generation)) {
      return {
        ok: false,
        stale: true,
        error:
          `stale or legacy envelope (req ${(envelope as { reqId?: unknown })?.reqId ?? "?"} has no ownership stamp); ` +
          `re-send via fleet_exec/fleet_broadcast so workerKey+commanderKey+generation are stamped (legacy spool is rejected under commander-only)`,
      };
    }
    // The bare sender must be the stamped commander's session (no spoofed origin).
    const fromCommander = String((envelope as { fromCommander?: unknown })?.fromCommander ?? "").trim();
    if (fromCommander === "" || fromCommander !== shortSessionOf(commanderKey)) {
      return {
        ok: false,
        stale: true,
        error:
          `stale envelope (req ${(envelope as { reqId?: unknown })?.reqId ?? "?"}): fromCommander "${fromCommander || "(empty)"}" ` +
          `does not match the stamped owner ${shortSessionOf(commanderKey)}; refusing (fail-closed)`,
      };
    }
    const asg = await readAssignments();
    if (asg.status === "corrupt" || asg.status === "error") {
      return {
        ok: false,
        stale: true,
        error: `assignment state unreadable (${asg.error ?? asg.status}); refusing delivery (fail-closed)`,
      };
    }
    const current = asg.state.assignments[workerKey];
    if (!current) {
      return {
        ok: false,
        stale: true,
        error: `stale envelope (req ${(envelope as { reqId?: unknown })?.reqId ?? "?"}): worker is no longer assigned; re-assign with fleet_assign and re-send`,
      };
    }
    if (current.commanderKey !== commanderKey || current.generation !== generation) {
      return {
        ok: false,
        stale: true,
        error:
          `stale envelope (req ${(envelope as { reqId?: unknown })?.reqId ?? "?"}): ownership moved ` +
          `(now owned by ${shortSessionOf(current.commanderKey)} gen ${current.generation}); re-send from the current owner`,
      };
    }
    // Bind the stamp to the ACTUAL receiving session (fail-closed forgery check).
    const receiver = opts?.receiver;
    if (receiver) {
      const targetSessionId = String((envelope as { targetSessionId?: unknown })?.targetSessionId ?? "");
      if (targetSessionId === "" || targetSessionId !== String(receiver.sessionId ?? "")) {
        return {
          ok: false,
          stale: true,
          error:
            `stale envelope (req ${(envelope as { reqId?: unknown })?.reqId ?? "?"}): targetSessionId "${targetSessionId || "(empty)"}" ` +
            `does not match the receiving session "${String(receiver.sessionId ?? "")}"; refusing (fail-closed)`,
        };
      }
      const targetDaemonId = String((envelope as { targetDaemonId?: unknown })?.targetDaemonId ?? "");
      if (targetDaemonId !== "" && !sameDaemon(targetDaemonId, receiver.daemonId)) {
        return {
          ok: false,
          stale: true,
          error:
            `stale envelope (req ${(envelope as { reqId?: unknown })?.reqId ?? "?"}): targetDaemonId mismatch; refusing (fail-closed)`,
        };
      }
      const expected = receiverKeyOf(receiver);
      if (expected === "" || workerKey !== expected) {
        return {
          ok: false,
          stale: true,
          error:
            `stale envelope (req ${(envelope as { reqId?: unknown })?.reqId ?? "?"}): ownership stamp is for ${shortSessionOf(workerKey)} ` +
            `but the receiving session is ${String(receiver.sessionId ?? "")} (${receiver.runtime}/${String(receiver.daemonId ?? "")}); refusing (fail-closed)`,
        };
      }
    }
    // Global inbound policy AFTER ownership at delivery too (fail-closed).
    const policy = await failClosedPolicy();
    if (!policy.ok) return { ok: false, stale: true, error: policy.error };
    return { ok: true, workerKey, commanderKey, generation };
  } catch {
    return { ok: false, stale: true, error: "delivery validation failed; refusing (fail-closed)" };
  }
}

export type HandoffVerdict =
  | {
      ok: true;
      workerKey: string;
      commanderKey: string;
      generation: number;
      targetSessionId: string;
      targetDaemonId: string;
    }
  | { ok: false; error: string; stale: boolean };

/**
 * Revalidate a REVERSE (worker->commander handoff) envelope at delivery time.
 * The receiving commander verifies: the sender worker composite key
 * (fromCommander must be that worker's bare session — callers cannot spoof
 * the origin via args), the durable recorded origin for the worker, that the
 * CURRENT assignment maps the worker to THIS commander (transfer-aware), and
 * that the target composite matches the actual receiving session. Only valid
 * handoffs bypass the regular worker-delivery stamp. Never throws.
 */
export async function validateHandoffDelivery(
  envelope: FleetEnvelope,
  opts: { receiver: DeliveryReceiver },
): Promise<HandoffVerdict> {
  try {
    const reqId = String((envelope as { reqId?: unknown })?.reqId ?? "?");
    if (String((envelope as { kind?: unknown })?.kind ?? "") !== "handoff") {
      return {
        ok: false,
        stale: true,
        error: `stale envelope (req ${reqId}): forward envelope presented to the handoff gate; refusing (fail-closed)`,
      };
    }
    const receiver = opts?.receiver;
    if (!receiver || String(receiver.sessionId ?? "").trim() === "") {
      return { ok: false, stale: true, error: `stale envelope (req ${reqId}): no receiving commander; refusing (fail-closed)` };
    }
    const workerKey = String((envelope as { workerKey?: unknown })?.workerKey ?? "");
    const commanderKey = String((envelope as { commanderKey?: unknown })?.commanderKey ?? "");
    const generationRaw = (envelope as { generation?: unknown })?.generation;
    const generation =
      typeof generationRaw === "number" && Number.isFinite(generationRaw)
        ? Math.floor(generationRaw)
        : NaN;
    if (workerKey === "" || commanderKey === "" || Number.isNaN(generation)) {
      return {
        ok: false,
        stale: true,
        error: `stale handoff envelope (req ${reqId} has no reverse stamp); re-send via fleet_handoff_back`,
      };
    }
    // Sender binding: fromCommander must be the sending worker's bare session.
    const fromCommander = String((envelope as { fromCommander?: unknown })?.fromCommander ?? "").trim();
    if (fromCommander === "" || fromCommander !== shortSessionOf(workerKey)) {
      return {
        ok: false,
        stale: true,
        error: `stale handoff envelope (req ${reqId}): sender "${fromCommander || "(empty)"}" does not match the sending worker ${shortSessionOf(workerKey)}; refusing (fail-closed)`,
      };
    }
    // Target binding: the target composite must be the actual receiver.
    const targetSessionId = String((envelope as { targetSessionId?: unknown })?.targetSessionId ?? "");
    if (targetSessionId === "" || targetSessionId !== String(receiver.sessionId ?? "")) {
      return {
        ok: false,
        stale: true,
        error: `stale handoff envelope (req ${reqId}): target "${targetSessionId || "(empty)"}" does not match the receiving commander "${String(receiver.sessionId ?? "")}"; refusing (fail-closed)`,
      };
    }
    const targetDaemonId = String((envelope as { targetDaemonId?: unknown })?.targetDaemonId ?? "");
    if (targetDaemonId !== "" && !sameDaemon(targetDaemonId, receiver.daemonId)) {
      return {
        ok: false,
        stale: true,
        error: `stale handoff envelope (req ${reqId}): targetDaemonId mismatch; refusing (fail-closed)`,
      };
    }
    const expectedCommander = receiverKeyOf(receiver);
    if (expectedCommander === "" || commanderKey !== expectedCommander) {
      return {
        ok: false,
        stale: true,
        error: `stale handoff envelope (req ${reqId}): stamped commander does not match the receiving commander; refusing (fail-closed)`,
      };
    }
    // Durable recorded origin must exist for the sending worker.
    const origin = await readHandoffOrigin(workerKey);
    if (!origin || origin.workerKey !== workerKey) {
      return {
        ok: false,
        stale: true,
        error: `stale handoff envelope (req ${reqId}): no durable delegation origin for ${shortSessionOf(workerKey)}; refusing (fail-closed)`,
      };
    }
    // CURRENT assignment must map the worker to THIS commander (transfer-aware).
    const asg = await readAssignments();
    if (asg.status === "corrupt" || asg.status === "error") {
      return {
        ok: false,
        stale: true,
        error: `assignment state unreadable (${asg.error ?? asg.status}); refusing handoff delivery (fail-closed)`,
      };
    }
    const current = asg.state.assignments[workerKey];
    if (!current) {
      return {
        ok: false,
        stale: true,
        error: `stale handoff envelope (req ${reqId}): worker ${shortSessionOf(workerKey)} is no longer assigned; refusing (fail-closed)`,
      };
    }
    if (current.commanderKey !== expectedCommander || current.generation !== generation) {
      return {
        ok: false,
        stale: true,
        error:
          `stale handoff envelope (req ${reqId}): ownership moved ` +
          `(now owned by ${shortSessionOf(current.commanderKey)} gen ${current.generation}); refusing (fail-closed)`,
      };
    }
    const policy = await failClosedPolicy();
    if (!policy.ok) return { ok: false, stale: true, error: policy.error };
    return {
      ok: true,
      workerKey,
      commanderKey,
      generation,
      targetSessionId,
      targetDaemonId,
    };
  } catch {
    return { ok: false, stale: true, error: "handoff delivery validation failed; refusing (fail-closed)" };
  }
}

export type HandoffSendGate =
  | {
      ok: true;
      workerKey: string;
      commanderKey: string;
      generation: number;
      targetSessionId: string;
      targetDaemonId: string;
      targetRuntime: FleetRuntime;
    }
  | { ok: false; error: string; code: string };

/**
 * Send-time reverse gate for fleet_handoff_back (worker->commander). The
 * worker identity comes from the tool context composite (never from explicit
 * args — callers cannot spoof the origin), and the target is resolved from
 * the CURRENT assignment (transfer-aware) by composite key: ambiguity and
 * stale owners are rejected, and an unassigned worker gets a readable error
 * (never a fallback route to the old origin commander). Never throws.
 */
export async function gateHandoffSend(
  callCtx: CallCtx,
  rt?: Runtime,
): Promise<HandoffSendGate> {
  try {
    const worker = callerIdentity(callCtx, rt);
    if (worker.sessionId.trim() === "" || worker.daemonId.trim() === "") {
      return {
        ok: false,
        code: "unknown-caller",
        error: "could not determine current worker identity (ambiguous); refusing",
      };
    }
    const workerKey = fleetKeyOf(worker);
    const [reg, asg] = await Promise.all([readRegistryStrict(), readAssignments()]);
    if (reg.status === "corrupt" || reg.status === "error") {
      return {
        ok: false,
        code: "state-unreadable",
        error: `registry state unreadable (${reg.error ?? reg.status}); refusing (fail-closed)`,
      };
    }
    if (asg.status === "corrupt" || asg.status === "error") {
      return {
        ok: false,
        code: "state-unreadable",
        error: `assignment state unreadable (${asg.error ?? asg.status}); refusing (fail-closed)`,
      };
    }
    const assignment = asg.state.assignments[workerKey];
    if (!assignment) {
      return {
        ok: false,
        code: "not-owned",
        error: `worker ${worker.sessionId} is not assigned to any commander (unassigned; claim it with fleet_assign first)`,
      };
    }
    const fresh = freshEntries(reg.entries);
    // Resolve the CURRENT owner by composite key (transfer-aware).
    const target = fresh.find((e) => fleetKeyOf(e) === assignment.commanderKey);
    if (!target) {
      const bare = shortSessionOf(assignment.commanderKey);
      const bareMatches = fresh.filter((e) => e.sessionId === bare);
      if (bareMatches.length === 0) {
        return {
          ok: false,
          code: "stale",
          error: `owning commander ${bare} is no longer in the registry (stale owner); ask the current owner to re-claim`,
        };
      }
      if (bareMatches.length > 1) {
        const where = bareMatches.map((e) => `${runtimeOf(e)}/${e.daemonId}`).join(", ");
        return {
          ok: false,
          code: "ambiguous",
          error: `owning commander ${bare} matches ${bareMatches.length} sessions (${where}); cannot route handoff (fail-closed)`,
        };
      }
      return {
        ok: false,
        code: "stale",
        error: `ownership moved for ${worker.sessionId} (stale owner ${bare}); refusing (fail-closed)`,
      };
    }
    // The current owner must still be commander-authorized (fail-closed).
    try {
      const auth = await readAuthStrict();
      if (auth.status === "corrupt" || auth.status === "error") {
        return {
          ok: false,
          code: "state-unreadable",
          error: `auth state unreadable (${auth.error ?? auth.status}); refusing (fail-closed)`,
        };
      }
      const chk = checkCommander(target, auth.commanders);
      if (!chk.ok) {
        return {
          ok: false,
          code: chk.code,
          error: `owning commander ${target.sessionId} is no longer commander-authorized (${chk.error}); refusing (fail-closed)`,
        };
      }
    } catch {
      return { ok: false, code: "state-unreadable", error: "auth state unreadable; refusing (fail-closed)" };
    }
    try {
      const { readAuth } = await import("./auth.js");
      const state = await readAuth();
      if (state.policy === "refuse") {
        return { ok: false, code: "refused", error: "denied: policy=refuse, ask commander to fleet_allow" };
      }
      if (state.policy === "hold") {
        return { ok: false, code: "held", error: "held for approval, use fleet_allow" };
      }
    } catch {
      return { ok: false, code: "state-unreadable", error: "auth state unreadable; refusing (fail-closed)" };
    }
    return {
      ok: true,
      workerKey,
      commanderKey: assignment.commanderKey,
      generation: assignment.generation,
      targetSessionId: target.sessionId,
      targetDaemonId: target.daemonId,
      targetRuntime: runtimeOf(target),
    };
  } catch {
    return { ok: false, code: "internal", error: "handoff send gate failed; refusing (fail-closed)" };
  }
}

// ---- handoff origins (survive .req.json cleanup) ----

function originsDir(): string {
  return join(stateDir(), "handoff-origins");
}

function safeSegment(raw: unknown): string {
  try {
    const s = String(raw ?? "").trim().replace(/[^A-Za-z0-9._-]+/g, "_");
    return (s === "" ? "unknown" : s).slice(0, 120);
  } catch {
    return "unknown";
  }
}

export function originPathForWorker(workerKey: string): string {
  try {
    const key = String(workerKey ?? "");
    // Hash-prefixed filename: the sanitized composite alone can collide
    // (separators sanitize to the same "_" as legal id characters), so the
    // sha256 of the full key disambiguates while the readable suffix aids debugging.
    const hash = createHash("sha256").update(key, "utf8").digest("hex").slice(0, 32);
    const parts = key.split("\u0000");
    const readable = `${safeSegment(parts[0])}__${safeSegment(parts[1])}__${safeSegment(parts[2])}`;
    return join(originsDir(), `${hash}__${readable}.origin.json`);
  } catch {
    return join(originsDir(), "unknown.origin.json");
  }
}

export interface HandoffOrigin {
  workerKey: string;
  /** Commander composite key that last delegated (origin, audit only). */
  fromCommanderKey: string;
  /** Bare session id of the origin commander (audit only). */
  fromCommanderSession: string;
  reqId: string;
  generation: number;
  at: number;
}

/**
 * Persist the delegating origin for a worker (called at delivery time AND
 * at direct/in-process/HTTP acceptance time, separate from .req.json so
 * commander-side cleanupReq cannot erase it). Generation-guarded: never
 * overwrite a newer origin with an older one after concurrent delegations
 * (older generation, or same generation with an older timestamp, is
 * skipped). Best-effort, never throws.
 */
export async function recordHandoffOrigin(origin: HandoffOrigin): Promise<void> {
  try {
    await recordHandoffOriginStrict(origin);
  } catch {
    // best-effort only
  }
}

/**
 * Strict variant: same generation-guarded write, but throws on I/O failure
 * so direct/in-process/HTTP send paths can fail visibly instead of silently
 * claiming takeover works. Returns true when written, false when skipped
 * because a newer origin already exists. Never throws for skips.
 */
export async function recordHandoffOriginStrict(origin: HandoffOrigin): Promise<boolean> {
  if (!origin || origin.workerKey === "") return false;
  await ensureStateMigrated();
  await mkdir(originsDir(), { recursive: true });
  // Generation guard: avoid overwriting a newer origin after concurrent
  // requests. Read failures (missing/corrupt) mean "no newer origin" → write.
  try {
    const existing = await readHandoffOrigin(origin.workerKey);
    if (existing && existing.workerKey === origin.workerKey) {
      const inGen = Math.floor(origin.generation);
      const exGen = Math.floor(existing.generation);
      if (inGen < exGen) return false;
      if (inGen === exGen && Math.floor(origin.at) < Math.floor(existing.at)) return false;
    }
  } catch {
    // read failure → proceed to write
  }
  const p = originPathForWorker(origin.workerKey);
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify({ ...origin, at: Math.floor(origin.at) }, null, 2) + "\n", {
    mode: 0o600,
  });
  await chmod(tmp, 0o600).catch(() => undefined);
  await rename(tmp, p);
  await chmod(p, 0o600).catch(() => undefined);
  return true;
}

/**
 * Build a HandoffOrigin from an already-stamped forward envelope (workerKey
 * + commanderKey + generation + reqId present). Returns null when the stamp
 * is missing (caller must fail visibly, never silently claim origin).
 */
export function originFromStamped(
  envelope: Pick<FleetEnvelope, "reqId"> & {
    workerKey?: unknown;
    commanderKey?: unknown;
    generation?: unknown;
  },
  at?: number,
): HandoffOrigin | null {
  try {
    const workerKey = String((envelope as { workerKey?: unknown })?.workerKey ?? "");
    const commanderKey = String((envelope as { commanderKey?: unknown })?.commanderKey ?? "");
    const generationRaw = (envelope as { generation?: unknown })?.generation;
    const generation =
      typeof generationRaw === "number" && Number.isFinite(generationRaw)
        ? Math.floor(generationRaw)
        : NaN;
    const reqId = String((envelope as { reqId?: unknown })?.reqId ?? "");
    if (workerKey === "" || commanderKey === "" || Number.isNaN(generation) || reqId === "") {
      return null;
    }
    return {
      workerKey,
      fromCommanderKey: commanderKey,
      fromCommanderSession: shortSessionOf(commanderKey),
      reqId,
      generation,
      at: typeof at === "number" && Number.isFinite(at) ? Math.floor(at) : Date.now(),
    };
  } catch {
    return null;
  }
}

/** Read the persisted origin for a worker; null when none/unreadable. Never throws. */
export async function readHandoffOrigin(workerKey: string): Promise<HandoffOrigin | null> {
  try {
    if (String(workerKey ?? "") === "") return null;
    await ensureStateMigrated();
    const raw = await readFile(originPathForWorker(workerKey), "utf8");
    const o = JSON.parse(raw) as Partial<HandoffOrigin>;
    if (typeof o !== "object" || o === null) return null;
    if (typeof o.workerKey !== "string" || o.workerKey === "") return null;
    if (typeof o.fromCommanderKey !== "string" || o.fromCommanderKey === "") return null;
    return {
      workerKey: o.workerKey,
      fromCommanderKey: o.fromCommanderKey,
      fromCommanderSession: typeof o.fromCommanderSession === "string" ? o.fromCommanderSession : shortSessionOf(o.fromCommanderKey),
      reqId: typeof o.reqId === "string" ? o.reqId : "",
      generation: typeof o.generation === "number" && Number.isFinite(o.generation) ? Math.floor(o.generation) : 0,
      at: typeof o.at === "number" && Number.isFinite(o.at) ? Math.floor(o.at) : 0,
    };
  } catch {
    return null;
  }
}

/** Current owner session (bare id) for a workerKey, or null when unassigned/unreadable. Never throws. */
export async function currentOwnerSessionOf(workerKey: string): Promise<string | null> {
  try {
    const asg = await readAssignments();
    if (asg.status === "corrupt" || asg.status === "error") return null;
    const a = asg.state.assignments[String(workerKey ?? "")];
    if (!a) return null;
    return shortSessionOf(a.commanderKey);
  } catch {
    return null;
  }
}

/** Runtime of a registry row (tolerant). Never throws. */
export function runtimeOfEntry(e: unknown): "v1" | "v2" {
  try {
    return runtimeOf(e as Parameters<typeof runtimeOf>[0]);
  } catch {
    return "v1";
  }
}

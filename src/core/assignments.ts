/**
 * assignments.ts — Phase A exclusive multi-commander ownership.
 *
 * Exactly ONE controlling commander per worker. Persisted in:
 *   $XDG_STATE_HOME/opencode/fleet/assignments.json
 *   (fallback ~/.local/state/opencode/fleet/assignments.json)
 * Shape: { version: 1, generation: number, assignments: Record<workerKey, Assignment> }
 * where both keys are composite fleet keys (runtime, daemonId, sessionId)
 * via fleetKeyOf — NEVER a bare sessionId (ses_ ids collide across v1/v2).
 *
 * Rules:
 * - Existing workers (registry rows with no assignment) read as unassigned;
 *   ownership is never guessed from parentID.
 * - All mutations are compare-and-set under ONE withStateLock acquisition
 *   (the lock is shared with registry/auth; never nest withStateLock —
 *   registry/auth reads used here are lock-free, and the journal append
 *   happens AFTER the lock is released).
 * - Generation increments on every mutation and is stamped on each
 *   assignment + journal event so the next phase can order notifications.
 * - Reads validate types and distinguish missing (absent file) from
 *   genuinely-empty (file with zero assignments) from corrupt/error.
 *   Mutations fail CLOSED when assignment/auth/registry state is unreadable.
 * - Bare sessionId selectors that match 0 rows -> not-found, 2+ rows ->
 *   ambiguous error requiring a full composite selector; exact composite
 *   selectors (runtime + daemonId + sessionId) match exactly one row.
 * - Commander authorization via the auth allowlist + registry commander
 *   role; forks (non-empty parentID) can never command.
 *
 * Nothing here throws to callers — every public op returns a result object.
 * Files are 0600 via temp file + rename.
 */

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  REGISTRY_TTL_MS,
  ensureStateMigrated,
  fleetKeyOf,
  registryPath,
  runtimeOf,
  stateDir,
  withStateLock,
} from "./registry.js";
import type { FleetRuntime, RegistryEntry } from "./registry.js";
export type { FleetRuntime } from "./registry.js";
import { authPath } from "./auth.js";
import { appendAssignmentEvent } from "./notify.js";

/** Composite identity of one session: (runtime, daemonId, sessionId). */
export interface FleetIdentity {
  runtime: FleetRuntime;
  daemonId: string;
  sessionId: string;
}

/**
 * Next-phase selector: a bare sessionId when unambiguous, else the full
 * composite (runtime + daemonId + sessionId). Partial qualifiers filter.
 */
export interface SessionSelector {
  sessionId: string;
  runtime?: FleetRuntime;
  daemonId?: string;
}

/** One ownership row, keyed in the file by workerKey. */
export interface Assignment {
  workerKey: string;
  commanderKey: string;
  assignedAt: number;
  generation: number;
}

export interface AssignmentsFile {
  version: 1;
  generation: number;
  assignments: Record<string, Assignment>;
}

/** missing = file absent (all unassigned); ok = readable (maybe empty). */
export type AssignmentsReadStatus = "ok" | "missing" | "corrupt" | "error";

export interface AssignmentsRead {
  state: AssignmentsFile;
  status: AssignmentsReadStatus;
  error?: string;
}

export type OwnershipErrorCode =
  | "state-unreadable"
  | "not-in-registry"
  | "not-commander"
  | "fork-not-commander"
  | "not-found"
  | "ambiguous"
  | "invalid"
  | "self-assign"
  | "self-transfer"
  | "already-owned"
  | "owned-by-other"
  | "not-owned"
  | "stale"
  | "internal";

export interface OpFailure {
  ok: false;
  code: OwnershipErrorCode;
  error: string;
}

export type AssignResult = { ok: true; assignment: Assignment } | OpFailure;
export type UnassignResult =
  | { ok: true; released: Assignment; generation: number }
  | OpFailure;
export type UnassignAllResult =
  | { ok: true; count: number; generation: number }
  | OpFailure;
export type TransferResult = { ok: true; assignment: Assignment } | OpFailure;

export type LookupKind =
  | "unassigned"
  | "owned-by-caller"
  | "owned-by-other"
  | "stale"
  | "not-found"
  | "ambiguous"
  | "error";

export interface AssignmentLookup {
  kind: LookupKind;
  assignment?: Assignment;
  /** Bare sessionId of the owning commander (owned kinds only). */
  ownerSessionId?: string;
  code?: OwnershipErrorCode;
  error?: string;
}

export interface OwnedWorker {
  assignment: Assignment;
  entry: RegistryEntry;
  stale: boolean;
}

function fail(code: OwnershipErrorCode, error: string): OpFailure {
  return { ok: false, code, error };
}

function emptyFile(): AssignmentsFile {
  return { version: 1, generation: 0, assignments: {} };
}

export function assignmentsPath(): string {
  return join(stateDir(), "assignments.json");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isValidAssignment(v: unknown): v is Assignment {
  if (!isRecord(v)) return false;
  return (
    typeof v["workerKey"] === "string" &&
    typeof v["commanderKey"] === "string" &&
    typeof v["assignedAt"] === "number" &&
    Number.isFinite(v["assignedAt"]) &&
    typeof v["generation"] === "number" &&
    Number.isFinite(v["generation"])
  );
}

/** Read assignments.json with a status that separates missing/empty/corrupt. Never throws. */
export async function readAssignments(): Promise<AssignmentsRead> {
  try {
    await ensureStateMigrated();
    let raw: string;
    try {
      raw = await readFile(assignmentsPath(), "utf8");
    } catch (err) {
      if ((err as { code?: unknown })?.code === "ENOENT") {
        return { state: emptyFile(), status: "missing" };
      }
      return { state: emptyFile(), status: "error", error: "assignments read failed" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { state: emptyFile(), status: "corrupt", error: "assignments.json is not valid JSON" };
    }
    if (!isRecord(parsed)) {
      return { state: emptyFile(), status: "corrupt", error: "assignments.json top-level must be an object" };
    }
    const version = (parsed as Record<string, unknown>)["version"];
    if (version !== undefined && version !== 1) {
      return { state: emptyFile(), status: "corrupt", error: "assignments.json version must be 1" };
    }
    const generation = (parsed as Record<string, unknown>)["generation"];
    if (typeof generation !== "number" || !Number.isFinite(generation) || generation < 0) {
      return { state: emptyFile(), status: "corrupt", error: "assignments.json generation must be a number >= 0" };
    }
    const table = (parsed as Record<string, unknown>)["assignments"];
    if (table !== undefined && !isRecord(table)) {
      return { state: emptyFile(), status: "corrupt", error: "assignments.json assignments must be an object" };
    }
    const assignments: Record<string, Assignment> = {};
    if (isRecord(table)) {
      for (const [k, v] of Object.entries(table)) {
        if (isValidAssignment(v) && v.workerKey === k) assignments[k] = { ...v };
        // Invalid rows are dropped defensively; the file itself stays readable.
      }
    }
    return {
      state: { version: 1, generation: Math.floor(generation), assignments },
      status: "ok",
    };
  } catch {
    return { state: emptyFile(), status: "error", error: "assignments read failed" };
  }
}

async function writeAssignmentsFileUnlocked(state: AssignmentsFile): Promise<void> {
  const filePath = assignmentsPath();
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, filePath);
  await chmod(filePath, 0o600);
}

// ---- strict registry/auth readers (fail-closed: corrupt is not empty) ----

export type StrictReadStatus = "ok" | "missing" | "corrupt" | "error";

export interface RegistryStrictRead {
  status: StrictReadStatus;
  entries: RegistryEntry[];
  error?: string;
}

/** Registry rows, validated like readRegistry but reporting corrupt. Never throws. */
export async function readRegistryStrict(): Promise<RegistryStrictRead> {
  try {
    await ensureStateMigrated();
    let raw: string;
    try {
      raw = await readFile(registryPath(), "utf8");
    } catch (err) {
      if ((err as { code?: unknown })?.code === "ENOENT") {
        return { status: "missing", entries: [] };
      }
      return { status: "error", entries: [], error: "registry read failed" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { status: "error", entries: [], error: "registry.json is not valid JSON" };
    }
    if (!Array.isArray(parsed)) {
      return { status: "corrupt", entries: [], error: "registry.json top-level must be an array" };
    }
    const entries = parsed.filter(
      (e): e is RegistryEntry =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as RegistryEntry).sessionId === "string" &&
        typeof (e as RegistryEntry).daemonId === "string",
    );
    return { status: "ok", entries };
  } catch {
    return { status: "error", entries: [], error: "registry read failed" };
  }
}

export interface AuthStrictRead {
  status: StrictReadStatus;
  commanders: string[];
  error?: string;
}

/** Auth allowlist, validated; corrupt JSON fails closed. Never throws. */
export async function readAuthStrict(): Promise<AuthStrictRead> {
  try {
    await ensureStateMigrated();
    let raw: string;
    try {
      raw = await readFile(authPath(), "utf8");
    } catch (err) {
      if ((err as { code?: unknown })?.code === "ENOENT") {
        return { status: "missing", commanders: [] };
      }
      return { status: "error", commanders: [], error: "auth read failed" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { status: "corrupt", commanders: [], error: "auth.json is not valid JSON" };
    }
    if (!isRecord(parsed)) {
      return { status: "corrupt", commanders: [], error: "auth.json top-level must be an object" };
    }
    const rawList = (parsed as Record<string, unknown>)["commanders"];
    if (rawList !== undefined && !Array.isArray(rawList)) {
      return { status: "corrupt", commanders: [], error: "auth.json commanders must be an array" };
    }
    const commanders: string[] = [];
    if (Array.isArray(rawList)) {
      for (const v of rawList) {
        if (typeof v === "string" && v.trim() !== "" && !commanders.includes(v.trim())) {
          commanders.push(v.trim());
        }
      }
    }
    return { status: "ok", commanders };
  } catch {
    return { status: "error", commanders: [], error: "auth read failed" };
  }
}

/** TTL-filtered rows, mirroring listRegistry semantics. Never throws. */
export function freshEntries(entries: RegistryEntry[], now = Date.now()): RegistryEntry[] {
  try {
    return (entries ?? []).filter((e) => {
      if (typeof e?.updatedAt !== "number" || now - e.updatedAt > REGISTRY_TTL_MS) return false;
      return true;
    });
  } catch {
    return [];
  }
}

function parentIdOfEntry(e: RegistryEntry | undefined): string {
  try {
    const p = (e as { parentID?: unknown } | undefined)?.parentID;
    return typeof p === "string" ? p.trim() : "";
  } catch {
    return "";
  }
}

// ---- selector resolution (bare ids must be unambiguous) ----

export type ResolveResult =
  | { ok: true; key: string; entry: RegistryEntry }
  | { ok: false; code: OwnershipErrorCode; error: string };

/**
 * Resolve a selector against fresh registry rows. Exact composite
 * (runtime + daemonId + sessionId) matches one row; bare/partial selectors
 * match by sessionId (+ given qualifiers): 0 -> not-found, 2+ -> ambiguous
 * error requiring the full composite selector. Never throws.
 */
export function resolveSessionKey(
  entries: RegistryEntry[],
  sel: SessionSelector,
): ResolveResult {
  try {
    const sid = String(sel?.sessionId ?? "").trim();
    if (sid === "") {
      return { ok: false, code: "invalid", error: "sessionId must be a non-empty string" };
    }
    const rt = sel?.runtime;
    if (rt !== undefined && rt !== "v1" && rt !== "v2") {
      return { ok: false, code: "invalid", error: `runtime must be v1|v2 (got ${String(rt)})` };
    }
    const daemon = sel?.daemonId !== undefined ? String(sel.daemonId ?? "").trim() : "";
    if (rt !== undefined && daemon !== "") {
      const key = `${rt}\u0000${daemon}\u0000${sid}`;
      const entry = (entries ?? []).find((e) => fleetKeyOf(e) === key);
      if (!entry) {
        return {
          ok: false,
          code: "not-found",
          error: `${sid} not in registry for ${rt}/${daemon} (suggest fleet_discover to find live sessions)`,
        };
      }
      return { ok: true, key, entry };
    }
    let cands = (entries ?? []).filter((e) => e?.sessionId === sid);
    if (rt !== undefined) cands = cands.filter((e) => runtimeOf(e) === rt);
    if (daemon !== "") cands = cands.filter((e) => e?.daemonId === daemon);
    if (cands.length === 0) {
      return {
        ok: false,
        code: "not-found",
        error: `${sid} not in registry (suggest fleet_discover to find live sessions)`,
      };
    }
    if (cands.length > 1) {
      const where = cands.map((e) => `${runtimeOf(e)}/${e.daemonId}`).join(", ");
      return {
        ok: false,
        code: "ambiguous",
        error:
          `${sid} matches ${cands.length} sessions (${where}); ` +
          "specify the full composite selector (runtime + daemonId + sessionId)",
      };
    }
    const entry = cands[0] as RegistryEntry;
    return { ok: true, key: fleetKeyOf(entry), entry };
  } catch {
    return { ok: false, code: "internal", error: "selector resolution failed" };
  }
}

// ---- commander authorization (allowlist + registry role; forks never) ----

export type CommanderCheck =
  | { ok: true; entry: RegistryEntry }
  | { ok: false; code: OwnershipErrorCode; error: string };

/** True when the entry may command: listed or role commander, never a fork. Never throws. */
export function checkCommander(
  entry: RegistryEntry | undefined,
  commanders: string[],
): CommanderCheck {
  try {
    if (!entry) {
      return {
        ok: false,
        code: "not-in-registry",
        error: "caller session not in registry (register with fleet_register first)",
      };
    }
    const sid = String(entry.sessionId ?? "");
    if (parentIdOfEntry(entry) !== "") {
      return {
        ok: false,
        code: "fork-not-commander",
        error: `forks cannot be commanders (${sid} has parentID ${parentIdOfEntry(entry)})`,
      };
    }
    if (Array.isArray(commanders) && commanders.includes(sid)) return { ok: true, entry };
    if ((entry as { role?: unknown }).role === "commander") return { ok: true, entry };
    return {
      ok: false,
      code: "not-commander",
      error: `${sid || "(unknown)"} is not a commander, ask commander to fleet_allow`,
    };
  } catch {
    return { ok: false, code: "internal", error: "commander check failed" };
  }
}

function shortSessionOf(key: string): string {
  try {
    const parts = String(key ?? "").split("\u0000");
    return parts[2] ?? key;
  } catch {
    return key;
  }
}

// ---- lookups ----

/**
 * Classify one worker: unassigned | owned-by-caller | owned-by-other |
 * stale (assignment exists but the worker row is gone/expired) |
 * not-found | ambiguous | error. Never throws.
 */
export async function lookupAssignment(
  worker: SessionSelector,
  callerKey?: string,
): Promise<AssignmentLookup> {
  try {
    const [reg, asg] = await Promise.all([readRegistryStrict(), readAssignments()]);
    if (asg.status === "corrupt" || asg.status === "error") {
      return { kind: "error", code: "state-unreadable", error: `assignment state unreadable (${asg.error ?? asg.status}); refusing (fail-closed)` };
    }
    if (reg.status === "corrupt" || reg.status === "error") {
      return { kind: "error", code: "state-unreadable", error: `registry state unreadable (${reg.error ?? reg.status}); refusing (fail-closed)` };
    }
    const fresh = freshEntries(reg.entries);
    const res = resolveSessionKey(fresh, worker);
    if (!res.ok) {
      return { kind: res.code === "ambiguous" ? "ambiguous" : "not-found", code: res.code, error: res.error };
    }
    const assignment = asg.state.assignments[res.key];
    if (!assignment) return { kind: "unassigned" };
    const workerStillThere = fresh.some((e) => fleetKeyOf(e) === res.key);
    if (!workerStillThere) return { kind: "stale", assignment };
    if (callerKey !== undefined && callerKey !== "" && assignment.commanderKey === callerKey) {
      return { kind: "owned-by-caller", assignment, ownerSessionId: shortSessionOf(assignment.commanderKey) };
    }
    return { kind: "owned-by-other", assignment, ownerSessionId: shortSessionOf(assignment.commanderKey) };
  } catch {
    return { kind: "error", code: "internal", error: "lookup failed" };
  }
}

/** Workers owned by one commander, with stale rows split out. Never throws. */
export async function listAssignedWorkers(commanderKey: string): Promise<
  | { ok: true; owned: OwnedWorker[]; stale: Assignment[]; generation: number }
  | OpFailure
> {
  try {
    const [reg, asg] = await Promise.all([readRegistryStrict(), readAssignments()]);
    if (asg.status === "corrupt" || asg.status === "error") {
      return fail("state-unreadable", `assignment state unreadable (${asg.error ?? asg.status}); refusing (fail-closed)`);
    }
    if (reg.status === "corrupt" || reg.status === "error") {
      return fail("state-unreadable", `registry state unreadable (${reg.error ?? reg.status}); refusing (fail-closed)`);
    }
    const fresh = freshEntries(reg.entries);
    const owned: OwnedWorker[] = [];
    const stale: Assignment[] = [];
    for (const a of Object.values(asg.state.assignments)) {
      if (a.commanderKey !== commanderKey) continue;
      const entry = fresh.find((e) => fleetKeyOf(e) === a.workerKey) ?? null;
      if (entry) owned.push({ assignment: a, entry, stale: false });
      else stale.push(a);
    }
    owned.sort((x, y) => x.entry.sessionId.localeCompare(y.entry.sessionId));
    return { ok: true, owned, stale, generation: asg.state.generation };
  } catch {
    return fail("internal", "listAssignedWorkers failed");
  }
}

/** Fresh registry rows with no live assignment (stale rows count as free). Never throws. */
export async function listUnassignedWorkers(): Promise<
  | { ok: true; workers: RegistryEntry[]; generation: number }
  | OpFailure
> {
  try {
    const [reg, asg] = await Promise.all([readRegistryStrict(), readAssignments()]);
    if (asg.status === "corrupt" || asg.status === "error") {
      return fail("state-unreadable", `assignment state unreadable (${asg.error ?? asg.status}); refusing (fail-closed)`);
    }
    if (reg.status === "corrupt" || reg.status === "error") {
      return fail("state-unreadable", `registry state unreadable (${reg.error ?? reg.status}); refusing (fail-closed)`);
    }
    const fresh = freshEntries(reg.entries);
    const liveWorkerKeys = new Set<string>();
    for (const a of Object.values(asg.state.assignments)) {
      if (fresh.some((e) => fleetKeyOf(e) === a.workerKey)) liveWorkerKeys.add(a.workerKey);
    }
    const workers = fresh
      .filter((e) => !liveWorkerKeys.has(fleetKeyOf(e)))
      .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    return { ok: true, workers, generation: asg.state.generation };
  } catch {
    return fail("internal", "listUnassignedWorkers failed");
  }
}

// ---- mutations (single withStateLock each; journal appended after release) ----

/** Assign an unassigned worker to the calling commander. Never throws. */
export async function assignWorker(
  worker: SessionSelector,
  caller: FleetIdentity,
): Promise<AssignResult> {
  try {
    const callerKey = fleetKeyOf(caller);
    if (String(caller?.sessionId ?? "").trim() === "") {
      return fail("invalid", "caller sessionId must be a non-empty string");
    }
    const [reg, auth, asg] = await Promise.all([
      readRegistryStrict(),
      readAuthStrict(),
      readAssignments(),
    ]);
    if (asg.status === "corrupt" || asg.status === "error") {
      return fail("state-unreadable", `assignment state unreadable (${asg.error ?? asg.status}); refusing (fail-closed)`);
    }
    if (reg.status === "corrupt" || reg.status === "error") {
      return fail("state-unreadable", `registry state unreadable (${reg.error ?? reg.status}); refusing (fail-closed)`);
    }
    if (auth.status === "corrupt" || auth.status === "error") {
      return fail("state-unreadable", `auth state unreadable (${auth.error ?? auth.status}); refusing (fail-closed)`);
    }
    const now = Date.now();
    const fresh = freshEntries(reg.entries, now);
    const callerEntry = fresh.find((e) => fleetKeyOf(e) === callerKey);
    const elig = checkCommander(callerEntry, auth.commanders);
    if (!elig.ok) return fail(elig.code, elig.error);
    const res = resolveSessionKey(fresh, worker);
    if (!res.ok) return fail(res.code, res.error);
    if (res.key === callerKey) {
      return fail("self-assign", "a commander cannot assign itself as its own worker");
    }

    const outcome = await withStateLock(async (): Promise<AssignResult> => {
      const cur = await readAssignments();
      if (cur.status === "corrupt" || cur.status === "error") {
        return fail("state-unreadable", `assignment state unreadable (${cur.error ?? cur.status}); refusing (fail-closed)`);
      }
      const regIn = await readRegistryStrict();
      if (regIn.status === "corrupt" || regIn.status === "error") {
        return fail("state-unreadable", `registry state unreadable (${regIn.error ?? regIn.status}); refusing (fail-closed)`);
      }
      const freshIn = freshEntries(regIn.entries);
      // Re-verify under lock: caller may have lost eligibility concurrently.
      const authIn = await readAuthStrict();
      if (authIn.status === "corrupt" || authIn.status === "error") {
        return fail("state-unreadable", `auth state unreadable (${authIn.error ?? authIn.status}); refusing (fail-closed)`);
      }
      const callerIn = freshIn.find((e) => fleetKeyOf(e) === callerKey);
      const eligIn = checkCommander(callerIn, authIn.commanders);
      if (!eligIn.ok) return fail(eligIn.code, eligIn.error);
      if (!freshIn.some((e) => fleetKeyOf(e) === res.key)) {
        return fail("not-found", `${String(worker.sessionId).trim()} not in registry (suggest fleet_discover to find live sessions)`);
      }
      const existing = cur.state.assignments[res.key];
      if (existing) {
        const workerStillThere = freshIn.some((e) => fleetKeyOf(e) === res.key);
        if (workerStillThere) {
          if (existing.commanderKey === callerKey) {
            return fail("already-owned", `${String(worker.sessionId).trim()} is already assigned to you`);
          }
          return fail(
            "owned-by-other",
            `${String(worker.sessionId).trim()} is owned by ${shortSessionOf(existing.commanderKey)}; only the owning commander can transfer or release it`,
          );
        }
        // Stale row: fall through and claim it.
      }
      const generation = cur.state.generation + 1;
      const assignment: Assignment = {
        workerKey: res.key,
        commanderKey: callerKey,
        assignedAt: Date.now(),
        generation,
      };
      const next: AssignmentsFile = {
        version: 1,
        generation,
        assignments: { ...cur.state.assignments, [res.key]: assignment },
      };
      await writeAssignmentsFileUnlocked(next);
      return { ok: true, assignment };
    });

    if (outcome.ok) {
      // Journal AFTER the lock is released (never nested). Best-effort.
      await appendAssignmentEvent(callerKey, {
        workerKey: outcome.assignment.workerKey,
        generation: outcome.assignment.generation,
        type: "join",
        data: shortSessionOf(outcome.assignment.workerKey),
      }).catch(() => null);
    }
    return outcome;
  } catch {
    return fail("internal", "assignWorker failed");
  }
}

/** Release one worker owned by the calling commander. Never throws. */
export async function unassignWorker(
  worker: SessionSelector,
  caller: FleetIdentity,
): Promise<UnassignResult> {
  try {
    const callerKey = fleetKeyOf(caller);
    if (String(caller?.sessionId ?? "").trim() === "") {
      return fail("invalid", "caller sessionId must be a non-empty string");
    }
    const [reg, auth, asg] = await Promise.all([
      readRegistryStrict(),
      readAuthStrict(),
      readAssignments(),
    ]);
    if (asg.status === "corrupt" || asg.status === "error") {
      return fail("state-unreadable", `assignment state unreadable (${asg.error ?? asg.status}); refusing (fail-closed)`);
    }
    if (reg.status === "corrupt" || reg.status === "error") {
      return fail("state-unreadable", `registry state unreadable (${reg.error ?? reg.status}); refusing (fail-closed)`);
    }
    if (auth.status === "corrupt" || auth.status === "error") {
      return fail("state-unreadable", `auth state unreadable (${auth.error ?? auth.status}); refusing (fail-closed)`);
    }
    const now = Date.now();
    const fresh = freshEntries(reg.entries, now);
    const callerEntry = fresh.find((e) => fleetKeyOf(e) === callerKey);
    const elig = checkCommander(callerEntry, auth.commanders);
    if (!elig.ok) return fail(elig.code, elig.error);
    const res = resolveSessionKey(fresh, worker);
    if (!res.ok) {
      // The worker row may be gone while a stale assignment lingers: fall
      // through to the locked section which reports stale vs not-owned.
      if (res.code !== "not-found") return fail(res.code, res.error);
    }

    const outcome = await withStateLock(async (): Promise<UnassignResult> => {
      const cur = await readAssignments();
      if (cur.status === "corrupt" || cur.status === "error") {
        return fail("state-unreadable", `assignment state unreadable (${cur.error ?? cur.status}); refusing (fail-closed)`);
      }
      const regIn = await readRegistryStrict();
      if (regIn.status === "corrupt" || regIn.status === "error") {
        return fail("state-unreadable", `registry state unreadable (${regIn.error ?? regIn.status}); refusing (fail-closed)`);
      }
      const freshIn = freshEntries(regIn.entries);
       // Find the assignment by live key first. After a worker restarts, its
       // new registry row may resolve while the old assignment is still
       // keyed by the dead daemon: permit releasing that stale row explicitly.
       let key = res.ok ? res.key : null;
       let existing = key ? cur.state.assignments[key] : undefined;
       if (!existing) {
         const sid = String(worker.sessionId ?? "").trim();
         const staleHits = Object.values(cur.state.assignments).filter(
           (a) => {
             const [rt, daemon, id] = a.workerKey.split("\u0000");
             return id === sid &&
               (worker.runtime === undefined || worker.runtime === rt) &&
               (worker.daemonId === undefined || worker.daemonId === daemon) &&
               !freshIn.some((e) => fleetKeyOf(e) === a.workerKey);
           },
         );
         if (staleHits.length > 1) {
           return fail("ambiguous", `${sid} has ${staleHits.length} stale assignments; specify runtime and daemonId to release one`);
         }
         if (staleHits.length === 1) {
           key = staleHits[0]!.workerKey;
           existing = staleHits[0];
         }
      }
      if (!existing || !key) {
        return fail("not-owned", `${String(worker.sessionId).trim()} is unassigned`);
      }
      const workerStillThere = freshIn.some((e) => fleetKeyOf(e) === key);
      if (existing.commanderKey !== callerKey) {
        if (!workerStillThere) {
          return fail("stale", `${String(worker.sessionId).trim()} has a stale assignment (worker row gone); ask its commander ${shortSessionOf(existing.commanderKey)} to release it, or claim via fleet_assign`);
        }
        return fail(
          "not-owned",
          `${String(worker.sessionId).trim()} is owned by ${shortSessionOf(existing.commanderKey)}; only the owning commander can release it`,
        );
      }
      const generation = cur.state.generation + 1;
      const next: AssignmentsFile = {
        version: 1,
        generation,
        assignments: { ...cur.state.assignments },
      };
      delete next.assignments[key];
      await writeAssignmentsFileUnlocked(next);
      return { ok: true, released: existing, generation };
    });

    if (outcome.ok) {
      await appendAssignmentEvent(callerKey, {
        workerKey: outcome.released.workerKey,
        generation: outcome.generation,
        type: "leave",
        data: shortSessionOf(outcome.released.workerKey),
      }).catch(() => null);
    }
    return outcome;
  } catch {
    return fail("internal", "unassignWorker failed");
  }
}

/** Release every worker owned by the calling commander. Never throws. */
export async function unassignAllOwned(caller: FleetIdentity): Promise<UnassignAllResult> {
  try {
    const callerKey = fleetKeyOf(caller);
    if (String(caller?.sessionId ?? "").trim() === "") {
      return fail("invalid", "caller sessionId must be a non-empty string");
    }
    const [reg, auth, asg] = await Promise.all([
      readRegistryStrict(),
      readAuthStrict(),
      readAssignments(),
    ]);
    if (asg.status === "corrupt" || asg.status === "error") {
      return fail("state-unreadable", `assignment state unreadable (${asg.error ?? asg.status}); refusing (fail-closed)`);
    }
    if (reg.status === "corrupt" || reg.status === "error") {
      return fail("state-unreadable", `registry state unreadable (${reg.error ?? reg.status}); refusing (fail-closed)`);
    }
    if (auth.status === "corrupt" || auth.status === "error") {
      return fail("state-unreadable", `auth state unreadable (${auth.error ?? auth.status}); refusing (fail-closed)`);
    }
    const fresh = freshEntries(reg.entries);
    const elig = checkCommander(
      fresh.find((e) => fleetKeyOf(e) === callerKey),
      auth.commanders,
    );
    if (!elig.ok) return fail(elig.code, elig.error);

    const outcome = await withStateLock(async (): Promise<
      { ok: true; released: Assignment[]; generation: number } | OpFailure
    > => {
      const cur = await readAssignments();
      if (cur.status === "corrupt" || cur.status === "error") {
        return fail("state-unreadable", `assignment state unreadable (${cur.error ?? cur.status}); refusing (fail-closed)`);
      }
      const released = Object.values(cur.state.assignments).filter(
        (a) => a.commanderKey === callerKey,
      );
      if (released.length === 0) {
        return { ok: true, released: [], generation: cur.state.generation };
      }
      const generation = cur.state.generation + 1;
      const next: AssignmentsFile = {
        version: 1,
        generation,
        assignments: { ...cur.state.assignments },
      };
      for (const a of released) delete next.assignments[a.workerKey];
      await writeAssignmentsFileUnlocked(next);
      return { ok: true, released, generation };
    });
    if (!outcome.ok) return outcome;

    for (const a of outcome.released) {
      await appendAssignmentEvent(callerKey, {
        workerKey: a.workerKey,
        generation: outcome.generation,
        type: "leave",
        data: shortSessionOf(a.workerKey),
      }).catch(() => null);
    }
    return { ok: true, count: outcome.released.length, generation: outcome.generation };
  } catch {
    return fail("internal", "unassignAllOwned failed");
  }
}

/**
 * Transfer a worker owned by the caller to another eligible commander.
 * The target must exist in the registry and be commander-authorized
 * (never a phantom from explicit args). Never throws.
 */
export async function transferWorker(
  worker: SessionSelector,
  toCommander: SessionSelector,
  caller: FleetIdentity,
): Promise<TransferResult> {
  try {
    const callerKey = fleetKeyOf(caller);
    if (String(caller?.sessionId ?? "").trim() === "") {
      return fail("invalid", "caller sessionId must be a non-empty string");
    }
    const [reg, auth, asg] = await Promise.all([
      readRegistryStrict(),
      readAuthStrict(),
      readAssignments(),
    ]);
    if (asg.status === "corrupt" || asg.status === "error") {
      return fail("state-unreadable", `assignment state unreadable (${asg.error ?? asg.status}); refusing (fail-closed)`);
    }
    if (reg.status === "corrupt" || reg.status === "error") {
      return fail("state-unreadable", `registry state unreadable (${reg.error ?? reg.status}); refusing (fail-closed)`);
    }
    if (auth.status === "corrupt" || auth.status === "error") {
      return fail("state-unreadable", `auth state unreadable (${auth.error ?? auth.status}); refusing (fail-closed)`);
    }
    const now = Date.now();
    const fresh = freshEntries(reg.entries, now);
    const elig = checkCommander(
      fresh.find((e) => fleetKeyOf(e) === callerKey),
      auth.commanders,
    );
    if (!elig.ok) return fail(elig.code, elig.error);
    const wRes = resolveSessionKey(fresh, worker);
    if (!wRes.ok) return fail(wRes.code, wRes.error);
    const tRes = resolveSessionKey(fresh, toCommander);
    if (!tRes.ok) return fail(tRes.code, `target commander: ${tRes.error}`);
    const tElig = checkCommander(tRes.entry, auth.commanders);
    if (!tElig.ok) {
      return fail(
        tElig.code,
        `target commander: ${tElig.error}`,
      );
    }

    const outcome = await withStateLock(async (): Promise<TransferResult> => {
      const cur = await readAssignments();
      if (cur.status === "corrupt" || cur.status === "error") {
        return fail("state-unreadable", `assignment state unreadable (${cur.error ?? cur.status}); refusing (fail-closed)`);
      }
      const regIn = await readRegistryStrict();
      if (regIn.status === "corrupt" || regIn.status === "error") {
        return fail("state-unreadable", `registry state unreadable (${regIn.error ?? regIn.status}); refusing (fail-closed)`);
      }
      const freshIn = freshEntries(regIn.entries);
      const authIn = await readAuthStrict();
      if (authIn.status === "corrupt" || authIn.status === "error") {
        return fail("state-unreadable", `auth state unreadable (${authIn.error ?? authIn.status}); refusing (fail-closed)`);
      }
      // Re-verify both ends under lock (CAS against concurrent races).
      const callerIn = freshIn.find((e) => fleetKeyOf(e) === callerKey);
      const eligIn = checkCommander(callerIn, authIn.commanders);
      if (!eligIn.ok) return fail(eligIn.code, eligIn.error);
      if (!freshIn.some((e) => fleetKeyOf(e) === wRes.key)) {
        return fail("not-found", `${String(worker.sessionId).trim()} not in registry (suggest fleet_discover to find live sessions)`);
      }
      const targetIn = freshIn.find((e) => fleetKeyOf(e) === tRes.key);
      const tEligIn = checkCommander(targetIn, authIn.commanders);
      if (!tEligIn.ok) return fail(tEligIn.code, `target commander: ${tEligIn.error}`);
      const existing = cur.state.assignments[wRes.key];
      if (!existing) {
        return fail("not-owned", `${String(worker.sessionId).trim()} is unassigned; assign it with fleet_assign first`);
      }
      if (!freshIn.some((e) => fleetKeyOf(e) === wRes.key)) {
        return fail("stale", `${String(worker.sessionId).trim()} has a stale assignment (worker row gone)`);
      }
      if (existing.commanderKey !== callerKey) {
        return fail(
          "owned-by-other",
          `${String(worker.sessionId).trim()} is owned by ${shortSessionOf(existing.commanderKey)}; only the owning commander can transfer it`,
        );
      }
      if (tRes.key === callerKey) {
        return fail("self-transfer", `${String(worker.sessionId).trim()} is already assigned to you`);
      }
      const generation = cur.state.generation + 1;
      const assignment: Assignment = {
        workerKey: wRes.key,
        commanderKey: tRes.key,
        assignedAt: Date.now(),
        generation,
      };
      const next: AssignmentsFile = {
        version: 1,
        generation,
        assignments: { ...cur.state.assignments, [wRes.key]: assignment },
      };
      await writeAssignmentsFileUnlocked(next);
      return { ok: true, assignment };
    });

    if (outcome.ok) {
      const note = `${shortSessionOf(callerKey)} -> ${shortSessionOf(tRes.key)}`;
      await appendAssignmentEvent(callerKey, {
        workerKey: outcome.assignment.workerKey,
        generation: outcome.assignment.generation,
        type: "transfer",
        data: note,
      }).catch(() => null);
      await appendAssignmentEvent(tRes.key, {
        workerKey: outcome.assignment.workerKey,
        generation: outcome.assignment.generation,
        type: "transfer",
        data: note,
      }).catch(() => null);
    }
    return outcome;
  } catch {
    return fail("internal", "transferWorker failed");
  }
}

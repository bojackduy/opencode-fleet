/**
 * commanderRecovery.ts — explicit operator recovery after a daemon restart.
 *
 * Production failure: the v1 daemon id used to be `<hostname>-<pid>-<port>`
 * and the commander session `ses_...` reappears after a restart under a NEW
 * daemon (new pid, new stable `proc-...` token) with the SAME sessionId.
 * The safe automatic same-process migration (daemonMigration.ts) REFUSES
 * when the process changed, so 16 assignment rows stay keyed by the dead
 * `Mac.lan-81615-4096:v1` commander while the live commander owns nothing.
 *
 * Remedy: `fleet_recover_commander({oldDaemonId})`, callable only from a
 * currently registered + commander-authorized session whose sessionId
 * EQUALS the old owner's sessionId (self derived from tool context+runtime;
 * the new commander sessionId is never an arg). Under the STRICT
 * cross-process lock (withStateLockStrict — never the degraded unlocked
 * fallback; the global isStateLockHeld depth is NOT consulted because it may
 * be true from an unrelated concurrent task) and compare-and-set:
 *
 *   - old daemon pid must NOT be alive (process.kill(pid,0); EPERM = alive).
 *   - caller row must be live (fresh TTL) + commander-authorized (forks denied).
 *   - old owner assignments must exist (>=1 row with old commanderKey).
 *   - no assignment may already be owned by the NEW caller key (conflict).
 *   - v1/v2 isolation: only rows matching the caller's runtime migrate.
 *   - ONLY assignment.commanderKey migrates old→new; workerKey is preserved
 *     verbatim (workers span many dead daemons and re-register themselves
 *     on heartbeat). Each affected row's generation is bumped by +1 so old
 *     queued generation-stamped envelopes go stale (delivery fails closed
 *     with "re-send from the current owner").
 *   - per-commander event journal + ACK cursor are moved/merged to the new
 *     key (fail closed when corrupt/unreadable); durable handoff origins
 *     have fromCommanderKey rewritten in place (fail closed when corrupt).
 *
 * Nothing here throws to tool callers — the public op returns a result
 * object. File writes are 0600 atomic temp+rename. No real-state access in
 * tests: everything resolves via stateDir() (XDG_STATE_HOME in tests).
 */

import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  fleetKeyOf,
  runtimeOf,
  withStateLockStrict,
} from "./registry.js";
import type { FleetRuntime } from "./registry.js";
import {
  assignmentsPath,
  checkCommander,
  freshEntries,
  readAssignments,
  readAuthStrict,
  readRegistryStrict,
} from "./assignments.js";
import type { Assignment, AssignmentsFile, FleetIdentity } from "./assignments.js";
import { assignmentJournalPaths } from "./notify.js";
import type { AssignmentEvent } from "./notify.js";
import { originPathForWorker } from "./ownershipControl.js";
import { parsePidPort, stripDaemonMarker } from "./daemonIdentity.js";
import { withV1Marker } from "./v1.js";

export type RecoveryErrorCode =
  | "invalid"
  | "unknown-caller"
  | "not-in-registry"
  | "not-commander"
  | "fork-not-commander"
  | "state-unreadable"
  | "old-unparseable"
  | "old-alive"
  | "runtime-mismatch"
  | "no-assignments"
  | "conflict"
  | "journal-corrupt"
  | "origin-corrupt"
  | "lock-unavailable"
  | "internal";

export type RecoverCommanderResult =
  | {
      ok: true;
      recovered: number;
      stale: number;
      generation: number;
      oldDaemon: string;
      newDaemon: string;
      sessionId: string;
      journalsMoved: number;
      originsMoved: number;
    }
  | { ok: false; code: RecoveryErrorCode; error: string };

function fail(code: RecoveryErrorCode, error: string): RecoverCommanderResult {
  return { ok: false, code, error };
}

function splitKey(key: string): [string, string, string] | null {
  try {
    const parts = String(key ?? "").split("\u0000");
    if (parts.length !== 3) return null;
    return [parts[0] as string, parts[1] as string, parts[2] as string];
  } catch {
    return null;
  }
}

function shortOf(key: string): string {
  try {
    return String(key ?? "").split("\u0000")[2] ?? key;
  } catch {
    return key;
  }
}

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, filePath);
  await chmod(filePath, 0o600);
}

async function readJsonRaw(filePath: string): Promise<{ found: boolean; raw?: string }> {
  try {
    const raw = await readFile(filePath, "utf8");
    return { found: true, raw };
  } catch (err) {
    if ((err as { code?: unknown })?.code === "ENOENT") return { found: false };
    throw err;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** True when the pid is alive. EPERM (no permission) counts as alive. Never throws. */
export function isPidAlive(pid: number): boolean {
  try {
    if (!Number.isSafeInteger(pid) || pid <= 0) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      const code = (err as { code?: unknown })?.code;
      if (code === "ESRCH") return false;
      return true;
    }
  } catch {
    return true;
  }
}

/**
 * Explicit commander recovery. Caller identity comes from the tool context
 * (same sessionId as the old owner required); oldDaemonId is the dead
 * daemon to recover from. Never throws (result object, fail-closed).
 */
export async function recoverCommander(
  caller: FleetIdentity,
  oldDaemonIdRaw: unknown,
): Promise<RecoverCommanderResult> {
  try {
    const sessionId = String(caller?.sessionId ?? "").trim();
    const callerDaemon = String(caller?.daemonId ?? "").trim();
    const callerRuntime: FleetRuntime = caller?.runtime === "v2" ? "v2" : "v1";
    if (sessionId === "") return fail("invalid", "caller sessionId must be a non-empty string");
    if (callerDaemon === "") return fail("unknown-caller", "could not determine current daemon id; refusing");
    const oldRaw = String(oldDaemonIdRaw ?? "").trim();
    if (oldRaw === "") return fail("invalid", "oldDaemonId must be a non-empty string");
    const oldBare = stripDaemonMarker(oldRaw);
    if (oldBare === "") return fail("old-unparseable", "oldDaemonId is empty after marker strip; refusing");
    const oldPP = parsePidPort(oldRaw);
    if (!oldPP) return fail("old-unparseable", `oldDaemonId pid/port unparseable (${oldRaw}); refusing`);
    const oldRuntime = runtimeOf({ runtime: undefined, daemonId: oldRaw });
    if (oldRuntime !== callerRuntime) {
      return fail("runtime-mismatch", `old daemon runtime ${oldRuntime} does not match caller ${callerRuntime}; v1/v2 rows stay isolated (fail-closed)`);
    }
    if (stripDaemonMarker(callerDaemon) === oldBare) {
      return fail("invalid", "oldDaemonId equals the current daemon; nothing to recover");
    }
    if (isPidAlive(oldPP.pid)) {
      return fail("old-alive", `old daemon process ${oldPP.pid} still running; refusing (fail-closed, retry after the old daemon exits)`);
    }
    const callerKey = fleetKeyOf({ runtime: callerRuntime, daemonId: callerDaemon, sessionId });

    try {
      return await withStateLockStrict(async (): Promise<RecoverCommanderResult> => {
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
        const callerEntry = fresh.find((e) => fleetKeyOf(e) === callerKey);
        const elig = checkCommander(callerEntry, auth.commanders);
        if (!elig.ok) return fail(elig.code as RecoveryErrorCode, elig.error);
        if (isPidAlive(oldPP.pid)) {
          return fail("old-alive", `old daemon process ${oldPP.pid} still running; refusing (fail-closed)`);
        }

        const matchesOldCommander = (commanderKey: string): boolean => {
          const p = splitKey(commanderKey);
          if (!p) return false;
          if (p[0] !== callerRuntime) return false;
          if (p[2] !== sessionId) return false;
          return stripDaemonMarker(p[1]) === oldBare;
        };

        const affected = Object.entries(asg.state.assignments).filter(([, a]) =>
          matchesOldCommander(a.commanderKey),
        );
        if (affected.length === 0) {
          return fail("no-assignments", `no assignments owned by ${sessionId} on ${oldBare}; nothing to recover`);
        }
        const alreadyOwned = Object.values(asg.state.assignments).filter(
          (a) => a.commanderKey === callerKey,
        );
        if (alreadyOwned.length > 0) {
          return fail("conflict", `current identity already owns ${alreadyOwned.length} assignment(s); refusing to merge (fail-closed)`);
        }
        for (const [wk, a] of affected) {
          if (a.workerKey !== wk) {
            return fail("state-unreadable", "assignment map key mismatch; refusing (fail-closed)");
          }
          const wp = splitKey(a.workerKey);
          if (!wp || wp[0] !== callerRuntime) {
            return fail("conflict", `worker ${shortOf(a.workerKey)} runtime mismatch; v1/v2 rows stay isolated (fail-closed)`);
          }
        }

        const distinctOldCommanderKeys = [...new Set(affected.map(([, a]) => a.commanderKey))];
        const journalPlans: Array<{
          oldKey: string;
          oldEventsPath: string;
          oldCursorPath: string;
          newEventsPath: string;
          newCursorPath: string;
          merged: AssignmentEvent[];
          oldCursor: unknown | null;
          newCursor: unknown | null;
          oldCursorFound: boolean;
          newCursorFound: boolean;
        }> = [];
        for (const oldKey of distinctOldCommanderKeys) {
          const op = assignmentJournalPaths(oldKey);
          const np = assignmentJournalPaths(callerKey);
          let oldEvents: unknown;
          try {
            const r = await readJsonRaw(op.eventsPath);
            if (!r.found) oldEvents = [];
            else {
              try {
                oldEvents = JSON.parse(r.raw as string);
              } catch {
                return fail("journal-corrupt", `journal ${op.eventsPath} corrupt (invalid JSON); refusing (fail-closed)`);
              }
              if (!Array.isArray(oldEvents)) {
                return fail("journal-corrupt", `journal ${op.eventsPath} corrupt (top-level must be an array); refusing (fail-closed)`);
              }
            }
          } catch {
            return fail("journal-corrupt", `journal ${op.eventsPath} unreadable; refusing (fail-closed)`);
          }
          let newEvents: unknown;
          try {
            const r = await readJsonRaw(np.eventsPath);
            if (!r.found) newEvents = [];
            else {
              try {
                newEvents = JSON.parse(r.raw as string);
              } catch {
                return fail("journal-corrupt", `journal ${np.eventsPath} corrupt (invalid JSON); refusing (fail-closed)`);
              }
              if (!Array.isArray(newEvents)) {
                return fail("journal-corrupt", `journal ${np.eventsPath} corrupt (top-level must be an array); refusing (fail-closed)`);
              }
            }
          } catch {
            return fail("journal-corrupt", `journal ${np.eventsPath} unreadable; refusing (fail-closed)`);
          }
          const rewrite = (list: unknown[]): AssignmentEvent[] =>
            (list as AssignmentEvent[]).map((ev) => {
              if (!isRecord(ev)) return ev as unknown as AssignmentEvent;
              if (ev["commanderKey"] === oldKey) return { ...(ev as object), commanderKey: callerKey } as AssignmentEvent;
              return ev as unknown as AssignmentEvent;
            });
          const base = rewrite(newEvents as unknown[]);
          const incoming = rewrite(oldEvents as unknown[]);
          const seen = new Set(base.map((e) => (isRecord(e) ? String((e as Record<string, unknown>)["id"] ?? "") : "")));
          const merged = [...base];
          for (const e of incoming) {
            const id = isRecord(e) ? String((e as Record<string, unknown>)["id"] ?? "") : "";
            if (id === "" || seen.has(id)) continue;
            seen.add(id);
            merged.push(e);
          }
          merged.sort((a, b) => {
            const ia = isRecord(a) ? String((a as Record<string, unknown>)["id"] ?? "") : "";
            const ib = isRecord(b) ? String((b as Record<string, unknown>)["id"] ?? "") : "";
            return ia < ib ? -1 : ia > ib ? 1 : 0;
          });
          let oldCursor: unknown | null = null;
          let newCursor: unknown | null = null;
          let oldCursorFound = false;
          let newCursorFound = false;
          try {
            const r = await readJsonRaw(op.cursorPath);
            if (r.found) {
              oldCursorFound = true;
              try {
                oldCursor = JSON.parse(r.raw as string);
              } catch {
                return fail("journal-corrupt", `cursor ${op.cursorPath} corrupt (invalid JSON); refusing (fail-closed)`);
              }
              if (!isRecord(oldCursor) || typeof oldCursor["ackedId"] !== "string" || oldCursor["ackedId"] === "") {
                return fail("journal-corrupt", `cursor ${op.cursorPath} corrupt (ackedId must be a non-empty string); refusing (fail-closed)`);
              }
            }
            const rn = await readJsonRaw(np.cursorPath);
            if (rn.found) {
              newCursorFound = true;
              try {
                newCursor = JSON.parse(rn.raw as string);
              } catch {
                return fail("journal-corrupt", `cursor ${np.cursorPath} corrupt (invalid JSON); refusing (fail-closed)`);
              }
              if (!isRecord(newCursor) || typeof newCursor["ackedId"] !== "string" || newCursor["ackedId"] === "") {
                return fail("journal-corrupt", `cursor ${np.cursorPath} corrupt (ackedId must be a non-empty string); refusing (fail-closed)`);
              }
            }
          } catch {
            return fail("journal-corrupt", "cursor unreadable; refusing (fail-closed)");
          }
          if (oldCursorFound && newCursorFound) {
            const oa = String((oldCursor as Record<string, unknown>)["ackedId"]);
            const na = String((newCursor as Record<string, unknown>)["ackedId"]);
            if (oa !== na) {
              return fail("journal-corrupt", "conflicting ACK cursors for old and new commander; refusing (fail-closed)");
            }
          }
          journalPlans.push({
            oldKey,
            oldEventsPath: op.eventsPath,
            oldCursorPath: op.cursorPath,
            newEventsPath: np.eventsPath,
            newCursorPath: np.cursorPath,
            merged,
            oldCursor,
            newCursor,
            oldCursorFound,
            newCursorFound,
          });
        }

        const originsProbe = originPathForWorker("v1\u0000x\u0000y");
        const originsDir = dirname(originsProbe);
        let originFiles: string[] = [];
        try {
          originFiles = await readdir(originsDir);
        } catch (err) {
          if ((err as { code?: unknown })?.code !== "ENOENT") {
            return fail("origin-corrupt", "handoff origins unreadable; refusing (fail-closed)");
          }
          originFiles = [];
        }
        const originUpdates: Array<{ path: string; value: Record<string, unknown> }> = [];
        let originsMatched = 0;
        for (const f of originFiles) {
          if (!f.endsWith(".origin.json")) continue;
          const p = join(originsDir, f);
          let parsed: unknown;
          try {
            const raw = await readFile(p, "utf8");
            try {
              parsed = JSON.parse(raw);
            } catch {
              return fail("origin-corrupt", `origin ${f} corrupt (invalid JSON); refusing (fail-closed)`);
            }
          } catch {
            return fail("origin-corrupt", `origin ${f} unreadable; refusing (fail-closed)`);
          }
          if (!isRecord(parsed) || typeof parsed["workerKey"] !== "string" || typeof parsed["fromCommanderKey"] !== "string") {
            return fail("origin-corrupt", `origin ${f} corrupt (workerKey/fromCommanderKey required); refusing (fail-closed)`);
          }
          const ck = String(parsed["fromCommanderKey"]);
          if (matchesOldCommander(ck)) {
            originsMatched++;
            originUpdates.push({ path: p, value: { ...parsed, fromCommanderKey: callerKey } });
          }
        }

        let maxNewGen = asg.state.generation;
        const nextAssignments: Record<string, Assignment> = { ...asg.state.assignments };
        for (const [wk, a] of affected) {
          const cur = nextAssignments[wk];
          if (!cur || cur.commanderKey !== a.commanderKey) {
            return fail("conflict", `ownership moved for ${shortOf(a.workerKey)} during recovery; refusing (fail-closed)`);
          }
          const bumped: Assignment = {
            workerKey: cur.workerKey,
            commanderKey: callerKey,
            assignedAt: cur.assignedAt,
            generation: Math.floor(cur.generation) + 1,
          };
          nextAssignments[wk] = bumped;
          if (bumped.generation > maxNewGen) maxNewGen = bumped.generation;
        }
        if (maxNewGen <= asg.state.generation) maxNewGen = asg.state.generation + 1;
        const nextFile: AssignmentsFile = {
          version: 1,
          generation: maxNewGen,
          assignments: nextAssignments,
        };

        for (const plan of journalPlans) {
          if (plan.merged.length > 0 || plan.oldCursorFound) {
            if (plan.newEventsPath !== plan.oldEventsPath) {
              await atomicWriteJson(plan.newEventsPath, plan.merged);
            } else {
              await atomicWriteJson(plan.newEventsPath, plan.merged);
            }
          }
          if (plan.oldCursorFound && !plan.newCursorFound && plan.newCursorPath !== plan.oldCursorPath) {
            await atomicWriteJson(plan.newCursorPath, plan.oldCursor);
          }
        }
        await atomicWriteJson(assignmentsPath(), nextFile);
        for (const u of originUpdates) {
          await atomicWriteJson(u.path, u.value);
        }
        let journalsMoved = 0;
        for (const plan of journalPlans) {
          if (plan.newEventsPath !== plan.oldEventsPath) {
            const r = await readJsonRaw(plan.oldEventsPath);
            if (r.found) {
              await rm(plan.oldEventsPath, { force: true }).catch(() => undefined);
              journalsMoved++;
            }
            if (plan.oldCursorFound && plan.newCursorPath !== plan.oldCursorPath) {
              await rm(plan.oldCursorPath, { force: true }).catch(() => undefined);
            }
          }
        }

        const stale = affected.filter(
          ([, a]) => !fresh.some((e) => fleetKeyOf(e) === a.workerKey),
        ).length;
        void withV1Marker;
        return {
          ok: true,
          recovered: affected.length,
          stale,
          generation: maxNewGen,
          oldDaemon: oldBare,
          newDaemon: callerDaemon,
          sessionId,
          journalsMoved,
          originsMoved: originsMatched,
        };
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/state lock unavailable/.test(msg)) {
        return fail("lock-unavailable", `${msg}`);
      }
      return fail("internal", `recovery failed (${msg}); refusing (fail-closed)`);
    }
  } catch {
    return fail("internal", "recovery failed; refusing (fail-closed)");
  }
}

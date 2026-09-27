/**
 * daemonMigration.ts — safe legacy hostname-daemon recovery.
 *
 * Production failure: the v1 daemon id used to be `<hostname>-<pid>-<port>`
 * and every caller recomputed it, so a mid-process hostname flip
 * (`Mac.lan-81615-4096:v1` -> `Spartans-...local-81615-4096:v1`) forked the
 * commander's composite identity. Worse, `registerSelf`'s legacy
 * sessionId-only fallback then OVERWROTE the commander's registry row in
 * place, so the old registry row is gone while assignments.json,
 * per-commander journals, and handoff origins still reference the old
 * daemon. The 16 workers vanish from every scoped view while `fleet_assign`
 * insists they are owned by the same session.
 *
 * Recovery (triggered from `registerSelf`, which every heartbeat/rebeat
 * calls): when a stable v1 identity registers and a legacy assignment key
 * or registry row exists with the SAME sessionId AND the SAME parsed
 * numeric pid/port (hostname ignored), rewrite all references of the old
 * daemon to the new stable daemon — registry rows, assignment
 * workerKey/commanderKey (generation preserved, never bumped), journal
 * contents + file renames + ACK cursors, and handoff-origin files.
 *
 * Safety (fail closed):
 *   - Anchor required: at least one legacy v1 key/row with the registering
 *     sessionId AND matching numeric pid/port. The registry row alone is
 *     NOT required (it may already be overwritten) — but a bare sessionId
 *     match is NEVER enough.
 *   - Direction is legacy -> stable only. A stable id with a different
 *     token (same pid/port reused by a later process) is NEVER rewritten:
 *     that is a different process, and merging would steal ownership.
 *     Unparseable ids never migrate.
 *   - v1 only: v2 keys/rows are never touched, so v1/v2 collisions stay
 *     isolated.
 *   - Same-session rows with a DIFFERENT daemon (non-matching pid/port)
 *     are kept as-is; ambiguity then surfaces via the composite selectors
 *     instead of a silent merge.
 *   - Corrupt journals/origins are never clobbered (skipped in place).
 *   - No locking here: the caller (`registerSelf`) MUST hold the
 *     cross-process state lock. All reads/writes below are raw file I/O;
 *     nesting `withStateLock` would deadlock, and running on the degraded
 *     unlocked path would race — so `registerSelf` gates on
 *     `isStateLockHeld()` and skips (next heartbeat retries).
 *
 * Stale envelopes stamped with the old daemon are NOT silently remapped:
 * delivery keeps failing closed with the readable re-send error
 * ("re-send from the current owner"), so nothing is orphan-delivered.
 * Nothing here throws to callers.
 */

import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runtimeOf } from "./registry.js";
import type { RegistryEntry } from "./registry.js";
import { assignmentsPath, readAssignments } from "./assignments.js";
import type { Assignment, AssignmentsFile } from "./assignments.js";
import { assignmentJournalPaths } from "./notify.js";
import { originPathForWorker } from "./ownershipControl.js";
import {
  isStableDaemonId,
  parsePidPort,
  processStartedAt,
  sameProcessHint,
  stripDaemonMarker,
} from "./daemonIdentity.js";

export interface DaemonMigrationInput {
  /** Live registry array from registerSelf (mutated in place). */
  entries: RegistryEntry[];
  sessionId: string;
  /** New daemon id, marked form (`:v1`) as stored. */
  newDaemonId: string;
  now?: number;
}

export interface DaemonMigrationResult {
  ran: boolean;
  reason: string;
  oldDaemons: string[];
  rewrittenAssignments: number;
  rewrittenRegistryRows: number;
  journalsMoved: number;
  originsMoved: number;
}

function emptyResult(): DaemonMigrationResult {
  return {
    ran: false,
    reason: "",
    oldDaemons: [],
    rewrittenAssignments: 0,
    rewrittenRegistryRows: 0,
    journalsMoved: 0,
    originsMoved: 0,
  };
}

let last: (DaemonMigrationResult & { at: number }) | null = null;

/** Last migration attempt (diagnostics/tests). Never throws. */
export function lastDaemonMigration(): (DaemonMigrationResult & { at: number }) | null {
  try {
    return last ? { ...last, oldDaemons: [...last.oldDaemons] } : null;
  } catch {
    return null;
  }
}

export const MANUAL_RECOVERY_HINT =
  "Manual recovery: from the same live commander session call " +
  "fleet_recover_commander({oldDaemonId}) after the old process exits; " +
  "do not copy state files between machines.";

function splitKey(key: string): [string, string, string] | null {
  try {
    const parts = String(key ?? "").split("\u0000");
    if (parts.length !== 3) return null;
    return [parts[0] as string, parts[1] as string, parts[2] as string];
  } catch {
    return null;
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

async function readJsonFile(filePath: string): Promise<{ found: boolean; value: unknown }> {
  try {
    const raw = await readFile(filePath, "utf8");
    try {
      return { found: true, value: JSON.parse(raw) };
    } catch {
      return { found: true, value: undefined };
    }
  } catch (err) {
    if ((err as { code?: unknown })?.code === "ENOENT") return { found: false, value: undefined };
    return { found: true, value: undefined };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Merge duplicate same-session/same-daemon rows (keeps newest, fills blanks). */
function dedupeRegistryEntries(entries: RegistryEntry[]): void {
  try {
    const seen = new Map<string, number>();
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i] as RegistryEntry;
      const key = `${runtimeOf(e)}\u0000${stripDaemonMarker(e.daemonId)}\u0000${e.sessionId}`;
      const at = seen.get(key);
      if (at === undefined) {
        seen.set(key, i);
        continue;
      }
      const keep = entries[at] as RegistryEntry;
      const neu = (Number(e.updatedAt) || 0) >= (Number(keep.updatedAt) || 0) ? e : keep;
      const old = neu === e ? keep : e;
      const merged: RegistryEntry = { ...old, ...neu };
      for (const f of ["title", "summary", "directory", "agent", "model", "status", "lastDone", "parentID", "location"] as const) {
        const cur = (merged as unknown as Record<string, unknown>)[f];
        if ((cur === "" || cur === undefined) && (old as unknown as Record<string, unknown>)[f] !== "") {
          (merged as unknown as Record<string, unknown>)[f] = (old as unknown as Record<string, unknown>)[f];
        }
      }
      if (!merged.endpoint && old.endpoint) merged.endpoint = old.endpoint;
      merged.updatedAt = Math.max(Number(keep.updatedAt) || 0, Number(e.updatedAt) || 0);
      entries[at] = merged;
      entries.splice(i, 1);
      i--;
    }
  } catch {
    // best-effort only
  }
}

export async function migrateDaemonKeysUnlocked(
  input: DaemonMigrationInput,
): Promise<DaemonMigrationResult> {
  const done = (r: DaemonMigrationResult): DaemonMigrationResult => {
    last = { ...r, oldDaemons: [...r.oldDaemons], at: Date.now() };
    return r;
  };
  try {
    const res = emptyResult();
    const sessionId = String(input?.sessionId ?? "").trim();
    const newMarked = String(input?.newDaemonId ?? "");
    const now =
      typeof input?.now === "number" && Number.isFinite(input.now) ? Math.floor(input.now) : Date.now();
    if (sessionId === "") return done({ ...res, reason: "empty sessionId; skipping" });
    if (runtimeOf({ runtime: undefined, daemonId: newMarked }) !== "v1" || !isStableDaemonId(newMarked)) {
      return done({ ...res, reason: "new daemon is not a stable v1 identity; skipping" });
    }
    const newBare = stripDaemonMarker(newMarked);
    const newPP = parsePidPort(newMarked);
    if (!newPP) return done({ ...res, reason: "new daemon pid/port unparseable; skipping" });
    const entries = Array.isArray(input?.entries) ? input.entries : [];

    const asg = await readAssignments();
    if (asg.status === "corrupt" || asg.status === "error") {
      return done({
        ...res,
        reason: `assignment state unreadable (${asg.error ?? asg.status}); refusing (fail-closed, will retry on next heartbeat)`,
      });
    }

    // Anchor: legacy v1 keys/rows with SAME sessionId + SAME numeric pid/port.
    const oldBares = new Set<string>();
    const consider = (daemonRaw: unknown): void => {
      try {
        const bare = stripDaemonMarker(daemonRaw);
        if (bare === "" || bare === newBare) return;
        if (isStableDaemonId(daemonRaw)) {
          // A different stable token with same pid/port = a different
          // process (PID reuse). This is recorded by the caller check below.
          return;
        }
        const pp = parsePidPort(daemonRaw);
        if (pp && pp.pid === newPP.pid && pp.port === newPP.port) oldBares.add(bare);
      } catch {
        // ignore
      }
    };
    for (const a of Object.values(asg.state.assignments)) {
      for (const k of [a.workerKey, a.commanderKey]) {
        const p = splitKey(k);
        if (!p || p[0] !== "v1" || p[2] !== sessionId) continue;
        consider(p[1]);
      }
    }
    for (const e of entries) {
      try {
        if (e.sessionId !== sessionId || runtimeOf(e) !== "v1") continue;
        consider(e.daemonId);
      } catch {
        // ignore
      }
    }

    // Fail closed: a competing STABLE identity for the same session with the
    // same pid/port but a different token means a different process is (or
    // was) alive with this pid/port — never steal its keys.
    const stableConflicts: string[] = [];
    {
      const seen = new Set<string>();
      const check = (daemonRaw: unknown): void => {
        try {
          const bare = stripDaemonMarker(daemonRaw);
          if (bare === "" || bare === newBare || seen.has(bare)) return;
          seen.add(bare);
          if (isStableDaemonId(daemonRaw) && sameProcessHint(daemonRaw, newMarked)) {
            stableConflicts.push(bare);
          }
        } catch {
          // ignore
        }
      };
      for (const a of Object.values(asg.state.assignments)) {
        const pw = splitKey(a.workerKey);
        const pc = splitKey(a.commanderKey);
        if (pw && pw[0] === "v1" && pw[2] === sessionId) check(pw[1]);
        if (pc && pc[0] === "v1" && pc[2] === sessionId) check(pc[1]);
      }
      for (const e of entries) {
        try {
          if (e.sessionId === sessionId && runtimeOf(e) === "v1") check(e.daemonId);
        } catch {
          // ignore
        }
      }
    }
    if (stableConflicts.length > 0) {
      return done({
        ...res,
        reason:
          `conflicting stable daemon(s) ${stableConflicts.join(", ")} for ${sessionId} ` +
          `(same pid/port, different process token — possible PID reuse); refusing to merge. ${MANUAL_RECOVERY_HINT}`,
      });
    }

    if (oldBares.size === 0) return done({ ...res, reason: "no legacy hostname keys for this session" });
    const oldList = [...oldBares];
    res.oldDaemons = oldList;

    // A PID and port can be reused by a later process resuming the same
    // session. Ownership created before this process existed cannot safely
    // be attributed to it merely because those numbers happen to match.
    const start = processStartedAt();
    const beforeStart = Object.values(asg.state.assignments).some((a) => {
      const keys = [a.workerKey, a.commanderKey];
      const anchored = keys.some((key) => {
        const p = splitKey(key);
        return p?.[0] === "v1" && p[2] === sessionId && oldList.includes(stripDaemonMarker(p[1]));
      });
      return anchored && (!Number.isFinite(a.assignedAt) || a.assignedAt < start - 2_000);
    });
    if (beforeStart) {
      return done({
        ...res,
        reason: `legacy ownership for ${sessionId} predates this process (possible PID reuse); refusing to merge. ${MANUAL_RECOVERY_HINT}`,
      });
    }

    // Build the rewrite map for every v1 assignment key on an old daemon.
    const keyMap = new Map<string, string>();
    for (const a of Object.values(asg.state.assignments)) {
      for (const k of [a.workerKey, a.commanderKey]) {
        if (keyMap.has(k)) continue;
        const p = splitKey(k);
        if (!p || p[0] !== "v1") continue;
        if (oldList.includes(stripDaemonMarker(p[1]))) {
          keyMap.set(k, `v1\u0000${newMarked}\u0000${p[2]}`);
        }
      }
    }

    // Assignments: rewrite keys, preserve generation/assignedAt, merge on
    // collision (higher generation wins, tie -> earliest assignedAt).
    let assignmentsChanged = false;
    {
      const next: Record<string, Assignment> = {};
      for (const [wk, a] of Object.entries(asg.state.assignments)) {
        const nwk = keyMap.get(a.workerKey) ?? a.workerKey;
        const nck = keyMap.get(a.commanderKey) ?? a.commanderKey;
        const na: Assignment =
          nwk !== a.workerKey || nck !== a.commanderKey
            ? { ...a, workerKey: nwk, commanderKey: nck }
            : a;
        if (na !== a) {
          assignmentsChanged = true;
          if (nwk !== wk) res.rewrittenAssignments++;
        }
        const clash = next[nwk];
        if (clash) {
          assignmentsChanged = true;
          if (
            na.generation > clash.generation ||
            (na.generation === clash.generation && na.assignedAt < clash.assignedAt)
          ) {
            next[nwk] = na;
          }
        } else {
          next[nwk] = na;
        }
      }
      // Commander-only key rewrites (commanderKey changed, workerKey same)
      // are already in `next` above; nothing more to do here.
      if (assignmentsChanged) {
        const file: AssignmentsFile = {
          version: 1,
          generation: asg.state.generation,
          assignments: next,
        };
        await atomicWriteJson(assignmentsPath(), file);
      }
    }

    // Registry rows (in-memory; registerSelf persists after): only legacy
    // daemons on the anchored old list. Stable ids are never rewritten.
    for (const e of entries) {
      try {
        if (runtimeOf(e) !== "v1") continue;
        if (!oldList.includes(stripDaemonMarker(e.daemonId))) continue;
        if (isStableDaemonId(e.daemonId)) continue;
        e.daemonId = newMarked;
        if (typeof e.updatedAt === "number") e.updatedAt = Math.max(e.updatedAt, now);
        res.rewrittenRegistryRows++;
      } catch {
        // keep going
      }
    }
    dedupeRegistryEntries(entries);

    // Journals: rewrite key references in every commander's events file,
    // then move (merge) renamed commander journals + ACK cursors.
    const cmdPairs = new Map<string, string>();
    // Commander pairs: old commanderKeys that were rewritten.
    for (const a of Object.values(asg.state.assignments)) {
      const nck = keyMap.get(a.commanderKey);
      if (nck && nck !== a.commanderKey && !cmdPairs.has(a.commanderKey)) {
        cmdPairs.set(a.commanderKey, nck);
      }
    }
    try {
      const probe = assignmentJournalPaths("v1\u0000x\u0000y");
      const dir = dirname(probe.eventsPath);
      let files: string[] = [];
      try {
        files = await readdir(dir);
      } catch {
        files = [];
      }
      // 1. Rewrite key references inside all event files.
      for (const f of files) {
        if (!f.endsWith(".events.json")) continue;
        const p = join(dir, f);
        const r = await readJsonFile(p);
        if (!r.found || !Array.isArray(r.value)) continue; // never clobber corrupt
        let touched = false;
        const out = (r.value as unknown[]).map((ev) => {
          if (!isRecord(ev)) return ev;
          const nw = typeof ev["workerKey"] === "string" ? (keyMap.get(ev["workerKey"]) ?? ev["workerKey"]) : ev["workerKey"];
          const nc =
            typeof ev["commanderKey"] === "string"
              ? (keyMap.get(ev["commanderKey"] as string) ?? ev["commanderKey"])
              : ev["commanderKey"];
          if (nw !== ev["workerKey"] || nc !== ev["commanderKey"]) {
            touched = true;
            return { ...ev, workerKey: nw, commanderKey: nc };
          }
          return ev;
        });
        if (touched) await atomicWriteJson(p, out);
      }
      // 2. Move/merge renamed commander journals + cursors.
      for (const [o, n] of cmdPairs) {
        const op = assignmentJournalPaths(o);
        const np = assignmentJournalPaths(n);
        if (op.eventsPath !== np.eventsPath) {
          const ro = await readJsonFile(op.eventsPath);
          if (ro.found && Array.isArray(ro.value)) {
            const rn = await readJsonFile(np.eventsPath);
            const base = Array.isArray(rn.value) ? (rn.value as unknown[]) : [];
            const seen = new Set(base.map((e) => (isRecord(e) ? String(e["id"] ?? "") : "")));
            const merged = [...base];
            for (const e of ro.value as unknown[]) {
              const id = isRecord(e) ? String(e["id"] ?? "") : "";
              if (id === "" || seen.has(id)) continue;
              seen.add(id);
              merged.push(e);
            }
            merged.sort((a, b) => {
              const ia = isRecord(a) ? String(a["id"] ?? "") : "";
              const ib = isRecord(b) ? String(b["id"] ?? "") : "";
              return ia < ib ? -1 : ia > ib ? 1 : 0;
            });
            await atomicWriteJson(np.eventsPath, merged);
            await rm(op.eventsPath, { force: true }).catch(() => undefined);
            res.journalsMoved++;
          }
        }
        if (op.cursorPath !== np.cursorPath) {
          const rc = await readJsonFile(op.cursorPath);
          const rn = await readJsonFile(np.cursorPath);
          if (rc.found && isRecord(rc.value) && typeof rc.value["ackedId"] === "string" && !rn.found) {
            await atomicWriteJson(np.cursorPath, rc.value);
            await rm(op.cursorPath, { force: true }).catch(() => undefined);
          }
        }
      }
    } catch {
      // journal migration is best-effort inside a best-effort migration
    }

    // Handoff origins: rewrite workerKey/fromCommanderKey refs, move files
    // to their hash paths.
    try {
      const probe = originPathForWorker("v1\u0000x\u0000y");
      const dir = dirname(probe);
      let files: string[] = [];
      try {
        files = await readdir(dir);
      } catch {
        files = [];
      }
      for (const f of files) {
        if (!f.endsWith(".origin.json")) continue;
        const p = join(dir, f);
        const r = await readJsonFile(p);
        if (!r.found || !isRecord(r.value)) continue; // never clobber corrupt
        const o = r.value;
        const wk = typeof o["workerKey"] === "string" ? o["workerKey"] : "";
        const ck = typeof o["fromCommanderKey"] === "string" ? o["fromCommanderKey"] : "";
        if (wk === "" || ck === "") continue;
        const nwk = keyMap.get(wk) ?? wk;
        const nck = keyMap.get(ck) ?? ck;
        if (nwk === wk && nck === ck) continue;
        const updated = { ...o, workerKey: nwk, fromCommanderKey: nck };
        const np = originPathForWorker(nwk);
        await atomicWriteJson(np, updated);
        if (np !== p) {
          await rm(p, { force: true }).catch(() => undefined);
          res.originsMoved++;
        }
      }
    } catch {
      // origin migration is best-effort
    }

    res.ran = true;
    res.reason = `migrated ${oldList.join(", ")} -> ${newBare} (session ${sessionId})`;
    return done(res);
  } catch (err) {
    const res = emptyResult();
    res.reason = `migration failed (${err instanceof Error ? err.message : String(err)}); will retry on next heartbeat`;
    return done(res);
  }
}

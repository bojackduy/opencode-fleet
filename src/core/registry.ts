/**
 * registry.ts — fleet session registry.
 *
 * State path (v1-only namespace):
 *   $XDG_STATE_HOME/opencode/fleet/registry.json
 *   fallback ~/.local/state/opencode/fleet/registry.json
 *
 * Concurrency: in-process read-modify-write is serialized with a promise
 * chain; CROSS-PROCESS RMW (v1 daemon + v2 service share this file, and
 * part 2 fleets routinely have both) is serialized with an atomic
 * mkdir-based lock dir (with stale-lock reaping). Without it, concurrent
 * writers last-writer-win and silently drop each other's rows.
 * Writes are atomic via temp file + rename, files are 0600.
 * Never throws on missing/corrupt registry — returns [] instead.
 */

import { chmod, cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { withV1Marker } from "./v1.js";
import { migrateDaemonKeysUnlocked } from "./daemonMigration.js";
import type { Role } from "./roles.js";

/** Fleet runtime that owns a registry row. Missing reads as "v1". */
export type FleetRuntime = "v1" | "v2";

/** Endpoint descriptor for a registry row. */
export interface RegistryEndpoint {
  kind: "v1-daemon" | "v2-service" | "v2-standalone";
  /** v1: daemon serverUrl; v2: service url when known, else "". */
  url: string;
}

export interface RegistryEntry {
  sessionId: string;
  daemonId: string;
  directory: string;
  /** Human-readable label set at registration time. */
  title?: string;
  /** Alias for title; kept so both `fleet_register(summary)` and title callers work. */
  summary?: string;
  /** Epoch millis of last register/heartbeat. Entries older than TTL are hidden. */
  updatedAt: number;
  /** Heartbeat enrichment (P4): agent/model/status/lastDone from v1 API. */
  agent?: string;
  model?: string;
  status?: string;
  lastDone?: string;
  /** P5 role. Entries without a role read as "peer" (see roleOf in roles.ts). */
  role?: Role;
  /** P5 parent session id (fork chain). Empty/absent = top-level session. */
  parentID?: string;
  /**
   * V2 compat (part 2): which runtime owns this row. Absent reads as "v1"
   * for backward compatibility with pre-v2 rows. Fleet keys on
   * (runtime, daemonId, sessionId) because ses_ ids can collide across
   * runtimes (they share the id format but no live state).
   */
  runtime?: FleetRuntime;
  /** Endpoint descriptor (routing metadata only, never ownership): v1 rows stamp {kind:'v1-daemon', url:serverUrl}. */
  endpoint?: RegistryEndpoint;
  /** V2 location directory (per-location plugin instance). */
  location?: string;
}

/** Entries with updatedAt older than this are hidden by listRegistry. */
export const REGISTRY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Runtime that owns a row. Missing `runtime` reads as "v1"; a `v2:` daemonId
 * prefix also reads as "v2". Never throws.
 */
export function runtimeOf(
  e: Pick<RegistryEntry, "runtime" | "daemonId"> | null | undefined,
): FleetRuntime {
  try {
    if (e?.runtime === "v2") return "v2";
    if (e?.runtime === "v1") return "v1";
    const d = String((e as { daemonId?: unknown } | null)?.daemonId ?? "");
    if (d.startsWith("v2:")) return "v2";
    return "v1";
  } catch {
    return "v1";
  }
}

/** Composite fleet key: (runtime, daemonId, sessionId). Never throws. */
export function fleetKeyOf(e: Pick<RegistryEntry, "runtime" | "daemonId" | "sessionId">): string {
  try {
    return `${runtimeOf(e)}\u0000${String(e?.daemonId ?? "")}\u0000${String(e?.sessionId ?? "")}`;
  } catch {
    return `v1\u0000\u0000`;
  }
}

export function stateDir(): string {
  const xdg = process.env.XDG_STATE_HOME;
  if (xdg && xdg.trim() !== "") return join(xdg, "opencode", "fleet");
  return join(homedir(), ".local", "state", "opencode", "fleet");
}

const LEGACY_SEGMENT = "fleet-v1"; // legacy fleet-v1/messages compat fallback

/** Pre-rename (0.1.x) state dir. Used read-only by the one-time migration below. */
export function legacyStateDir(): string {
  const xdg = process.env.XDG_STATE_HOME;
  if (xdg && xdg.trim() !== "") return join(xdg, "opencode", LEGACY_SEGMENT);
  return join(homedir(), ".local", "state", "opencode", LEGACY_SEGMENT);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * One-time migration from the pre-rename state dir to the new one.
 * Copies missing files over (whole tree when the new dir is absent,
 * per-file for registry.json / auth.json / messages otherwise) so live
 * fleets survive the upgrade. Best-effort — never throws. Cached: the
 * copy is attempted at most once per process.
 */
async function migrateLegacyStateOnce(): Promise<void> {
  try {
    const next = stateDir();
    const prev = legacyStateDir();
    if (next === prev) return;
    if (!(await pathExists(prev))) return;
    if (!(await pathExists(next))) {
      await mkdir(dirname(next), { recursive: true });
      await cp(prev, next, { recursive: true });
      await chmod(join(next, "registry.json"), 0o600).catch(() => undefined);
      await chmod(join(next, "auth.json"), 0o600).catch(() => undefined);
      return;
    }
    for (const name of ["registry.json", "auth.json", "messages"]) {
      try {
        const dst = join(next, name);
        const src = join(prev, name);
        if ((await pathExists(dst)) || !(await pathExists(src))) continue;
        await cp(src, dst, { recursive: true });
      } catch {
        // per-file best-effort; keep migrating the rest.
      }
    }
  } catch {
    // best-effort only — migration must never break reads.
  }
}

let migrated: Promise<void> | null = null;

/** Ensure the one-time legacy migration ran (cached). Never throws. */
export function ensureStateMigrated(): Promise<void> {
  try {
    if (!migrated) migrated = migrateLegacyStateOnce();
    return migrated;
  } catch {
    return Promise.resolve();
  }
}

export function registryPath(): string {
  return join(stateDir(), "registry.json");
}

/** In-process mutex: every RMW queues behind the previous one. */
let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  // Keep the chain alive even if this step rejects.
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Cross-process mutex for state-file RMW (shared by registry.ts and
 * auth.ts, which live in the same state dir). mkdir is atomic: exactly one
 * process wins. Stale locks (crashed holder) are reaped after STALE_MS;
 * acquisition gives up after WAIT_MS and runs unlocked rather than hanging
 * a plugin tool forever. Never throws.
 */
const LOCK_STALE_MS = 15_000;
const LOCK_WAIT_MS = 60_000;

/**
 * Cross-process lock hold depth for THIS process. Diagnostic only: a
 * concurrent operation may hold the lock while this call runs unlocked.
 */
let stateLockHeldDepth = 0;

export function isStateLockHeld(): boolean {
  try {
    return stateLockHeldDepth > 0;
  } catch {
    return false;
  }
}

export async function withStateLock<T>(fn: () => Promise<T>): Promise<T> {
  const acquired = await acquireStateLock();
  if (!acquired) {
    // Degrade: run unlocked rather than hang a plugin tool forever.
    return await fn();
  }
  try {
    return await withStateLockHeld(fn);
  } finally {
    await releaseStateLock();
  }
}

/**
 * Strict cross-process lock for explicit operator recovery
 * (fleet_recover_commander): NEVER runs fn unlocked. On acquisition timeout
 * the callback is NOT executed and a fail-closed Error is thrown instead,
 * so no mutation can happen on the degraded fallback path.
 *
 * The acquisition result is explicit per-call (mkdir success for THIS call),
 * never the process-global {@link isStateLockHeld} depth — that depth may
 * be nonzero due to an unrelated concurrent task holding the lock while
 * this call is still waiting, which would falsely look "held". Never throws
 * except the fail-closed lock-unavailable Error.
 */
export async function withStateLockStrict<T>(fn: () => Promise<T>): Promise<T> {
  const acquired = await acquireStateLock();
  if (!acquired) {
    throw new Error("state lock unavailable; refusing (fail-closed, retry later)");
  }
  try {
    return await withStateLockHeld(fn);
  } finally {
    await releaseStateLock();
  }
}

async function acquireStateLock(): Promise<boolean> {
  const dir = `${registryPath()}.lock`;
  try {
    await mkdir(dirname(dir), { recursive: true });
  } catch {
    // Parent creation is best-effort; acquire loop handles the rest.
  }
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await mkdir(dir);
      return true;
    } catch {
      try {
        const st = await stat(dir);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await rm(dir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // raced creation/removal; retry immediately.
      }
      if (Date.now() > deadline) return false;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

async function releaseStateLock(): Promise<void> {
  try {
    await rm(`${registryPath()}.lock`, { recursive: true, force: true });
  } catch {
    // best-effort release
  }
}

async function withStateLockHeld<T>(fn: () => Promise<T>): Promise<T> {
  stateLockHeldDepth++;
  try {
    return await fn();
  } finally {
    stateLockHeldDepth--;
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

/**
 * Read the registry. Never throws: missing file or corrupt JSON
 * yields an empty list (and non-array payloads are coerced to []).
 */
export async function readRegistry(): Promise<RegistryEntry[]> {
  try {
    await ensureStateMigrated();
    const raw = await readFile(registryPath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is RegistryEntry =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as RegistryEntry).sessionId === "string" &&
        typeof (e as RegistryEntry).daemonId === "string",
    );
  } catch {
    return [];
  }
}

async function writeRegistryAtomic(entries: RegistryEntry[]): Promise<void> {
  await atomicWriteJson(registryPath(), entries);
}

export type RegisterSelfInput = Omit<RegistryEntry, "updatedAt"> &
  Partial<Pick<RegistryEntry, "updatedAt">>;

/**
 * Insert or refresh this session's entry (matched by the composite fleet key
 * (runtime, daemonId, sessionId), with a legacy sessionId-only fallback when
 * runtimes agree — so pre-v2 v1 rows keep updating in place). v2 daemonIds
 * (runtime "v2" or `v2:` prefix) skip the `:v1` marker. Serialized with the
 * in-process chain. Returns the stored entry.
 *
 * v1 registrations also trigger the daemon-identity migration
 * (daemonMigration.ts): legacy hostname-daemon keys for this session (same
 * sessionId + same numeric pid/port) are rewritten to the stable identity
 * across the registry, assignments, journals, and handoff origins. The
 * registration uses the strict lock so migration cannot run through an
 * unlocked fallback; lock acquisition failures are retried by the next beat.
 */
export async function registerSelf(input: RegisterSelfInput): Promise<RegistryEntry> {
  return enqueue(() =>
    withStateLockStrict(async () => {
      const entries = await readRegistry();
    const rt: FleetRuntime = input.runtime ?? runtimeOf({ runtime: undefined, daemonId: input.daemonId });
    const entry: RegistryEntry = {
      ...input,
      runtime: rt,
      daemonId: rt === "v2" ? String(input.daemonId ?? "") : withV1Marker(input.daemonId),
      updatedAt: input.updatedAt ?? Date.now(),
    };
    try {
      if (rt === "v1") {
        await migrateDaemonKeysUnlocked({
          entries,
          sessionId: entry.sessionId,
          newDaemonId: entry.daemonId,
          now: Date.now(),
        });
      }
    } catch {
      // best-effort: registration must succeed; migration retries next beat.
    }
    const key = fleetKeyOf(entry);
    let idx = entries.findIndex((e) => fleetKeyOf(e) === key);
    if (idx < 0) {
      // Legacy fallback: same sessionId with an agreeing runtime (covers
      // pre-v2 rows that lack the field but match this runtime).
      idx = entries.findIndex((e) => e.sessionId === entry.sessionId && runtimeOf(e) === rt);
    }
    if (idx >= 0) entries[idx] = { ...entries[idx], ...entry };
    else entries.push(entry);
    await writeRegistryAtomic(entries);
    return entry;
    }),
  );
}

export interface ListRegistryOptions {
  /** Include the caller's own session. Default false. */
  includeSelf?: boolean;
  /** Session id of the caller; excluded unless includeSelf is true. */
  selfId?: string;
  /** Override "now" (epoch millis) for TTL tests. Default Date.now(). */
  now?: number;
}

/**
 * List registry entries, hiding entries with updatedAt older than 24h.
 * Never throws — read failures yield [].
 */
export async function listRegistry(opts: ListRegistryOptions = {}): Promise<RegistryEntry[]> {
  const { includeSelf = false, selfId, now = Date.now() } = opts;
  const entries = await readRegistry();
  return entries.filter((e) => {
    if (typeof e.updatedAt !== "number" || now - e.updatedAt > REGISTRY_TTL_MS) return false;
    if (!includeSelf && selfId !== undefined && e.sessionId === selfId) return false;
    return true;
  });
}

/** Remove one session from the registry (e.g. on session.deleted). No-op if absent. */
export async function removeSession(sessionId: string): Promise<void> {
  await enqueue(() =>
    withStateLock(async () => {
      const entries = await readRegistry();
      const next = entries.filter((e) => e.sessionId !== sessionId);
      if (next.length === entries.length) return;
      await writeRegistryAtomic(next);
    }),
  );
}

/** Scoped removal: only rows matching (sessionId + runtime/daemonId when given). */
export async function removeSessionScoped(
  sessionId: string,
  scope?: { runtime?: FleetRuntime; daemonId?: string },
): Promise<void> {
  await enqueue(() =>
    withStateLock(async () => {
      const entries = await readRegistry();
      const next = entries.filter((e) => {
        if (e.sessionId !== sessionId) return true;
        if (scope?.runtime !== undefined && runtimeOf(e) !== scope.runtime) return true;
        if (scope?.daemonId !== undefined && e.daemonId !== scope.daemonId) return true;
        return false;
      });
      if (next.length === entries.length) return;
      await writeRegistryAtomic(next);
    }),
  );
}

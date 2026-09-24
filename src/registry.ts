/**
 * registry.ts — fleet-v1 session registry.
 *
 * State path (v1-only namespace):
 *   $XDG_STATE_HOME/opencode/fleet-v1/registry.json
 *   fallback ~/.local/state/opencode/fleet-v1/registry.json
 *
 * Concurrency: in-process read-modify-write is serialized with a promise
 * chain; cross-process is last-writer-wins (acceptable for MVP).
 * Writes are atomic via temp file + rename, files are 0600.
 * Never throws on missing/corrupt registry — returns [] instead.
 */

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { withV1Marker } from "./v1.js";

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
}

/** Entries with updatedAt older than this are hidden by listRegistry. */
export const REGISTRY_TTL_MS = 24 * 60 * 60 * 1000;

export function stateDir(): string {
  const xdg = process.env.XDG_STATE_HOME;
  if (xdg && xdg.trim() !== "") return join(xdg, "opencode", "fleet-v1");
  return join(homedir(), ".local", "state", "opencode", "fleet-v1");
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
 * Insert or refresh this session's entry (matched by sessionId).
 * Serialized with the in-process chain. Returns the stored entry.
 */
export async function registerSelf(input: RegisterSelfInput): Promise<RegistryEntry> {
  return enqueue(async () => {
    const entries = await readRegistry();
    const entry: RegistryEntry = {
      ...input,
      daemonId: withV1Marker(input.daemonId),
      updatedAt: input.updatedAt ?? Date.now(),
    };
    const idx = entries.findIndex((e) => e.sessionId === entry.sessionId);
    if (idx >= 0) entries[idx] = { ...entries[idx], ...entry };
    else entries.push(entry);
    await writeRegistryAtomic(entries);
    return entry;
  });
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
  await enqueue(async () => {
    const entries = await readRegistry();
    const next = entries.filter((e) => e.sessionId !== sessionId);
    if (next.length === entries.length) return;
    await writeRegistryAtomic(next);
  });
}

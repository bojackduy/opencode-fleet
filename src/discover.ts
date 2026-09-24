/**
 * discover.ts — v1-only read-only discovery for fleet-v1 (P4 API-first).
 *
 * PRIMARY path (hot): heartbeat registry written by beat() via the v1 API
 * (`client.session.get/status/messages`), plus live `discoverViaClient()`
 * over `client.session.list`. No sqlite, no ps/lsof on the hot path.
 *
 * DEPRECATED fallback: the shared v1 sqlite DB
 *   ~/.local/share/opencode/opencode.db (or $XDG_DATA_HOME/opencode/opencode.db)
 * table `session`, plus `ps`/`lsof` hints. Kept for compat only; every use
 * logs a deprecation via client.app.log. Never writes.
 *
 * All exports never throw — DB/FS/API failures yield [].
 */

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { listRegistry } from "./registry.js";

export interface DiscoveredSession {
  id: string;
  title: string;
  directory: string;
  timeUpdated: number;
  agent: string;
  model: string;
  registered: boolean;
}

export interface FleetPsRow {
  sessionId: string;
  title: string;
  directory: string;
  pidHint: string;
  portHint: string;
  registered: boolean;
  age: string;
}

interface DbSessionRow {
  id?: unknown;
  project_id?: unknown;
  directory?: unknown;
  title?: unknown;
  time_created?: unknown;
  time_updated?: unknown;
  agent?: unknown;
  model?: unknown;
}

export function dataDbPath(): string {
  try {
    const xdg = process.env["XDG_DATA_HOME"];
    if (xdg && xdg.trim() !== "") return join(xdg, "opencode", "opencode.db");
    return join(homedir(), ".local", "share", "opencode", "opencode.db");
  } catch {
    return join(homedir(), ".local", "share", "opencode", "opencode.db");
  }
}

/** Best-effort deprecation notice for the legacy sqlite/ps path. Never throws. */
export async function logDeprecated(client: unknown, message: string): Promise<void> {
  try {
    const c = client as {
      app?: { log?: (args: unknown) => Promise<unknown> };
    } | null;
    await c?.app?.log?.({
      body: { service: "fleet-v1", level: "warn", message: `fleet-v1 deprecated discover path: ${message}` },
    });
  } catch {
    // best-effort only
  }
}

/** Unwrap SDK RequestResult ({data,error}) or a raw payload. */
function unwrap<T>(raw: unknown): T {
  try {
    if (raw !== null && typeof raw === "object" && "data" in (raw as Record<string, unknown>)) {
      return (raw as { data: T }).data as T;
    }
  } catch {
    // fall through
  }
  return raw as T;
}

function toNumber(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toText(v: unknown): string {
  return typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
}

function clampLimit(raw: unknown, fallback: number, max: number): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : fallback;
  return Math.max(1, Math.min(max, n || fallback));
}

/**
 * PRIMARY: sessions from the heartbeat registry (written by beat()).
 * Same shape as discoverSessions; every row is registered:true.
 * Never throws.
 */
export async function discoverViaRegistry(limit = 100): Promise<DiscoveredSession[]> {
  try {
    const n = clampLimit(limit, 100, 500);
    const entries = await listRegistry({ includeSelf: true }).catch(() => []);
    const out: DiscoveredSession[] = (entries ?? []).map((e) => ({
      id: e.sessionId,
      title: e.title ?? e.summary ?? "",
      directory: e.directory ?? "",
      timeUpdated: typeof e.updatedAt === "number" ? e.updatedAt : 0,
      agent: e.agent ?? "",
      model: e.model ?? "",
      registered: true,
    }));
    out.sort((a, b) => b.timeUpdated - a.timeUpdated);
    return out.slice(0, n);
  } catch {
    return [];
  }
}

/**
 * PRIMARY: live sessions via the v1 API (`client.session.list`),
 * joined with the heartbeat registry for the registered flag + agent/model.
 * Never throws — SDK absence/failure yields [].
 */
export async function discoverViaClient(client: unknown, limit = 100): Promise<DiscoveredSession[]> {
  try {
    const n = clampLimit(limit, 100, 500);
    const c = client as { session?: { list?: (args?: unknown) => Promise<unknown> } } | null;
    if (!c?.session || typeof c.session.list !== "function") {
      // SDK lacks session.list — caller falls back to registry heartbeats.
      return [];
    }
    const raw = await c.session.list({ query: { limit: n } }).catch(() => c.session!.list!());
    const data = unwrap<unknown>(raw);
    const list = Array.isArray(data) ? data : [];
    const registry = await listRegistry({ includeSelf: true }).catch(() => []);
    const regById = new Map(registry.map((e) => [e.sessionId, e]));
    const out: DiscoveredSession[] = [];
    for (const s of list) {
      const rec = s as Record<string, unknown>;
      const id = toText(rec["id"]);
      if (id === "") continue;
      const time = rec["time"] as { updated?: unknown } | undefined;
      const reg = regById.get(id);
      out.push({
        id,
        title: toText(rec["title"]) || reg?.title || reg?.summary || "",
        directory: toText(rec["directory"]) || reg?.directory || "",
        timeUpdated: toNumber(time?.updated) || reg?.updatedAt || 0,
        agent: reg?.agent || "",
        model: reg?.model || "",
        registered: reg !== undefined,
      });
    }
    out.sort((a, b) => b.timeUpdated - a.timeUpdated);
    return out.slice(0, n);
  } catch {
    return [];
  }
}

/**
 * Preferred discovery: live API first, heartbeat registry second, legacy
 * sqlite only on a total miss (with deprecation log). Never throws.
 */
export async function discoverSessionsPreferApi(
  client?: unknown,
  limit = 100,
): Promise<DiscoveredSession[]> {
  try {
    const n = clampLimit(limit, 100, 500);
    if (client) {
      const live = await discoverViaClient(client, n).catch(() => [] as DiscoveredSession[]);
      if (live.length > 0) return live;
    }
    const reg = await discoverViaRegistry(n).catch(() => [] as DiscoveredSession[]);
    if (reg.length > 0) return reg;
    await logDeprecated(client, "sqlite fallback: no heartbeat registry entries; using deprecated sqlite path");
    return await discoverSessionsLegacy(n);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// DEPRECATED fallback (sqlite/ps/lsof). Kept for compat; not the hot path.
// ---------------------------------------------------------------------------

function execFileAsync(
  file: string,
  args: string[],
  timeoutMs = 5000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout ?? ""));
    });
  });
}

/** @deprecated Use discoverViaClient/discoverViaRegistry instead. Read-only sqlite query. Never throws. */
async function queryDbSessions(limit = 100): Promise<DbSessionRow[]> {
  try {
    const db = dataDbPath();
    const n = Math.max(1, Math.min(500, Math.floor(limit) || 100));
    const sql = `SELECT id, project_id, directory, title, time_created, time_updated, agent, model FROM session ORDER BY time_updated DESC LIMIT ${n};`;
    const out = await execFileAsync("sqlite3", ["-json", "-readonly", db, sql]);
    const trimmed = out.trim();
    if (trimmed === "") return [];
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return [];
    return parsed as DbSessionRow[];
  } catch {
    return [];
  }
}

/**
 * @deprecated Use discoverSessionsPreferApi instead. Direct sqlite+registry
 * join kept for compat. Never throws.
 */
export async function discoverSessionsLegacy(limit = 100): Promise<DiscoveredSession[]> {
  try {
    const [rows, registry] = await Promise.all([
      queryDbSessions(limit),
      listRegistry({ includeSelf: true }).catch(() => []),
    ]);
    const registered = new Set((registry ?? []).map((e) => e.sessionId));
    const out: DiscoveredSession[] = rows
      .filter((r) => toText(r.id) !== "")
      .map((r) => ({
        id: toText(r.id),
        title: toText(r.title),
        directory: toText(r.directory),
        timeUpdated: toNumber(r.time_updated),
        agent: toText(r.agent),
        model: toText(r.model),
        registered: registered.has(toText(r.id)),
      }));
    out.sort((a, b) => b.timeUpdated - a.timeUpdated);
    return out;
  } catch {
    return [];
  }
}

/**
 * Discover sessions — API-first (hot path has no sqlite): live client list,
 * then heartbeat registry, then deprecated sqlite only on a miss.
 * Keeps the legacy (limit) signature; pass client as 2nd arg when available.
 * Never throws.
 */
export async function discoverSessions(limit = 100, client?: unknown): Promise<DiscoveredSession[]> {
  try {
    if (client) return await discoverSessionsPreferApi(client, limit);
    const reg = await discoverViaRegistry(limit).catch(() => [] as DiscoveredSession[]);
    if (reg.length > 0) return reg;
    return await discoverSessionsLegacy(limit);
  } catch {
    return [];
  }
}

interface PsHint {
  pid: string;
  port: string;
}

/** @deprecated Best-effort `ps aux | grep opencode` hints. */
async function psHints(): Promise<PsHint[]> {
  try {
    const out = await execFileAsync("ps", ["aux"]);
    const hints: PsHint[] = [];
    for (const line of out.split("\n")) {
      if (!/opencode/i.test(line)) continue;
      if (/grep/i.test(line)) continue;
      // Skip v2 .bun processes — v1 only.
      if (line.includes(".bun")) continue;
      const cols = line.trim().split(/\s+/);
      const pid = cols[1] ?? "";
      let port = "";
      const portMatch = /(?:--port[=\s]+|:)(4\d{3}|14\d{3}|5\d{4})(\s|$)/.exec(line);
      if (portMatch) port = portMatch[1] ?? "";
      if (port === "49374") continue; // v2 service port
      hints.push({ pid, port });
    }
    return hints;
  } catch {
    return [];
  }
}

/**
 * @deprecated Best-effort listening-port map via `lsof`. Never throws.
 */
async function lsofPorts(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const out = await execFileAsync("lsof", ["-iTCP", "-sTCP:LISTEN", "-P", "-n"]);
    for (const line of out.split("\n")) {
      if (!/opencode/i.test(line)) continue;
      if (line.includes(".bun")) continue;
      // e.g. "opencode 12345 user ... TCP *:14121 (LISTEN)" or "127.0.0.1:14121"
      const pidMatch = /^\S+\s+(\d+)/.exec(line.trim());
      const portMatch = /:(\d{4,5})\s+\(LISTEN\)/.exec(line);
      if (pidMatch && portMatch) {
        const pid = pidMatch[1] ?? "";
        const port = portMatch[1] ?? "";
        if (port === "49374") continue;
        if (pid !== "" && port !== "") map.set(pid, port);
      }
    }
  } catch {
    // lsof missing/denied — return whatever we have (possibly empty).
  }
  return map;
}

function ageOf(timeUpdated: number, now = Date.now()): string {
  try {
    if (!timeUpdated || timeUpdated <= 0) return "-";
    const ms = Math.max(0, now - timeUpdated);
    const h = ms / 3_600_000;
    if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))}m`;
    if (h < 48) return `${h.toFixed(1)}h`;
    return `${(h / 24).toFixed(1)}d`;
  } catch {
    return "-";
  }
}

/**
 * Merge heartbeat registry (primary) into display rows; ps/lsof hints are
 * best-effort deprecated extras (empty string when unknown).
 * Pass client to prefer the live API. Never throws.
 */
export async function fleetPs(limit = 50, client?: unknown): Promise<FleetPsRow[]> {
  try {
    const n = Math.max(1, Math.min(500, Math.floor(limit) || 50));
    const sessions =
      client || (await discoverViaRegistry(1).catch(() => [] as DiscoveredSession[])).length > 0
        ? await discoverSessionsPreferApi(client, n).catch(() => [] as DiscoveredSession[])
        : await discoverSessionsPreferApi(undefined, n).catch(() => [] as DiscoveredSession[]);
    if (sessions.length === 0) {
      await logDeprecated(client, "fleet_ps sqlite fallback: registry empty");
      const legacy = await discoverSessionsLegacy(n).catch(() => [] as DiscoveredSession[]);
      if (legacy.length === 0) return [];
      return toPsRows(legacy.slice(0, n), "", "", new Map());
    }
    // Deprecated extras only: pid/port hints.
    let hints: PsHint[] = [];
    let ports = new Map<string, string>();
    try {
      hints = await psHints().catch(() => [] as PsHint[]);
      ports = await lsofPorts().catch(() => new Map<string, string>());
    } catch {
      // hints stay empty
    }
    const fallbackPid = hints.length > 0 ? (hints[0]?.pid ?? "") : "";
    const fallbackPort = hints.map((h) => h.port).find((p) => p !== "") ?? "";
    return toPsRows(sessions.slice(0, n), fallbackPid, fallbackPort, ports);
  } catch {
    return [];
  }
}

function toPsRows(
  sessions: DiscoveredSession[],
  fallbackPid: string,
  fallbackPort: string,
  ports: Map<string, string>,
): FleetPsRow[] {
  const now = Date.now();
  return sessions.map((s) => {
    const pidHint = fallbackPid;
    let portHint = fallbackPort;
    if (pidHint !== "" && ports.has(pidHint)) portHint = ports.get(pidHint) ?? portHint;
    return {
      sessionId: s.id,
      title: s.title,
      directory: s.directory,
      pidHint,
      portHint,
      registered: s.registered,
      age: ageOf(s.timeUpdated, now),
    };
  });
}

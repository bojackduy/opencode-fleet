/**
 * daemonIdentity.ts — stable v1 daemon identity + legacy pid/port parsing.
 *
 * Problem: the historic v1 daemon id `<hostname>-<pid>-<port>` drifts when
 * the machine hostname changes mid-process (e.g. `Mac.lan` -> a
 * `Spartans-...local` mDNS name). Every caller recomputes the id
 * (heartbeat.beat, callerIdentity, v1 adapter server()), so one hostname
 * flip silently forks the commander's composite identity and orphans all
 * assignment rows keyed by the old daemon.
 *
 * Fix (part 1): the live daemon id no longer contains the hostname. It is
 * `proc-<pid>-<port>-<token12>` where the token is a per-process random
 * value cached on `globalThis[Symbol.for(...)]`, so it is:
 *   - stable within the process for all calls AND across plugin module
 *     re-imports (same globalThis slot),
 *   - unique across restarts: two processes that reuse the same PID/port
 *     get different tokens and are never confused,
 *   - independent of hostname changes.
 * v2 is untouched; `withV1Marker` still applies on top (`:v1` suffix).
 *
 * Fix (part 2, see daemonMigration.ts): legacy `host-pid-port` rows are
 * recovered by matching sessionId + parsed numeric pid/port (never
 * hostname), rewriting only legacy-format keys to the stable id. Stable
 * ids with a different token are NEVER rewritten (fail closed on PID
 * reuse), and anything unparseable never migrates.
 *
 * Never throws (fail-closed nulls); no I/O, no subprocesses.
 */

import { createHash, randomUUID } from "node:crypto";

/** Global slot so re-imports of this module share one process token. */
const GLOBAL_KEY = Symbol.for("opencode-fleet.v1DaemonIdentity.v1");

interface ProcIdentity {
  token: string;
  pid: number;
  startedAt: number;
}

function procIdentity(): ProcIdentity {
  try {
    const g = globalThis as unknown as Record<symbol, ProcIdentity | undefined>;
    const cur = g[GLOBAL_KEY];
    if (cur && typeof cur.token === "string" && cur.token !== "" && cur.pid === process.pid) {
      return cur;
    }
    const fresh: ProcIdentity = {
      token: randomUUID().replace(/-/g, "").slice(0, 12),
      pid: process.pid,
      startedAt: Date.now() - process.uptime() * 1000,
    };
    g[GLOBAL_KEY] = fresh;
    return fresh;
  } catch {
    return { token: "unknown", pid: process.pid, startedAt: Date.now() - process.uptime() * 1000 };
  }
}

/** Approximate wall-clock start of this process; guards legacy PID reuse. */
export function processStartedAt(): number {
  return procIdentity().startedAt;
}

/** Process token (test hook: proves stability / distinguishes restarts). */
export function stableProcessToken(): string {
  try {
    return procIdentity().token;
  } catch {
    return "unknown";
  }
}

/**
 * Parse the trailing port out of a server URL. Same tolerant rules as the
 * historic getDaemonId: URL port first, then a trailing `:port` match.
 * Returns "" when no port can be parsed (caller falls back to a hash).
 */
export function parseServerPort(serverUrl: string): string {
  try {
    const raw = String(serverUrl ?? "");
    try {
      const port = new URL(raw).port;
      if (port && port.trim() !== "") return port.trim();
    } catch {
      // Fall through to the regex fallback below.
    }
    const m = /:(\d+)(?:\/|$)/.exec(raw);
    if (m) return m[1] as string;
    return "";
  } catch {
    return "";
  }
}

/**
 * Stable v1 daemon id for this process (UNMARKED — callers add `:v1` via
 * withV1Marker exactly like before). Hostname-free, so mid-process
 * hostname flips cannot fork the identity.
 */
export function getStableDaemonId(serverUrl: string): string {
  try {
    const { token, pid } = procIdentity();
    const port = parseServerPort(serverUrl);
    if (port !== "") return `proc-${pid}-${port}-${token}`;
    const h = createHash("sha256").update(String(serverUrl ?? ""), "utf8").digest("hex").slice(0, 8);
    return `proc-${pid}-x${h}-${token}`;
  } catch {
    return `proc-${process.pid}-unknown`;
  }
}

/**
 * Historic hostname-based daemon id (`<hostname>-<pid>-<port>`). Kept ONLY
 * so tests can seed pre-migration legacy rows; live code must use
 * {@link getStableDaemonId} (via inbox getDaemonId). Never throws.
 */
export function getLegacyHostnameDaemonId(serverUrl: string, host: string): string {
  try {
    const h = String(host ?? "unknown-host");
    const pid = process.pid;
    const port = parseServerPort(serverUrl);
    if (port !== "") return `${h}-${pid}-${port}`;
    const m = /:(\d+)(?:\/|$)/.exec(String(serverUrl ?? ""));
    if (m) return `${h}-${pid}-${m[1]}`;
    return `${h}-${pid}-${String(serverUrl ?? "")}`;
  } catch {
    return `unknown-host-${process.pid}-${String(serverUrl ?? "")}`;
  }
}

/** Strip a trailing `:v1` / `#v1` marker. Never throws. */
export function stripDaemonMarker(daemonId: unknown): string {
  try {
    return String(daemonId ?? "").replace(/:v1$|#v1$/, "");
  } catch {
    return String(daemonId ?? "");
  }
}

/** True for process-stable `proc-<pid>-<port>-<token>` ids. Never throws. */
export function isStableDaemonId(daemonId: unknown): boolean {
  try {
    return /^proc-\d+-(?:\d+|x[0-9a-f]{8})-[0-9a-f]{6,}$/.test(stripDaemonMarker(daemonId));
  } catch {
    return false;
  }
}

/** Parsed numeric pid + port from a daemon id, or null when unparseable. */
export interface DaemonPidPort {
  pid: number;
  /** Numeric port string. Non-numeric/fallback forms never parse (fail closed). */
  port: string;
}

export function parsePidPort(daemonId: unknown): DaemonPidPort | null {
  try {
    const bare = stripDaemonMarker(daemonId);
    if (bare === "") return null;
    let m = /^proc-(\d+)-(\d+)-[0-9a-f]{6,}$/.exec(bare);
    if (m) return { pid: Number(m[1]), port: m[2] as string };
    // Legacy `<host>-<pid>-<port>`: host may itself contain dashes, so anchor
    // on the last two dash-separated numeric segments.
    m = /^(.*)-(\d+)-(\d+)$/.exec(bare);
    if (m && (m[1] as string) !== "") return { pid: Number(m[2]), port: m[3] as string };
    return null;
  } catch {
    return null;
  }
}

/**
 * Same-process hint: both ids parse to the same numeric pid AND numeric
 * port (hostname ignored). This alone NEVER authorizes a merge — migration
 * additionally requires the same sessionId and a legacy->stable direction
 * (see daemonMigration.ts). Never throws.
 */
export function sameProcessHint(a: unknown, b: unknown): boolean {
  try {
    const pa = parsePidPort(a);
    const pb = parsePidPort(b);
    if (!pa || !pb) return false;
    if (!Number.isSafeInteger(pa.pid) || !Number.isSafeInteger(pb.pid)) return false;
    return pa.pid === pb.pid && pa.port === pb.port;
  } catch {
    return false;
  }
}

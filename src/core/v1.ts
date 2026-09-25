/**
 * v1.ts — v1-only enforcement for fleet.
 *
 * Pinned binary + version, plus helpers to detect (and skip) v2 daemons:
 *  - v2 `.bun serve --service` on port 49374
 *  - bare `opencode` resolving to the v2 `.bun` binary
 *  - any serverUrl / exec path containing a `.bun` segment
 *
 * Never throws. Keep ESM `.js` import suffixes at call sites.
 */

/** Absolute path to the pinned v1 binary (alias `opencode1`). */
export const V1_BIN = "/opt/homebrew/bin/opencode";

/** Pinned v1 version string. */
export const V1_VERSION = "1.18.32";

/** Port used by the v2 `.bun serve --service` daemon — always skipped. */
export const V2_SERVICE_PORT = "49374";

/**
 * True when the given server URL looks like a v1 daemon.
 * Skips `.bun` paths and the v2 service port 49374, plus a `.bun`
 * `process.execPath` (bare `opencode` resolving to v2).
 */
export function isV1Daemon(serverUrl?: unknown): boolean {
  try {
    const s = String(serverUrl ?? "");
    if (s.includes(".bun")) return false;
    if (s.includes(V2_SERVICE_PORT)) return false;
    const execPath = process.execPath ?? "";
    if (execPath.includes(".bun")) return false;
    return true;
  } catch {
    return true;
  }
}

/**
 * True for supported daemon versions. Empty/unknown versions are allowed
 * (best-effort) so the plugin still loads; explicit `2.x` versions fail.
 */
export function isV1Version(version?: unknown): boolean {
  try {
    const v = String(version ?? "").trim();
    if (v === "") return true;
    if (v === V1_VERSION) return true;
    if (v.startsWith("2.")) return false;
    if (v.startsWith("1.")) return true;
    return false;
  } catch {
    return true;
  }
}

/** Current daemon version, best-effort via `OPENCODE_VERSION` env. */
export function currentVersion(): string {
  try {
    return String(process.env["OPENCODE_VERSION"] ?? "");
  } catch {
    return "";
  }
}

/**
 * Tag a daemonId with a v1 marker (`:v1` suffix) so registry rows are
 * visibly v1-scoped. Idempotent — already-marked ids pass through.
 */
export function withV1Marker(daemonId: string): string {
  try {
    const id = String(daemonId ?? "");
    if (id.includes(":v1") || id.endsWith("#v1")) return id;
    return `${id}:v1`;
  } catch {
    return String(daemonId ?? "");
  }
}

/** Strip a trailing `:v1` / `#v1` marker for daemon comparisons. Never throws. */
export function stripV1Marker(daemonId: unknown): string {
  try {
    return String(daemonId ?? "").replace(/:v1$|#v1$/, "");
  } catch {
    return String(daemonId ?? "");
  }
}

/**
 * Marker-insensitive daemon equality: the registry stores `:v1`-marked ids
 * while watchers hold the raw `getDaemonId()` value — compare stripped.
 * Never throws.
 */
export function sameDaemon(a: unknown, b: unknown): boolean {
  try {
    const x = stripV1Marker(a);
    const y = stripV1Marker(b);
    return x !== "" && x === y;
  } catch {
    return false;
  }
}

/**
 * Guard for registry daemonIds: true when the id is not a known v2 marker
 * (`.bun` path or the 49374 service port).
 */
export function isV1DaemonId(daemonId: unknown): boolean {
  try {
    const s = String(daemonId ?? "");
    if (s === "") return false;
    if (s.startsWith("v2:")) return false;
    if (s.includes(".bun")) return false;
    if (s.includes(V2_SERVICE_PORT)) return false;
    return true;
  } catch {
    return false;
  }
}

/** True when a daemonId belongs to a v2 runtime (`v2:` prefix or legacy markers). */
export function isV2DaemonId(daemonId: unknown): boolean {
  try {
    const s = String(daemonId ?? "");
    if (s === "") return false;
    if (s.startsWith("v2:")) return true;
    if (s.includes(".bun")) return true;
    if (s.includes(V2_SERVICE_PORT)) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Route a daemonId to its runtime (part 2): v2 markers (`.bun`/49374/`v2:`)
 * route to the v2 transport instead of being skipped. Never throws.
 */
export function runtimeOfDaemonId(daemonId: unknown): "v1" | "v2" {
  try {
    return isV2DaemonId(daemonId) ? "v2" : "v1";
  } catch {
    return "v1";
  }
}

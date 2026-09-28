/**
 * liveness.ts — heartbeat-age liveness for fleet registry rows.
 *
 * A registry row is only as good as its last heartbeat. Daemons re-beat
 * their own rows roughly every 60s (see v1/adapter.ts startPeriodicRebeat),
 * so a row that has not moved for a while means its owning daemon is down
 * or wedged — sending to it would burn a full DONE: timeout (default 60s)
 * on both the direct and the spool path (nobody is left to consume the
 * spool either). Callers fail fast with a readable "not live" error
 * instead, and point at fleet_doctor for the next command.
 *
 * Thresholds (generous on purpose: CI sandboxes pause, laptops sleep):
 *   live  — age <= LIVE_MS   (default 10min)
 *   stale — age <= STALE_MS  (default 60min)
 *   dead  — older, or missing/unparsable updatedAt
 *
 * Rows older than REGISTRY_TTL_MS (24h) are hidden by listRegistry anyway;
 * "dead" covers the window in between. Liveness is routing metadata only —
 * it never mutates ownership, assignments, or the registry.
 *
 * Owner-process reachability (advisory, doctor-only): where a daemonId
 * safely parses to a local pid (`pid:<n>` segments, v2 pid fallbacks), we
 * probe with `process.kill(pid, 0)` (no signal sent). Anything else reads
 * as "unknown" — never "unreachable" on a parse failure, so gating stays
 * on heartbeat age alone (fail-closed, no false kills).
 *
 * Never throws.
 */

import type { RegistryEntry } from "./registry.js";

/** Age at or under which a row counts as live (owning daemon beating). */
export const LIVE_MS = 10 * 60 * 1000;

/** Age at or under which a row counts as stale (not live, maybe transient). */
export const STALE_MS = 60 * 60 * 1000;

export type Liveness = "live" | "stale" | "dead";

/** Classify a heartbeat age (epoch millis) at `now`. Never throws. */
export function livenessOf(updatedAt: unknown, now = Date.now()): Liveness {
  try {
    const at = typeof updatedAt === "number" && Number.isFinite(updatedAt) ? updatedAt : NaN;
    if (Number.isNaN(at) || at <= 0) return "dead";
    const age = now - at;
    if (age < 0) return "live"; // future clock skew: treat as live, not dead.
    if (age <= LIVE_MS) return "live";
    if (age <= STALE_MS) return "stale";
    return "dead";
  } catch {
    return "dead";
  }
}

/** Classify a registry row. Never throws. */
export function livenessOfEntry(
  e: Pick<RegistryEntry, "updatedAt"> | null | undefined,
  now = Date.now(),
): Liveness {
  try {
    return livenessOf((e as { updatedAt?: unknown } | null)?.updatedAt, now);
  } catch {
    return "dead";
  }
}

/** True when the row is live at `now`. Never throws. */
export function isLiveEntry(
  e: Pick<RegistryEntry, "updatedAt"> | null | undefined,
  now = Date.now(),
): boolean {
  try {
    return livenessOfEntry(e, now) === "live";
  } catch {
    return false;
  }
}

/** Keep only live rows (default scoped views). Never throws. */
export function liveEntries<T extends Pick<RegistryEntry, "updatedAt">>(
  entries: T[],
  now = Date.now(),
): T[] {
  try {
    return (entries ?? []).filter((e) => isLiveEntry(e, now));
  } catch {
    return [];
  }
}

/** Short human age ("3m", "2.5h", "3.0d", "-" when unknown). Never throws. */
export function ageTextOf(updatedAt: unknown, now = Date.now()): string {
  try {
    const at = typeof updatedAt === "number" && Number.isFinite(updatedAt) ? updatedAt : NaN;
    if (Number.isNaN(at) || at <= 0) return "-";
    const ms = Math.max(0, now - at);
    const h = ms / 3_600_000;
    if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))}m`;
    if (h < 48) return `${h.toFixed(1)}h`;
    return `${(h / 24).toFixed(1)}d`;
  } catch {
    return "-";
  }
}

/**
 * Readable fail-fast error for a non-live target (stale|dead). Names the
 * age, the owning daemon, and the next command. Never throws.
 */
export function notLiveError(
  sessionId: string,
  entry: Pick<RegistryEntry, "updatedAt" | "daemonId"> | null | undefined,
  now = Date.now(),
): string {
  try {
    const sid = String(sessionId ?? "").trim() || "(unknown)";
    const live = livenessOfEntry(entry, now);
    const age = ageTextOf((entry as { updatedAt?: unknown } | null)?.updatedAt, now);
    const daemon = String((entry as { daemonId?: unknown } | null)?.daemonId ?? "").trim() || "(unknown daemon)";
    if (live === "live" || !entry) {
      return `${sid} is not live (age ${age}); owning daemon ${daemon} is not beating — run fleet_doctor for the next command`;
    }
    return `${sid} is not live (${live}, age ${age}); owning daemon ${daemon} is not beating — refusing instead of a full-timeout wait (run fleet_doctor for the next command)`;
  } catch {
    return `${String(sessionId ?? "")} is not live; run fleet_doctor for the next command`;
  }
}

export type OwnerReachability = "reachable" | "unreachable" | "unknown";

/**
 * Advisory owner-process probe (doctor-only, never gating): extract a local
 * pid from pid-style daemon segments and signal-0 it. Anything unparsable
 * reads "unknown". Never throws, never signals.
 */
export function ownerReachabilityOf(
  entry: Pick<RegistryEntry, "daemonId"> | null | undefined,
): OwnerReachability {
  try {
    const daemon = String((entry as { daemonId?: unknown } | null)?.daemonId ?? "");
    if (daemon.trim() === "") return "unknown";
    // v1 rows carry a `:v1`-marked stable id (no pid); v2 pid fallbacks look
    // like `v2:pid:<n>` and legacy rows may embed `pid-<n>` / `pid:<n>`.
    const pidMatch = /pid[:_-](\d{1,7})/i.exec(daemon);
    if (!pidMatch) {
      // Bare numeric daemonIds are ports, not pids — unparsable by design.
      return "unknown";
    }
    const pid = Number.parseInt(pidMatch[1] ?? "", 10);
    if (!Number.isFinite(pid) || pid <= 0) return "unknown";
    try {
      process.kill(pid, 0);
      return "reachable";
    } catch {
      return "unreachable";
    }
  } catch {
    return "unknown";
  }
}

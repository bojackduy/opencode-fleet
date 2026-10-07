/**
 * loopd.ts — read-only loopd goal awareness for fleet rows.
 *
 * loopd stores per-project state at `<projectDir>/.opencode/loopd/state.json`
 * with top-level `{ version, revision, goals[], runtimes, ... }` where each
 * goal carries `{ id, name, status, ownerSessionID, workerSessionID? }` and
 * the live phase lives in `runtimes[]` as `{ goalID, phase, ... }` (older
 * shapes may nest it as `goal.runtime.phase` or `goal.phase` — all are
 * honored). Fleet registry rows already carry the worker session's project
 * `directory`, so the join is directory + session-id match.
 *
 * This module is STRICTLY read-only: it never writes, never creates
 * directories, never throws (any error degrades to `[]`), and never depends
 * on loopd packages (structural local types only).
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface LoopdGoalMatch {
  goalId: string;
  name: string;
  status: string;
  phase: string;
  ownerSessionId: string;
  /** True when the fleet session is the goal's worker. */
  isWorker: boolean;
  /** True when the fleet session is the goal's owner. */
  isOwner: boolean;
}

/** Cap the state file read at 5MB (fail-open to [] above it). */
export const LOOPD_STATE_MAX_BYTES = 5 * 1024 * 1024;

/** Sanitize one cell fragment so table rows stay single-line. */
function cleanCell(raw: unknown, fallback: string, maxLen = 60): string {
  try {
    const s = String(raw ?? "").replace(/[\r\n]+/g, " ").replace(/\|/g, "/").trim();
    if (s === "") return fallback;
    return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
  } catch {
    return fallback;
  }
}

function phaseByGoalId(state: unknown): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const runtimes = (state as { runtimes?: unknown })?.runtimes;
    const list: unknown[] = Array.isArray(runtimes)
      ? runtimes
      : runtimes && typeof runtimes === "object"
        ? Object.values(runtimes as Record<string, unknown>)
        : [];
    for (const r of list) {
      if (!r || typeof r !== "object") continue;
      const rec = r as Record<string, unknown>;
      const id = rec["goalID"] ?? rec["goalId"] ?? rec["id"];
      const phase = rec["phase"] ?? (rec["runtime"] as Record<string, unknown> | undefined)?.["phase"];
      if (typeof id === "string" && id !== "" && typeof phase === "string" && phase !== "") {
        out.set(id, phase);
      }
    }
  } catch {
    // ignore — fail-open
  }
  return out;
}

/**
 * Read-only lookup of loopd goals owned/worked by `sessionId` in the project
 * rooted at `directory`. Reads `<dir>/.opencode/loopd/state.json` only
 * (containment-checked, size-capped); returns `[]` on any error. Never throws.
 */
export function findLoopdGoals(directory: unknown, sessionId: unknown): LoopdGoalMatch[] {
  try {
    if (typeof directory !== "string" || directory.trim() === "") return [];
    if (typeof sessionId !== "string" || sessionId.trim() === "") return [];
    const sid = sessionId.trim();
    const root = path.resolve(directory.trim());
    const statePath = path.join(root, ".opencode", "loopd", "state.json");
    // Containment: the resolved state path must stay inside the project dir
    // (never follow symlinks outside it).
    const resolved = path.resolve(statePath);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return [];
    let st: fs.Stats;
    try {
      st = fs.lstatSync(resolved);
    } catch {
      return [];
    }
    // Refuse symlinks (never follow them outside the project) and oversize files.
    if (st.isSymbolicLink()) return [];
    if (!st.isFile() || st.size > LOOPD_STATE_MAX_BYTES) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
    } catch {
      return [];
    }
    const goals = (parsed as { goals?: unknown })?.goals;
    if (!Array.isArray(goals)) return [];
    const phases = phaseByGoalId(parsed);
    const out: LoopdGoalMatch[] = [];
    for (const g of goals) {
      if (!g || typeof g !== "object") continue;
      const rec = g as Record<string, unknown>;
      const owner = typeof rec["ownerSessionID"] === "string" ? rec["ownerSessionID"] : "";
      const worker = typeof rec["workerSessionID"] === "string" ? rec["workerSessionID"] : "";
      const isOwner = owner !== "" && owner === sid;
      const isWorker = worker !== "" && worker === sid;
      if (!isOwner && !isWorker) continue;
      const id = typeof rec["id"] === "string" && rec["id"] !== "" ? rec["id"] : "-";
      const nestedPhase =
        (rec["runtime"] as Record<string, unknown> | undefined)?.["phase"];
      const phase =
        phases.get(id) ??
        (typeof nestedPhase === "string" && nestedPhase !== "" ? nestedPhase : null) ??
        (typeof rec["phase"] === "string" && (rec["phase"] as string) !== ""
          ? (rec["phase"] as string)
          : null) ??
        "-";
      out.push({
        goalId: id,
        name: cleanCell(rec["name"], "-"),
        status: cleanCell(rec["status"], "unknown"),
        phase: cleanCell(phase, "-"),
        ownerSessionId: owner,
        isWorker,
        isOwner,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Compact cell for the `loopd` column: `<name>:<status>/<phase>` per match
 * (comma-joined), `-` when none. Never throws.
 */
export function loopdCell(directory: unknown, sessionId: unknown): string {
  try {
    const matches = findLoopdGoals(directory, sessionId);
    if (matches.length === 0) return "-";
    return matches.map((m) => `${m.name}:${m.status}/${m.phase}`).join(",");
  } catch {
    return "-";
  }
}

/**
 * Suffix for `fleet_status` rows: ` | loopd:<cell>` when matched, `""`
 * otherwise (status rows omit the column instead of printing `-`). Never throws.
 */
export function loopdSuffix(directory: unknown, sessionId: unknown): string {
  try {
    const matches = findLoopdGoals(directory, sessionId);
    if (matches.length === 0) return "";
    return ` | loopd:${matches.map((m) => `${m.name}:${m.status}/${m.phase}`).join(",")}`;
  } catch {
    return "";
  }
}

/**
 * fleetDiscover.ts — Phase P1 `fleet_discover` + `fleet_ps` tools,
 * Phase B2 default-scoped with an explicit global flag.
 *
 * Default rows hide workers owned by ANOTHER commander (no accidental
 * foreign visibility): a resolving commander sees self + own + unassigned;
 * an unresolvable caller (unknown/peer/fork — e.g. pre-claim onboarding)
 * sees only unassigned/unknown rows, never another commander's workers.
 * Pass scope:"all" for the explicit global onboarding roster (requires a
 * resolvable commander identity, fail-closed otherwise).
 *
 * Every registered row carries its ownership annotation (owning commander
 * composite key, `unassigned` when claimable, `unknown` when assignment
 * state is unreadable, `ambiguous(N)` on bare-id collisions). Claiming is
 * via `fleet_assign`; control never happens from here. Never throws —
 * failures render as readable text.
 */

import { depsOf, z } from "../toolDef.js";
import type { ToolDef } from "../toolDef.js";
import type { Runtime } from "../runtime.js";
import { discoverSessionsPreferApi, fleetPs } from "../discover.js";
import { readAssignments } from "../assignments.js";
import { resolveCallingCommander, shortSessionOf } from "../ownershipControl.js";

export interface FleetToolDeps {
  // biome-ignore lint/suspicious/noExplicitAny: v1 plugin client is untyped at the boundary.
  client?: any;
  serverUrl?: string | URL;
}

function toReadableError(err: unknown): string {
  if (err instanceof Error) return err.message || String(err);
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function timeAgo(timeUpdated: number, now = Date.now()): string {
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

/** Bare sessionId -> owning commander COMPOSITE keys (runtime/daemon/session, never bare). Never throws. */
async function ownerAnnotations(): Promise<Map<string, string[]> | null> {
  try {
    const asg = await readAssignments();
    if (asg.status === "corrupt" || asg.status === "error") return null;
    const map = new Map<string, string[]>();
    for (const a of Object.values(asg.state.assignments)) {
      const worker = shortSessionOf(a.workerKey);
      const list = map.get(worker) ?? [];
      if (!list.includes(a.commanderKey)) list.push(a.commanderKey);
      map.set(worker, list);
    }
    return map;
  } catch {
    return null;
  }
}

/** Render one composite commander key as `runtime/daemonId/sessionId`. Never throws. */
function displayKey(key: string): string {
  try {
    const parts = String(key ?? "").split("\u0000");
    if (parts.length !== 3) return String(key ?? "");
    return `${parts[0]}/${parts[1]}/${parts[2]}`;
  } catch {
    return String(key ?? "");
  }
}

/** One owner cell: `unassigned` (claimable), composite owner key, `a+b` on collision, `unknown` when unreadable. */
function ownerCell(sessionId: string, owners: Map<string, string[]> | null): string {
  try {
    if (owners === null) return "unknown";
    const list = owners.get(String(sessionId ?? "")) ?? [];
    if (list.length === 0) return "unassigned";
    if (list.length === 1) return displayKey(list[0] as string);
    return `ambiguous(${list.length}):${list.map(displayKey).join("+")}`;
  } catch {
    return "unknown";
  }
}

/**
 * Best-effort caller key for default-scope filtering (never denies: this is
 * the read-only onboarding path). Empty string when the caller does not
 * resolve to a commander (unknown/peer/fork). Never throws.
 */
async function discoverCallerKey(context: any, rt?: Runtime): Promise<string> {
  try {
    const res = await resolveCallingCommander(context as any, rt);
    return res.ok ? res.callerKey : "";
  } catch {
    return "";
  }
}

/**
 * Default-scope filter: hide rows owned by another commander. A resolving
 * commander keeps self + own + unassigned/unknown rows; an unresolvable
 * caller keeps only unassigned/unknown rows. Corrupt/unreadable assignment
 * state (owners === null) keeps every row as `unknown` so recovery
 * discovery stays usable without claiming clean ownership.
 */
function rowVisible(
  sessionId: string,
  owners: Map<string, string[]> | null,
  callerKey: string,
): boolean {
  try {
    if (owners === null) return true;
    const list = owners.get(String(sessionId ?? "")) ?? [];
    if (list.length === 0) return true; // unassigned: visible for claiming
    if (callerKey === "") return false; // unknown caller: never show owned rows
    return list.includes(callerKey);
  } catch {
    return false;
  }
}

function isScopeAll(args: any): boolean {
  try {
    return typeof args?.scope === "string" && args.scope.trim().toLowerCase() === "all";
  } catch {
    return false;
  }
}

function shortDir(dir: string, max = 48): string {
  try {
    if (dir.length <= max) return dir;
    return `…${dir.slice(dir.length - max + 1)}`;
  } catch {
    return dir;
  }
}

export async function fleetDiscoverHandler(args: any, context: any, deps?: FleetToolDeps): Promise<string> {
  try {
    const rawLimit = args?.limit;
    const limit =
      typeof rawLimit === "number" && Number.isFinite(rawLimit)
        ? Math.max(1, Math.min(100, Math.floor(rawLimit)))
        : 15;
    const rt = (deps as { rt?: Runtime } | undefined)?.rt;
    if (isScopeAll(args)) {
      // Explicit global onboarding roster: requires a resolvable commander.
      const res = await resolveCallingCommander(context as any, rt);
      if (!res.ok) return `fleet_discover failed: ${res.error}`;
    }
    // Hot path: heartbeat registry / live API first; sqlite only on a miss.
    const rows = await discoverSessionsPreferApi(deps?.client, limit);
    if (rows.length === 0) return "no sessions discovered";
    const now = Date.now();
    const owners = await ownerAnnotations();
    const callerKey = isScopeAll(args) ? "" : await discoverCallerKey(context, rt);
    const lines = ["sessionId | title | dir | updated | registered | owner"];
    let shown = 0;
    for (const r of rows) {
      if (shown >= limit) break;
      if (!isScopeAll(args) && !rowVisible(r.id, owners, callerKey)) continue;
      const title = r.title.replace(/\s+/g, " ").trim().slice(0, 60) || "-";
      lines.push(
        `${r.id} | ${title} | ${shortDir(r.directory)} | ${timeAgo(r.timeUpdated, now)} | ${r.registered ? "yes" : "no"} | ${ownerCell(r.id, owners)}`,
      );
      shown += 1;
    }
    if (shown === 0) return "no sessions discovered";
    return lines.join("\n");
  } catch (err) {
    return `fleet_discover failed: ${toReadableError(err)}`;
  }
}

export async function fleetPsHandler(args: any, context: any, deps?: FleetToolDeps): Promise<string> {
  try {
    const rt = (deps as { rt?: Runtime } | undefined)?.rt;
    if (isScopeAll(args)) {
      const res = await resolveCallingCommander(context as any, rt);
      if (!res.ok) return `fleet_ps failed: ${res.error}`;
    }
    const rows = await fleetPs(50, deps?.client);
    if (rows.length === 0) return "no sessions discovered";
    const owners = await ownerAnnotations();
    const callerKey = isScopeAll(args) ? "" : await discoverCallerKey(context, rt);
    const lines = ["sessionId | title | dir | pid | port | registered | age | owner"];
    let shown = 0;
    for (const r of rows) {
      if (!isScopeAll(args) && !rowVisible(r.sessionId, owners, callerKey)) continue;
      const title = r.title.replace(/\s+/g, " ").trim().slice(0, 50) || "-";
      lines.push(
        `${r.sessionId} | ${title} | ${shortDir(r.directory, 40)} | ${r.pidHint || "-"} | ${r.portHint || "-"} | ${r.registered ? "yes" : "no"} | ${r.age} | ${ownerCell(r.sessionId, owners)}`,
      );
      shown += 1;
    }
    if (shown === 0) return "no sessions discovered";
    return lines.join("\n");
  } catch (err) {
    return `fleet_ps failed: ${toReadableError(err)}`;
  }
}

export const fleetDiscoverDef: ToolDef = {
  name: "fleet_discover",
  description:
    "Find live sessions to claim (read-only, newest first; ownership-annotated; default hides workers owned by other commanders). First-use order: fleet_doctor (if lost) -> fleet_discover/fleet_unassigned -> fleet_assign -> fleet_exec. Control never happens from here.",
  args: {
    limit: z.number().optional().describe("Max sessions to show (default 15)"),
    scope: z
      .string()
      .optional()
      .describe('Row scope: default hides other commanders\' workers; "all" for the explicit global roster (requires commander identity)'),
  },
  run: (args, callCtx, rt) => fleetDiscoverHandler(args, callCtx, depsOf(rt)),
};

export const fleetPsDef: ToolDef = {
  name: "fleet_ps",
  description:
    "Show fleet processes merged from ps/lsof + sqlite + registry with pid/port hints (read-only, v1 only; ownership-annotated; default hides workers owned by other commanders).",
  args: {
    scope: z
      .string()
      .optional()
      .describe('Row scope: default hides other commanders\' workers; "all" for the explicit global roster (requires commander identity)'),
  },
  run: (args, callCtx, rt) => fleetPsHandler(args, callCtx, depsOf(rt)),
};

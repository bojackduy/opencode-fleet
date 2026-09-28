/**
 * fleetDiscover.ts — Phase P1 `fleet_discover` + `fleet_ps` tools,
 * Phase B2 ownership-annotated.
 *
 * Read-only discovery over sqlite + registry + ps. These stay OPEN (no
 * commander gate: discovery must work before a worker is claimed), but
 * every registered row carries its ownership annotation (owning commander
 * session, `unassigned` when claimable, `unknown` when assignment state is
 * unreadable, `ambiguous(N)` on bare-id collisions). Claiming is via
 * `fleet_assign`; control never happens from here. Never throws —
 * failures render as readable text.
 */

import { depsOf, z } from "../toolDef.js";
import type { ToolDef } from "../toolDef.js";
import { discoverSessionsPreferApi, fleetPs } from "../discover.js";
import { readAssignments } from "../assignments.js";
import { shortSessionOf } from "../ownershipControl.js";

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

function shortDir(dir: string, max = 48): string {
  try {
    if (dir.length <= max) return dir;
    return `…${dir.slice(dir.length - max + 1)}`;
  } catch {
    return dir;
  }
}

export async function fleetDiscoverHandler(args: any, _context: any, _deps?: FleetToolDeps): Promise<string> {
  void _context;
  try {
    const rawLimit = args?.limit;
    const limit =
      typeof rawLimit === "number" && Number.isFinite(rawLimit)
        ? Math.max(1, Math.min(100, Math.floor(rawLimit)))
        : 15;
    // Hot path: heartbeat registry / live API first; sqlite only on a miss.
    const rows = await discoverSessionsPreferApi(_deps?.client, limit);
    if (rows.length === 0) return "no sessions discovered";
    const now = Date.now();
    const owners = await ownerAnnotations();
    const lines = ["sessionId | title | dir | updated | registered | owner"];
    for (const r of rows.slice(0, limit)) {
      const title = r.title.replace(/\s+/g, " ").trim().slice(0, 60) || "-";
      lines.push(
        `${r.id} | ${title} | ${shortDir(r.directory)} | ${timeAgo(r.timeUpdated, now)} | ${r.registered ? "yes" : "no"} | ${ownerCell(r.id, owners)}`,
      );
    }
    return lines.join("\n");
  } catch (err) {
    return `fleet_discover failed: ${toReadableError(err)}`;
  }
}

export async function fleetPsHandler(_args: any, _context: any, _deps?: FleetToolDeps): Promise<string> {
  void _context;
  try {
    const rows = await fleetPs(50, _deps?.client);
    if (rows.length === 0) return "no sessions discovered";
    const owners = await ownerAnnotations();
    const lines = ["sessionId | title | dir | pid | port | registered | age | owner"];
    for (const r of rows) {
      const title = r.title.replace(/\s+/g, " ").trim().slice(0, 50) || "-";
      lines.push(
        `${r.sessionId} | ${title} | ${shortDir(r.directory, 40)} | ${r.pidHint || "-"} | ${r.portHint || "-"} | ${r.registered ? "yes" : "no"} | ${r.age} | ${ownerCell(r.sessionId, owners)}`,
      );
    }
    return lines.join("\n");
  } catch (err) {
    return `fleet_ps failed: ${toReadableError(err)}`;
  }
}

export const fleetDiscoverDef: ToolDef = {
  name: "fleet_discover",
  description:
    "Find live sessions to claim (read-only, newest first; ownership-annotated). First-use order: fleet_doctor (if lost) -> fleet_discover/fleet_unassigned -> fleet_assign -> fleet_exec. Control never happens from here.",
  args: {
    limit: z.number().optional().describe("Max sessions to show (default 15)"),
  },
  run: (args, callCtx, rt) => fleetDiscoverHandler(args, callCtx, depsOf(rt)),
};

export const fleetPsDef: ToolDef = {
  name: "fleet_ps",
  description:
    "Show fleet processes merged from ps/lsof + sqlite + registry with pid/port hints (read-only, v1 only; ownership-annotated).",
  args: {},
  run: (args, callCtx, rt) => fleetPsHandler(args, callCtx, depsOf(rt)),
};

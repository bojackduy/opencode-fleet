/**
 * fleetList.ts — Phase 3 `fleet_list` tool, Phase B2 per-commander scoped.
 *
 * Exactly ONE controlling commander per worker (see ../assignments.ts).
 * Default rows are ONLY the calling commander's owned workers (never the
 * whole fleet, never another commander's workers — no accidental foreign
 * visibility). Pass scope:"all" for an explicit global roster. Caller
 * identity ALWAYS comes from the tool context + runtime (fail-closed:
 * unknown/non-commander callers and unreadable state render readable
 * errors, never a misleading list). Never throws.
 */

import { depsOf, z } from "../toolDef.js";
import type { ToolDef } from "../toolDef.js";
import type { Runtime } from "../runtime.js";
import { listRegistry, fleetKeyOf, runtimeOf } from "../registry.js";
import type { RegistryEntry } from "../registry.js";
import { scopedRegistryEntries } from "../ownershipControl.js";
import { liveEntries } from "../liveness.js";
import { renderTree } from "./fleetRoles.js";
import { loopdCell } from "../loopd.js";

export interface FleetToolDeps {
  // biome-ignore lint/suspicious/noExplicitAny: v1 plugin client is untyped at the boundary.
  client?: any;
  serverUrl?: string | URL;
  rt?: Runtime;
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

export async function fleetListHandler(
  args: any,
  context: any,
  deps?: FleetToolDeps,
): Promise<string> {
  try {
    const includeSelf = args?.includeSelf === true;
    const selfId = context?.sessionID ?? context?.sessionId;
    const scopeAll = typeof args?.scope === "string" && args.scope.trim().toLowerCase() === "all";
    const scoped = await scopedRegistryEntries(context as any, deps?.rt);
    if (!scoped.ok) return `fleet_list failed: ${scoped.error}`;
    let entries: RegistryEntry[];
    if (scopeAll) {
      entries = await listRegistry({ includeSelf, selfId });
    } else {
      // Default rows are live-owned workers only (stale/dead rows fail fast
      // at send time; scope:"all" keeps the explicit global roster/history).
      const owned = [...scoped.owned];
      const live = liveEntries(owned);
      if (live.length === 0 && owned.length > 0) {
        return `no live workers assigned to you (${owned.length} owned but stale/dead; run fleet_doctor for the next command; scope:"all" shows history)`;
      }
      entries = [...live];
      if (includeSelf) {
        const all = await listRegistry({ includeSelf: true, selfId });
        const self = all.find((e) => fleetKeyOf(e) === scoped.callerKey);
        if (self && !entries.some((e) => fleetKeyOf(e) === scoped.callerKey)) entries.push(self);
      }
    }
    if (entries.length === 0) {
      return scopeAll
        ? "no workers registered"
        : `no workers assigned to you (claim workers with fleet_assign; unassigned discovery: fleet_unassigned)`;
    }
    // P5 hierarchy view: group by parentID (commanders top, workers nested).
    if (args?.tree === true) return renderTree(entries, selfId);
    const now = Date.now();
    const lines = ["sessionId | runtime | daemonId | directory | summary | ageH | loopd"];
    for (const e of entries) {
      const label = e.summary ?? e.title ?? "";
      const ageH =
        typeof e.updatedAt === "number" ? ((now - e.updatedAt) / 3_600_000).toFixed(1) : "?";
      lines.push(`${e.sessionId} | ${runtimeOf(e)} | ${e.daemonId} | ${e.directory} | ${label} | ${ageH} | ${loopdCell(e.directory, e.sessionId)}`);
    }
    return lines.join("\n");
  } catch (err) {
    return `fleet_list failed: ${toReadableError(err)}`;
  }
}

export const fleetListDef: ToolDef = {
  name: "fleet_list",
  description:
    "List live fleet workers you own (per-commander scoped, liveness-gated; entries older than 24h are hidden). Pass scope:\"all\" for the explicit global roster/history. Excludes self unless includeSelf is true. Missing workers? Run fleet_doctor first.",
  args: {
    includeSelf: z
      .boolean()
      .optional()
      .describe("Include the calling session in the list"),
    scope: z
      .string()
      .optional()
      .describe('Row scope: default is your owned workers only; "all" for the explicit global roster'),
    tree: z
      .boolean()
      .optional()
      .describe("Group by parentID: commanders at top, workers/forks nested, orphans last"),
  },
  run: (args, callCtx, rt) => fleetListHandler(args, callCtx, depsOf(rt)),
};

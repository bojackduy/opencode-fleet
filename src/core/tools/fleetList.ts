/**
 * fleetList.ts — Phase 3 `fleet_list` tool.
 *
 * Reads the registry via `listRegistry()` (24h TTL filtering is already
 * applied there) and renders a compact table. Never throws — failures are
 * returned as readable text.
 */

import { depsOf, z } from "../toolDef.js";
import type { ToolDef } from "../toolDef.js";
import { listRegistry } from "../registry.js";
import { renderTree } from "./fleetRoles.js";

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

export async function fleetListHandler(
  args: any,
  context: any,
  _deps?: FleetToolDeps,
): Promise<string> {
  void _deps;
  try {
    const includeSelf = args?.includeSelf === true;
    const selfId = context?.sessionID ?? context?.sessionId;
    const entries = await listRegistry({ includeSelf, selfId });
    if (entries.length === 0) return "no workers registered";
    // P5 hierarchy view: group by parentID (commanders top, workers nested).
    if (args?.tree === true) return renderTree(entries, selfId);
    const now = Date.now();
    const lines = ["sessionId | daemonId | directory | summary | ageH"];
    for (const e of entries) {
      const label = e.summary ?? e.title ?? "";
      const ageH =
        typeof e.updatedAt === "number" ? ((now - e.updatedAt) / 3_600_000).toFixed(1) : "?";
      lines.push(`${e.sessionId} | ${e.daemonId} | ${e.directory} | ${label} | ${ageH}`);
    }
    return lines.join("\n");
  } catch (err) {
    return `fleet_list failed: ${toReadableError(err)}`;
  }
}

export const fleetListDef: ToolDef = {
  name: "fleet_list",
  description:
    "List registered fleet worker sessions (entries older than 24h are hidden). Excludes self unless includeSelf is true.",
  args: {
    includeSelf: z
      .boolean()
      .optional()
      .describe("Include the calling session in the list"),
    tree: z
      .boolean()
      .optional()
      .describe("Group by parentID: commanders at top, workers/forks nested, orphans last"),
  },
  run: (args, callCtx, rt) => fleetListHandler(args, callCtx, depsOf(rt)),
};

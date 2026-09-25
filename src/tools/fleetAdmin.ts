/**
 * fleetAdmin.ts — P4 `fleet_allow` / `fleet_block` / `fleet_policy` /
 * `fleet_summary` / `fleet_group` tools.
 *
 * Admin over the auth allowlist (commander ids) + registry summaries grouped
 * by directory/project/agent/status with counts + last DONE per group.
 * All tools are v1 tool() and never throw — failures render as readable text.
 */

import { tool } from "@opencode-ai/plugin";
import {
  addCommander,
  getPolicy,
  listCommanders,
  removeCommander,
  setPolicy,
} from "../auth.js";
import { listRegistry } from "../registry.js";

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

function projectOf(directory: string): string {
  try {
    const parts = String(directory ?? "").split("/").filter((p) => p !== "");
    return parts.length > 0 ? (parts[parts.length - 1] as string) : "-";
  } catch {
    return "-";
  }
}

type GroupBy = "directory" | "project" | "agent" | "status";

function normalizeGroupBy(raw: unknown): GroupBy {
  if (raw === "project" || raw === "agent" || raw === "status" || raw === "directory") return raw;
  return "directory";
}

function oneLine(s: string, max = 60): string {
  try {
    const flat = String(s ?? "").replace(/\s+/g, " ").trim();
    if (flat === "") return "-";
    return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
  } catch {
    return "-";
  }
}

export async function fleetAllowHandler(args: any, _context: any, _deps?: FleetToolDeps): Promise<string> {
  void _context;
  void _deps;
  try {
    const id = typeof args?.sessionId === "string" ? args.sessionId.trim() : "";
    if (id === "") return "fleet_allow failed: sessionId must be a non-empty string";
    const list = await addCommander(id);
    const policy = await getPolicy().catch(() => "commander-only");
    return `allowed ${id} (policy=${policy}, allowlist=${list.length})`;
  } catch (err) {
    return `fleet_allow failed: ${toReadableError(err)}`;
  }
}

export async function fleetBlockHandler(args: any, _context: any, _deps?: FleetToolDeps): Promise<string> {
  void _context;
  void _deps;
  try {
    const id = typeof args?.sessionId === "string" ? args.sessionId.trim() : "";
    if (id === "") return "fleet_block failed: sessionId must be a non-empty string";
    const list = await removeCommander(id);
    const policy = await getPolicy().catch(() => "commander-only");
    return `blocked ${id} (policy=${policy}, allowlist=${list.length})`;
  } catch (err) {
    return `fleet_block failed: ${toReadableError(err)}`;
  }
}

export async function fleetPolicyHandler(args: any, _context: any, _deps?: FleetToolDeps): Promise<string> {
  void _context;
  void _deps;
  try {
    const raw = typeof args?.policy === "string" ? args.policy.trim() : "";
    if (raw === "") {
      const cur = await getPolicy().catch(() => "commander-only");
      const list = await listCommanders().catch(() => [] as string[]);
      return `policy=${cur} allowlist=${list.length}${list.length > 0 ? ` (${list.join(", ")})` : ""}`;
    }
    if (raw !== "accept" && raw !== "hold" && raw !== "refuse" && raw !== "commander-only") {
      return `fleet_policy failed: policy must be commander-only|accept|hold|refuse (got ${raw})`;
    }
    const p = await setPolicy(raw);
    const list = await listCommanders().catch(() => [] as string[]);
    return `policy=${p} allowlist=${list.length}`;
  } catch (err) {
    return `fleet_policy failed: ${toReadableError(err)}`;
  }
}

async function summarize(groupBy: GroupBy): Promise<string> {
  try {
    const entries = await listRegistry({ includeSelf: true }).catch(() => []);
    if (entries.length === 0) return "no workers registered";
    const groups = new Map<string, { count: number; lastDone: string; lastAt: number }>();
    for (const e of entries) {
      let key = "-";
      if (groupBy === "directory") key = e.directory || "-";
      else if (groupBy === "project") key = projectOf(e.directory);
      else if (groupBy === "agent") key = e.agent || "-";
      else key = e.status || "-";
      const g = groups.get(key) ?? { count: 0, lastDone: "-", lastAt: 0 };
      g.count += 1;
      const at = typeof e.updatedAt === "number" ? e.updatedAt : 0;
      if (at >= g.lastAt) {
        g.lastAt = at;
        if (e.lastDone && e.lastDone.trim() !== "") g.lastDone = e.lastDone.trim();
      }
      groups.set(key, g);
    }
    const rows = [...groups.entries()].sort((a, b) => b[1].count - a[1].count);
    const lines = [`group(${groupBy}) | count | lastDONE`];
    for (const [k, g] of rows) lines.push(`${oneLine(k, 60)} | ${g.count} | ${oneLine(g.lastDone, 80)}`);
    return lines.join("\n");
  } catch (err) {
    return `fleet_summary failed: ${toReadableError(err)}`;
  }
}

export async function fleetSummaryHandler(args: any, _context: any, _deps?: FleetToolDeps): Promise<string> {
  void _context;
  void _deps;
  try {
    return await summarize(normalizeGroupBy(args?.groupBy));
  } catch (err) {
    return `fleet_summary failed: ${toReadableError(err)}`;
  }
}

export async function fleetGroupHandler(args: any, _context: any, _deps?: FleetToolDeps): Promise<string> {
  void _context;
  void _deps;
  try {
    return await summarize(normalizeGroupBy(args?.groupBy));
  } catch (err) {
    return `fleet_group failed: ${toReadableError(err)}`;
  }
}

export function makeFleetAllowTool(deps?: FleetToolDeps) {
  return tool({
    description: "Allow a commander session id into the fleet allowlist (auth accept path).",
    args: {
      sessionId: tool.schema.string().describe("Commander session id to allow"),
    },
    execute: async (args, context) => fleetAllowHandler(args, context, deps),
  });
}

export function makeFleetBlockTool(deps?: FleetToolDeps) {
  return tool({
    description: "Remove a commander session id from the fleet allowlist (deny path).",
    args: {
      sessionId: tool.schema.string().describe("Commander session id to block"),
    },
    execute: async (args, context) => fleetBlockHandler(args, context, deps),
  });
}

export function makeFleetPolicyTool(deps?: FleetToolDeps) {
  return tool({
    description:
      "Get or set the fleet inbound policy (commander-only|accept|hold|refuse). Default is commander-only (P5 safe default).",
    args: {
      policy: tool.schema.string().optional().describe("commander-only|accept|hold|refuse; omit to read current"),
    },
    execute: async (args, context) => fleetPolicyHandler(args, context, deps),
  });
}

export function makeFleetSummaryTool(deps?: FleetToolDeps) {
  return tool({
    description: "Summarize fleet workers grouped by directory|project|agent|status with counts + last DONE.",
    args: {
      groupBy: tool.schema.string().optional().describe("directory (default)|project|agent|status"),
    },
    execute: async (args, context) => fleetSummaryHandler(args, context, deps),
  });
}

export function makeFleetGroupTool(deps?: FleetToolDeps) {
  return tool({
    description: "Group fleet workers like fleet_summary: counts + last DONE per group.",
    args: {
      groupBy: tool.schema.string().optional().describe("directory (default)|project|agent|status"),
    },
    execute: async (args, context) => fleetGroupHandler(args, context, deps),
  });
}

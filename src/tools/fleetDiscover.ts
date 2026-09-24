/**
 * fleetDiscover.ts — Phase P1 `fleet_discover` + `fleet_ps` tools.
 *
 * Read-only discovery over sqlite + registry + ps. Never throws —
 * failures render as readable text.
 */

import { tool } from "@opencode-ai/plugin";
import { discoverSessionsPreferApi, fleetPs } from "../discover.js";

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
    const lines = ["sessionId | title | dir | updated | registered"];
    for (const r of rows.slice(0, limit)) {
      const title = r.title.replace(/\s+/g, " ").trim().slice(0, 60) || "-";
      lines.push(
        `${r.id} | ${title} | ${shortDir(r.directory)} | ${timeAgo(r.timeUpdated, now)} | ${r.registered ? "yes" : "no"}`,
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
    const lines = ["sessionId | title | dir | pid | port | registered | age"];
    for (const r of rows) {
      const title = r.title.replace(/\s+/g, " ").trim().slice(0, 50) || "-";
      lines.push(
        `${r.sessionId} | ${title} | ${shortDir(r.directory, 40)} | ${r.pidHint || "-"} | ${r.portHint || "-"} | ${r.registered ? "yes" : "no"} | ${r.age}`,
      );
    }
    return lines.join("\n");
  } catch (err) {
    return `fleet_ps failed: ${toReadableError(err)}`;
  }
}

export function makeFleetDiscoverTool(deps?: FleetToolDeps) {
  return tool({
    description:
      "Discover v1 sessions from the shared sqlite DB joined with the fleet registry (read-only, newest first).",
    args: {
      limit: tool.schema.number().optional().describe("Max sessions to show (default 15)"),
    },
    execute: async (args, context) => fleetDiscoverHandler(args, context, deps),
  });
}

export function makeFleetPsTool(deps?: FleetToolDeps) {
  return tool({
    description:
      "Show fleet processes merged from ps/lsof + sqlite + registry with pid/port hints (read-only, v1 only).",
    args: {},
    execute: async (args, context) => fleetPsHandler(args, context, deps),
  });
}

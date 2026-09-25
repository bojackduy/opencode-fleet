/**
 * fleetRoles.ts — P5 `fleet_claim_commander` / `fleet_release_commander` /
 * `fleet_tree` tools.
 *
 * Claim/release mutate the auth.json commander allowlist (+ stamp the
 * registry role) via roles.ts. Tree renders the parentID hierarchy:
 * commanders at top, their workers/forks nested, orphans last.
 * All tools are v1 tool() and never throw — failures render as readable text.
 */

import { tool } from "@opencode-ai/plugin";
import { listRegistry } from "../registry.js";
import type { RegistryEntry } from "../registry.js";
import { claimCommander, releaseCommander, roleOf } from "../roles.js";

export interface FleetToolDeps {
  // biome-ignore lint/suspicious/noExplicitAny: v1 plugin client is untyped at the boundary.
  client?: any;
  serverUrl?: string | URL;
}

function selfIdOf(context: any): string {
  return (context?.sessionID ?? context?.sessionId ?? "") as string;
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

function parentOf(e: RegistryEntry): string {
  try {
    const p = (e as { parentID?: unknown }).parentID;
    return typeof p === "string" ? p.trim() : "";
  } catch {
    return "";
  }
}

function labelOf(e: RegistryEntry): string {
  try {
    const l = e.summary ?? e.title ?? "";
    return l.trim() === "" ? "-" : l.trim();
  } catch {
    return "-";
  }
}

/**
 * Render the parentID hierarchy. Commanders at top with their
 * workers/forks nested (2-space indent), top-level peers next,
 * orphans (parentID pointing at an unknown session) last.
 * Never throws — returns readable text.
 */
export function renderTree(entries: RegistryEntry[], selfId?: string): string {
  try {
    if (entries.length === 0) return "no workers registered";
    const byId = new Map(entries.map((e) => [e.sessionId, e]));
    const kids = new Map<string, RegistryEntry[]>();
    const orphans: RegistryEntry[] = [];
    const tops: RegistryEntry[] = [];
    for (const e of entries) {
      const p = parentOf(e);
      if (p === "") {
        tops.push(e);
      } else if (byId.has(p)) {
        const list = kids.get(p) ?? [];
        list.push(e);
        kids.set(p, list);
      } else {
        orphans.push(e);
      }
    }
    const rank = (e: RegistryEntry): number => {
      const r = roleOf(e);
      if (r === "commander") return 0;
      if (r === "worker") return 1;
      return 2;
    };
    tops.sort((a, b) => rank(a) - rank(b) || a.sessionId.localeCompare(b.sessionId));
    const lines: string[] = ["role sessionId | daemonId | directory | summary"];
    const seen = new Set<string>();
    const emit = (e: RegistryEntry, depth: number): void => {
      if (seen.has(e.sessionId)) return;
      seen.add(e.sessionId);
      const pad = "  ".repeat(Math.min(depth, 8));
      const self = selfId !== undefined && selfId !== "" && e.sessionId === selfId ? " (self)" : "";
      lines.push(
        `${pad}${roleOf(e)} ${e.sessionId}${self} | ${e.daemonId} | ${e.directory} | ${labelOf(e)}`,
      );
      const children = (kids.get(e.sessionId) ?? [])
        .slice()
        .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
      for (const c of children) emit(c, depth + 1);
    };
    for (const t of tops) emit(t, 0);
    // Any nested entries unreachable from tops (cycles) still get listed.
    for (const e of entries) {
      if (!seen.has(e.sessionId) && !orphans.includes(e)) emit(e, 0);
    }
    if (orphans.length > 0) {
      lines.push("orphans (parent not in registry):");
      const sorted = orphans.slice().sort((a, b) => a.sessionId.localeCompare(b.sessionId));
      for (const o of sorted) {
        if (seen.has(o.sessionId)) continue;
        seen.add(o.sessionId);
        lines.push(
          `  ${roleOf(o)} ${o.sessionId} | ${o.daemonId} | ${o.directory} | ${labelOf(o)} | parent=${parentOf(o)}`,
        );
      }
    }
    return lines.join("\n");
  } catch (err) {
    return `fleet_tree failed: ${toReadableError(err)}`;
  }
}

export async function fleetClaimCommanderHandler(
  args: any,
  context: any,
  deps?: FleetToolDeps,
): Promise<string> {
  void deps;
  try {
    const raw = typeof args?.sessionId === "string" ? args.sessionId.trim() : "";
    const id = raw !== "" ? raw : selfIdOf(context);
    if (id === "") return "fleet_claim_commander failed: sessionId must be a non-empty string";
    const role = await claimCommander(id);
    try {
      await deps?.client?.app?.log?.({
        body: { service: "fleet-v1", level: "info", message: `claimed commander ${id}` },
      });
    } catch {
      // best-effort
    }
    return `claimed commander ${id} (role=${role})`;
  } catch (err) {
    return `fleet_claim_commander failed: ${toReadableError(err)}`;
  }
}

export async function fleetReleaseCommanderHandler(
  args: any,
  context: any,
  deps?: FleetToolDeps,
): Promise<string> {
  void deps;
  try {
    const raw = typeof args?.sessionId === "string" ? args.sessionId.trim() : "";
    const id = raw !== "" ? raw : selfIdOf(context);
    if (id === "") return "fleet_release_commander failed: sessionId must be a non-empty string";
    const role = await releaseCommander(id);
    try {
      await deps?.client?.app?.log?.({
        body: { service: "fleet-v1", level: "info", message: `released commander ${id}` },
      });
    } catch {
      // best-effort
    }
    return `released commander ${id} (role=${role})`;
  } catch (err) {
    return `fleet_release_commander failed: ${toReadableError(err)}`;
  }
}

export async function fleetTreeHandler(
  args: any,
  context: any,
  deps?: FleetToolDeps,
): Promise<string> {
  void args;
  void deps;
  try {
    const selfId = selfIdOf(context);
    const entries = await listRegistry({ includeSelf: true });
    return renderTree(entries, selfId);
  } catch (err) {
    return `fleet_tree failed: ${toReadableError(err)}`;
  }
}

export function makeFleetClaimCommanderTool(deps?: FleetToolDeps) {
  return tool({
    description:
      "Claim commander role for a session (defaults to self): adds to the auth allowlist + stamps the registry role.",
    args: {
      sessionId: tool.schema
        .string()
        .optional()
        .describe("Session id to promote (defaults to the calling session)"),
    },
    execute: async (args, context) => fleetClaimCommanderHandler(args, context, deps),
  });
}

export function makeFleetReleaseCommanderTool(deps?: FleetToolDeps) {
  return tool({
    description:
      "Release commander role for a session (defaults to self): removes from the auth allowlist + stamps the registry role back to peer.",
    args: {
      sessionId: tool.schema
        .string()
        .optional()
        .describe("Session id to demote (defaults to the calling session)"),
    },
    execute: async (args, context) => fleetReleaseCommanderHandler(args, context, deps),
  });
}

export function makeFleetTreeTool(deps?: FleetToolDeps) {
  return tool({
    description:
      "Show the fleet hierarchy grouped by parentID: commanders at top with workers/forks nested, orphans last.",
    args: {},
    execute: async (args, context) => fleetTreeHandler(args, context, deps),
  });
}

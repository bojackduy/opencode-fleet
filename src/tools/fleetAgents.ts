/**
 * fleetAgents.ts — Phase 3 bonus `fleet_agents` + `fleet_models` tools.
 *
 * Wraps the SDK's agent/model listings when available; otherwise returns a
 * hint to check the TUI `/agent` and `/model` pickers. Never throws.
 */

import { tool } from "@opencode-ai/plugin";

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

function nameOf(entry: any): string {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object") {
    const cand = entry.name ?? entry.id ?? entry.title;
    if (typeof cand === "string" && cand !== "") return cand;
  }
  try {
    return JSON.stringify(entry);
  } catch {
    return String(entry);
  }
}

export async function fleetAgentsHandler(
  _args: any,
  _context: any,
  deps?: FleetToolDeps,
): Promise<string> {
  void _args;
  void _context;
  try {
    const list = await deps?.client?.app?.agents?.();
    if (Array.isArray(list) && list.length > 0) {
      return `agents:\n${list.map(nameOf).join("\n")}`;
    }
    return "agent list unavailable from SDK — check TUI /agent to see available agents";
  } catch (err) {
    return `fleet_agents failed: ${toReadableError(err)}`;
  }
}

export async function fleetModelsHandler(
  _args: any,
  _context: any,
  deps?: FleetToolDeps,
): Promise<string> {
  void _args;
  void _context;
  try {
    const providers = await deps?.client?.config?.providers?.();
    const names: string[] = [];
    if (Array.isArray(providers)) {
      for (const p of providers) names.push(nameOf(p));
    } else if (providers && typeof providers === "object") {
      for (const [id, p] of Object.entries(providers)) {
        const models = (p as any)?.models;
        if (Array.isArray(models) && models.length > 0) {
          for (const m of models) names.push(`${id}/${nameOf(m)}`);
        } else {
          names.push(id);
        }
      }
    }
    if (names.length > 0) return `models:\n${names.join("\n")}`;
    return "model list unavailable from SDK — check TUI /model to see available models";
  } catch (err) {
    return `fleet_models failed: ${toReadableError(err)}`;
  }
}

export function makeFleetAgentsTool(deps?: FleetToolDeps) {
  return tool({
    description: "List agents available to fleet workers (falls back to a TUI hint).",
    args: {},
    execute: async (args, context) => fleetAgentsHandler(args, context, deps),
  });
}

export function makeFleetModelsTool(deps?: FleetToolDeps) {
  return tool({
    description: "List models available to fleet workers (falls back to a TUI hint).",
    args: {},
    execute: async (args, context) => fleetModelsHandler(args, context, deps),
  });
}

/**
 * fleetRoles.ts — P5 `fleet_claim_commander` / `fleet_release_commander` /
 * `fleet_tree` tools.
 *
 * Claim/release mutate the auth.json commander allowlist (+ stamp the
 * registry role) via roles.ts. Tree renders the parentID hierarchy:
 * commanders at top, their workers/forks nested, orphans last.
 * All tools are runtime-agnostic ToolDefs and never throw — failures render as readable text.
 */

import { depsOf, z } from "../toolDef.js";
import type { ToolDef } from "../toolDef.js";
import type { Runtime } from "../runtime.js";
import { listRegistry, fleetKeyOf, runtimeOf } from "../registry.js";
import type { RegistryEntry } from "../registry.js";
import { claimCommander, releaseCommander, roleOf } from "../roles.js";
import { scopedRegistryEntries } from "../ownershipControl.js";

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
    const lines: string[] = ["role sessionId | runtime | daemonId | directory | summary"];
    const seen = new Set<string>();
    const emit = (e: RegistryEntry, depth: number): void => {
      if (seen.has(e.sessionId)) return;
      seen.add(e.sessionId);
      const pad = "  ".repeat(Math.min(depth, 8));
      const self = selfId !== undefined && selfId !== "" && e.sessionId === selfId ? " (self)" : "";
      lines.push(
        `${pad}${roleOf(e)} ${e.sessionId}${self} | ${runtimeOf(e)} | ${e.daemonId} | ${e.directory} | ${labelOf(e)}`,
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
          `  ${roleOf(o)} ${o.sessionId} | ${runtimeOf(o)} | ${o.daemonId} | ${o.directory} | ${labelOf(o)} | parent=${parentOf(o)}`,
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
        body: { service: "fleet", level: "info", message: `claimed commander ${id}` },
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
        body: { service: "fleet", level: "info", message: `released commander ${id}` },
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
  try {
    // Phase B2: per-commander scoped by default (owned workers + self);
    // scope:"all" is the explicit global hierarchy. Fail-closed on
    // unknown/non-commander callers and unreadable state. Never throws.
    const scopeAll =
      typeof args?.scope === "string" && args.scope.trim().toLowerCase() === "all";
    const scoped = await scopedRegistryEntries(
      context as any,
      (deps as { rt?: Runtime } | undefined)?.rt,
    );
    if (!scoped.ok) return `fleet_tree failed: ${scoped.error}`;
    const selfId = selfIdOf(context);
    if (scopeAll) {
      const entries = await listRegistry({ includeSelf: true });
      return renderTree(entries, selfId);
    }
    const byKey = new Map(scoped.owned.map((e) => [fleetKeyOf(e), e]));
    // Always orient on self where the row is still live.
    try {
      const all = await listRegistry({ includeSelf: true });
      const self = all.find((e) => fleetKeyOf(e) === scoped.callerKey);
      if (self && !byKey.has(scoped.callerKey)) byKey.set(scoped.callerKey, self);
    } catch {
      // self-orientation is best-effort; owned rows still render.
    }
    return renderTree([...byKey.values()], selfId);
  } catch (err) {
    return `fleet_tree failed: ${toReadableError(err)}`;
  }
}

export const fleetClaimCommanderDef: ToolDef = {
  name: "fleet_claim_commander",
  description:
    "Claim commander role for a session (defaults to self): adds to the auth allowlist + stamps the registry role.",
  args: {
    sessionId: z
      .string()
      .optional()
      .describe("Session id to promote (defaults to the calling session)"),
  },
  run: (args, callCtx, rt) => fleetClaimCommanderHandler(args, callCtx, depsOf(rt)),
};

export const fleetReleaseCommanderDef: ToolDef = {
  name: "fleet_release_commander",
  description:
    "Release commander role for a session (defaults to self): removes from the auth allowlist + stamps the registry role back to peer.",
  args: {
    sessionId: z
      .string()
      .optional()
      .describe("Session id to demote (defaults to the calling session)"),
  },
  run: (args, callCtx, rt) => fleetReleaseCommanderHandler(args, callCtx, depsOf(rt)),
};

export const fleetTreeDef: ToolDef = {
  name: "fleet_tree",
  description:
    "Show your fleet hierarchy grouped by parentID (per-commander scoped: owned workers + self; pass scope:\"all\" for the explicit global hierarchy).",
  args: {
    scope: z
      .string()
      .optional()
      .describe('Row scope: default is your owned workers + self; "all" for the explicit global hierarchy'),
  },
  run: (args, callCtx, rt) => fleetTreeHandler(args, callCtx, depsOf(rt)),
};

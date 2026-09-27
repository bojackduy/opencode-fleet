/**
 * fleetAssign.ts — Phase A exclusive-ownership tools: `fleet_assign`,
 * `fleet_unassign`, `fleet_transfer`, `fleet_my_workers`, `fleet_unassigned`.
 *
 * Exactly ONE controlling commander per worker (see ../assignments.ts).
 * Caller identity ALWAYS comes from the tool context sessionID plus the
 * runtime/daemonId — never from explicit args (no spoofed callers, no
 * phantom commanders from args: transfer targets must exist in the
 * registry and be commander-authorized). All handlers never throw:
 * failures render as readable text, and unreadable assignment/auth/
 * registry state fails CLOSED via the core result codes.
 *
 * Next-phase types are re-exported below for adapters + fleet_watch.
 */

import { depsOf, z } from "../toolDef.js";
import type { ToolDef } from "../toolDef.js";
import type { CallCtx, Runtime } from "../runtime.js";
import { fleetKeyOf, runtimeOf } from "../registry.js";
import { getDaemonId } from "../inbox.js";
import { withV1Marker } from "../v1.js";
import { roleOf } from "../roles.js";
import {
  assignWorker,
  listAssignedWorkers,
  listUnassignedWorkers,
  transferWorker,
  unassignAllOwned,
  unassignWorker,
} from "../assignments.js";
import type { FleetIdentity, FleetRuntime, SessionSelector } from "../assignments.js";

// Next-phase surface: ownership selectors/keys + the journal event shape.
export type {
  AssignResult,
  Assignment,
  AssignmentLookup,
  AssignmentsFile,
  AssignmentsRead,
  FleetIdentity,
  OwnedWorker,
  SessionSelector,
  TransferResult,
  UnassignAllResult,
  UnassignResult,
} from "../assignments.js";
export type { AssignmentCursor, AssignmentEvent, AssignmentEventType } from "../notify.js";

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

/**
 * Caller identity from the tool context (sessionID) + runtime/daemonId.
 * v1 daemonIds carry the `:v1` marker exactly like registerSelf, so the
 * composite key matches the stored registry row. Never throws.
 */
export function callerIdentity(callCtx: CallCtx, rt?: Runtime): FleetIdentity {
  try {
    const runtime: FleetRuntime = rt?.kind === "v2" ? "v2" : "v1";
    const ctx = callCtx as unknown as Record<string, unknown>;
    const sessionId = String(
      (callCtx as { sessionID?: unknown })?.sessionID ??
        ctx["sessionId"] ??
        ctx["sessionID"] ??
        "",
    ).trim();
    let daemonId = "";
    if (runtime === "v2") {
      daemonId = String(rt?.daemonId ?? "").trim();
    } else {
      const su = rt?.serverUrl ?? ctx["serverUrl"] ?? "";
      daemonId = withV1Marker(getDaemonId(String(su ?? "")));
    }
    return { runtime, daemonId, sessionId };
  } catch {
    return { runtime: "v1", daemonId: "", sessionId: "" };
  }
}

function normalizeRuntimeFlag(raw: unknown): FleetRuntime | undefined | { error: string } {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (raw === "v1" || raw === "v2") return raw;
  return { error: `runtime must be v1|v2 (got ${String(raw)})` };
}

function workerSelectorOf(args: {
  workerSessionId?: unknown;
  workerRuntime?: unknown;
  workerDaemonId?: unknown;
}): SessionSelector | { error: string } {
  const sessionId = typeof args?.workerSessionId === "string" ? args.workerSessionId.trim() : "";
  if (sessionId === "") return { error: "workerSessionId must be a non-empty string" };
  const rt = normalizeRuntimeFlag(args?.workerRuntime);
  if (typeof rt === "object") return rt;
  const daemonRaw = typeof args?.workerDaemonId === "string" ? args.workerDaemonId.trim() : "";
  const sel: SessionSelector = { sessionId };
  if (rt !== undefined) sel.runtime = rt;
  if (daemonRaw !== "") sel.daemonId = daemonRaw;
  return sel;
}

function commanderSelectorOf(args: {
  toCommanderSessionId?: unknown;
  toCommanderRuntime?: unknown;
  toCommanderDaemonId?: unknown;
}): SessionSelector | { error: string } {
  const sessionId =
    typeof args?.toCommanderSessionId === "string" ? args.toCommanderSessionId.trim() : "";
  if (sessionId === "") return { error: "toCommanderSessionId must be a non-empty string" };
  const rt = normalizeRuntimeFlag(args?.toCommanderRuntime);
  if (typeof rt === "object") return rt;
  const daemonRaw =
    typeof args?.toCommanderDaemonId === "string" ? args.toCommanderDaemonId.trim() : "";
  const sel: SessionSelector = { sessionId };
  if (rt !== undefined) sel.runtime = rt;
  if (daemonRaw !== "") sel.daemonId = daemonRaw;
  return sel;
}

function shortOf(key: string): string {
  try {
    const parts = String(key ?? "").split("\u0000");
    return parts[2] ?? key;
  } catch {
    return key;
  }
}

function labelOf(entry: { title?: string; summary?: string }): string {
  try {
    const l = String(entry?.summary ?? entry?.title ?? "").trim();
    return l === "" ? "-" : l;
  } catch {
    return "-";
  }
}

export async function fleetAssignHandler(
  args: unknown,
  context: unknown,
  deps?: FleetToolDeps,
): Promise<string> {
  try {
    const a = (args ?? {}) as Record<string, unknown>;
    const sel = workerSelectorOf({
      workerSessionId: a["workerSessionId"],
      workerRuntime: a["workerRuntime"],
      workerDaemonId: a["workerDaemonId"],
    });
    if ("error" in sel) return `fleet_assign failed: ${sel.error}`;
    const caller = callerIdentity(context as CallCtx, deps?.rt);
    if (caller.sessionId === "") {
      return "fleet_assign failed: could not determine current session id";
    }
    const r = await assignWorker(sel, caller);
    if (r.ok) {
      return `assigned ${sel.sessionId} to ${caller.sessionId} (generation ${r.assignment.generation})`;
    }
    return `fleet_assign failed: ${r.error}`;
  } catch (err) {
    return `fleet_assign failed: ${toReadableError(err)}`;
  }
}

export async function fleetUnassignHandler(
  args: unknown,
  context: unknown,
  deps?: FleetToolDeps,
): Promise<string> {
  try {
    const a = (args ?? {}) as Record<string, unknown>;
    const caller = callerIdentity(context as CallCtx, deps?.rt);
    if (caller.sessionId === "") {
      return "fleet_unassign failed: could not determine current session id";
    }
    const rawSid = typeof a["workerSessionId"] === "string" ? a["workerSessionId"].trim() : "";
    if (rawSid === "") {
      const r = await unassignAllOwned(caller);
      if (!r.ok) return `fleet_unassign failed: ${r.error}`;
      if (r.count === 0) return `no workers assigned to ${caller.sessionId}`;
      return `released ${r.count} worker(s) from ${caller.sessionId} (generation ${r.generation})`;
    }
    const sel = workerSelectorOf({
      workerSessionId: a["workerSessionId"],
      workerRuntime: a["workerRuntime"],
      workerDaemonId: a["workerDaemonId"],
    });
    if ("error" in sel) return `fleet_unassign failed: ${sel.error}`;
    const r = await unassignWorker(sel, caller);
    if (r.ok) {
      return `released ${sel.sessionId} from ${caller.sessionId} (generation ${r.generation})`;
    }
    return `fleet_unassign failed: ${r.error}`;
  } catch (err) {
    return `fleet_unassign failed: ${toReadableError(err)}`;
  }
}

export async function fleetTransferHandler(
  args: unknown,
  context: unknown,
  deps?: FleetToolDeps,
): Promise<string> {
  try {
    const a = (args ?? {}) as Record<string, unknown>;
    const sel = workerSelectorOf({
      workerSessionId: a["workerSessionId"],
      workerRuntime: a["workerRuntime"],
      workerDaemonId: a["workerDaemonId"],
    });
    if ("error" in sel) return `fleet_transfer failed: ${sel.error}`;
    const target = commanderSelectorOf({
      toCommanderSessionId: a["toCommanderSessionId"],
      toCommanderRuntime: a["toCommanderRuntime"],
      toCommanderDaemonId: a["toCommanderDaemonId"],
    });
    if ("error" in target) return `fleet_transfer failed: ${target.error}`;
    const caller = callerIdentity(context as CallCtx, deps?.rt);
    if (caller.sessionId === "") {
      return "fleet_transfer failed: could not determine current session id";
    }
    const r = await transferWorker(sel, target, caller);
    if (r.ok) {
      return `transferred ${sel.sessionId} from ${caller.sessionId} to ${target.sessionId} (generation ${r.assignment.generation})`;
    }
    return `fleet_transfer failed: ${r.error}`;
  } catch (err) {
    return `fleet_transfer failed: ${toReadableError(err)}`;
  }
}

export async function fleetMyWorkersHandler(
  args: unknown,
  context: unknown,
  deps?: FleetToolDeps,
): Promise<string> {
  void args;
  try {
    const caller = callerIdentity(context as CallCtx, deps?.rt);
    if (caller.sessionId === "") {
      return "fleet_my_workers failed: could not determine current session id";
    }
    const r = await listAssignedWorkers(fleetKeyOf(caller));
    if (!r.ok) return `fleet_my_workers failed: ${r.error}`;
    if (r.owned.length === 0 && r.stale.length === 0) {
      return `no workers assigned to ${caller.sessionId}`;
    }
    const lines = [`workers of ${caller.sessionId} (generation ${r.generation}):`];
    for (const w of r.owned) {
      lines.push(
        `${w.entry.sessionId} | ${runtimeOf(w.entry)} | ${w.entry.daemonId} | ${w.entry.directory} | ${labelOf(w.entry)} | gen ${w.assignment.generation}`,
      );
    }
    if (r.stale.length > 0) {
      lines.push("stale assignments (worker row gone):");
      for (const a of r.stale) lines.push(`  ${shortOf(a.workerKey)} | gen ${a.generation}`);
    }
    return lines.join("\n");
  } catch (err) {
    return `fleet_my_workers failed: ${toReadableError(err)}`;
  }
}

export async function fleetUnassignedHandler(
  args: unknown,
  context: unknown,
  deps?: FleetToolDeps,
): Promise<string> {
  void args;
  void context;
  void deps;
  try {
    const r = await listUnassignedWorkers();
    if (!r.ok) return `fleet_unassigned failed: ${r.error}`;
    if (r.workers.length === 0) return "no unassigned workers";
    const lines = [`unassigned workers (generation ${r.generation}):`];
    for (const e of r.workers) {
      lines.push(
        `${e.sessionId} | ${runtimeOf(e)} | ${e.daemonId} | ${e.directory} | ${roleOf(e)} | ${labelOf(e)}`,
      );
    }
    return lines.join("\n");
  } catch (err) {
    return `fleet_unassigned failed: ${toReadableError(err)}`;
  }
}

export const fleetAssignDef: ToolDef = {
  name: "fleet_assign",
  description:
    "Assign an unassigned fleet worker to yourself (exclusive ownership: exactly one commander per worker). Fails when the worker is owned by another commander.",
  args: {
    workerSessionId: z.string().describe("Worker session id to assign to yourself"),
    workerRuntime: z
      .string()
      .optional()
      .describe("Disambiguate colliding ids: v1|v2 (required with workerDaemonId)"),
    workerDaemonId: z
      .string()
      .optional()
      .describe("Disambiguate colliding ids: owning daemon id (required with workerRuntime)"),
  },
  run: (args, callCtx, rt) => fleetAssignHandler(args, callCtx, depsOf(rt)),
};

export const fleetUnassignDef: ToolDef = {
  name: "fleet_unassign",
  description:
    "Release a worker you own (or all your workers when workerSessionId is omitted). Only the owning commander can release.",
  args: {
    workerSessionId: z
      .string()
      .optional()
      .describe("Worker session id to release (omit to release all your workers)"),
    workerRuntime: z
      .string()
      .optional()
      .describe("Disambiguate colliding ids: v1|v2 (required with workerDaemonId)"),
    workerDaemonId: z
      .string()
      .optional()
      .describe("Disambiguate colliding ids: owning daemon id (required with workerRuntime)"),
  },
  run: (args, callCtx, rt) => fleetUnassignHandler(args, callCtx, depsOf(rt)),
};

export const fleetTransferDef: ToolDef = {
  name: "fleet_transfer",
  description:
    "Transfer a worker you own to another eligible commander (must exist in the registry and be commander-authorized).",
  args: {
    workerSessionId: z.string().describe("Worker session id to transfer"),
    toCommanderSessionId: z.string().describe("Target commander session id"),
    workerRuntime: z
      .string()
      .optional()
      .describe("Disambiguate colliding worker ids: v1|v2"),
    workerDaemonId: z
      .string()
      .optional()
      .describe("Disambiguate colliding worker ids: owning daemon id"),
    toCommanderRuntime: z
      .string()
      .optional()
      .describe("Disambiguate colliding commander ids: v1|v2"),
    toCommanderDaemonId: z
      .string()
      .optional()
      .describe("Disambiguate colliding commander ids: owning daemon id"),
  },
  run: (args, callCtx, rt) => fleetTransferHandler(args, callCtx, depsOf(rt)),
};

export const fleetMyWorkersDef: ToolDef = {
  name: "fleet_my_workers",
  description: "List the fleet workers exclusively owned by the calling commander.",
  args: {},
  run: (args, callCtx, rt) => fleetMyWorkersHandler(args, callCtx, depsOf(rt)),
};

export const fleetUnassignedDef: ToolDef = {
  name: "fleet_unassigned",
  description: "List fleet sessions with no owning commander (assignable via fleet_assign).",
  args: {},
  run: (args, callCtx, rt) => fleetUnassignedHandler(args, callCtx, depsOf(rt)),
};

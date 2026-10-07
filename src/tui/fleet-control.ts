/**
 * fleet-control.ts — manual-control client for the fleet TUI dashboard.
 *
 * Every dashboard action maps 1:1 to an existing server tool by calling the
 * same runtime-agnostic core (assignments + tool handlers) the v1/v2
 * adapters use — no duplicated ownership logic, no behavior change to the
 * 28 server tools. The caller identity is synthesized from the owning
 * session (the session that opened the dashboard) plus its registry row,
 * so spoofing is impossible: bare sessionIds that match 0 rows are
 * not-found, 2+ rows are ambiguous (fail-closed, same as the tools).
 *
 * Exec from the dashboard is spool-only: the TUI host has no promptAsync
 * surface, so direct injection would silently fail. The owning daemon's
 * spool watcher serves the request; the result text names the via path.
 *
 * Nothing here throws to callers — failures render as readable text.
 */

import {
  fleetKeyOf,
  runtimeOf,
} from "../core/registry.js";
import type { RegistryEntry } from "../core/registry.js";
import {
  assignWorker,
  freshEntries,
  readAssignments,
  readRegistryStrict,
  transferWorker,
  unassignAllOwned,
  unassignWorker,
} from "../core/assignments.js";
import type {
  Assignment,
  AssignmentsRead,
  FleetIdentity,
  SessionSelector,
  UnassignAllResult,
  UnassignResult,
} from "../core/assignments.js";
import {
  ackAssignmentEvent,
  readAssignmentEvents,
} from "../core/notify.js";
import type {
  AssignmentCursor,
  AssignmentEvent,
} from "../core/notify.js";
import type { CallCtx, Runtime } from "../core/runtime.js";
import {
  fleetClaimCommanderHandler,
  fleetReleaseCommanderHandler,
} from "../core/tools/fleetRoles.js";
import { fleetRecoverCommanderHandler } from "../core/tools/fleetRecover.js";
import { fleetExecHandler } from "../core/tools/fleetExec.js";
import { fleetBroadcastHandler } from "../core/tools/fleetBroadcast.js";

export interface FleetSnapshot {
  /** Caller composite key ("" when unresolved — mutations disabled). */
  callerKey: string;
  caller: FleetIdentity | null;
  /** Fresh registry rows (TTL-filtered, includes self). */
  entries: RegistryEntry[];
  assignments: Record<string, Assignment>;
  generation: number;
  assignmentsStatus: AssignmentsRead["status"];
  events: AssignmentEvent[];
  cursor: AssignmentCursor | null;
  totalUnacked: number;
  eventsStatus: "ok" | "missing" | "corrupt" | "error";
  eventsError?: string;
  /** Fail-closed error when the caller cannot be resolved. */
  error?: string;
}

export type CallerResolution =
  | { ok: true; caller: FleetIdentity; callerKey: string; entry: RegistryEntry; rt: Runtime }
  | { ok: false; error: string };

function noopRuntime(caller: FleetIdentity, serverUrl = ""): Runtime {
  return {
    kind: caller.runtime,
    daemonId: caller.daemonId,
    ...(serverUrl !== "" ? { serverUrl } : {}),
    selfEndpoint: () => ({ kind: "v2-standalone", url: "" }),
    promptLocal: async () => {
      throw new Error("fleet dashboard: no local prompt surface (spool-only)");
    },
    sessionInfo: async () => null,
    log: () => undefined,
  };
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
 * Resolve the dashboard owner's caller identity from its session id.
 * Optional runtime/daemonId qualifiers disambiguate colliding ses_ ids
 * across v1/v2 (same rule as the server tools). Never throws.
 */
export async function resolveDashboardCaller(
  ownerSessionID: string | undefined,
  qualifier?: { runtime?: "v1" | "v2"; daemonId?: string },
): Promise<CallerResolution> {
  try {
    const sid = String(ownerSessionID ?? "").trim();
    if (sid === "") {
      return { ok: false, error: "no owning session (open the dashboard from a session view) — mutations disabled" };
    }
    const reg = await readRegistryStrict();
    if (reg.status === "corrupt" || reg.status === "error") {
      return { ok: false, error: `registry state unreadable (${reg.error ?? reg.status}); refusing (fail-closed)` };
    }
    const fresh = freshEntries(reg.entries);
    let cands = fresh.filter((e) => e.sessionId === sid);
    if (qualifier?.runtime !== undefined) {
      if (qualifier.runtime !== "v1" && qualifier.runtime !== "v2") {
        return { ok: false, error: `runtime must be v1|v2 (got ${String(qualifier.runtime)})` };
      }
      const rt = qualifier.runtime;
      cands = cands.filter((e: RegistryEntry) => runtimeOf(e) === rt);
    }
    if (qualifier?.daemonId !== undefined && qualifier.daemonId !== "") {
      cands = cands.filter((e) => e.daemonId === qualifier.daemonId);
    }
    if (cands.length === 0) {
      return { ok: false, error: `${sid} not in registry (register with fleet_register first) — mutations disabled` };
    }
    if (cands.length > 1) {
      return {
        ok: false,
        error: `${sid} matches ${cands.length} sessions; specify runtime + daemonId (fail-closed) — mutations disabled`,
      };
    }
    const entry = cands[0] as RegistryEntry;
    const caller: FleetIdentity = {
      runtime: runtimeOf(entry),
      daemonId: entry.daemonId,
      sessionId: entry.sessionId,
    };
    // v1 callerIdentity derives the daemon id from rt.serverUrl, so replay
    // the row's endpoint url (the original daemon serverUrl). v2 reads
    // rt.daemonId directly. Missing endpoints fail closed downstream.
    const serverUrl = caller.runtime === "v1" ? String(entry.endpoint?.url ?? "") : "";
    return { ok: true, caller, callerKey: fleetKeyOf(entry), entry, rt: noopRuntime(caller, serverUrl) };
  } catch (err) {
    return { ok: false, error: `caller resolution failed (${toReadableError(err)}); refusing (fail-closed)` };
  }
}

function callCtxFor(sessionId: string): CallCtx {
  return { sessionID: sessionId };
}

function workerSelectorOf(sessionId: string): SessionSelector | { error: string } {
  const sid = String(sessionId ?? "").trim();
  if (sid === "") return { error: "worker session id must be a non-empty string" };
  return { sessionId: sid };
}

export interface FleetControlOpts {
  ownerSessionID: string | undefined;
  qualifier?: { runtime?: "v1" | "v2"; daemonId?: string };
  eventsLimit?: number;
}

/**
 * Owner-scoped control surface. Construct per dashboard open (owner = the
 * calling session). All methods return readable text, never throw.
 */
export class FleetControl {
  private readonly ownerSessionID: string | undefined;
  private readonly qualifier: { runtime?: "v1" | "v2"; daemonId?: string } | undefined;
  private readonly eventsLimit: number;

  constructor(opts: FleetControlOpts) {
    this.ownerSessionID = opts.ownerSessionID;
    this.qualifier = opts.qualifier;
    const lim = opts.eventsLimit;
    this.eventsLimit = typeof lim === "number" && Number.isFinite(lim)
      ? Math.min(Math.max(Math.floor(lim), 1), 100)
      : 50;
  }

  get owner(): string | undefined {
    return this.ownerSessionID;
  }

  /** Full snapshot for one dashboard refresh (registry + assignments + journal). */
  async refresh(): Promise<FleetSnapshot> {
    try {
      const res = await resolveDashboardCaller(this.ownerSessionID, this.qualifier);
      const [reg, asg] = await Promise.all([readRegistryStrict(), readAssignments()]);
      const entries = reg.status === "ok" || reg.status === "missing" ? freshEntries(reg.entries) : [];
      const assignments = asg.status === "ok" || asg.status === "missing" ? asg.state.assignments : {};
      const generation = asg.status === "ok" || asg.status === "missing" ? asg.state.generation : 0;
      if (!res.ok) {
        return {
          callerKey: "",
          caller: null,
          entries,
          assignments,
          generation,
          assignmentsStatus: asg.status,
          events: [],
          cursor: null,
          totalUnacked: 0,
          eventsStatus: "error",
          eventsError: "caller unresolved; journal unread (fail-closed)",
          error: res.error,
        };
      }
      const journal = await readAssignmentEvents(res.callerKey, this.eventsLimit);
      return {
        callerKey: res.callerKey,
        caller: res.caller,
        entries,
        assignments,
        generation,
        assignmentsStatus: asg.status,
        events: journal.events,
        cursor: journal.cursor,
        totalUnacked: journal.total,
        eventsStatus: journal.status,
        ...(journal.error !== undefined ? { eventsError: journal.error } : {}),
        ...(asg.status === "corrupt" || asg.status === "error"
          ? { error: `assignment state unreadable (${asg.error ?? asg.status}); refusing (fail-closed)` }
          : {}),
      };
    } catch (err) {
      return {
        callerKey: "",
        caller: null,
        entries: [],
        assignments: {},
        generation: 0,
        assignmentsStatus: "error",
        events: [],
        cursor: null,
        totalUnacked: 0,
        eventsStatus: "error",
        eventsError: "snapshot failed; refusing (fail-closed)",
        error: toReadableError(err),
      };
    }
  }

  private async withCaller<T>(fn: (caller: FleetIdentity, rt: Runtime) => Promise<T>): Promise<T | { error: string }> {
    try {
      const res = await resolveDashboardCaller(this.ownerSessionID, this.qualifier);
      if (!res.ok) return { error: res.error };
      return await fn(res.caller, res.rt);
    } catch (err) {
      return { error: toReadableError(err) };
    }
  }

  /** fleet_assign — claim an unassigned worker for yourself. */
  async assign(workerSessionId: string): Promise<string> {
    try {
      const sel = workerSelectorOf(workerSessionId);
      if ("error" in sel) return `fleet_assign failed: ${sel.error}`;
      const out = await this.withCaller((caller) => assignWorker(sel, caller));
      if (out !== null && typeof out === "object" && "error" in (out as Record<string, unknown>) && !("ok" in (out as Record<string, unknown>))) {
        return `fleet_assign failed: ${(out as { error: string }).error}`;
      }
      const r = out as Awaited<ReturnType<typeof assignWorker>>;
      return r.ok
        ? `assigned ${sel.sessionId} (generation ${r.assignment.generation})`
        : `fleet_assign failed: ${r.error}`;
    } catch (err) {
      return `fleet_assign failed: ${toReadableError(err)}`;
    }
  }

  /** fleet_unassign — release one worker (or all yours when omitted). */
  async unassign(workerSessionId?: string): Promise<string> {
    try {
      const raw = String(workerSessionId ?? "").trim();
      const out = await this.withCaller(
        (caller): Promise<UnassignResult | UnassignAllResult> =>
          raw === "" ? unassignAllOwned(caller) : unassignWorker({ sessionId: raw }, caller),
      );
      if (out !== null && typeof out === "object" && "error" in (out as Record<string, unknown>) && !("ok" in (out as Record<string, unknown>))) {
        return `fleet_unassign failed: ${(out as { error: string }).error}`;
      }
      const r = out as Awaited<ReturnType<typeof unassignWorker>> | Awaited<ReturnType<typeof unassignAllOwned>>;
      if (!r.ok) return `fleet_unassign failed: ${(r as { error: string }).error}`;
      if ("released" in r && !("count" in r)) {
        return `released ${raw} (generation ${(r as { generation: number }).generation})`;
      }
      const all = r as { ok: true; count: number; generation: number };
      return all.count === 0 ? "no workers assigned to you" : `released ${all.count} worker(s) (generation ${all.generation})`;
    } catch (err) {
      return `fleet_unassign failed: ${toReadableError(err)}`;
    }
  }

  /** fleet_transfer — move a worker you own to another commander. */
  async transfer(workerSessionId: string, toCommanderSessionId: string): Promise<string> {
    try {
      const sel = workerSelectorOf(workerSessionId);
      if ("error" in sel) return `fleet_transfer failed: ${sel.error}`;
      const target = String(toCommanderSessionId ?? "").trim();
      if (target === "") return "fleet_transfer failed: target commander session id must be a non-empty string";
      const out = await this.withCaller((caller) =>
        transferWorker(sel, { sessionId: target }, caller),
      );
      if (out !== null && typeof out === "object" && "error" in (out as Record<string, unknown>) && !("ok" in (out as Record<string, unknown>))) {
        return `fleet_transfer failed: ${(out as { error: string }).error}`;
      }
      const r = out as Awaited<ReturnType<typeof transferWorker>>;
      return r.ok
        ? `transferred ${sel.sessionId} to ${target} (generation ${r.assignment.generation})`
        : `fleet_transfer failed: ${r.error}`;
    } catch (err) {
      return `fleet_transfer failed: ${toReadableError(err)}`;
    }
  }

  /** fleet_claim_commander — claim commander role (defaults to self). */
  async claim(sessionId?: string): Promise<string> {
    try {
      const owner = String(this.ownerSessionID ?? "").trim();
      const out = await this.withCaller((caller) =>
        fleetClaimCommanderHandler(
          { sessionId: String(sessionId ?? "").trim() || caller.sessionId },
          callCtxFor(owner),
        ),
      );
      if (out !== null && typeof out === "object") return `fleet_claim_commander failed: ${(out as { error: string }).error}`;
      return out as string;
    } catch (err) {
      return `fleet_claim_commander failed: ${toReadableError(err)}`;
    }
  }

  /** fleet_release_commander — release commander role (defaults to self). */
  async release(sessionId?: string): Promise<string> {
    try {
      const owner = String(this.ownerSessionID ?? "").trim();
      const out = await this.withCaller((caller) =>
        fleetReleaseCommanderHandler(
          { sessionId: String(sessionId ?? "").trim() || caller.sessionId },
          callCtxFor(owner),
        ),
      );
      if (out !== null && typeof out === "object") return `fleet_release_commander failed: ${(out as { error: string }).error}`;
      return out as string;
    } catch (err) {
      return `fleet_release_commander failed: ${toReadableError(err)}`;
    }
  }

  /** fleet_recover_commander — migrate ownership from a dead daemon id. */
  async recover(oldDaemonId: string): Promise<string> {
    try {
      const owner = String(this.ownerSessionID ?? "").trim();
      const out = await this.withCaller((caller, rt) =>
        fleetRecoverCommanderHandler({ oldDaemonId }, callCtxFor(owner || caller.sessionId), { rt }),
      );
      if (out !== null && typeof out === "object") return `fleet_recover_commander failed: ${(out as { error: string }).error}`;
      return out as string;
    } catch (err) {
      return `fleet_recover_commander failed: ${toReadableError(err)}`;
    }
  }

  /** fleet_exec (spool-only from the dashboard — no local prompt surface). */
  async exec(workerSessionId: string, message: string, timeoutMs = 60_000): Promise<string> {
    try {
      const owner = String(this.ownerSessionID ?? "").trim();
      const out = await this.withCaller((caller, rt) =>
        fleetExecHandler(
          { sessionId: workerSessionId, message, mode: "spool", timeoutMs },
          { ...callCtxFor(owner || caller.sessionId) },
          { rt },
        ),
      );
      if (out !== null && typeof out === "object") return `fleet_exec failed: ${(out as { error: string }).error}`;
      return out as string;
    } catch (err) {
      return `fleet_exec failed: ${toReadableError(err)}`;
    }
  }

  /** fleet_broadcast — fan out to all workers you own (confirm-gated by the view). */
  async broadcast(message: string, timeoutMs = 60_000): Promise<string> {
    try {
      const owner = String(this.ownerSessionID ?? "").trim();
      const out = await this.withCaller((caller, rt) =>
        fleetBroadcastHandler(
          { message, mode: "spool", timeoutMs },
          { ...callCtxFor(owner || caller.sessionId) },
          { client: undefined, serverUrl: "", rt },
        ),
      );
      if (out !== null && typeof out === "object") return `fleet_broadcast failed: ${(out as { error: string }).error}`;
      return out as string;
    } catch (err) {
      return `fleet_broadcast failed: ${toReadableError(err)}`;
    }
  }

  /** fleet_watch (single non-blocking read of your unacked journal events). */
  async watch(limit = 20): Promise<string> {
    try {
      const res = await resolveDashboardCaller(this.ownerSessionID, this.qualifier);
      if (!res.ok) return `fleet_watch failed: ${res.error}`;
      const lim = Math.min(Math.max(Math.floor(limit) || 20, 1), 100);
      const read = await readAssignmentEvents(res.callerKey, lim);
      if (read.status === "corrupt" || read.status === "error") {
        return `fleet_watch failed: ${read.error ?? "assignment event journal unreadable"}; refusing (fail-closed)`;
      }
      if (read.events.length === 0) return "no new fleet events (ack required to advance: fleet_ack <eventId>)";
      const lines = read.events.map((e) => {
        const worker = String(e.workerKey).split(" ")[2] ?? e.workerKey;
        const data = String(e.data ?? "");
        return `${e.id} | ${e.type} ${worker} gen ${e.generation}${data !== "" ? ` ${data}` : ""}`;
      });
      lines.push(`ack required: fleet_ack <eventId> (total unacked: ${read.total})`);
      return lines.join("\n");
    } catch (err) {
      return `fleet_watch failed: ${toReadableError(err)}`;
    }
  }

  /** fleet_ack — acknowledge one journal event by id. */
  async ack(eventId: string): Promise<string> {
    try {
      const id = String(eventId ?? "").trim();
      if (id === "") return "fleet_ack failed: eventId must be a non-empty string";
      const res = await resolveDashboardCaller(this.ownerSessionID, this.qualifier);
      if (!res.ok) return `fleet_ack failed: ${res.error}`;
      const ok = await ackAssignmentEvent(res.callerKey, id);
      return ok ? `acked ${id}` : `fleet_ack failed: unknown event id ${id}`;
    } catch (err) {
      return `fleet_ack failed: ${toReadableError(err)}`;
    }
  }
}

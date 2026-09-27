/**
 * fleetRecover.ts — explicit operator recovery tool `fleet_recover_commander`.
 *
 * Operator-initiated remedy after a daemon restart when the old pid is no
 * longer current and the safe automatic migration refuses (process changed).
 * Caller identity ALWAYS comes from the tool context sessionID + runtime/
 * daemonId (never from explicit args — no spoofed callers); the only arg is
 * the dead oldDaemonId. Requires the SAME sessionId as the old owner.
 * Never throws: failures render as readable text, fail-closed.
 */

import { depsOf, z } from "../toolDef.js";
import type { ToolDef } from "../toolDef.js";
import type { CallCtx, Runtime } from "../runtime.js";
import { callerIdentity } from "./fleetAssign.js";
import { parsePidPort } from "../daemonIdentity.js";
import { isPidAlive, recoverCommander } from "../commanderRecovery.js";

function toReadableError(err: unknown): string {
  if (err instanceof Error) return err.message || String(err);
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export async function fleetRecoverCommanderHandler(
  args: unknown,
  context: unknown,
  deps?: { client?: unknown; serverUrl?: string | URL; rt?: Runtime },
): Promise<string> {
  try {
    const a = (args ?? {}) as Record<string, unknown>;
    const oldDaemonId = typeof a["oldDaemonId"] === "string" ? a["oldDaemonId"].trim() : "";
    if (oldDaemonId === "") {
      return "fleet_recover_commander failed: oldDaemonId must be a non-empty string";
    }
    const caller = callerIdentity(context as CallCtx, deps?.rt);
    if (caller.sessionId.trim() === "") {
      return "fleet_recover_commander failed: could not determine current session id";
    }
    if (caller.daemonId.trim() === "") {
      return "fleet_recover_commander failed: could not determine current daemon id";
    }
    const pp = parsePidPort(oldDaemonId);
    if (!pp) {
      return `fleet_recover_commander failed: oldDaemonId pid/port unparseable (${oldDaemonId}); refusing`;
    }
    if (isPidAlive(pp.pid)) {
      return `fleet_recover_commander failed: old daemon process ${pp.pid} still running; refusing (fail-closed, retry after the old daemon exits)`;
    }
    const r = await recoverCommander(caller, oldDaemonId);
    if (!r.ok) return `fleet_recover_commander failed: ${r.error}`;
    const staleNote = r.stale > 0 ? `; ${r.stale} stale worker row(s) (worker gone until re-register)` : "";
    const journalNote = r.journalsMoved > 0 ? `; journals moved ${r.journalsMoved}` : "; journal preserved";
    const originNote = r.originsMoved > 0 ? `; origins updated ${r.originsMoved}` : "";
    return (
      `recovered ${r.recovered} assignment(s) from ${r.oldDaemon} to ${r.newDaemon} ` +
      `for ${r.sessionId} (generation ${r.generation})${staleNote}${journalNote}${originNote}`
    );
  } catch (err) {
    return `fleet_recover_commander failed: ${toReadableError(err)}`;
  }
}

export const fleetRecoverCommanderDef: ToolDef = {
  name: "fleet_recover_commander",
  description:
    "Recover commander ownership after a daemon restart: migrate assignment commanderKeys from a dead oldDaemonId to your current daemon (same sessionId required; old pid must be exited). Worker keys are preserved; generations bump to invalidate stale queued requests.",
  args: {
    oldDaemonId: z.string().describe("Dead old daemon id to recover from (e.g. Mac.lan-81615-4096:v1)"),
  },
  run: (args, callCtx, rt) => fleetRecoverCommanderHandler(args, callCtx, depsOf(rt)),
};

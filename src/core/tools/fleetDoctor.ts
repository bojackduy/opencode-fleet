/**
 * fleetDoctor.ts — `fleet_doctor` onboarding diagnostic (read-only).
 *
 * First-use triage for a commander that cannot see, claim, or reach its
 * workers. Inspects (never mutates):
 *   - caller identity + role (commander / peer / fork / unknown),
 *   - ownership count (owned / stale-owned),
 *   - stranded assignments for the same session (old daemon keys after a
 *     restart — the classic "my workers vanished" cause),
 *   - liveness split of owned targets (live / stale / dead + endpoint
 *     presence for cross-daemon routing),
 *   - policy + state-file health (registry / assignments / auth readable?).
 *
 * Output is a short checklist ending in EXACT next commands
 * (fleet_claim_commander / fleet_assign / fleet_recover_commander /
 * fleet_unassign / fleet_discover / fleet_unassigned). Never throws —
 * unreadable state renders as findings, not exceptions.
 */

import { depsOf, z } from "../toolDef.js";
import type { ToolDef } from "../toolDef.js";
import type { Runtime } from "../runtime.js";
import {
  checkCommander,
  freshEntries,
  readAssignments,
  readAuthStrict,
  readRegistryStrict,
} from "../assignments.js";
import { getPolicy } from "../auth.js";
import { callerIdentity } from "./fleetAssign.js";
import { fleetKeyOf, runtimeOf } from "../registry.js";
import type { RegistryEntry } from "../registry.js";
import { shortSessionOf } from "../ownershipControl.js";
import { ageTextOf, livenessOfEntry, ownerReachabilityOf } from "../liveness.js";
import type { Liveness } from "../liveness.js";

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

function compositeOf(key: string): string {
  try {
    const parts = String(key ?? "").split("\u0000");
    if (parts.length !== 3) return String(key ?? "");
    return `${parts[0]}/${parts[1]}/${parts[2]}`;
  } catch {
    return String(key ?? "");
  }
}

export async function fleetDoctorHandler(
  _args: unknown,
  context: unknown,
  deps?: FleetToolDeps,
): Promise<string> {
  void _args;
  try {
    const rt = deps?.rt;
    const lines: string[] = ["fleet_doctor (read-only; nothing was changed)"];
    const next: string[] = [];

    // ---- 1. caller identity + role ----
    const caller = callerIdentity((context ?? {}) as never, rt);
    const callerKey = fleetKeyOf(caller);
    if (caller.sessionId.trim() === "" || caller.daemonId.trim() === "") {
      lines.push("caller: unknown (could not determine session/daemon identity)");
      lines.push("finding: tool context carries no usable sessionID; commands from this surface cannot own workers.");
      return [...lines, "next: re-run from a real session, then fleet_claim_commander"].join("\n");
    }
    lines.push(`caller: ${caller.runtime}/${caller.daemonId}/${caller.sessionId}`);

    const [reg, auth, asg] = await Promise.all([
      readRegistryStrict(),
      readAuthStrict(),
      readAssignments(),
    ]);
    if (reg.status === "corrupt" || reg.status === "error") {
      lines.push(`finding: registry state unreadable (${reg.error ?? reg.status}) — fail-closed; fix the state file first.`);
      return [...lines, "next: inspect $XDG_STATE_HOME/opencode/fleet/registry.json (restore from backup; never hand-edit while daemons run)"].join("\n");
    }
    if (auth.status === "corrupt" || auth.status === "error") {
      lines.push(`finding: auth state unreadable (${auth.error ?? auth.status}) — fail-closed; fix the state file first.`);
      return [...lines, "next: inspect $XDG_STATE_HOME/opencode/fleet/auth.json (restore from backup; never hand-edit while daemons run)"].join("\n");
    }
    if (asg.status === "corrupt" || asg.status === "error") {
      lines.push(`finding: assignment state unreadable (${asg.error ?? asg.status}) — fail-closed; fix the state file first.`);
      return [...lines, "next: inspect $XDG_STATE_HOME/opencode/fleet/assignments.json (restore from backup; never hand-edit while daemons run)"].join("\n");
    }

    const fresh = freshEntries(reg.entries);
    const ownRow = fresh.find((e) => fleetKeyOf(e) === callerKey);
    const chk = checkCommander(ownRow, auth.commanders);
    if (chk.ok) {
      lines.push(`role: commander (registry row live, updated ${ageTextOf(ownRow?.updatedAt)} ago)`);
    } else if (!ownRow) {
      lines.push(`role: unknown — caller session not in registry (${chk.error})`);
      next.push("fleet_register({ summary: <label> })  — register this session first");
      next.push("fleet_claim_commander  — then claim the commander role");
    } else {
      lines.push(`role: not-commander — ${chk.error}`);
      next.push("fleet_claim_commander  — claim the commander role (or ask the commander to fleet_allow)");
    }

    // ---- 2. ownership (mine vs stranded same-session keys) ----
    const ownedKeys = Object.values(asg.state.assignments)
      .filter((a) => a.commanderKey === callerKey)
      .map((a) => a.workerKey);
    const byKey = new Map(fresh.map((e) => [fleetKeyOf(e), e]));
    let live = 0;
    let stale = 0;
    let dead = 0;
    let staleOwned = 0;
    const deadOwned: string[] = [];
    for (const k of ownedKeys) {
      const row = byKey.get(k);
      if (!row) {
        staleOwned++;
        continue;
      }
      const l: Liveness = livenessOfEntry(row);
      if (l === "live") live++;
      else if (l === "stale") stale++;
      else {
        dead++;
        deadOwned.push(shortSessionOf(k));
      }
    }
    lines.push(`owned: ${ownedKeys.length} live=${live} stale=${stale} dead=${dead} stale-rows=${staleOwned}`);

    // Stranded: assignments whose commander session is MY session but whose
    // composite key is NOT my current key (daemon restart / re-register left
    // the old commander key owning workers).
    const stranded = Object.values(asg.state.assignments).filter(
      (a) =>
        a.commanderKey !== callerKey &&
        shortSessionOf(a.commanderKey) === caller.sessionId,
    );
    if (stranded.length > 0) {
      lines.push(
        `finding: ${stranded.length} stranded assignment(s) under old commander key(s): ` +
          [...new Set(stranded.map((a) => compositeOf(a.commanderKey)))].join(", "),
      );
      next.push("fleet_recover_commander  — migrate the old commander key to this daemon (strict-locked, operator recovery)");
    }

    // ---- 3. owned-target detail: liveness + endpoint + advisory reachability ----
    if (ownedKeys.length > 0) {
      const detail: string[] = [];
      for (const k of ownedKeys) {
        const row: RegistryEntry | undefined = byKey.get(k);
        if (!row) {
          detail.push(`- ${shortSessionOf(k)}: stale assignment (worker row gone)`);
          continue;
        }
        const l = livenessOfEntry(row);
        const age = ageTextOf(row.updatedAt);
        const ep = typeof row.endpoint?.url === "string" && row.endpoint.url.trim() !== ""
          ? `${row.endpoint.kind} ${row.endpoint.url.trim()}`
          : "no-endpoint";
        const reach = ownerReachabilityOf(row);
        detail.push(`- ${row.sessionId} [${runtimeOf(row)}]: ${l} age=${age} endpoint=${ep} owner-proc=${reach}`);
      }
      lines.push("targets:");
      lines.push(...detail);
      const missingEp = ownedKeys.filter((k) => {
        const row = byKey.get(k);
        return !!row && !(typeof row.endpoint?.url === "string" && row.endpoint.url.trim() !== "");
      });
      if (missingEp.length > 0) {
        lines.push(`finding: ${missingEp.length} owned target(s) without an endpoint (cross-daemon routing falls back to spool).`);
        next.push("ask the worker side to re-beat (any fleet call refreshes it) so heartbeatAndRegister stamps {kind:v1-daemon, url}");
      }
      if (staleOwned > 0) {
        next.push("fleet_unassign({ workerSessionId })  — release stale rows, then fleet_assign to re-claim live ones");
      }
      if (dead > 0) {
        lines.push(`finding: ${dead} dead owned target(s) (${deadOwned.slice(0, 5).join(", ")}): owning daemon(s) not beating — sends fail fast.`);
        next.push("restart the owning daemon(s), or fleet_unassign the dead rows and fleet_assign replacements");
      } else if (stale > 0) {
        next.push("stale targets: wait for the next ~60s re-beat, or restart the owning daemon if they stay stale");
      }
    } else if (chk.ok) {
      lines.push("finding: commander with no workers — discover and claim.");
      next.push("fleet_unassigned  — list claimable sessions");
      next.push('fleet_discover({ limit: 15 })  — find live sessions (ownership-annotated)');
      next.push('fleet_assign({ workerSessionId: "<ses_…>" })  — claim one (add workerRuntime+workerDaemonId when ambiguous)');
    }

    // ---- 4. policy + state health ----
    let policy = "commander-only";
    try {
      policy = await getPolicy().catch(() => "commander-only" as never) as string;
    } catch {
      // keep default
    }
    lines.push(`policy: ${policy} | state: registry=${reg.status} assignments=${asg.status} auth=${auth.status} generation=${asg.state.generation}`);
    if (policy === "refuse" || policy === "hold") {
      next.push(`fleet_policy / fleet_allow  — inbound is ${policy}; sends queue or deny until the commander allows`);
    }

    if (next.length > 0) {
      lines.push("next:");
      for (const n of next) lines.push(`- ${n}`);
    } else {
      lines.push("next: none — all live, owned, and reachable. Ship it.");
    }
    return lines.join("\n");
  } catch (err) {
    return `fleet_doctor failed: ${toReadableError(err)}`;
  }
}

export const fleetDoctorDef: ToolDef = {
  name: "fleet_doctor",
  description:
    "Diagnose fleet onboarding/visibility problems (read-only; never mutates): caller role, owned/stale/stranded workers, endpoint + policy health, and the exact next command. Run this first when workers are missing or sends fail.",
  args: {},
  run: (_args, callCtx, rt) => fleetDoctorHandler(_args, callCtx, depsOf(rt)),
};

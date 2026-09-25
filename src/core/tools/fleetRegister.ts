/**
 * fleetRegister.ts — Phase 3 `fleet_register` tool.
 *
 * Registers the calling session as a fleet worker in
 * `fleet-v1/registry.json` via `registerSelf()`.
 *
 * Never throws to the commander — failures are returned as readable text.
 */

import { depsOf, z } from "../toolDef.js";
import type { ToolDef } from "../toolDef.js";
import type { Runtime } from "../runtime.js";
import { getDaemonId } from "../inbox.js";
import { registerSelf } from "../registry.js";
import type { FleetRuntime, RegistryEndpoint } from "../registry.js";
import { parentIdOf } from "../heartbeat.js";
import { resolveRole } from "../roles.js";

/** Plugin-scoped deps captured in `server()` (loose types to satisfy tsc). */
export interface FleetToolDeps {
  // biome-ignore lint/suspicious/noExplicitAny: v1 plugin client is untyped at the boundary.
  client?: any;
  serverUrl?: string | URL;
  rt?: Runtime;
}

function selfIdOf(context: any): string {
  return (context?.sessionID ?? context?.sessionId ?? "") as string;
}

function serverUrlOf(context: any, deps?: FleetToolDeps): string {
  const s = deps?.serverUrl ?? context?.serverUrl ?? "";
  return typeof s === "string" ? s : String(s ?? "");
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

export async function fleetRegisterHandler(
  args: any,
  context: any,
  deps?: FleetToolDeps,
): Promise<string> {
  try {
    const raw = typeof args?.summary === "string" ? args.summary.trim() : "";
    const summary = raw !== "" ? raw : "worker";
    const sessionId = selfIdOf(context);
    if (!sessionId) return "fleet_register failed: could not determine current session id";
    // Part 2: the runtime owns the daemon identity. v2 uses `v2:<service-url>`;
    // v1 keeps getDaemonId(serverUrl) (registerSelf adds the `:v1` marker).
    const rt = deps?.rt;
    const runtime: FleetRuntime = rt?.kind === "v2" ? "v2" : "v1";
    const daemonId = runtime === "v2" && rt ? rt.daemonId : getDaemonId(serverUrlOf(context, deps));
    const ep = runtime === "v2" && rt ? rt.selfEndpoint() : null;
    const endpoint: RegistryEndpoint | undefined =
      ep === null
        ? undefined
        : { kind: ep.kind === "v2-service" ? "v2-service" : "v2-standalone", url: ep.url };
    const directory = String(
      context?.directory ?? context?.worktree ?? ep?.location ?? process.cwd(),
    );
    // P5: parentID from explicit arg, else best-effort session.get (API only).
    let parentID = typeof args?.parentID === "string" ? args.parentID.trim() : "";
    if (parentID === "") {
      try {
        const client = deps?.client as {
          session?: { get?: (args: unknown) => Promise<unknown> };
        } | null;
        if (typeof client?.session?.get === "function") {
          const raw = await client.session.get({ path: { id: sessionId } });
          const data =
            raw !== null && typeof raw === "object" && "data" in (raw as Record<string, unknown>)
              ? (raw as { data: unknown }).data
              : raw;
          parentID = parentIdOf(data);
        }
      } catch {
        // best-effort only
      }
    }
    const role = await resolveRole({ sessionID: sessionId, parentID }).catch(() => "peer" as const);
    const entry = await registerSelf({
      sessionId,
      daemonId,
      directory,
      summary,
      title: summary,
      role,
      runtime,
      ...(endpoint ? { endpoint } : {}),
      ...(runtime === "v2" && ep?.location ? { location: ep.location } : {}),
      ...(parentID !== "" ? { parentID } : {}),
    });
    try {
      await deps?.client?.app?.log?.({
        body: { service: "fleet-v1", level: "info", message: `registered ${sessionId} as ${summary} role=${role}` },
      });
    } catch {
      // Logging is best-effort.
    }
    return `registered ${entry.sessionId} as ${summary} role=${role} in ${entry.directory}`;
  } catch (err) {
    return `fleet_register failed: ${toReadableError(err)}`;
  }
}

export const fleetRegisterDef: ToolDef = {
  name: "fleet_register",
  description:
    "Register the current session as a fleet worker so the commander can list it and delegate tasks to it.",
  args: {
    summary: z.string().describe("Short human-readable label for this worker session"),
    parentID: z
      .string()
      .optional()
      .describe("Parent session id for forks (sets worker role; auto-detected via session.get when omitted)"),
  },
  run: (args, callCtx, rt) => fleetRegisterHandler(args, callCtx, depsOf(rt)),
};

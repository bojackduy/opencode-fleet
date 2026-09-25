/**
 * index.ts — Phase 4 final wiring for fleet-v1.
 *
 * Object-module form (requires @opencode-ai/plugin 1.18.29+):
 *   export default { id: "fleet.v1", server } satisfies PluginModule
 *
 * server() runs once per daemon process (NOT per session), so there is no
 * "current sessionID" here. The inbox watcher is therefore daemon-wide:
 * it scans fleet-v1/messages/*.req.json for envelopes whose targetDaemonId
 * matches this daemon's getDaemonId(serverUrl) and replays each one into
 * envelope.targetSessionId via client.session.promptAsync — as a normal
 * user bubble (never noReply/silent) so manual takeover with
 * revert/fork/continue keeps working.
 */

import type { PluginInput, PluginModule } from "@opencode-ai/plugin";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildInjectText,
  claimedPath,
  getDaemonId,
  INBOX_RESPONSE_TIMEOUT_MS,
  parseFleetModel,
} from "./inbox.js";
import {
  INBOX_POLL_MS,
  hopOf,
  isHopExceeded,
  loopGuardText,
  messagesDir,
  readReq,
  writeRes,
} from "./fileTransport.js";
import { readRegistry, registerSelf, removeSession } from "./registry.js";
import { beat } from "./heartbeat.js";
import { writeNotify } from "./notify.js";
import { makeFleetRegisterTool } from "./tools/fleetRegister.js";
import { makeFleetListTool } from "./tools/fleetList.js";
import { makeFleetBroadcastTool } from "./tools/fleetBroadcast.js";
import { makeFleetStatusTool } from "./tools/fleetStatus.js";
import { makeFleetAgentsTool, makeFleetModelsTool } from "./tools/fleetAgents.js";
import { makeFleetDiscoverTool, makeFleetPsTool } from "./tools/fleetDiscover.js";
import { makeFleetExecTool } from "./tools/fleetExec.js";
import { makeFleetHandoffBackTool, makeFleetThreadTool } from "./tools/fleetHandoff.js";
import {
  makeFleetAllowTool,
  makeFleetBlockTool,
  makeFleetGroupTool,
  makeFleetPolicyTool,
  makeFleetSummaryTool,
} from "./tools/fleetAdmin.js";
import {
  makeFleetClaimCommanderTool,
  makeFleetReleaseCommanderTool,
  makeFleetTreeTool,
} from "./tools/fleetRoles.js";
import { currentVersion, isV1Daemon, isV1Version, V1_BIN, V1_VERSION } from "./v1.js";

const RESPONSE_POLL_MS = 500;

interface DaemonWatcher {
  stop: () => void;
  isRunning: () => boolean;
  daemonId: string;
  serverUrl: string;
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

function doneLineOf(text: string): string | null {
  const re = /^DONE:\s*(.+?)\s*$/gm;
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) last = m[1];
  return last;
}

function assistantTextOf(
  messages: Array<{ info: unknown; parts: unknown[] }>,
  since: number,
): string | null {
  let latest: string | null = null;
  for (const m of messages ?? []) {
    const info = m?.info as { role?: unknown; time?: { created?: unknown } } | null;
    if (!info || info.role !== "assistant") continue;
    const created =
      typeof info?.time?.created === "number" ? (info.time.created as number) : 0;
    if (created < since) continue;
    const texts: string[] = [];
    for (const p of m?.parts ?? []) {
      const part = p as { type?: unknown; text?: unknown } | null;
      if (part && part.type === "text" && typeof part.text === "string") {
        texts.push(part.text);
      }
    }
    if (texts.length > 0) latest = texts.join("\n");
  }
  return latest;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Daemon-wide inbox watcher. Picks up any .req.json addressed to this
 * daemon (targetDaemonId === daemonId, or empty/absent targetDaemonId as a
 * fallback) and replays it into its targetSessionId. Per-request failures
 * are captured into .res.json as {ok:false, error} — never thrown.
 */
function startDaemonWatcher(
  client: PluginInput["client"],
  daemonId: string,
  pollMs: number = INBOX_POLL_MS,
): DaemonWatcher {
  const claimed = new Set<string>();
  const inFlight = new Set<string>();
  let running = true;

  const log = (m: string): void => {
    try {
      void (client as unknown as {
        app?: { log?: (args: unknown) => Promise<unknown> };
      })?.app?.log?.({
        body: { service: "fleet-v1", level: "info", message: m },
      });
    } catch {
      // best-effort only; never use console.log in plugins.
    }
  };

  const timer: ReturnType<typeof setInterval> = setInterval(() => {
    if (!running) return;
    void scan().catch((err: unknown) =>
      log(`fleet-v1 inbox scan error: ${toReadableError(err)}`),
    );
  }, pollMs);
  if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
    (timer as unknown as { unref: () => void }).unref();
  }

  async function scan(): Promise<void> {
    let files: string[];
    try {
      files = await readdir(messagesDir());
    } catch {
      return; // no spool dir yet
    }
    for (const f of files) {
      if (!f.endsWith(".req.json")) continue;
      const reqId = f.slice(0, -".req.json".length);
      if (claimed.has(reqId) || inFlight.has(reqId)) continue;
      if (await fileExists(join(messagesDir(), `${reqId}.res.json`))) {
        claimed.add(reqId);
        continue;
      }
      if (await fileExists(claimedPath(reqId))) {
        claimed.add(reqId);
        continue;
      }
      const envelope = await readReq(reqId);
      if (!envelope) continue;
      const targetDaemon = envelope.targetDaemonId ?? "";
      if (targetDaemon !== "" && targetDaemon !== daemonId) continue;
      if (!envelope.targetSessionId) continue;
      claimed.add(reqId);
      inFlight.add(reqId);
      void handleOne(reqId, envelope.targetSessionId, envelope).finally(() => {
        inFlight.delete(reqId);
      });
    }
  }

  async function handleOne(
    reqId: string,
    targetSessionId: string,
    envelope: NonNullable<Awaited<ReturnType<typeof readReq>>>,
  ): Promise<void> {
    try {
      // P5 loop guard: refuse to forward envelopes past MAX_HOPS.
      if (isHopExceeded(envelope)) {
        const text = loopGuardText(reqId, hopOf(envelope));
        try {
          await writeRes(reqId, { ok: false, error: text });
        } catch {
          // writeRes failing must not crash the watcher.
        }
        log(`fleet-v1 req ${reqId}: ${text}`);
        return;
      }
      await writeFile(claimedPath(reqId), daemonId, { mode: 0o600 }).catch(
        () => undefined,
      );
      const injectText = buildInjectText(envelope);
      const parsedModel = parseFleetModel(envelope.model);
      const body: Record<string, unknown> = {
        parts: [{ type: "text", text: injectText }],
      };
      if (envelope.agent) body["agent"] = envelope.agent;
      if (parsedModel) body["model"] = parsedModel;
      if (envelope.variant) body["variant"] = envelope.variant;
      if (envelope.system) body["system"] = envelope.system;
      // NOTE: never set noReply — delegation must land as a normal user bubble.
      const c = client as unknown as {
        session: {
          promptAsync: (args: unknown) => Promise<unknown>;
          messages: (args: unknown) => Promise<unknown>;
        };
      };
      const beforeTime = Date.now();
      await c.session.promptAsync({ path: { id: targetSessionId }, body });
      const reply = await pollForReply(c, targetSessionId, beforeTime);
      if (reply === null) {
        await writeRes(reqId, {
          ok: false,
          error: `timeout waiting for DONE: reply after ${INBOX_RESPONSE_TIMEOUT_MS}ms (req ${reqId})`,
        });
        log(`fleet-v1 req ${reqId}: reply timeout`);
        return;
      }
      const done = doneLineOf(reply);
      if (done === null || done.trim() === "") {
        await writeRes(reqId, {
          ok: false,
          error: `empty reply: no trailing DONE: line found (req ${reqId})`,
        });
        log(`fleet-v1 req ${reqId}: no DONE: line`);
        return;
      }
      await writeRes(reqId, { ok: true, reply: reply.trim() });
      try {
        await writeNotify(reqId, envelope, reply.trim());
      } catch {
        // notify is best-effort; never break the inbox path.
      }
      log(`fleet-v1 req ${reqId}: DONE:${done}`);
    } catch (err) {
      const text = toReadableError(err);
      try {
        await writeRes(reqId, { ok: false, error: text || `failed req ${reqId}` });
      } catch {
        // writeRes failing must not crash the watcher.
      }
      log(`fleet-v1 req ${reqId} error: ${text}`);
    }
  }

  async function pollForReply(
    c: {
      session: { messages: (args: unknown) => Promise<unknown> };
    },
    targetSessionId: string,
    beforeTime: number,
  ): Promise<string | null> {
    const deadline = beforeTime + INBOX_RESPONSE_TIMEOUT_MS;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      try {
        const raw = (await c.session.messages({
          path: { id: targetSessionId },
        })) as Array<{ info: unknown; parts: unknown[] }>;
        const text = assistantTextOf(Array.isArray(raw) ? raw : [], beforeTime);
        if (text !== null && doneLineOf(text) !== null) return text;
      } catch (err) {
        log(`fleet-v1 reply poll error: ${toReadableError(err)}`);
      }
      await new Promise((r) =>
        setTimeout(r, Math.min(RESPONSE_POLL_MS, Math.max(0, remaining))),
      );
      if (Date.now() >= deadline) return null;
    }
  }

  return {
    stop: () => {
      running = false;
      clearInterval(timer);
    },
    isRunning: () => running,
    daemonId,
    serverUrl: "",
  };
}

export async function server(input: PluginInput) {
  const serverUrlStr = String(input.serverUrl ?? "");
  const daemonId = getDaemonId(serverUrlStr);
  const client = input.client;
  const deps = { client, serverUrl: serverUrlStr };

  const appLog = async (message: string, level: "info" | "warn" | "error" | "debug" = "info"): Promise<void> => {
    try {
      await client.app.log({
        body: { service: "fleet-v1", level, message },
      });
    } catch {
      // best-effort
    }
  };

  await appLog(`fleet.v1 loaded daemon=${daemonId} dir=${input.directory} v1bin=${V1_BIN} v1=${V1_VERSION}`);

  // v1-only enforcement: warn + skip watcher work on version/daemon mismatch.
  // Version source: client if it exposes one, else OPENCODE_VERSION env.
  const clientVersion = (client as unknown as { version?: unknown })?.version;
  const envVersion = currentVersion();
  const versionStr =
    typeof clientVersion === "string" && clientVersion !== "" ? clientVersion : envVersion;
  const v1Daemon = isV1Daemon(serverUrlStr);
  const v1Version = isV1Version(versionStr);
  const v1Ok = v1Daemon && v1Version;
  if (!v1Ok) {
    const reason = !v1Daemon
      ? `non-v1 daemon serverUrl=${serverUrlStr} (skips .bun / port 49374)`
      : `version mismatch version=${versionStr || "(unknown)"} expected=${V1_VERSION}`;
    await appLog(`fleet.v1 WARN v1-only guard: ${reason}; inbox watcher disabled`, "warn");
  }

  let watcher: DaemonWatcher | null = null;
  if (v1Ok) {
    watcher = startDaemonWatcher(client, daemonId);
    // Expose serverUrl on the handle for diagnostics (matches objective shape).
    (watcher as { serverUrl: string }).serverUrl = serverUrlStr;
  } else {
    // Stopped handle so dispose() stays safe while watcher work is skipped.
    let running = false;
    watcher = {
      stop: () => {
        running = false;
      },
      isRunning: () => running,
      daemonId,
      serverUrl: serverUrlStr,
    };
  }
  const handle = { watcher, daemonId, serverUrl: serverUrlStr };

  // P4 heartbeat helper: beat() via the v1 API only, then registerSelf
  // with the enriched entry (title/agent/model/status/lastDone). Never throws.
  const heartbeatAndRegister = async (sessionID: string): Promise<void> => {
    try {
      if (sessionID === "") return;
      const hb = await beat({
        client,
        sessionID,
        serverUrl: serverUrlStr,
        directory: String(input.directory ?? ""),
      }).catch(() => null);
      if (hb) {
        await registerSelf({
          sessionId: hb.sessionId,
          daemonId: hb.daemonId,
          directory: hb.directory || String(input.directory ?? ""),
          ...(hb.title !== "" ? { title: hb.title } : {}),
          ...(hb.agent !== "" ? { agent: hb.agent } : {}),
          ...(hb.model !== "" ? { model: hb.model } : {}),
          ...(hb.status !== "" ? { status: hb.status } : {}),
          ...(hb.lastDone !== "" ? { lastDone: hb.lastDone } : {}),
          role: hb.role,
          ...(hb.parentID !== "" ? { parentID: hb.parentID } : {}),
          updatedAt: hb.updatedAt,
        });
      } else {
        await registerSelf({
          sessionId: sessionID,
          daemonId,
          directory: String(input.directory ?? ""),
        });
      }
    } catch {
      // best-effort only
    }
  };

  // Startup best-effort auto-register via heartbeat: server() is daemon-wide
  // with no sessionID, but some hosts stash one on the input — use it if present.
  try {
    const maybeSession =
      (input as unknown as Record<string, unknown>)["sessionID"] ??
      (input as unknown as Record<string, unknown>)["sessionId"];
    if (typeof maybeSession === "string" && maybeSession !== "") {
      await heartbeatAndRegister(maybeSession);
    }
  } catch {
    // best-effort only
  }

  return {
    tool: {
      fleet_register: makeFleetRegisterTool(deps),
      fleet_list: makeFleetListTool(deps),
      fleet_broadcast: makeFleetBroadcastTool(deps),
      fleet_status: makeFleetStatusTool(deps),
      fleet_agents: makeFleetAgentsTool(deps),
      fleet_models: makeFleetModelsTool(deps),
      fleet_discover: makeFleetDiscoverTool(deps),
      fleet_ps: makeFleetPsTool(deps),
      fleet_exec: makeFleetExecTool(deps),
      fleet_handoff_back: makeFleetHandoffBackTool(deps),
      fleet_thread: makeFleetThreadTool(deps),
      fleet_allow: makeFleetAllowTool(deps),
      fleet_block: makeFleetBlockTool(deps),
      fleet_policy: makeFleetPolicyTool(deps),
      fleet_summary: makeFleetSummaryTool(deps),
      fleet_group: makeFleetGroupTool(deps),
      fleet_claim_commander: makeFleetClaimCommanderTool(deps),
      fleet_release_commander: makeFleetReleaseCommanderTool(deps),
      fleet_tree: makeFleetTreeTool(deps),
    },
    event: async ({ event }: { event: unknown }) => {
      try {
        const e = event as { type?: unknown; properties?: Record<string, unknown> };
        const type = typeof e?.type === "string" ? (e.type as string) : "";
        const props = (e?.properties ?? {}) as Record<string, unknown>;
        const rawId =
          props["sessionID"] ?? props["sessionId"] ??
          (e as Record<string, unknown>)["sessionID"] ??
          (e as Record<string, unknown>)["sessionId"] ??
          props["id"] ??
          (e as Record<string, unknown>)["id"];
        const sessionId = typeof rawId === "string" ? rawId : "";
        if (type === "session.created") {
          // Auto-register new sessions via heartbeat (v1 daemons only).
          if (sessionId !== "" && isV1Daemon(serverUrlStr)) {
            await heartbeatAndRegister(sessionId);
          }
          return;
        }
        if (type === "session.deleted") {
          if (sessionId !== "") {
            try {
              await removeSession(sessionId);
            } catch {
              // best-effort
            }
          }
          return;
        }
        if (type === "session.idle") {
          // Heartbeat via the v1 API: refresh title/agent/model/status/lastDone.
          if (sessionId === "") return;
          try {
            const entries = await readRegistry();
            const self = entries.find((x) => x.sessionId === sessionId);
            if (!self) {
              await heartbeatAndRegister(sessionId);
              return;
            }
            await heartbeatAndRegister(sessionId);
          } catch {
            // best-effort
          }
        }
      } catch {
        // event hooks are fire-and-forget; never throw.
      }
    },
    dispose: async () => {
      try {
        handle.watcher.stop();
      } catch {
        // ignore
      }
    },
  };
}

export default { id: "fleet.v1", server } satisfies PluginModule;

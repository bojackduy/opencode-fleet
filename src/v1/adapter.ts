/**
 * v1/adapter.ts — OpenCode v1 (1.18.x) adapter: the original fleet
 * server() wiring, rebuilt on the runtime-agnostic core (src/core/).
 * Behaviour is identical to the pre-core index.ts; tools are the core
 * ToolDefs wrapped with v1 `tool()`.
 *
 * server() runs once per daemon process (NOT per session), so there is no
 * "current sessionID" here. The inbox watcher is therefore daemon-wide:
 * it scans fleet/messages/*.req.json for envelopes whose targetDaemonId
 * matches this daemon's getDaemonId(serverUrl) and replays each one into
 * envelope.targetSessionId via client.session.promptAsync — as a normal
 * user bubble (never noReply/silent) so manual takeover with
 * revert/fork/continue keeps working.
 */

import { tool } from "@opencode-ai/plugin";
import type { PluginInput } from "@opencode-ai/plugin";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildInjectText,
  claimedPath,
  getDaemonId,
  INBOX_RESPONSE_TIMEOUT_MS,
  messageListOf,
  parseFleetModel,
} from "../core/inbox.js";
import {
  INBOX_POLL_MS,
  hopOf,
  isHopExceeded,
  loopGuardText,
  messagesDir,
  readReq,
  writeRes,
} from "../core/fileTransport.js";
import { readRegistry, registerSelf, removeSession, ensureStateMigrated } from "../core/registry.js";
import { beat } from "../core/heartbeat.js";
import { writeNotify } from "../core/notify.js";
import { ALL_TOOL_DEFS } from "../core/tools/index.js";
import type { ToolDef } from "../core/toolDef.js";
import type { CallCtx, LogLevel, Runtime } from "../core/runtime.js";
import { currentVersion, isV1Daemon, isV1Version, sameDaemon, V1_BIN, V1_VERSION } from "../core/v1.js";

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
        body: { service: "fleet", level: "info", message: m },
      });
    } catch {
      // best-effort only; never use console.log in plugins.
    }
  };

  const timer: ReturnType<typeof setInterval> = setInterval(() => {
    if (!running) return;
    void scan().catch((err: unknown) =>
      log(`fleet inbox scan error: ${toReadableError(err)}`),
    );
  }, pollMs);
  if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
    (timer as unknown as { unref: () => void }).unref();
  }

  async function scan(): Promise<void> {
    await ensureStateMigrated();
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
      // Marker-insensitive: registry rows carry the `:v1` marker.
      // v2-targeted envelopes (`v2:…`) never match a v1 daemon — routing, not a skip.
      if (targetDaemon !== "" && !sameDaemon(targetDaemon, daemonId)) continue;
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
        log(`fleet req ${reqId}: ${text}`);
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
        log(`fleet req ${reqId}: reply timeout`);
        return;
      }
      const done = doneLineOf(reply);
      if (done === null || done.trim() === "") {
        await writeRes(reqId, {
          ok: false,
          error: `empty reply: no trailing DONE: line found (req ${reqId})`,
        });
        log(`fleet req ${reqId}: no DONE: line`);
        return;
      }
      await writeRes(reqId, { ok: true, reply: reply.trim() });
      try {
        await writeNotify(reqId, envelope, reply.trim());
      } catch {
        // notify is best-effort; never break the inbox path.
      }
      log(`fleet req ${reqId}: DONE:${done}`);
    } catch (err) {
      const text = toReadableError(err);
      try {
        await writeRes(reqId, { ok: false, error: text || `failed req ${reqId}` });
      } catch {
        // writeRes failing must not crash the watcher.
      }
      log(`fleet req ${reqId} error: ${text}`);
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
        const raw = await c.session.messages({
          path: { id: targetSessionId },
        });
        const text = assistantTextOf(messageListOf(raw), beforeTime);
        if (text !== null && doneLineOf(text) !== null) return text;
      } catch (err) {
        log(`fleet reply poll error: ${toReadableError(err)}`);
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

/** v1 Runtime backed by the v1 plugin client (HTTP SDK) + serverUrl. */
function makeV1Runtime(
  client: PluginInput["client"],
  serverUrl: string,
  daemonId: string,
): Runtime {
  const c = client as unknown as {
    app?: { log?: (args: unknown) => Promise<unknown> };
    session?: {
      promptAsync?: (args: unknown) => Promise<unknown>;
      get?: (args: unknown) => Promise<unknown>;
    };
  };
  return {
    kind: "v1",
    daemonId,
    client,
    serverUrl,
    selfEndpoint: () => ({ kind: "v1-daemon", url: serverUrl }),
    promptLocal: async (sessionId, text, opts) => {
      const body: Record<string, unknown> = { parts: [{ type: "text", text }] };
      if (opts?.agent) body["agent"] = opts.agent;
      const parsedModel = parseFleetModel(opts?.model as Parameters<typeof parseFleetModel>[0]);
      if (parsedModel) body["model"] = parsedModel;
      if (opts?.variant) body["variant"] = opts.variant;
      if (opts?.system) body["system"] = opts.system;
      await c.session?.promptAsync?.({ path: { id: sessionId }, body });
    },
    sessionInfo: async (sessionId) => {
      try {
        const hb = await beat({ client, sessionID: sessionId, serverUrl, directory: "" });
        if (!hb) return null;
        return { title: hb.title, agent: hb.agent, model: hb.model, busy: hb.status === "busy", idleAt: null };
      } catch {
        return null;
      }
    },
    log: (level: LogLevel, msg: string) => {
      try {
        void c.app?.log?.({ body: { service: "fleet", level, message: msg } });
      } catch {
        // best-effort only; never use console.log in plugins.
      }
    },
  };
}

/** Wrap a runtime-agnostic ToolDef as a v1 `tool()` (same name/args/description). */
function toV1Tool(d: ToolDef, rt: Runtime) {
  return tool({
    description: d.description,
    args: d.args,
    execute: async (args, context) => {
      const callCtx: CallCtx = {
        ...(context as unknown as Record<string, unknown>),
        sessionID: context.sessionID,
        agent: context.agent,
        abort: context.abort,
      };
      return d.run(args, callCtx, rt);
    },
  });
}

export async function server(input: PluginInput) {
  const serverUrlStr = String(input.serverUrl ?? "");
  const daemonId = getDaemonId(serverUrlStr);
  const client = input.client;
  const rt = makeV1Runtime(client, serverUrlStr, daemonId);

  const appLog = async (message: string, level: "info" | "warn" | "error" | "debug" = "info"): Promise<void> => {
    try {
      await client.app.log({
        body: { service: "fleet", level, message },
      });
    } catch {
      // best-effort
    }
  };

  await appLog(`fleet loaded daemon=${daemonId} dir=${input.directory} v1bin=${V1_BIN} v1=${V1_VERSION}`);

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
    await appLog(`fleet WARN v1-only guard: ${reason}; inbox watcher disabled`, "warn");
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
          runtime: "v1",
          ...(hb.parentID !== "" ? { parentID: hb.parentID } : {}),
          updatedAt: hb.updatedAt,
        });
      } else {
        await registerSelf({
          sessionId: sessionID,
          daemonId,
          directory: String(input.directory ?? ""),
          runtime: "v1",
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
    tool: Object.fromEntries(ALL_TOOL_DEFS.map((d) => [d.name, toV1Tool(d, rt)])),
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


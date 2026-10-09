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
 *
 * P6 live-roster: a daemon-wide ~60s re-beat refreshes rows owned by this
 * daemon, and session.created/deleted emit roster notifies consumed by the
 * `fleet_watch` subscribe primitive (see core/tools/fleetWatch.ts).
 */

import { tool } from "@opencode-ai/plugin";
import type { PluginInput } from "@opencode-ai/plugin";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startPollLoop } from "../core/pollLoop.js";
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
import { runtimeOf } from "../core/registry.js";
import { beat } from "../core/heartbeat.js";
import { writeNotify, writeRosterNotify } from "../core/notify.js";
import {
  doneNoteFor,
  emitForWorkerIdentity,
  emitOwnershipEvent,
  emitToOwnersOfSession,
  idleNoteFor,
  snapshotOwnersForSession,
} from "../core/ownershipEvents.js";
import {
  recordHandoffOrigin,
  shortSessionOf,
  validateDelivery,
  validateHandoffDelivery,
} from "../core/ownershipControl.js";
import { ALL_TOOL_DEFS } from "../core/tools/index.js";
import type { ToolDef } from "../core/toolDef.js";
import type { CallCtx, LogLevel, Runtime } from "../core/runtime.js";
import { currentVersion, isV1Daemon, isV1Version, sameDaemon, V1_BIN, V1_VERSION } from "../core/v1.js";
import { discoverViaClient } from "../core/discover.js";

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

  const timer = startPollLoop(scan, pollMs, (err) => log(`fleet inbox scan error: ${toReadableError(err)}`));

  async function scan(): Promise<void> {
    await ensureStateMigrated();
    let files: string[];
    try {
      files = await readdir(messagesDir());
    } catch {
      return; // no spool dir yet
    }
    for (const f of files) {
      if (!running) return;
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
      if (!running) return;
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
      // Phase B2 delivery-time revalidation (TOCTOU-safe): envelopes are
      // dispatched by explicit kind — forward (commander->worker) envelopes
      // bind the ownership stamp to the ACTUAL receiving session (stamped
      // workerKey must equal this session's composite; forged targets and
      // legacy unstamped envelopes rejected), while handoff (worker->
      // commander reverse) envelopes run the reverse gate (sender binding +
      // durable origin + current-owner check). A transfer/unassign racing a
      // queued request makes it STALE -> rejected with a readable error,
      // never orphan-delivered.
      if (envelope.kind === "handoff") {
        const verdict = await validateHandoffDelivery(envelope, {
          receiver: { runtime: "v1", daemonId, sessionId: targetSessionId },
        });
        if (!verdict.ok) {
          try {
            await writeRes(reqId, { ok: false, error: verdict.error });
          } catch {
            // writeRes failing must not crash the watcher.
          }
          log(`fleet req ${reqId}: ${verdict.error}`);
          return;
        }
      } else {
        const verdict = await validateDelivery(envelope, {
          receiver: { runtime: "v1", daemonId, sessionId: targetSessionId },
        });
        if (!verdict.ok) {
          try {
            await writeRes(reqId, { ok: false, error: verdict.error });
          } catch {
            // writeRes failing must not crash the watcher.
          }
          log(`fleet req ${reqId}: ${verdict.error}`);
          return;
        }
        // Worker-side delivery: persist the delegating origin (durable
        // handoff routing survives commander-side .req cleanup).
        try {
          await recordHandoffOrigin({
            workerKey: verdict.workerKey,
            fromCommanderKey: verdict.commanderKey,
            fromCommanderSession: shortSessionOf(verdict.commanderKey),
            reqId,
            generation: verdict.generation,
            at: Date.now(),
          });
        } catch {
          // origin persistence is best-effort
        }
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
      if (!running) throw new Error("inbox watcher stopped before delivery");
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
      // Phase B1: scoped DONE to the assigned commander only (snippet, no
      // raw prompts). Unassigned workers produce no scoped event. Dedup
      // suppresses a second delivery when fleet_exec already emitted it.
      try {
        const done = doneLineOf(reply.trim());
        await emitForWorkerIdentity(
          { runtime: "v1", daemonId, sessionId: targetSessionId },
          "done",
          doneNoteFor(done !== null && done.trim() !== "" ? done : reply.trim()),
        );
      } catch {
        // scoped notify is best-effort
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
      timer.stop();
    },
    isRunning: () => running,
    daemonId,
    serverUrl: "",
  };
}

/** P6 re-beat cadence: daemon-wide refresh of own rows (~60s). */
const REBEAT_MS = 60_000;

/**
 * P6 periodic re-beat: every REBEAT_MS, refresh ONLY rows owned by this
 * daemon (marker-insensitive daemonId match, v1 runtime rows only — never
 * touch other daemons' rows) with live title/agent/model/status via beat().
 * Best-effort — never throws out of the interval.
 */
function startPeriodicRebeat(
  client: PluginInput["client"],
  serverUrlStr: string,
  daemonId: string,
  beatOne: (sessionId: string) => Promise<void>,
  log: (m: string) => void,
): { stop: () => void } {
  let running = true;
  const timer = startPollLoop(async () => {
      try {
        if (!isV1Daemon(serverUrlStr)) return;
        const entries = await readRegistry().catch(() => []);
        const own = entries.filter((e) => {
          try {
            if (runtimeOf(e) === "v2") return false;
            return sameDaemon(e.daemonId, daemonId);
          } catch {
            return false;
          }
        });
        for (const e of own) {
          if (!running) return;
          try {
            await beatOne(e.sessionId);
          } catch (err) {
            log(`fleet re-beat ${e.sessionId}: ${toReadableError(err)}`);
          }
        }
      } catch (err) {
        log(`fleet re-beat scan error: ${toReadableError(err)}`);
      }
  }, REBEAT_MS, (err) => log(`fleet re-beat scan error: ${toReadableError(err)}`));
  return {
    stop: () => {
      running = false;
      timer.stop();
    },
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
  // with the enriched entry (title/agent/model/status/lastDone). Returns the
  // heartbeat (or null) so event hooks can route scoped ownership events.
  // The v1 endpoint {kind:'v1-daemon', url:serverUrl} is stamped as routing
  // metadata only (never ownership) so cross-daemon sends can route direct
  // HTTP before spool fallback. Never throws.
  const heartbeatAndRegister = async (sessionID: string): Promise<null | {
    sessionId: string;
    daemonId: string;
    status: string;
    lastDone: string;
    role: string;
    parentID: string;
  }> => {
    try {
      if (sessionID === "") return null;
      const endpoint = serverUrlStr !== "" ? { kind: "v1-daemon" as const, url: serverUrlStr } : undefined;
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
          ...(endpoint ? { endpoint } : {}),
          updatedAt: hb.updatedAt,
        });
        return hb;
      } else {
        await registerSelf({
          sessionId: sessionID,
          daemonId,
          directory: String(input.directory ?? ""),
          runtime: "v1",
          ...(endpoint ? { endpoint } : {}),
        });
        return null;
      }
    } catch {
      // best-effort only
      return null;
    }
  };

  // P6 periodic re-beat (daemon-wide ~60s, own v1 rows only). The wrapper
  // also refreshes scoped ownership events (idle/role, dedup-suppressed).
  const rebeat = startPeriodicRebeat(client, serverUrlStr, daemonId, async (sessionId: string) => {
    try {
      const before = await readRegistry().catch(() => []);
      const oldRow = before.find((x) => x.sessionId === sessionId);
      const hb = await heartbeatAndRegister(sessionId);
      void hb;
      try {
        const after = await readRegistry().catch(() => []);
        const row = after.find((x) => x.sessionId === sessionId);
        if (row) {
          await emitForWorkerIdentity(
            { runtime: "v1", daemonId: row.daemonId, sessionId },
            "idle",
            idleNoteFor(String((row as { lastDone?: unknown }).lastDone ?? "")),
          ).catch(() => null);
          const oldRole = String((oldRow as { role?: unknown } | undefined)?.role ?? "");
          const newRole = String((row as { role?: unknown }).role ?? "");
          if (oldRole !== "" && newRole !== "" && oldRole !== newRole) {
            await emitForWorkerIdentity(
              { runtime: "v1", daemonId: row.daemonId, sessionId },
              "role",
              `${oldRole}->${newRole}`,
            ).catch(() => null);
          }
        }
      } catch {
        // scoped notify is best-effort
      }
    } catch {
      // best-effort only
    }
  }, (m) => {
    void appLog(m).catch(() => undefined);
  });

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

  // Startup sweep: sessions created before/at plugin load never emit
  // session.created to us, and rebeat skips rows stamped by dead daemons —
  // without this the fleet stays dark after every restart. Same handler as
  // session.created, run once over this daemon's live sessions. Best-effort.
  if (v1Ok) {
    try {
      const live = await discoverViaClient(client, 200).catch(() => []);
      for (const s of live) {
        try {
          if (typeof s?.id === "string" && s.id !== "") await heartbeatAndRegister(s.id);
        } catch {
          // one bad row must not block the rest
        }
      }
      if (live.length > 0) await appLog(`fleet startup sweep registered ${live.length} live session(s)`).catch(() => undefined);
    } catch {
      // best-effort only
    }
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
          // Global roster join stays for discovery; scoped join goes only
          // to the assigned commander (silent when unassigned).
          if (sessionId !== "" && isV1Daemon(serverUrlStr)) {
            await heartbeatAndRegister(sessionId);
            try {
              const entries = await readRegistry().catch(() => []);
              const row = entries.find((x) => x.sessionId === sessionId);
              await writeRosterNotify("join", {
                sessionId,
                title: String(row?.title ?? row?.summary ?? ""),
                directory: String(row?.directory ?? input.directory ?? ""),
              });
            } catch {
              // roster notify is best-effort
            }
            try {
              const entries = await readRegistry().catch(() => []);
              const row = entries.find((x) => x.sessionId === sessionId);
              if (row) {
                await emitForWorkerIdentity(
                  { runtime: "v1", daemonId: row.daemonId, sessionId },
                  "join",
                  String(row?.title ?? row?.summary ?? sessionId).slice(0, 200),
                ).catch(() => null);
              } else {
                await emitToOwnersOfSession(sessionId, "join", sessionId).catch(() => null);
              }
            } catch {
              // scoped notify is best-effort
            }
          }
          return;
        }
        if (type === "session.deleted") {
          if (sessionId !== "") {
            // Snapshot the owner BEFORE removeSession so the scoped leave
            // route survives registry removal (assignment rows persist).
            let snap: { workerKey: string; commanderKey: string }[] = [];
            try {
              const s = await snapshotOwnersForSession(sessionId);
              if (!("error" in s)) snap = s.owners;
            } catch {
              snap = [];
            }
            try {
              await removeSession(sessionId);
            } catch {
              // best-effort
            }
            try {
              await writeRosterNotify("leave", { sessionId });
            } catch {
              // roster notify is best-effort
            }
            try {
              for (const o of snap) {
                await emitOwnershipEvent(o.workerKey, "leave", sessionId).catch(() => null);
              }
              if (snap.length === 0) {
                await emitToOwnersOfSession(sessionId, "leave", sessionId).catch(() => null);
              }
            } catch {
              // scoped notify is best-effort
            }
          }
          return;
        }
        if (type === "session.idle") {
          // Heartbeat via the v1 API: refresh title/agent/model/status/lastDone,
          // then route a scoped idle (+role on change) to the owner only.
          // Manual idle included; dedup suppresses repeat transitions.
          if (sessionId === "") return;
          try {
            const entries = await readRegistry();
            const self = entries.find((x) => x.sessionId === sessionId);
            const oldRole = String((self as { role?: unknown } | undefined)?.role ?? "");
            const oldDone = String((self as { lastDone?: unknown } | undefined)?.lastDone ?? "");
            if (!self) {
              await heartbeatAndRegister(sessionId);
              try {
                const after = await readRegistry().catch(() => []);
                const row = after.find((x) => x.sessionId === sessionId);
                if (row) {
                  await emitForWorkerIdentity(
                    { runtime: "v1", daemonId: row.daemonId, sessionId },
                    "idle",
                    idleNoteFor(String((row as { lastDone?: unknown }).lastDone ?? "")),
                  ).catch(() => null);
                }
              } catch {
                // scoped notify is best-effort
              }
              return;
            }
            await heartbeatAndRegister(sessionId);
            try {
              const after = await readRegistry().catch(() => []);
              const row = after.find((x) => x.sessionId === sessionId);
              if (row) {
                const newDone = String((row as { lastDone?: unknown }).lastDone ?? "");
                // Suppress duplicate idle on the same transition (same lastDone
                // as before the beat): the journal dedup is the second net.
                if (newDone !== oldDone || oldDone === "") {
                  await emitForWorkerIdentity(
                    { runtime: "v1", daemonId: row.daemonId, sessionId },
                    "idle",
                    idleNoteFor(newDone),
                  ).catch(() => null);
                }
                const newRole = String((row as { role?: unknown }).role ?? "");
                if (oldRole !== "" && newRole !== "" && oldRole !== newRole) {
                  await emitForWorkerIdentity(
                    { runtime: "v1", daemonId: row.daemonId, sessionId },
                    "role",
                    `${oldRole}->${newRole}`,
                  ).catch(() => null);
                }
              }
            } catch {
              // scoped notify is best-effort
            }
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
      try {
        rebeat.stop();
      } catch {
        // ignore
      }
    },
  };
}

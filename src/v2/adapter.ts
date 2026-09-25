/**
 * v2/adapter.ts — OpenCode v2 (2.0.16+) adapter: `setup(ctx)` from the
 * promise plugin API. Runs once per Location (directory) with a separately
 * imported module instance per location (see fleet-progress-V2-research.md).
 *
 * Part 2 scope (checklist steps 4-8):
 * - Full `Runtime` impl: daemonId `v2:<service-url>` (pid fallback),
 *   promptLocal via ctx.session.prompt({delivery:"queue"}), sessionInfo via
 *   session.get/API, file log.
 * - Process-wide singleton on globalThis[Symbol.for("fleet.v2.daemon")]
 *   (module singletons don't work across per-location re-imports): spool
 *   watcher + per-location ref-counting; cleanup stops the loop/watcher.
 * - Delegation transports live in core (fleetExec/Broadcast/Handoff route by
 *   target row runtime); this adapter provides the in-process promptLocal,
 *   the remote-HTTP credentials path (via v2transport), and the spool
 *   watcher that claims v2 envelopes as normal user messages + DONE: replies.
 * - Heartbeat from session.created/idle/deleted + session.execution.*
 *   events (data.sessionID); registry rows carry runtime:"v2" + endpoint.
 * - Feature-detect ctx.tool?.transform / ctx.session?.prompt /
 *   ctx.event?.subscribe; missing pieces degrade to spool-only + a log line.
 *
 * Only local structural types are used for the v2 context — no runtime
 * dependency on @opencode/plugin. Strict TS ESM, rt.log never console.log,
 * and the service password is never logged/persisted/registered (it is read
 * from service.json at send time inside v2transport only).
 */

import { appendFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { registerSelf, removeSessionScoped, stateDir, ensureStateMigrated } from "../core/registry.js";
import type { RegistryEndpoint } from "../core/registry.js";
import { ALL_TOOL_DEFS } from "../core/tools/index.js";
import { z } from "../core/toolDef.js";
import type { ToolDef } from "../core/toolDef.js";
import type { CallCtx, Endpoint, LogLevel, Runtime } from "../core/runtime.js";
import { parentIdOf } from "../core/heartbeat.js";
import { resolveRole } from "../core/roles.js";
import {
  buildInjectText,
  claimedPath,
  INBOX_RESPONSE_TIMEOUT_MS,
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
import { writeNotify } from "../core/notify.js";
import {
  passwordForUrl,
  pollV2Done,
  readV2ServiceCreds,
  v2ActiveMap,
  v2DaemonId,
  v2SessionStateOf,
} from "../core/v2transport.js";

// ---- local structural types for the v2 promise plugin context ----

interface V2ToolExecCtx {
  sessionID?: string;
  agent?: string;
  messageID?: string;
  id?: string;
  signal?: AbortSignal;
  progress?: unknown;
}

interface V2ToolSpec {
  name: string;
  description: string;
  input: unknown;
  execute: (input: unknown, ctx: V2ToolExecCtx) => Promise<{ content: string }>;
}

interface V2ToolEditor {
  add: (spec: V2ToolSpec) => unknown;
}

interface V2BusEvent {
  type?: unknown;
  data?: unknown;
  location?: unknown;
}

export interface V2Context {
  app?: { name?: string; version?: string; channel?: string };
  location?: { directory?: string; workspaceID?: string };
  tool?: {
    transform?: (fn: (t: V2ToolEditor) => unknown) => unknown;
    list?: () => unknown;
  };
  session?: {
    prompt?: (args: Record<string, unknown>) => Promise<unknown>;
    get?: (args: unknown) => Promise<unknown>;
  };
  event?: {
    subscribe?: () => AsyncIterable<V2BusEvent>;
  };
  [key: string]: unknown;
}

// ---- logging: v2 ctx has no log API; append to a fleet log file ----

const LOG_MAX_BYTES = 1_000_000;

function v2LogPath(): string {
  return join(stateDir(), "v2.log");
}

function makeLogger(location: string): Runtime["log"] {
  return (level: LogLevel, msg: string, extra?: Record<string, unknown>) => {
    const line =
      JSON.stringify({
        t: new Date().toISOString(),
        pid: process.pid,
        level,
        location,
        msg,
        ...(extra ? { extra } : {}),
      }) + "\n";
    void (async () => {
      try {
        await mkdir(stateDir(), { recursive: true, mode: 0o700 });
        const size = await stat(v2LogPath())
          .then((s) => s.size)
          .catch(() => 0);
        if (size > LOG_MAX_BYTES) await writeFile(v2LogPath(), "", { mode: 0o600 });
        await appendFile(v2LogPath(), line, { mode: 0o600 });
      } catch {
        // best-effort only; never use console.log in plugins.
      }
    })();
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

// ---- process-wide singleton (per-location module re-imports share it) ----

const DAEMON_KEY = Symbol.for("fleet.v2.daemon");

/** Per-location session surface captured for the process-wide watcher. */
interface V2LocationApi {
  prompt: (args: Record<string, unknown>) => Promise<unknown>;
  getRaw: (args: unknown) => Promise<unknown>;
}

interface V2DaemonState {
  refs: Map<string, number>;
  apis: Map<string, V2LocationApi>;
  daemonId: string;
  serviceUrl: string;
  watcher: { stop: () => void } | null;
}

function daemonState(): V2DaemonState {
  const g = globalThis as unknown as Record<symbol, V2DaemonState | undefined>;
  let s = g[DAEMON_KEY];
  if (!s) {
    s = { refs: new Map(), apis: new Map(), daemonId: "", serviceUrl: "", watcher: null };
    g[DAEMON_KEY] = s;
  }
  return s;
}

// ---- v2 Runtime ----

function toEndpoint(serviceUrl: string, location: string): Endpoint {
  if (serviceUrl !== "") return { kind: "v2-service", url: serviceUrl, location };
  return { kind: "v2-standalone", url: "", location };
}

async function tolerantSessionGet(api: V2LocationApi | undefined, sessionId: string): Promise<unknown> {
  if (!api) return null;
  const attempts: unknown[] = [
    sessionId,
    { sessionID: sessionId },
    { id: sessionId },
    { path: { id: sessionId } },
  ];
  for (const a of attempts) {
    try {
      const r = await api.getRaw(a);
      if (r !== null && r !== undefined) return r;
    } catch {
      // try the next shape
    }
  }
  return null;
}

function makeV2Runtime(
  ctx: V2Context,
  daemonId: string,
  serviceUrl: string,
  location: string,
  log: Runtime["log"],
): Runtime {
  const api: V2LocationApi | undefined =
    typeof ctx.session?.prompt === "function" && typeof ctx.session?.get === "function"
      ? {
          prompt: ctx.session.prompt.bind(ctx.session),
          getRaw: ctx.session.get.bind(ctx.session),
        }
      : undefined;
  return {
    kind: "v2",
    daemonId,
    client: undefined,
    serverUrl: "",
    selfEndpoint: () => toEndpoint(serviceUrl, location),
    promptLocal: async (sessionId, text, opts) => {
      if (!api) throw new Error("fleet v2: ctx.session.prompt unavailable (spool-only degrade)");
      const body: Record<string, unknown> = { sessionID: sessionId, text, delivery: "queue" };
      if (opts?.agent) body["agents"] = [opts.agent];
      if (opts?.model !== undefined) body["model"] = opts.model;
      if (opts?.system) body["system"] = opts.system;
      await api.prompt(body);
    },
    sessionInfo: async (sessionId) => {
      try {
        const raw = await tolerantSessionGet(api, sessionId);
        if (raw === null || raw === undefined) return null;
        const data =
          raw !== null && typeof raw === "object" && "data" in (raw as Record<string, unknown>)
            ? (raw as { data: unknown }).data
            : raw;
        let active: Record<string, string> | null = null;
        if (serviceUrl !== "") {
          try {
            const pw = await passwordForUrl(serviceUrl).catch(() => "");
            if (pw !== "") active = await v2ActiveMap(serviceUrl, pw).catch(() => null);
          } catch {
            // best-effort
          }
        }
        const st = v2SessionStateOf(data, active);
        return {
          title: st.title,
          agent: st.agent,
          model: st.model,
          busy: st.busy,
          idleAt: st.idleAt,
        };
      } catch {
        return null;
      }
    },
    waitForDone: async (sessionId, since, timeoutMs, signal) => {
      try {
        if (serviceUrl === "") return null;
        const pw = await passwordForUrl(serviceUrl).catch(() => "");
        if (pw === "") return null;
        return await pollV2Done(serviceUrl, pw, sessionId, since, timeoutMs, signal);
      } catch {
        return null;
      }
    },
    log,
  };
}

/** Wrap a runtime-agnostic ToolDef as a v2 tool spec (zod = StandardSchema input). */
export function toV2Tool(d: ToolDef, rt: Runtime): V2ToolSpec {
  return {
    name: d.name,
    description: d.description,
    input: z.object(d.args),
    execute: async (input, c) => {
      const callCtx: CallCtx = {
        sessionID: String(c?.sessionID ?? ""),
        ...(typeof c?.agent === "string" ? { agent: c.agent } : {}),
        ...(c?.signal ? { abort: c.signal } : {}),
        ...(rt.selfEndpoint().location ? { directory: rt.selfEndpoint().location } : {}),
      };
      try {
        const content = await d.run(input ?? {}, callCtx, rt);
        return { content: typeof content === "string" ? content : String(content) };
      } catch (err) {
        return { content: `${d.name} failed: ${toReadableError(err)}` };
      }
    },
  };
}

// ---- v2 heartbeat (event-driven) ----

function eventSessionId(ev: V2BusEvent): string {
  try {
    const d = (ev?.data ?? {}) as Record<string, unknown>;
    for (const k of ["sessionID", "sessionId", "id"]) {
      const v = d[k];
      if (typeof v === "string" && v !== "") return v;
    }
    return "";
  } catch {
    return "";
  }
}

async function heartbeatAndRegisterV2(
  rt: Runtime,
  api: V2LocationApi | undefined,
  sessionId: string,
  location: string,
): Promise<void> {
  try {
    if (sessionId === "") return;
    const ep = rt.selfEndpoint();
    const base = {
      sessionId,
      daemonId: rt.daemonId,
      directory: location,
      runtime: "v2" as const,
      endpoint: {
        kind: (ep.kind === "v2-service" ? "v2-service" : "v2-standalone") as RegistryEndpoint["kind"],
        url: ep.url,
      },
      ...(location !== "" ? { location } : {}),
    };
    let title = "";
    let agent = "";
    let model = "";
    let parentID = "";
    try {
      const raw = await tolerantSessionGet(api, sessionId);
      const data =
        raw !== null && typeof raw === "object" && "data" in (raw as Record<string, unknown>)
          ? (raw as { data: unknown }).data
          : raw;
      if (data !== null && typeof data === "object") {
        const o = data as Record<string, unknown>;
        if (typeof o["title"] === "string") title = o["title"] as string;
        const st = v2SessionStateOf(data, null);
        agent = st.agent;
        model = st.model;
        parentID = parentIdOf(data);
      }
    } catch {
      // best-effort enrichment
    }
    let role: "commander" | "worker" | "peer" = "peer";
    try {
      role = await resolveRole({ sessionID: sessionId, parentID });
    } catch {
      // keep peer
    }
    await registerSelf({
      ...base,
      ...(title !== "" ? { title } : {}),
      ...(agent !== "" ? { agent } : {}),
      ...(model !== "" ? { model } : {}),
      role,
      ...(parentID !== "" ? { parentID } : {}),
      updatedAt: Date.now(),
    });
  } catch {
    // best-effort only
  }
}

async function runEventLoop(
  ctx: V2Context,
  rt: Runtime,
  api: V2LocationApi | undefined,
  location: string,
  signal: AbortSignal,
): Promise<void> {
  const subscribe = ctx.event?.subscribe;
  if (typeof subscribe !== "function") {
    rt.log("warn", "fleet v2 setup: ctx.event.subscribe unavailable; heartbeat events disabled");
    return;
  }
  try {
    const iter = subscribe.call(ctx.event) as AsyncIterable<V2BusEvent>;
    for await (const ev of iter) {
      if (signal.aborted) return;
      try {
        const type = typeof ev?.type === "string" ? (ev.type as string) : "";
        const sessionId = eventSessionId(ev);
        if (sessionId === "") continue;
        if (
          type === "session.created" ||
          type === "session.idle" ||
          type === "session.execution.succeeded" ||
          type === "session.execution.failed" ||
          type === "session.execution.interrupted" ||
          type === "session.status"
        ) {
          await heartbeatAndRegisterV2(rt, api, sessionId, location);
        } else if (type === "session.deleted") {
          try {
            await removeSessionScoped(sessionId, { runtime: "v2" });
          } catch {
            // best-effort
          }
        }
      } catch (err) {
        rt.log("warn", `fleet v2 event error: ${toReadableError(err)}`);
      }
    }
  } catch (err) {
    if (!signal.aborted) rt.log("warn", `fleet v2 event loop ended: ${toReadableError(err)}`);
  }
}

// ---- process-wide spool watcher (claims v2 envelopes) ----

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

function startV2SpoolWatcher(log: Runtime["log"]): { stop: () => void } {
  const claimed = new Set<string>();
  const inFlight = new Set<string>();
  let running = true;

  const timer: ReturnType<typeof setInterval> = setInterval(() => {
    if (!running) return;
    void scan().catch((err: unknown) => log("warn", `fleet v2 spool scan error: ${toReadableError(err)}`));
  }, INBOX_POLL_MS);
  if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
    (timer as unknown as { unref: () => void }).unref();
  }

  function hostingApis(): Array<{ location: string; api: V2LocationApi }> {
    const s = daemonState();
    const out: Array<{ location: string; api: V2LocationApi }> = [];
    for (const [location, api] of s.apis) {
      if (api && typeof api.prompt === "function") out.push({ location, api });
    }
    return out;
  }

  async function findHost(sessionId: string): Promise<V2LocationApi | null> {
    for (const { api } of hostingApis()) {
      try {
        const r = await tolerantSessionGet(api, sessionId);
        if (r !== null && r !== undefined) return api;
      } catch {
        // try next location
      }
    }
    return null;
  }

  async function scan(): Promise<void> {
    await ensureStateMigrated();
    const s = daemonState();
    if (s.daemonId === "") return;
    if (hostingApis().length === 0) return; // spool-only degrade: claim nothing we can't serve
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
      // v1-targeted envelopes belong to v1 daemons; empty targets are
      // claimed only when we actually host the session.
      if (targetDaemon !== "" && targetDaemon !== s.daemonId) continue;
      if (!envelope.targetSessionId) continue;
      const host = await findHost(envelope.targetSessionId);
      if (!host) continue; // not ours — leave for the owning daemon
      claimed.add(reqId);
      inFlight.add(reqId);
      void handleOne(reqId, envelope.targetSessionId, host).finally(() => {
        inFlight.delete(reqId);
      });
    }
  }

  async function handleOne(
    reqId: string,
    targetSessionId: string,
    host: V2LocationApi,
  ): Promise<void> {
    const s = daemonState();
    try {
      const envelope = await readReq(reqId);
      if (!envelope) return;
      if (isHopExceeded(envelope)) {
        const text = loopGuardText(reqId, hopOf(envelope));
        try {
          await writeRes(reqId, { ok: false, error: text });
        } catch {
          // never crash the watcher
        }
        log("warn", `fleet v2 req ${reqId}: ${text}`);
        return;
      }
      await writeFile(claimedPath(reqId), s.daemonId, { mode: 0o600 }).catch(() => undefined);
      const injectText = buildInjectText(envelope);
      // Capture `since` BEFORE injection: the worker's reply is always
      // created after the user bubble lands, so a pre-prompt timestamp can
      // never exclude it (a post-prompt timestamp could, on same-second
      // races). Mirrors the v1 watcher's beforeTime.
      const since = Date.now();
      // Land as a normal user bubble (delivery queue, auto-runs).
      await host.prompt({ sessionID: targetSessionId, text: injectText, delivery: "queue" });
      // Wait for the DONE: reply over our own service HTTP surface.
      // Without service credentials (standalone) the injection still landed
      // as a user bubble — report it delivered without a DONE: capture.
      const pw = s.serviceUrl !== "" ? await passwordForUrl(s.serviceUrl).catch(() => "") : "";
      if (s.serviceUrl === "" || pw === "") {
        await writeRes(reqId, {
          ok: true,
          reply: `injected via v2 spool; DONE poll unavailable (req ${reqId})`,
        }).catch(() => undefined);
        log("info", `fleet v2 req ${reqId}: injected (DONE poll unavailable)`);
        return;
      }
      const reply = await pollV2Done(s.serviceUrl, pw, targetSessionId, since, INBOX_RESPONSE_TIMEOUT_MS);
      if (reply === null) {
        const errText = `timeout waiting for DONE: reply after ${INBOX_RESPONSE_TIMEOUT_MS}ms (req ${reqId})`;
        await writeRes(reqId, { ok: false, error: errText }).catch(() => undefined);
        log("warn", `fleet v2 req ${reqId}: ${errText}`);
        return;
      }
      await writeRes(reqId, { ok: true, reply: reply.trim() }).catch(() => undefined);
      try {
        const envelope2 = await readReq(reqId);
        if (envelope2) await writeNotify(reqId, envelope2, reply.trim());
      } catch {
        // notify is best-effort
      }
      log("info", `fleet v2 req ${reqId}: DONE reply captured`);
    } catch (err) {
      const text = toReadableError(err);
      try {
        await writeRes(reqId, { ok: false, error: text || `failed req ${reqId}` });
      } catch {
        // never crash the watcher
      }
      log("warn", `fleet v2 req ${reqId} error: ${text}`);
    }
  }

  return {
    stop: () => {
      running = false;
      clearInterval(timer);
    },
  };
}

// ---- setup ----

export async function v2Setup(ctx: V2Context): Promise<(() => void) | void> {
  const location = String(ctx.location?.directory ?? "");
  const log = makeLogger(location);

  // Host guard: v1 daemons (1.18.x) also invoke an exported `setup` when
  // present. Without ANY v2 plugin API this is a foreign host — log once and
  // return with zero side effects (no tools, no watcher, no singleton refs),
  // so v1 behaviour stays exactly as before.
  const hasToolApi = typeof ctx?.tool?.transform === "function";
  const hasSessionApi =
    typeof ctx?.session?.prompt === "function" || typeof ctx?.session?.get === "function";
  const hasEventApi = typeof ctx?.event?.subscribe === "function";
  if (!hasToolApi && !hasSessionApi && !hasEventApi) {
    log("warn", "fleet v2 setup: no v2 plugin APIs detected (foreign host); skipping v2 setup entirely");
    return;
  }

  // Service identity: daemonId `v2:<url>` (stable), pid fallback for standalone.
  let serviceUrl = "";
  try {
    const creds = await readV2ServiceCreds().catch(() => null);
    if (creds && typeof creds.url === "string" && creds.url.trim() !== "") {
      serviceUrl = creds.url.trim();
    }
  } catch {
    // standalone — daemonId falls back to pid
  }
  const daemonId = v2DaemonId(serviceUrl);
  const rt = makeV2Runtime(ctx, daemonId, serviceUrl, location, log);

  // Tools (feature-detected; missing transform degrades to spool-only).
  try {
    const toolApi = ctx?.tool;
    if (typeof toolApi?.transform !== "function") {
      log("warn", "fleet v2 setup: ctx.tool.transform unavailable; no tools registered (spool-only)");
    } else {
      const specs = ALL_TOOL_DEFS.map((d) => toV2Tool(d, rt));
      await toolApi.transform((t) => {
        for (const s of specs) t.add(s);
      });
      log("info", `fleet v2 setup: registered ${specs.length} tools`, {
        app: ctx.app?.version ?? "",
      });
    }
  } catch (err) {
    log("error", `fleet v2 tool setup failed: ${toReadableError(err)}`);
  }

  // Process-wide singleton: per-location ref-counting.
  const s = daemonState();
  if (s.daemonId === "") {
    s.daemonId = daemonId;
    s.serviceUrl = serviceUrl;
  }
  s.refs.set(location, (s.refs.get(location) ?? 0) + 1);
  if (typeof ctx.session?.prompt === "function" && typeof ctx.session?.get === "function") {
    s.apis.set(location, {
      prompt: ctx.session.prompt.bind(ctx.session),
      getRaw: ctx.session.get.bind(ctx.session),
    });
  } else {
    log("warn", "fleet v2 setup: ctx.session.prompt/get unavailable; this location cannot serve spool (spool-only degrade)");
  }
  if (!s.watcher) {
    s.watcher = startV2SpoolWatcher(log);
    log("info", "fleet v2 spool watcher started (process-wide)");
  }

  // Event-driven heartbeat for this location.
  const aborter = new AbortController();
  const api = s.apis.get(location);
  void runEventLoop(ctx, rt, api, location, aborter.signal);

  log("info", `fleet v2 setup: location ready daemon=${daemonId}`, { location });

  // Cleanup on location unload: release this location; stop the watcher when
  // the last location goes away.
  return () => {
    try {
      aborter.abort();
    } catch {
      // ignore
    }
    try {
      const st = daemonState();
      const n = (st.refs.get(location) ?? 1) - 1;
      if (n <= 0) {
        st.refs.delete(location);
        st.apis.delete(location);
      } else {
        st.refs.set(location, n);
      }
      if (st.refs.size === 0 && st.watcher) {
        try {
          st.watcher.stop();
        } catch {
          // ignore
        }
        st.watcher = null;
      }
    } catch {
      // ignore
    }
  };
}

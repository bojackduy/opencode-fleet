/**
 * inbox.ts — Phase 2 inbox watcher for fleet-v1.
 *
 * Worker-side loop: polls `fleet-v1/messages/*.req.json` for requests
 * targeting this session (and this daemon), replays each one as a normal
 * user message via `client.session.promptAsync` (NEVER noReply/silent),
 * then polls `client.session.messages` for the assistant reply and writes
 * `<reqId>.res.json` for the commander to collect.
 *
 * Safety: peer text is untrusted input (same trust as pasted user text).
 * It is rendered as a plain user-bubble text part — never eval'd, never
 * written to the DB directly, never used as code.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { INBOX_POLL_MS, messagesDir, readReq, writeRes } from "./fileTransport.js";
import type { FleetEnvelope, FleetModel } from "./fileTransport.js";
import { writeNotify } from "./notify.js";
import { readRegistry, registerSelf, removeSession } from "./registry.js";

export { INBOX_POLL_MS };

/** How long to wait for the assistant reply after promptAsync before timing out. */
export const INBOX_RESPONSE_TIMEOUT_MS = 120_000;

/** Default inbox scan cadence when the caller omits `pollMs`. */
export const DEFAULT_INBOX_POLL_MS = INBOX_POLL_MS;

/** Default reply-poll cadence when the caller omits `responsePollMs`. */
export const DEFAULT_RESPONSE_POLL_MS = 500;

/** Footer appended to every injected prompt so the commander can poll reliably. */
export const DONE_FOOTER = "Reply ending with exactly: DONE:<one-line-result>";

/**
 * Daemon identity: `<hostname>-<pid>-<port>`.
 * Port is parsed out of the server URL; when the URL cannot be parsed the
 * raw serverUrl string is used as the trailing segment instead.
 */
export function getDaemonId(serverUrl: string): string {
  const host = hostname();
  const pid = process.pid;
  try {
    const port = new URL(serverUrl).port;
    if (port && port.trim() !== "") return `${host}-${pid}-${port}`;
  } catch {
    // Fall through to the raw-string fallback below.
  }
  // No parseable port — fall back to the raw string per spec.
  // Try a trailing :port match so "http://127.0.0.1:14121" still yields "14121"
  // even if URL parsing behaved unexpectedly.
  const m = /:(\d+)(?:\/|$)/.exec(serverUrl);
  if (m) return `${host}-${pid}-${m[1]}`;
  return `${host}-${pid}-${serverUrl}`;
}

/** Path of the `<reqId>.claimed` marker used to avoid double-pickup. */
export function claimedPath(reqId: string): string {
  return join(messagesDir(), `${reqId}.claimed`);
}

/**
 * Build the user-bubble text for an injected delegation. The header keeps
 * manual takeover readable; the DONE footer is always appended so the
 * commander can poll reliably even when the original message omits it.
 */
export function buildInjectText(envelope: FleetEnvelope): string {
  const header = `[from fleet-v1 ${envelope.reqId} | commander:${envelope.fromCommander}]`;
  const body = (envelope.message ?? "").trim();
  if (/DONE:/.test(body)) return `${header}\n${body}\n${DONE_FOOTER}`;
  return `${header}\n${body}\n${DONE_FOOTER}`;
}

/**
 * Normalize a fleet model reference to `{providerID, modelID}`.
 * Accepts the structured form (passed through) or the "provider/model"
 * shorthand (split on the first `/`, trimmed). Returns undefined when the
 * input is missing, empty, or has no `/` separator.
 */
export function parseFleetModel(
  m: FleetModel | string | undefined,
): { providerID: string; modelID: string } | undefined {
  if (m === undefined || m === null) return undefined;
  if (typeof m === "object") {
    const providerID = (m.providerID ?? "").trim();
    const modelID = (m.modelID ?? "").trim();
    if (providerID === "" || modelID === "") return undefined;
    return { providerID, modelID };
  }
  const raw = m.trim();
  if (raw === "") return undefined;
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) return undefined;
  const providerID = raw.slice(0, slash).trim();
  const modelID = raw.slice(slash + 1).trim();
  if (providerID === "" || modelID === "") return undefined;
  return { providerID, modelID };
}

export interface StartInboxWatcherOpts {
  // biome-ignore lint/suspicious/noExplicitAny: v1 plugin client is untyped at the boundary.
  client: any;
  sessionID: string;
  serverUrl: string;
  daemonId: string;
  pollMs?: number;
  responsePollMs?: number;
  onLog?: (m: string) => void;
}

export interface InboxWatcherHandle {
  stop: () => void;
  isRunning: () => boolean;
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

function assistantTextOf(messages: Array<{ info: any; parts: any[] }>, since: number): string | null {
  let latest: string | null = null;
  for (const m of messages ?? []) {
    const info = m?.info as any;
    if (!info || info.role !== "assistant") continue;
    const created = typeof info?.time?.created === "number" ? (info.time.created as number) : 0;
    if (created < since) continue;
    const texts: string[] = [];
    for (const p of m?.parts ?? []) {
      if (p && (p as any).type === "text" && typeof (p as any).text === "string") {
        texts.push((p as any).text as string);
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
 * Start the inbox watcher. Scans `messagesDir()` every `pollMs` for
 * `*.req.json` files addressed to this session/daemon and handles each
 * pickup in the background (fire-and-forget) so the scan loop never blocks
 * on the 120s reply poll. Never throws — per-request failures are captured
 * into `.res.json` as `{ok:false, error}`.
 */
export function startInboxWatcher(opts: StartInboxWatcherOpts): InboxWatcherHandle {
  const { client, sessionID, daemonId } = opts;
  const pollMs = opts.pollMs ?? DEFAULT_INBOX_POLL_MS;
  const responsePollMs = opts.responsePollMs ?? DEFAULT_RESPONSE_POLL_MS;
  const claimed = new Set<string>();
  const inFlight = new Set<string>();
  let running = true;

  const log = (m: string): void => {
    try {
      opts.onLog?.(m);
    } catch {
      // onLog must never break the watcher.
    }
    try {
      void client?.app?.log?.({
        body: { service: "fleet-v1", level: "info", message: m },
      });
    } catch {
      // client.app.log is best-effort.
    }
  };

  const timer: ReturnType<typeof setInterval> = setInterval(() => {
    if (!running) return;
    void scan().catch((err: unknown) => log(`fleet-v1 inbox scan error: ${toReadableError(err)}`));
  }, pollMs);
  // Don't keep the daemon alive just for the watcher.
  if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
    (timer as unknown as { unref: () => void }).unref();
  }

  async function scan(): Promise<void> {
    let files: string[];
    try {
      files = await readdir(messagesDir());
    } catch {
      return; // No spool dir yet — nothing to do.
    }
    for (const f of files) {
      if (!f.endsWith(".req.json")) continue;
      const reqId = f.slice(0, -".req.json".length);
      if (claimed.has(reqId) || inFlight.has(reqId)) continue;
      // Skip requests that already have a response.
      const resFile = join(messagesDir(), `${reqId}.res.json`);
      if (await fileExists(resFile)) {
        claimed.add(reqId);
        continue;
      }
      // Cross-daemon guard: another worker already claimed this request.
      if (await fileExists(claimedPath(reqId))) {
        claimed.add(reqId);
        continue;
      }
      const envelope = await readReq(reqId);
      if (!envelope) continue;
      if (envelope.targetSessionId !== sessionID) continue;
      if (
        envelope.targetDaemonId !== undefined &&
        envelope.targetDaemonId !== null &&
        envelope.targetDaemonId !== "" &&
        envelope.targetDaemonId !== daemonId
      ) {
        continue;
      }
      claimed.add(reqId);
      inFlight.add(reqId);
      void handleOne(reqId, envelope).finally(() => {
        inFlight.delete(reqId);
      });
    }
  }

  async function handleOne(reqId: string, envelope: FleetEnvelope): Promise<void> {
    try {
      await writeFile(claimedPath(reqId), daemonId, { mode: 0o600 }).catch(() => undefined);
      const injectText = buildInjectText(envelope);
      const parsedModel = parseFleetModel(envelope.model);
      const body: Record<string, unknown> = {
        parts: [{ type: "text", text: injectText }],
      };
      if (envelope.agent) body["agent"] = envelope.agent;
      if (parsedModel) body["model"] = parsedModel;
      if (envelope.variant) body["variant"] = envelope.variant;
      if (envelope.system) body["system"] = envelope.system;
      // NOTE: never set noReply — the delegation must land as a normal user bubble.
      const beforeTime = Date.now();
      await client.session.promptAsync({ path: { id: sessionID }, body });
      const reply = await pollForReply(beforeTime);
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
      } catch (err) {
        try {
          void client?.app?.log?.({
            body: { service: "fleet-v1", level: "warn", message: `fleet-v1 req ${reqId}: notify write failed: ${toReadableError(err)}` },
          });
        } catch {
          // client.app.log is best-effort.
        }
      }
      log(`fleet-v1 req ${reqId}: DONE:${done}`);
    } catch (err) {
      const text = toReadableError(err);
      try {
        await writeRes(reqId, { ok: false, error: text || `failed to handle req ${reqId}` });
      } catch {
        // writeRes failing must not crash the watcher.
      }
      log(`fleet-v1 req ${reqId} error: ${text}`);
    }
  }

  async function pollForReply(beforeTime: number): Promise<string | null> {
    const deadline = beforeTime + INBOX_RESPONSE_TIMEOUT_MS;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      try {
        const messages = (await client.session.messages({
          path: { id: sessionID },
        })) as Array<{ info: any; parts: any[] }>;
        const text = assistantTextOf(Array.isArray(messages) ? messages : [], beforeTime);
        if (text !== null && doneLineOf(text) !== null) return text;
      } catch (err) {
        log(`fleet-v1 reply poll error: ${toReadableError(err)}`);
      }
      await new Promise((r) => setTimeout(r, Math.min(responsePollMs, Math.max(0, remaining))));
      if (Date.now() >= deadline) return null;
    }
  }

  const handle: InboxWatcherHandle = {
    stop: () => {
      running = false;
      clearInterval(timer);
    },
    isRunning: () => running,
  };
  return handle;
}

/** Stop a watcher handle created by {@link startInboxWatcher}. */
export function stopInboxWatcher(handle: InboxWatcherHandle): void {
  handle.stop();
}

/**
 * Plugin `event` hook helper. Removes our registry entry when our session is
 * deleted; refreshes `updatedAt` on idle as a heartbeat. Best-effort —
 * never throws.
 */
export async function handleSessionEvent(event: any, selfSessionId: string): Promise<void> {
  try {
    const type: unknown = (event as any)?.type;
    const props: any = (event as any)?.properties ?? {};
    const sessionId: unknown =
      props.sessionID ?? props.sessionId ?? (event as any)?.sessionID ?? (event as any)?.sessionId;
    if (typeof type === "string" && type === "session.deleted") {
      if (typeof sessionId === "string" && sessionId === selfSessionId) {
        await removeSession(selfSessionId);
      }
      return;
    }
    if (typeof type === "string" && type === "session.idle") {
      if (typeof sessionId === "string" && sessionId !== selfSessionId) return;
      try {
        const entries = await readRegistry();
        const self = entries.find((e) => e.sessionId === selfSessionId);
        if (!self) return;
        await registerSelf({
          sessionId: self.sessionId,
          daemonId: self.daemonId,
          directory: self.directory,
          ...(self.title !== undefined ? { title: self.title } : {}),
          ...(self.summary !== undefined ? { summary: self.summary } : {}),
          updatedAt: Date.now(),
        });
      } catch {
        // Heartbeat is best-effort.
      }
    }
  } catch {
    // Never throw out of an event hook.
  }
}

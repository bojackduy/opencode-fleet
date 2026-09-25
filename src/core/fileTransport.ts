/**
 * fileTransport.ts — file-spool transport for fleet.
 *
 * Layout under the v1-namespaced state dir:
 *   $XDG_STATE_HOME/opencode/fleet/messages/<reqId>.req.json
 *   $XDG_STATE_HOME/opencode/fleet/messages/<reqId>.res.json
 *   (fallback ~/.local/state/opencode/fleet/ when XDG_STATE_HOME is unset)
 *
 * Envelope carries everything Phase 2 needs to replay a delegation as a
 * normal user message via prompt_async: agent / model / variant / system.
 * Every delegated message must stay self-contained (goal + files +
 * constraints + done-criteria + DONE: instruction).
 */

import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureStateMigrated } from "./registry.js";

/** Model reference: structured form or "provider/model" shorthand. */
export interface FleetModel {
  providerID: string;
  modelID: string;
}

export interface FleetEnvelope {
  reqId: string;
  /** Commander session id that issued the request. */
  fromCommander: string;
  targetSessionId: string;
  /** Owning daemon; InboxWatcher only picks up reqs for its own daemonId. */
  targetDaemonId?: string;
  /** Self-contained task text (includes DONE: instruction). */
  message: string;
  /** Optional replay hints for prompt_async (used in Phase 2). */
  agent?: string;
  model?: FleetModel | string;
  variant?: string;
  system?: string;
  /** Epoch millis when the request was written. */
  createdAt: number;
  /** P5 loop guard: forward hops so far (default 0). Refuse hop > MAX_HOPS. */
  hop?: number;
}

export interface FleetResult {
  ok: boolean;
  reply?: string;
  error?: string;
}

/** Poll cadence for response files (commander side). */
export const RESPONSE_POLL_MS = 500;
/** Poll cadence for inbox scans (worker InboxWatcher, Phase 2). */
export const INBOX_POLL_MS = 1000;
/** P5 loop guard: max forward hops before a delegation is refused. */
export const MAX_HOPS = 3;

/** Hop count of an envelope; missing/invalid reads as 0. Never throws. */
export function hopOf(envelope: Pick<FleetEnvelope, "hop"> | null | undefined): number {
  try {
    const h = (envelope as { hop?: unknown } | null | undefined)?.hop;
    if (typeof h === "number" && Number.isFinite(h) && h >= 0) return Math.floor(h);
    return 0;
  } catch {
    return 0;
  }
}

/** True when the envelope exceeded MAX_HOPS. Never throws. */
export function isHopExceeded(envelope: Pick<FleetEnvelope, "hop"> | null | undefined): boolean {
  try {
    return hopOf(envelope) > MAX_HOPS;
  } catch {
    return false;
  }
}

/** Next hop count when forwarding an envelope (hop + 1). Never throws. */
export function nextHop(envelope: Pick<FleetEnvelope, "hop"> | null | undefined): number {
  try {
    return hopOf(envelope) + 1;
  } catch {
    return 1;
  }
}

/** Readable loop-guard refusal text. Never throws. */
export function loopGuardText(reqId: string, hop: number): string {
  try {
    const id = String(reqId ?? "").trim() || "(unknown req)";
    return `loop guard: max ${MAX_HOPS} hops (req ${id} hop=${hop})`;
  } catch {
    return `loop guard: max ${MAX_HOPS} hops`;
  }
}

/** Extract `Re: <reqId>` chain refs from a message body. Never throws. */
export function chainRefsOf(message: string): string[] {
  try {
    const out: string[] = [];
    const re = /Re:\s*([A-Za-z0-9._-]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(message ?? "")) !== null) {
      const ref = (m[1] ?? "").trim();
      if (ref !== "" && !out.includes(ref)) out.push(ref);
    }
    return out;
  } catch {
    return [];
  }
}

export function stateDir(): string {
  const xdg = process.env.XDG_STATE_HOME;
  if (xdg && xdg.trim() !== "") return join(xdg, "opencode", "fleet");
  return join(homedir(), ".local", "state", "opencode", "fleet");
}

export function messagesDir(): string {
  return join(stateDir(), "messages");
}

export function reqPath(reqId: string): string {
  return join(messagesDir(), `${reqId}.req.json`);
}

export function resPath(reqId: string): string {
  return join(messagesDir(), `${reqId}.res.json`);
}

export async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  await ensureStateMigrated();
  await mkdir(messagesDir(), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, filePath);
  await chmod(filePath, 0o600);
}

/** Sleep that rejects early when the abort signal fires. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortedError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(abortedError());
    };
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortedError(): Error {
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}

/** Write a request envelope (<reqId>.req.json). */
export async function writeReq(reqId: string, envelope: FleetEnvelope): Promise<void> {
  await atomicWriteJson(reqPath(reqId), envelope);
}

/** Write a response (<reqId>.res.json). */
export async function writeRes(reqId: string, result: FleetResult): Promise<void> {
  await atomicWriteJson(resPath(reqId), result);
}

export interface ReadResOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

/**
 * Poll for <reqId>.res.json until it appears or timeoutMs elapses.
 * Returns null on timeout. Throws AbortError when signal aborts.
 */
export async function readRes(reqId: string, timeoutMs: number, signal?: AbortSignal): Promise<FleetResult | null> {
  await ensureStateMigrated();
  const path = resPath(reqId);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) throw abortedError();
    try {
      const raw = await readFile(path, "utf8");
      return JSON.parse(raw) as FleetResult;
    } catch (err) {
      if (isAbortError(err)) throw err;
      // ENOENT / corrupt JSON: keep polling until the deadline.
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    await abortableSleep(Math.min(RESPONSE_POLL_MS, remaining), signal);
  }
}

/** Read a request envelope once; null when absent/unreadable. */
export async function readReq(reqId: string): Promise<FleetEnvelope | null> {
  try {
    await ensureStateMigrated();
    const raw = await readFile(reqPath(reqId), "utf8");
    return JSON.parse(raw) as FleetEnvelope;
  } catch {
    return null;
  }
}

/** Best-effort cleanup of a request/response pair after the caller read the result. */
export async function cleanupReq(reqId: string): Promise<void> {
  await Promise.allSettled([unlink(reqPath(reqId)), unlink(resPath(reqId))]);
}

function isAbortError(err: unknown): err is Error {
  return err instanceof Error && err.name === "AbortError";
}

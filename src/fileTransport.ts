/**
 * fileTransport.ts — file-spool transport for fleet-v1.
 *
 * Layout under the v1-namespaced state dir:
 *   $XDG_STATE_HOME/opencode/fleet-v1/messages/<reqId>.req.json
 *   $XDG_STATE_HOME/opencode/fleet-v1/messages/<reqId>.res.json
 *   (fallback ~/.local/state/opencode/fleet-v1/ when XDG_STATE_HOME is unset)
 *
 * Envelope carries everything Phase 2 needs to replay a delegation as a
 * normal user message via prompt_async: agent / model / variant / system.
 * Every delegated message must stay self-contained (goal + files +
 * constraints + done-criteria + DONE: instruction).
 */

import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

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

export function stateDir(): string {
  const xdg = process.env.XDG_STATE_HOME;
  if (xdg && xdg.trim() !== "") return join(xdg, "opencode", "fleet-v1");
  return join(homedir(), ".local", "state", "opencode", "fleet-v1");
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

/**
 * notify.ts — P3 DONE notifications for fleet.
 *
 * After the inbox watcher writes `<reqId>.res.json` with ok:true (DONE line
 * found), it also writes `<reqId>.notify.json` so the commander side can
 * poll/list completions without re-reading every `.res.json`:
 *
 *   { reqId, targetSessionId, fromCommander, done, replySnippet, createdAt }
 *
 * All helpers are best-effort and never throw — notify must never break
 * the inbox write path. Files are 0600 via atomicWriteJson.
 */

import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteJson, messagesDir } from "./fileTransport.js";
import type { FleetEnvelope } from "./fileTransport.js";

export interface FleetNotify {
  reqId: string;
  targetSessionId: string;
  fromCommander: string;
  done: string;
  replySnippet: string;
  createdAt: number;
}

export function notifyPath(reqId: string): string {
  return join(messagesDir(), `${reqId}.notify.json`);
}

function doneLineOf(text: string): string | null {
  const re = /^DONE:\s*(.+?)\s*$/gm;
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) last = m[1];
  return last;
}

function snippetOf(text: string, max = 200): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max)}…`;
}

/**
 * Write `<reqId>.notify.json` for a successful DONE reply.
 * Best-effort — never throws.
 */
export async function writeNotify(
  reqId: string,
  envelope: FleetEnvelope,
  reply: string,
): Promise<void> {
  try {
    const done = (doneLineOf(reply ?? "") ?? "").trim();
    const note: FleetNotify = {
      reqId,
      targetSessionId: envelope?.targetSessionId ?? "",
      fromCommander: envelope?.fromCommander ?? "",
      done,
      replySnippet: snippetOf(reply ?? ""),
      createdAt: Date.now(),
    };
    await atomicWriteJson(notifyPath(reqId), note);
  } catch {
    // best-effort only — notify must never break the inbox path.
  }
}

/** Read one notification; null when absent/unreadable. Never throws. */
export async function readNotify(reqId: string): Promise<FleetNotify | null> {
  try {
    const raw = await readFile(notifyPath(reqId), "utf8");
    const parsed = JSON.parse(raw) as FleetNotify;
    if (typeof parsed !== "object" || parsed === null) return null;
    if (typeof parsed.reqId !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export interface ListNotificationsOptions {
  sinceMs?: number;
  limit?: number;
}

function clampLimit(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : NaN;
  if (Number.isNaN(n)) return 20;
  if (n < 1) return 1;
  if (n > 100) return 100;
  return n;
}

/**
 * List notifications newest-first (read-only). Per-file try/catch —
 * one corrupt file never fails the listing. Never throws.
 */
export async function listNotifications(
  sinceMs?: number,
  limit = 20,
): Promise<FleetNotify[]> {
  try {
    const lim = clampLimit(limit);
    let files: string[];
    try {
      files = await readdir(messagesDir());
    } catch {
      return [];
    }
    const out: FleetNotify[] = [];
    for (const f of files) {
      if (!f.endsWith(".notify.json")) continue;
      try {
        const raw = await readFile(join(messagesDir(), f), "utf8");
        const parsed = JSON.parse(raw) as FleetNotify;
        if (typeof parsed !== "object" || parsed === null) continue;
        if (typeof parsed.reqId !== "string") continue;
        if (typeof sinceMs === "number" && Number.isFinite(sinceMs)) {
          const created = typeof parsed.createdAt === "number" ? parsed.createdAt : 0;
          if (created < sinceMs) continue;
        }
        out.push(parsed);
      } catch {
        // skip unreadable/corrupt files
      }
    }
    out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    return out.slice(0, lim);
  } catch {
    return [];
  }
}

/** Best-effort removal of `<reqId>.notify.json`. Never throws. */
export async function clearNotify(reqId: string): Promise<void> {
  try {
    await unlink(notifyPath(reqId));
  } catch {
    // best-effort
  }
}

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

import { chmod, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicWriteJson, messagesDir } from "./fileTransport.js";
import type { FleetEnvelope } from "./fileTransport.js";
import { ensureStateMigrated, stateDir, withStateLock } from "./registry.js";

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

export interface RosterChange {
  kind: "roster";
  change: "join" | "leave" | "role";
  sessionId: string;
  title: string;
  directory: string;
  at: number;
}

function sanitizeSessionId(raw: unknown): string {
  try {
    const s = String(raw ?? "").trim().replace(/[^A-Za-z0-9._-]+/g, "_");
    return s === "" ? "unknown" : s.slice(0, 80);
  } catch {
    return "unknown";
  }
}

/**
 * Write a roster-change notification (`roster-<at>-<sessionId>.notify.json`):
 * {kind:"roster", change:"join"|"leave"|"role", sessionId, title, directory, at}.
 * Best-effort — never throws. Files are 0600 via atomicWriteJson.
 */
export async function writeRosterNotify(
  change: RosterChange["change"],
  info: { sessionId: string; title?: string; directory?: string; at?: number },
): Promise<void> {
  try {
    const at =
      typeof info?.at === "number" && Number.isFinite(info.at) ? info.at : Date.now();
    const sessionId = String(info?.sessionId ?? "");
    if (sessionId.trim() === "") return;
    if (change !== "join" && change !== "leave" && change !== "role") return;
    const note: RosterChange = {
      kind: "roster",
      change,
      sessionId,
      title: String(info?.title ?? ""),
      directory: String(info?.directory ?? ""),
      at,
    };
    const name = `roster-${at}-${sanitizeSessionId(sessionId)}.notify.json`;
    await atomicWriteJson(join(messagesDir(), name), note);
  } catch {
    // best-effort only — roster notify must never break the event path.
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

// ---- Phase A: durable per-commander assignment event journal ----
//
// One journal per commander, keyed by the composite commander key
// (runtime, daemonId, sessionId). Only the affected commander(s) get
// events — never a broadcast to every commander.
//
//   $XDG_STATE_HOME/opencode/fleet/assignment-events/<commander>.events.json
//   $XDG_STATE_HOME/opencode/fleet/assignment-events/<commander>.cursor.json
//
// Event ids are zero-padded `<at>-<seq>` so they sort chronologically and
// stay unique + ordered across same-millisecond appends (seq is assigned
// under the cross-process lock). The cursor/ack file records the last
// processed event id; reads return only unacked events oldest-first.
// Acknowledged events are pruned beyond MAX_RETAINED_ACKED (unacked events
// are never pruned). All files are 0600, atomic temp+rename. Next phase
// wires adapters + fleet_watch to this journal; existing notifications
// above are untouched.

/** Assignment lifecycle event types (idle/done/role reserved for next phase). */
export type AssignmentEventType = "join" | "leave" | "idle" | "done" | "role" | "transfer";

export interface AssignmentEvent {
  /** Zero-padded `<at>-<seq>`: unique + chronologically ordered. */
  id: string;
  commanderKey: string;
  workerKey: string;
  /** assignments.json generation stamped at emit time. */
  generation: number;
  type: AssignmentEventType;
  at: number;
  /** Short human note only (truncated to 200 chars). */
  data: string;
}

export interface AssignmentCursor {
  ackedId: string;
  ackedAt: number;
}

/** Acked events retained per commander; unacked events are never pruned. */
export const MAX_RETAINED_ACKED = 200;

function isAssignmentEventType(v: unknown): v is AssignmentEventType {
  return (
    v === "join" ||
    v === "leave" ||
    v === "idle" ||
    v === "done" ||
    v === "role" ||
    v === "transfer"
  );
}

function isValidAssignmentEvent(v: unknown): v is AssignmentEvent {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o["id"] === "string" &&
    typeof o["commanderKey"] === "string" &&
    typeof o["workerKey"] === "string" &&
    typeof o["generation"] === "number" &&
    Number.isFinite(o["generation"]) &&
    isAssignmentEventType(o["type"]) &&
    typeof o["at"] === "number" &&
    Number.isFinite(o["at"]) &&
    typeof o["data"] === "string"
  );
}

function assignmentEventsDir(): string {
  return join(stateDir(), "assignment-events");
}

function safeSegment(raw: unknown): string {
  try {
    const s = String(raw ?? "").trim().replace(/[^A-Za-z0-9._-]+/g, "_");
    return (s === "" ? "unknown" : s).slice(0, 120);
  } catch {
    return "unknown";
  }
}

/** Filename base for one commander's journal, derived from its composite key. */
export function commanderJournalBase(commanderKey: string): string {
  try {
    const parts = String(commanderKey ?? "").split("\u0000");
    return `${safeSegment(parts[0])}__${safeSegment(parts[1])}__${safeSegment(parts[2])}`;
  } catch {
    return "unknown__unknown__unknown";
  }
}

function commanderEventsPath(commanderKey: string): string {
  return join(assignmentEventsDir(), `${commanderJournalBase(commanderKey)}.events.json`);
}

function commanderCursorPath(commanderKey: string): string {
  return join(assignmentEventsDir(), `${commanderJournalBase(commanderKey)}.cursor.json`);
}

/** Exported for tests/tools: journal file paths for one commander. Never throws. */
export function assignmentJournalPaths(commanderKey: string): {
  eventsPath: string;
  cursorPath: string;
} {
  try {
    return {
      eventsPath: commanderEventsPath(commanderKey),
      cursorPath: commanderCursorPath(commanderKey),
    };
  } catch {
    return {
      eventsPath: join(assignmentEventsDir(), "unknown.events.json"),
      cursorPath: join(assignmentEventsDir(), "unknown.cursor.json"),
    };
  }
}

async function writeJournalJson(filePath: string, data: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, filePath);
  await chmod(filePath, 0o600);
}

async function readJournalEvents(commanderKey: string): Promise<AssignmentEvent[] | null> {
  try {
    await ensureStateMigrated();
    const raw = await readFile(commanderEventsPath(commanderKey), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(isValidAssignmentEvent);
  } catch (err) {
    if ((err as { code?: unknown })?.code === "ENOENT") return [];
    return null;
  }
}

async function readJournalCursor(commanderKey: string): Promise<AssignmentCursor | null> {
  try {
    const raw = await readFile(commanderCursorPath(commanderKey), "utf8");
    const parsed = JSON.parse(raw) as Partial<AssignmentCursor>;
    if (typeof parsed !== "object" || parsed === null) return null;
    if (typeof parsed.ackedId !== "string" || parsed.ackedId === "") return null;
    return {
      ackedId: parsed.ackedId,
      ackedAt: typeof parsed.ackedAt === "number" ? parsed.ackedAt : 0,
    };
  } catch {
    return null;
  }
}

export interface AppendAssignmentEventInput {
  workerKey: string;
  generation: number;
  type: AssignmentEventType;
  data?: string;
  /** Override "now" (epoch millis) for tests. Default Date.now(). */
  at?: number;
}

/**
 * Append one event to a commander's journal (cross-process serialized).
 * Returns the stored event, or null when the input is invalid or the
 * journal is unreadable/corrupt (never clobbers a corrupt journal).
 * Never throws.
 */
export async function appendAssignmentEvent(
  commanderKey: string,
  input: AppendAssignmentEventInput,
): Promise<AssignmentEvent | null> {
  try {
    const key = String(commanderKey ?? "");
    const workerKey = String(input?.workerKey ?? "");
    if (key === "" || workerKey === "") return null;
    if (!isAssignmentEventType(input?.type)) return null;
    const generation =
      typeof input?.generation === "number" && Number.isFinite(input.generation)
        ? Math.floor(input.generation)
        : 0;
    const at =
      typeof input?.at === "number" && Number.isFinite(input.at) ? Math.floor(input.at) : Date.now();
    const data = String(input?.data ?? "").slice(0, 200);
    return await withStateLock(async () => {
      const existing = await readJournalEvents(key);
      if (existing === null) return null;
      let seq = 0;
      for (const e of existing) {
        const m = /^(\d+)-(\d+)$/.exec(e.id);
        if (m && Number(m[1]) === at) seq = Math.max(seq, Number(m[2]) + 1);
      }
      const event: AssignmentEvent = {
        id: `${String(at).padStart(13, "0")}-${String(seq).padStart(4, "0")}`,
        commanderKey: key,
        workerKey,
        generation,
        type: input.type,
        at,
        data,
      };
      const next = [...existing, event].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      await writeJournalJson(commanderEventsPath(key), next);
      return event;
    });
  } catch {
    return null;
  }
}

export type AssignmentJournalStatus = "ok" | "missing" | "corrupt" | "error";

export interface AssignmentEventsRead {
  /** Unacked events oldest-first (capped by limit). */
  events: AssignmentEvent[];
  /** Last acked cursor, if any. */
  cursor: AssignmentCursor | null;
  /** Total unacked events (before the limit cap). */
  total: number;
  /** Journal readability: missing = no journal yet (empty, not an error). */
  status: AssignmentJournalStatus;
  error?: string;
}

/**
 * Read a commander's unacked events oldest-first (explicit ack required
 * via ackAssignmentEvent). Lock-free read: writers use atomic rename so a
 * read always sees a whole file. Fail-closed: a corrupt/unreadable journal
 * reports status corrupt/error (never a misleading empty ok). Never throws.
 */
export async function readAssignmentEvents(
  commanderKey: string,
  limit = 100,
): Promise<AssignmentEventsRead> {
  try {
    const key = String(commanderKey ?? "");
    if (key === "") return { events: [], cursor: null, total: 0, status: "ok" };
    const lim =
      typeof limit === "number" && Number.isFinite(limit)
        ? Math.min(Math.max(Math.floor(limit), 1), 500)
        : 100;
    // Distinguish missing (no journal yet) from corrupt/unreadable.
    let journalStatus: AssignmentJournalStatus = "ok";
    let journalError: string | undefined;
    try {
      await ensureStateMigrated();
      await readFile(commanderEventsPath(key), "utf8");
    } catch (err) {
      if ((err as { code?: unknown })?.code === "ENOENT") {
        journalStatus = "missing";
      } else {
        return {
          events: [],
          cursor: null,
          total: 0,
          status: "error",
          error: "assignment event journal unreadable; refusing (fail-closed)",
        };
      }
    }
    if (journalStatus === "missing") {
      const cursor = await readJournalCursor(key);
      return { events: [], cursor, total: 0, status: "missing" };
    }
    // Journal file exists: parse strictly to detect corruption.
    try {
      const raw = await readFile(commanderEventsPath(key), "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return {
          events: [],
          cursor: null,
          total: 0,
          status: "corrupt",
          error: "assignment event journal corrupt (top-level must be an array); refusing (fail-closed)",
        };
      }
    } catch {
      return {
        events: [],
        cursor: null,
        total: 0,
        status: "corrupt",
        error: "assignment event journal corrupt (invalid JSON); refusing (fail-closed)",
      };
    }
    void journalError;
    const [events, cursor] = await Promise.all([
      readJournalEvents(key),
      readJournalCursor(key),
    ]);
    if (events === null) return { events: [], cursor, total: 0, status: "corrupt", error: "assignment event journal corrupt; refusing (fail-closed)" };
    let unacked = events;
    if (cursor) {
      const idx = events.findIndex((e) => e.id === cursor.ackedId);
      unacked = idx >= 0 ? events.slice(idx + 1) : events;
    }
    return { events: unacked.slice(0, lim), cursor, total: unacked.length, status: "ok" };
  } catch {
    return { events: [], cursor: null, total: 0, status: "error", error: "assignment event journal unreadable; refusing (fail-closed)" };
  }
}

/**
 * Ack a commander's journal up to (including) eventId. Prunes acked events
 * beyond MAX_RETAINED_ACKED; unacked events are never pruned. Returns false
 * when the event id is unknown (cursor untouched). Never throws.
 */
export async function ackAssignmentEvent(
  commanderKey: string,
  eventId: string,
): Promise<boolean> {
  try {
    const key = String(commanderKey ?? "");
    const id = String(eventId ?? "");
    if (key === "" || id === "") return false;
    return await withStateLock(async () => {
      const existing = await readJournalEvents(key);
      if (existing === null) return false;
      const idx = existing.findIndex((e) => e.id === id);
      if (idx < 0) return false;
      const acked = existing.slice(0, idx + 1);
      const unacked = existing.slice(idx + 1);
      const kept = acked.slice(-MAX_RETAINED_ACKED);
      const next = [...kept, ...unacked];
      await writeJournalJson(commanderCursorPath(key), {
        ackedId: id,
        ackedAt: Date.now(),
      });
      if (next.length !== existing.length) {
        await writeJournalJson(commanderEventsPath(key), next);
      }
      return true;
    });
  } catch {
    return false;
  }
}

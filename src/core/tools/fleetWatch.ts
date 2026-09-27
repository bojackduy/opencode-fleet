/**
 * fleetWatch.ts — P6 `fleet_watch` subscribe primitive.
 *
 * The roster (registry.json) is passive: without this tool the commander
 * must blind-poll. `fleet_watch` blocks up to `timeoutMs` waiting for roster
 * change notifications (join/leave/role) plus DONE completion notifications
 * newer than `since`, then returns compact lines. A `fleet_watch` loop
 * replaces blind polling. Never throws — failures render as readable text.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "../toolDef.js";
import type { ToolDef } from "../toolDef.js";
import { abortableSleep, messagesDir } from "../fileTransport.js";

function toReadableError(err: unknown): string {
  if (err instanceof Error) return err.message || String(err);
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function clampTimeout(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : NaN;
  if (Number.isNaN(n)) return 30_000;
  if (n < 0) return 0;
  if (n > 120_000) return 120_000;
  return n;
}

function clampSince(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : NaN;
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  return n;
}

interface WatchEvent {
  at: number;
  line: string;
}

/** One scan: roster + DONE .notify.json files newer than `since`, oldest-first. */
async function scanNotifies(since: number): Promise<WatchEvent[]> {
  try {
    let files: string[];
    try {
      files = await readdir(messagesDir());
    } catch {
      return [];
    }
    const out: WatchEvent[] = [];
    for (const f of files) {
      if (!f.endsWith(".notify.json")) continue;
      let parsed: Record<string, unknown>;
      try {
        const raw = await readFile(join(messagesDir(), f), "utf8");
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (parsed === null || typeof parsed !== "object") continue;
      try {
        if (parsed["kind"] === "roster") {
          const at = typeof parsed["at"] === "number" ? (parsed["at"] as number) : 0;
          if (at < since) continue;
          const change = String(parsed["change"] ?? "?");
          const sessionId = String(parsed["sessionId"] ?? "?");
          const title = String(parsed["title"] ?? "");
          const dir = String(parsed["directory"] ?? "");
          const tail = [title, dir].filter((s) => s !== "").join(" | ");
          out.push({
            at,
            line: `roster ${change} ${sessionId} ${at}${tail !== "" ? ` ${tail}` : ""}`,
          });
        } else if (typeof parsed["reqId"] === "string") {
          const at =
            typeof parsed["createdAt"] === "number" ? (parsed["createdAt"] as number) : 0;
          if (at < since) continue;
          const reqId = String(parsed["reqId"] ?? "?");
          const target = String(parsed["targetSessionId"] ?? "?");
          const done = String(parsed["done"] ?? "");
          out.push({ at, line: `done ${reqId} ${target} ${at}${done !== "" ? ` DONE:${done}` : ""}` });
        }
      } catch {
        // skip malformed entries
      }
    }
    out.sort((a, b) => a.at - b.at || a.line.localeCompare(b.line));
    return out;
  } catch {
    return [];
  }
}

export async function fleetWatchHandler(args: unknown, context: unknown): Promise<string> {
  void context;
  try {
    const a = (args ?? {}) as { since?: unknown; timeoutMs?: unknown };
    const since = clampSince(a.since);
    const timeoutMs = clampTimeout(a.timeoutMs);
    const abort = (context as { abort?: AbortSignal } | null)?.abort;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (abort?.aborted) return "fleet_watch aborted";
      const events = await scanNotifies(since);
      if (events.length > 0) {
        const capped = events.slice(0, 50);
        return capped.map((e) => e.line).join("\n");
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return "no new fleet events";
      try {
        await abortableSleep(Math.min(1000, remaining), abort);
      } catch {
        return "fleet_watch aborted";
      }
    }
  } catch (err) {
    return `fleet_watch failed: ${toReadableError(err)}`;
  }
}

export const fleetWatchDef: ToolDef = {
  name: "fleet_watch",
  description:
    "Subscribe to fleet roster + DONE notifications: blocks up to timeoutMs for roster (.notify.json join/leave/role) and DONE events newer than since (epoch-ms). Replaces blind polling.",
  args: {
    since: z
      .number()
      .optional()
      .describe("Only events at/after this epoch-ms timestamp (default 0)"),
    timeoutMs: z
      .number()
      .optional()
      .describe("Max time to block waiting for events (default 30000, max 120000)"),
  },
  run: (args, callCtx) => fleetWatchHandler(args, callCtx),
};

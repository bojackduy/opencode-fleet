/**
 * fleetStatus.ts — Phase 3 `fleet_status` tool.
 *
 * Polls `client.session.status()` plus the last few `client.session.messages()`
 * per worker, extracts the trailing `DONE:` line, and renders a compact table.
 * Per-row failures are captured as readable cells — the tool never throws.
 */

import { tool } from "@opencode-ai/plugin";
import { listRegistry } from "../registry.js";

export interface FleetToolDeps {
  // biome-ignore lint/suspicious/noExplicitAny: v1 plugin client is untyped at the boundary.
  client?: any;
  serverUrl?: string | URL;
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

/** Last `DONE:<...>` line in a text blob, or null when absent. */
function doneLineOf(text: string): string | null {
  const re = /^DONE:\s*(.+?)\s*$/gm;
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) last = m[1];
  return last;
}

/** Most recent assistant text across session messages (newest last). */
function lastAssistantText(messages: any[]): string {
  let latest = "";
  for (const m of messages ?? []) {
    const info = m?.info as any;
    if (!info || info.role !== "assistant") continue;
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

function oneLineSnippet(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "") return "-";
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Best-effort status string for one session out of the status map. */
function statusOf(statusMap: any, sessionId: string): string {
  try {
    const v = statusMap?.[sessionId] ?? statusMap?.[sessionId.replace(/-/g, "")];
    if (v === undefined || v === null) return "unknown";
    if (typeof v === "string") return v;
    if (typeof v === "object") {
      const cand = (v as any).type ?? (v as any).status ?? (v as any).state;
      if (typeof cand === "string" && cand !== "") return cand;
      return "unknown";
    }
    return String(v);
  } catch {
    return "unknown";
  }
}

export async function fleetStatusHandler(
  args: any,
  _context: any,
  deps?: FleetToolDeps,
): Promise<string> {
  void _context;
  try {
    const client = deps?.client;
    if (!client) return "fleet_status failed: no client available";

    const requested = Array.isArray(args?.sessionIds)
      ? (args.sessionIds as unknown[]).filter((s): s is string => typeof s === "string" && s !== "")
      : [];
    const ids =
      requested.length > 0
        ? requested
        : (await listRegistry({ includeSelf: true })).map((e) => e.sessionId);
    if (ids.length === 0) return "no workers registered";

    let statusMap: any = {};
    try {
      statusMap = (await client.session.status()) ?? {};
    } catch (err) {
      return `fleet_status failed: session.status: ${toReadableError(err)}`;
    }

    const rows = await Promise.all(
      ids.map(async (id): Promise<string> => {
        try {
          const status = statusOf(statusMap, id);
          let messages: any[] = [];
          try {
            const res = await client.session.messages({ path: { id }, query: { limit: 5 } });
            messages = Array.isArray(res) ? res : [];
          } catch (err) {
            return `${id} | ${status} | - | messages error: ${toReadableError(err)}`;
          }
          const lastText = lastAssistantText(messages);
          const done = lastText !== "" ? (doneLineOf(lastText) ?? "-") : "-";
          return `${id} | ${status} | ${done} | ${oneLineSnippet(lastText)}`;
        } catch (err) {
          return `${id} | error | - | ${toReadableError(err)}`;
        }
      }),
    );
    return ["sessionId | status | lastDONE | lastMsgSnippet", ...rows].join("\n");
  } catch (err) {
    return `fleet_status failed: ${toReadableError(err)}`;
  }
}

export function makeFleetStatusTool(deps?: FleetToolDeps) {
  return tool({
    description:
      "Show live status per fleet worker: session status, trailing DONE: line, and last assistant message snippet.",
    args: {
      sessionIds: tool.schema
        .array(tool.schema.string())
        .optional()
        .describe("Session ids to check; defaults to all registered workers"),
    },
    execute: async (args, context) => fleetStatusHandler(args, context, deps),
  });
}

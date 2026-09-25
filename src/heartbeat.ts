/**
 * heartbeat.ts — P4 client heartbeat via v1 API only.
 *
 * Builds a rich registry entry for one session using ONLY the v1 plugin
 * client (`client.session.get` / `status` / `messages`) plus
 * `getDaemonId(serverUrl)`. No subprocess spawns, no DB reads, no ps/lsof.
 * Never throws — every API call is individually try/caught and falls back
 * to readable defaults.
 */

import { getDaemonId } from "./inbox.js";
import { resolveRole } from "./roles.js";
import type { Role } from "./roles.js";

export interface BeatInput {
  // biome-ignore lint/suspicious/noExplicitAny: v1 plugin client is untyped at the boundary.
  client: any;
  sessionID: string;
  serverUrl: string | URL;
  directory: string;
}

export interface Heartbeat {
  sessionId: string;
  daemonId: string;
  directory: string;
  title: string;
  agent: string;
  model: string;
  status: string;
  lastDone: string;
  updatedAt: number;
  /** P5: resolved role (fork with parentID is always "worker"). */
  role: Role;
  /** P5: parent session id (fork chain); "" when top-level. */
  parentID: string;
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

/** Unwrap SDK RequestResult ({data,error}) or a raw payload. */
function unwrap<T>(raw: unknown): T {
  try {
    if (raw !== null && typeof raw === "object" && "data" in (raw as Record<string, unknown>)) {
      return (raw as { data: T }).data as T;
    }
  } catch {
    // fall through to raw
  }
  return raw as T;
}

/** Last `DONE:<...>` line in a text blob, or "" when absent. */
export function doneLineOf(text: string): string {
  try {
    const re = /^DONE:\s*(.+?)\s*$/gm;
    let last = "";
    let m: RegExpExecArray | null;
    while ((m = re.exec(text ?? "")) !== null) last = (m[1] ?? "").trim();
    return last;
  } catch {
    return "";
  }
}

function assistantTextOf(messages: unknown): string {
  try {
    const list = Array.isArray(messages) ? messages : [];
    let latest = "";
    for (const m of list) {
      const info = (m as { info?: unknown })?.info as { role?: unknown } | null;
      if (!info || info.role !== "assistant") continue;
      const parts = (m as { parts?: unknown })?.parts;
      if (!Array.isArray(parts)) continue;
      const texts: string[] = [];
      for (const p of parts) {
        const part = p as { type?: unknown; text?: unknown } | null;
        if (part && part.type === "text" && typeof part.text === "string") texts.push(part.text);
      }
      if (texts.length > 0) latest = texts.join("\n");
    }
    return latest;
  } catch {
    return "";
  }
}

function userAgentModelOf(messages: unknown): { agent: string; model: string } {
  try {
    const list = Array.isArray(messages) ? messages : [];
    let agent = "";
    let model = "";
    for (const m of list) {
      const info = (m as { info?: unknown })?.info as {
        role?: unknown;
        agent?: unknown;
        model?: unknown;
      } | null;
      if (!info || info.role !== "user") continue;
      if (typeof info.agent === "string" && info.agent !== "") agent = info.agent;
      const mo = info.model as { providerID?: unknown; modelID?: unknown } | string | null;
      if (typeof mo === "string" && mo !== "") model = mo;
      else if (mo && typeof mo === "object") {
        const p = typeof mo.providerID === "string" ? mo.providerID : "";
        const mid = typeof mo.modelID === "string" ? mo.modelID : "";
        if (p !== "" && mid !== "") model = `${p}/${mid}`;
        else if (mid !== "") model = mid;
      }
    }
    return { agent, model };
  } catch {
    return { agent: "", model: "" };
  }
}

function statusTextOf(statusMap: unknown, sessionId: string): string {
  try {
    if (statusMap === null || statusMap === undefined) return "unknown";
    const m = statusMap as Record<string, unknown>;
    const v = m[sessionId] ?? m[sessionId.replace(/-/g, "")];
    if (v === undefined || v === null) {
      // Some daemons return a single status object instead of a map.
      if (typeof m["type"] === "string") return String(m["type"]);
      return "unknown";
    }
    if (typeof v === "string") return v;
    if (typeof v === "object") {
      const cand =
        (v as Record<string, unknown>)["type"] ??
        (v as Record<string, unknown>)["status"] ??
        (v as Record<string, unknown>)["state"];
      if (typeof cand === "string" && cand !== "") return cand;
      return "unknown";
    }
    return String(v);
  } catch {
    return "unknown";
  }
}

/**
 * Best-effort parent session id from a `client.session.get` payload.
 * Checks the common key spellings (parentID / parentId / parent_id /
 * parentSessionID / ...), including one nested `info` level. Pure API
 * data — never sqlite, never subprocess. Never throws.
 */
export function parentIdOf(payload: unknown): string {
  try {
    if (payload === null || typeof payload !== "object") return "";
    const obj = payload as Record<string, unknown>;
    const keys = [
      "parentID",
      "parentId",
      "parent_id",
      "parentSessionID",
      "parentSessionId",
      "parent_session_id",
    ];
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === "string" && v.trim() !== "") return v.trim();
    }
    const info = obj["info"];
    if (info !== null && typeof info === "object") {
      const inner = info as Record<string, unknown>;
      for (const k of keys) {
        const v = inner[k];
        if (typeof v === "string" && v.trim() !== "") return v.trim();
      }
    }
    return "";
  } catch {
    return "";
  }
}

/**
 * Fallback parent discovery via the v1 API only: when `client.session.list`
 * exists, scan the live session list for our id and read its parent keys.
 * Never sqlite, never subprocess. Never throws — "" when unavailable.
 */
async function discoverParentIdViaApi(client: unknown, sessionId: string): Promise<string> {
  try {
    const c = client as {
      session?: { list?: (args?: unknown) => Promise<unknown> };
    } | null;
    if (typeof c?.session?.list !== "function") return "";
    const raw = await c.session.list().catch(() => null);
    const data = unwrap<unknown>(raw);
    const list = Array.isArray(data)
      ? data
      : ((data as Record<string, unknown> | null)?.["sessions"] as unknown) ??
        ((data as Record<string, unknown> | null)?.["data"] as unknown) ??
        [];
    if (!Array.isArray(list)) return "";
    for (const item of list) {
      try {
        const o = item as Record<string, unknown>;
        const id =
          typeof o["id"] === "string"
            ? (o["id"] as string)
            : typeof o["sessionID"] === "string"
              ? (o["sessionID"] as string)
              : typeof o["sessionId"] === "string"
                ? (o["sessionId"] as string)
                : "";
        if (id !== sessionId) continue;
        const p = parentIdOf(o);
        if (p !== "") return p;
      } catch {
        // keep scanning
      }
    }
    return "";
  } catch {
    return "";
  }
}

async function appLog(client: unknown, message: string): Promise<void> {
  try {
    const c = client as { app?: { log?: (args: unknown) => Promise<unknown> } } | null;
    await c?.app?.log?.({ body: { service: "fleet-v1", level: "info", message } });
  } catch {
    // best-effort only
  }
}

/**
 * Build a heartbeat for one session via the v1 API only.
 * Never throws — failures yield readable fallbacks.
 */
export async function beat(input: BeatInput): Promise<Heartbeat> {
  const sessionId = String(input?.sessionID ?? "");
  const directory = String(input?.directory ?? "");
  let daemonId = "";
  try {
    daemonId = getDaemonId(String(input?.serverUrl ?? ""));
  } catch {
    daemonId = String(input?.serverUrl ?? "");
  }
  const fallback: Heartbeat = {
    sessionId,
    daemonId,
    directory,
    title: "",
    agent: "",
    model: "",
    status: "unknown",
    lastDone: "",
    updatedAt: Date.now(),
    role: "peer",
    parentID: "",
  };
  try {
    const client = input?.client;
    if (!client?.session) {
      try {
        fallback.role = await resolveRole({ sessionID: sessionId });
      } catch {
        // keep peer
      }
      return fallback;
    }

    let title = "";
    let dirOut = directory;
    let timeUpdated = 0;
    let parentID = "";
    try {
      const rawGet = await client.session.get({ path: { id: sessionId } });
      const s = unwrap<Record<string, unknown>>(rawGet) as Record<string, unknown>;
      if (s && typeof s === "object") {
        if (typeof s["title"] === "string") title = s["title"] as string;
        if (typeof s["directory"] === "string" && (s["directory"] as string) !== "") {
          dirOut = s["directory"] as string;
        }
        const t = s["time"] as { updated?: unknown } | undefined;
        if (t && typeof t.updated === "number" && Number.isFinite(t.updated)) timeUpdated = t.updated;
        parentID = parentIdOf(s);
      }
    } catch (err) {
      await appLog(client, `fleet-v1 heartbeat: session.get failed for ${sessionId}: ${toReadableError(err)}`);
    }
    // P5 fallback: discover the parent via the v1 API list (never sqlite).
    if (parentID === "") {
      try {
        parentID = await discoverParentIdViaApi(client, sessionId);
      } catch {
        // keep ""
      }
    }

    let status = "unknown";
    try {
      const rawStatus = await client.session.status();
      status = statusTextOf(unwrap<unknown>(rawStatus), sessionId);
    } catch (err) {
      await appLog(client, `fleet-v1 heartbeat: session.status failed for ${sessionId}: ${toReadableError(err)}`);
    }

    let lastDone = "";
    let agent = "";
    let model = "";
    try {
      const rawMsgs = await client.session.messages({ path: { id: sessionId }, query: { limit: 5 } });
      const msgs = unwrap<unknown>(rawMsgs);
      const list = Array.isArray(msgs)
        ? msgs
        : ((msgs as Record<string, unknown>)?.["messages"] as unknown) ??
          ((msgs as Record<string, unknown>)?.["data"] as unknown) ??
          [];
      const arr = Array.isArray(list) ? list : [];
      lastDone = doneLineOf(assistantTextOf(arr));
      const um = userAgentModelOf(arr);
      agent = um.agent;
      model = um.model;
    } catch (err) {
      await appLog(client, `fleet-v1 heartbeat: session.messages failed for ${sessionId}: ${toReadableError(err)}`);
    }

    let role: Role = "peer";
    try {
      role = await resolveRole({ sessionID: sessionId, parentID });
    } catch {
      // keep peer
    }

    return {
      sessionId,
      daemonId,
      directory: dirOut,
      title,
      agent,
      model,
      status,
      lastDone,
      updatedAt: timeUpdated > 0 ? timeUpdated : Date.now(),
      role,
      parentID,
    };
  } catch (err) {
    try {
      await appLog(input?.client, `fleet-v1 heartbeat failed for ${sessionId}: ${toReadableError(err)}`);
    } catch {
      // ignore
    }
    return fallback;
  }
}

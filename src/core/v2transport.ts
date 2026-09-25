/**
 * v2transport.ts — OpenCode v2 (2.0.16+) HTTP transport + service credentials.
 *
 * A v2 service (`serve`, usually on port 49374) requires HTTP Basic auth
 * (`opencode:<password>`) for every `/api/…` call. The password lives in
 * `$XDG_STATE_HOME/opencode/service.json` (mode 0600, same user) with keys
 * `id, version, url, pid, password`.
 *
 * Security rules (see fleet-progress-V2-research.md Decision §5):
 * - The password is read from service.json ONLY at send time, ONLY when the
 *   target url matches the file's url, and is NEVER logged, persisted, or
 *   written to the registry. Grep must prove this: no `password` in
 *   registry writes, no password in log lines.
 * - Standalone v2 servers (no matching service.json) are unreachable over
 *   HTTP — callers fall back to the file spool.
 *
 * Every helper is best-effort and never throws: failures yield null/false.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { doneLineOf } from "./heartbeat.js";

export { doneLineOf };

/** Prefix for v2 daemonIds: `v2:<service-url>` (stable while it runs). */
export const V2_DAEMON_PREFIX = "v2:";

/** Build a v2 daemonId from a service url (or a pid fallback). */
export function v2DaemonId(serviceUrl: string): string {
  try {
    const u = String(serviceUrl ?? "").trim();
    if (u !== "") return `${V2_DAEMON_PREFIX}${u}`;
    return `${V2_DAEMON_PREFIX}pid:${process.pid}`;
  } catch {
    return `${V2_DAEMON_PREFIX}pid:${process.pid}`;
  }
}

function serviceJsonPath(): string {
  try {
    const xdg = process.env.XDG_STATE_HOME;
    if (xdg && xdg.trim() !== "")
      return join(xdg.trim(), "opencode", "service.json");
    return join(homedir(), ".local", "state", "opencode", "service.json");
  } catch {
    return join(homedir(), ".local", "state", "opencode", "service.json");
  }
}

export interface V2ServiceCreds {
  url: string;
  password: string;
  pid: number;
}

/** Read service.json (keys id/version/url/pid/password). Null when absent/unreadable. */
export async function readV2ServiceCreds(): Promise<V2ServiceCreds | null> {
  try {
    const raw = await readFile(serviceJsonPath(), "utf8");
    const o = JSON.parse(raw) as Record<string, unknown>;
    const url = typeof o["url"] === "string" ? (o["url"] as string).trim() : "";
    const password = typeof o["password"] === "string" ? (o["password"] as string) : "";
    const pid = typeof o["pid"] === "number" ? (o["pid"] as number) : 0;
    if (url === "" || password === "") return null;
    return { url, password, pid };
  } catch {
    return null;
  }
}

/**
 * Password for a target v2 url, read at send time and only on URL match.
 * Returns "" when there is no match (caller falls back to spool). The value
 * must never be logged or persisted — it lives only in this return string.
 */
export async function passwordForUrl(url: string): Promise<string> {
  try {
    const want = String(url ?? "").trim().replace(/\/+$/, "");
    if (want === "") return "";
    const creds = await readV2ServiceCreds();
    if (!creds) return "";
    const have = creds.url.trim().replace(/\/+$/, "");
    if (have !== want) return "";
    return creds.password;
  } catch {
    return "";
  }
}

function basicAuth(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`;
}

async function v2Fetch(
  url: string,
  password: string,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<unknown | null> {
  try {
    const base = String(url ?? "").trim().replace(/\/+$/, "");
    if (base === "" || password === "") return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const res = await fetch(`${base}${path}`, {
        method: init?.method ?? "GET",
        headers: {
          Authorization: basicAuth(password),
          ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      const text = await res.text();
      if (text.trim() === "") return null;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return null;
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

function unwrapData<T>(raw: unknown): T {
  try {
    if (raw !== null && typeof raw === "object" && "data" in (raw as Record<string, unknown>)) {
      return (raw as { data: T }).data as T;
    }
  } catch {
    // fall through
  }
  return raw as T;
}

/**
 * Inject `text` as a normal user message into a v2 session on a remote
 * service (delivery "queue" = takeover-friendly user bubble, auto-runs).
 * True when the inbox accepted it.
 */
export async function v2PromptRemote(
  url: string,
  password: string,
  sessionId: string,
  text: string,
): Promise<boolean> {
  try {
    if (String(sessionId ?? "").trim() === "" || String(text ?? "").trim() === "") return false;
    const raw = await v2Fetch(url, password, `/api/session/${encodeURIComponent(sessionId)}/prompt`, {
      method: "POST",
      body: { text, delivery: "queue" },
    });
    if (raw === null) return false;
    const item = unwrapData<Record<string, unknown>>(raw);
    return (
      item !== null &&
      typeof item === "object" &&
      (item as Record<string, unknown>)["type"] === "user"
    );
  } catch {
    return false;
  }
}

/** Liveness check: pid alive (when known) + GET /api/session/active returns 200. */
export async function isV2ServiceAlive(url: string, pid?: number): Promise<boolean> {
  try {
    if (typeof pid === "number" && Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
      } catch {
        return false;
      }
    }
    const pw = await passwordForUrl(url);
    if (pw === "") return false;
    const raw = await v2Fetch(url, pw, "/api/session/active");
    return raw !== null;
  } catch {
    return false;
  }
}

/** Busy map from GET /api/session/active: sessionId -> status string. Null on failure. */
export async function v2ActiveMap(
  url: string,
  password: string,
): Promise<Record<string, string> | null> {
  try {
    const raw = await v2Fetch(url, password, "/api/session/active");
    if (raw === null) return null;
    const data = unwrapData<Record<string, unknown>>(raw);
    if (data === null || typeof data !== "object") return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === "string") out[k] = v;
      else if (v !== null && typeof v === "object") {
        const t = (v as Record<string, unknown>)["type"];
        out[k] = typeof t === "string" && t !== "" ? t : "running";
      } else out[k] = String(v);
    }
    return out;
  } catch {
    return null;
  }
}

export interface V2SessionState {
  title: string;
  agent: string;
  model: string;
  busy: boolean | null;
  idleAt: number | null;
  outcome: string;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Parse a v2 Session.Info payload tolerantly (field names vary by version). */
export function v2SessionStateOf(payload: unknown, active?: Record<string, string> | null): V2SessionState {
  const out: V2SessionState = { title: "", agent: "", model: "", busy: null, idleAt: null, outcome: "" };
  try {
    const o = (payload ?? {}) as Record<string, unknown>;
    if (typeof o["title"] === "string") out.title = o["title"] as string;
    const info = (o["info"] ?? o) as Record<string, unknown>;
    const pick = (obj: Record<string, unknown>, keys: string[]): string => {
      for (const k of keys) {
        const v = obj[k];
        if (typeof v === "string" && v !== "") return v;
      }
      return "";
    };
    if (out.title === "") out.title = pick(o, ["title", "name"]);
    out.agent = pick(info, ["agent", "agentID"]);
    const mo = info["model"] ?? o["model"];
    if (typeof mo === "string") out.model = mo;
    else if (mo !== null && typeof mo === "object") {
      const p = typeof (mo as Record<string, unknown>)["providerID"] === "string" ? ((mo as Record<string, unknown>)["providerID"] as string) : "";
      const m = typeof (mo as Record<string, unknown>)["modelID"] === "string" ? ((mo as Record<string, unknown>)["modelID"] as string) : "";
      out.model = p !== "" && m !== "" ? `${p}/${m}` : m;
    }
    const time = (o["time"] ?? info["time"] ?? {}) as Record<string, unknown>;
    out.idleAt = numOrNull(time["idle"]) ?? numOrNull(time["updated"]) ?? numOrNull(o["updatedAt"]);
    if (typeof o["outcome"] === "string") out.outcome = o["outcome"] as string;
    else if (typeof info["outcome"] === "string") out.outcome = info["outcome"] as string;
    if (active) {
      const id = typeof o["id"] === "string" ? (o["id"] as string) : typeof o["sessionID"] === "string" ? (o["sessionID"] as string) : "";
      const hit = (id !== "" && (active[id] ?? active[id.replace(/-/g, "")])) ?? undefined;
      if (hit !== undefined) out.busy = String(hit).toLowerCase() !== "idle";
      else out.busy = false;
    }
    return out;
  } catch {
    return out;
  }
}

/** GET /api/session/{id} parsed. Null on failure. */
export async function v2SessionState(
  url: string,
  password: string,
  sessionId: string,
): Promise<V2SessionState | null> {
  try {
    const raw = await v2Fetch(url, password, `/api/session/${encodeURIComponent(sessionId)}`);
    if (raw === null) return null;
    const active = await v2ActiveMap(url, password).catch(() => null);
    return v2SessionStateOf(unwrapData<unknown>(raw), active);
  } catch {
    return null;
  }
}

function textsFromPart(p: unknown, acc: string[]): void {
  try {
    if (p === null || p === undefined) return;
    if (typeof p === "string") {
      if (p.trim() !== "") acc.push(p);
      return;
    }
    if (typeof p !== "object") return;
    const o = p as Record<string, unknown>;
    if (typeof o["text"] === "string" && (o["text"] as string).trim() !== "") {
      const t = (o["type"] as string) ?? "";
      if (t === "" || t === "text") acc.push(o["text"] as string);
      return;
    }
    if (typeof o["content"] === "string" && (o["content"] as string).trim() !== "") {
      acc.push(o["content"] as string);
      return;
    }
    if (Array.isArray(o["content"])) {
      for (const c of o["content"] as unknown[]) textsFromPart(c, acc);
      return;
    }
    const payload = o["payload"] as Record<string, unknown> | undefined;
    if (payload !== null && typeof payload === "object") {
      if (typeof payload["text"] === "string" && (payload["text"] as string).trim() !== "") {
        acc.push(payload["text"] as string);
      }
    }
  } catch {
    // tolerant only
  }
}

function isAssistantItem(m: unknown): boolean {
  try {
    const o = (m ?? {}) as Record<string, unknown>;
    const info = (o["info"] ?? {}) as Record<string, unknown>;
    for (const cand of [o["role"], o["type"], info["role"], info["type"]]) {
      if (typeof cand === "string") {
        const s = cand.toLowerCase();
        if (s.includes("assist")) return true;
        if (s === "user" || s === "synthetic" || s === "idle") return false;
      }
    }
    // Items with assistant-typical parts but no role: treat text parts as candidate.
    return o["parts"] !== undefined || o["content"] !== undefined;
  } catch {
    return false;
  }
}

/** Latest assistant text from a v2 message.list payload (tolerant of shape drift). */
export function v2AssistantTextOf(payload: unknown, since = 0): string {
  try {
    const raw = payload as Record<string, unknown> | unknown[];
    const list = Array.isArray(raw)
      ? (raw as unknown[])
      : ((raw as Record<string, unknown>)?.["data"] as unknown) ??
        ((raw as Record<string, unknown>)?.["messages"] as unknown) ??
        [];
    if (!Array.isArray(list)) return "";
    let latest = "";
    for (const m of list) {
      if (!isAssistantItem(m)) continue;
      // Time filter: ignore replies that predate the delegation, so a stale
      // DONE: line from an earlier task can never satisfy a new wait.
      try {
        const t = ((m ?? {}) as Record<string, unknown>)["time"] as Record<string, unknown> | undefined;
        const created = t !== null && typeof t === "object" ? t["created"] : undefined;
        if (typeof created === "number" && Number.isFinite(created) && created < since) continue;
      } catch {
        // missing/unparsable time: include the item rather than lose it.
      }
      const o = (m ?? {}) as Record<string, unknown>;
      const acc: string[] = [];
      const parts = o["parts"];
      const content = o["content"];
      if (Array.isArray(parts)) {
        for (const p of parts as unknown[]) textsFromPart(p, acc);
      } else if (Array.isArray(content)) {
        // v2 shape: assistant messages carry `content: [{type, text}...]`.
        for (const p of content as unknown[]) textsFromPart(p, acc);
      } else {
        textsFromPart(content ?? o["text"] ?? o["payload"], acc);
      }
      if (acc.length > 0) latest = acc.join("\n");
    }
    return latest;
  } catch {
    return "";
  }
}

/** GET /api/session/{id}/message → latest assistant text since `since`. "" on failure. */
export async function v2AssistantText(
  url: string,
  password: string,
  sessionId: string,
  limit = 10,
  since = 0,
): Promise<string> {
  try {
    const raw = await v2Fetch(
      url,
      password,
      `/api/session/${encodeURIComponent(sessionId)}/message?limit=${limit}&order=desc`,
    );
    if (raw === null) return "";
    return v2AssistantTextOf(raw, since);
  } catch {
    return "";
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error("aborted"));
    };
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Poll a v2 session's message list for a trailing DONE: line. Returns the
 * full assistant text once a DONE: line appears, else null on timeout/abort.
 */
export async function pollV2Done(
  url: string,
  password: string,
  sessionId: string,
  since: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string | null> {
  const deadline = since + timeoutMs;
  for (;;) {
    if (signal?.aborted) return null;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    try {
      const text = await v2AssistantText(url, password, sessionId, 10, since);
      if (text !== "" && doneLineOf(text) !== "") return text;
    } catch {
      // Transient poll errors: keep polling until the deadline.
    }
    try {
      await abortableSleep(Math.min(1000, Math.max(0, remaining)), signal);
    } catch {
      return null;
    }
    if (Date.now() >= deadline) return null;
  }
}

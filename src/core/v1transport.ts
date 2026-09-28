/**
 * v1transport.ts — OpenCode v1 cross-daemon HTTP transport helper.
 *
 * Analogous to v2transport.ts: base-URL normalization, short timeouts, and
 * no persisted secrets. Routes confirmed against the INSTALLED v1 SDK
 * (node_modules/@opencode-ai/sdk, pinned 1.18.x — local source only):
 * - `POST /session/{id}/prompt_async` accepts a prompt and returns
 *   **204 Prompt accepted** immediately (400/404 otherwise). See
 *   `dist/gen/sdk.gen.js` (route) + `dist/gen/types.gen.d.ts`
 *   (`SessionPromptAsyncData` body `{parts, agent?, model?, system?}`,
 *   `SessionPromptAsyncResponses` 204 void).
 * - `GET /session/{id}/message?limit=N` lists messages (`SessionMessagesData`).
 * - `GET /session/status` returns the session status map.
 *
 * v1 server auth: the generated v1 client sends NO auth headers at all
 * (see `dist/gen/client/client.gen.js` — no `Authorization` anywhere), so
 * same-user loopback calls carry none either: this transport sends no
 * credentials and persists nothing. Grep must prove this: no `password`,
 * no `Authorization` in this file.
 *
 * Routing priority for a v1 target (see fleetExec.ts):
 *   1. same-daemon in-process/client (client.session.promptAsync),
 *   2. remote owning-daemon HTTP via this module,
 *   3. file-spool fallback (owning daemon's inbox watcher).
 * Once a prompt is ACCEPTED by the target runtime, callers must never spool
 * (that would double-deliver).
 *
 * Every helper is best-effort and never throws: failures yield null/false
 * so callers fall through to the spool honestly.
 */

import { doneLineOf, normalizeStatus } from "./heartbeat.js";

/** Default HTTP timeout for one v1 remote attempt (short: fail fast). */
export const V1_HTTP_TIMEOUT_MS = 8_000;

/** Short probe timeout for status/message reads (never burn a full wait). */
export const V1_PROBE_TIMEOUT_MS = 5_000;

/** Poll cadence for the remote DONE: wait. */
export const V1_DONE_POLL_MS = 500;

/**
 * Normalize a daemon base URL: trim, drop trailing slashes. "" when empty.
 * Never throws.
 */
export function normalizeV1BaseUrl(url: unknown): string {
  try {
    const s = String(url ?? "").trim().replace(/\/+$/, "");
    return s;
  } catch {
    return "";
  }
}

/**
 * True when `url` looks like a reachable v1 daemon base (http loopback, not
 * a v2 service marker, not a pid fallback). Never throws. Advisory only —
 * the actual attempt still fails closed on fetch errors.
 */
export function isV1HttpTarget(url: unknown): boolean {
  try {
    const base = normalizeV1BaseUrl(url);
    if (base === "") return false;
    if (base.startsWith("v2:")) return false;
    if (base.startsWith("pid:")) return false;
    if (base.includes(".bun")) return false;
    if (base.includes("49374")) return false;
    return /^https?:\/\//i.test(base);
  } catch {
    return false;
  }
}

/** Raw fetch result: status + optional parsed JSON. Never throws. */
async function v1FetchRaw(
  base: string,
  path: string,
  init?: { method?: string; body?: unknown; query?: Record<string, string | number> },
  timeoutMs = V1_HTTP_TIMEOUT_MS,
): Promise<{ ok: boolean; status: number; json: unknown } | null> {
  try {
    if (base === "" || path === "") return null;
    let url = `${base}${path}`;
    if (init?.query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(init.query)) qs.set(k, String(v));
      const s = qs.toString();
      if (s !== "") url += (url.includes("?") ? "&" : "?") + s;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: init?.method ?? "GET",
        headers: {
          // No auth: the v1 server takes none on same-user loopback (see header).
          ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: ctrl.signal,
      });
      const ok = res.ok;
      const status = res.status;
      let json: unknown = null;
      try {
        const text = await res.text();
        if (text.trim() !== "") json = JSON.parse(text) as unknown;
      } catch {
        json = null;
      }
      return { ok, status, json };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/** Unwrap SDK RequestResult ({data,error}) or a raw payload. */
function unwrap<T>(raw: unknown): T {
  try {
    if (raw !== null && typeof raw === "object" && "data" in (raw as Record<string, unknown>)) {
      return (raw as { data: T }).data as T;
    }
  } catch {
    // fall through
  }
  return raw as T;
}

export interface V1PromptBody {
  parts: Array<{ type: "text"; text: string }>;
  agent?: string;
  model?: { providerID: string; modelID: string };
  variant?: string;
  system?: string;
}

/**
 * Inject a prompt as a normal user message into a session on a REMOTE v1
 * daemon (`POST /session/{id}/prompt_async`; 2xx incl. the documented 204
 * means accepted). True only when the remote inbox accepted it (caller must
 * then poll for DONE: and must NEVER spool — that would double-deliver).
 * False on any failure (unknown session, refused, timeout → caller falls
 * back to the spool). Never throws, sends no auth, persists nothing.
 */
export async function v1PromptRemote(
  baseUrl: string,
  sessionId: string,
  body: V1PromptBody | string,
): Promise<boolean> {
  try {
    const base = normalizeV1BaseUrl(baseUrl);
    if (!isV1HttpTarget(base)) return false;
    const sid = String(sessionId ?? "").trim();
    if (sid === "") return false;
    const payload: V1PromptBody =
      typeof body === "string"
        ? { parts: [{ type: "text", text: body }] }
        : body;
    if (payload.parts.length === 0) return false;
    const res = await v1FetchRaw(base, `/session/${encodeURIComponent(sid)}/prompt_async`, {
      method: "POST",
      body: payload,
    });
    return res !== null && res.ok;
  } catch {
    return false;
  }
}

/**
 * Liveness probe for a remote v1 daemon: `GET /session/status` returns 2xx
 * with a parseable map. False on any failure (caller fails fast or falls
 * back to spool — never a 60s wait). Never throws.
 */
export async function isV1DaemonAlive(baseUrl: string): Promise<boolean> {
  try {
    const base = normalizeV1BaseUrl(baseUrl);
    if (!isV1HttpTarget(base)) return false;
    const res = await v1FetchRaw(base, "/session/status", undefined, V1_PROBE_TIMEOUT_MS);
    return res !== null && res.ok;
  } catch {
    return false;
  }
}

/**
 * Status map from `GET /session/status`: sessionId -> raw status payload.
 * Null on failure. Never throws.
 */
export async function v1StatusMap(
  baseUrl: string,
  timeoutMs = V1_PROBE_TIMEOUT_MS,
): Promise<Record<string, unknown> | null> {
  try {
    const base = normalizeV1BaseUrl(baseUrl);
    if (!isV1HttpTarget(base)) return null;
    const res = await v1FetchRaw(base, "/session/status", undefined, timeoutMs);
    if (res === null || !res.ok) return null;
    const data = unwrap<unknown>(res.json);
    if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
    return data as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Normalized status string for one session out of a v1 status map (same
 * vocabulary as the heartbeat: busy|idle|<raw>|unknown). "unknown" only
 * when the map genuinely has no entry. Never throws.
 */
export function v1StatusOf(map: Record<string, unknown> | null | undefined, sessionId: string): string {
  try {
    if (!map || typeof map !== "object") return "unknown";
    const sid = String(sessionId ?? "");
    const variants = [sid];
    try {
      variants.push(sid.replace(/-/g, ""));
    } catch {
      // ignore
    }
    for (const key of variants) {
      if (key === "" || !(key in map)) continue;
      const v = (map as Record<string, unknown>)[key];
      if (typeof v === "string") return normalizeStatus(v);
      if (v !== null && typeof v === "object") {
        const o = v as Record<string, unknown>;
        for (const k of ["type", "status", "state", "value", "label"]) {
          if (typeof o[k] === "string" && String(o[k]).trim() !== "") {
            return normalizeStatus(o[k]);
          }
        }
        return "unknown";
      }
      if (typeof v === "boolean") return v ? "busy" : "idle";
      if (typeof v === "number" && Number.isFinite(v)) return v > 0 ? "busy" : "idle";
      if (v !== undefined && v !== null) return normalizeStatus(v);
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

/** Latest assistant text from a v1 message-list payload (tolerant of shape drift). */
export function v1AssistantTextOf(payload: unknown, since = 0): string {
  try {
    const raw = unwrap<unknown>(payload);
    const list = Array.isArray(raw)
      ? raw
      : ((raw as Record<string, unknown> | null)?.["messages"] as unknown) ??
        ((raw as Record<string, unknown> | null)?.["data"] as unknown) ??
        [];
    if (!Array.isArray(list)) return "";
    let latest = "";
    for (const m of list) {
      try {
        const rec = (m ?? {}) as Record<string, unknown>;
        const info = (rec["info"] ?? {}) as Record<string, unknown>;
        if (info["role"] !== "assistant" && rec["role"] !== "assistant") continue;
        // Time filter: ignore replies that predate the delegation, so a stale
        // DONE: line from an earlier task can never satisfy a new wait.
        try {
          const t = (info["time"] ?? rec["time"] ?? {}) as Record<string, unknown>;
          const created = t["created"];
          if (typeof created === "number" && Number.isFinite(created) && created < since) continue;
        } catch {
          // missing/unparsable time: include rather than lose the item.
        }
        const parts = rec["parts"];
        if (!Array.isArray(parts)) continue;
        const texts: string[] = [];
        for (const p of parts as unknown[]) {
          const part = p as { type?: unknown; text?: unknown } | null;
          if (part && part.type === "text" && typeof part.text === "string") texts.push(part.text);
        }
        if (texts.length > 0) latest = texts.join("\n");
      } catch {
        // keep scanning
      }
    }
    return latest;
  } catch {
    return "";
  }
}

/** `GET /session/{id}/message?limit=N` → latest assistant text since `since`. "" on failure. */
export async function v1AssistantText(
  baseUrl: string,
  sessionId: string,
  limit = 10,
  since = 0,
  timeoutMs = V1_PROBE_TIMEOUT_MS,
): Promise<string> {
  try {
    const base = normalizeV1BaseUrl(baseUrl);
    if (!isV1HttpTarget(base)) return "";
    const sid = String(sessionId ?? "").trim();
    if (sid === "") return "";
    const res = await v1FetchRaw(
      base,
      `/session/${encodeURIComponent(sid)}/message`,
      { query: { limit } },
      timeoutMs,
    );
    if (res === null || !res.ok) return "";
    return v1AssistantTextOf(res.json, since);
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
 * Poll a remote v1 session's message list for a trailing DONE: line.
 * Returns the full assistant text once a DONE: line appears, else null on
 * timeout/abort. Never throws.
 */
export async function pollV1Done(
  baseUrl: string,
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
      const text = await v1AssistantText(baseUrl, sessionId, 10, since, Math.min(V1_PROBE_TIMEOUT_MS, Math.max(1000, remaining)));
      if (text !== "" && doneLineOf(text) !== "") return text;
    } catch {
      // Transient poll errors: keep polling until the deadline.
    }
    try {
      await abortableSleep(Math.min(V1_DONE_POLL_MS, Math.max(0, remaining)), signal);
    } catch {
      return null;
    }
    if (Date.now() >= deadline) return null;
  }
}

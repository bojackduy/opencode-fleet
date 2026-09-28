/**
 * fleetStatus.ts — Phase 3 `fleet_status` tool, Phase B2 per-commander scoped.
 *
 * Exactly ONE controlling commander per worker (see ../assignments.ts).
 * Default rows cover ONLY the calling commander's owned workers. Explicit
 * sessionIds are gated per worker via lookupAssignment: foreign, unassigned,
 * stale, missing, or ambiguous ids render as readable error cells (never
 * leak another commander's DONE lines). Caller identity ALWAYS comes from
 * the tool context + runtime (fail-closed). Never throws.
 */

import { depsOf, z } from "../toolDef.js";
import type { ToolDef } from "../toolDef.js";
import type { Runtime } from "../runtime.js";
import { listRegistry, runtimeOf } from "../registry.js";
import type { RegistryEntry } from "../registry.js";
import { lookupAssignment } from "../assignments.js";
import { scopedRegistryEntries } from "../ownershipControl.js";
import { ageTextOf, liveEntries } from "../liveness.js";
import { isV1HttpTarget, normalizeV1BaseUrl, v1AssistantText, v1StatusMap, v1StatusOf, V1_PROBE_TIMEOUT_MS } from "../v1transport.js";
import { messageListOf } from "../inbox.js";
import { passwordForUrl, v2ActiveMap, v2AssistantText } from "../v2transport.js";

export interface FleetToolDeps {
  // biome-ignore lint/suspicious/noExplicitAny: v1 plugin client is untyped at the boundary.
  client?: any;
  serverUrl?: string | URL;
  rt?: Runtime;
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
  context: any,
  deps?: FleetToolDeps,
): Promise<string> {
  try {
    const client = deps?.client;
    const rt = deps?.rt;

    // Phase B2 scope: commander resolution first (fail-closed).
    const scoped = await scopedRegistryEntries(context as any, rt);
    if (!scoped.ok) return `fleet_status failed: ${scoped.error}`;

    const requested = Array.isArray(args?.sessionIds)
      ? (args.sessionIds as unknown[]).filter((s): s is string => typeof s === "string" && s !== "")
      : [];
    const entries = await listRegistry({ includeSelf: true });
    const byId = new Map(entries.map((e) => [e.sessionId, e]));
    let ids: string[];
    if (requested.length > 0) {
      ids = requested;
    } else {
      // Default rows cover live-owned workers only (stale/dead rows fail
      // fast at send time; explicit sessionIds still render per-row).
      const live = liveEntries([...scoped.owned]);
      if (live.length === 0 && scoped.owned.length > 0) {
        return `no live workers assigned to you (${scoped.owned.length} owned but stale/dead; run fleet_doctor for the next command)`;
      }
      ids = live.map((e) => e.sessionId);
    }
    if (ids.length === 0) {
      return requested.length > 0
        ? "no matching workers"
        : `no workers assigned to you (claim workers with fleet_assign; unassigned discovery: fleet_unassigned)`;
    }

    // v1 rows on a v1 commander keep the live client.session.status path.
    const v1Local = client && rt?.kind !== "v2"
      ? ids.filter((id) => runtimeOf(byId.get(id)) === "v1")
      : [];

    let statusMap: any = {};
    if (v1Local.length > 0) {
      try {
        statusMap = (await client.session.status()) ?? {};
      } catch (err) {
        return `fleet_status failed: session.status: ${toReadableError(err)}`;
      }
    }

    const rows = await Promise.all(
      ids.map(async (id): Promise<string> => {
        // Phase B2 per-row ownership gate (explicit ids only; the default
        // set is already owned). Foreign/unassigned/stale/missing/
        // ambiguous ids render as error cells — no DONE leak.
        if (requested.length > 0) {
          const gate = await lookupAssignment({ sessionId: id }, scoped.callerKey);
          if (gate.kind === "ambiguous" || gate.kind === "not-found") {
            return `${id} | error | - | ${gate.error ?? "not in registry"}`;
          }
          if (gate.kind === "error") {
            return `${id} | error | - | ${gate.error ?? "lookup failed"}`;
          }
          if (gate.kind === "unassigned") {
            return `${id} | error | - | ${id} is not assigned to you (unassigned; claim it with fleet_assign first)`;
          }
          if (gate.kind === "stale") {
            return `${id} | error | - | ${id} has a stale assignment (worker row gone); release or re-claim via fleet_assign`;
          }
          if (gate.kind === "owned-by-other") {
            return `${id} | error | - | ${id} is owned by ${gate.ownerSessionId ?? "?"}; only the owning commander can check it`;
          }
        }
        if (v1Local.includes(id)) {
          try {
            const status = statusOf(statusMap, id);
          let messages: any[] = [];
          try {
            const res = await client.session.messages({ path: { id }, query: { limit: 5 } });
            messages = messageListOf(res);
          } catch (err) {
            return `${id} | ${status} | - | messages error: ${toReadableError(err)}`;
          }
            const lastText = lastAssistantText(messages);
            const done = lastText !== "" ? (doneLineOf(lastText) ?? "-") : "-";
            return `${id} | ${status} | ${done} | ${oneLineSnippet(lastText)}`;
          } catch (err) {
            return `${id} | error | - | ${toReadableError(err)}`;
          }
        }
        // Part 2: v2 rows (or v1 rows seen from a v2 commander).
        return statusRowForRemote(byId.get(id), id, rt);
      }),
    );
    return ["sessionId | status | lastDONE | lastMsgSnippet", ...rows].join("\n");
  } catch (err) {
    return `fleet_status failed: ${toReadableError(err)}`;
  }
}

/**
 * Status row without a v1 client: v2 rows via the service HTTP API
 * (/api/session/active + message list DONE: parse); v1 rows via the owning
 * daemon's endpoint (`GET /session/status` + message list DONE: parse);
 * anything unreachable falls back to the registry heartbeat (status/lastDone
 * with age). Never throws.
 */
async function statusRowForRemote(
  entry: RegistryEntry | undefined,
  id: string,
  rt?: Runtime,
): Promise<string> {
  try {
    if (!entry) return `${id} | unknown | - | not in registry`;
    if (runtimeOf(entry) === "v1") {
      // Endpoint-routed live read (short probes; never a full wait). Same-
      // daemon rows with a live client never reach here (v1Local path above).
      const url = normalizeV1BaseUrl(entry.endpoint?.url);
      if (isV1HttpTarget(url)) {
        try {
          const map = await v1StatusMap(url, V1_PROBE_TIMEOUT_MS).catch(() => null);
          if (map !== null) {
            const status = v1StatusOf(map, id);
            const text = await v1AssistantText(url, id, 5, 0, V1_PROBE_TIMEOUT_MS).catch(() => "");
            const done = text !== "" ? (doneLineOf(text) ?? "-") : "-";
            return `${id} | ${status} | ${done} | ${text !== "" ? oneLineSnippet(text) : "v1-http"}`;
          }
        } catch {
          // fall through to registry fallback
        }
      }
    }
    if (runtimeOf(entry) === "v2") {
      const url =
        (typeof entry.endpoint?.url === "string" && entry.endpoint.url.trim() !== ""
          ? entry.endpoint.url.trim()
          : entry.daemonId.startsWith("v2:")
            ? entry.daemonId.slice("v2:".length)
            : "") ?? "";
      // Prefer the service HTTP surface (works same-process and remote):
      // live busy from /api/session/active + last DONE from the message list.
      if (url !== "" && !url.startsWith("pid:")) {
        try {
          const pw = await passwordForUrl(url).catch(() => "");
          if (pw !== "") {
            const active = await v2ActiveMap(url, pw).catch(() => null);
            const hit = active ? (active[id] ?? active[id.replace(/-/g, "")]) : undefined;
            const status = hit !== undefined ? String(hit) : "idle";
            const text = await v2AssistantText(url, pw, id, 5).catch(() => "");
            const done = text !== "" ? (doneLineOf(text) ?? "-") : "-";
            return `${id} | ${status} | ${done} | ${oneLineSnippet(text)}`;
          }
        } catch {
          // fall through to in-process/registry
        }
      }
      // Same-process fallback when HTTP creds are unavailable (standalone).
      if (rt?.kind === "v2" && rt.daemonId === entry.daemonId) {
        try {
          const info = await rt.sessionInfo(id);
          if (info) {
            const status = info.busy === null ? "unknown" : info.busy ? "busy" : "idle";
            const lastDone = entry.lastDone && entry.lastDone.trim() !== "" ? entry.lastDone : "-";
            const label = `${info.agent !== "" ? info.agent : "?"}/${info.model !== "" ? info.model : "?"}`;
            return `${id} | ${status} | ${lastDone} | ${label}`;
          }
        } catch {
          // fall through to registry fallback
        }
      }
    }
    // Registry-heartbeat fallback (honest): the stored heartbeat status is
    // shown as-is with its age so readers can judge staleness; "unknown" is
    // reserved for rows that genuinely have no heartbeat status.
    const status = entry.status && entry.status.trim() !== "" ? entry.status : "unknown";
    const done = entry.lastDone && entry.lastDone.trim() !== "" ? entry.lastDone : "-";
    const age = ageTextOf(entry.updatedAt);
    const where = runtimeOf(entry) === "v2" ? `registry age ${age} (v2 unreachable)` : `registry age ${age}`;
    return `${id} | ${status} | ${done} | ${where}`;
  } catch (err) {
    return `${id} | error | - | ${toReadableError(err)}`;
  }
}

export const fleetStatusDef: ToolDef = {
  name: "fleet_status",
  description:
    "Show live status per fleet worker you own (per-commander scoped): session status, trailing DONE: line, and last assistant message snippet.",
  args: {
    sessionIds: z
      .array(z.string())
      .optional()
      .describe("Owned session ids to check (each must be owned by you); defaults to all workers you own"),
  },
  run: (args, callCtx, rt) => fleetStatusHandler(args, callCtx, depsOf(rt)),
};

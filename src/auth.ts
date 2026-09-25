/**
 * auth.ts — P4 inbound policy + commander allowlist for fleet-v1.
 *
 * State file (0600, atomic temp+rename):
 *   $XDG_STATE_HOME/opencode/fleet-v1/auth.json
 *   (fallback ~/.local/state/opencode/fleet-v1/auth.json)
 * Shape: { commanders: string[], policy: "commander-only" | "accept" | "hold" | "refuse" }
 * Default policy is "commander-only" (P5 safe default: closed mesh).
 *
 * Semantics of canExec(fromCommander, targetSessionId, registry?, opts?):
 *   - self-target (from === target, both non-empty) -> false, always.
 *   - policy "refuse" -> false (deny everything, readable deny at call site)
 *   - policy "hold"   -> "hold" (queue path: write held .req.json + .notify.json)
 *   - policy "accept" -> legacy open path: true when the allowlist is empty
 *     (open), else true only when fromCommander is listed; unknown/unlisted -> false.
 *   - policy "commander-only" (default, P5 role matrix):
 *       target "broadcast"            -> allow iff from is commander
 *       target is commander           -> ALWAYS allow worker/peer->commander
 *                                        reverse (handoff_back path);
 *                                        deny commander->commander unless
 *                                        opts.force === true
 *       target is worker/peer/unknown -> allow iff from is commander,
 *                                        else deny ("peer->any hold/deny")
 *     Denied (non-hold) call sites render:
 *       "denied: <reason>, ask commander to fleet_allow"
 *
 * Commander identity = listed in auth.json commanders OR registry entry
 * with role "commander" (when a registry snapshot is supplied).
 *
 * All exports never throw. No subprocess spawns, no DB reads.
 */

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stateDir } from "./registry.js";
import type { RegistryEntry } from "./registry.js";

export type FleetPolicy = "commander-only" | "accept" | "hold" | "refuse";

export interface AuthState {
  commanders: string[];
  policy: FleetPolicy;
}

export const DEFAULT_POLICY: FleetPolicy = "commander-only";

export function authPath(): string {
  return join(stateDir(), "auth.json");
}

function normalizePolicy(raw: unknown): FleetPolicy {
  if (raw === "hold" || raw === "refuse" || raw === "accept" || raw === "commander-only") {
    return raw;
  }
  return DEFAULT_POLICY;
}

function normalizeCommanders(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v === "string" && v.trim() !== "" && !out.includes(v.trim())) out.push(v.trim());
  }
  return out;
}

function defaults(): AuthState {
  return { commanders: [], policy: DEFAULT_POLICY };
}

/** Read auth state. Never throws — missing/corrupt yields defaults. */
export async function readAuth(): Promise<AuthState> {
  try {
    const raw = await readFile(authPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<AuthState>;
    if (typeof parsed !== "object" || parsed === null) return defaults();
    return {
      commanders: normalizeCommanders((parsed as Record<string, unknown>)["commanders"]),
      policy: normalizePolicy((parsed as Record<string, unknown>)["policy"]),
    };
  } catch {
    return defaults();
  }
}

async function writeAuthAtomic(state: AuthState): Promise<void> {
  const filePath = authPath();
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, filePath);
  await chmod(filePath, 0o600);
}

/**
 * Decide whether fromCommander may exec into targetSessionId.
 * Returns true (allowed), false (refused), or "hold" (queue for approval).
 * Never throws — read failures yield commander-only defaults.
 *
 * Role matrix (policy "commander-only"):
 *   commander -> worker/peer  allow
 *   worker/peer -> commander  allow (reverse handoff_back path)
 *   commander -> commander    deny unless opts.force === true
 *   peer -> worker/peer       deny
 *   self -> self              deny always
 */
export async function canExec(
  fromCommander: string,
  _targetSessionId: string,
  registry?: RegistryEntry[],
  opts?: { force?: boolean },
): Promise<boolean | string> {
  try {
    const detail = await canExecDetail(fromCommander, _targetSessionId, registry, opts);
    return detail.allowed;
  } catch {
    return false;
  }
}

export interface CanExecDetail {
  allowed: boolean | "hold";
  /** Machine-readable reason for denies (empty when allowed/held). */
  reason: string;
}

/** True when id is a commander via the auth allowlist or a registry commander role. */
function isCommanderId(
  id: string,
  state: AuthState,
  registry?: RegistryEntry[],
): boolean {
  try {
    if (id === "") return false;
    if (state.commanders.includes(id)) return true;
    if (Array.isArray(registry)) {
      const entry = registry.find((e) => e.sessionId === id);
      if (entry && (entry as { role?: unknown }).role === "commander") return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * canExec with a machine-readable deny reason. Never throws.
 * Denied (non-hold) call sites render:
 *   `denied: ${reason}, ask commander to fleet_allow`
 */
export async function canExecDetail(
  fromCommander: string,
  targetSessionId: string,
  registry?: RegistryEntry[],
  opts?: { force?: boolean },
): Promise<CanExecDetail> {
  try {
    const from = String(fromCommander ?? "").trim();
    const target = String(targetSessionId ?? "").trim();
    // Self-target is always denied, on every policy.
    if (from !== "" && from === target) {
      return { allowed: false, reason: "self-target not allowed" };
    }
    const state = await readAuth();
    if (state.policy === "refuse") return { allowed: false, reason: "policy=refuse" };
    if (state.policy === "hold") return { allowed: "hold", reason: "" };
    if (state.policy === "accept") {
      // Legacy open path (kept for compat; not the default).
      if (state.commanders.length === 0) return { allowed: true, reason: "" };
      if (from === "") return { allowed: false, reason: "unknown commander" };
      return state.commanders.includes(from)
        ? { allowed: true, reason: "" }
        : { allowed: false, reason: `${from} is not an allowed commander` };
    }
    // Default: commander-only role matrix.
    const fromIsCommander = isCommanderId(from, state, registry);
    if (target === "broadcast") {
      return fromIsCommander
        ? { allowed: true, reason: "" }
        : { allowed: false, reason: `${from || "(unknown)"} is not a commander` };
    }
    const targetIsCommander = isCommanderId(target, state, registry);
    if (targetIsCommander) {
      // Reverse path (worker->commander handoff_back) is always allowed.
      if (!fromIsCommander) return { allowed: true, reason: "" };
      // Commander->commander needs an explicit force override.
      if (opts?.force === true) return { allowed: true, reason: "" };
      return { allowed: false, reason: "commander->commander needs force:true" };
    }
    // Target is worker/peer/unknown: only commanders may drive.
    if (fromIsCommander) return { allowed: true, reason: "" };
    return { allowed: false, reason: `${from || "(unknown)"} is not a commander` };
  } catch {
    return { allowed: false, reason: "auth check failed" };
  }
}

/** Render a denied (non-hold) verdict as readable text. Never throws. */
export function denyText(reason: string): string {
  try {
    const r = String(reason ?? "").trim() || "not allowed";
    return `denied: ${r}, ask commander to fleet_allow`;
  } catch {
    return "denied: not allowed, ask commander to fleet_allow";
  }
}

/** Add a commander id to the allowlist. Never throws; returns the new list. */
export async function addCommander(commanderId: string): Promise<string[]> {
  try {
    const id = String(commanderId ?? "").trim();
    if (id === "") return (await readAuth()).commanders;
    const state = await readAuth();
    if (!state.commanders.includes(id)) {
      state.commanders.push(id);
      await writeAuthAtomic(state);
    }
    return state.commanders;
  } catch {
    try {
      return (await readAuth()).commanders;
    } catch {
      return [];
    }
  }
}

/** Remove a commander id from the allowlist. Never throws; returns the new list. */
export async function removeCommander(commanderId: string): Promise<string[]> {
  try {
    const id = String(commanderId ?? "").trim();
    const state = await readAuth();
    const next = state.commanders.filter((c) => c !== id);
    if (next.length !== state.commanders.length) {
      await writeAuthAtomic({ commanders: next, policy: state.policy });
    }
    return next;
  } catch {
    try {
      return (await readAuth()).commanders;
    } catch {
      return [];
    }
  }
}

/** List allowed commander ids. Never throws. */
export async function listCommanders(): Promise<string[]> {
  try {
    return (await readAuth()).commanders;
  } catch {
    return [];
  }
}

/** Set the inbound policy. Invalid values are ignored. Never throws. */
export async function setPolicy(policy: string): Promise<FleetPolicy> {
  try {
    const p = normalizePolicy(policy);
    if (
      policy !== "accept" &&
      policy !== "hold" &&
      policy !== "refuse" &&
      policy !== "commander-only"
    ) {
      return (await readAuth()).policy;
    }
    const state = await readAuth();
    state.policy = p;
    await writeAuthAtomic(state);
    return p;
  } catch {
    try {
      return (await readAuth()).policy;
    } catch {
      return DEFAULT_POLICY;
    }
  }
}

/** Get the current inbound policy. Never throws. */
export async function getPolicy(): Promise<FleetPolicy> {
  try {
    return (await readAuth()).policy;
  } catch {
    return DEFAULT_POLICY;
  }
}

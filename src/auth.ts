/**
 * auth.ts — P4 inbound policy + commander allowlist for fleet-v1.
 *
 * State file (0600, atomic temp+rename):
 *   $XDG_STATE_HOME/opencode/fleet-v1/auth.json
 *   (fallback ~/.local/state/opencode/fleet-v1/auth.json)
 * Shape: { commanders: string[], policy: "accept" | "hold" | "refuse" }
 * Default policy is "accept".
 *
 * Semantics of canExec(fromCommander, targetSessionId):
 *   - policy "refuse" -> false (deny everything, readable deny at call site)
 *   - policy "hold"   -> "hold" (queue path: write held .req.json + .notify.json)
 *   - policy "accept" -> true when the allowlist is empty (open), else true
 *     only when fromCommander is listed; unknown/unlisted -> false.
 *
 * All exports never throw. No subprocess spawns, no DB reads.
 */

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stateDir } from "./registry.js";

export type FleetPolicy = "accept" | "hold" | "refuse";

export interface AuthState {
  commanders: string[];
  policy: FleetPolicy;
}

export const DEFAULT_POLICY: FleetPolicy = "accept";

export function authPath(): string {
  return join(stateDir(), "auth.json");
}

function normalizePolicy(raw: unknown): FleetPolicy {
  if (raw === "hold" || raw === "refuse" || raw === "accept") return raw;
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
 * Never throws — read failures yield accept-with-open-list.
 */
export async function canExec(
  fromCommander: string,
  _targetSessionId: string,
): Promise<boolean | string> {
  try {
    void _targetSessionId;
    const state = await readAuth();
    if (state.policy === "refuse") return false;
    if (state.policy === "hold") return "hold";
    if (state.commanders.length === 0) return true;
    const from = String(fromCommander ?? "").trim();
    if (from === "") return false;
    return state.commanders.includes(from);
  } catch {
    return true;
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
    if (policy !== "accept" && policy !== "hold" && policy !== "refuse") {
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

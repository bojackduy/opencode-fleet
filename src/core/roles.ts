/**
 * roles.ts — P5 role + hierarchy for fleet.
 *
 * Roles: "commander" | "worker" | "peer".
 *   - A session WITH a parentID (fork) is ALWAYS a "worker".
 *   - Else "commander" when listed in auth.json commanders, else "peer".
 *   - Registry entries without a role read as "peer" (see roleOf()).
 *
 * All exports never throw. No subprocess spawns, no DB reads.
 * Uses client.app.log at call sites, never console.log.
 */

import { listCommanders, addCommander, removeCommander } from "./auth.js";
import { readRegistry, registerSelf } from "./registry.js";
import type { RegistryEntry } from "./registry.js";

export type Role = "commander" | "worker" | "peer";

export const DEFAULT_ROLE: Role = "peer";

function normalizeId(raw: unknown): string {
  try {
    return String(raw ?? "").trim();
  } catch {
    return "";
  }
}

function normalizeParentId(raw: unknown): string {
  return normalizeId(raw);
}

function isRole(raw: unknown): raw is Role {
  return raw === "commander" || raw === "worker" || raw === "peer";
}

/** Role of a stored entry; missing/invalid reads as "peer". Never throws. */
export function roleOf(entry: Pick<RegistryEntry, "role"> | null | undefined): Role {
  try {
    const r = (entry as { role?: unknown } | null | undefined)?.role;
    return isRole(r) ? r : DEFAULT_ROLE;
  } catch {
    return DEFAULT_ROLE;
  }
}

/**
 * Pure role resolution given a commander allowlist.
 * Fork (non-empty parentID) is ALWAYS "worker".
 */
export function resolveRoleWithCommanders(
  input: { sessionID: string; parentID?: string },
  commanders: string[],
): Role {
  try {
    const parent = normalizeParentId(input?.parentID);
    if (parent !== "") return "worker";
    const id = normalizeId(input?.sessionID);
    if (id !== "" && Array.isArray(commanders) && commanders.includes(id)) return "commander";
    return DEFAULT_ROLE;
  } catch {
    return DEFAULT_ROLE;
  }
}

/**
 * Resolve the role for a session (async: reads auth.json commanders).
 * Fork (non-empty parentID) is ALWAYS "worker", else "commander" when
 * listed in auth commanders, else "peer". Never throws.
 */
export async function resolveRole(input: { sessionID: string; parentID?: string }): Promise<Role> {
  try {
    const parent = normalizeParentId(input?.parentID);
    if (parent !== "") return "worker";
    const id = normalizeId(input?.sessionID);
    if (id === "") return DEFAULT_ROLE;
    const commanders = await listCommanders().catch(() => [] as string[]);
    return resolveRoleWithCommanders({ sessionID: id }, commanders);
  } catch {
    return DEFAULT_ROLE;
  }
}

/** True when the session id is listed in auth.json commanders. Never throws. */
export async function isCommander(sessionId: string): Promise<boolean> {
  try {
    const id = normalizeId(sessionId);
    if (id === "") return false;
    const commanders = await listCommanders().catch(() => [] as string[]);
    return commanders.includes(id);
  } catch {
    return false;
  }
}

async function stampRegistryRole(sessionId: string, role: Role): Promise<void> {
  try {
    const id = normalizeId(sessionId);
    if (id === "") return;
    const entries = await readRegistry().catch(() => [] as RegistryEntry[]);
    const existing = entries.find((e) => e.sessionId === id);
    if (!existing) return;
    await registerSelf({ ...existing, role }).catch(() => undefined);
  } catch {
    // best-effort only
  }
}

/**
 * Claim commander: adds to auth.json commanders + stamps registry role.
 * Returns the resulting role ("commander", or "peer" on empty/invalid input).
 * Never throws.
 */
export async function claimCommander(sessionId: string): Promise<Role> {
  try {
    const id = normalizeId(sessionId);
    if (id === "") return DEFAULT_ROLE;
    await addCommander(id).catch(() => [] as string[]);
    await stampRegistryRole(id, "commander");
    return "commander";
  } catch {
    return DEFAULT_ROLE;
  }
}

/**
 * Release commander: removes from auth.json commanders + stamps registry
 * role back to "peer". Returns "peer". Never throws.
 */
export async function releaseCommander(sessionId: string): Promise<Role> {
  try {
    const id = normalizeId(sessionId);
    if (id === "") return DEFAULT_ROLE;
    await removeCommander(id).catch(() => [] as string[]);
    await stampRegistryRole(id, "peer");
    return DEFAULT_ROLE;
  } catch {
    return DEFAULT_ROLE;
  }
}

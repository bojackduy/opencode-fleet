/**
 * toolDef.ts — runtime-agnostic tool definition shape.
 *
 * `z` is the zod instance bundled with @opencode-ai/plugin (`tool.schema`),
 * so v1 sees byte-identical arg schemas to before the core extraction, and
 * v2 gets a zod (StandardSchema) object via `z.object(def.args)`.
 */

import { tool } from "@opencode-ai/plugin";
import type { CallCtx, Runtime } from "./runtime.js";

export const z: typeof tool.schema = tool.schema;

// biome-ignore lint/suspicious/noExplicitAny: zod raw shape with heterogeneous members.
export type ArgsShape = Record<string, any>;

export interface ToolDef {
  name: string;
  description: string;
  args: ArgsShape;
  // biome-ignore lint/suspicious/noExplicitAny: args are validated by the host.
  run(args: any, callCtx: CallCtx, rt: Runtime): Promise<string>;
}

/** Legacy handler deps derived from a runtime (v1 client/serverUrl + the runtime itself). */
export function depsOf(rt: Runtime): { client?: unknown; serverUrl?: string; rt: Runtime } {
  return { client: rt.client, serverUrl: rt.serverUrl, rt };
}

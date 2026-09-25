/**
 * index.ts — dual-shape plugin entry for OpenCode v1 and v2.
 *
 *   v1 (1.18.x) calls `server(input)` and ignores `setup`.
 *   v2 (2.0.16+) calls `setup(ctx)` and ignores `server`.
 *
 * Both share the runtime-agnostic core in src/core/.
 */

import { server } from "./v1/adapter.js";
import { v2Setup } from "./v2/adapter.js";

export { server } from "./v1/adapter.js";
export { v2Setup } from "./v2/adapter.js";

export default { id: "fleet.v1", server, setup: v2Setup };

// scripts/build-tui.mjs — emit dist/tui.js for the fleet TUI dashboard.
//
// `tsc` compiles src/tui/*.tsx to dist/tui/*.js (react-jsx against
// @opentui/solid, which the TUI host provides). This script adds the flat
// dist/tui.js entry the package exports map points at: a thin re-export of
// the compiled plugin module. Server tools are untouched — this only
// packages the new read + manual-control surface.

import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const compiled = join(root, "dist", "tui", "plugin.js");

try {
  await stat(compiled);
} catch {
  console.error("build-tui: dist/tui/plugin.js missing (run tsc first)");
  process.exit(1);
}

await writeFile(
  join(root, "dist", "tui.js"),
  `export { default } from "./tui/plugin.js";\nexport * from "./tui/plugin.js";\n`,
);
console.log("build-tui: dist/tui.js emitted");

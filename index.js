// Root re-export so an absolute-directory OpenCode v2 entry
// (`plugins: ["/path/to/opencode-fleet-v1"]`) resolves `<dir>/index.js`.
export * from "./dist/index.js";
export { default } from "./dist/index.js";

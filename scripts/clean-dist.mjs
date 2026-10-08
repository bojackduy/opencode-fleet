import { rm } from "node:fs/promises";

// Resolve from this script, never the caller's working directory. rm removes
// a dist symlink itself rather than traversing its target.
await rm(new URL("../dist", import.meta.url), { recursive: true, force: true });

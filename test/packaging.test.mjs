import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, copyFile, writeFile, access, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));

test("clean-dist is scoped to its repository and does not traverse symlinks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fleet-clean-"));
  try {
    await mkdir(join(dir, "repo/scripts"), { recursive: true });
    await mkdir(join(dir, "repo/dist"));
    await mkdir(join(dir, "outside"));
    await copyFile(join(root, "scripts/clean-dist.mjs"), join(dir, "repo/scripts/clean-dist.mjs"));
    await writeFile(join(dir, "repo/dist/stale-missionLedger.js"), "stale");
    await writeFile(join(dir, "outside/keep"), "keep");
    const clean = () => execFileSync(process.execPath, [join(dir, "repo/scripts/clean-dist.mjs")], { cwd: join(dir, "outside") });
    clean();
    await assert.rejects(access(join(dir, "repo/dist")));
    await access(join(dir, "outside/keep"));
    await symlink(join(dir, "outside"), join(dir, "repo/dist"));
    clean();
    await access(join(dir, "outside/keep"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("npm package excludes maps and retains public modules, declarations and skills", () => {
  // Do not invoke prepack recursively or mutate source/dist during the test.
  const json = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root, encoding: "utf8", env: { ...process.env, npm_config_progress: "false" },
  }));
  const pack = Array.isArray(json) ? json[0] : Object.values(json)[0];
  const paths = new Set(pack.files.map((file) => file.path));
  assert.equal([...paths].some((path) => path.endsWith(".map")), false);
  for (const path of ["dist/index.js", "dist/index.d.ts", "dist/tui.js", "dist/tui/plugin.js", "dist/tui/plugin.d.ts", "dist/v1/adapter.js", "dist/v2/adapter.js", "index.js", "skills/fleet/SKILL.md", "LICENSE"]) {
    assert.ok(paths.has(path), `missing ${path}`);
  }
});

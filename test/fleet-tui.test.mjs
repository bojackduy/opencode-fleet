// fleet-tui.test.mjs — fleet TUI plugin entry tests (mirrors loopd's
// test/tui/plugin.test.ts + dashboard-tabs coverage at the contract level).
//
// Isolated XDG temp dirs; no real state/config/daemon writes. Imports the
// built dist output, so run `npm run build` first.
// Checks: npm run typecheck, npm run build, node --test test/*.test.mjs

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "fleet-test-boot-"));

const plugin = await import("../dist/tui/plugin.js");
const view = await import("../dist/tui/fleet-view.js");
const toolIndex = await import("../dist/core/tools/index.js");

describe("fleet TUI plugin entry (dual shape)", () => {
  it("exports { id, tui, setup } and keeps the server entry untouched", async () => {
    assert.equal(plugin.PLUGIN_ID, "fleet.tui");
    assert.equal(typeof plugin.default.tui, "function");
    assert.equal(typeof plugin.default.setup, "function");
    assert.equal(plugin.default.id, "fleet.tui");
    const server = await import("../dist/index.js");
    assert.equal(server.default.id, "fleet");
    assert.equal(typeof server.default.server, "function");
    assert.equal(typeof server.default.setup, "function");
  });

  it("resolves the owner session from a v1 route, fail-closed otherwise", () => {
    const api = { route: { current: { name: "session", params: { sessionID: "ses_owner" } } } };
    assert.equal(plugin.currentOwnerSessionID(api), "ses_owner");
    assert.equal(plugin.currentOwnerSessionID({ route: { current: { name: "other", params: {} } } }), undefined);
    assert.equal(plugin.currentOwnerSessionID(null), undefined);
    assert.equal(plugin.currentOwnerSessionID({}), undefined);
  });

  it("adapts a minimal v2 theme without throwing", () => {
    const flat = plugin.adaptThemeV2({});
    for (const k of ["text", "primary", "success", "warning", "error", "background", "border"]) {
      assert.equal(typeof flat[k], "string");
    }
    const partial = plugin.adaptThemeV2({ text: { base: "#111" }, background: { base: "#000" } });
    assert.equal(partial.text, "#111");
  });
});

describe("fleet dashboard contracts (mirror loopd tabs)", () => {
  beforeEach(() => {
    process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "fleet-test-"));
  });

  it("every manual control maps to a registered server tool", () => {
    const names = new Set(toolIndex.ALL_TOOL_DEFS.map((d) => d.name));
    for (const [action, tool] of Object.entries(view.FLEET_ACTION_TOOL)) {
      assert.ok(names.has(tool), `${action} -> ${tool} must stay registered`);
    }
  });

  it("dead rows are never sendable and destructive actions confirm", () => {
    const dead = {
      entry: { sessionId: "s", daemonId: "", directory: "", updatedAt: 0 },
      workerKey: "k",
      ownership: "stale",
      liveness: "dead",
      age: "-",
      sendable: false,
    };
    assert.equal(view.isDeadRow(dead), true);
    assert.equal(view.canSendToRow(dead), false);
    assert.equal(view.needsConfirm("broadcast"), true);
    assert.equal(view.needsConfirm("assign"), false);
  });

  it("tab state starts on workers and moves per-tab", () => {
    const sel = view.initialFleetSelection();
    assert.equal(sel.tab, "workers");
    const counts = { workers: 2, events: 2, assign: 2, threads: 2 };
    const moved = view.moveFleetSelection(sel, "last", counts);
    assert.equal(moved.workerIndex, 1);
    assert.equal(moved.eventIndex, 0);
  });
});

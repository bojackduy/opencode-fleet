// loopd-awareness.test.mjs — read-only loopd goal awareness in fleet rows.
//
// Uses isolated temp project dirs only (fresh per test): no real state writes.
// Imports the built dist output, so run `npm run build` first.
// Checks: npm run typecheck, npm run build, node --test test/loopd-awareness.test.mjs

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "fleet-test-boot-"));

const loopd = await import("../dist/core/loopd.js");
const registry = await import("../dist/core/registry.js");
const auth = await import("../dist/core/auth.js");
const assignments = await import("../dist/core/assignments.js");
const inbox = await import("../dist/core/inbox.js");
const v1mod = await import("../dist/core/v1.js");
const fleetList = await import("../dist/core/tools/fleetList.js");
const fleetAssign = await import("../dist/core/tools/fleetAssign.js");
const fleetStatus = await import("../dist/core/tools/fleetStatus.js");

const { findLoopdGoals, loopdCell, loopdSuffix } = loopd;
const { registerSelf } = registry;
const { addCommander } = auth;
const { assignWorker } = assignments;
const { getDaemonId } = inbox;
const { withV1Marker } = v1mod;

const V1_URL = "http://127.0.0.1:14121";
const V2_DAEMON = "v2:http://127.0.0.1:49374";

function ctxFor(sessionId, extra = {}) {
  return { sessionID: sessionId, ...extra };
}

function depsV1(url = V1_URL) {
  return { rt: { kind: "v1", daemonId: getDaemonId(url), serverUrl: url }, serverUrl: url, client: undefined };
}

/** Fresh isolated project dir with <dir>/.opencode/loopd/state.json written. */
function projectWithState(stateObj) {
  const dir = mkdtempSync(join(tmpdir(), "fleet-loopd-proj-"));
  mkdirSync(join(dir, ".opencode", "loopd"), { recursive: true });
  const p = join(dir, ".opencode", "loopd", "state.json");
  writeFileSync(p, typeof stateObj === "string" ? stateObj : JSON.stringify(stateObj));
  return { dir, statePath: p };
}

function stateWith(goals, runtimes) {
  return { version: 9, revision: 1, goals, runtimes };
}

beforeEach(() => {
  process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "fleet-test-"));
});

describe("findLoopdGoals unit", () => {
  it("matches a worker session and resolves phase from the runtimes list", () => {
    const { dir } = projectWithState(
      stateWith(
        [{ id: "g-1", name: "my-goal", status: "active", ownerSessionID: "ses_owner", workerSessionID: "ses_worker" }],
        [{ goalID: "g-1", phase: "running" }],
      ),
    );
    const m = findLoopdGoals(dir, "ses_worker");
    assert.equal(m.length, 1);
    assert.equal(m[0].goalId, "g-1");
    assert.equal(m[0].name, "my-goal");
    assert.equal(m[0].status, "active");
    assert.equal(m[0].phase, "running");
    assert.equal(m[0].isWorker, true);
    assert.equal(m[0].isOwner, false);
    assert.equal(m[0].ownerSessionId, "ses_owner");
  });

  it("matches an owner session (no workerSessionID set)", () => {
    const { dir } = projectWithState(
      stateWith(
        [{ id: "g-2", name: "owned-goal", status: "paused", ownerSessionID: "ses_cmd" }],
        [{ goalID: "g-2", phase: "idle" }],
      ),
    );
    const m = findLoopdGoals(dir, "ses_cmd");
    assert.equal(m.length, 1);
    assert.equal(m[0].isOwner, true);
    assert.equal(m[0].isWorker, false);
    assert.equal(m[0].phase, "idle");
  });

  it("ignores unrelated sessions and falls back to nested runtime.phase", () => {
    const { dir } = projectWithState(
      stateWith(
        [{ id: "g-3", name: "other", status: "complete", ownerSessionID: "ses_else", runtime: { phase: "done" } }],
        [],
      ),
    );
    assert.deepEqual(findLoopdGoals(dir, "ses_stranger"), []);
    assert.deepEqual(loopdCell(dir, "ses_stranger"), "-");
    assert.equal(loopdSuffix(dir, "ses_stranger"), "");
  });

  it("no state file -> [] and `-` (never throws)", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-loopd-empty-"));
    assert.deepEqual(findLoopdGoals(dir, "ses_x"), []);
    assert.equal(loopdCell(dir, "ses_x"), "-");
    assert.equal(loopdSuffix(dir, "ses_x"), "");
  });

  it("corrupt state -> [] fail-open-read (never throws)", () => {
    const { dir } = projectWithState("{oops not json");
    assert.deepEqual(findLoopdGoals(dir, "ses_x"), []);
    assert.equal(loopdCell(dir, "ses_x"), "-");
    // Non-object / missing-goals shapes also degrade.
    const { dir: d2 } = projectWithState({ version: 9, goals: "nope" });
    assert.deepEqual(findLoopdGoals(d2, "ses_x"), []);
    const { dir: d3 } = projectWithState([1, 2, 3]);
    assert.deepEqual(findLoopdGoals(d3, "ses_x"), []);
  });

  it("invalid inputs -> [] (never throws)", () => {
    assert.deepEqual(findLoopdGoals("", "ses_x"), []);
    assert.deepEqual(findLoopdGoals(null, "ses_x"), []);
    assert.deepEqual(findLoopdGoals("/tmp", ""), []);
    assert.deepEqual(findLoopdGoals("/tmp", null), []);
  });

  it("does not follow a symlinked state.json outside the project", () => {
    const outside = mkdtempSync(join(tmpdir(), "fleet-loopd-out-"));
    const real = join(outside, "state.json");
    writeFileSync(
      real,
      JSON.stringify(
        stateWith(
          [{ id: "g-s", name: "sneaky", status: "active", ownerSessionID: "ses_x" }],
          [{ goalID: "g-s", phase: "running" }],
        ),
      ),
    );
    const dir = mkdtempSync(join(tmpdir(), "fleet-loopd-link-"));
    mkdirSync(join(dir, ".opencode", "loopd"), { recursive: true });
    symlinkSync(real, join(dir, ".opencode", "loopd", "state.json"));
    assert.deepEqual(findLoopdGoals(dir, "ses_x"), []);
  });

  it("is read-only: missing/corrupt reads create no files and touch nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-loopd-ro-"));
    const before = readdirSync(dir);
    assert.deepEqual(findLoopdGoals(dir, "ses_x"), []);
    assert.deepEqual(readdirSync(dir), before);
    const { dir: d2, statePath } = projectWithState("{bad json");
    const content = readFileSync(statePath, "utf8");
    assert.deepEqual(findLoopdGoals(d2, "ses_x"), []);
    assert.equal(readFileSync(statePath, "utf8"), content);
  });
});

describe("row surfacing (v1 + v2, isolated XDG)", () => {
  async function setupOwnedWorker(cmd, worker, projectDir, runtime = "v1", daemonId = null, endpoint = null) {
    const daemon = daemonId ?? (runtime === "v2" ? V2_DAEMON : withV1Marker(getDaemonId(V1_URL)));
    await registerSelf({ sessionId: cmd, daemonId: daemon, directory: "/tmp/cmd", title: "cmd", runtime });
    const entry = { sessionId: worker, daemonId: daemon, directory: projectDir, title: "worker", runtime };
    if (endpoint) entry.endpoint = endpoint;
    await registerSelf(entry);
    await addCommander(cmd);
    const caller = { runtime, daemonId: daemon, sessionId: cmd };
    const r = await assignWorker({ sessionId: worker, runtime, daemonId: daemon }, caller);
    assert.ok(r.ok, `assign failed: ${r.error ?? r.code}`);
  }

  it("fleet_list appends the loopd column (match + `-` when none)", async () => {
    const { dir: withGoal } = projectWithState(
      stateWith(
        [{ id: "g-w", name: "work-goal", status: "active", ownerSessionID: "ses_cmd_L", workerSessionID: "ses_w1" }],
        [{ goalID: "g-w", phase: "running" }],
      ),
    );
    const plain = mkdtempSync(join(tmpdir(), "fleet-loopd-plain-"));
    await setupOwnedWorker("ses_cmd_L", "ses_w1", withGoal);
    // Second worker in a project without loopd state.
    await registerSelf({
      sessionId: "ses_w2",
      daemonId: withV1Marker(getDaemonId(V1_URL)),
      directory: plain,
      title: "plain",
      runtime: "v1",
    });
    const caller = { runtime: "v1", daemonId: withV1Marker(getDaemonId(V1_URL)), sessionId: "ses_cmd_L" };
    assert.ok((await assignWorker({ sessionId: "ses_w2", runtime: "v1", daemonId: caller.daemonId }, caller)).ok);

    const out = await fleetList.fleetListHandler({}, ctxFor("ses_cmd_L"), depsV1());
    const lines = out.split("\n");
    assert.match(lines[0], /sessionId \| runtime \| daemonId \| directory \| summary \| ageH \| loopd/);
    const row1 = lines.find((l) => l.startsWith("ses_w1 "));
    const row2 = lines.find((l) => l.startsWith("ses_w2 "));
    assert.ok(row1, `missing ses_w1 row in:\n${out}`);
    assert.ok(row2, `missing ses_w2 row in:\n${out}`);
    assert.match(row1, /\| work-goal:active\/running$/);
    assert.match(row2, /\| -$/);
  });

  it("fleet_my_workers shows loopd:<name>:<status>/<phase> or `-`", async () => {
    const { dir } = projectWithState(
      stateWith(
        [{ id: "g-m", name: "m-goal", status: "paused", ownerSessionID: "ses_cmd_M", workerSessionID: "ses_wm" }],
        [{ goalID: "g-m", phase: "idle" }],
      ),
    );
    await setupOwnedWorker("ses_cmd_M", "ses_wm", dir);
    const out = await fleetAssign.fleetMyWorkersHandler({}, ctxFor("ses_cmd_M"), depsV1());
    assert.match(out, /workers of ses_cmd_M/);
    assert.match(out, /\| loopd:m-goal:paused\/idle$/m);
  });

  it("fleet_status appends `| loopd:<goal-name>:<status>/<phase>` when matched", async () => {
    const { dir } = projectWithState(
      stateWith(
        [{ id: "g-s", name: "s-goal", status: "active", ownerSessionID: "ses_cmd_S", workerSessionID: "ses_ws" }],
        [{ goalID: "g-s", phase: "running" }],
      ),
    );
    await setupOwnedWorker("ses_cmd_S", "ses_ws", dir);
    const out = await fleetStatus.fleetStatusHandler({}, ctxFor("ses_cmd_S"), depsV1());
    const row = out.split("\n").find((l) => l.startsWith("ses_ws "));
    assert.ok(row, `missing ses_ws row in:\n${out}`);
    assert.match(row, /\| loopd:s-goal:active\/running$/);
  });

  it("v2 worker rows resolve loopd via directory too", async () => {
    const { dir } = projectWithState(
      stateWith(
        [{ id: "g-v", name: "v-goal", status: "active", ownerSessionID: "ses_cmd_V", workerSessionID: "ses_wv" }],
        [{ goalID: "g-v", phase: "running" }],
      ),
    );
    await setupOwnedWorker("ses_cmd_V", "ses_wv", dir, "v2");
    const rt = { kind: "v2", daemonId: V2_DAEMON, serverUrl: "" };
    const out = await fleetList.fleetListHandler(
      {},
      { sessionID: "ses_cmd_V" },
      { rt, serverUrl: "", client: undefined },
    );
    const row = out.split("\n").find((l) => l.startsWith("ses_wv "));
    assert.ok(row, `missing ses_wv row in:\n${out}`);
    assert.match(row, /\| v-goal:active\/running$/);
  });
});

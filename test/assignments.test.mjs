// assignments.test.mjs — Phase A exclusive multi-commander ownership tests.
//
// Uses XDG temp dirs only (fresh per test): no real state writes.
// Imports the built dist output, so run `npm run build` first.
// Checks: npm run typecheck, npm run build, node --test test/assignments.test.mjs

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "fleet-test-boot-"));

const registry = await import("../dist/core/registry.js");
const auth = await import("../dist/core/auth.js");
const assignments = await import("../dist/core/assignments.js");
const notify = await import("../dist/core/notify.js");
const inbox = await import("../dist/core/inbox.js");
const v1mod = await import("../dist/core/v1.js");
const tools = await import("../dist/core/tools/fleetAssign.js");
const toolIndex = await import("../dist/core/tools/index.js");

const {
  registerSelf,
  fleetKeyOf,
  stateDir,
} = registry;
const { addCommander } = auth;
const {
  assignWorker,
  transferWorker,
  unassignWorker,
  unassignAllOwned,
  lookupAssignment,
  listAssignedWorkers,
  listUnassignedWorkers,
  readAssignments,
  assignmentsPath,
} = assignments;
const {
  appendAssignmentEvent,
  readAssignmentEvents,
  ackAssignmentEvent,
} = notify;
const { getDaemonId } = inbox;
const { withV1Marker } = v1mod;
const {
  fleetAssignHandler,
  fleetUnassignHandler,
  fleetTransferHandler,
  fleetMyWorkersHandler,
  fleetUnassignedHandler,
} = tools;

const V1_URL_A = "http://127.0.0.1:14121";
const V1_URL_B = "http://127.0.0.1:14122";
const V2_DAEMON = "v2:http://127.0.0.1:49374";

function v1daemon(url) {
  return withV1Marker(getDaemonId(url));
}

function identV1(sessionId, url = V1_URL_A) {
  return { runtime: "v1", daemonId: v1daemon(url), sessionId };
}

function identV2(sessionId, daemon = V2_DAEMON) {
  return { runtime: "v2", daemonId: daemon, sessionId };
}

function rtV1(url = V1_URL_A) {
  return { kind: "v1", daemonId: getDaemonId(url), serverUrl: url };
}

function rtV2(daemon = V2_DAEMON) {
  return { kind: "v2", daemonId: daemon, serverUrl: "" };
}

function ctxFor(sessionId, extra = {}) {
  return { sessionID: sessionId, ...extra };
}

function depsV1(url = V1_URL_A) {
  const rt = rtV1(url);
  return { rt, serverUrl: url, client: undefined };
}

async function setupPair(cmdSession = "ses_cmd_A", workerSession = "ses_worker_W", url = V1_URL_A) {
  await registerSelf({
    sessionId: cmdSession,
    daemonId: getDaemonId(url),
    directory: `/tmp/${cmdSession}`,
    title: cmdSession,
    runtime: "v1",
  });
  await registerSelf({
    sessionId: workerSession,
    daemonId: getDaemonId(url),
    directory: `/tmp/${workerSession}`,
    title: workerSession,
    runtime: "v1",
  });
  await addCommander(cmdSession);
  return { caller: identV1(cmdSession, url) };
}

beforeEach(() => {
  process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "fleet-test-"));
});

describe("tool registration", () => {
  it("keeps the 20 existing tools plus the 5 ownership tools plus fleet_doctor", () => {
    const names = toolIndex.ALL_TOOL_DEFS.map((d) => d.name);
    assert.equal(names.length, 28);
    assert.equal(new Set(names).size, 28);
    for (const n of [
      "fleet_assign",
      "fleet_unassign",
      "fleet_transfer",
      "fleet_my_workers",
      "fleet_unassigned",
      "fleet_recover_commander",
      "fleet_doctor",
      "fleet_exec",
      "fleet_register",
      "fleet_watch",
      "fleet_claim_commander",
      "fleet_ack",
    ]) {
      assert.ok(names.includes(n), `missing tool ${n}`);
    }
  });
});

describe("unassigned migration + assign + generation", () => {
  it("existing workers read as unassigned; assign stamps generation 1", async () => {
    const { caller } = await setupPair();
    const key = fleetKeyOf(caller);

    const lookup = await lookupAssignment({ sessionId: "ses_worker_W" }, key);
    assert.equal(lookup.kind, "unassigned");

    const un = await listUnassignedWorkers();
    assert.ok(un.ok);
    assert.ok(un.workers.some((e) => e.sessionId === "ses_worker_W"));

    const r = await assignWorker({ sessionId: "ses_worker_W" }, caller);
    assert.ok(r.ok);
    assert.equal(r.assignment.generation, 1);
    assert.equal(r.assignment.commanderKey, key);

    const st = await readAssignments();
    assert.equal(st.status, "ok");
    assert.equal(st.state.generation, 1);

    const owned = await listAssignedWorkers(key);
    assert.ok(owned.ok);
    assert.equal(owned.owned.length, 1);
    assert.equal(owned.owned[0].entry.sessionId, "ses_worker_W");

    const mine = await lookupAssignment({ sessionId: "ses_worker_W" }, key);
    assert.equal(mine.kind, "owned-by-caller");
    const other = await lookupAssignment({ sessionId: "ses_worker_W" }, "v1\u0000other\u0000ses_x");
    assert.equal(other.kind, "owned-by-other");
    assert.equal(other.ownerSessionId, "ses_cmd_A");
  });
});

describe("exclusivity + transfer race", () => {
  it("second commander cannot steal; only the owner can transfer/release", async () => {
    const { caller: a } = await setupPair("ses_cmd_A", "ses_worker_W");
    await registerSelf({
      sessionId: "ses_cmd_B",
      daemonId: getDaemonId(V1_URL_A),
      directory: "/tmp/ses_cmd_B",
      title: "b",
      runtime: "v1",
    });
    await addCommander("ses_cmd_B");
    const b = identV1("ses_cmd_B");

    assert.ok((await assignWorker({ sessionId: "ses_worker_W" }, a)).ok);

    // Steal attempts fail.
    const steal = await assignWorker({ sessionId: "ses_worker_W" }, b);
    assert.equal(steal.ok, false);
    assert.equal(steal.code, "owned-by-other");

    const raceTransfer = await transferWorker({ sessionId: "ses_worker_W" }, { sessionId: "ses_cmd_B" }, b);
    assert.equal(raceTransfer.ok, false);
    assert.equal(raceTransfer.code, "owned-by-other");

    const releaseOther = await unassignWorker({ sessionId: "ses_worker_W" }, b);
    assert.equal(releaseOther.ok, false);

    // Owner transfer works; generation 2; old owner locked out.
    const t = await transferWorker({ sessionId: "ses_worker_W" }, { sessionId: "ses_cmd_B" }, a);
    assert.ok(t.ok);
    assert.equal(t.assignment.generation, 2);
    assert.equal(t.assignment.commanderKey, fleetKeyOf(b));

    const staleRelease = await unassignWorker({ sessionId: "ses_worker_W" }, a);
    assert.equal(staleRelease.ok, false);

    const rel = await unassignWorker({ sessionId: "ses_worker_W" }, b);
    assert.ok(rel.ok);
    assert.equal(rel.generation, 3);

    const again = await lookupAssignment({ sessionId: "ses_worker_W" }, fleetKeyOf(b));
    assert.equal(again.kind, "unassigned");
  });
});

describe("v1/v2 colliding bare IDs", () => {
  it("bare selector is ambiguous; exact composites assign independently", async () => {
    const url = V1_URL_A;
    await registerSelf({ sessionId: "ses_cmd_A", daemonId: getDaemonId(url), directory: "/tmp/a", title: "a", runtime: "v1" });
    await registerSelf({ sessionId: "ses_dup", daemonId: getDaemonId(url), directory: "/tmp/dup1", title: "dup-v1", runtime: "v1" });
    await registerSelf({ sessionId: "ses_dup", daemonId: V2_DAEMON, directory: "/tmp/dup2", title: "dup-v2", runtime: "v2", endpoint: { kind: "v2-service", url: "http://127.0.0.1:49374" } });
    await addCommander("ses_cmd_A");
    const a = identV1("ses_cmd_A", url);

    const bare = await assignWorker({ sessionId: "ses_dup" }, a);
    assert.equal(bare.ok, false);
    assert.equal(bare.code, "ambiguous");
    assert.match(bare.error, /composite selector/);

    const v1sel = { sessionId: "ses_dup", runtime: "v1", daemonId: v1daemon(url) };
    const r1 = await assignWorker(v1sel, a);
    assert.ok(r1.ok);

    const v2sel = { sessionId: "ses_dup", runtime: "v2", daemonId: V2_DAEMON };
    const stillFree = await lookupAssignment(v2sel, fleetKeyOf(a));
    assert.equal(stillFree.kind, "unassigned");

    const r2 = await assignWorker(v2sel, a);
    assert.ok(r2.ok);
    assert.notEqual(r1.assignment.workerKey, r2.assignment.workerKey);
  });
});

describe("unauthorized attach/transfer", () => {
  it("peers denied; forks cannot command even when allowlisted; targets verified", async () => {
    const { caller: a } = await setupPair("ses_cmd_A", "ses_worker_W");
    await registerSelf({ sessionId: "ses_peer", daemonId: getDaemonId(V1_URL_A), directory: "/tmp/peer", title: "peer", runtime: "v1" });
    await registerSelf({ sessionId: "ses_fork", daemonId: getDaemonId(V1_URL_A), directory: "/tmp/fork", title: "fork", runtime: "v1", parentID: "ses_cmd_A" });
    await addCommander("ses_fork"); // allowlisted fork still cannot command
    const peer = identV1("ses_peer");
    const fork = identV1("ses_fork");

    const pAssign = await assignWorker({ sessionId: "ses_worker_W" }, peer);
    assert.equal(pAssign.ok, false);
    assert.equal(pAssign.code, "not-commander");

    const fAssign = await assignWorker({ sessionId: "ses_worker_W" }, fork);
    assert.equal(fAssign.ok, false);
    assert.equal(fAssign.code, "fork-not-commander");

    assert.ok((await assignWorker({ sessionId: "ses_worker_W" }, a)).ok);

    const toPeer = await transferWorker({ sessionId: "ses_worker_W" }, { sessionId: "ses_peer" }, a);
    assert.equal(toPeer.ok, false);
    assert.match(toPeer.error, /target commander/);

    const toGhost = await transferWorker({ sessionId: "ses_worker_W" }, { sessionId: "ses_ghost" }, a);
    assert.equal(toGhost.ok, false);
    assert.equal(toGhost.code, "not-found");

    const selfAssign = await assignWorker({ sessionId: "ses_cmd_A" }, a);
    assert.equal(selfAssign.ok, false);
    assert.equal(selfAssign.code, "self-assign");
  });
});

describe("per-commander event journal", () => {
  it("same-ms ids stay unique+ordered; cursors are independent per commander", async () => {
    const { caller: a } = await setupPair("ses_cmd_A", "ses_worker_W");
    await registerSelf({ sessionId: "ses_cmd_B", daemonId: getDaemonId(V1_URL_A), directory: "/tmp/b", title: "b", runtime: "v1" });
    await addCommander("ses_cmd_B");
    const b = identV1("ses_cmd_B");
    const keyA = fleetKeyOf(a);
    const keyB = fleetKeyOf(b);

    // Same-millisecond appends: unique, ordered ids.
    const at = Date.now();
    const e1 = await appendAssignmentEvent(keyA, { workerKey: "w", generation: 0, type: "idle", at });
    const e2 = await appendAssignmentEvent(keyA, { workerKey: "w", generation: 0, type: "idle", at });
    assert.ok(e1 && e2);
    assert.notEqual(e1.id, e2.id);
    assert.ok(e1.id < e2.id);

    // Ownership ops emit join (A) then transfer (A + B).
    assert.ok((await assignWorker({ sessionId: "ses_worker_W" }, a)).ok);
    const t = await transferWorker({ sessionId: "ses_worker_W" }, { sessionId: "ses_cmd_B" }, a);
    assert.ok(t.ok);

    const ra = await readAssignmentEvents(keyA);
    const rb = await readAssignmentEvents(keyB);
    assert.deepEqual(ra.events.map((e) => e.type), ["idle", "idle", "join", "transfer"]);
    assert.deepEqual(rb.events.map((e) => e.type), ["transfer"]);
    assert.equal(rb.events[0].generation, t.assignment.generation);

    // Ack on A does not move B.
    assert.equal(await ackAssignmentEvent(keyA, e1.id), true);
    const ra2 = await readAssignmentEvents(keyA);
    assert.ok(ra2.events.every((e) => e.id !== e1.id));
    assert.equal(ra2.total, 3);
    const rb2 = await readAssignmentEvents(keyB);
    assert.equal(rb2.total, 1);

    assert.equal(await ackAssignmentEvent(keyA, "nonexistent-id"), false);
  });
});

describe("corrupt state fails closed", () => {
  it("unreadable assignments/auth/registry refuse mutation + readable tool errors", async () => {
    await setupPair();
    const caller = identV1("ses_cmd_A");

    writeFileSync(assignmentsPath(), "{oops not json");
    const bad = await assignWorker({ sessionId: "ses_worker_W" }, caller);
    assert.equal(bad.ok, false);
    assert.equal(bad.code, "state-unreadable");

    const toolText = await fleetAssignHandler(
      { workerSessionId: "ses_worker_W" },
      ctxFor("ses_cmd_A"),
      depsV1(),
    );
    assert.match(toolText, /fleet_assign failed: .*unreadable/);

    // Restore assignments, corrupt auth instead.
    const { unlinkSync } = await import("node:fs");
    unlinkSync(assignmentsPath());
    const authPath = join(stateDir(), "auth.json");
    writeFileSync(authPath, "[1,2,3]");
    const badAuth = await assignWorker({ sessionId: "ses_worker_W" }, caller);
    assert.equal(badAuth.ok, false);
    assert.equal(badAuth.code, "state-unreadable");
    unlinkSync(authPath);

    // Corrupt registry also fails closed.
    writeFileSync(join(stateDir(), "registry.json"), "nope{");
    const badReg = await assignWorker({ sessionId: "ses_worker_W" }, caller);
    assert.equal(badReg.ok, false);
    assert.equal(badReg.code, "state-unreadable");
  });
});

describe("tool handlers end to end", () => {
  it("assign/my_workers/unassigned/transfer/unassign(+all) render readable text", async () => {
    await setupPair("ses_cmd_A", "ses_worker_W");
    await registerSelf({ sessionId: "ses_cmd_B", daemonId: getDaemonId(V1_URL_A), directory: "/tmp/b", title: "b", runtime: "v1" });
    await registerSelf({ sessionId: "ses_worker_V", daemonId: getDaemonId(V1_URL_A), directory: "/tmp/v", title: "v", runtime: "v1" });
    await addCommander("ses_cmd_B");

    const cA = ctxFor("ses_cmd_A");
    const cB = ctxFor("ses_cmd_B");
    const d = depsV1();

    let out = await fleetAssignHandler({ workerSessionId: "ses_worker_W" }, cA, d);
    assert.match(out, /^assigned ses_worker_W to ses_cmd_A \(generation 1\)/);

    out = await fleetAssignHandler({ workerSessionId: "ses_worker_W" }, cB, d);
    assert.match(out, /fleet_assign failed: .*owned by ses_cmd_A/);

    out = await fleetMyWorkersHandler({}, cA, d);
    assert.match(out, /workers of ses_cmd_A/);
    assert.match(out, /ses_worker_W/);

    out = await fleetUnassignedHandler({}, cA, d);
    assert.match(out, /ses_worker_V/);
    assert.ok(!out.includes("ses_worker_W |"), "owned worker must not list as unassigned");

    out = await fleetTransferHandler({ workerSessionId: "ses_worker_W", toCommanderSessionId: "ses_cmd_B" }, cA, d);
    assert.match(out, /^transferred ses_worker_W from ses_cmd_A to ses_cmd_B \(generation 2\)/);

    out = await fleetUnassignHandler({ workerSessionId: "ses_worker_W" }, cA, d);
    assert.match(out, /fleet_unassign failed: .*owned by ses_cmd_B/);

    out = await fleetUnassignHandler({ workerSessionId: "ses_worker_W" }, cB, d);
    assert.match(out, /^released ses_worker_W from ses_cmd_B \(generation 3\)/);

    // Unassign-all path.
    await fleetAssignHandler({ workerSessionId: "ses_worker_W" }, cA, d);
    await fleetAssignHandler({ workerSessionId: "ses_worker_V" }, cA, d);
    out = await fleetUnassignHandler({}, cA, d);
    assert.match(out, /^released 2 worker\(s\) from ses_cmd_A \(generation 6\)/);
    out = await fleetUnassignHandler({}, cA, d);
    assert.match(out, /^no workers assigned to ses_cmd_A/);
  });

  it("v2 caller identity resolves via runtime daemonId", async () => {
    await registerSelf({ sessionId: "ses_cmd_V2", daemonId: V2_DAEMON, directory: "/tmp/v2c", title: "v2c", runtime: "v2", endpoint: { kind: "v2-service", url: "http://127.0.0.1:49374" } });
    await registerSelf({ sessionId: "ses_worker_V2", daemonId: V2_DAEMON, directory: "/tmp/v2w", title: "v2w", runtime: "v2", endpoint: { kind: "v2-service", url: "http://127.0.0.1:49374" } });
    await addCommander("ses_cmd_V2");
    const rt = rtV2();
    const deps = { rt, serverUrl: "", client: undefined };

    const out = await fleetAssignHandler({ workerSessionId: "ses_worker_V2" }, ctxFor("ses_cmd_V2"), deps);
    assert.match(out, /^assigned ses_worker_V2 to ses_cmd_V2 \(generation 1\)/);

    const my = await fleetMyWorkersHandler({}, ctxFor("ses_cmd_V2"), deps);
    assert.match(my, /ses_worker_V2/);
  });
});

describe("unassign edge cases", () => {
  it("releasing an unassigned worker is a readable not-owned error", async () => {
    await setupPair();
    const caller = identV1("ses_cmd_A");
    const r = await unassignWorker({ sessionId: "ses_worker_W" }, caller);
    assert.equal(r.ok, false);
    assert.equal(r.code, "not-owned");

    const all = await unassignAllOwned(caller);
    assert.ok(all.ok);
    assert.equal(all.count, 0);
  });
});

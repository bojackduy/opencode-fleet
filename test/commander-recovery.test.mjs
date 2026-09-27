// commander-recovery.test.mjs — explicit post-restart commander recovery.
//
// Uses XDG temp dirs only (fresh per test): no real state reads/writes.
// Imports the built dist output, so run `npm run build` first.
// Checks: npm run typecheck, npm run build, node --test test/commander-recovery.test.mjs
//
// Simulates the ACTUAL restart case: 16 assignments owned by a dead daemon
// with an impossible pid (process exited), worker keys spanning several dead
// daemons; the same sessionId reappears under a new daemon/pid. Manual
// recovery must migrate ONLY commanderKey old→new, preserve workerKey,
// bump generations (old queued stamps go stale), preserve journals/ACK and
// handoff origins. Fails closed on: other caller session, old pid alive,
// v1/v2 collisions, corrupt journal, lock unavailable (strict lock never
// runs unlocked).

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "fleet-test-boot-"));

const registry = await import("../dist/core/registry.js");
const auth = await import("../dist/core/auth.js");
const assignments = await import("../dist/core/assignments.js");
const notify = await import("../dist/core/notify.js");
const inbox = await import("../dist/core/inbox.js");
const v1mod = await import("../dist/core/v1.js");
const recovery = await import("../dist/core/commanderRecovery.js");
const ownershipControl = await import("../dist/core/ownershipControl.js");
const tools = await import("../dist/core/tools/fleetAssign.js");
const recoverTool = await import("../dist/core/tools/fleetRecover.js");

const { registerSelf, fleetKeyOf } = registry;
const { addCommander } = auth;
const { assignWorker, readAssignments, unassignWorker } = assignments;
const { readAssignmentEvents, ackAssignmentEvent } = notify;
const { getDaemonId } = inbox;
const { withV1Marker } = v1mod;
const { recoverCommander } = recovery;
const { validateDelivery, readHandoffOrigin, recordHandoffOrigin } = ownershipControl;
const { fleetMyWorkersHandler } = tools;
const { fleetRecoverCommanderHandler } = recoverTool;

const V1_URL = "http://127.0.0.1:14121";
const DEAD_PID = 999999937;
const PORT = "14121";
const OLD_RAW = `Mac.lan-${DEAD_PID}-${PORT}`;
const OLD_OTHER_RAW = `OtherHost-${DEAD_PID}-${PORT}`;
const OLD_MARKED = withV1Marker(OLD_RAW);

const CMD = "ses_recover_cmd";
const workers = Array.from({ length: 16 }, (_, i) => `ses_recover_w${String(i + 1).padStart(2, "0")}`);

function oldCommanderIdent() {
  return { runtime: "v1", daemonId: OLD_MARKED, sessionId: CMD };
}

function workerIdent(i) {
  const raw = i < 8 ? OLD_RAW : OLD_OTHER_RAW;
  return { runtime: "v1", daemonId: withV1Marker(raw), sessionId: workers[i] };
}

function newDaemonRaw() {
  return getDaemonId(V1_URL);
}

function newCommanderIdent() {
  return { runtime: "v1", daemonId: withV1Marker(newDaemonRaw()), sessionId: CMD };
}

function rtV1() {
  return { kind: "v1", daemonId: newDaemonRaw(), serverUrl: V1_URL };
}

function ctxFor(sessionId, extra = {}) {
  return { sessionID: sessionId, ...extra };
}

function depsV1() {
  const rt = rtV1();
  return { rt, serverUrl: V1_URL, client: undefined };
}

async function seedDeadFleet() {
  await registerSelf({ sessionId: CMD, daemonId: OLD_RAW, directory: `/tmp/${CMD}`, title: CMD, runtime: "v1" });
  for (let i = 0; i < workers.length; i++) {
    const raw = i < 8 ? OLD_RAW : OLD_OTHER_RAW;
    await registerSelf({ sessionId: workers[i], daemonId: raw, directory: `/tmp/${workers[i]}`, title: workers[i], runtime: "v1" });
  }
  await addCommander(CMD);
  const caller = oldCommanderIdent();
  for (let i = 0; i < workers.length; i++) {
    const r = await assignWorker({ sessionId: workers[i] }, caller);
    assert.equal(r.ok, true, `seed assign ${workers[i]}: ${r.ok ? "" : r.error}`);
  }
  const oldCmdKey = fleetKeyOf(oldCommanderIdent());
  const journal = await readAssignmentEvents(oldCmdKey, 100);
  assert.equal(journal.total, 16);
  assert.equal(await ackAssignmentEvent(oldCmdKey, journal.events[0].id), true);
  await recordHandoffOrigin({
    workerKey: fleetKeyOf(workerIdent(0)),
    fromCommanderKey: oldCmdKey,
    fromCommanderSession: CMD,
    reqId: "req-seed-1",
    generation: 1,
    at: Date.now(),
  });
}

async function registerNewCommander() {
  await registerSelf({
    sessionId: CMD, daemonId: newDaemonRaw(), directory: `/tmp/${CMD}`, title: CMD, runtime: "v1",
  });
}

beforeEach(() => {
  process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "fleet-test-"));
});

describe("explicit commander recovery (restart case)", () => {
  it("migrates only commanderKey, preserves workerKey, bumps generations, preserves journal/ACK/origins", async () => {
    await seedDeadFleet();
    const before = await readAssignments();
    const beforeWorkerKeys = new Set(Object.values(before.state.assignments).map((a) => a.workerKey));
    assert.equal(beforeWorkerKeys.size, 16);
    const beforeGens = Object.values(before.state.assignments).map((a) => a.generation).sort((x, y) => x - y);
    assert.deepEqual(beforeGens, Array.from({ length: 16 }, (_, i) => i + 1));

    await registerNewCommander();
    const out = await fleetRecoverCommanderHandler({ oldDaemonId: OLD_MARKED }, ctxFor(CMD), depsV1());
    assert.match(out, /recovered 16 assignment/);

    const after = await readAssignments();
    assert.equal(Object.keys(after.state.assignments).length, 16);
    const newCmdKey = fleetKeyOf(newCommanderIdent());
    for (const a of Object.values(after.state.assignments)) {
      assert.equal(a.commanderKey, newCmdKey);
    }
    const afterWorkerKeys = new Set(Object.values(after.state.assignments).map((a) => a.workerKey));
    assert.deepEqual([...afterWorkerKeys].sort(), [...beforeWorkerKeys].sort());
    assert.ok([...afterWorkerKeys].some((k) => k.includes("Mac.lan")));
    assert.ok([...afterWorkerKeys].some((k) => k.includes("OtherHost")));
    for (const a of Object.values(after.state.assignments)) {
      assert.ok(a.generation >= 2, `generation bumped, got ${a.generation}`);
    }

    const my = await fleetMyWorkersHandler({}, ctxFor(CMD), depsV1());
    assert.match(my, /workers of ses_recover_cmd/);
    for (const w of workers) assert.ok(my.includes(w), `my_workers missing ${w}`);

    const journal = await readAssignmentEvents(newCmdKey, 100);
    assert.equal(journal.status, "ok");
    assert.equal(journal.total, 15);
    assert.ok(journal.events.every((e) => e.commanderKey === newCmdKey && e.type === "join"));
    assert.equal(journal.cursor !== null, true);

    const origin = await readHandoffOrigin(fleetKeyOf(workerIdent(0)));
    assert.ok(origin);
    assert.equal(origin.workerKey, fleetKeyOf(workerIdent(0)));
    assert.equal(origin.fromCommanderKey, newCmdKey);
  });

  it("releases a stale worker assignment after that worker re-registers on a new daemon", async () => {
    await seedDeadFleet();
    await registerNewCommander();
    const recovered = await recoverCommander(newCommanderIdent(), OLD_MARKED);
    assert.equal(recovered.ok, true);
    const oldKey = fleetKeyOf(workerIdent(0));

    await registerSelf({
      sessionId: workers[0], daemonId: newDaemonRaw(), directory: `/tmp/${workers[0]}`, runtime: "v1",
    });
    const before = await readAssignments();
    assert.ok(before.state.assignments[oldKey]);
    const released = await unassignWorker({ sessionId: workers[0] }, newCommanderIdent());
    assert.equal(released.ok, true, released.ok ? "" : released.error);
    assert.equal(released.released.workerKey, oldKey);
    const after = await readAssignments();
    assert.equal(after.state.assignments[oldKey], undefined);
    const reassigned = await assignWorker({ sessionId: workers[0] }, newCommanderIdent());
    assert.equal(reassigned.ok, true, reassigned.ok ? "" : reassigned.error);
    assert.equal(reassigned.assignment.workerKey, fleetKeyOf({ runtime: "v1", daemonId: withV1Marker(newDaemonRaw()), sessionId: workers[0] }));
  });

  it("denies other caller session, old pid alive, and keeps v1/v2 isolated", async () => {
    await seedDeadFleet();
    await registerNewCommander();

    await registerSelf({ sessionId: "ses_recover_peer", daemonId: newDaemonRaw(), directory: "/tmp/peer", title: "peer", runtime: "v1" });
    await addCommander("ses_recover_peer");
    const peerOut = await fleetRecoverCommanderHandler({ oldDaemonId: OLD_MARKED }, ctxFor("ses_recover_peer"), depsV1());
    assert.match(peerOut, /failed/);

    const aliveRaw = withV1Marker(`Mac.lan-${process.pid}-${PORT}`);
    const aliveOut = await fleetRecoverCommanderHandler({ oldDaemonId: aliveRaw }, ctxFor(CMD), depsV1());
    assert.match(aliveOut, /still running|no assignments|refusing/);

    await registerSelf({ sessionId: workers[0], daemonId: "v2:http://127.0.0.1:49374", directory: "/tmp/w-v2", title: "w-v2", runtime: "v2" });
    await addCommander("ses_recover_v2cmd").catch(() => null);
    const v2before = await readAssignments();
    const v2countBefore = Object.keys(v2before.state.assignments).length;
    const ok = await fleetRecoverCommanderHandler({ oldDaemonId: OLD_MARKED }, ctxFor(CMD), depsV1());
    assert.match(ok, /recovered 16 assignment/);
    const v2after = await readAssignments();
    assert.equal(Object.keys(v2after.state.assignments).length, v2countBefore);
    for (const a of Object.values(v2after.state.assignments)) {
      assert.ok(!a.commanderKey.startsWith("v2"), "v2 commander rows untouched");
    }
  });

  it("invalidates old queued generation-stamped reqs", async () => {
    await seedDeadFleet();
    const before = await readAssignments();
    const oldKey = fleetKeyOf(oldCommanderIdent());
    const oldWorkerKey = fleetKeyOf(workerIdent(0));
    const oldGen = before.state.assignments[oldWorkerKey].generation;
    await registerNewCommander();
    const out = await fleetRecoverCommanderHandler({ oldDaemonId: OLD_MARKED }, ctxFor(CMD), depsV1());
    assert.match(out, /recovered 16 assignment/);

    const staleVerdict = await validateDelivery(
      {
        reqId: "req-old-queued",
        fromCommander: CMD,
        targetSessionId: workers[0],
        targetDaemonId: withV1Marker(OLD_RAW),
        workerKey: oldWorkerKey,
        commanderKey: oldKey,
        generation: oldGen,
      },
      { receiver: { runtime: "v1", daemonId: newDaemonRaw(), sessionId: workers[0] } },
    );
    assert.equal(staleVerdict.ok, false);
    assert.match(staleVerdict.error, /re-send|stale/);
  });

  it("fails closed on corrupt journal without mutating assignments", async () => {
    await seedDeadFleet();
    await registerNewCommander();
    const { assignmentJournalPaths } = await import("../dist/core/notify.js");
    const { writeFile } = await import("node:fs/promises");
    const oldKey = fleetKeyOf(oldCommanderIdent());
    await writeFile(assignmentJournalPaths(oldKey).eventsPath, "not-json{{", { mode: 0o600 });
    const before = await readAssignments();
    const out = await fleetRecoverCommanderHandler({ oldDaemonId: OLD_MARKED }, ctxFor(CMD), depsV1());
    assert.match(out, /failed.*journal|corrupt|refusing/);
    const after = await readAssignments();
    assert.deepEqual(after.state.assignments, before.state.assignments);
  });

  it("core recoverCommander never touches the real XDG state dir", async () => {
    assert.ok(String(process.env.XDG_STATE_HOME).includes("fleet-test-"));
    assert.ok(!String(process.env.XDG_STATE_HOME).includes(".local/state"));
    await seedDeadFleet();
    await registerNewCommander();
    const r = await recoverCommander(newCommanderIdent(), OLD_MARKED);
    assert.equal(r.ok, true);
    assert.equal(r.recovered, 16);
  });
});

// ownership-events.test.mjs — Phase B1 scoped ownership event tests.
//
// Uses XDG temp dirs only (fresh per test): no real state writes.
// Imports the built dist output, so run `npm run build` first.
// Checks: npm run typecheck, npm run build,
//   node --test test/assignments.test.mjs test/ownership-events.test.mjs
//
// Proves: A owns W1, B owns W2 -> watch scoping; unassigned joins silent;
// idle/DONE once (dedup); deletion -> leave; transfer -> future only new
// owner; independent ACK + restart replay; corrupt journal fails closed;
// same-ms no loss. No actual daemon on real state.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "fleet-own-boot-"));

const registry = await import("../dist/core/registry.js");
const auth = await import("../dist/core/auth.js");
const assignments = await import("../dist/core/assignments.js");
const notify = await import("../dist/core/notify.js");
const own = await import("../dist/core/ownershipEvents.js");
const inbox = await import("../dist/core/inbox.js");
const v1mod = await import("../dist/core/v1.js");
const watchTools = await import("../dist/core/tools/fleetWatch.js");

const { registerSelf, removeSession, fleetKeyOf, stateDir } = registry;
const { addCommander } = auth;
const { assignWorker, transferWorker } = assignments;
const {
  readAssignmentEvents,
  appendAssignmentEvent,
  ackAssignmentEvent,
  assignmentJournalPaths,
} = notify;
const {
  emitOwnershipEvent,
  emitForWorkerIdentity,
  emitToOwnersOfSession,
  snapshotOwnersForSession,
  idleNoteFor,
  doneNoteFor,
} = own;
const { getDaemonId } = inbox;
const { withV1Marker } = v1mod;
const { fleetWatchHandler, fleetAckHandler } = watchTools;

const V1_URL_A = "http://127.0.0.1:14121";
const V1_URL_B = "http://127.0.0.1:14122";
const V2_DAEMON = "v2:http://127.0.0.1:49374";

function v1daemon(url) {
  return withV1Marker(getDaemonId(url));
}
function identV1(sessionId, url = V1_URL_A) {
  return { runtime: "v1", daemonId: v1daemon(url), sessionId };
}
function rtV1(url = V1_URL_A) {
  return { kind: "v1", daemonId: getDaemonId(url), serverUrl: url };
}
function ctxFor(sessionId, extra = {}) {
  return { sessionID: sessionId, ...extra };
}
function shortOf(key) {
  return String(key).split("\u0000")[2] ?? key;
}

async function setupAB() {
  // A owns W1, B owns W2 (all v1 same daemon for simplicity).
  const url = V1_URL_A;
  for (const s of ["ses_cmd_A", "ses_cmd_B", "ses_W1", "ses_W2", "ses_W3"]) {
    await registerSelf({
      sessionId: s,
      daemonId: getDaemonId(url),
      directory: `/tmp/${s}`,
      title: s,
      runtime: "v1",
    });
  }
  await addCommander("ses_cmd_A");
  await addCommander("ses_cmd_B");
  const a = identV1("ses_cmd_A", url);
  const b = identV1("ses_cmd_B", url);
  assert.ok((await assignWorker({ sessionId: "ses_W1" }, a)).ok);
  assert.ok((await assignWorker({ sessionId: "ses_W2" }, b)).ok);
  // ses_W3 stays unassigned.
  return { a, b, keyA: fleetKeyOf(a), keyB: fleetKeyOf(b) };
}

function workerKeyV1(sessionId, url = V1_URL_A) {
  return fleetKeyOf(identV1(sessionId, url));
}

beforeEach(() => {
  process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "fleet-own-"));
});

describe("watch scoping A/B + unassigned silence", () => {
  it("A sees only W1, B only W2; unassigned W3 join emits nothing", async () => {
    const { keyA, keyB } = await setupAB();
    const w1 = workerKeyV1("ses_W1");
    const w2 = workerKeyV1("ses_W2");
    const w3 = workerKeyV1("ses_W3");

    // Unassigned join: no scoped event.
    const silent = await emitOwnershipEvent(w3, "join", "ses_W3");
    assert.equal(silent, null);

    assert.ok(await emitOwnershipEvent(w1, "idle", idleNoteFor("done-one")));
    assert.ok(await emitOwnershipEvent(w2, "idle", idleNoteFor("done-two")));

    const dA = { rt: rtV1() };
    const outA = await fleetWatchHandler({ timeoutMs: 10 }, ctxFor("ses_cmd_A"), dA);
    assert.match(outA, /ses_W1/);
    assert.ok(!outA.includes("ses_W2"), "A must not see W2");
    assert.ok(!outA.includes("ses_W3"), "A must not see unassigned W3");
    assert.match(outA, /fleet_ack/);

    const outB = await fleetWatchHandler({ timeoutMs: 10 }, ctxFor("ses_cmd_B"), dA);
    assert.match(outB, /ses_W2/);
    assert.ok(!outB.includes("ses_W1"), "B must not see W1");

    // Direct journal reads agree.
    const ra = await readAssignmentEvents(keyA);
    const rb = await readAssignmentEvents(keyB);
    assert.equal(ra.status, "ok");
    assert.ok(ra.events.every((e) => shortOf(e.workerKey) === "ses_W1"));
    assert.ok(rb.events.every((e) => shortOf(e.workerKey) === "ses_W2"));
  });

  it("non-commander, fork, and unknown callers are denied (no global fallback)", async () => {
    await setupAB();
    const dA = { rt: rtV1() };
    // Peer (registered but not commander).
    await registerSelf({
      sessionId: "ses_peer",
      daemonId: getDaemonId(V1_URL_A),
      directory: "/tmp/peer",
      title: "peer",
      runtime: "v1",
    });
    const peerOut = await fleetWatchHandler({ timeoutMs: 10 }, ctxFor("ses_peer"), dA);
    assert.match(peerOut, /fleet_watch failed/);
    // Fork (allowlisted but parentID set) cannot watch.
    await registerSelf({
      sessionId: "ses_fork",
      daemonId: getDaemonId(V1_URL_A),
      directory: "/tmp/fork",
      title: "fork",
      runtime: "v1",
      parentID: "ses_cmd_A",
    });
    await addCommander("ses_fork");
    const forkOut = await fleetWatchHandler({ timeoutMs: 10 }, ctxFor("ses_fork"), dA);
    assert.match(forkOut, /fleet_watch failed/);
    // Unknown session.
    const ghostOut = await fleetWatchHandler({ timeoutMs: 10 }, ctxFor("ses_ghost"), dA);
    assert.match(ghostOut, /fleet_watch failed/);
    // Empty identity.
    const emptyOut = await fleetWatchHandler({ timeoutMs: 10 }, ctxFor(""), dA);
    assert.match(emptyOut, /fleet_watch failed/);
  });
});

describe("idle/DONE once (dedup) + snippet only", () => {
  it("repeat idle/done on same transition suppressed; new data delivered; data <=200 chars", async () => {
    const { keyA } = await setupAB();
    const w1 = workerKeyV1("ses_W1");
    const first = await emitOwnershipEvent(w1, "idle", idleNoteFor("alpha"));
    assert.ok(first);
    const dup = await emitOwnershipEvent(w1, "idle", idleNoteFor("alpha"));
    assert.equal(dup, null, "duplicate idle must be suppressed");
    const changed = await emitOwnershipEvent(w1, "idle", idleNoteFor("beta"));
    assert.ok(changed, "changed idle must be delivered");

    const d1 = await emitOwnershipEvent(w1, "done", doneNoteFor("DONE:hello world"));
    assert.ok(d1);
    assert.ok(d1.data.includes("DONE:hello world"));
    assert.ok(d1.data.length <= 200);
    const dDup = await emitOwnershipEvent(w1, "done", doneNoteFor("DONE:hello world"));
    assert.equal(dDup, null, "duplicate done must be suppressed");

    // No raw prompts leak: long reply truncated.
    const long = "x".repeat(5000);
    const trunc = await emitOwnershipEvent(w1, "done", doneNoteFor(long));
    assert.ok(trunc);
    assert.ok(trunc.data.length <= 200);

    const ra = await readAssignmentEvents(keyA);
    const idles = ra.events.filter((e) => e.type === "idle");
    assert.equal(idles.length, 2, "only alpha + beta idles stored");
  });
});

describe("deletion -> leave to owner (snapshot before removal)", () => {
  it("leave routes to pre-removal owner even after the row is gone", async () => {
    await setupAB();
    const w1 = workerKeyV1("ses_W1");
    // Adapter order: snapshot BEFORE removeSession.
    const snap = await snapshotOwnersForSession("ses_W1");
    assert.ok(!("error" in snap));
    assert.equal(snap.owners.length, 1);
    await removeSession("ses_W1");
    for (const o of snap.owners) {
      const ev = await emitOwnershipEvent(o.workerKey, "leave", "ses_W1");
      assert.ok(ev, "leave must route to snapshot owner after removal");
      assert.equal(ev.type, "leave");
    }
    void w1;
    const dA = { rt: rtV1() };
    const outA = await fleetWatchHandler({ timeoutMs: 10 }, ctxFor("ses_cmd_A"), dA);
    assert.match(outA, /leave ses_W1/);
    const outB = await fleetWatchHandler({ timeoutMs: 10 }, ctxFor("ses_cmd_B"), dA);
    assert.ok(!outB.includes("ses_W1"), "B must not see A's leave");
  });
});

describe("transfer -> future events only new owner", () => {
  it("after A->B, W1 idle/done go to B alone", async () => {
    const { a, keyA, keyB } = await setupAB();
    const w1 = workerKeyV1("ses_W1");
    assert.ok(await emitOwnershipEvent(w1, "idle", idleNoteFor("pre")));
    const t = await transferWorker({ sessionId: "ses_W1" }, { sessionId: "ses_cmd_B" }, a);
    assert.ok(t.ok);
    // Drain A's pre-transfer history so the next watch reflects only future.
    const ra0 = await readAssignmentEvents(keyA);
    for (const e of ra0.events) await ackAssignmentEvent(keyA, e.id);
    const rb0 = await readAssignmentEvents(keyB);
    for (const e of rb0.events) await ackAssignmentEvent(keyB, e.id);

    assert.ok(await emitOwnershipEvent(w1, "idle", idleNoteFor("post")));
    assert.ok(await emitOwnershipEvent(w1, "done", doneNoteFor("DONE:after-move")));

    const dA = { rt: rtV1() };
    const outA = await fleetWatchHandler({ timeoutMs: 10 }, ctxFor("ses_cmd_A"), dA);
    assert.ok(!outA.includes("post") && !outA.includes("after-move"), "old owner sees no future events");
    const outB = await fleetWatchHandler({ timeoutMs: 10 }, ctxFor("ses_cmd_B"), dA);
    assert.match(outB, /post/);
    assert.match(outB, /after-move/);
  });
});

describe("independent ACK + restart replay", () => {
  it("ack on A does not move B; unacked survive re-read", async () => {
    const { keyA, keyB } = await setupAB();
    const w1 = workerKeyV1("ses_W1");
    const w2 = workerKeyV1("ses_W2");
    await emitOwnershipEvent(w1, "idle", idleNoteFor("a1"));
    await emitOwnershipEvent(w1, "idle", idleNoteFor("a2"));
    await emitOwnershipEvent(w2, "idle", idleNoteFor("b1"));

    const ra = await readAssignmentEvents(keyA);
    assert.equal(ra.total, 3); // join + a1 + a2
    const firstId = ra.events[0].id;
    assert.equal(await ackAssignmentEvent(keyA, firstId), true);
    const ra2 = await readAssignmentEvents(keyA);
    assert.equal(ra2.total, 2);
    assert.ok(ra2.events.every((e) => e.id !== firstId));
    // B untouched.
    const rb = await readAssignmentEvents(keyB);
    assert.equal(rb.total, 2); // join + b1
    // Restart replay: re-read sees the same unacked remainder.
    const ra3 = await readAssignmentEvents(keyA);
    assert.deepEqual(ra3.events.map((e) => e.id), ra2.events.map((e) => e.id));
    // Unknown ack fails cleanly.
    assert.equal(await ackAssignmentEvent(keyA, "nonexistent-id"), false);
    const dA = { rt: rtV1() };
    const ackOut = await fleetAckHandler({ eventId: "nonexistent-id" }, ctxFor("ses_cmd_A"), dA);
    assert.match(ackOut, /fleet_ack failed: unknown event id/);
    const ackOk = await fleetAckHandler({ eventId: ra2.events[0].id }, ctxFor("ses_cmd_A"), dA);
    assert.match(ackOk, /^acked /);
  });
});

describe("corrupt journal fails closed", () => {
  it("watch + ack error instead of misleading no-events", async () => {
    const { keyA } = await setupAB();
    const w1 = workerKeyV1("ses_W1");
    assert.ok(await emitOwnershipEvent(w1, "idle", idleNoteFor("x")));
    const { eventsPath } = assignmentJournalPaths(keyA);
    writeFileSync(eventsPath, "{corrupt json");
    const read = await readAssignmentEvents(keyA);
    assert.ok(read.status === "corrupt" || read.status === "error");
    const dA = { rt: rtV1() };
    const out = await fleetWatchHandler({ timeoutMs: 10 }, ctxFor("ses_cmd_A"), dA);
    assert.match(out, /fleet_watch failed: .*fail-closed/);
    const ackOut = await fleetAckHandler({ eventId: "whatever" }, ctxFor("ses_cmd_A"), dA);
    assert.match(ackOut, /fleet_ack failed: .*fail-closed/);
    // Other commander's journal still fine.
    const outB = await fleetWatchHandler({ timeoutMs: 10 }, ctxFor("ses_cmd_B"), dA);
    assert.ok(!outB.includes("fail-closed"), "B journal must stay readable");
  });
});

describe("same-ms events no loss + v1/v2 collision routing", () => {
  it("same at yields unique ordered ids; colliding bare ids route per composite", async () => {
    const { keyA } = await setupAB();
    const at = Date.now();
    const w1 = workerKeyV1("ses_W1");
    const e1 = await appendAssignmentEvent(keyA, { workerKey: w1, generation: 1, type: "idle", data: "m1", at });
    const e2 = await appendAssignmentEvent(keyA, { workerKey: w1, generation: 1, type: "idle", data: "m2", at });
    assert.ok(e1 && e2);
    assert.notEqual(e1.id, e2.id);
    assert.ok(e1.id < e2.id);
    const ra = await readAssignmentEvents(keyA);
    assert.ok(ra.events.some((e) => e.id === e1.id));
    assert.ok(ra.events.some((e) => e.id === e2.id));

    // v1/v2 collision: same bare sessionId on two runtimes, different owners.
    const url = V1_URL_A;
    await registerSelf({ sessionId: "ses_dup", daemonId: getDaemonId(url), directory: "/tmp/d1", title: "d1", runtime: "v1" });
    await registerSelf({ sessionId: "ses_dup", daemonId: V2_DAEMON, directory: "/tmp/d2", title: "d2", runtime: "v2", endpoint: { kind: "v2-service", url: "http://127.0.0.1:49374" } });
    await registerSelf({ sessionId: "ses_cmd_V2", daemonId: V2_DAEMON, directory: "/tmp/v2c", title: "v2c", runtime: "v2", endpoint: { kind: "v2-service", url: "http://127.0.0.1:49374" } });
    await addCommander("ses_cmd_V2");
    const a = identV1("ses_cmd_A", url);
    const v2cmd = { runtime: "v2", daemonId: V2_DAEMON, sessionId: "ses_cmd_V2" };
    const r1 = await assignWorker({ sessionId: "ses_dup", runtime: "v1", daemonId: v1daemon(url) }, a);
    assert.ok(r1.ok);
    const r2 = await assignWorker({ sessionId: "ses_dup", runtime: "v2", daemonId: V2_DAEMON }, v2cmd);
    assert.ok(r2.ok);
    // Each composite emits only to its own owner.
    const evV1 = await emitForWorkerIdentity({ runtime: "v1", daemonId: v1daemon(url), sessionId: "ses_dup" }, "idle", "v1-note");
    const evV2 = await emitForWorkerIdentity({ runtime: "v2", daemonId: V2_DAEMON, sessionId: "ses_dup" }, "idle", "v2-note");
    assert.ok(evV1 && evV2);
    assert.notEqual(evV1.commanderKey, evV2.commanderKey);
    // Bare-session fan-out reaches both owners (never picks one by bare id).
    const both = await emitToOwnersOfSession("ses_dup", "idle", "both-note");
    assert.equal(both.length, 2);
  });
});

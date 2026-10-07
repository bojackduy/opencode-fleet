// ownership-control.test.mjs — Phase B2 exclusive-ownership control-plane tests.
//
// Uses XDG temp dirs only (fresh per test): no real state writes.
// Imports the built dist output, so run `npm run build` first.
// Checks: npm run typecheck, npm run build, node --test test/ownership-control.test.mjs
//
// Covers: A owns W1 + B owns W2; foreign deny (exec/broadcast/status, force
// included); default broadcast owner-only; sender+receiver generation checks;
// transfer-queued stale denial; legacy envelope rejection; v1/v2 collisions;
// durable handoff origin surviving .req cleanup and routing to the CURRENT
// owner; restart persistence; normal message + agent/model/variant preserved;
// policy hold/refuse preserved; fail-closed corrupt state on the new paths.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "fleet-test-boot-"));

const registry = await import("../dist/core/registry.js");
const auth = await import("../dist/core/auth.js");
const assignments = await import("../dist/core/assignments.js");
const control = await import("../dist/core/ownershipControl.js");
const transport = await import("../dist/core/fileTransport.js");
const assignTools = await import("../dist/core/tools/fleetAssign.js");
const execTools = await import("../dist/core/tools/fleetExec.js");
const broadcastTools = await import("../dist/core/tools/fleetBroadcast.js");
const listTools = await import("../dist/core/tools/fleetList.js");
const statusTools = await import("../dist/core/tools/fleetStatus.js");
const adminTools = await import("../dist/core/tools/fleetAdmin.js");
const rolesTools = await import("../dist/core/tools/fleetRoles.js");
const discoverTools = await import("../dist/core/tools/fleetDiscover.js");
const handoffTools = await import("../dist/core/tools/fleetHandoff.js");
const inbox = await import("../dist/core/inbox.js");
const v1mod = await import("../dist/core/v1.js");

const { registerSelf, fleetKeyOf, stateDir } = registry;
const { addCommander, setPolicy, getPolicy } = auth;
const { assignWorker, transferWorker, readAssignments, assignmentsPath } = assignments;
const {
  gateSendToWorker,
  stampEnvelope,
  validateDelivery,
  recordHandoffOrigin,
  readHandoffOrigin,
  currentOwnerSessionOf,
  scopedRegistryEntries,
  scopedViewFor,
} = control;
const { writeReq, readReq, cleanupReq } = transport;
const { getDaemonId } = inbox;
const { withV1Marker } = v1mod;

const V1_URL_A = "http://127.0.0.1:14121";
const V2_DAEMON = "v2:http://127.0.0.1:49374";

function ctxFor(sessionId, extra = {}) {
  return { sessionID: sessionId, ...extra };
}

function depsV1(url = V1_URL_A) {
  return { rt: { kind: "v1", daemonId: getDaemonId(url), serverUrl: url }, serverUrl: url, client: undefined };
}

function identV1(sessionId, url = V1_URL_A) {
  return { runtime: "v1", daemonId: withV1Marker(getDaemonId(url)), sessionId };
}

async function setupTwoOwners() {
  for (const sid of ["ses_cmd_A", "ses_cmd_B", "ses_worker_W1", "ses_worker_W2"]) {
    await registerSelf({
      sessionId: sid,
      daemonId: getDaemonId(V1_URL_A),
      directory: `/tmp/${sid}`,
      title: sid,
      runtime: "v1",
    });
  }
  await addCommander("ses_cmd_A");
  await addCommander("ses_cmd_B");
  const r1 = await assignWorker({ sessionId: "ses_worker_W1" }, identV1("ses_cmd_A"));
  assert.ok(r1.ok);
  const r2 = await assignWorker({ sessionId: "ses_worker_W2" }, identV1("ses_cmd_B"));
  assert.ok(r2.ok);
  return { gen1: r1.assignment.generation, gen2: r2.assignment.generation };
}

beforeEach(() => {
  process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "fleet-test-"));
});

describe("two commanders own disjoint workers; scoped views", () => {
  it("A sees only W1 by default; scope:all is explicit; status/summary scoped", async () => {
    await setupTwoOwners();
    const d = depsV1();
    const cA = ctxFor("ses_cmd_A");

    const list = await listTools.fleetListHandler({}, cA, d);
    assert.match(list, /ses_worker_W1/);
    assert.ok(!list.includes("ses_worker_W2"), "default list must not leak foreign worker");

    const all = await listTools.fleetListHandler({ scope: "all" }, cA, d);
    assert.match(all, /ses_worker_W1/);
    assert.match(all, /ses_worker_W2/);

    const status = await statusTools.fleetStatusHandler({}, cA, d);
    assert.match(status, /ses_worker_W1/);
    assert.ok(!status.includes("ses_worker_W2"), "default status must not leak foreign worker");

    const summary = await adminTools.fleetSummaryHandler({ groupBy: "directory" }, cA, d);
    assert.match(summary, /ses_worker_W1|tmp/);
    assert.ok(!summary.includes("ses_worker_W2"), "summary must not aggregate foreign workers");

    const view = await scopedViewFor(cA, d.rt);
    assert.ok(view.ok);
    assert.equal(view.ownedKeys.size, 1);
  });

  it("tree + discover hide foreign workers by default; scope:all is explicit", async () => {
    await setupTwoOwners();
    const d = depsV1();
    const cA = ctxFor("ses_cmd_A");

    const tree = await rolesTools.fleetTreeHandler({}, cA, d);
    assert.match(tree, /ses_worker_W1/);
    assert.ok(!tree.includes("ses_worker_W2"), "default tree must not leak foreign worker");

    const treeAll = await rolesTools.fleetTreeHandler({ scope: "all" }, cA, d);
    assert.match(treeAll, /ses_worker_W1/);
    assert.match(treeAll, /ses_worker_W2/);

    const ghostTree = await rolesTools.fleetTreeHandler({}, ctxFor("ses_ghost"), d);
    assert.match(ghostTree, /fleet_tree failed/);

    // Discover falls back to registry rows in isolated XDG (no live sqlite).
    const disc = await discoverTools.fleetDiscoverHandler({ limit: 15 }, cA, d);
    if (disc !== "no sessions discovered") {
      assert.match(disc, /ses_worker_W1/);
      assert.ok(!disc.includes("ses_worker_W2"), "default discover must not leak foreign worker");
    }

    const discAll = await discoverTools.fleetDiscoverHandler({ limit: 15, scope: "all" }, cA, d);
    if (discAll !== "no sessions discovered") {
      assert.match(discAll, /ses_worker_W1/);
      assert.match(discAll, /ses_worker_W2/);
    }

    const ghostDiscAll = await discoverTools.fleetDiscoverHandler(
      { limit: 15, scope: "all" },
      ctxFor("ses_ghost"),
      d,
    );
    assert.match(ghostDiscAll, /fleet_discover failed/);

    // Unknown callers keep only unassigned rows, never owned ones.
    const ghostDisc = await discoverTools.fleetDiscoverHandler({ limit: 15 }, ctxFor("ses_ghost"), d);
    if (ghostDisc !== "no sessions discovered") {
      assert.ok(!ghostDisc.includes("ses_worker_W1"), "unknown caller must not see owned rows");
      assert.ok(!ghostDisc.includes("ses_worker_W2"), "unknown caller must not see owned rows");
    }
  });
});

describe("foreign control denied (exec/broadcast/status, force included)", () => {
  it("A cannot exec/status/broadcast to W2; force:true never bypasses ownership", async () => {
    await setupTwoOwners();
    const d = depsV1();
    const cA = ctxFor("ses_cmd_A");

    const exec = await execTools.fleetExecHandler(
      { sessionId: "ses_worker_W2", message: "do work\n\nDONE: done", timeoutMs: 1000 },
      cA,
      d,
    );
    assert.match(exec, /fleet_exec failed: .*owned by ses_cmd_B/);

    const execForce = await execTools.fleetExecHandler(
      { sessionId: "ses_worker_W2", message: "do work\n\nDONE: done", force: true, timeoutMs: 1000 },
      cA,
      d,
    );
    assert.match(execForce, /fleet_exec failed: .*owned by ses_cmd_B/);

    const bc = await broadcastTools.fleetBroadcastHandler(
      { message: "task\n\nDONE: done", only: ["ses_worker_W2"], timeoutMs: 1000 },
      cA,
      d,
    );
    assert.match(bc, /ses_worker_W2: error: .*owned by ses_cmd_B/);

    const st = await statusTools.fleetStatusHandler({ sessionIds: ["ses_worker_W2"] }, cA, d);
    assert.match(st, /ses_worker_W2 \| error \| - \| .*owned by ses_cmd_B/);
    assert.ok(!st.includes("DONE:"), "foreign status must not leak DONE lines");
  });

  it("exec to a commander and to unassigned workers is denied", async () => {
    await setupTwoOwners();
    await registerSelf({
      sessionId: "ses_worker_V",
      daemonId: getDaemonId(V1_URL_A),
      directory: "/tmp/ses_worker_V",
      title: "v",
      runtime: "v1",
    });
    const d = depsV1();
    const cA = ctxFor("ses_cmd_A");

    const toCommander = await execTools.fleetExecHandler(
      { sessionId: "ses_cmd_B", message: "hi\n\nDONE: done", timeoutMs: 1000 },
      cA,
      d,
    );
    assert.match(toCommander, /fleet_exec failed: .*commander/);

    const unassigned = await execTools.fleetExecHandler(
      { sessionId: "ses_worker_V", message: "hi\n\nDONE: done", timeoutMs: 1000 },
      cA,
      d,
    );
    assert.match(unassigned, /fleet_exec failed: .*not assigned to you/);
  });
});

describe("default broadcast is owner-only", () => {
  it("A's default broadcast targets W1 only (one line, no W2)", async () => {
    await setupTwoOwners();
    const d = depsV1();
    const out = await broadcastTools.fleetBroadcastHandler(
      { message: "task\n\nDONE: done", timeoutMs: 1000 },
      ctxFor("ses_cmd_A"),
      d,
    );
    const lines = out.trim().split("\n");
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^ses_worker_W1: error: timeout after 1000ms/);
    assert.ok(!out.includes("ses_worker_W2"));
  });
});

describe("sender + receiver generation checks; stale + legacy denied", () => {
  it("stamped envelope validates; transfer makes queued envelopes stale; legacy rejected", async () => {
    await setupTwoOwners();
    const d = depsV1();
    const cA = ctxFor("ses_cmd_A");

    const gate = await gateSendToWorker(cA, d.rt, { sessionId: "ses_worker_W1" }, {});
    assert.ok(gate.ok);
    const envelope = stampEnvelope(
      {
        reqId: "req-gen-1",
        fromCommander: "ses_cmd_A",
        targetSessionId: "ses_worker_W1",
        message: "do the thing\n\nDONE: done",
        createdAt: Date.now(),
        agent: "explore",
        model: "prov/mod",
        variant: "v",
        system: "sys",
      },
      gate,
    );
    assert.equal(envelope.workerKey, gate.workerKey);
    assert.equal(envelope.commanderKey, gate.callerKey);
    assert.equal(envelope.generation, gate.generation);
    // Normal user message + replay hints preserved through the stamp.
    assert.match(envelope.message, /do the thing/);
    assert.equal(envelope.agent, "explore");
    assert.equal(envelope.model, "prov/mod");
    assert.equal(envelope.variant, "v");
    assert.equal(envelope.system, "sys");

    const fresh = await validateDelivery(envelope);
    assert.ok(fresh.ok);

    // Transfer races the queued request: the queued envelope is now stale.
    const t = await transferWorker(
      { sessionId: "ses_worker_W1" },
      { sessionId: "ses_cmd_B" },
      identV1("ses_cmd_A"),
    );
    assert.ok(t.ok);

    const stale = await validateDelivery(envelope);
    assert.equal(stale.ok, false);
    assert.equal(stale.stale, true);
    assert.match(stale.error, /ownership moved.*owned by ses_cmd_B/);

    // The old owner is locked out at send time too.
    const gateAgain = await gateSendToWorker(cA, d.rt, { sessionId: "ses_worker_W1" }, {});
    assert.equal(gateAgain.ok, false);
    assert.match(gateAgain.error, /owned by ses_cmd_B/);

    // Legacy unstamped envelopes are rejected, never silently allowed.
    const legacy = await validateDelivery({
      reqId: "req-legacy",
      fromCommander: "ses_cmd_A",
      targetSessionId: "ses_worker_W1",
      message: "old client",
      createdAt: Date.now(),
    });
    assert.equal(legacy.ok, false);
    assert.match(legacy.error, /no ownership stamp.*re-send/);
  });
});

describe("bare-id collisions fail closed; composites work", () => {
  it("ambiguous bare ids denied on exec/status; full composite selectors succeed", async () => {
    const url = V1_URL_A;
    await registerSelf({ sessionId: "ses_cmd_A", daemonId: getDaemonId(url), directory: "/tmp/a", title: "a", runtime: "v1" });
    await registerSelf({ sessionId: "ses_dup", daemonId: getDaemonId(url), directory: "/tmp/dup1", title: "dup-v1", runtime: "v1" });
    await registerSelf({ sessionId: "ses_dup", daemonId: V2_DAEMON, directory: "/tmp/dup2", title: "dup-v2", runtime: "v2", endpoint: { kind: "v2-service", url: "http://127.0.0.1:49374" } });
    await addCommander("ses_cmd_A");
    const a = identV1("ses_cmd_A", url);
    const d = depsV1();
    const cA = ctxFor("ses_cmd_A");

    const v1sel = { sessionId: "ses_dup", runtime: "v1", daemonId: withV1Marker(getDaemonId(url)) };
    assert.ok((await assignWorker(v1sel, a)).ok);

    const bare = await execTools.fleetExecHandler(
      { sessionId: "ses_dup", message: "hi\n\nDONE: done", timeoutMs: 1000 },
      cA,
      d,
    );
    assert.match(bare, /fleet_exec failed: .*matches 2 sessions.*composite selector/);

    const bareStatus = await statusTools.fleetStatusHandler({ sessionIds: ["ses_dup"] }, cA, d);
    assert.match(bareStatus, /ses_dup \| error \| - \| .*matches 2 sessions/);

    const gated = await gateSendToWorker(cA, d.rt, v1sel, {});
    assert.ok(gated.ok);

    const scoped = await scopedRegistryEntries(cA, d.rt);
    assert.ok(scoped.ok);
    assert.ok(scoped.owned.some((e) => e.sessionId === "ses_dup"));
  });
});

describe("durable handoff origin survives .req cleanup, routes to current owner", () => {
  it("worker hands back to B after transfer even though the inbound .req is gone", async () => {
    await setupTwoOwners();
    const keyW1 = fleetKeyOf(identV1("ses_worker_W1"));
    const keyA = fleetKeyOf(identV1("ses_cmd_A"));

    // Simulate worker-side delivery: origin persisted at delivery time.
    await recordHandoffOrigin({
      workerKey: keyW1,
      fromCommanderKey: keyA,
      fromCommanderSession: "ses_cmd_A",
      reqId: "req-origin-1",
      generation: 1,
      at: Date.now(),
    });
    // And a live inbound .req the commander later cleans up after reading.
    await writeReq("req-inbound-1", {
      reqId: "req-inbound-1",
      fromCommander: "ses_cmd_A",
      targetSessionId: "ses_worker_W1",
      message: "original task\n\nDONE: done",
      createdAt: Date.now(),
      hop: 0,
    });

    // Transfer W1 A -> B, then commander-side cleanup removes the .req.
    const t = await transferWorker(
      { sessionId: "ses_worker_W1" },
      { sessionId: "ses_cmd_B" },
      identV1("ses_cmd_A"),
    );
    assert.ok(t.ok);
    await cleanupReq("req-inbound-1");
    assert.equal(await readReq("req-inbound-1"), null);
    // Origin survives the cleanup.
    const origin = await readHandoffOrigin(keyW1);
    assert.ok(origin);
    assert.equal(origin.reqId, "req-origin-1");

    // Handoff from the worker (no client: spool path) routes to B.
    const out = await handoffTools.fleetHandoffBackHandler(
      {
        message: "needs a correction",
        done: "fixed",
        agent: "general",
        model: "prov/mod",
        variant: "vv",
      },
      ctxFor("ses_worker_W1"),
      depsV1(),
    );
    assert.match(out, /^handed back to ses_cmd_B via:spool \(req \S+ Re: req-origin-1\)$/);
    assert.match(out, /\(origin: ses_cmd_A\)|handed back to ses_cmd_B/);

    const m = /^handed back to \S+ via:\S+ \(req (\S+) Re: \S+\)$/.exec(out);
    assert.ok(m, "handoff output must carry the new req id");
    const env = await readReq(m[1]);
    assert.ok(env);
    assert.equal(env.targetSessionId, "ses_cmd_B");
    assert.match(env.message, /needs a correction/);
    assert.match(env.message, /Re: req-origin-1/);
    assert.match(env.message, /DONE:fixed/);
    assert.equal(env.agent, "general");
    assert.equal(env.model, "prov/mod");
    assert.equal(env.variant, "vv");

    // Current-owner lookup follows the transfer.
    assert.equal(await currentOwnerSessionOf(keyW1), "ses_cmd_B");
  });
});

describe("restart persistence", () => {
  it("assignments, origins, and journals survive a module reload (new generation ordering kept)", async () => {
    await setupTwoOwners();
    const keyW1 = fleetKeyOf(identV1("ses_worker_W1"));
    const keyA = fleetKeyOf(identV1("ses_cmd_A"));
    await recordHandoffOrigin({
      workerKey: keyW1,
      fromCommanderKey: keyA,
      fromCommanderSession: "ses_cmd_A",
      reqId: "req-restart-1",
      generation: 1,
      at: Date.now(),
    });
    const before = await readAssignments();
    assert.equal(before.state.generation, 2);

    const fresh2 = await import(`../dist/core/assignments.js?restart=${Date.now()}`);
    const after = await fresh2.readAssignments();
    assert.equal(after.status, "ok");
    assert.equal(after.state.generation, 2);
    assert.equal(after.state.assignments[keyW1].commanderKey, keyA);

    const control2 = await import(`../dist/core/ownershipControl.js?restart=${Date.now()}`);
    const origin = await control2.readHandoffOrigin(keyW1);
    assert.ok(origin);
    assert.equal(origin.reqId, "req-restart-1");
    assert.equal(await control2.currentOwnerSessionOf(keyW1), "ses_cmd_A");
  });
});

describe("policy hold/refuse preserved through the ownership gate", () => {
  it("refuse denies; hold queues held; commander-only restores", async () => {
    await setupTwoOwners();
    const d = depsV1();
    const cA = ctxFor("ses_cmd_A");
    assert.equal(await getPolicy().catch(() => "commander-only"), "commander-only");

    await setPolicy("refuse");
    const refused = await execTools.fleetExecHandler(
      { sessionId: "ses_worker_W1", message: "hi\n\nDONE: done", timeoutMs: 1000 },
      cA,
      d,
    );
    assert.match(refused, /fleet_exec failed: .*policy=refuse/);

    await setPolicy("hold");
    const held = await execTools.fleetExecHandler(
      { sessionId: "ses_worker_W1", message: "hi\n\nDONE: done", timeoutMs: 1000 },
      cA,
      d,
    );
    assert.match(held, /held for approval/);

    await setPolicy("commander-only");
    assert.equal(await getPolicy(), "commander-only");
  });
});

describe("fail-closed corrupt state on the new paths", () => {
  it("corrupt assignments deny list/status/broadcast/exec and mark discover unknown", async () => {
    await setupTwoOwners();
    const d = depsV1();
    const cA = ctxFor("ses_cmd_A");
    writeFileSync(assignmentsPath(), "{oops not json");

    const list = await listTools.fleetListHandler({}, cA, d);
    assert.match(list, /fleet_list failed: .*unreadable/);

    const status = await statusTools.fleetStatusHandler({}, cA, d);
    assert.match(status, /fleet_status failed: .*unreadable/);

    const bc = await broadcastTools.fleetBroadcastHandler(
      { message: "hi\n\nDONE: done", timeoutMs: 1000 },
      cA,
      d,
    );
    assert.match(bc, /fleet_broadcast failed: .*unreadable/);

    const exec = await execTools.fleetExecHandler(
      { sessionId: "ses_worker_W1", message: "hi\n\nDONE: done", timeoutMs: 1000 },
      cA,
      d,
    );
    assert.match(exec, /fleet_exec failed: .*unreadable/);

    const summary = await adminTools.fleetSummaryHandler({}, cA, d);
    assert.match(summary, /fleet_summary failed: .*unreadable/);

    const disc = await discoverTools.fleetDiscoverHandler({ limit: 5 }, cA, d);
    // Discovery stays usable (needed pre-claim) but must not claim clean ownership.
    if (disc !== "no sessions discovered") {
      assert.ok(!disc.includes("unassigned"), "corrupt state must not report clean unassigned");
    }
  });
});

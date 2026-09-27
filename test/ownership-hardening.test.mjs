// ownership-hardening.test.mjs — FIX 3 round-trip hardening regression tests.
//
// Uses XDG temp dirs only (fresh per test): no real state writes.
// Imports the built dist output, so run `npm run build` first.
// Checks: npm run typecheck, npm run build, node --test test/ownership-hardening.test.mjs
//
// Covers FIX 1: receiver-bound validateDelivery rejects mismatched
// workerKey/targetSessionId, mismatched daemon/runtime, forged fromCommander,
// kind:handoff presented to the forward gate, and legacy unstamped envelopes
// (never interpreted as allowed).
// Covers FIX 2: handoff reverse path — transfer between queue+delivery goes
// stale, unassign after .req cleanup returns unassigned (never routes to the
// old owner), forged senders / wrong receivers / missing origins rejected,
// v1+v2 watcher spool handoff happy paths, and direct/in-process pre-prompt
// gates that deny without injecting.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
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
const handoffTools = await import("../dist/core/tools/fleetHandoff.js");
const inbox = await import("../dist/core/inbox.js");
const v1mod = await import("../dist/core/v1.js");

const { registerSelf, fleetKeyOf } = registry;
const { addCommander } = auth;
const { assignWorker, transferWorker, unassignWorker, readAssignments } = assignments;
const {
  gateSendToWorker,
  gateHandoffSend,
  stampEnvelope,
  validateDelivery,
  validateHandoffDelivery,
  recordHandoffOrigin,
  readHandoffOrigin,
  originPathForWorker,
} = control;
const { writeReq, readReq } = transport;
const { getDaemonId } = inbox;
const { withV1Marker } = v1mod;

const V1_URL_A = "http://127.0.0.1:14121";
const V1_URL_B = "http://127.0.0.1:14122";
const V2_DAEMON = "v2:http://127.0.0.1:49374";
const V2_URL = "http://127.0.0.1:49374";

function ctxFor(sessionId, extra = {}) {
  return { sessionID: sessionId, ...extra };
}

function depsV1(url = V1_URL_A) {
  return { rt: { kind: "v1", daemonId: getDaemonId(url), serverUrl: url }, serverUrl: url, client: undefined };
}

function identV1(sessionId, url = V1_URL_A) {
  return { runtime: "v1", daemonId: withV1Marker(getDaemonId(url)), sessionId };
}

function receiverV1(sessionId, url = V1_URL_A) {
  return { runtime: "v1", daemonId: getDaemonId(url), sessionId };
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
  assert.ok((await assignWorker({ sessionId: "ses_worker_W1" }, identV1("ses_cmd_A"))).ok);
  assert.ok((await assignWorker({ sessionId: "ses_worker_W2" }, identV1("ses_cmd_B"))).ok);
}

async function stampedForward(sessionId, ctxSid, url = V1_URL_A) {
  const d = depsV1(url);
  const gate = await gateSendToWorker(ctxFor(ctxSid), d.rt, { sessionId }, {});
  assert.ok(gate.ok, `gate should pass: ${gate.ok ? "" : gate.error}`);
  return stampEnvelope(
    {
      reqId: `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      fromCommander: ctxSid,
      targetSessionId: sessionId,
      targetDaemonId: gate.targetDaemonId,
      message: "do work\n\nDONE: done",
      createdAt: Date.now(),
    },
    gate,
  );
}

beforeEach(() => {
  process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "fleet-test-"));
});

describe("FIX 1: receiver-bound forward delivery rejects forgeries", () => {
  it("stamped workerKey delivered to a different session is rejected", async () => {
    await setupTwoOwners();
    // Sender stamps W1 ownership but targets W2: receiver binding must deny.
    const gate = await gateSendToWorker(ctxFor("ses_cmd_A"), depsV1().rt, { sessionId: "ses_worker_W1" }, {});
    assert.ok(gate.ok);
    const forged = stampEnvelope(
      {
        reqId: "req-cross-target",
        fromCommander: "ses_cmd_A",
        targetSessionId: "ses_worker_W2",
        targetDaemonId: gate.targetDaemonId,
        message: "cross-target\n\nDONE: done",
        createdAt: Date.now(),
      },
      gate,
    );
    const verdict = await validateDelivery(forged, { receiver: receiverV1("ses_worker_W2") });
    assert.equal(verdict.ok, false);
    assert.match(verdict.error, /fail-closed/);
  });

  it("mismatched daemon and runtime receivers are rejected", async () => {
    await setupTwoOwners();
    const env = await stampedForward("ses_worker_W1", "ses_cmd_A");
    assert.ok((await validateDelivery(env, { receiver: receiverV1("ses_worker_W1") })).ok);

    // Same session id, foreign daemon: the composite key differs.
    const foreignDaemon = await validateDelivery(env, {
      receiver: { runtime: "v1", daemonId: getDaemonId(V1_URL_B), sessionId: "ses_worker_W1" },
    });
    assert.equal(foreignDaemon.ok, false);
    assert.match(foreignDaemon.error, /fail-closed/);

    // Same session id, foreign runtime: v1 stamp never validates as v2.
    const foreignRuntime = await validateDelivery(env, {
      receiver: { runtime: "v2", daemonId: V2_DAEMON, sessionId: "ses_worker_W1" },
    });
    assert.equal(foreignRuntime.ok, false);
    assert.match(foreignRuntime.error, /fail-closed/);
  });

  it("forged fromCommander is rejected even with a valid stamp", async () => {
    await setupTwoOwners();
    const env = await stampedForward("ses_worker_W1", "ses_cmd_A");
    const forged = { ...env, fromCommander: "ses_cmd_B" };
    const verdict = await validateDelivery(forged, { receiver: receiverV1("ses_worker_W1") });
    assert.equal(verdict.ok, false);
    assert.match(verdict.error, /does not match the stamped owner/);
  });

  it("handoff-kind envelopes never pass the worker-delivery gate", async () => {
    await setupTwoOwners();
    const env = await stampedForward("ses_worker_W1", "ses_cmd_A");
    const verdict = await validateDelivery(
      { ...env, kind: "handoff" },
      { receiver: receiverV1("ses_worker_W1") },
    );
    assert.equal(verdict.ok, false);
    assert.match(verdict.error, /handoff envelope presented to the worker-delivery gate/);
  });

  it("legacy unstamped envelopes stay rejected with a receiver bound", async () => {
    await setupTwoOwners();
    const verdict = await validateDelivery(
      {
        reqId: "req-legacy-recv",
        fromCommander: "ses_cmd_A",
        targetSessionId: "ses_worker_W1",
        message: "old client",
        createdAt: Date.now(),
      },
      { receiver: receiverV1("ses_worker_W1") },
    );
    assert.equal(verdict.ok, false);
    assert.match(verdict.error, /no ownership stamp/);
  });

  it("transfer between send and delivery goes stale under the receiver binding", async () => {
    await setupTwoOwners();
    const env = await stampedForward("ses_worker_W1", "ses_cmd_A");
    assert.ok((await validateDelivery(env, { receiver: receiverV1("ses_worker_W1") })).ok);
    assert.ok(
      (await transferWorker({ sessionId: "ses_worker_W1" }, { sessionId: "ses_cmd_B" }, identV1("ses_cmd_A"))).ok,
    );
    const stale = await validateDelivery(env, { receiver: receiverV1("ses_worker_W1") });
    assert.equal(stale.ok, false);
    assert.match(stale.error, /ownership moved.*owned by ses_cmd_B/);
  });
});

describe("FIX 2: handoff reverse path", () => {
  async function originOnlySetup() {
    await setupTwoOwners();
    const keyW1 = fleetKeyOf(identV1("ses_worker_W1"));
    const keyA = fleetKeyOf(identV1("ses_cmd_A"));
    await recordHandoffOrigin({
      workerKey: keyW1,
      fromCommanderKey: keyA,
      fromCommanderSession: "ses_cmd_A",
      reqId: "req-origin-h",
      generation: 1,
      at: Date.now(),
    });
    return { keyW1, keyA };
  }

  it("v1 spool handoff happy path validates through the watcher gate", async () => {
    const { keyW1 } = await originOnlySetup();
    const out = await handoffTools.fleetHandoffBackHandler(
      { message: "needs a correction", done: "fixed", agent: "general", model: "prov/mod", variant: "vv" },
      ctxFor("ses_worker_W1"),
      depsV1(),
    );
    assert.match(out, /^handed back to ses_cmd_A via:spool \(req \S+ Re: req-origin-h\)$/);
    const m = /^handed back to \S+ via:\S+ \(req (\S+) Re: \S+\)$/.exec(out);
    assert.ok(m);
    const env = await readReq(m[1]);
    assert.ok(env);
    assert.equal(env.kind, "handoff");
    assert.equal(env.workerKey, keyW1);
    assert.equal(env.fromCommander, "ses_worker_W1");
    assert.equal(env.targetSessionId, "ses_cmd_A");
    assert.equal(env.originReqId, "req-origin-h");
    assert.equal(env.agent, "general");
    assert.equal(env.model, "prov/mod");
    assert.equal(env.variant, "vv");
    assert.match(env.message, /Re: req-origin-h/);
    // Exactly the gate the v1 spool watcher runs at delivery.
    const verdict = await validateHandoffDelivery(env, { receiver: receiverV1("ses_cmd_A") });
    assert.ok(verdict.ok, `handoff should validate: ${verdict.ok ? "" : verdict.error}`);
  });

  it("v2 spool handoff happy path validates through the watcher gate", async () => {
    for (const sid of ["ses_cmd_V", "ses_worker_VW"]) {
      await registerSelf({
        sessionId: sid,
        daemonId: V2_DAEMON,
        directory: `/tmp/${sid}`,
        title: sid,
        runtime: "v2",
        endpoint: { kind: "v2-service", url: V2_URL },
      });
    }
    await addCommander("ses_cmd_V");
    const identV = { runtime: "v2", daemonId: V2_DAEMON, sessionId: "ses_cmd_V" };
    const identW = { runtime: "v2", daemonId: V2_DAEMON, sessionId: "ses_worker_VW" };
    assert.ok((await assignWorker({ sessionId: "ses_worker_VW" }, identV)).ok);
    await recordHandoffOrigin({
      workerKey: fleetKeyOf(identW),
      fromCommanderKey: fleetKeyOf(identV),
      fromCommanderSession: "ses_cmd_V",
      reqId: "req-origin-v2",
      generation: 1,
      at: Date.now(),
    });
    // Same-daemon v2 rt: in-process promptLocal is absent on this stub, so
    // the handler degrades through remote (no creds) to spool.
    const rtV2 = { kind: "v2", daemonId: V2_DAEMON };
    const out = await handoffTools.fleetHandoffBackHandler(
      { message: "v2 correction", done: "ok2" },
      ctxFor("ses_worker_VW"),
      { rt: rtV2, client: undefined },
    );
    assert.match(out, /^handed back to ses_cmd_V via:spool \(req \S+ Re: req-origin-v2\)$/);
    const m = /^handed back to \S+ via:\S+ \(req (\S+) Re: \S+\)$/.exec(out);
    assert.ok(m);
    const env = await readReq(m[1]);
    assert.ok(env);
    assert.equal(env.kind, "handoff");
    // Exactly the gate the v2 spool watcher runs at delivery.
    const verdict = await validateHandoffDelivery(env, {
      receiver: { runtime: "v2", daemonId: V2_DAEMON, sessionId: "ses_cmd_V" },
    });
    assert.ok(verdict.ok, `v2 handoff should validate: ${verdict.ok ? "" : verdict.error}`);
  });

  it("forward envelopes never pass the handoff gate", async () => {
    await setupTwoOwners();
    const env = await stampedForward("ses_worker_W1", "ses_cmd_A");
    const verdict = await validateHandoffDelivery(env, { receiver: receiverV1("ses_cmd_A") });
    assert.equal(verdict.ok, false);
    assert.match(verdict.error, /presented to the handoff gate/);
  });

  it("transfer between handoff queue and delivery goes stale", async () => {
    await originOnlySetup();
    const out = await handoffTools.fleetHandoffBackHandler(
      { message: "queued handoff" },
      ctxFor("ses_worker_W1"),
      depsV1(),
    );
    const m = /^handed back to \S+ via:\S+ \(req (\S+) Re: \S+\)$/.exec(out);
    assert.ok(m);
    const env = await readReq(m[1]);
    assert.ok(env);
    assert.ok(
      (await transferWorker({ sessionId: "ses_worker_W1" }, { sessionId: "ses_cmd_B" }, identV1("ses_cmd_A"))).ok,
    );
    const stale = await validateHandoffDelivery(env, { receiver: receiverV1("ses_cmd_A") });
    assert.equal(stale.ok, false);
    assert.match(stale.error, /ownership moved/);
  });

  it("unassign after .req cleanup returns unassigned, never the old owner", async () => {
    await originOnlySetup();
    // Commander-side cleanup removed every live .req; only the durable
    // origin remains. Then the assignment itself is released.
    assert.ok((await unassignWorker({ sessionId: "ses_worker_W1" }, identV1("ses_cmd_A"))).ok);
    let prompted = 0;
    const client = { session: { promptAsync: async () => { prompted += 1; } } };
    const out = await handoffTools.fleetHandoffBackHandler(
      { message: "late handoff" },
      ctxFor("ses_worker_W1"),
      { ...depsV1(), client },
    );
    assert.match(out, /fleet_handoff_back failed: .*not assigned/);
    assert.ok(!out.includes("handed back to"), "must never route to the old owner when unassigned");
    assert.equal(prompted, 0, "denied handoff must not prompt");
    // The reverse send gate agrees.
    const gate = await gateHandoffSend(ctxFor("ses_worker_W1"), depsV1().rt);
    assert.equal(gate.ok, false);
    assert.match(gate.error, /not assigned/);
  });

  it("forged handoff sender, wrong receiver, and missing origin are rejected", async () => {
    await originOnlySetup();
    const out = await handoffTools.fleetHandoffBackHandler(
      { message: "real handoff" },
      ctxFor("ses_worker_W1"),
      depsV1(),
    );
    const m = /^handed back to \S+ via:\S+ \(req (\S+) Re: \S+\)$/.exec(out);
    assert.ok(m);
    const env = await readReq(m[1]);
    assert.ok(env);

    const forgedSender = await validateHandoffDelivery(
      { ...env, fromCommander: "ses_cmd_B" },
      { receiver: receiverV1("ses_cmd_A") },
    );
    assert.equal(forgedSender.ok, false);
    assert.match(forgedSender.error, /does not match the sending worker/);

    // A third commander the handoff was never stamped for.
    await registerSelf({
      sessionId: "ses_cmd_C",
      daemonId: getDaemonId(V1_URL_A),
      directory: "/tmp/ses_cmd_C",
      title: "c",
      runtime: "v1",
    });
    await addCommander("ses_cmd_C");
    const wrongReceiver = await validateHandoffDelivery(env, { receiver: receiverV1("ses_cmd_C") });
    assert.equal(wrongReceiver.ok, false);
    assert.match(wrongReceiver.error, /does not match the receiving commander/);

    // W2 is assigned but never received a delegation: no durable origin.
    const asg = await readAssignments();
    const keyW2 = fleetKeyOf(identV1("ses_worker_W2"));
    const ownerB = asg.state.assignments[keyW2].commanderKey;
    const noOrigin = await validateHandoffDelivery(
      {
        reqId: "req-no-origin",
        kind: "handoff",
        fromCommander: "ses_worker_W2",
        targetSessionId: "ses_cmd_B",
        targetDaemonId: withV1Marker(getDaemonId(V1_URL_A)),
        workerKey: keyW2,
        commanderKey: ownerB,
        generation: asg.state.assignments[keyW2].generation,
        message: "x",
        createdAt: Date.now(),
      },
      { receiver: receiverV1("ses_cmd_B") },
    );
    assert.equal(noOrigin.ok, false);
    assert.match(noOrigin.error, /no durable delegation origin/);
  });

  it("origin paths are collision-proof across separator-like ids", async () => {
    const k1 = "v1\0a/b\0w";
    const k2 = "v1\0a_b\0w";
    assert.notEqual(originPathForWorker(k1), originPathForWorker(k2));
    await recordHandoffOrigin({
      workerKey: k1,
      fromCommanderKey: "v1\0d\0c1",
      fromCommanderSession: "c1",
      reqId: "r-1",
      generation: 1,
      at: Date.now(),
    });
    await recordHandoffOrigin({
      workerKey: k2,
      fromCommanderKey: "v1\0d\0c1",
      fromCommanderSession: "c1",
      reqId: "r-2",
      generation: 1,
      at: Date.now(),
    });
    assert.equal((await readHandoffOrigin(k1))?.reqId, "r-1");
    assert.equal((await readHandoffOrigin(k2))?.reqId, "r-2");
  });
});

describe("pre-prompt gates deny without injecting", () => {
  it("direct exec denied for non-owners never calls promptAsync", async () => {
    await setupTwoOwners();
    let prompted = 0;
    const client = { session: { promptAsync: async () => { prompted += 1; } } };
    const out = await execTools.fleetExecHandler(
      { sessionId: "ses_worker_W2", message: "do work\n\nDONE: done", timeoutMs: 1000 },
      ctxFor("ses_cmd_A"),
      { ...depsV1(), client },
    );
    assert.match(out, /fleet_exec failed: .*owned by ses_cmd_B/);
    assert.equal(prompted, 0, "denied exec must not inject");
  });

  it("in-process exec denied after transfer never calls promptLocal", async () => {
    for (const sid of ["ses_cmd_A2", "ses_cmd_B2", "ses_worker_VW2"]) {
      await registerSelf({
        sessionId: sid,
        daemonId: V2_DAEMON,
        directory: `/tmp/${sid}`,
        title: sid,
        runtime: "v2",
        endpoint: { kind: "v2-service", url: V2_URL },
      });
    }
    await addCommander("ses_cmd_A2");
    await addCommander("ses_cmd_B2");
    const identA2 = { runtime: "v2", daemonId: V2_DAEMON, sessionId: "ses_cmd_A2" };
    assert.ok((await assignWorker({ sessionId: "ses_worker_VW2" }, identA2)).ok);
    assert.ok(
      (
        await transferWorker(
          { sessionId: "ses_worker_VW2" },
          { sessionId: "ses_cmd_B2" },
          identA2,
        )
      ).ok,
    );
    let prompted = 0;
    const rtV2 = {
      kind: "v2",
      daemonId: V2_DAEMON,
      promptLocal: async () => { prompted += 1; },
      waitForDone: async () => null,
    };
    const out = await execTools.fleetExecHandler(
      { sessionId: "ses_worker_VW2", message: "do work\n\nDONE: done", timeoutMs: 1000 },
      { sessionID: "ses_cmd_A2" },
      { rt: rtV2, client: undefined },
    );
    assert.match(out, /fleet_exec failed: .*owned by ses_cmd_B2/);
    assert.equal(prompted, 0, "denied in-process exec must not inject");
  });

  it("direct handoff after transfer validates against the new owner only", async () => {
    await setupTwoOwners();
    const keyW1 = fleetKeyOf(identV1("ses_worker_W1"));
    await recordHandoffOrigin({
      workerKey: keyW1,
      fromCommanderKey: fleetKeyOf(identV1("ses_cmd_A")),
      fromCommanderSession: "ses_cmd_A",
      reqId: "req-pre-transfer",
      generation: 1,
      at: Date.now(),
    });
    await writeReq("req-live-1", {
      reqId: "req-live-1",
      fromCommander: "ses_cmd_A",
      targetSessionId: "ses_worker_W1",
      message: "task\n\nDONE: done",
      createdAt: Date.now(),
      hop: 0,
    });
    assert.ok(
      (await transferWorker({ sessionId: "ses_worker_W1" }, { sessionId: "ses_cmd_B" }, identV1("ses_cmd_A"))).ok,
    );
    // Spool path: routes to the CURRENT owner (B), preserving the audit trail.
    const out = await handoffTools.fleetHandoffBackHandler(
      { message: "correction" },
      ctxFor("ses_worker_W1"),
      depsV1(),
    );
    assert.match(out, /^handed back to ses_cmd_B via:spool \(req \S+ Re: req-pre-transfer\)$/);
  });
});

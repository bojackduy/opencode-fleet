// daemon-identity.test.mjs — stable v1 daemon identity + hostname-flip recovery.
//
// Uses XDG temp dirs only (fresh per test): no real state writes, no daemon
// restarts. Imports the built dist output, so run `npm run build` first.
// Checks: npm run typecheck, npm run build, node --test test/daemon-identity.test.mjs
//
// Reproduces the production failure: 16 workers assigned under a legacy
// hostname daemon (`Mac.lan-<pid>-<port>:v1`); the hostname flips, the
// commander's registry row is overwritten in place (old row gone), and the
// 16 assignment rows still reference the old daemon. Recovery must match by
// exact commander sessionId + parsed PID/port (never hostname, never bare
// sessionId alone) and preserve generations, journals, ACK cursors, and
// handoff origins.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";

process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "fleet-test-boot-"));

const registry = await import("../dist/core/registry.js");
const auth = await import("../dist/core/auth.js");
const assignments = await import("../dist/core/assignments.js");
const notify = await import("../dist/core/notify.js");
const inbox = await import("../dist/core/inbox.js");
const v1mod = await import("../dist/core/v1.js");
const daemonIdentity = await import("../dist/core/daemonIdentity.js");
const daemonMigration = await import("../dist/core/daemonMigration.js");
const ownershipControl = await import("../dist/core/ownershipControl.js");
const tools = await import("../dist/core/tools/fleetAssign.js");

const { registerSelf, fleetKeyOf, readRegistry } = registry;
const { addCommander } = auth;
const { assignWorker, transferWorker, listAssignedWorkers, readAssignments } = assignments;
const { readAssignmentEvents, ackAssignmentEvent } = notify;
const { getDaemonId } = inbox;
const { withV1Marker } = v1mod;
const {
  parsePidPort,
  sameProcessHint,
  isStableDaemonId,
  stableProcessToken,
  getStableDaemonId,
} = daemonIdentity;
const { lastDaemonMigration } = daemonMigration;
const { gateSendToWorker, validateDelivery, recordHandoffOrigin, readHandoffOrigin } =
  ownershipControl;
const { fleetMyWorkersHandler, fleetUnassignedHandler } = tools;

const V1_URL = "http://127.0.0.1:14121";
const PID = process.pid;
const PORT = "14121";
// Crafted legacy daemons (no secrets, no real state): same pid/port as this
// process, different hostnames — exactly the production drift shape.
const OLD_HOST = "Mac.lan";
const OLD_RAW = `${OLD_HOST}-${PID}-${PORT}`;
const OTHER_HOST_RAW = `OtherHost-${PID}-${PORT}`;

const CMD = "ses_drift_cmd";
const workers = Array.from({ length: 16 }, (_, i) => `ses_drift_w${String(i + 1).padStart(2, "0")}`);

function oldIdent(sessionId) {
  return { runtime: "v1", daemonId: withV1Marker(OLD_RAW), sessionId };
}

function newDaemonRaw() {
  return getDaemonId(V1_URL);
}

function newIdent(sessionId) {
  return { runtime: "v1", daemonId: withV1Marker(newDaemonRaw()), sessionId };
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

/** Seed commander + 16 workers under the OLD hostname daemon, assigned gen 1..16. */
async function seedLegacyFleet() {
  await registerSelf({ sessionId: CMD, daemonId: OLD_RAW, directory: `/tmp/${CMD}`, title: CMD, runtime: "v1" });
  for (const w of workers) {
    await registerSelf({ sessionId: w, daemonId: OLD_RAW, directory: `/tmp/${w}`, title: w, runtime: "v1" });
  }
  await addCommander(CMD);
  const caller = oldIdent(CMD);
  for (const w of workers) {
    const r = await assignWorker({ sessionId: w }, caller);
    assert.equal(r.ok, true, `seed assign ${w}: ${r.ok ? "" : r.error}`);
  }
  // One durable handoff origin under old keys (worker w01).
  const oldCmdKey = fleetKeyOf(oldIdent(CMD));
  const oldWorkerKey = fleetKeyOf(oldIdent(workers[0]));
  await recordHandoffOrigin({
    workerKey: oldWorkerKey,
    fromCommanderKey: oldCmdKey,
    fromCommanderSession: CMD,
    reqId: "req-seed-1",
    generation: 1,
    at: Date.now(),
  });
}

beforeEach(() => {
  process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "fleet-test-"));
});

describe("stable v1 daemon identity", () => {
  it("is hostname-free, stable in-process, and parses pid/port", () => {
    const a = getDaemonId(V1_URL);
    const b = getDaemonId(V1_URL);
    assert.equal(a, b);
    assert.match(a, new RegExp(`^proc-${PID}-${PORT}-[0-9a-f]{12}$`));
    assert.ok(!a.includes(hostname()), "must not embed the hostname");
    assert.ok(isStableDaemonId(withV1Marker(a)));
    assert.equal(getStableDaemonId(V1_URL), a);
    assert.equal(stableProcessToken().length, 12);
    // Re-import shares the process token (module re-import stability).
    return import("../dist/core/daemonIdentity.js").then((again) => {
      assert.equal(again.getStableDaemonId(V1_URL), a);
    });
  });

  it("parses legacy host-pid-port and matches same process ignoring hostname", () => {
    const legacy = withV1Marker(OLD_RAW);
    const stable = withV1Marker(newDaemonRaw());
    assert.deepEqual(parsePidPort(legacy), { pid: PID, port: PORT });
    assert.deepEqual(parsePidPort(stable), { pid: PID, port: PORT });
    assert.equal(sameProcessHint(legacy, stable), true);
    assert.equal(sameProcessHint(legacy, withV1Marker(OTHER_HOST_RAW)), true);
    assert.equal(parsePidPort("v2:http://x"), null);
    assert.equal(parsePidPort(""), null);
    assert.equal(parsePidPort(withV1Marker(`${OLD_HOST}-${PID}`)), null);
  });
});

describe("hostname-flip recovery (16 workers)", () => {
  it("recovers list/status/broadcast/exec after the registry row was overwritten", async () => {
    await seedLegacyFleet();
    const oldCmdKey = fleetKeyOf(oldIdent(CMD));

    // Flip: commander re-registers under the new stable daemon. The legacy
    // sessionId fallback overwrites the registry row in place (old row gone).
    await registerSelf({
      sessionId: CMD, daemonId: newDaemonRaw(), directory: `/tmp/${CMD}`, title: CMD, runtime: "v1",
    });
    const rows = await readRegistry();
    const cmdRows = rows.filter((e) => e.sessionId === CMD);
    assert.equal(cmdRows.length, 1);
    assert.equal(cmdRows[0].daemonId, withV1Marker(newDaemonRaw()));

    const mig = lastDaemonMigration();
    assert.ok(mig && mig.ran, `migration should run: ${JSON.stringify(mig)}`);
    assert.ok(mig.oldDaemons.includes(OLD_RAW), `old daemon recorded: ${JSON.stringify(mig)}`);

    // 16 owned, none stale, under the NEW runtime identity.
    const callerKey = fleetKeyOf(newIdent(CMD));
    const owned = await listAssignedWorkers(callerKey);
    assert.equal(owned.ok, true);
    assert.equal(owned.owned.length, 16);
    assert.equal(owned.stale.length, 0);

    // Generations 1..16 preserved (not bumped).
    const asg = await readAssignments();
    const gens = Object.values(asg.state.assignments)
      .filter((a) => a.commanderKey === callerKey)
      .map((a) => a.generation)
      .sort((x, y) => x - y);
    assert.deepEqual(gens, Array.from({ length: 16 }, (_, i) => i + 1));

    // No assignment still references the old daemon.
    for (const a of Object.values(asg.state.assignments)) {
      assert.ok(!a.workerKey.includes(OLD_HOST) && !a.commanderKey.includes(OLD_HOST));
    }

    // fleet_my_workers shows 16 under the new identity.
    const my = await fleetMyWorkersHandler({}, ctxFor(CMD), depsV1());
    assert.match(my, /workers of ses_drift_cmd/);
    for (const w of workers) assert.ok(my.includes(w), `my_workers missing ${w}`);

    // fleet_unassigned excludes the owned workers.
    const un = await fleetUnassignedHandler({}, ctxFor(CMD), depsV1());
    for (const w of workers) assert.ok(!un.includes(w), `unassigned leaks ${w}`);

    // Old commander key owns nothing now.
    const staleView = await listAssignedWorkers(oldCmdKey);
    assert.equal(staleView.ok, true);
    assert.equal(staleView.owned.length, 0);

    // Send gate allows the recovered commander; peer is denied.
    const gate = await gateSendToWorker(ctxFor(CMD), rtV1(), { sessionId: workers[0] });
    assert.equal(gate.ok, true);
    assert.equal(gate.workerKey, fleetKeyOf(newIdent(workers[0])));
    await registerSelf({ sessionId: "ses_drift_peer", daemonId: newDaemonRaw(), directory: "/tmp/peer", title: "peer", runtime: "v1" });
    await addCommander("ses_drift_peer");
    const peerGate = await gateSendToWorker(ctxFor("ses_drift_peer"), rtV1(), { sessionId: workers[0] });
    assert.equal(peerGate.ok, false);
    assert.match(peerGate.error, /owned by/);

    // Re-claim is idempotent (already-owned, not a duplicate row).
    const again = await assignWorker({ sessionId: workers[0] }, newIdent(CMD));
    assert.equal(again.ok, false);
    assert.equal(again.code, "already-owned");

    // New-stamped envelope validates; old-stamped fails closed with resubmit text.
    const fresh = await readAssignments();
    const cur = fresh.state.assignments[fleetKeyOf(newIdent(workers[0]))];
    const goodVerdict = await validateDelivery(
      {
        reqId: "req-new-1",
        fromCommander: CMD,
        targetSessionId: workers[0],
        targetDaemonId: withV1Marker(newDaemonRaw()),
        workerKey: fleetKeyOf(newIdent(workers[0])),
        commanderKey: callerKey,
        generation: cur.generation,
      },
      { receiver: { runtime: "v1", daemonId: newDaemonRaw(), sessionId: workers[0] } },
    );
    assert.equal(goodVerdict.ok, true);
    const staleVerdict = await validateDelivery(
      {
        reqId: "req-old-1",
        fromCommander: CMD,
        targetSessionId: workers[0],
        targetDaemonId: withV1Marker(OLD_RAW),
        workerKey: fleetKeyOf(oldIdent(workers[0])),
        commanderKey: oldCmdKey,
        generation: 1,
      },
      { receiver: { runtime: "v1", daemonId: newDaemonRaw(), sessionId: workers[0] } },
    );
    assert.equal(staleVerdict.ok, false);
    assert.match(staleVerdict.error, /re-send|stale/);
  });

  it("preserves journals, ACK cursors, handoff origins, and transfer", async () => {
    await seedLegacyFleet();
    await registerSelf({
      sessionId: CMD, daemonId: newDaemonRaw(), directory: `/tmp/${CMD}`, title: CMD, runtime: "v1",
    });
    const callerKey = fleetKeyOf(newIdent(CMD));

    // 16 join events survived under the new commander key.
    const journal = await readAssignmentEvents(callerKey, 100);
    assert.equal(journal.status, "ok");
    assert.equal(journal.total, 16);
    assert.ok(journal.events.every((e) => e.commanderKey === callerKey && e.type === "join"));

    // ACK cursor works on the migrated journal.
    assert.equal(await ackAssignmentEvent(callerKey, journal.events[0].id), true);
    const afterAck = await readAssignmentEvents(callerKey, 100);
    assert.equal(afterAck.total, 15);

    // Handoff origin moved to the new keys.
    const origin = await readHandoffOrigin(fleetKeyOf(newIdent(workers[0])));
    assert.ok(origin);
    assert.equal(origin.workerKey, fleetKeyOf(newIdent(workers[0])));
    assert.equal(origin.fromCommanderKey, callerKey);

    // Transfer to a second commander keeps journals on both sides.
    await registerSelf({ sessionId: "ses_drift_cmd2", daemonId: newDaemonRaw(), directory: "/tmp/cmd2", title: "cmd2", runtime: "v1" });
    await addCommander("ses_drift_cmd2");
    const t = await transferWorker(
      { sessionId: workers[0] },
      { sessionId: "ses_drift_cmd2" },
      newIdent(CMD),
    );
    assert.equal(t.ok, true, t.ok ? "" : t.error);
    const j1 = await readAssignmentEvents(callerKey, 100);
    const j2 = await readAssignmentEvents(fleetKeyOf(newIdent("ses_drift_cmd2")), 100);
    assert.ok(j1.events.some((e) => e.type === "transfer"));
    assert.ok(j2.events.some((e) => e.type === "transfer"));
    const stillOwned = await listAssignedWorkers(callerKey);
    assert.equal(stillOwned.owned.length, 15);
  });

  it("refuses to merge a competing stable identity (PID reuse) and keeps v1/v2 isolated", async () => {
    await seedLegacyFleet();
    await registerSelf({
      sessionId: CMD, daemonId: newDaemonRaw(), directory: `/tmp/${CMD}`, title: CMD, runtime: "v1",
    });
    const callerKey = fleetKeyOf(newIdent(CMD));

    // A different process reusing the same pid/port (different token)
    // re-registers the same session: keys must NOT be rewritten.
    const fakeRaw = `proc-${PID}-${PORT}-deadbeefcafe`;
    await registerSelf({ sessionId: CMD, daemonId: fakeRaw, directory: "/tmp/evil", title: "evil", runtime: "v1" });
    const mig = lastDaemonMigration();
    assert.ok(mig && !mig.ran, `conflict must refuse: ${JSON.stringify(mig)}`);
    assert.match(mig.reason, /PID reuse|conflicting stable/);
    const asg = await readAssignments();
    for (const a of Object.values(asg.state.assignments)) {
      assert.ok(!a.workerKey.includes("deadbeefcafe") && !a.commanderKey.includes("deadbeefcafe"));
    }
    const owned = await listAssignedWorkers(callerKey);
    assert.equal(owned.ok, true);
    assert.equal(owned.owned.length, 16);

    // Same session on v2 is an isolated row; v1 ownership is untouched.
    await registerSelf({ sessionId: CMD, daemonId: "v2:http://127.0.0.1:49374", directory: "/tmp/cmd-v2", title: "cmd-v2", runtime: "v2" });
    const rows = await readRegistry();
    assert.ok(rows.some((e) => e.sessionId === CMD && e.runtime === "v2"));
    const ownedAfter = await listAssignedWorkers(callerKey);
    assert.equal(ownedAfter.owned.length, 16);
  });

  it("does not adopt legacy ownership created before this process started despite PID reuse", async () => {
    await seedLegacyFleet();
    const beforeStart = daemonIdentity.processStartedAt() - 60_000;
    const path = assignments.assignmentsPath();
    const state = JSON.parse(readFileSync(path, "utf8"));
    for (const row of Object.values(state.assignments)) row.assignedAt = beforeStart;
    writeFileSync(path, JSON.stringify(state), { mode: 0o600 });

    await registerSelf({ sessionId: CMD, daemonId: newDaemonRaw(), directory: `/tmp/${CMD}`, runtime: "v1" });
    const migration = lastDaemonMigration();
    assert.equal(migration?.ran, false);
    assert.match(migration?.reason ?? "", /predates this process/);
    const after = await readAssignments();
    assert.equal(Object.keys(after.state.assignments).length, 16);
    assert.ok(Object.values(after.state.assignments).every((row) => row.commanderKey === fleetKeyOf(oldIdent(CMD))));
  });

  it("does not migrate on bare sessionId alone (different pid/port untouched)", async () => {
    await seedLegacyFleet();
    // Same session re-registers on a genuinely different daemon (other port):
    // legacy keys for the old pid/port must stay put.
    await registerSelf({
      sessionId: CMD, daemonId: getDaemonId("http://127.0.0.1:14999"), directory: `/tmp/${CMD}`, title: CMD, runtime: "v1",
    });
    const mig = lastDaemonMigration();
    assert.ok(mig && !mig.ran, `must not migrate: ${JSON.stringify(mig)}`);
    const asg = await readAssignments();
    const keys = Object.keys(asg.state.assignments);
    assert.equal(keys.length, 16);
    assert.ok(keys.every((k) => k.includes(OLD_HOST)));
  });
});

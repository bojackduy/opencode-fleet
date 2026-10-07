// fleet-dashboard.test.mjs — fleet TUI dashboard tests.
//
// Headless view-state tests (tabs/selection/owner scoping/live-dead
// rendering) + FleetControl integration against isolated XDG temp dirs
// (no real state/config/daemon writes). Imports the built dist output,
// so run `npm run build` first.
// Checks: npm run typecheck, npm run build, node --test test/*.test.mjs

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "fleet-test-boot-"));

const view = await import("../dist/tui/fleet-view.js");
const controlMod = await import("../dist/tui/fleet-control.js");
const registry = await import("../dist/core/registry.js");
const auth = await import("../dist/core/auth.js");
const assignments = await import("../dist/core/assignments.js");
const notify = await import("../dist/core/notify.js");
const inbox = await import("../dist/core/inbox.js");
const v1mod = await import("../dist/core/v1.js");

const {
  nextFleetTab,
  prevFleetTab,
  fleetTabForKey,
  initialFleetSelection,
  switchFleetTab,
  moveFleetSelection,
  clampFleetSelection,
  buildWorkerRows,
  visibleWorkerRows,
  assignableRows,
  isDeadRow,
  canSendToRow,
  workerRowLabel,
  eventsViewOf,
  isEventAcked,
  buildThreadGroups,
  needsConfirm,
  confirmLabel,
  resolveFleetOpen,
  FLEET_ACTION_TOOL,
} = view;
const { FleetControl, resolveDashboardCaller } = controlMod;
const { registerSelf, fleetKeyOf } = registry;
const { addCommander } = auth;
const { getDaemonId } = inbox;
const { withV1Marker } = v1mod;

const V1_URL = "http://127.0.0.1:14231";
const V1_URL_OTHER = "http://127.0.0.1:14232";
const daemonOf = (url) => withV1Marker(getDaemonId(url));

function entry(sessionId, daemon, updatedAt, extra = {}) {
  return { sessionId, daemonId: daemon, directory: `/tmp/${sessionId}`, updatedAt, ...extra };
}

describe("fleet tabs", () => {
  it("cycles workers->events->assign->threads->workers", () => {
    assert.equal(nextFleetTab("workers"), "events");
    assert.equal(nextFleetTab("events"), "assign");
    assert.equal(nextFleetTab("assign"), "threads");
    assert.equal(nextFleetTab("threads"), "workers");
    assert.equal(prevFleetTab("workers"), "threads");
    assert.equal(prevFleetTab("events"), "workers");
  });

  it("maps 1-4/tab keys, undefined otherwise", () => {
    assert.equal(fleetTabForKey("1"), "workers");
    assert.equal(fleetTabForKey("2"), "events");
    assert.equal(fleetTabForKey("3"), "assign");
    assert.equal(fleetTabForKey("4"), "threads");
    assert.equal(fleetTabForKey("tab"), "next");
    assert.equal(fleetTabForKey("shift-tab"), "prev");
    assert.equal(fleetTabForKey("j"), undefined);
    assert.equal(fleetTabForKey("q"), undefined);
  });

  it("switches tabs keeping per-tab indexes", () => {
    let sel = initialFleetSelection("workers");
    sel = { ...sel, workerIndex: 3, eventIndex: 2 };
    const next = switchFleetTab(sel, "events");
    assert.equal(next.tab, "events");
    assert.equal(next.workerIndex, 3);
    assert.equal(next.eventIndex, 2);
  });
});

describe("fleet selection movement", () => {
  const counts = { workers: 3, events: 2, assign: 4, threads: 1 };

  it("moves only the active tab index", () => {
    let sel = initialFleetSelection("workers");
    sel = moveFleetSelection(sel, "down", counts);
    assert.equal(sel.workerIndex, 1);
    assert.equal(sel.eventIndex, 0);
    sel = switchFleetTab(sel, "assign");
    sel = moveFleetSelection(sel, "last", counts);
    assert.equal(sel.assignIndex, 3);
    assert.equal(sel.workerIndex, 1);
  });

  it("clamps at bounds", () => {
    let sel = { ...initialFleetSelection("events"), eventIndex: 99 };
    sel = clampFleetSelection(sel, counts);
    assert.equal(sel.eventIndex, 1);
    sel = moveFleetSelection(initialFleetSelection("threads"), "down", counts);
    assert.equal(sel.threadIndex, 0);
  });
});

describe("worker rows: owner scoping + live/dead", () => {
  const now = Date.now();
  const daemon = daemonOf(V1_URL);
  const callerKey = `v1\0${daemon}\0ses_cmd`;
  const otherKey = `v1\0${daemonOf(V1_URL_OTHER)}\0ses_other`;
  const rowsOf = (entries, table = {}) =>
    buildWorkerRows({ entries, assignments: table, callerKey, now });

  it("marks mine/other/unassigned and scopes others out by default", () => {
    const entries = [
      entry("ses_cmd", daemon, now),
      entry("ses_w1", daemon, now),
      entry("ses_w2", daemon, now),
    ];
    const table = {
      [`v1\0${daemon}\0ses_w1`]: {
        workerKey: `v1\0${daemon}\0ses_w1`,
        commanderKey: callerKey,
        assignedAt: now,
        generation: 1,
      },
      [`v1\0${daemon}\0ses_w2`]: {
        workerKey: `v1\0${daemon}\0ses_w2`,
        commanderKey: otherKey,
        assignedAt: now,
        generation: 1,
      },
    };
    const rows = rowsOf(entries, table);
    assert.equal(rows.find((r) => r.entry.sessionId === "ses_w1").ownership, "mine");
    assert.equal(rows.find((r) => r.entry.sessionId === "ses_w2").ownership, "other");
    assert.equal(rows.find((r) => r.entry.sessionId === "ses_cmd").ownership, "unassigned");
    const scoped = visibleWorkerRows(rows);
    assert.ok(!scoped.some((r) => r.entry.sessionId === "ses_w2"));
    assert.equal(visibleWorkerRows(rows, true).length, 3);
  });

  it("derives live/stale/dead and never marks dead rows sendable", () => {
    const entries = [
      entry("ses_live", daemon, now),
      entry("ses_stale", daemon, now - 30 * 60 * 1000),
      entry("ses_dead", daemon, now - 2 * 60 * 60 * 1000),
    ];
    const table = Object.fromEntries(
      entries.map((e) => [
        `v1\0${daemon}\0${e.sessionId}`,
        { workerKey: `v1\0${daemon}\0${e.sessionId}`, commanderKey: callerKey, assignedAt: now, generation: 1 },
      ]),
    );
    const rows = rowsOf(entries, table);
    const byId = Object.fromEntries(rows.map((r) => [r.entry.sessionId, r]));
    assert.equal(byId.ses_live.liveness, "live");
    assert.equal(byId.ses_stale.liveness, "stale");
    assert.equal(byId.ses_dead.liveness, "dead");
    assert.equal(byId.ses_live.sendable, true);
    assert.equal(byId.ses_stale.sendable, false);
    assert.equal(byId.ses_dead.sendable, false);
    assert.equal(isDeadRow(byId.ses_dead), true);
    assert.equal(canSendToRow(byId.ses_dead), false);
    assert.equal(canSendToRow(byId.ses_live), true);
    assert.match(workerRowLabel(byId.ses_dead), /DEAD|dead/i);
  });

  it("renders stale assignment rows distinctly and never sendable", () => {
    const rows = rowsOf([entry("ses_w1", daemon, now)], {
      "v1\0gone-daemon\0ses_gone": {
        workerKey: "v1\0gone-daemon\0ses_gone",
        commanderKey: callerKey,
        assignedAt: now,
        generation: 7,
      },
    });
    const stale = rows.find((r) => r.ownership === "stale");
    assert.ok(stale);
    assert.equal(stale.sendable, false);
    assert.equal(isDeadRow(stale), true);
  });

  it("assign tab lists only live unassigned rows", () => {
    const rows = rowsOf([
      entry("ses_free", daemon, now),
      entry("ses_old", daemon, now - 5 * 60 * 60 * 1000),
      entry("ses_mine", daemon, now),
    ], {
      [`v1\0${daemon}\0ses_mine`]: {
        workerKey: `v1\0${daemon}\0ses_mine`,
        commanderKey: callerKey,
        assignedAt: now,
        generation: 1,
      },
    });
    const pool = assignableRows(rows).map((r) => r.entry.sessionId);
    assert.deepEqual(pool, ["ses_free"]);
  });
});

describe("events view + ack state (read-only)", () => {
  it("projects unacked events and reports ack coverage", () => {
    const evs = [
      { id: "0001-0000", commanderKey: "k", workerKey: "w", generation: 1, type: "join", at: 1, data: "a" },
      { id: "0002-0000", commanderKey: "k", workerKey: "w", generation: 2, type: "leave", at: 2, data: "b" },
    ];
    // Real journal reads exclude acked ids from `unacked` (oldest-first).
    const v = eventsViewOf([evs[1]], { ackedId: "0001-0000", ackedAt: 1 }, 1);
    assert.equal(isEventAcked(v, "0001-0000"), true);
    assert.equal(isEventAcked(v, "0002-0000"), false);
    assert.equal(isEventAcked(v, ""), false);
  });
});

describe("thread groups", () => {
  it("groups fork chains by root", () => {
    const now = Date.now();
    const d = daemonOf(V1_URL);
    const groups = buildThreadGroups([
      entry("ses_root", d, now),
      entry("ses_fork1", d, now, { parentID: "ses_root" }),
      entry("ses_fork2", d, now, { parentID: "ses_fork1" }),
      entry("ses_lone", d, now),
    ]);
    assert.equal(groups.length, 2);
    const root = groups.find((g) => g.rootSessionId === "ses_root");
    assert.deepEqual(root.members.map((m) => m.sessionId), ["ses_fork1", "ses_fork2", "ses_root"]);
  });
});

describe("confirm gating + open dispatch", () => {
  it("requires confirm for destructive actions only", () => {
    for (const a of ["unassign", "transfer", "release", "recover", "broadcast", "exec"]) {
      assert.equal(needsConfirm(a), true);
      assert.match(confirmLabel(a, "ses_x"), /y\/n/);
    }
    for (const a of ["assign", "claim", "watch", "ack"]) {
      assert.equal(needsConfirm(a), false);
    }
  });

  it("maps every manual control 1:1 to a fleet_* server tool", () => {
    assert.deepEqual(Object.keys(FLEET_ACTION_TOOL).sort(), [
      "ack", "assign", "broadcast", "claim", "exec", "recover", "release", "transfer", "unassign", "watch",
    ]);
    for (const tool of Object.values(FLEET_ACTION_TOOL)) {
      assert.match(tool, /^fleet_/);
    }
  });

  it("resolves open targets per tab and fails closed when empty", () => {
    const now = Date.now();
    const d = daemonOf(V1_URL);
    const rows = buildWorkerRows({ entries: [entry("ses_w", d, now)], assignments: {}, callerKey: "", now });
    const sel = (tab, idx) => ({ tab, workerIndex: idx, eventIndex: idx, assignIndex: idx, threadIndex: idx });
    assert.equal(resolveFleetOpen({ rows, events: [], pool: [], groups: [], sel: sel("workers", 0) }).kind, "worker");
    assert.equal(resolveFleetOpen({ rows: [], events: [], pool: [], groups: [], sel: sel("workers", 0) }).kind, "none");
    assert.equal(
      resolveFleetOpen({
        rows: [], events: [{ id: "e1" }], pool: [], groups: [], sel: sel("events", 0),
      }).kind,
      "event",
    );
  });
});

describe("FleetControl integration (isolated XDG)", () => {
  beforeEach(() => {
    process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "fleet-test-"));
  });

  async function setupFleet() {
    const daemon = getDaemonId(V1_URL);
    await registry.registerSelf({
      sessionId: "ses_cmd",
      daemonId: daemon,
      directory: "/tmp/ses_cmd",
      title: "cmd",
      runtime: "v1",
      endpoint: { kind: "v1-daemon", url: V1_URL },
    });
    await registry.registerSelf({
      sessionId: "ses_worker",
      daemonId: daemon,
      directory: "/tmp/ses_worker",
      title: "worker",
      runtime: "v1",
      endpoint: { kind: "v1-daemon", url: V1_URL },
    });
    await addCommander("ses_cmd");
  }

  it("fails closed for unknown owners", async () => {
    const ctl = new FleetControl({ ownerSessionID: "ses_nobody" });
    const snap = await ctl.refresh();
    assert.match(snap.error ?? "", /not in registry|mutations disabled/);
    assert.match(await ctl.assign("ses_worker"), /fleet_assign failed/);
  });

  it("assign/watch/ack/unassign round-trips through the journal", async () => {
    await setupFleet();
    const ctl = new FleetControl({ ownerSessionID: "ses_cmd" });
    const res = await resolveDashboardCaller("ses_cmd");
    assert.equal(res.ok, true);

    assert.match(await ctl.assign("ses_worker"), /assigned ses_worker/);
    let snap = await ctl.refresh();
    assert.equal(snap.callerKey, res.ok ? res.callerKey : "");
    assert.ok(snap.entries.some((e) => e.sessionId === "ses_worker"));

    const watched = await ctl.watch();
    assert.match(watched, /join ses_worker/);
    const eventId = watched.split("\n")[0].split("|")[0].trim();
    assert.match(await ctl.ack(eventId), new RegExp(`acked ${eventId}`));
    assert.match(await ctl.watch(), /no new fleet events/);

    assert.match(await ctl.unassign("ses_worker"), /released ses_worker/);
    snap = await ctl.refresh();
    const { readAssignments: readAsg } = assignments;
    const state = await readAsg();
    assert.equal(Object.keys(state.state.assignments).length, 0);
  });

  it("refuses dead/other-owned rows at the view layer even when control exists", async () => {
    await setupFleet();
    const ctl = new FleetControl({ ownerSessionID: "ses_cmd" });
    await ctl.assign("ses_worker");
    const snap = await ctl.refresh();
    const rows = buildWorkerRows({
      entries: snap.entries,
      assignments: snap.assignments,
      callerKey: "v1\0other\0ses_other",
    });
    for (const r of rows) assert.equal(canSendToRow(r), false);
  });

  it("journal helpers stay read-only consistent (append/read/ack)", async () => {
    await setupFleet();
    const res = await resolveDashboardCaller("ses_cmd");
    assert.equal(res.ok, true);
    const key = res.ok ? res.callerKey : "";
    await notify.appendAssignmentEvent(key, { workerKey: "w", generation: 1, type: "join", data: "hi" });
    const read = await notify.readAssignmentEvents(key, 10);
    assert.equal(read.status, "ok");
    assert.equal(read.events.length, 1);
    assert.equal(await notify.ackAssignmentEvent(key, read.events[0].id), true);
  });
});

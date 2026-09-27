// direct-handoff-origin.test.mjs — direct-delegation takeover gap regression.
//
// Phase A/B1/B2 + hardening complete, but recordHandoffOrigin() was called by
// v1/v2 SPOOL watchers only; fleet_exec direct v1 promptAsync, v2 in-process
// promptLocal, remote v2 HTTP, and same-process fleet_broadcast never wrote a
// .req file, so a worker could not fleet_handoff_back after manual takeover.
// These tests prove every ACCEPTED direct/in-process/HTTP delegation persists
// the durable HandoffOrigin BEFORE returning, with no duplicate sender-side
// writes on spool paths.
//
// Uses XDG temp dirs only (fresh per test): no real state writes.
// Imports the built dist output, so run `npm run build` first.
// Checks: npm run typecheck, npm run build, node --test test/direct-handoff-origin.test.mjs

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "fleet-test-boot-"));

const registry = await import("../dist/core/registry.js");
const auth = await import("../dist/core/auth.js");
const assignments = await import("../dist/core/assignments.js");
const control = await import("../dist/core/ownershipControl.js");
const execTools = await import("../dist/core/tools/fleetExec.js");
const broadcastTools = await import("../dist/core/tools/fleetBroadcast.js");
const handoffTools = await import("../dist/core/tools/fleetHandoff.js");
const transport = await import("../dist/core/fileTransport.js");
const inbox = await import("../dist/core/inbox.js");
const v1mod = await import("../dist/core/v1.js");

const { registerSelf, fleetKeyOf } = registry;
const { addCommander } = auth;
const { assignWorker, transferWorker, unassignWorker } = assignments;
const { readHandoffOrigin, recordHandoffOriginStrict } = control;
const { getDaemonId } = inbox;
const { withV1Marker } = v1mod;

const V1_URL_A = "http://127.0.0.1:14221";
const V2_DAEMON = "v2:http://127.0.0.1:49399";

function ctxFor(sessionId, extra = {}) {
  return { sessionID: sessionId, ...extra };
}

function depsV1(url = V1_URL_A) {
  return { rt: { kind: "v1", daemonId: getDaemonId(url), serverUrl: url }, serverUrl: url, client: undefined };
}

function identV1(sessionId, url = V1_URL_A) {
  return { runtime: "v1", daemonId: withV1Marker(getDaemonId(url)), sessionId };
}

beforeEach(() => {
  process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "fleet-test-"));
});

function reqFilesTargeting(sessionId) {
  const dir = transport.messagesDir();
  let files = [];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  return files.filter((f) => f.endsWith(".req.json"));
}

async function setupV1Pair() {
  for (const sid of ["ses_cmd_A", "ses_worker_W1"]) {
    await registerSelf({
      sessionId: sid,
      daemonId: getDaemonId(V1_URL_A),
      directory: `/tmp/${sid}`,
      title: sid,
      runtime: "v1",
    });
  }
  await addCommander("ses_cmd_A");
  assert.ok((await assignWorker({ sessionId: "ses_worker_W1" }, identV1("ses_cmd_A"))).ok);
}

async function setupV2Pair(cmd = "ses_cmd_V", worker = "ses_worker_VW", daemon = V2_DAEMON) {
  for (const sid of [cmd, worker]) {
    await registerSelf({
      sessionId: sid,
      daemonId: daemon,
      directory: `/tmp/${sid}`,
      title: sid,
      runtime: "v2",
      endpoint: { kind: "v2-service", url: "http://127.0.0.1:49399" },
    });
  }
  await addCommander(cmd);
  const identC = { runtime: "v2", daemonId: daemon, sessionId: cmd };
  assert.ok((await assignWorker({ sessionId: worker }, identC)).ok);
  return identC;
}

describe("direct v1 delegation persists handoff origin", () => {
  it("records origin on accepted promptAsync with model/agent/variant intact, no noReply", async () => {
    await setupV1Pair();
    let seenBody = null;
    const client = {
      session: {
        promptAsync: async ({ body }) => {
          seenBody = body;
        },
        messages: async () => [
          {
            info: { role: "assistant", time: { created: Date.now() } },
            parts: [{ type: "text", text: "did the work\nDONE: direct-ok" }],
          },
        ],
      },
    };
    const out = await execTools.fleetExecHandler(
      {
        sessionId: "ses_worker_W1",
        message: "do work\n\nDONE: done",
        agent: "general",
        model: "prov/mod",
        variant: "vv",
        timeoutMs: 5000,
      },
      ctxFor("ses_cmd_A"),
      { ...depsV1(), client },
    );
    assert.match(out, /via:direct \| ok/);
    assert.match(out, /DONE:direct-ok/);
    // Normal user bubble: model/agent/variant replayed, noReply never set.
    assert.ok(seenBody, "promptAsync body must be captured");
    assert.equal(seenBody.agent, "general");
    assert.equal(seenBody.variant, "vv");
    assert.ok(seenBody.model, "model must be replayed");
    assert.ok(!("noReply" in seenBody), "noReply must never be set");
    // Durable origin persisted despite no .req file.
    const origin = await readHandoffOrigin(fleetKeyOf(identV1("ses_worker_W1")));
    assert.ok(origin, "direct v1 must persist handoff origin");
    assert.equal(origin.workerKey, fleetKeyOf(identV1("ses_worker_W1")));
    assert.equal(origin.fromCommanderSession, "ses_cmd_A");
    assert.match(origin.reqId, /^exec-/);
    assert.equal(origin.generation, 1);
  });

  it("worker hands back AFTER no .req exists (origin-only routing)", async () => {
    await setupV1Pair();
    const client = {
      session: {
        promptAsync: async () => {},
        messages: async () => [
          {
            info: { role: "assistant", time: { created: Date.now() } },
            parts: [{ type: "text", text: "did it\nDONE: direct-ok" }],
          },
        ],
      },
    };
    await execTools.fleetExecHandler(
      { sessionId: "ses_worker_W1", message: "task\n\nDONE: done", timeoutMs: 5000 },
      ctxFor("ses_cmd_A"),
      { ...depsV1(), client },
    );
    const origin = await readHandoffOrigin(fleetKeyOf(identV1("ses_worker_W1")));
    assert.ok(origin, "origin must exist before handoff");
    // Direct path never writes a forward .req file.
    assert.equal(reqFilesTargeting("ses_worker_W1").length, 0);
    const out = await handoffTools.fleetHandoffBackHandler(
      { message: "correction after takeover" },
      ctxFor("ses_worker_W1"),
      depsV1(),
    );
    assert.match(out, new RegExp(`handed back to ses_cmd_A via:\\S+ \\(req \\S+ Re: ${origin.reqId}\\)`));
  });

  it("spool sender writes no origin (single writer is the watcher)", async () => {
    await setupV1Pair();
    const out = await execTools.fleetExecHandler(
      { sessionId: "ses_worker_W1", message: "slow task\n\nDONE: done", timeoutMs: 1200, mode: "spool" },
      ctxFor("ses_cmd_A"),
      depsV1(),
    );
    assert.match(out, /via:spool \| error: timeout/);
    const origin = await readHandoffOrigin(fleetKeyOf(identV1("ses_worker_W1")));
    assert.equal(origin, null, "spool sender must not write the origin (watcher owns it)");
  });
});

describe("v2 in-process delegation persists handoff origin", () => {
  it("records origin on accepted promptLocal and hands back origin-only", async () => {
    const identC = await setupV2Pair();
    let seen = null;
    const rtV2 = {
      kind: "v2",
      daemonId: V2_DAEMON,
      promptLocal: async (sid, text, opts) => {
        seen = { sid, text, opts };
      },
      waitForDone: async () => "did v2 work\nDONE: local-ok",
    };
    const out = await execTools.fleetExecHandler(
      {
        sessionId: "ses_worker_VW",
        message: "v2 task\n\nDONE: done",
        agent: "general",
        model: "prov/mod",
        variant: "vv",
        timeoutMs: 5000,
      },
      { sessionID: "ses_cmd_V" },
      { rt: rtV2, client: undefined },
    );
    assert.match(out, /via:in-process \| ok/);
    assert.match(out, /DONE:local-ok/);
    assert.equal(seen.sid, "ses_worker_VW");
    assert.equal(seen.opts.agent, "general");
    assert.equal(seen.opts.variant, "vv");
    assert.ok(seen.opts.model, "model must be replayed in-process");
    const workerKey = fleetKeyOf({ runtime: "v2", daemonId: V2_DAEMON, sessionId: "ses_worker_VW" });
    const origin = await readHandoffOrigin(workerKey);
    assert.ok(origin, "v2 in-process must persist handoff origin");
    assert.equal(origin.fromCommanderSession, "ses_cmd_V");
    assert.match(origin.reqId, /^exec-/);
    void identC;
    // Origin-only handoff (no live .req) routes to the owner via spool
    // (stub rt has no promptLocal for the handoff call path used here).
    const back = await handoffTools.fleetHandoffBackHandler(
      { message: "v2 correction" },
      { sessionID: "ses_worker_VW" },
      { rt: { kind: "v2", daemonId: V2_DAEMON }, client: undefined },
    );
    assert.match(back, new RegExp(`handed back to ses_cmd_V via:\\S+ \\(req \\S+ Re: ${origin.reqId}\\)`));
  });
});

describe("fleet_broadcast in-process persists per-target origins", () => {
  it("records origin for the local target; targets stay independent", async () => {
    const identC = await setupV2Pair("ses_cmd_BC", "ses_worker_BW");
    void identC;
    const rtV2 = {
      kind: "v2",
      daemonId: V2_DAEMON,
      promptLocal: async () => {},
      waitForDone: async () => "broadcast done\nDONE: bc-ok",
    };
    const out = await broadcastTools.fleetBroadcastHandler(
      { message: "fanout\n\nDONE: done", only: ["ses_worker_BW"], timeoutMs: 5000 },
      { sessionID: "ses_cmd_BC" },
      { rt: rtV2, client: undefined },
    );
    assert.match(out, /ses_worker_BW: ok/);
    assert.match(out, /DONE: bc-ok/);
    const workerKey = fleetKeyOf({ runtime: "v2", daemonId: V2_DAEMON, sessionId: "ses_worker_BW" });
    const origin = await readHandoffOrigin(workerKey);
    assert.ok(origin, "broadcast in-process must persist handoff origin");
    assert.equal(origin.fromCommanderSession, "ses_cmd_BC");
    assert.match(origin.reqId, /^req-/);
  });
});

describe("v2 remote HTTP delegation persists handoff origin (mock service)", () => {
  let server = null;
  let url = "";
  afterEach(async () => {
    if (server) {
      await new Promise((r) => server.close(r));
      server = null;
    }
  });

  it("records origin on accepted HTTP prompt", async () => {
    await setupV1Pair();
    // Mock v2 service: prompt accept + DONE-bearing message list.
    server = http.createServer((req, res) => {
      const u = String(req.url ?? "");
      if (req.method === "POST" && u.startsWith("/api/session/") && u.endsWith("/prompt")) {
        req.resume();
        req.on("end", () => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ data: { type: "user" } }));
        });
        return;
      }
      if (req.method === "GET" && u.includes("/message")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            data: [
              {
                role: "assistant",
                time: { created: Date.now() },
                parts: [{ type: "text", text: "remote work\nDONE: remote-ok" }],
              },
            ],
          }),
        );
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end("{}");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    url = `http://127.0.0.1:${addr.port}`;
    // service.json credentials for this exact url (read at send time).
    const xdg = process.env.XDG_STATE_HOME;
    mkdirSync(join(xdg, "opencode"), { recursive: true });
    writeFileSync(
      join(xdg, "opencode", "service.json"),
      JSON.stringify({ id: "x", version: "1", url, pid: process.pid, password: "pw-remote" }),
      { mode: 0o600 },
    );
    const daemon = `v2:${url}`;
    for (const sid of ["ses_worker_RW"]) {
      await registerSelf({
        sessionId: sid,
        daemonId: daemon,
        directory: `/tmp/${sid}`,
        title: sid,
        runtime: "v2",
        endpoint: { kind: "v2-service", url },
      });
    }
    // Commander ses_cmd_A (v1) owns the remote v2 worker.
    assert.ok((await assignWorker({ sessionId: "ses_worker_RW" }, identV1("ses_cmd_A"))).ok);
    const out = await execTools.fleetExecHandler(
      { sessionId: "ses_worker_RW", message: "remote task\n\nDONE: done", timeoutMs: 8000 },
      ctxFor("ses_cmd_A"),
      depsV1(),
    );
    assert.match(out, /via:v2-http \| ok/);
    assert.match(out, /DONE:remote-ok/);
    const workerKey = fleetKeyOf({ runtime: "v2", daemonId: daemon, sessionId: "ses_worker_RW" });
    const origin = await readHandoffOrigin(workerKey);
    assert.ok(origin, "v2 remote HTTP must persist handoff origin");
    assert.equal(origin.fromCommanderSession, "ses_cmd_A");
    assert.match(origin.reqId, /^exec-/);
  });
});

describe("origin generation guard + transfer/unassign routing", () => {
  it("older generation never overwrites a newer origin", async () => {
    await setupV1Pair();
    const key = fleetKeyOf(identV1("ses_worker_W1"));
    const newer = {
      workerKey: key,
      fromCommanderKey: fleetKeyOf(identV1("ses_cmd_A")),
      fromCommanderSession: "ses_cmd_A",
      reqId: "req-newer",
      generation: 2,
      at: Date.now(),
    };
    assert.equal(await recordHandoffOriginStrict(newer), true);
    const older = { ...newer, reqId: "req-older", generation: 1, at: Date.now() + 1000 };
    assert.equal(await recordHandoffOriginStrict(older), false, "older generation must be skipped");
    assert.equal((await readHandoffOrigin(key))?.reqId, "req-newer");
  });

  it("after transfer handoff routes to the current owner; unassign denies", async () => {
    await setupV1Pair();
    await addCommander("ses_cmd_B");
    await registerSelf({
      sessionId: "ses_cmd_B",
      daemonId: getDaemonId(V1_URL_A),
      directory: "/tmp/ses_cmd_B",
      title: "b",
      runtime: "v1",
    });
    const client = {
      session: {
        promptAsync: async () => {},
        messages: async () => [
          {
            info: { role: "assistant", time: { created: Date.now() } },
            parts: [{ type: "text", text: "did it\nDONE: direct-ok" }],
          },
        ],
      },
    };
    await execTools.fleetExecHandler(
      { sessionId: "ses_worker_W1", message: "task\n\nDONE: done", timeoutMs: 5000 },
      ctxFor("ses_cmd_A"),
      { ...depsV1(), client },
    );
    const origin = await readHandoffOrigin(fleetKeyOf(identV1("ses_worker_W1")));
    assert.ok(origin);
    assert.ok(
      (await transferWorker({ sessionId: "ses_worker_W1" }, { sessionId: "ses_cmd_B" }, identV1("ses_cmd_A"))).ok,
    );
    const routed = await handoffTools.fleetHandoffBackHandler(
      { message: "follow-up after transfer" },
      ctxFor("ses_worker_W1"),
      depsV1(),
    );
    assert.match(routed, new RegExp(`handed back to ses_cmd_B via:\\S+ \\(req \\S+ Re: ${origin.reqId}\\)`));
    assert.ok(
      (await unassignWorker({ sessionId: "ses_worker_W1" }, identV1("ses_cmd_B"))).ok,
    );
    let prompted = 0;
    const denyClient = { session: { promptAsync: async () => { prompted += 1; } } };
    const denied = await handoffTools.fleetHandoffBackHandler(
      { message: "late handoff" },
      ctxFor("ses_worker_W1"),
      { ...depsV1(), client: denyClient },
    );
    assert.match(denied, /fleet_handoff_back failed: .*not assigned/);
    assert.ok(!denied.includes("handed back to"), "must never route when unassigned");
    assert.equal(prompted, 0, "denied handoff must not prompt");
  });
});

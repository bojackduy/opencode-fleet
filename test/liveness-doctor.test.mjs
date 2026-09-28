// liveness-doctor.test.mjs — fleet direct-routing + liveness + doctor tests.
//
// Uses XDG temp dirs only (fresh per file): no real state writes.
// Imports the built dist output, so run `npm run build` first.
// Checks: npm run typecheck, npm run build, node --test test/liveness-doctor.test.mjs
//
// Covers: v1 endpoint stamping (register + heartbeat path carry
// {kind:'v1-daemon', url}, v2 endpoint behavior preserved, endpoint-only
// changes never touch assignments); liveness classification
// (live/stale/dead); dead/stale exec fail-fast WITHOUT waiting (promptAsync
// never called); liveness-scoped list/status defaults with scope:'all'
// history; ps hint honesty (empty pid/port); status registry fallback with
// age; doctor diagnostics (unknown/unregistered/commander-empty/live/dead)
// that never mutate state; v1transport URL normalization + closed-port probe.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "fleet-test-liveness-"));

const registry = await import("../dist/core/registry.js");
const auth = await import("../dist/core/auth.js");
const assignments = await import("../dist/core/assignments.js");
const liveness = await import("../dist/core/liveness.js");
const v1transport = await import("../dist/core/v1transport.js");
const discover = await import("../dist/core/discover.js");
const registerTools = await import("../dist/core/tools/fleetRegister.js");
const listTools = await import("../dist/core/tools/fleetList.js");
const statusTools = await import("../dist/core/tools/fleetStatus.js");
const execTools = await import("../dist/core/tools/fleetExec.js");
const doctorTools = await import("../dist/core/tools/fleetDoctor.js");
const assignTools = await import("../dist/core/tools/fleetAssign.js");
const inbox = await import("../dist/core/inbox.js");
const v1mod = await import("../dist/core/v1.js");

const { registerSelf, readRegistry } = registry;
const { addCommander } = auth;
const { assignWorker, readAssignments } = assignments;
const { livenessOf, livenessOfEntry, isLiveEntry, liveEntries, ageTextOf, notLiveError, ownerReachabilityOf, LIVE_MS, STALE_MS } = liveness;
const { normalizeV1BaseUrl, isV1HttpTarget, isV1DaemonAlive, v1PromptRemote } = v1transport;
const { getDaemonId } = inbox;
const { withV1Marker } = v1mod;

const V1_URL = "http://127.0.0.1:14121/";
const CMD = "ses_cmd_doc";
const W1 = "ses_worker_live1";

function ctxFor(sessionId, extra = {}) {
  return { sessionID: sessionId, ...extra };
}

function depsV1(url = V1_URL, client = undefined) {
  return { rt: { kind: "v1", daemonId: getDaemonId(url), serverUrl: url }, serverUrl: url, client };
}

function identV1(sessionId, url = V1_URL) {
  return { runtime: "v1", daemonId: withV1Marker(getDaemonId(url)), sessionId };
}

async function setupCommanderWithLiveWorker() {
  await registerSelf({ sessionId: CMD, daemonId: getDaemonId(V1_URL), directory: "/tmp/cmd", title: CMD, runtime: "v1" });
  await registerSelf({ sessionId: W1, daemonId: getDaemonId(V1_URL), directory: "/tmp/w1", title: W1, runtime: "v1" });
  await addCommander(CMD);
  const a = await assignWorker({ sessionId: W1 }, identV1(CMD));
  assert.equal(a.ok, true);
}

describe("liveness classification", () => {
  it("live/stale/dead boundaries from heartbeat age", () => {
    const now = Date.now();
    assert.equal(livenessOf(now, now), "live");
    assert.equal(livenessOf(now - LIVE_MS, now), "live");
    assert.equal(livenessOf(now - LIVE_MS - 1, now), "stale");
    assert.equal(livenessOf(now - STALE_MS, now), "stale");
    assert.equal(livenessOf(now - STALE_MS - 1, now), "dead");
    assert.equal(livenessOf(undefined, now), "dead");
    assert.equal(livenessOf(0, now), "dead");
    assert.equal(livenessOf("nope", now), "dead");
    assert.equal(livenessOf(now + 60_000, now), "live"); // future skew reads live
  });

  it("entry helpers + age text + not-live error names fleet_doctor", () => {
    const now = Date.now();
    assert.equal(livenessOfEntry({ updatedAt: now }, now), "live");
    assert.equal(isLiveEntry({ updatedAt: now - STALE_MS - 1 }, now), false);
    assert.equal(liveEntries([{ updatedAt: now }, { updatedAt: 1 }], now).length, 1);
    assert.equal(ageTextOf(0), "-");
    assert.match(ageTextOf(now - 60_000, now), /1m/);
    const err = notLiveError("ses_x", { updatedAt: 1, daemonId: "d:v1" }, now);
    assert.match(err, /not live/);
    assert.match(err, /fleet_doctor/);
  });

  it("owner reachability stays unknown for v1 stable ids, parses pid fallbacks", () => {
    assert.equal(ownerReachabilityOf({ daemonId: withV1Marker(getDaemonId(V1_URL)) }), "unknown");
    assert.equal(ownerReachabilityOf({ daemonId: "" }), "unknown");
    assert.equal(ownerReachabilityOf(null), "unknown");
    // Current process pid is reachable; a huge pid is not.
    assert.equal(ownerReachabilityOf({ daemonId: `v2:pid:${process.pid}` }), "reachable");
    assert.equal(ownerReachabilityOf({ daemonId: "v2:pid:999999999" }), "unreachable");
  });
});

describe("v1 endpoint stamping (routing metadata only)", () => {
  it("fleet_register stamps {kind:v1-daemon, url} for v1 rows", async () => {
    const sid = "ses_reg_ep1";
    const out = await registerTools.fleetRegisterHandler(
      { summary: "ep worker" },
      ctxFor(sid),
      depsV1(),
    );
    assert.match(out, /registered ses_reg_ep1/);
    const rows = await readRegistry();
    const row = rows.find((e) => e.sessionId === sid);
    assert.ok(row);
    assert.equal(row.endpoint?.kind, "v1-daemon");
    assert.equal(row.endpoint?.url, V1_URL);
  });

  it("v2 endpoint behavior preserved; re-register without endpoint keeps it", async () => {
    const sid = "ses_v2_ep1";
    await registerSelf({
      sessionId: sid, daemonId: "v2:http://127.0.0.1:49374", directory: "/tmp/x",
      runtime: "v2", endpoint: { kind: "v2-service", url: "http://127.0.0.1:49374" },
    });
    await registerSelf({ sessionId: sid, daemonId: "v2:http://127.0.0.1:49374", directory: "/tmp/x", runtime: "v2" });
    const rows = await readRegistry();
    const row = rows.find((e) => e.sessionId === sid);
    assert.ok(row);
    assert.equal(row.endpoint?.kind, "v2-service");
    assert.equal(row.endpoint?.url, "http://127.0.0.1:49374");
  });

  it("endpoint-only re-registration never touches assignments", async () => {
    const before = await readAssignments();
    await registerSelf({
      sessionId: W1, daemonId: getDaemonId(V1_URL), directory: "/tmp/w1",
      runtime: "v1", endpoint: { kind: "v1-daemon", url: V1_URL },
    });
    const after = await readAssignments();
    assert.equal(after.status, before.status);
    assert.deepEqual(after.state.assignments, before.state.assignments);
  });
});

describe("fail-fast on non-live targets (no full-timeout wait)", () => {
  it("dead worker exec fails fast and never calls promptAsync", async () => {
    await setupCommanderWithLiveWorker();
    // Backdate the worker 2h (dead) via the updatedAt override.
    await registerSelf({
      sessionId: W1, daemonId: getDaemonId(V1_URL), directory: "/tmp/w1",
      runtime: "v1", updatedAt: Date.now() - 2 * 3600_000,
    });
    let called = 0;
    const client = { session: { promptAsync: async () => { called++; return {}; } } };
    const t0 = Date.now();
    const out = await execTools.fleetExecHandler(
      { sessionId: W1, message: "do work please. DONE: x", timeoutMs: 60_000 },
      ctxFor(CMD),
      depsV1(V1_URL, client),
    );
    const elapsed = Date.now() - t0;
    assert.match(out, /not live/);
    assert.match(out, /fleet_doctor/);
    assert.equal(called, 0);
    assert.ok(elapsed < 10_000, `fail-fast took ${elapsed}ms`);
  });

  it("stale worker exec fails fast too", async () => {
    await registerSelf({
      sessionId: W1, daemonId: getDaemonId(V1_URL), directory: "/tmp/w1",
      runtime: "v1", updatedAt: Date.now() - 20 * 60_000,
    });
    const client = { session: { promptAsync: async () => { throw new Error("must not be called"); } } };
    const out = await execTools.fleetExecHandler(
      { sessionId: W1, message: "do work. DONE: x", timeoutMs: 60_000 },
      ctxFor(CMD),
      depsV1(V1_URL, client),
    );
    assert.match(out, /not live \(stale/);
  });
});

describe("liveness-scoped views keep scope:all history", () => {
  it("fleet_list default hides dead rows; scope:all shows them", async () => {
    const d = depsV1();
    const mine = await listTools.fleetListHandler({}, ctxFor(CMD), d);
    assert.match(mine, /no live workers/);
    assert.match(mine, /fleet_doctor/);
    const all = await listTools.fleetListHandler({ scope: "all" }, ctxFor(CMD), d);
    assert.match(all, new RegExp(W1));
  });

  it("fleet_status default reports no live workers; explicit id still renders", async () => {
    const d = depsV1();
    const mine = await statusTools.fleetStatusHandler({}, ctxFor(CMD), d);
    assert.match(mine, /no live workers/);
    const one = await statusTools.fleetStatusHandler({ sessionIds: [W1] }, ctxFor(CMD), d);
    assert.match(one, new RegExp(W1));
  });
});

describe("ps hint honesty + status fallback", () => {
  it("fleetPs never repeats one process across rows (empty when unknown)", async () => {
    const rows = await discover.fleetPs(10);
    assert.ok(rows.length > 0);
    const pids = new Set(rows.map((r) => r.pidHint).filter((p) => p !== ""));
    assert.equal(pids.size, 0);
    for (const r of rows) {
      assert.equal(r.pidHint, "");
      assert.equal(r.portHint, "");
    }
  });

  it("status row without a live client falls back to registry heartbeat with age", async () => {
    // A worker row with NO endpoint (unreachable by definition) viewed with
    // no live v1 client, so the handler takes the registry-heartbeat
    // fallback deterministically (same path a v2 commander takes for
    // unreachable rows). Uses a fresh sid so earlier endpoint-stamping
    // tests cannot attach an endpoint to it.
    const sid = "ses_status_fb";
    await registerSelf({ sessionId: sid, daemonId: getDaemonId(V1_URL), directory: "/tmp/fb", title: sid, runtime: "v1", status: "idle", lastDone: "did it" });
    const a = await assignWorker({ sessionId: sid }, identV1(CMD));
    assert.equal(a.ok, true);
    const out = await statusTools.fleetStatusHandler(
      { sessionIds: [sid] },
      ctxFor(CMD),
      depsV1(), // no client: forces the registry fallback row
    );
    assert.match(out, new RegExp(sid));
    assert.match(out, /idle/);
    assert.match(out, /did it/);
    assert.match(out, /registry age/);
  });
});

describe("fleet_doctor diagnostics (read-only)", () => {
  it("unknown caller gets the re-run hint", async () => {
    const out = await doctorTools.fleetDoctorHandler({}, {}, depsV1());
    assert.match(out, /caller: unknown/);
    assert.match(out, /fleet_claim_commander/);
  });

  it("unregistered session is told to register then claim", async () => {
    const out = await doctorTools.fleetDoctorHandler({}, ctxFor("ses_ghost_zzz"), depsV1());
    assert.match(out, /not in registry/);
    assert.match(out, /fleet_register/);
    assert.match(out, /fleet_claim_commander/);
  });

  it("commander with no workers gets discover/assign order", async () => {
    const sid = "ses_cmd_lonely";
    await registerSelf({ sessionId: sid, daemonId: getDaemonId(V1_URL), directory: "/tmp/l", runtime: "v1" });
    await addCommander(sid);
    const out = await doctorTools.fleetDoctorHandler({}, ctxFor(sid), depsV1());
    assert.match(out, /role: commander/);
    assert.match(out, /fleet_unassigned/);
    assert.match(out, /fleet_assign/);
  });

  it("commander with a live worker reports healthy + never mutates", async () => {
    // Re-fresh W1 to live first (a write BEFORE the read-only check).
    await registerSelf({ sessionId: W1, daemonId: getDaemonId(V1_URL), directory: "/tmp/w1", runtime: "v1" });
    const regPre = JSON.stringify(await readRegistry());
    const asgPre = JSON.stringify((await readAssignments()).state);
    assert.ok(regPre.length > 0);
    const out = await doctorTools.fleetDoctorHandler({}, ctxFor(CMD), depsV1());
    assert.match(out, /role: commander/);
    assert.match(out, /live=2/); // W1 (re-freshed above) + ses_status_fb
    assert.match(out, /policy:/);
    assert.equal(JSON.stringify(await readRegistry()), regPre);
    assert.equal(JSON.stringify((await readAssignments()).state), asgPre);
  });

  it("dead owned worker names fleet_unassign", async () => {
    await registerSelf({
      sessionId: W1, daemonId: getDaemonId(V1_URL), directory: "/tmp/w1",
      runtime: "v1", updatedAt: Date.now() - 2 * 3600_000,
    });
    const out = await doctorTools.fleetDoctorHandler({}, ctxFor(CMD), depsV1());
    assert.match(out, /dead=1/);
    assert.match(out, /fleet_unassign/);
  });
});

describe("v1transport helpers", () => {
  it("normalizes base urls and classifies targets", () => {
    assert.equal(normalizeV1BaseUrl("http://127.0.0.1:14121///"), "http://127.0.0.1:14121");
    assert.equal(normalizeV1BaseUrl(""), "");
    assert.equal(isV1HttpTarget("http://127.0.0.1:14121"), true);
    assert.equal(isV1HttpTarget("v2:http://127.0.0.1:49374"), false);
    assert.equal(isV1HttpTarget("pid:123"), false);
    assert.equal(isV1HttpTarget(""), false);
    assert.equal(isV1HttpTarget("http://host/.bun/x"), false);
  });

  it("closed-port probe fails fast with false (no throw, no 60s wait)", async () => {
    const t0 = Date.now();
    assert.equal(await isV1DaemonAlive("http://127.0.0.1:9"), false);
    assert.equal(await v1PromptRemote("http://127.0.0.1:9", "ses_x", "hi"), false);
    assert.ok(Date.now() - t0 < 20_000);
  });
});

describe("remote owning-daemon routing (mock v1 HTTP)", () => {
  const STUB_W = "ses_stub_w1";
  let stubUrl = "";
  let prompts = [];
  let server = null;

  it("setup: stub v1 daemon speaking the confirmed routes", async () => {
    const http = await import("node:http");
    await new Promise((resolve) => {
      server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => {
          const u = String(req.url ?? "");
          if (req.method === "POST" && /\/session\/.+\/prompt_async$/.test(u)) {
            prompts.push(body);
            res.writeHead(204);
            res.end();
            return;
          }
          if (req.method === "GET" && u === "/session/status") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ [STUB_W]: "idle" }));
            return;
          }
          const m = /^\/session\/([^/]+)\/message(\?.*)?$/.exec(u);
          if (req.method === "GET" && m) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify([{
              info: { role: "assistant", time: { created: Date.now() } },
              parts: [{ type: "text", text: "stub working\nDONE: stub did it" }],
            }]));
            return;
          }
          res.writeHead(404);
          res.end("{}");
        });
      });
      server.listen(0, "127.0.0.1", resolve);
    });
    // NOTE: no t.after() close here — the stub must stay up for the tests
    // below; the last test in this describe closes it (sandbox-only).
    // unref() first so a failure upstream can never hang the runner on a
    // keep-alive socket.
    server.unref();
    const addr = server.address();    stubUrl = `http://127.0.0.1:${addr.port}`;
    assert.ok(stubUrl.startsWith("http://127.0.0.1:"));

    // Commander CMD owns the stub worker whose endpoint is the stub daemon
    // (a DIFFERENT daemon than the caller's own). The caller context below
    // runs as CMD on selfUrl; registering CMD there migrates its row (legacy
    // same-session fallback), so ownership below uses that same identity.
    const selfUrl = "http://127.0.0.1:14999";
    await registerSelf({
      sessionId: CMD, daemonId: getDaemonId(selfUrl), directory: "/tmp/cmd-14999",
      title: CMD, runtime: "v1",
    });
    const cmdSelf = { runtime: "v1", daemonId: withV1Marker(getDaemonId(selfUrl)), sessionId: CMD };
    await registerSelf({
      sessionId: STUB_W, daemonId: getDaemonId(stubUrl), directory: "/tmp/stub",
      title: STUB_W, runtime: "v1", endpoint: { kind: "v1-daemon", url: stubUrl },
    });
    const a = await assignWorker({ sessionId: STUB_W }, cmdSelf);
    assert.equal(a.ok, true);
  });

  it("exec routes remote HTTP second and returns the DONE line (no spool)", async () => {
    const { readdir } = await import("node:fs/promises");
    const transport = await import("../dist/core/fileTransport.js");
    const before = new Set(await readdir(transport.messagesDir()).catch(() => []));
    // No local client: same-daemon direct is unavailable, so the handler must
    // take the remote owning-daemon HTTP step (self url differs).
    const selfUrl = "http://127.0.0.1:14999";
    const out = await execTools.fleetExecHandler(
      { sessionId: STUB_W, message: "stub task please. DONE: x", timeoutMs: 20_000 },
      ctxFor(CMD),
      { rt: { kind: "v1", daemonId: getDaemonId(selfUrl), serverUrl: selfUrl }, serverUrl: selfUrl, client: undefined },
    );
    assert.match(out, /via:v1-http \| ok/);
    assert.match(out, /DONE:stub did it/);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /stub task please/);
    // No double-delivery: no spool files appeared for this delegation.
    const after = await readdir(transport.messagesDir()).catch(() => []);
    for (const f of after) assert.ok(before.has(f), `spool file leaked: ${f}`);
  });

  it("status reads the remote daemon live via the endpoint", async () => {
    const selfUrl = "http://127.0.0.1:14999";
    const out = await statusTools.fleetStatusHandler(
      { sessionIds: [STUB_W] },
      ctxFor(CMD),
      { rt: { kind: "v1", daemonId: getDaemonId(selfUrl), serverUrl: selfUrl }, serverUrl: selfUrl, client: undefined },
    );
    assert.match(out, new RegExp(STUB_W));
    assert.match(out, /idle/);
    assert.match(out, /stub did it/);
  });

  it("same-daemon endpoint skips remote HTTP (no double-handle)", async () => {
    const before = prompts.length;
    // Fresh commander + worker both living ON the stub daemon (fresh sids
    // avoid the same-session migration path entirely). Self url EQUALS the
    // worker endpoint, so the remote step must be skipped: the stub sees no
    // prompt and the handler falls to the spool timeout.
    const c2 = "ses_cmd_stub2";
    const w2 = "ses_stub_w2";
    await registerSelf({ sessionId: c2, daemonId: getDaemonId(stubUrl), directory: "/tmp/c2", title: c2, runtime: "v1" });
    await registerSelf({
      sessionId: w2, daemonId: getDaemonId(stubUrl), directory: "/tmp/w2",
      title: w2, runtime: "v1", endpoint: { kind: "v1-daemon", url: stubUrl },
    });
    await addCommander(c2);
    const c2ident = { runtime: "v1", daemonId: withV1Marker(getDaemonId(stubUrl)), sessionId: c2 };
    const aw = await assignWorker({ sessionId: w2 }, c2ident);
    assert.equal(aw.ok, true);
    // Self url EQUALS the worker endpoint: remote step must be skipped, so
    // the stub sees no prompt and the handler falls to the spool timeout.
    const out = await execTools.fleetExecHandler(
      { sessionId: w2, message: "should not arrive. DONE: x", timeoutMs: 1500 },
      ctxFor(c2),
      { rt: { kind: "v1", daemonId: getDaemonId(stubUrl), serverUrl: stubUrl }, serverUrl: stubUrl, client: undefined },
    );
    assert.match(out, /via:spool \| error: timeout/);
    assert.equal(prompts.length, before);
    // Sandbox stub only: drop keep-alive sockets first so close() cannot
    // hang the runner, then close without awaiting (unref covers exit).
    server.closeAllConnections();
    server.close();
    server.unref();
  });
});

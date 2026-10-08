import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPollLoop } from "../dist/core/pollLoop.js";
import { startInboxWatcher, claimedPath } from "../dist/core/inbox.js";
import { atomicWriteJson, reqPath, resPath } from "../dist/core/fileTransport.js";
import { v2Setup } from "../dist/v2/adapter.js";
import { server } from "../dist/v1/adapter.js";
import { registerSelf } from "../dist/core/registry.js";
import { getDaemonId } from "../dist/core/inbox.js";
import { V1_VERSION } from "../dist/core/v1.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
function timers(t) {
  const callbacks = new Map();
  t.mock.method(globalThis, "setInterval", (fn, ms) => {
    const id = { unref() {} };
    callbacks.set(id, { fn, ms });
    return id;
  });
  t.mock.method(globalThis, "clearInterval", (id) => callbacks.delete(id));
  return { callbacks, tick: (ms) => { for (const value of [...callbacks.values()]) if (value.ms === ms) value.fn(); } };
}
async function sandbox(t) {
  const dir = await mkdtemp(join(tmpdir(), "fleet-poll-"));
  const oldState = process.env.XDG_STATE_HOME;
  const oldConfig = process.env.XDG_CONFIG_HOME;
  process.env.XDG_STATE_HOME = join(dir, "state");
  process.env.XDG_CONFIG_HOME = join(dir, "config");
  t.after(async () => {
    if (oldState === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = oldState;
    if (oldConfig === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldConfig;
    await rm(dir, { recursive: true, force: true });
  });
}

test("poll loop skips overlapping ticks, recovers after rejection and stops idempotently", async (t) => {
  const clock = timers(t);
  const gate = deferred();
  let calls = 0;
  const errors = [];
  const loop = startPollLoop(async (running) => {
    calls++;
    if (calls === 1) { await gate.promise; assert.equal(running(), true); throw new Error("tick failed"); }
  }, 10, (e) => errors.push(e.message));
  clock.tick(10);
  await flush();
  for (let i = 0; i < 100; i++) clock.tick(10);
  await flush();
  assert.equal(calls, 1);
  gate.resolve();
  await flush();
  assert.deepEqual(errors, ["tick failed"]);
  clock.tick(10);
  await flush();
  assert.equal(calls, 2);
  loop.stop(); loop.stop(); clock.tick(10);
  await flush();
  assert.equal(calls, 2);
  assert.equal(clock.callbacks.size, 0);
});

test("core inbox retains duplicate guard even when durable markers disappear", async (t) => {
  await sandbox(t);
  const clock = timers(t);
  const injected = deferred();
  const completed = deferred();
  const secondCompleted = deferred();
  let prompts = 0;
  const handle = startInboxWatcher({ sessionID: "worker", daemonId: "daemon", serverUrl: "", pollMs: 10,
    client: { session: {
      promptAsync: async () => { prompts++; injected.resolve(); },
      messages: async () => [{ info: { role: "assistant", time: { created: Date.now() } }, parts: [{ type: "text", text: "DONE: delivered" }] }],
    } }, onLog: (text) => {
      if (text.includes("req request: DONE:")) completed.resolve();
      if (text.includes("req second: DONE:")) secondCompleted.resolve();
    },
  });
  t.after(() => handle.stop());
  await atomicWriteJson(reqPath("request"), { targetSessionId: "worker", targetDaemonId: "daemon", message: "work", reqId: "request" });
  clock.tick(10);
  await injected.promise;
  await completed.promise;
  await unlink(claimedPath("request"));
  await unlink(resPath("request"));
  await atomicWriteJson(reqPath("second"), { targetSessionId: "worker", targetDaemonId: "daemon", message: "work", reqId: "second" });
  clock.tick(10);
  // Wait for a new delivery on this scan, not merely one microtask turn.
  await secondCompleted.promise;
  handle.stop();
  clock.tick(10);
  await flush();
  assert.equal(prompts, 2);
  assert.equal(handle.isRunning(), false);
  assert.equal(clock.callbacks.size, 0);
});

test("v2 slow host lookup is single-flight and disposal prevents late injection", async (t) => {
  await sandbox(t);
  const clock = timers(t);
  const entered = deferred();
  const lookup = deferred();
  let lookups = 0;
  let prompts = 0;
  const dispose = await v2Setup({ location: { directory: "/fake/location" }, session: {
    get: async () => { lookups++; entered.resolve(); return lookup.promise; },
    prompt: async () => { prompts++; },
  } });
  t.after(() => dispose?.());
  await atomicWriteJson(reqPath("slow"), { targetSessionId: "worker", message: "work", reqId: "slow" });
  // Use the actual configured inbox cadence instead of assuming it.
  for (const { fn, ms } of clock.callbacks.values()) if (ms !== 60000) fn();
  await entered.promise;
  for (let i = 0; i < 100; i++) for (const { fn, ms } of clock.callbacks.values()) if (ms !== 60000) fn();
  await flush();
  assert.equal(lookups, 1);
  dispose(); dispose();
  lookup.resolve({ id: "worker" });
  await flush();
  assert.equal(prompts, 0);
  assert.equal(clock.callbacks.size, 0);
});

test("v1 rebeat does not overlap blocked runtime calls and cleanup removes both timers", async (t) => {
  await sandbox(t);
  const clock = timers(t);
  const entered = deferred();
  const blocked = deferred();
  let calls = 0;
  const url = "http://127.0.0.1:14288";
  await registerSelf({ sessionId: "worker", daemonId: getDaemonId(url), directory: "/fake", runtime: "v1" });
  const hooks = await server({ directory: "/fake", serverUrl: new URL(url), client: {
    version: V1_VERSION,
    app: { log: async () => {} },
    session: { get: async () => { calls++; entered.resolve(); return blocked.promise; } },
  } });
  t.after(() => hooks.dispose());
  clock.tick(60000);
  await entered.promise;
  for (let i = 0; i < 100; i++) clock.tick(60000);
  await flush();
  assert.equal(calls, 1);
  await hooks.dispose();
  clock.tick(60000);
  assert.equal(calls, 1);
  assert.equal(clock.callbacks.size, 0);
  // Leave the mocked API promise unresolved: disposal cannot cancel an
  // already-issued host API call; no real network or timer is held open.
});

test("v2 repeated cleanup cannot release another registration for the same location", async (t) => {
  await sandbox(t);
  const clock = timers(t);
  const ctx = { location: { directory: "/fake/shared" }, session: { get: async () => null, prompt: async () => {} } };
  const first = await v2Setup(ctx);
  const second = await v2Setup(ctx);
  t.after(() => { first(); second(); });
  assert.equal(clock.callbacks.size, 2);
  first(); first();
  assert.equal(clock.callbacks.size, 2);
  second();
  assert.equal(clock.callbacks.size, 0);
});

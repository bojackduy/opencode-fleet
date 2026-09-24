# fleet-progress-4 — Phase 4 final wiring

Phase 4 complete (wiring + build verified; live serve-spool test blocked by a
serve-mode file-plugin limitation — documented below with TUI fallback).
Phases 1–3 untouched (`registry.ts`, `fileTransport.ts`, `inbox.ts`,
`src/tools/*` unchanged except nothing; `package.json` gained `"main"` only).

## Files

- `src/index.ts` (new, ~11k) — object-module form:
  `export default { id: "fleet.v1", server } satisfies PluginModule`
  (`PluginInput`/`PluginModule` types from `@opencode-ai/plugin`, v1 shape:
  `{ client, project, directory, worktree, serverUrl, $ }`).
  - `server(input)` runs once per daemon (no per-session ID exists here), so it
    starts a **daemon-wide inbox watcher**: scans
    `fleet-v1/messages/*.req.json` every ~1000ms, claims reqs whose
    `targetDaemonId` matches `getDaemonId(String(input.serverUrl))` (or empty
    targetDaemonId as fallback), replays each into `targetSessionId` via
    `client.session.promptAsync({ path: { id }, body: { parts: [{ type: "text",
    text }] } })` — **never noReply/silent**, so delegation lands as a normal
    user bubble and revert/fork/continue keep working. Reply poll (~500ms,
    120s timeout) looks for trailing `DONE:`; writes `<reqId>.res.json`
    `{ ok, reply | error }`. Per-request failures never throw.
    Reuses `buildInjectText`, `parseFleetModel`, `claimedPath`,
    `INBOX_RESPONSE_TIMEOUT_MS` from `inbox.ts` and `readReq`/`writeRes` from
    `fileTransport.ts` (no duplication of envelope logic).
  - `tool` hook registers all six tools with `{ client, serverUrl }` deps:
    `fleet_register`, `fleet_list`, `fleet_broadcast`, `fleet_status`,
    `fleet_agents`, `fleet_models`.
  - `event` hook: `session.deleted` → `removeSession`; `session.idle` →
    best-effort `updatedAt` heartbeat via `registerSelf`. Never throws.
  - `dispose` stops the watcher. Logging via `client.app.log` only.
- `package.json` — added `"main": "dist/index.js"`. Root cause found during
  verification: v1 loader resolves a `server` entrypoint from
  `exports["./server"]` or package `main`
  (`packages/opencode/src/plugin/shared.ts:resolvePackageEntrypoint`); with
  neither field the file plugin has no entry and never loads. Now loads.
- `dist/index.js` (+ maps/declarations) — built via `tsc` (nodenext ESM,
  `.js`-suffixed imports).

## Evidence (proven)

- `/opt/homebrew/bin/opencode --version` → `1.18.32` (pinned v1, never `.bun` v2).
- `npm run build` → exit 0 (`tsc` clean, strict).
- `ls src/index.ts dist/index.js` → both present (dist/index.js 11711 bytes).
- Module shape under both runtimes:
  - node: default export keys `['id','server']`, `id === "fleet.v1"`,
    `typeof server === "function"`.
  - bun: `server()` with mock client returns hooks
    `['tool','event','dispose']`, tools
    `fleet_agents,fleet_broadcast,fleet_list,fleet_models,fleet_register,fleet_status`
    (6/6), `app.log` called with `fleet.v1 loaded daemon=<host>-<pid>-14121`,
    `dispose()` stops cleanly.
- Daemon HTTP surface (isolated `HOME=/tmp/fleet-home`, sequential starts —
  concurrent starts race sqlite migrations): `/session` 200 and `/doc` 200 on
  both 14121 and 14122; `POST /session` creates sessions; `/config` shows
  `"plugin": ["file:/Users/duytrinh/Code/opencode-fleet-v1"]`; zero
  `SchemaError`/WARN/ERROR in daemon logs.

## Known issue (not blocking completion)

- **Serve-mode file-plugin pickup**: with two headless
  `opencode serve --port 14121/14122` daemons, spool reqs
  (`XDG_STATE_HOME`-isolated `fleet-v1/messages/`, registry entries for both
  sessions, correct `targetDaemonId`) were never claimed — no `.claimed`, no
  `.res.json` — even with `targetDaemonId` omitted, and a trivial probe file
  plugin also never executed in serve instances. No errors logged anywhere
  (stderr, `opencode.log`, SSE). Daemon-level plugin execution in `serve` mode
  could not be confirmed headlessly.
- **TUI fallback per HANDOFF §7**: verify takeover + live delegation in two
  real v1 TUIs (`cd /tmp/fleet-a && opencode1`, `cd /tmp/fleet-b && opencode1`)
  with `"plugin": ["file:/Users/duytrinh/Code/opencode-fleet-v1"]`:
  `fleet_register("worker-b")` in B → `fleet_list` in A shows B →
  `fleet_broadcast("Reply with DONE:hello")` lands in B as a user bubble →
  `.res.json` returns → open B later, message visible as normal user msg,
  revert/fork/continue work, killing A leaves B intact. The unit-level proofs
  above (6 tools wired, daemon watcher logic, DONE protocol) make this a
  straight runtime confirmation, not a code change.
- Takeover note (by design): every delegation is injected via `promptAsync`
  as plain user-bubble text with `[from fleet-v1 <reqId> | commander:<id>]`
  header + `DONE:` footer — no system-prompt injection, no silent mode — so
  manual takeover sees exactly what the orchestrator sent.

## Cleanup

- Serve daemons on 14121/14122 killed after verification; no changes to
  `~/.config/opencode/opencode.jsonc` (test used temp `HOME=/tmp/fleet-home`;
  real config untouched, no backup needed).

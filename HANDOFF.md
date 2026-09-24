# opencode-fleet-v1 — HANDOFF

> Throw this whole file into a fresh OpenCode session started in this directory (`/Users/duytrinh/Code/opencode-fleet-v1/`) and tell it to implement.
> Scope: **v1 ONLY**. No v2, no A2A. Lightweight orchestrator → workers, takeover-friendly.

## 1. What we want

I work with many OpenCode primary sessions at once, one per feature worktree/directory. I need ONE commander session where I type once and it fans out tasks to ALL worker sessions, watches results, and reports back.

Requirements:
1. **Primary-to-primary**, not subagent/task tool. Workers are independent OpenCode sessions in different directories.
2. **Orchestrator = remote keyboard.** Every delegated task must land in the worker as a **normal user message** (as if I typed in the chat box and hit Enter). So when I later `cd` into that worktree and take over manually, I see exactly what the orchestrator sent, and `revert / fork / continue / diff / abort` all work.
3. **Workers stay independent.** Killing the orchestrator must not break workers. No shared memory, no hidden context. Every prompt is self-contained.
4. **Cross-daemon.** I run one TUI per worktree (separate daemons/processes), so the solution must work across daemons on the same machine, not just same-process sessions.
5. **v1 first.** v2 is unstable and several plugins don't support it yet.

Non-goals: full Google A2A protocol, cross-host relay, file transfer, shared transcript, silent/noReply injection, v2 `Plugin.define` API.

## 2. Decisions already made

- **No A2A.** A2A (Agent2Agent, Google → Linux Foundation, v1.0) = Agent Cards + JSON-RPC 2.0 + task state machine + SSE/push + auth. Correct for cross-org agents, overkill for same-machine OpenCode. Use plain-text handoff instead.
- **Transport = file spool + InboxWatcher (MVP).** Same pattern as `kinminghao/cross-session-messaging`. Upgrade to socket spool (like `opencode-plugin-peers v2`) only if needed later.
- **Delivery primitive = v1 `prompt_async`.** Never `silent`/`noReply` mode. That is the opposite of what we want.
- **Result protocol = `DONE:` footer.** Every worker reply must end with `DONE:<one-line-result>` so the commander can poll reliably.
- **State dir is v1-namespaced** so v2 daemons ignore it.

## 3. Environment — pinned to v1

- v1 binary: `/opt/homebrew/bin/opencode` → `1.18.32` (main, use this; alias `opencode1`).
- v2 binary: `/Users/duytrinh/.bun/bin/opencode` → `2.0.15` (DO NOT use for this plugin).
- Bare `opencode` currently resolves to v2 (`.bun` first in PATH) — always use the absolute v1 path in this project.
- v1 config shape: `"plugin": [...]` singular in `opencode.jsonc`, `tui.jsonc` for client. Do NOT convert to v2 `plugins` / `cli.json` shape here. Back up config before opening v2.
- Local OpenCode source clone for reference: `/Users/duytrinh/Code/opencode` (branch `dev`).
- This plugin dir: `/Users/duytrinh/Code/opencode-fleet-v1/` (fresh, nothing implemented yet).

## 4. Available v1 interfaces (verified from clone + docs)

Source of truth: local clone + `https://opencode.ai/docs/server`, `/docs/plugins`, `/docs/sdk`.

**Server (each TUI/serve = own server, shared sqlite DB):**
- `packages/opencode/src/server/server.ts:73 listen({port, hostname})` — default 4096, TUI picks random. Headless: `opencode1 serve --port 14100`.
- `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts:78-105` — route table. Key endpoints:
  - `GET /session` (list, sorted by updated), `GET /session/status`
  - `GET /session/:id`, `GET /session/:id/children`, `GET /session/:id/todo`
  - `GET /session/:id/message?limit=` , `GET /session/:id/message/:messageID`
  - `POST /session/:id/message` (sync, streams) vs `POST /session/:id/prompt_async` (async, `204`, starts session if needed — USE THIS)
  - `POST /session/:id/command`, `POST /session/:id/shell`
  - `POST /session/:id/fork {messageID?}`, `POST /session/:id/revert`, `POST /session/:id/unrevert`
  - `GET /session/:id/diff`, `POST /session/:id/abort`
  - `GET /event`, `GET /global/event` (SSE; first event `server.connected`)
- Spec: `http://127.0.0.1:<port>/doc`.

**Storage (shared across daemons):**
- `packages/core/src/database/database.ts:46-54` — sqlite at `Global.Path.data/opencode.db` (≈ `~/.local/share/opencode/`).
- `packages/core/src/session/sql.ts:22` — `SessionTable, MessageTable, PartTable, TodoTable, SessionInputTable`.
- `packages/opencode/src/session/session.ts:59 fromRow()` — session has `id, project_id, directory, parentID, title`.
- `packages/core/src/global.ts:11-27` — `data/cache/state/log` under XDG. Fleet state MUST live under state dir (see §6).
- Caveat (V2 Session Core in AGENTS.md): prompt admission is durable (`session_input` row) but **drains are process-local** — listing sees other daemons via shared DB, but *executing* needs the owning daemon woken via its own `prompt_async`. Never write DB rows directly; always go through the owning daemon's API.

**Plugin (v1 shape only):**
- `packages/plugin/src/index.ts:56-74` — `PluginInput = { client, project, directory, worktree, serverUrl, $ }`, `Plugin = (input, options?) => Promise<Hooks>`.
- Custom tools via `tool()` + zod `tool.schema`; use `context.directory/worktree/abort`, `context.ask()` for permission boundaries, `client.app.log()` not `console.log`.
- Hooks we care about: `tool` (register tools), `event` (fire-and-forget; watch `session.deleted`, `session.idle`), `tool.execute.before/after` if needed. Do NOT use v2 `Plugin.define / ctx.session / ctx.tool.transform`.
- Requires `1.18.29+` for object-module form: `export default { id, server } satisfies PluginModule`.

## 5. Architecture (MVP)

```
Commander session (any worktree, has plugin)
  │ fleet_broadcast("...task...")  →  one .req.json per worker in fleet-v1/messages/
  │ fleet_status()                 →  poll session.status + session.messages, look for DONE:
  ▼
Worker daemon N (each worktree TUI, has same plugin)
  InboxWatcher (setInterval ~1s, started in server()) polls messages/ for reqs where target==my session
  → validates daemonId ownership → client.session.promptAsync({path:{id:myId}, body:{parts:[{type:"text",text:reqText}]}})
  → polls for assistant reply → writes .res.json → caller reads + cleans up
Registry: fleet-v1/registry.json — { sessionId, daemonId, directory, title/summary, updatedAt } with 24h TTL hide.
```

Why files not direct HTTP: daemons have dynamic ports; files work with zero port bookkeeping and match my N-TUI habit. Sockets (peers-style UDS) are a later optimization, not MVP.

## 6. What to implement (v1 MVP)

**Package:** plain TS plugin, no framework. Must load on `1.18.32` with `"plugin": ["file:/Users/duytrinh/Code/opencode-fleet-v1"]` or `~/.config/opencode/plugins/` copy. Test with `opencode1`, never v2 binary.

**Files (suggested):**
```
src/index.ts            # default export { id:"fleet.v1", server }
src/registry.ts         # atomic read-modify-write (in-process chain + temp+rename), 24h TTL
src/fileTransport.ts    # write/read/poll .req.json/.res.json, abortable sleep
src/inbox.ts            # InboxWatcher start/stop, daemonId check, promptAsync + reply poll
src/tools/fleetList.ts      # fleet_list
src/tools/fleetBroadcast.ts # fleet_broadcast
src/tools/fleetStatus.ts    # fleet_status
```

**Tools (v1 `tool()`):**
1. `fleet_register(summary: string)` — register current session into `fleet-v1/registry.json` with `{sessionId, daemonId, directory, summary, updatedAt}`. Called once per worker (or auto on `session.created` event).
2. `fleet_list(includeSelf=false)` — read registry, hide entries `updatedAt > 24h`, exclude self by default.
3. `fleet_broadcast(message: string, only?: string[])` — for each target: validate in registry, write `{reqId}.req.json`, wait up to 60s (max 10min via param) for `.res.json`, **never throw** — return per-target `{sessionId, ok, reply|error}` text. `message` MUST be self-contained (goal + files + constraints + done-criteria + `DONE:` instruction); workers cannot see commander's history.
4. `fleet_status(sessionIds?: string[])` — `client.session.status()` + last ~5 `client.session.messages()` per worker, extract trailing `DONE:` line, return compact table.

**Message envelope (takeover-critical):**
```
[from fleet-v1 <reqId> | <commander:>]< in every injected prompt
<self-contained task>
Reply ending with exactly: DONE:<one-line-result>
```
Inject via `promptAsync` so it renders as a normal user bubble. No system-prompt injection, no silent mode.

**InboxWatcher details:**
- Start in `server()`; stop in `dispose()`. Poll `fleet-v1/messages/*.req.json` every ~1000ms; response poll ~500ms.
- Only process reqs targeting my `sessionID` AND my `daemonId` (daemonId = e.g. `hostname-pid-serverUrl.port`, persisted per daemon).
- On pickup: `client.session.promptAsync(...)` then poll messages for new assistant text after req timestamp; write `.res.json {ok, reply|error}`; caller deletes both files after read.
- Timeout / target-missing / abort / empty-reply all return readable text, never throw (so commander turn doesn't die).
- `event({event})`: on `session.deleted` remove own registry entry; on `session.idle` optionally refresh `updatedAt`.

**State paths (v1-only namespace):**
```
$XDG_STATE_HOME/opencode/fleet-v1/registry.json   (fallback ~/.local/state/opencode/fleet-v1/)
$XDG_STATE_HOME/opencode/fleet-v1/messages/
```
`0600` files. Atomic write via temp+rename. In-process serialize RMW with a promise chain; cross-process = last-writer-wins (acceptable for MVP).

**Permissions/safety:** peer text is untrusted input (same trust as pasted user text). Document `inboundPolicy` default accept for MVP; note future `hold/refuse` + never auto-approve secrets/permission-escalation. Single-user machine assumption.

## 7. Verify on v1 (do all of this)

```bash
/opt/homebrew/bin/opencode --version   # expect 1.18.32
# terminal A:
cd /tmp/fleet-a && /opt/homebrew/bin/opencode serve --port 14121 &
# terminal B:
cd /tmp/fleet-b && /opt/homebrew/bin/opencode serve --port 14122 &
curl -s http://127.0.0.1:14121/session | head -c 500
curl -s http://127.0.0.1:14121/doc | head -c 200
# plugin loads with no SchemaError in both daemons
# commander: fleet_register("worker-b") in B, fleet_list in A shows B
# commander: fleet_broadcast("Reply with DONE:hello") → worker B shows it as user bubble, replies, .res.json returns
# takeover: open B in TUI, see orchestrator message as normal user msg, revert/fork/continue work, kill A, B keeps full history
```

## 8. Explicitly out of scope

- v2 port (`Plugin.define`, `ctx.*`, flattened SDK, `plugins`/`cli.json`) — later, separate change.
- A2A Agent Cards / JSON-RPC server / task store / gRPC / signatures.
- Cross-host relay, file attachments, shared transcript, queue/retry, deadlock detection, multi-user auth.
- Touching `~/.config/opencode/opencode.jsonc` `plugin` list shape or converting anything to v2.

## 9. Prompt to start the build session

> Implement the v1 MVP described in this HANDOFF using only OpenCode v1 APIs (`/opt/homebrew/bin/opencode`, 1.18.32). Keep every delegation as a normal user message via `prompt_async` so manual takeover with revert/fork works. Verify with the commands in §7. Do not add v2 code, A2A, or silent injection.

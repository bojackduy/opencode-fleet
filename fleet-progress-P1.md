# fleet-progress-P1 — v1-only enforce + discover

## v1 pin
- `V1_BIN=/opt/homebrew/bin/opencode`, `V1_VERSION=1.18.32` (`src/v1.ts`)
- `/opt/homebrew/bin/opencode --version` → `1.18.32`
- `isV1Daemon("http://127.0.0.1:14121")=true`, `(...:49374)=false`, `(.bun path)=false`
- `withV1Marker("host-1-14121")` → `host-1-14121:v1`
- `registry.registerSelf` tags `daemonId` via `withV1Marker` (guard in registry)
- `server()` logs `fleet.v1 loaded ... v1bin=... v1=...`, warns + disables inbox watcher on `.bun`/port-49374 or `2.x` version (client.version else `OPENCODE_VERSION`)

## Discover
- `src/discover.ts`: read-only sqlite `~/.local/share/opencode/opencode.db` table `session` via `sqlite3 -json -readonly`, join with `registry.json`, `discoverSessions()` sorted `time_updated DESC`, never throws; `fleetPs()` merges `ps aux` (skips `.bun`, skips 49374) + `lsof -iTCP -sTCP:LISTEN -P` + sqlite + registry.
- `src/tools/fleetDiscover.ts`: `fleet_discover(limit?=15)` → `sessionId|title|dir|updated|registered`; `fleet_ps` → `sessionId|title|dir|pid|port|registered|age`. Never throws.
- Wired in `src/index.ts` tool hook: 8 tools total (`fleet_register`, `fleet_list`, `fleet_broadcast`, `fleet_status`, `fleet_agents`, `fleet_models`, `fleet_discover`, `fleet_ps`).
- Auto-register: `event(session.created)` → `registerSelf` best-effort (v1 only); `server()` startup best-effort if input carries sessionID.

## Evidence
- `npm run build` ✅, `npx tsc --noEmit` ✅ (fixed `appLog` level union type).
- `ls src/discover.ts src/tools/fleetDiscover.ts src/v1.ts dist/discover.js dist/tools/fleetDiscover.js dist/v1.js` ✅ all present.
- Discover sample (live `dist/discover.js`, limit 3):
  - `ses_f2d5448e7ffepBCheEje5AZjD5 | loopd: fleet-v1-P1-discover-v1only | /Users/duytrinh/Code/opencode-fleet-v1 | registered:false`
  - `ses_f9912ac81ffewkT2wL6JqbXRJZ | Diagnosing Retention for OpenCode /goal Tool | .../opencode-loopd`
  - `ses_f2d5e72ccffedYwfzdG8flNR4G | loopd: streaming-stt-01-review-fixes | .../opencode-voice`
- PS sample: `pidHint=90473 portHint=59808 age=1m` (best-effort first-v1-pid fallback; lsof pid→port map applied when available).
- sqlite CLI sample: 5 newest sessions returned JSON (ids match discover output).
- `ps aux | grep opencode` shows v1 TUIs plus v2 `.bun ... serve --service` (pid 51875) — correctly skipped by `psHints()`.
- Existing files untouched in behavior: `registry.ts` (additive `:v1` tag), `fileTransport.ts`, `inbox.ts`, `tools/fleetRegister|List|Broadcast|Status|Agents.ts`, `dist/index.js` rebuilt.

## Constraints kept
- v1 only, no `Plugin.define`, no DB writes, no `console.log` (`client.app.log`), strict TS ESM with `.js` suffixes.

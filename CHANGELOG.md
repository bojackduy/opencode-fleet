# Changelog

## Unreleased

- Clean repository-local `dist` before building and omit maps from npm packages;
  preserve JS/declarations, dual server/TUI entries, and the fleet skill.
- Test freshly built code before packing/releasing/publishing; avoid a redundant
  build in the publish workflow (CI build-before-test fix retained).
- Serialize inbox scans and periodic rebeats, guard late delivery after cleanup,
  and make v2 location cleanup idempotent without releasing another reference.
- Coalesce dashboard refreshes and ignore refresh results after disposal.
- Add isolated packaging and fake-timer/runtime lifecycle regressions. No claim
  of benchmarked startup improvement, a measured memory leak, or live TUI rendering.

## 0.2.4 (2026-09-28) — Direct v1 routing, liveness, doctor, skill

- Stamp v1 daemon endpoint URLs at register/heartbeat (routing metadata only)
- Direct cross-daemon v1 transport: same-daemon → remote owning-daemon HTTP
  (`POST /session/{id}/prompt_async`, no auth) → spool fallback; ownership
  revalidated immediately before every live prompt, never double-delivers
- Heartbeat-age liveness gating (live/stale/dead); dead/stale targets fail
  fast instead of burning full timeouts; default views hide dead rows
- Honest `fleet_ps` pid/port hints and registry-heartbeat status fallback
- New read-only `fleet_doctor` tool (28th): exact next commands for
  peer/commander/recovery states
- New `skills/fleet/SKILL.md` commander/worker workflow, shipped in npm files

## 0.2.3 (2026-09-27) — Stable v1 daemon identity and ownership recovery

- Replace hostname-based v1 daemon IDs with process-stable IDs so hostname changes no longer split a commander's fleet.
- Migrate same-process legacy registry, assignment, journal/ACK, and handoff-origin keys when a session registers; refuse uncertain PID-reuse cases.
- Add `fleet_recover_commander` for explicit recovery after a daemon restart, preserving worker keys and invalidating stale queued requests.
- Allow the owning commander to release a stale worker assignment after the worker reconnects under a new daemon ID.
- Add hostname-flip and restart-recovery regression tests.

## 0.2.1 (2026-09-27) — P6 live-roster + notify

- Periodic re-beat (~60s, v1 adapter + v2 singleton): refreshes ONLY rows owned
  by this daemon with live title/agent/model/status; 24h TTL now means dead
- Real status: `normalizeStatus()` maps daemon variants (running/working/…)
  to busy/idle; v1 probes per-session status shapes; v2 folds
  /api/session/active + time.idle/outcome into the row — unknown is last-resort
- Roster-change notify: session.created → join, session.deleted → leave,
  claim/release commander → role (`roster-*.notify.json`, 0600, never throws)
- New `fleet_watch` tool (20th): blocks up to timeoutMs (default 30s, max 120s)
  for roster + DONE notifies newer than `since` — the commander's subscribe
  primitive replacing blind polling

## 0.2.0 (2026-09-25) — Rename to opencode-fleet (v1+v2 support); state dir opencode/fleet with auto-migration from opencode/fleet-v1 (0.1.x history below unchanged)

- Package `@bojackduy/opencode-fleet`, plugin id `fleet`, state dir `opencode/fleet`
- One-time best-effort migration copies the old state dir on first registry/auth read
- README covers both v1 (`plugin`) and v2 (`plugins`) install shapes

## 0.1.0 (2026-09-24) — Initial release

- Registry + file-spool transport (atomic 0600 writes, 24h TTL, abortable poll)
- InboxWatcher with `promptAsync` user-bubble replay (`agent/model/variant`), `DONE:` protocol
- Tools: register/list/broadcast/status/agents/models, discover/ps, fast exec, notify + handoff-back + thread, allow/block/policy/summary/group
- v1-only pin (`/opt/homebrew/bin/opencode` 1.18.32), server-client heartbeat + inbound auth

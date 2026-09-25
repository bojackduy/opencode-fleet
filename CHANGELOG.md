# Changelog

## 0.2.0 (2026-09-25) — Rename to opencode-fleet (v1+v2 support); state dir opencode/fleet with auto-migration from opencode/fleet-v1 (0.1.x history below unchanged)

- Package `@bojackduy/opencode-fleet`, plugin id `fleet`, state dir `opencode/fleet`
- One-time best-effort migration copies the old state dir on first registry/auth read
- README covers both v1 (`plugin`) and v2 (`plugins`) install shapes

## 0.1.0 (2026-09-24) — Initial release

- Registry + file-spool transport (atomic 0600 writes, 24h TTL, abortable poll)
- InboxWatcher with `promptAsync` user-bubble replay (`agent/model/variant`), `DONE:` protocol
- Tools: register/list/broadcast/status/agents/models, discover/ps, fast exec, notify + handoff-back + thread, allow/block/policy/summary/group
- v1-only pin (`/opt/homebrew/bin/opencode` 1.18.32), server-client heartbeat + inbound auth

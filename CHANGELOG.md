# Changelog

## 0.1.0 (2026-09-24) — Initial release

- Registry + file-spool transport (atomic 0600 writes, 24h TTL, abortable poll)
- InboxWatcher with `promptAsync` user-bubble replay (`agent/model/variant`), `DONE:` protocol
- Tools: register/list/broadcast/status/agents/models, discover/ps, fast exec, notify + handoff-back + thread, allow/block/policy/summary/group
- v1-only pin (`/opt/homebrew/bin/opencode` 1.18.32), server-client heartbeat + inbound auth

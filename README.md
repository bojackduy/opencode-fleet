# opencode-fleet-v1

Lightweight orchestrator → workers for OpenCode v1 (file spool + `prompt_async`, takeover-friendly).

One commander session fans out self-contained tasks to all registered worker sessions, watches `DONE:` replies, and reports back. Every delegation lands as a **normal user message**, so manual takeover with `revert / fork / continue` keeps working. Killing the commander never breaks workers.

> Scope: **v1 only** (`opencode` 1.18.32 via `/opt/homebrew/bin/opencode`). No v2, no A2A.

## Install

```jsonc
// opencode.jsonc (v1 shape)
{ "plugin": ["file:/Users/duytrinh/Code/opencode-fleet-v1"] }
```

Or from npm once published:

```jsonc
{ "plugin": ["@bojackduy/opencode-fleet-v1"] }
```

## Tools

| Tool | What it does |
| ---- | ------------ |
| `fleet_register` | Register current session (daemon, directory, summary) |
| `fleet_list` | List workers (24h TTL, excludes self by default) |
| `fleet_discover` / `fleet_ps` | Discover live sessions + process/port join (v1 API first) |
| `fleet_broadcast` | Fan out to all / `only:[...]` with `agent/model/variant`, waits for `.res.json` |
| `fleet_exec` | Fast direct `promptAsync` + abort/retry, spool fallback |
| `fleet_status` / `fleet_thread` | Compact status + `DONE:` extraction / thread view |
| `fleet_handoff_back` | Worker hands corrected result back to commander (`Re:reqId`) |
| `fleet_agents` / `fleet_models` | List available agents / models |
| `fleet_allow` / `fleet_block` / `fleet_policy` | Commander allowlist + `accept/hold/refuse` inbound policy |
| `fleet_summary` / `fleet_group` | Grouped counts + last `DONE:` per group |

## Protocol

Delegated prompts are wrapped as:

```
[from fleet-v1 <reqId> | commander:<id>]
<self-contained task>
Reply ending with exactly: DONE:<one-line-result>
```

Workers reply via `.res.json`; commanders are auto-notified via `.notify.json`.

## License

AGPL-3.0-or-later — see [LICENSE](./LICENSE).
Original work by Duy Trinh (bojackduy), 2026. CI/publish pipeline adapted
from [@bojackduy/opencode-loopd](https://github.com/bojackduy/opencode-loopd).

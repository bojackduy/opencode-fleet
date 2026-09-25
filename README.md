# opencode-fleet

Lightweight orchestrator → workers for OpenCode (file spool + `prompt_async`, takeover-friendly; v1+v2 compatible).

One commander session fans out self-contained tasks to all registered worker sessions, watches `DONE:` replies, and reports back. Every delegation lands as a **normal user message**, so manual takeover with `revert / fork / continue` keeps working. Killing the commander never breaks workers.

> Scope: **v1+v2** (plugin id `fleet`; v1 `opencode` 1.18.32 via `/opt/homebrew/bin/opencode`, v2 `2.0.16+`).

## Install

```jsonc
// opencode.jsonc (v1 shape)
{ "plugin": ["file:/Users/duytrinh/Code/opencode-fleet"] }
```

Or from npm once published:

```jsonc
{ "plugin": ["@bojackduy/opencode-fleet"] }
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
[from fleet <reqId> | commander:<id>]
<self-contained task>
Reply ending with exactly: DONE:<one-line-result>
```

Workers reply via `.res.json`; commanders are auto-notified via `.notify.json`.

## OpenCode v2

The same entry line works in **both** runtimes (minimum v2 `2.0.16`): v2
migrates the v1 `plugin` list and loads the dual-shape `dist/index.js`
(`{ id, server, setup }` — v1 runs `server`, v2 runs `setup`).

```jsonc
// already have this? nothing to add — it loads on v2 too.
{ "plugin": ["file:/Users/duytrinh/Code/opencode-fleet"] }
```

Otherwise:

```sh
opencode2 plugin add @bojackduy/opencode-fleet
```

```jsonc
// opencode.jsonc (v2 shape)
{ "plugins": ["@bojackduy/opencode-fleet"] }
```

Caveats:

- Do **not** point a v2 `plugins` entry at a file path (`…/dist/index.js`
  is rejected — "must be a directory"). Use the package spec above, or an
  absolute directory that contains `server.*`/`index.*` at its root.
- All 19 `fleet_*` tools register natively per location; identity is the
  calling `sessionID`. Delegation routes by the target row's `runtime`:
  same-process in-process prompt → remote v2 HTTP (`POST
  {url}/api/session/{id}/prompt`, password read from
  `state/opencode/service.json` only on URL match at send time, never
  logged/persisted/registered) → file-spool fallback, which is also the
  universal v1↔v2 path. Every delegation still lands as a normal user
  message ending in a `DONE:` reply.
- v1 behaviour is unchanged (v1 pin `@opencode-ai/plugin 1.18.32` kept for
  v1 paths; v2 uses structural types only).

## License

AGPL-3.0-or-later — see [LICENSE](./LICENSE).
Original work by Duy Trinh (bojackduy), 2026. CI/publish pipeline adapted
from [@bojackduy/opencode-loopd](https://github.com/bojackduy/opencode-loopd).

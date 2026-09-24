# Fleet P4 — server-client auth (progress + evidence)

P1–P3 preserved (11 tools, src/v1.ts, discover/notify/fleetExec/Handoff/Discover).
P4 adds: client heartbeat via v1 API only, commander allowlist + inbound policy,
API-first discovery (sqlite/ps/lsof demoted to deprecated fallback), fleet admin
tools, heartbeat wiring + auth gates in server().

## Files

- NEW `src/heartbeat.ts` — `beat({client, sessionID, serverUrl, directory})`
  via `client.session.get/status/messages` (limit 5, DONE: extract) +
  `getDaemonId(serverUrl)`. Never throws; per-call try/catch + fallbacks.
- NEW `src/auth.ts` — `fleet-v1/auth.json` (`{commanders, policy}` default
  `accept`), 0600 atomic temp+rename. Exports `canExec` (true | false | "hold"),
  `addCommander/removeCommander/listCommanders`, `setPolicy/getPolicy`.
- REWROTE `src/discover.ts` — hot path is `discoverViaClient` (session.list) →
  `discoverViaRegistry` (heartbeat registry) → deprecated sqlite/ps/lsof only on
  a miss with `client.app.log` deprecation warning. `discoverSessions(limit,
  client?)` and `fleetPs(limit, client?)` keep compat signatures.
- EXTENDED `src/registry.ts` — optional `agent/model/status/lastDone` (heartbeat
  enrichment, backward compatible).
- NEW `src/tools/fleetAdmin.ts` — `fleet_allow / fleet_block / fleet_policy /
  fleet_summary / fleet_group` (groupBy directory|project|agent|status, counts +
  last DONE per group). v1 `tool()`, never throws, `.js` suffixes.
- `src/tools/fleetExec.ts`, `src/tools/fleetBroadcast.ts` — P4 auth gate at top:
  hold → queue `.req.json` (+`held:true`) + `.notify.json` (`held:true`), return
  "held for approval, use fleet_allow"; refuse → readable deny; allow → existing
  direct/spool fast path unchanged.
- `src/tools/fleetDiscover.ts` — now calls `discoverSessionsPreferApi(client)`
  / `fleetPs(50, client)` (registry first).
- `src/index.ts` — `heartbeatAndRegister()` (beat → registerSelf with
  title/agent/model/status/lastDone) on start, `session.created`, `session.idle`;
  `session.deleted` → `removeSession` (unchanged). Wires 5 new admin tools.

## Evidence

### 1. No subprocess/DB in hot-path new code

```
$ grep -rn "child_process" src/heartbeat.ts src/auth.ts src/tools/fleetAdmin.ts
(no matches, exit 1)
$ grep -rn "sqlite" src/heartbeat.ts src/auth.ts src/tools/fleetAdmin.ts
(no matches, exit 1)
$ grep -rn "child_process" src/
src/discover.ts:16: import { execFile } from "node:child_process";  # deprecated fallback only
```

### 2. Heartbeat sample (fake v1 client)

```
HEARTBEAT {"sessionId":"ses-test-1","daemonId":"…-14121","directory":"/tmp/proj",
 "title":"Test Session","agent":"general","model":"openai/gpt-5",
 "status":"idle","lastDone":"shipped it","updatedAt":…}
VIAREG [{"id":"ses-test-1",…,"agent":"general","model":"openai/gpt-5","registered":true}]
PREFER (live API + registry join) → same row, registered:true
```

### 3. Allow / hold / refuse flow

```
policy=accept, open list → canExec('anyone') = true
allowlist=[ses-commander-1] → listed=true, stranger=false
policy=hold   → canExec = "hold"
policy=refuse → canExec = false
EXEC-HOLD: ses-test-1 | held for approval, use fleet_allow   (+ held .req.json/.notify.json written)
BC-HOLD:   ses-test-1: held for approval, use fleet_allow
EXEC-REFUSE: fleet_exec denied: commander … not allowed (use fleet_allow / fleet_policy)
BC-REFUSE:   fleet_broadcast denied: commander … not allowed (use fleet_allow / fleet_policy)
```

### 4. Summary / group table

```
group(directory) | count | lastDONE
/tmp/proj | 1 | shipped it
POLICY-READ: policy=accept allowlist=1 (ses-commander-1)
```

### 5. Build + typecheck clean (opencode 1.18.32, v1 only)

```
$ npx tsc --noEmit   # clean
$ npm run build      # clean → dist/heartbeat.js, dist/auth.js, dist/tools/fleetAdmin.js
```

Test artifacts (ses-test-1 registry entry, held spool files, test commander)
were removed; `auth.json` reset to `{commanders: [], policy: accept}`.

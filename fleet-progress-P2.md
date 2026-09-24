# Fleet P2 — fast direct exec (`fleet_exec`) — DONE

## What
- New: `src/tools/fleetExec.ts` exporting `fleet_exec` (v1 tool) + `fleetExecHandler`.
- Wired in `src/index.ts` → now 9 tools (was 8).
- Conventions kept: ESM `.js` suffixes, `client.app.log` (no console.log),
  zod via `tool.schema`, never-throw handlers returning readable text.

## Params
`sessionId*`, `message*`, `agent?`, `model?` (`"provider/model"` string or
`{providerID, modelID}` union), `variant?`, `system?`,
`timeoutMs?` (default 60000, clamp 1000–600000),
`mode?` `"direct"` (default) | `"spool"`, `abortOnBusy?` (default true).

## Paths
- **DIRECT** (default): registry validate → `buildInjectText({reqId:
  exec-<ms>-<rand>, fromCommander: selfId, ...})` → `client.session.promptAsync`
  (never noReply) → poll `client.session.messages({path:{id}, query:{limit:10}})`
  for new assistant `DONE:` line after `beforeTime`, 500 ms cadence,
  honors `context.abort`.
- **Abort/retry note**: on `SessionBusyError` (name/message contains "busy")
  with `abortOnBusy`, best-effort `client.session.abort({path:{id}})` then
  exactly one `promptAsync` retry. Abort/timeout stays a direct error
  (no spool — same daemon already failed live).
- **SPOOL fallback**: only when direct fails with not-found/unreachable
  (owning daemon asleep) — or when `client.session.promptAsync` is absent.
  Reuses the same envelope (`targetSessionId`/`targetDaemonId` from registry):
  `writeReq` → `readRes` → `cleanupReq` in `finally`.
- `mode:"spool"` skips DIRECT entirely (same write/poll/cleanup).
- Registry miss → `fleet_exec failed: <id> not in registry (suggest
  fleet_discover to find live sessions)`.

## Return shape
- ok: `<sessionId> | via:direct|spool | ok | DONE:<line> | <200-char snippet>`
- err: `<sessionId> | via:<v> | error: <readable>` (never throws)

## Evidence
- `npx tsc --noEmit` clean, `npm run build` clean.
- `ls src/tools/fleetExec.ts` present.
- Handler smoke (dist):
  - empty sessionId → `fleet_exec failed: sessionId must be a non-empty string`
  - unknown id → `... not in registry (suggest fleet_discover ...)`
  - empty message → `fleet_exec failed: message must be a non-empty string`
  - spool vs registered temp entry, timeoutMs 1000 → 
    `p2-smoke | via:spool | error: timeout after 1000ms waiting for reply
    (req exec-...)`; messages dir shows 0 `exec-*` leftovers (cleanup ok).
- Direct path not live-fired here (no second daemon in this env);
  logic mirrors inbox `promptAsync` + `messages` polling already proven in P1.

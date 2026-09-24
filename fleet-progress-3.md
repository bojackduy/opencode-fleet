# fleet-progress-3 — Phase 3 fleet tools

Phase 3 complete. `src/tools/` created with 5 files; `npx tsc --noEmit` clean;
Phase 1 (`registry.ts`, `fileTransport.ts`) and Phase 2 (`inbox.ts`) untouched.

## Files

- `src/tools/fleetRegister.ts` — `fleet_register(summary)` via `registerSelf()`;
  self id from `context.sessionID`, daemon via `getDaemonId(serverUrl)`,
  directory via `context.directory`. Returns
  `registered <sessionId> as <summary> in <directory>`.
  Exports `makeFleetRegisterTool(deps)` + `fleetRegisterHandler`.
- `src/tools/fleetList.ts` — `fleet_list(includeSelf=false)` via `listRegistry()`
  (24h TTL already filtered there). Compact
  `sessionId | daemonId | directory | summary | ageH` table; empty →
  `no workers registered`. Exports `makeFleetListTool` + `fleetListHandler`.
- `src/tools/fleetBroadcast.ts` — `fleet_broadcast(message, only?, agent?,
  model?, variant?, system?, timeoutMs?=60000 max 600000)`: validates each
  target against fresh registry (`not in registry` per-target error), builds
  `FleetEnvelope` with `req-<now>-<rand>` reqId, appends `DONE_FOOTER` (imported
  from `inbox.ts`) when `DONE:` missing, `writeReq` → `readRes(reqId,
  timeoutMs, context.abort)` → `cleanupReq` in `finally`. Parallel fan-out via
  `Promise.all`; timeout/abort/write failures → per-target
  `{ok:false, error}` text lines; outer never throws.
  Exports `makeFleetBroadcastTool` + `fleetBroadcastHandler` + `ensureDoneInstruction`.
- `src/tools/fleetStatus.ts` — `fleet_status(sessionIds?)` (default: all fresh
  registry incl. self): `client.session.status()` map → status cell,
  `client.session.messages({path:{id},query:{limit:5}})` → last assistant text →
  trailing `/^DONE:(.*)/m` + 120-char snippet. Per-row errors as readable cells.
  Exports `makeFleetStatusTool` + `fleetStatusHandler`.
- `src/tools/fleetAgents.ts` (bonus) — `fleet_agents` via
  `client.app.agents()`, `fleet_models` via `client.config.providers()`
  (handles array- and map-shaped responses); SDK gaps → TUI `/agent`/`/model`
  hint. Exports `makeFleetAgentsTool`/`makeFleetModelsTool` + handlers.

## Conventions (per objective)

- `import { tool } from "@opencode-ai/plugin"`, args via `tool.schema.*`
  (verified against `node_modules/@opencode-ai/plugin/dist/tool.d.ts`).
- `PluginInput` shape confirmed in `/Users/duytrinh/Code/opencode`
  `packages/plugin/src/index.ts` (`client`, `directory`, `worktree`,
  `serverUrl: URL`); SDK `session.status()` → map, `session.messages()` →
  `{info,parts}[]` confirmed in `@opencode-ai/sdk` gen types.
- Deps (`client`, `serverUrl`) captured in `make*Tool(deps)` closure; handlers
  take `(args, context, deps)` so Phase 4 `index.ts` can wire directly.
- `client.app.log` (best-effort) in register; no `console.log`; no throws.

## Evidence

- `ls src/tools/fleetRegister.ts src/tools/fleetList.ts src/tools/fleetBroadcast.ts src/tools/fleetStatus.ts src/tools/fleetAgents.ts` — all present.
- `npx tsc --noEmit` — exit 0.

## Next (Phase 4, out of scope)

Wire `make*Tool({client, serverUrl})` in `src/index.ts`
`export default { id: "fleet.v1", server }`, start `startInboxWatcher` in
`server()`, `handleSessionEvent` in `event()`.

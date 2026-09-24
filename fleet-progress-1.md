# fleet-progress-1 — Phase 1 foundation (done)

## What was built
- `package.json` — name `opencode-fleet-v1`, type module, deps `@opencode-ai/plugin@1.18.32`, dev `typescript` + `@types/node`.
- `tsconfig.json` — strict, module/moduleResolution `nodenext`, target `es2022`, rootDir `src`, outDir `dist`.
- `.gitignore` — `node_modules/`, `dist/`.
- `src/registry.ts` — registry under `$XDG_STATE_HOME/opencode/fleet-v1/registry.json` (fallback `~/.local/state/opencode/fleet-v1/`).
  - Entry `{sessionId, daemonId, directory, title?, summary?, updatedAt}`.
  - In-process promise-chain RMW + temp+rename atomic writes, 0600 files.
  - Exports `readRegistry`, `registerSelf`, `listRegistry({includeSelf,selfId,now})` with 24h TTL hide, `removeSession`. Never throws on missing/corrupt → `[]`.
- `src/fileTransport.ts` — spool under same state dir `messages/`.
  - `FleetEnvelope {reqId, fromCommander, targetSessionId, targetDaemonId?, message, agent?, model?: {providerID,modelID} | "provider/model", variant?, system?, createdAt}`.
  - `FleetResult {ok, reply?, error?}`, `.req.json` / `.res.json`.
  - Helpers `stateDir`, `messagesDir`, `atomicWriteJson`, `abortableSleep`; `writeReq/readReq/writeRes/readRes(reqId, timeoutMs, signal?)` with 500ms response poll; `RESPONSE_POLL_MS=500`, `INBOX_POLL_MS=1000`; `cleanupReq`.

## Verification
- `/opt/homebrew/bin/opencode --version` → `1.18.32`
- `ls src/` → `fileTransport.ts`, `registry.ts`
- `npx tsc --noEmit` → exit 0, no output.

## Notes / next (Phase 2, not started)
- InboxWatcher, `src/index.ts` plugin entry, fleet tools (`fleet_register/list/broadcast/status`) are Phase 2+.
- Envelope already carries agent/model/variant/system so delegations stay self-contained for replay.

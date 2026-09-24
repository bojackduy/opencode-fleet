# fleet-progress-2 — Phase 2 inbox watcher (done)

## What was built
- `src/inbox.ts` — worker-side InboxWatcher (plain TS strict, ESM, v1 only).
  - `getDaemonId(serverUrl)` → `${hostname}-${pid}-${port}` (URL port parse, trailing `:port` regex, raw-string fallback). Plus `claimedPath(reqId)` marker helper.
  - `buildInjectText(envelope)` → `[from fleet-v1 <reqId> | commander:<from>]` header + message + `DONE:` footer (footer always appended even if message already mentions `DONE:`).
  - `parseFleetModel(m)` → `{providerID,modelID}` passthrough / `"provider/model"` first-slash split+trim, `undefined` on missing/empty/no-slash.
  - `startInboxWatcher({client, sessionID, serverUrl, daemonId, pollMs=1000, responsePollMs=500, onLog})` → `{stop, isRunning}`.
    - `setInterval(pollMs)` scans `messagesDir()` `*.req.json` via `node:fs` readdir; skips non-target session, non-target daemon, already-claimed (in-memory Set + `.res.json` exists + `.claimed` marker).
    - Pickup runs fire-and-forget (in-flight Set, scan never blocks): writes `.claimed`, `promptAsync({path:{id}, body:{parts:[{type:"text",text}], agent?, model?, variant?, system?}})` — NEVER `noReply:true` — then polls `client.session.messages` up to 120s (`INBOX_RESPONSE_TIMEOUT_MS`) for new assistant text after `beforeTime` containing a trailing `DONE:` line; writes `.res.json` `{ok:true,reply}` or `{ok:false,error}` (timeout / no-DONE / Agent-not-found / Model-not-found all captured, never throws).
    - Logging via `client.app.log({body:{service:"fleet-v1",level:"info",message}})` + optional `onLog`; no `console.log`.
  - `stopInboxWatcher(handle)` + `handle.stop()`; `handleSessionEvent(event, selfSessionId)` — `session.deleted` → `removeSession(self)`, `session.idle` → `registerSelf` heartbeat refresh; best-effort try/catch, never throws.
  - Re-exports `INBOX_POLL_MS` from `fileTransport.js`; imports use `.js` suffixes (nodenext). No DB writes, peer text only rendered as user-bubble text.
  - Did not modify `src/registry.ts` / `src/fileTransport.ts`.

## Verification
- `ls src/inbox.ts` → present.
- `npx tsc --noEmit` → exit 0, no errors.
- `grep -c promptAsync src/inbox.ts` → 3 (doc comment + call + timeout comment).
- References used: `prompt.ts` PromptInput (model/agent/variant/system/parts, noReply) + setAgentModel switch; SDK `types.gen.d.ts` `SessionPromptAsyncData` (path/body incl. agent/model/system/parts, no variant — passed via `any` client) and `AppLogData` (`body:{service,level,message}`).

## Notes / next (Phase 3, not started)
- `src/index.ts` plugin entry (`{id:"fleet.v1", server}` wiring start/stop + `event`), fleet tools (`fleet_register/list/broadcast/status`) remain Phase 3+.

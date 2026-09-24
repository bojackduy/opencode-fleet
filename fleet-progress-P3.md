# Fleet P3 — notify + handoff-back — DONE

## What
- New: `src/notify.ts` (`writeNotify`, `readNotify`, `listNotifications`,
  `clearNotify`, `FleetNotify`, `notifyPath`). After the inbox writes
  `.res.json` with ok:true + DONE line, it also writes `.notify.json`
  `{reqId,targetSessionId,fromCommander,done,replySnippet,createdAt}` via
  `atomicWriteJson` (0600). Best-effort, never throws.
- Hooked into both inbox paths (P1+P2 must not break):
  `src/inbox.ts` `handleOne` (after successful `writeRes(ok:true)`) and
  `src/index.ts` `startDaemonWatcher.handleOne` (same point). Existing
  behavior kept; notify failure only emits a warn log (inbox.ts) or is
  swallowed (index.ts daemon watcher).
- New: `src/tools/fleetHandoff.ts` with two v1 tools:
  - `fleet_handoff_back {message*, done?, agent?, model?, variant?}` —
    finds most recent `.req.json` with `targetSessionId==selfId` (readdir +
    readReq, max createdAt) for the `fromCommander` + `reqId` chain; builds
    a reverse envelope (`targetSessionId=fromCommander`,
    `fromCommander=selfId`, message = correction + `Re: <reqId>` thread ref
    + optional `Suggested result: DONE:<done>`, injected via
    `buildInjectText` so the DONE footer is always present; agent/model/
    variant passthrough); DIRECT `client.session.promptAsync` when
    reachable else SPOOL `writeReq`; returns
    `handed back to <id> via:direct/spool (req <new> Re: <orig>)`.
  - `fleet_thread {reqId?, limit? default 10, max 50}` — reads all
    `.req.json`, filters by same/prefix reqId or `Re: <reqId>` in message,
    sorts by createdAt asc, resolves `done` via `.notify.json` first then
    `.res.json` reply DONE line, renders
    `reqId|from->to|done|snippet` table. Both never throw.
- Wired in `src/index.ts` → now 11 tools (was 9): + `fleet_handoff_back`,
  `fleet_thread`. ESM `.js` suffixes, `tool()` + zod, `client.app.log`.

## Evidence
- `ls src/notify.ts`, `ls src/tools/fleetHandoff.ts` present.
- `npx tsc --noEmit` clean (exit 0), `npm run build` clean (exit 0);
  `dist/notify.js`, `dist/tools/fleetHandoff.js` emitted.
- 11 tools wired (`grep fleet_ src/index.ts` → register, list, broadcast,
  status, agents, models, discover, ps, exec, handoff_back, thread).
- Notify sample (dist smoke, temp XDG_STATE_HOME):
  `{"reqId":"req-001","targetSessionId":"ses-B","fromCommander":"ses-orches",`
  `"done":"ok-x","replySnippet":"did X DONE:ok-x","createdAt":...}` —
  mode `100600`; `readNotify` after `clearNotify` → null; corrupt
  `bad.notify.json` skipped by `listNotifications` (returns [] for others,
  never throws).
- Handoff reverse flow (orches→B→orches, temp spool):
  - `writeReq(req-abc, orches→B)` then as ses-B:
    `fleet_handoff_back{message:'needs correction…'}` with live client →
    `DIRECT_TO:ses-orches` +
    `handed back to ses-orches via:direct (req handoff-… Re: req-abc)`.
  - Same call with no client →
    `handed back to ses-orches via:spool (req handoff-… Re: req-abc)` +
    spool file present.
  - No inbound (ses-nobody) →
    `fleet_handoff_back failed: no inbound delegation found …` (never throws).
- Thread table (`fleet_thread{reqId:'req-abc'}`):
  ```
  reqId|from->to|done|snippet
  req-abc|ses-orches->ses-B|widget-ok|build widget
  handoff-1|ses-B->ses-orches|-|needs tweak Re: req-abc
  ```
  (done resolved from `.notify.json`; `Re:` ref links the handoff row;
  unknown filter → `no thread entries for reqId nope`).

## Constraints kept
- v1 only (`/opt/homebrew/bin/opencode 1.18.32` path untouched), strict TS
  ESM, no DB writes, peer text treated as untrusted plain text.
- P1+P2 paths untouched except the additive notify call after success.

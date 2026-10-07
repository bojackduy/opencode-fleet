---
name: fleet
description: Command and coordinate multiple live OpenCode sessions with opencode-fleet. Use this skill whenever orchestrating workers, taking over a session, handing work back, assigning/transferring workers, or debugging fleet delegation, ownership, liveness, DONE replies, or recovery. Even if the user says commander, workers, takeover, handoff, broadcast, exec, watch, assign, or multi-session, use this workflow before touching fleet tools.
---

# Fleet commander/worker skill

Opencode-fleet coordinates independent OpenCode sessions. One worker has exactly one controlling commander. Delegations arrive as normal user messages, so manual takeover, revert, fork, continue, diff, and abort keep working.

## Unconditional truths

- Identity is composite: `runtime + daemonId + sessionId`. Bare `ses_` IDs can collide across v1/v2.
- Ownership is exclusive: only the current owning commander can list, check, exec, broadcast to, transfer, or release a worker.
- `force:true` never bypasses worker ownership.
- Registry history is not liveness: a registered row can be stale, dead, closed, or from another daemon.
- Every delegated task must be self-contained and end with: `DONE:<one-line-result>`.
- File notifications alone do not wake an idle model; the commander must observe and act.
- Fleet sees loopd workers' goal name/status/phase via the project-local loopd state (read-only `loopd` column in `fleet_list` / `fleet_my_workers`, `| loopd:…` suffix in `fleet_status`).

## Commander workflow

Use this order. Do not skip ownership.

1. Register and claim:
   - `fleet_register`
   - `fleet_claim_commander`
   - If tools say the session is not a commander, claim first; do not proceed as a peer.
2. Find claimable work:
   - `fleet_discover`
   - `fleet_unassigned`
   - Prefer recently heartbeated rows. Treat old rows as history until proven live.
3. Claim workers explicitly:
   - `fleet_assign`
   - If owned by another commander, stop; only the owner can transfer or release it.
   - If IDs collide across runtimes, supply the full composite selector.
4. Verify before delegating:
   - `fleet_my_workers`
   - `fleet_list`
   - `fleet_status`
   - If status is `unknown`, stale, or the heartbeat is old, do not broadcast blindly.
5. Delegate narrowly:
   - `fleet_exec` for one worker.
   - `fleet_broadcast` only to owned workers, preferably with an explicit target list.
   - Keep messages self-contained: goal, files, constraints, completion criteria, and `DONE:` instruction.
6. Observe completions:
   - `fleet_watch`
   - `fleet_ack`
   - `fleet_thread`
   - A trailing `DONE:` line is the completion signal. Timeouts mean no live worker answered.
7. Move ownership explicitly:
   - `fleet_transfer`
   - `fleet_unassign`
   - `fleet_recover_commander` only after restart, for the same commander session, after the old daemon PID has exited.

## Worker and takeover workflow

1. Do the delegated work.
2. End the final reply with exactly: `DONE:<one-line-result>`.
3. If the commander's intent was wrong or incomplete, correct it manually, then use `fleet_handoff_back`.
4. Handoff routes to the current owner, even after transfer or request cleanup.
5. Never spoof another session or commander identity.

## Failure-first responses

Translate tool errors into action:

- `not a commander` → run `fleet_claim_commander`.
- `no workers assigned` → run `fleet_my_workers`, then `fleet_unassigned` or `fleet_discover`, then `fleet_assign`.
- `owned-by-other` → stop; ask the owning commander to transfer or release.
- `ambiguous` → supply runtime plus daemon ID.
- `stale` or old heartbeat → release/reassign only a live worker; do not retry blindly.
- broadcast/exec timeout → treat targets as not live; verify heartbeat, daemon, registration, ownership, and generation before resending.
- `policy=refuse` or `held` → use `fleet_allow`, transfer, or change policy explicitly.

## Commander status output

When asked for fleet status, report:

- commander session and directory;
- owned workers only, grouped by live/stale/dead;
- for each live worker: session, runtime/daemon, directory, summary, status, last `DONE:`, next action;
- stale/dead rows separately with release/reassign guidance;
- never present registry history as active work.

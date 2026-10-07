/**
 * fleet-dashboard.tsx — thin Solid renderer for the fleet TUI dashboard.
 *
 * All tab/selection/liveness/owner-scope/confirm logic lives in
 * fleet-view.ts (headless); all server calls go through FleetControl
 * (fleet-control.ts, 1:1 with existing server tools). This component only
 * renders state and traps keys inside the modal.
 *
 * Modal contract (mirrors loopd's dashboard.tsx): single always-focused
 * input traps keys, no leak to chat; destructive actions
 * (unassign/transfer/release/recover/broadcast/exec) require the confirm
 * step (y/n); dead rows render distinctly and are never sendable.
 */

/** @jsxImportSource @opentui/solid */
import { createSignal, For, Show, onCleanup, onMount } from "solid-js";
import { useKeyboard } from "@opentui/solid";
import type { TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui";
import type { InputRenderable, ParsedKey } from "@opentui/core";
import { FleetControl, type FleetSnapshot } from "./fleet-control.js";
import {
  FLEET_TABS,
  assignableRows,
  buildThreadGroups,
  buildWorkerRows,
  canSendToRow,
  clampFleetSelection,
  confirmLabel,
  eventsViewOf,
  fleetEventLabel,
  fleetTabForKey,
  initialFleetSelection,
  isDeadRow,
  moveFleetSelection,
  needsConfirm,
  nextFleetTab,
  prevFleetTab,
  resolveFleetOpen,
  switchFleetTab,
  visibleWorkerRows,
  workerRowLabel,
  type FleetAction,
  type FleetSelection,
  type FleetTab,
  type WorkerRow,
} from "./fleet-view.js";
import type { AssignmentEvent } from "../core/notify.js";

function prevent(evt: ParsedKey): void {
  const e = evt as ParsedKey & { preventDefault?: () => void; stopPropagation?: () => void };
  e.preventDefault?.();
  e.stopPropagation?.();
}

function keyName(evt: ParsedKey): string {
  return ((evt as unknown as { name?: string }).name || "").toLowerCase();
}

function keySeq(evt: ParsedKey): string {
  const e = evt as unknown as { sequence?: string; raw?: string };
  return e.sequence || e.raw || "";
}

export function isEnterKey(evt: ParsedKey): boolean {
  const name = keyName(evt);
  if (name === "return" || name === "enter" || name === "kp_enter") return true;
  const seq = keySeq(evt);
  return seq === "\r" || seq === "\n";
}

export function isEscapeKey(evt: ParsedKey): boolean {
  if (keyName(evt) === "escape" || keyName(evt) === "esc") return true;
  return keySeq(evt) === "\x1b";
}

type Mode = "normal" | "insert";

interface PendingConfirm {
  action: FleetAction;
  target: string;
  label: string;
  run: () => Promise<void>;
}

interface Props {
  api: TuiPluginApi;
  directory: string;
  initialTab?: FleetTab;
  ownerSessionID?: string;
  control?: FleetControl;
  isActive?: () => boolean;
}

function livenessColor(liveness: string, theme: TuiThemeCurrent): string {
  if (liveness === "live") return theme.success as unknown as string;
  if (liveness === "stale") return theme.warning as unknown as string;
  return theme.error as unknown as string;
}

function ownershipTag(row: WorkerRow, theme: TuiThemeCurrent): { text: string; color: string } {
  switch (row.ownership) {
    case "mine": return { text: "mine", color: theme.success as unknown as string };
    case "other": return { text: `owned:${row.ownerSessionId ?? "?"}`, color: theme.warning as unknown as string };
    case "stale": return { text: "STALE", color: theme.error as unknown as string };
    default: return { text: "free", color: theme.info as unknown as string };
  }
}

export function FleetDashboard(props: Props) {
  const theme = () => props.api.theme.current;
  const [mode, setMode] = createSignal<Mode>("normal");
  const [sel, setSel] = createSignal<FleetSelection>(initialFleetSelection(props.initialTab ?? "workers"));
  const [snap, setSnap] = createSignal<FleetSnapshot | null>(null);
  const [commandInput, setCommandInput] = createSignal("");
  const [statusText, setStatusText] = createSignal("Tab switch · 1-4 tabs · j/k move · : command · ? help · q close");
  const [showHelp, setShowHelp] = createSignal(false);
  const [showAll, setShowAll] = createSignal(false);
  const [pending, setPending] = createSignal<PendingConfirm | null>(null);
  let inputEl: InputRenderable | undefined;
  let focusTimer: ReturnType<typeof setTimeout> | undefined;
  const control = () => props.control ?? new FleetControl({ ownerSessionID: props.ownerSessionID });
  const popMode = props.api.mode.push("fleet.dashboard");

  const rows = (): WorkerRow[] => {
    const s = snap();
    if (!s) return [];
    return visibleWorkerRows(
      buildWorkerRows({ entries: s.entries, assignments: s.assignments, callerKey: s.callerKey }),
      showAll(),
    );
  };
  const pool = (): WorkerRow[] => assignableRows(
    buildWorkerRows({
      entries: snap()?.entries ?? [],
      assignments: snap()?.assignments ?? {},
      callerKey: snap()?.callerKey ?? "",
    }),
  );
  const events = (): AssignmentEvent[] => {
    const s = snap();
    if (!s) return [];
    return eventsViewOf(s.events, s.cursor, s.totalUnacked, s.eventsStatus, s.eventsError).unacked;
  };
  const groups = () => buildThreadGroups(snap()?.entries ?? []);
  const counts = () => ({
    workers: rows().length,
    events: events().length,
    assign: pool().length,
    threads: groups().flatMap((g) => g.members).length,
  });

  function focusInput(): void {
    if (focusTimer) clearTimeout(focusTimer);
    focusTimer = setTimeout(() => {
      const current = props.api.renderer.currentFocusedRenderable;
      if (current && current !== inputEl) current.blur();
      inputEl?.focus();
    }, 10);
  }

  async function refresh(): Promise<void> {
    try {
      const s = await control().refresh();
      setSnap(s);
      setSel((prev) => clampFleetSelection(prev, counts()));
      if (s.error) setStatusText(`Error: ${s.error}`);
    } catch (e) {
      setStatusText(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function enterInsertMode(prefill = ""): void {
    setCommandInput(prefill);
    if (inputEl) inputEl.value = prefill;
    setMode("insert");
    focusInput();
  }

  function returnToNormalMode(): void {
    setCommandInput("");
    if (inputEl) inputEl.value = "";
    setMode("normal");
    focusInput();
  }

  function selectedWorkerRow(): WorkerRow | null {
    return rows()[sel().workerIndex] ?? null;
  }

  function selectedPoolRow(): WorkerRow | null {
    return pool()[sel().assignIndex] ?? null;
  }

  function selectedEvent(): AssignmentEvent | null {
    return events()[sel().eventIndex] ?? null;
  }

  function requestConfirm(action: FleetAction, target: string, run: () => Promise<void>): void {
    if (!needsConfirm(action)) {
      void run();
      return;
    }
    setPending({ action, target, label: confirmLabel(action, target), run });
    setStatusText(confirmLabel(action, target));
  }

  async function runControl(label: string, fn: () => Promise<string>): Promise<void> {
    setStatusText(`sending ${label}…`);
    try {
      const text = await fn();
      setStatusText(text.slice(0, 300));
      await refresh();
    } catch (e) {
      setStatusText(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function guardedWorker(action: FleetAction, fn: (row: WorkerRow) => Promise<void>): void {
    const row = selectedWorkerRow();
    if (!row) {
      setStatusText("No worker selected.");
      return;
    }
    if ((action === "exec") && !canSendToRow(row)) {
      setStatusText(
        isDeadRow(row)
          ? `"${row.entry.sessionId}" is dead/stale — never sendable (run fleet_doctor).`
          : `"${row.entry.sessionId}" is not yours — claim it with fleet_assign first.`,
      );
      return;
    }
    requestConfirm(action, row.entry.sessionId, () => fn(row));
  }

  async function executeCommand(cmd: string): Promise<void> {
    const text = cmd.trim().replace(/^:/, "");
    if (text === "") {
      setStatusText("Empty command");
      returnToNormalMode();
      return;
    }
    const space = text.indexOf(" ");
    const verb = (space < 0 ? text : text.slice(0, space)).toLowerCase();
    const rest = space < 0 ? "" : text.slice(space + 1).trim();
    const ctl = control();
    switch (verb) {
      case "assign": {
        const target = rest || selectedPoolRow()?.entry.sessionId || "";
        if (target === "") {
          setStatusText("Usage: :assign <sessionId> (or select a pool row)");
          break;
        }
        await runControl("assign", () => ctl.assign(target));
        break;
      }
      case "unassign": {
        const target = rest || selectedWorkerRow()?.entry.sessionId;
        requestConfirm("unassign", target ?? "(all mine)", () => runControl("unassign", () => ctl.unassign(target)));
        break;
      }
      case "transfer": {
        const row = selectedWorkerRow();
        if (!row) {
          setStatusText("No worker selected.");
          break;
        }
        if (rest === "") {
          setStatusText("Usage: :transfer <toCommanderSessionId>");
          break;
        }
        requestConfirm("transfer", `${row.entry.sessionId} -> ${rest}`, () =>
          runControl("transfer", () => ctl.transfer(row.entry.sessionId, rest)));
        break;
      }
      case "claim":
        await runControl("claim", () => ctl.claim(rest || undefined));
        break;
      case "release":
        requestConfirm("release", rest || "self", () => runControl("release", () => ctl.release(rest || undefined)));
        break;
      case "recover": {
        if (rest === "") {
          setStatusText("Usage: :recover <oldDaemonId>");
          break;
        }
        requestConfirm("recover", rest, () => runControl("recover", () => ctl.recover(rest)));
        break;
      }
      case "exec": {
        const row = selectedWorkerRow();
        if (!row) {
          setStatusText("No worker selected.");
          break;
        }
        if (!canSendToRow(row)) {
          setStatusText(`"${row.entry.sessionId}" is not sendable (dead or not yours).`);
          break;
        }
        if (rest === "") {
          setStatusText("Usage: :exec <task message>");
          break;
        }
        requestConfirm("exec", row.entry.sessionId, () =>
          runControl("exec", () => ctl.exec(row.entry.sessionId, rest)));
        break;
      }
      case "broadcast": {
        if (rest === "") {
          setStatusText("Usage: :broadcast <message>");
          break;
        }
        requestConfirm("broadcast", "ALL owned workers", () =>
          runControl("broadcast", () => ctl.broadcast(rest)));
        break;
      }
      case "watch": {
        await runControl("watch", () => ctl.watch());
        break;
      }
      case "ack": {
        const id = rest || selectedEvent()?.id || "";
        if (id === "") {
          setStatusText("Usage: :ack <eventId> (or select an event)");
          break;
        }
        await runControl("ack", () => ctl.ack(id));
        break;
      }
      case "open": {
        describeSelection();
        break;
      }
      case "show":
        setShowAll((v) => !v);
        setStatusText(showAll() ? "Showing all commanders' workers." : "Owner-scoped: mine + unassigned.");
        break;
      case "help":
        setShowHelp(true);
        break;
      case "q":
      case "close":
        props.api.ui.dialog.clear();
        return;
      default:
        setStatusText(`Unknown: ${verb}. ? for help`);
    }
    returnToNormalMode();
  }

  function describeSelection(): void {
    const target = resolveFleetOpen({ rows: rows(), events: events(), pool: pool(), groups: groups(), sel: sel() });
    if (target.kind === "worker") {
      const row = [...rows(), ...pool()].find((r) => r.workerKey === target.workerKey);
      setStatusText(row ? workerRowLabel(row) : `worker ${target.sessionId}`);
    } else if (target.kind === "event") {
      const e = events().find((ev) => ev.id === target.eventId);
      setStatusText(e ? fleetEventLabel(e) : `event ${target.eventId}`);
    } else {
      setStatusText(
        target.reason === "no-worker-selected" ? "No worker selected."
        : target.reason === "no-event-selected" ? "No event selected."
        : target.reason === "no-pool-selected" ? "No pool row selected."
        : target.reason === "no-thread-selected" ? "No thread selected."
        : "Nothing to open.",
      );
    }
  }

  useKeyboard((evt: ParsedKey) => {
    const name = keyName(evt);
    const raw = (evt as unknown as { raw?: string }).raw || "";
    const seq = keySeq(evt);
    if (!props.api.ui.dialog.open) return;
    let active = true;
    try {
      active = props.isActive?.() ?? props.api.ui.dialog.open;
    } catch {
      active = props.api.ui.dialog.open;
    }
    if (!active) return;

    // Pending confirm: y runs, n/Esc cancels. Nothing else acts.
    if (pending()) {
      const key = raw || seq || name;
      if (key === "y" || key === "Y" || isEnterKey(evt)) {
        prevent(evt);
        const p = pending();
        setPending(null);
        if (p) void p.run();
        return;
      }
      if (key === "n" || key === "N" || isEscapeKey(evt)) {
        prevent(evt);
        setPending(null);
        setStatusText("Cancelled.");
        return;
      }
      prevent(evt);
      return;
    }

    if (mode() === "insert") {
      if (isEnterKey(evt)) {
        prevent(evt);
        void executeCommand(commandInput());
        return;
      }
      if (isEscapeKey(evt) || (Boolean(evt.ctrl) && name === "n")) {
        prevent(evt);
        returnToNormalMode();
        return;
      }
      return;
    }

    const isColon = name === ":" || seq === ":" || raw === ":" || seq.includes(":") || raw.includes(":");
    const isQuestion = name === "?" || seq === "?" || raw === "?";
    if (isColon) {
      prevent(evt);
      enterInsertMode();
      return;
    }
    if (isQuestion) {
      prevent(evt);
      setShowHelp((v) => !v);
      return;
    }
    const key = raw || seq || name;
    if (name === "tab" || key === "tab") {
      prevent(evt);
      setSel((s) => switchFleetTab(s, nextFleetTab(s.tab)));
      return;
    }
    const tabKey = fleetTabForKey(key);
    if (tabKey === "next") {
      prevent(evt);
      setSel((s) => switchFleetTab(s, nextFleetTab(s.tab)));
      return;
    }
    if (tabKey === "prev") {
      prevent(evt);
      setSel((s) => switchFleetTab(s, prevFleetTab(s.tab)));
      return;
    }
    if (tabKey !== undefined) {
      prevent(evt);
      setSel((s) => switchFleetTab(s, tabKey));
      return;
    }
    function applyMove(move: "down" | "up" | "first" | "last"): void {
      setSel((s) => {
        const next = moveFleetSelection(s, move, counts());
        return { ...next };
      });
    }
    if (name === "down" || key === "j") {
      prevent(evt);
      applyMove("down");
      return;
    }
    if (name === "up" || key === "k") {
      prevent(evt);
      applyMove("up");
      return;
    }
    if (key === "g") {
      prevent(evt);
      applyMove("first");
      return;
    }
    if (key === "G") {
      prevent(evt);
      applyMove("last");
      return;
    }
    if (key === "a") {
      prevent(evt);
      const row = selectedPoolRow() ?? rows().find((r) => r.ownership === "unassigned") ?? null;
      if (!row) {
        setStatusText("No unassigned worker to claim.");
        return;
      }
      void runControl("assign", () => control().assign(row.entry.sessionId));
      return;
    }
    if (key === "u") {
      prevent(evt);
      guardedWorker("unassign", (row) => runControl("unassign", () => control().unassign(row.entry.sessionId)));
      return;
    }
    if (key === "A") {
      prevent(evt);
      const e = selectedEvent();
      if (!e) {
        setStatusText("No event selected.");
        return;
      }
      void runControl("ack", () => control().ack(e.id));
      return;
    }
    if (key === "e") {
      prevent(evt);
      enterInsertMode(":exec ");
      return;
    }
    if (key === "B") {
      prevent(evt);
      enterInsertMode(":broadcast ");
      return;
    }
    if (key === "T") {
      prevent(evt);
      enterInsertMode(":transfer ");
      return;
    }
    if (key === "c") {
      prevent(evt);
      setShowAll((v) => !v);
      setStatusText(showAll() ? "Owner-scoped: mine + unassigned." : "Showing all commanders' workers.");
      return;
    }
    if (key === "o" || isEnterKey(evt)) {
      prevent(evt);
      describeSelection();
      return;
    }
    if (key === "q") {
      prevent(evt);
      props.api.ui.dialog.clear();
      return;
    }
  });

  void refresh();
  const unsubs = [
    props.api.event.on("session.idle", () => void refresh()),
    props.api.event.on("session.status", () => void refresh()),
    props.api.event.on("session.error", () => void refresh()),
    props.api.event.on("session.compacted", () => void refresh()),
    setInterval(() => void refresh(), 10000),
  ];
  onCleanup(() => {
    popMode();
    if (focusTimer) clearTimeout(focusTimer);
    for (const u of unsubs) {
      if (typeof u === "function") (u as () => void)();
      else clearInterval(u as unknown as number);
    }
  });

  onMount(() => {
    focusInput();
  });

  return (
    <box flexDirection="column" width="100%" alignItems="center" padding={1}>
      <box flexDirection="column" width="90%" border={true} borderColor={theme().border} padding={1}>
        <box flexDirection="row" justifyContent="space-between" alignItems="center" flexShrink={0} gap={1}>
          <text>
            <span style={{ fg: theme().primary, bold: true }}>⬢ Fleet Dashboard</span>
            <span style={{ fg: theme().textMuted }}> │ </span>
            <span style={{ fg: mode() === "normal" ? theme().success : theme().warning, bold: true }}> {mode().toUpperCase()} </span>
            <span style={{ fg: theme().textMuted }}> │ </span>
            <span style={{ fg: theme().accent, bold: true }}>{rows().length}</span>
            <span style={{ fg: theme().textMuted }}> shown</span>
            <span style={{ fg: theme().textMuted }}> │ </span>
            <span style={{ fg: theme().info, bold: true }}>{snap()?.totalUnacked ?? 0}</span>
            <span style={{ fg: theme().textMuted }}> unacked</span>
          </text>
        </box>
        <box flexDirection="row" flexShrink={0} gap={2}>
          <For each={FLEET_TABS}>
            {(t, i) => (
              <text>
                <span style={{ fg: sel().tab === t ? theme().primary : theme().textMuted, bold: sel().tab === t }}>
                  {sel().tab === t ? `[${t}]` : ` ${t} `}
                </span>
                <span style={{ fg: theme().textMuted }}>{i() < FLEET_TABS.length - 1 ? "" : ""}</span>
              </text>
            )}
          </For>
          <text>
            <span style={{ fg: theme().textMuted }}>(1-4 · Tab)</span>
          </text>
        </box>

        <Show when={showHelp()}>
          <box flexDirection="column" padding={1} border={true} borderColor="yellow" flexShrink={0}>
            <text>
              <span style={{ fg: "yellow", bold: true }}>━━━ Keys: ? help · 1-4/Tab tabs · j/k/g/G move · a assign · u unassign ✓ · A ack · e exec ✓ · B broadcast ✓ · T transfer ✓ · c scope · o detail · q close ━━━</span>
              {"\n"}
              <span style={{ fg: theme().textMuted }}>✓ = confirm step first. Commands: :assign :unassign :transfer :claim :release ✓ :recover ✓ :exec ✓ :broadcast ✓ :watch :ack :show :help :q</span>
            </text>
          </box>
        </Show>

        <Show when={snap()?.error}>
          <box flexDirection="column" flexShrink={0}>
            <text>
              <span style={{ fg: theme().error, bold: true }}>⚠ {snap()?.error}</span>
            </text>
          </box>
        </Show>

        <Show when={sel().tab === "workers"}>
          <Show when={rows().length > 0} fallback={
            <box flexDirection="column" padding={1}>
              <text><span style={{ fg: theme().textMuted }}>No workers in scope. fleet_register peers, then :assign from the assign tab.</span></text>
            </box>
          }>
            <box flexDirection="column" flexShrink={0}>
              <For each={rows().slice(0, 10)}>
                {(row, i) => {
                  const tag = ownershipTag(row, theme());
                  const isActive = () => i() === sel().workerIndex;
                  return (
                    <text wrapMode="none" truncate={true}>
                      <span style={{ fg: livenessColor(row.liveness, theme()), bold: isActive() }}>{isActive() ? "▶ " : "  "}{row.entry.sessionId}</span>
                      <span style={{ fg: theme().textMuted }}> {row.liveness.toUpperCase()} {row.age} </span>
                      <span style={{ fg: tag.color }}>[{tag.text}]</span>
                      {isDeadRow(row) && <span style={{ fg: theme().error, bold: true }}> DEAD — never sendable</span>}
                    </text>
                  );
                }}
              </For>
            </box>
          </Show>
        </Show>

        <Show when={sel().tab === "events"}>
          <Show when={events().length > 0} fallback={
            <box flexDirection="column" padding={1}>
              <text><span style={{ fg: theme().textMuted }}>No unacked events. :watch to poll, :ack &lt;id&gt; (or A) to advance.</span></text>
            </box>
          }>
            <box flexDirection="column" flexShrink={0}>
              <For each={events().slice(0, 10)}>
                {(e, i) => (
                  <text wrapMode="none" truncate={true}>
                    <span style={{ fg: theme().accent, bold: i() === sel().eventIndex }}>{i() === sel().eventIndex ? "▶ " : "  "}{fleetEventLabel(e)}</span>
                  </text>
                )}
              </For>
            </box>
          </Show>
        </Show>

        <Show when={sel().tab === "assign"}>
          <Show when={pool().length > 0} fallback={
            <box flexDirection="column" padding={1}>
              <text><span style={{ fg: theme().textMuted }}>No assignable workers. a does nothing until a live unassigned row appears.</span></text>
            </box>
          }>
            <box flexDirection="column" flexShrink={0}>
              <For each={pool().slice(0, 10)}>
                {(row, i) => (
                  <text wrapMode="none" truncate={true}>
                    <span style={{ fg: theme().info, bold: i() === sel().assignIndex }}>{i() === sel().assignIndex ? "▶ " : "  "}{workerRowLabel(row)}</span>
                  </text>
                )}
              </For>
            </box>
          </Show>
        </Show>

        <Show when={sel().tab === "threads"}>
          <box flexDirection="column" flexShrink={0}>
            <For each={groups().slice(0, 10)}>
              {(g) => (
                <text wrapMode="none" truncate={true}>
                  <span style={{ fg: theme().primary, bold: true }}>⑂ {g.rootSessionId}</span>
                  <span style={{ fg: theme().textMuted }}> ({g.members.length}) {g.members.map((m) => m.sessionId.slice(0, 12)).join(", ")}</span>
                </text>
              )}
            </For>
            <Show when={groups().length === 0}>
              <text><span style={{ fg: theme().textMuted }}>No sessions in registry.</span></text>
            </Show>
          </box>
        </Show>

        <Show when={pending()}>
          <box flexDirection="column" border={true} borderColor={theme().warning} padding={1} flexShrink={0}>
            <text>
              <span style={{ fg: theme().warning, bold: true }}>⚠ {pending()?.label} </span>
              <span style={{ fg: theme().textMuted }}>[y]es / [n]o</span>
            </text>
          </box>
        </Show>

        <box flexDirection="row" flexShrink={0}>
          <text>
            <span style={{ fg: theme().textMuted }}>{statusText()}</span>
          </text>
        </box>

        <box flexDirection="row" border={true} borderColor={mode() === "insert" ? theme().warning : theme().border} paddingLeft={1} paddingRight={1} flexShrink={0} height={3} gap={1}>
          <text>
            <span style={{ fg: mode() === "insert" ? theme().warning : theme().success, bold: true }}>{mode() === "insert" ? " INSERT" : " NORMAL "}</span>
          </text>
          <input
            ref={(el: InputRenderable) => { inputEl = el; focusInput(); }}
            flexGrow={1}
            placeholder={mode() === "insert" ? ":assign <id> · :exec <task> · :broadcast <msg> (Esc: normal)" : statusText() || "Press : to command · ? help · q close"}
            placeholderColor={theme().textMuted}
            cursorColor={theme().primary}
            focusedTextColor={theme().text}
            focusedBackgroundColor={theme().background}
            onInput={(v: string) => {
              if (mode() === "insert") setCommandInput(v);
              else if (inputEl?.value) inputEl.value = "";
            }}
            onKeyDown={(evt: ParsedKey) => {
              if (mode() !== "insert" && (evt.name || "").length === 1) prevent(evt);
            }}
          />
        </box>
      </box>
    </box>
  );
}

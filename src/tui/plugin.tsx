/**
 * plugin.tsx — fleet TUI plugin entry (dual v1-tui / v2-setup facade).
 *
 * v1 (opencode 1.18.x): `tui(api)` opens the FleetDashboard modal via
 * `/fleet` + `<leader>f`, owner-scoped to the calling session.
 * v2 (opencode 2.x): `setup(ctx)` maps the same dashboard (written against
 * the v1 api prop) through a minimal facade — dialog/events/theme/router —
 * per the loopd src/tui/plugin.tsx pattern. Only the calls the dashboard
 * actually makes are mapped; everything else is untouched.
 *
 * Manual controls dispatch through FleetControl (spool-only exec, 1:1 with
 * existing server tools). Server tools stay untouched in behavior.
 */

/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule, TuiThemeCurrent } from "@opencode-ai/plugin/tui";
import type { Plugin as TuiV2 } from "@opencode/plugin/tui";
import { FleetDashboard } from "./fleet-dashboard.js";

export const PLUGIN_ID = "fleet.tui";
export const FLEET_ROUTE_NAME = "fleet.dashboard";

/** Read the current session ID from a v1-shaped route (fail-closed). */
export function currentOwnerSessionID(api: unknown): string | undefined {
  try {
    const current = (
      api as unknown as { route?: { current?: { name?: string; params?: { sessionID?: string } } } }
    ).route?.current;
    if (current?.name === "session" && current.params?.sessionID) return current.params.sessionID;
  } catch {}
  return undefined;
}

const tui: TuiPlugin = async (api) => {
  const directory = api.state.path.directory;

  const open = () => {
    const previousFocus = api.renderer.currentFocusedRenderable;
    const ownerSessionID = currentOwnerSessionID(api);
    api.ui.dialog.replace(() => (
      <FleetDashboard api={api} directory={directory} ownerSessionID={ownerSessionID} />
    ));
    api.ui.dialog.setSize("xlarge");
    previousFocus?.blur();
  };

  api.keymap.registerLayer({
    commands: [
      {
        name: "opencode.fleet.dashboard",
        title: "Fleet Dashboard",
        category: "Fleet",
        namespace: "palette",
        slashName: "fleet",
        run: open,
      },
    ],
    bindings: [
      { key: "<leader>f", cmd: "opencode.fleet.dashboard", desc: "Open fleet dashboard" },
    ],
  });
};

// ─── V2 (opencode v2 TUI) ───────────────────────────────────────────────────
// The dashboard was written against the v1 api prop. Only the calls it (and
// this entry) actually make are mapped here; everything else is untouched.
// - dialog: `replace` → `show`, `setSize` → `set({ size })`; v2 `Dialog` has
//   no `open` getter, so openness is tracked locally (we own show/clear).
// - keymap: `{ name, category, namespace: "palette", slashName }` commands +
//   `{ key, cmd }` bindings → `{ id, group, palette: true, slash: { name } }`
//   commands with `bind`, activated via layer `bindings: [id]`.
// - events: v1 `session.status/error/compacted` have no v2 counterparts; the
//   dashboard only needs "something changed, refresh", mapped to the closest
//   v2 execution/compaction events.
// - theme: v2 `ResolvedTheme` is nested vs v1's flat `TuiThemeCurrent`.
export function adaptThemeV2(theme: TuiV2.Context["theme"]): TuiThemeCurrent {
  const t = (theme ?? {}) as any;
  const text = t.text ?? {};
  const fb = text.feedback ?? {};
  const bg = t.background ?? {};
  const raised = bg.raised ?? bg.surface ?? {};
  const diff = t.diff ?? {};
  const diffText = diff.text ?? {};
  const diffBg = diff.background ?? {};
  const diffHi = diff.highlight ?? {};
  const diffLn = diff.lineNumber ?? {};
  const syntax = t.syntax ?? {};
  const md = t.markdown ?? {};
  const pick = (...values: unknown[]) => values.find((value) => value !== undefined && value !== null);
  const base = pick(text.base, text.default, "#ffffff");
  const muted = pick(text.muted, text.subdued, "#888888");
  const primary = pick(t.hue?.interactive?.[200], text.formfield?.focused, text.action?.primary?.selected, base);
  const accent = pick(t.hue?.accent?.[200], text.action?.primary?.focused, primary);
  const background = pick(bg.base, bg.default, "#000000");
  return {
    text: base,
    textMuted: muted,
    primary,
    secondary: pick(t.hue?.accent?.[300], accent),
    accent,
    success: pick(fb.success?.base, fb.success?.default, "#22c55e"),
    warning: pick(fb.warning?.base, fb.warning?.default, "#eab308"),
    error: pick(fb.error?.base, fb.error?.default, "#ef4444"),
    info: pick(fb.info?.base, fb.info?.default, accent),
    selectedListItemText: pick(text.action?.primary?.focused, base),
    background,
    backgroundPanel: pick(raised.base, raised.overlay, background),
    backgroundElement: pick(raised.high, raised.offset, background),
    backgroundMenu: pick(raised.max, raised.high, background),
    border: pick(t.border?.base, muted),
    borderActive: pick(t.scrollbar?.base, primary),
    borderSubtle: pick(t.border?.base, muted),
    diffAdded: pick(diffText.added, base),
    diffRemoved: pick(diffText.removed, base),
    diffContext: pick(diffText.context, muted),
    diffHunkHeader: pick(diffText.hunkHeader, accent),
    diffAddedBg: pick(diffBg.added, background),
    diffRemovedBg: pick(diffBg.removed, background),
    diffContextBg: pick(diffBg.context, background),
    diffHighlightAdded: pick(diffHi.added, base),
    diffHighlightRemoved: pick(diffHi.removed, base),
    diffLineNumber: pick(diffLn.text, muted),
    diffAddedLineNumberBg: pick(diffLn.background?.added, background),
    diffRemovedLineNumberBg: pick(diffLn.background?.removed, background),
    syntaxComment: pick(syntax.comment, muted),
    syntaxKeyword: pick(syntax.keyword, base),
    syntaxFunction: pick(syntax.function, base),
    syntaxVariable: pick(syntax.variable, base),
    syntaxString: pick(syntax.string, base),
    syntaxNumber: pick(syntax.number, base),
    syntaxType: pick(syntax.type, base),
    syntaxOperator: pick(syntax.operator, base),
    syntaxPunctuation: pick(syntax.punctuation, muted),
    markdownText: pick(md.text, base),
    markdownHeading: pick(md.heading, primary),
    markdownLink: pick(md.link, accent),
    markdownLinkText: pick(md.linkText, accent),
    markdownCode: pick(md.code, base),
    markdownBlockQuote: pick(md.blockQuote, muted),
    markdownEmph: pick(md.emphasis, base),
    markdownStrong: pick(md.strong, base),
    markdownHorizontalRule: pick(md.horizontalRule, muted),
    markdownListItem: pick(md.listItem, accent),
    markdownListEnumeration: pick(md.listEnumeration, accent),
    markdownImage: pick(md.image, accent),
    markdownImageText: pick(md.imageText, base),
    markdownCodeBlock: pick(md.codeBlock, base),
    thinkingOpacity: 0.6,
    _hasSelectedListItemText: true,
  } as unknown as TuiThemeCurrent;
}

// v1 dashboard refresh triggers → closest v2 events ("something changed").
const REFRESH_EVENTS = [
  "session.idle",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.compaction.ended",
] as const;

const v2setup: TuiV2.Definition["setup"] = (ctx) => {
  const directory = ctx.location?.directory ?? ctx.data.location.default().directory;

  let dialogOpen = false;
  const closeDialog = () => {
    dialogOpen = false;
    ctx.ui.dialog.clear();
  };
  // Facade: fleet-dashboard.tsx was written against the v1 TuiPluginApi. Only
  // the calls it actually makes are mapped here; everything else is untouched.
  const facade = {
    theme: {
      get current() {
        return adaptThemeV2(ctx.theme);
      },
    },
    mode: {
      push: (name: string) => ctx.keymap.mode.push(name),
    },
    renderer: ctx.renderer,
    client: ctx.client,
    event: {
      on: (name: string, callback: () => void) => {
        if (name === "session.idle") return ctx.data.on("session.idle", callback);
        if (name === "session.status") {
          const unsubs = [
            ctx.data.on("session.execution.started", callback),
            ctx.data.on("session.execution.succeeded", callback),
          ];
          return () => void unsubs.forEach((un) => un());
        }
        if (name === "session.error") return ctx.data.on("session.execution.failed", callback);
        if (name === "session.compacted") return ctx.data.on("session.compaction.ended", callback);
        return ctx.data.on(name as (typeof REFRESH_EVENTS)[number], callback as () => void);
      },
    },
    ui: {
      dialog: {
        clear: closeDialog,
        get open() {
          return dialogOpen;
        },
        replace: (render: () => unknown) => {
          dialogOpen = true;
          ctx.ui.dialog.show(render as () => unknown as never);
        },
        setSize: (_size: string) => ctx.ui.dialog.set({ size: "xlarge" }),
      },
    },
    route: {
      get current() {
        const current = ctx.ui.router.current();
        return current.type === "session"
          ? { name: "session", params: { sessionID: current.sessionID } }
          : { name: current.type, params: {} };
      },
      navigate: (name: string, params?: Record<string, unknown>) => {
        if (name === "session") ctx.ui.router.navigate({ type: "session", sessionID: params?.sessionID as string });
      },
    },
  } as unknown as TuiPluginApi;

  const open = () => {
    const previousFocus = (ctx.renderer as unknown as { currentFocusedRenderable?: { blur(): void } })
      .currentFocusedRenderable;
    const ownerSessionID = (() => {
      try {
        const current = ctx.ui.router.current();
        return current.type === "session" ? current.sessionID : undefined;
      } catch {
        return undefined;
      }
    })();
    dialogOpen = true;
    ctx.ui.dialog.show(() => (
      <FleetDashboard api={facade} directory={directory} ownerSessionID={ownerSessionID} />
    ), () => {
      dialogOpen = false;
    });
    ctx.ui.dialog.set({ size: "xlarge" });
    previousFocus?.blur();
  };

  // NOTE: ctx.keymap.layer() must run inside a component — the host resolves
  // the layer against the ambient Keymap provider, so calling it in setup()
  // throws. Claim the always-mounted "app" slot with a null-render component
  // as the mount point (same pattern as loopd/telescope).
  const command = "opencode.fleet.dashboard";
  let layerRegistered = false;
  const unclaimSlot = ctx.ui.slot({
    append: "app",
    render: () => {
      if (!layerRegistered) {
        layerRegistered = true;
        ctx.keymap.layer(() => ({
          commands: [
            {
              id: command,
              title: "Fleet Dashboard",
              group: "Fleet",
              palette: true,
              slash: { name: "fleet" },
              bind: "<leader>f",
              run: open,
            },
          ],
          bindings: [command],
        }));
      }
      return null;
    },
  });

  return () => {
    closeDialog();
    unclaimSlot();
  };
};

export default {
  id: PLUGIN_ID,
  tui,
  setup: v2setup,
} satisfies TuiPluginModule & { id: string; setup: typeof v2setup };

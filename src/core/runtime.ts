/**
 * runtime.ts — runtime abstraction shared by the v1 and v2 adapters.
 *
 * Core code (registry, spool, roles/auth, tool definitions) never talks to a
 * host runtime directly; it goes through a `Runtime`. The v1 adapter backs it
 * with the v1 plugin `client` + serverUrl, the v2 adapter with the v2 plugin
 * context (see fleet-progress-V2-research.md §Decision 1).
 */

export type RuntimeKind = "v1" | "v2";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** What a runtime advertises about itself (registry endpoint descriptor). */
export interface Endpoint {
  kind: "v1-daemon" | "v2-service" | "v2-standalone" | "v2-unknown";
  /** v1: daemon serverUrl; v2: service url when known, else "". */
  url: string;
  /** Location directory for v2 (per-location plugin instance). */
  location?: string;
}

export interface PromptOptions {
  agent?: string;
  /** "provider/model" or {providerID, modelID}; runtime-specific parsing. */
  model?: unknown;
  variant?: string;
  system?: string;
}

export interface SessionInfo {
  title: string;
  agent: string;
  model: string;
  busy: boolean | null;
  idleAt: number | null;
}

export interface Runtime {
  kind: RuntimeKind;
  daemonId: string;
  selfEndpoint(): Endpoint;
  /** Inject `text` as a normal user message into a session this runtime hosts. */
  promptLocal(sessionId: string, text: string, opts?: PromptOptions): Promise<void>;
  sessionInfo(sessionId: string): Promise<SessionInfo | null>;
  log(level: LogLevel, msg: string, extra?: Record<string, unknown>): void;
  /**
   * Wait for a trailing DONE: line on a LOCALLY hosted session (poll the
   * runtime's own message surface). Null when the runtime cannot poll
   * (caller falls back to spool/remote). Never throws.
   */
  waitForDone?(sessionId: string, since: number, timeoutMs: number, signal?: AbortSignal): Promise<string | null>;
  /**
   * v1-only legacy handles consumed by the existing tool handlers
   * (FleetToolDeps). Undefined on v2: handlers then degrade to readable text.
   */
  // biome-ignore lint/suspicious/noExplicitAny: v1 plugin client is untyped at the boundary.
  client?: any;
  serverUrl?: string;
}

/** Per-call context handed to runtime-agnostic tool definitions. */
export interface CallCtx {
  sessionID: string;
  agent?: string;
  abort?: AbortSignal;
  /** Extra host-specific context fields (e.g. v1 directory/worktree). */
  [extra: string]: unknown;
}

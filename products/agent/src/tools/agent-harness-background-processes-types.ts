export interface AgentHarnessBackgroundProcessArgs {
  readonly processId?: unknown;
  readonly processSessionId?: unknown;
  readonly sessionId?: unknown;
  readonly session_id?: unknown;
  readonly action?: unknown;
  readonly processAction?: unknown;
  readonly command?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly cwd?: unknown;
  readonly timeoutMs?: unknown;
  /** 'command' (killable on timeout) or 'long_lived' (a browser, editor, or server). */
  readonly processClass?: unknown;
  /** Explicit opt-in/out of the timeout watchdog terminating this process. */
  readonly killOnTimeout?: unknown;
  readonly pty?: unknown;
  readonly data?: unknown;
  readonly fields?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
}

export type BackgroundProcessLookupSource =
  | 'processId'
  | 'processSessionId'
  | 'sessionId'
  | 'session_id'
  | 'target'
  | 'query';

export type ProcessCapabilityStatus = 'supported' | 'contract-discovered' | 'blocked-contract-gap' | 'visible-only';

export type BackgroundProcessResolution =
  | { readonly status: 'found'; readonly process: Record<string, unknown> }
  | { readonly status: 'ambiguous'; readonly input: string; readonly candidates: readonly Record<string, unknown>[] }
  | { readonly status: 'missing_lookup'; readonly usage: string };

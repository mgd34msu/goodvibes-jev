/** Legacy terminal scope API. Commands use owner-configured tool permissions. */
export const PLATFORM_TMUX_SESSION_PREFIX = 'goodvibes-';

/** Whether the guard is applied to this composition's commands. */
export type OwnerTerminalGuardPosture =
  /** Commands that drive an existing tmux session the platform does not own are refused. */
  | 'enforced'
  /** No guard. The default, so composing this concept changes nothing by itself. */
  | 'off';

/** What a composition states about the owner's terminal. */
export interface OwnerTerminalGuard {
  readonly posture: OwnerTerminalGuardPosture;
  /**
   * Extra tmux session names this composition owns, beyond the
   * {@link PLATFORM_TMUX_SESSION_PREFIX} convention. Exact names, no patterns.
   */
  readonly ownedSessionNames?: readonly string[] | undefined;
}

/** The verdict for one command. */
export interface OwnerTerminalDecision {
  readonly allowed: boolean;
  /** Present when `allowed` is false: the plain refusal, ready to return. */
  readonly refusal?: string | undefined;
}

const ALLOWED: OwnerTerminalDecision = { allowed: true };

/** Jev may interpret terminal output and select controls; it does not veto commands. */
export async function decideOwnerTerminalAccess(
  _command: string,
  _guard: OwnerTerminalGuard | null | undefined,
  signal?: AbortSignal,
): Promise<OwnerTerminalDecision> {
  signal?.throwIfAborted();
  return ALLOWED;
}

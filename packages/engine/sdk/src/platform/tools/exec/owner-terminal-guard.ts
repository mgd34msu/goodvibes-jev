/**
 * owner-terminal-guard.ts, the owner's terminal is not a surface this platform
 * types into.
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 *
 * Recorded owner doctrine: never touch tmux sessions the platform did not
 * create. This module is that rule made enforceable at the exec layer, for
 * turns that run without anyone watching: a command that INTERACTS with an
 * existing tmux session, window or pane, send-keys, kill, resize, attach,
 * respawn, rename, is refused, and the refusal names the rule.
 *
 * Creating and driving the platform's OWN tmux sessions stays allowed, because
 * that is not the owner's terminal: a session this platform made is a session
 * this platform may type into. Ownership is DECLARED by name
 * ({@link PLATFORM_TMUX_SESSION_PREFIX}), plus any names a composition
 * registers. Reading is not touching: listing sessions or capturing a pane is
 * allowed, because the platform's fleet view already reads the pane list to
 * notice externally-launched agents (runtime/fleet/observed/detect.ts).
 *
 * What a command does to a terminal is read by Jev from the raw command
 * (`engine.tools.owner-terminal`), with the owned names as state, so a wrapper
 * (`sh -c`, `env`, `xargs`, a full path), a script or `screen` is read the same
 * as a bare `tmux` call. The command runs only when it reads, with an answer
 * that acts, as acting on no existing session or as acting only on owned
 * ones; anything else refuses it. A failed reading throws.
 *
 * ── What this is not ───────────────────────────────────────────────────────
 *
 * It is not the catastrophic block, which the gate reads (gate/reading.ts,
 * repeated by exec/ast-guard.ts) and which is untouched by this file. It is not a command-class
 * policy either, class risk stays with the permission settings. It is one
 * named rule about one named tool, applied where a composition asks for it, and
 * it can only ever refuse.
 *
 * It does not reach the platform's own tmux drill-in steer
 * (runtime/fleet/observed/source.ts), which spawns tmux directly rather than
 * through the exec tool and is an affordance the owner drives himself from the
 * fleet view.
 */

import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { ownerTerminal, ownerTerminalState } from '../batteries/owner-terminal.js';

const OWNER_TERMINAL_SITE = 'tools.exec.owner-terminal';

/**
 * The name prefix that marks a tmux session as the platform's own.
 *
 * A session the platform creates is named `goodvibes-<something>`; a command
 * targeting one is a command about the platform's own workspace, not the
 * owner's terminal.
 */
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

const RULE_LINE =
  'Platform rule: the owner\'s terminal is untouchable, this platform never drives a tmux '
  + 'session, window or pane it did not create.';

function refuse(detail: string): OwnerTerminalDecision {
  return {
    allowed: false,
    refusal:
      `Command refused: ${detail}\n`
      + `${RULE_LINE}\n`
      + `Creating and driving this platform's own sessions (named `
      + `${PLATFORM_TMUX_SESSION_PREFIX}…) is allowed, and so is reading tmux state `
      + '(list-sessions, list-panes, capture-pane). Report what you found and propose '
      + "what you would do, rather than doing it in the owner's shell.",
  };
}

/**
 * Decide whether a command may run under this composition's owner-terminal
 * posture. With the guard off nothing is read; enforced, Jev reads the
 * command (`engine.tools.owner-terminal`) and it runs only when it acts on no
 * existing session, or only on owned ones, each read with an answer that acts.
 *
 * @param command - The raw shell command string, exactly as it would run.
 * @param guard - The composition's posture. `undefined` reads as `off`.
 */
export async function decideOwnerTerminalAccess(
  command: string,
  guard: OwnerTerminalGuard | null | undefined,
): Promise<OwnerTerminalDecision> {
  if (!guard || guard.posture !== 'enforced') return ALLOWED;
  const state = ownerTerminalState(command, PLATFORM_TMUX_SESSION_PREFIX, guard.ownedSessionNames ?? []);
  const run = await ownerTerminal.run(judgmentPort(OWNER_TERMINAL_SITE), state, { site: OWNER_TERMINAL_SITE });
  const { acts_on_session: acts, owned_targets: owned } = run.readings;
  const leavesSessionsAlone = acts.verdict === 'no' && acts.outcome === 'act';
  const actsOnlyOnOwned = owned.verdict === 'yes' && owned.outcome === 'act';
  const allowed = leavesSessionsAlone || actsOnlyOnOwned;
  run.recordAction(allowed ? 'ran' : 'refused');
  if (allowed) return ALLOWED;
  return refuse(
    acts.verdict === 'yes' && owned.verdict === 'no'
      ? 'it was read as changing or sending input to a terminal session, window or pane this platform did not create.'
      : "it could not be read as leaving the owner's terminal sessions alone.",
  );
}

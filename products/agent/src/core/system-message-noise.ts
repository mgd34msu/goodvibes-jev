/**
 * System-message noise policy, decides whether an operational status message
 * should reach the Recent feed / transcript unchanged, be dropped, or be folded.
 * Every noisy source these rules catch funnels through SystemMessageRouter, so
 * this one classifier is where first-run plumbing is kept out of the user's
 * stream while the information stays reachable elsewhere (activity log, /health,
 * /model, the fleet/agents surface).
 *
 * Ported from the TUI (src/core/system-message-noise.ts). The TUI regexes are
 * kept VERBATIM (provider-replay fold / agents-snapshot drop / stale-replay
 * drop); the only agent-specific addition is the `[Terminal] Captured …` rule
 * (the stdout-capture leak). Dropped noise is
 * drop-from-the-feed, NOT delete: the captured-write detail stays reachable via
 * the activity log (the terminal-output guard logs each intercept + the count).
 */

export interface NoiseGateDeps {
  /**
   * True when a WRFC chain is terminal (passed/failed) or gone (killed/removed).
   * Used to suppress stale "[Replay] … transitioned … waiting for action"
   * re-notifications for chains that can no longer act. Absent → never suppress.
   */
  readonly isChainTerminal?: (chainId: string) => boolean;
}

export type NoiseVerdict =
  /** Pass through to the feed/transcript unchanged. */
  | { readonly action: 'emit' }
  /** Suppress entirely, reachable via another live surface. */
  | { readonly action: 'drop' }
  /** Provider "from last session" replay line, buffer and fold to one line. */
  | { readonly action: 'foldProviderReplay' };

const EMIT: NoiseVerdict = { action: 'emit' };
const DROP: NoiseVerdict = { action: 'drop' };
const FOLD: NoiseVerdict = { action: 'foldProviderReplay' };

/** Matches the SDK's per-provider persisted-replay line (1b). */
const PROVIDER_REPLAY_RE = / — from last session$/;

/** Matches the SDK's 30s periodic running-agents snapshot (1d). */
const AGENTS_RUNNING_SNAPSHOT_RE = /^\[Agents\] \d+ running:/;

/** Extracts the chain id from a "[Replay]… WRFC chain <id> transitioned …" line (1c). */
const REPLAY_CHAIN_RE = /WRFC chain (\S+) transitioned .* waiting for action/;

/**
 * Matches the terminal-output guard's aggregate captured-write notice
 * (agent-specific). First-run plumbing writes a burst of direct stdout
 * that the guard intercepts and would otherwise summarize into the Recent feed;
 * the count stays reachable in the activity log, so the feed copy is dropped.
 */
const TERMINAL_CAPTURED_RE = /^\[Terminal\] Captured \d+ direct /;

/**
 * Classify one system message. Pure aside from the injected `isChainTerminal`
 * lookup, so it is trivially testable.
 */
export function classifyNoise(message: string, deps: NoiseGateDeps): NoiseVerdict {
  // Agent-specific, the terminal-output guard's aggregate captured-write notice.
  // Kept out of the Recent feed; the detail stays in the activity log.
  if (TERMINAL_CAPTURED_RE.test(message)) {
    return DROP;
  }

  // 1b, provider-discovery replay burst ("[Local] …, from last session").
  if (message.startsWith('[Local]') && PROVIDER_REPLAY_RE.test(message)) {
    return FOLD;
  }

  // 1d, periodic "[Agents] N running:" status snapshot. The same live detail
  // is shown in the fleet/agents surface and the footer count, so the periodic
  // transcript churn is dropped. Meaningful lifecycle lines ("[Agents] ✓ …",
  // "[Agents] Cohort …", "[Agents] ✗ …") do not match.
  if (AGENTS_RUNNING_SNAPSHOT_RE.test(message)) {
    return DROP;
  }

  // 1c, stale "[Replay] … waiting for action" for a terminal/killed chain.
  if (message.startsWith('[Replay]') && deps.isChainTerminal) {
    const match = REPLAY_CHAIN_RE.exec(message);
    if (match && deps.isChainTerminal(match[1])) return DROP;
  }

  return EMIT;
}

/** Provider name from a "[Local] <name> at host:port (…), from last session" line. */
export function providerNameFromReplay(message: string): string {
  const match = /^\[Local\]\s+(.+?)\s+at\s/.exec(message);
  if (match) return match[1];
  // Fallback: first token after the tag.
  const bare = /^\[Local\]\s+(\S+)/.exec(message);
  return bare ? bare[1] : 'provider';
}

/**
 * Build the single folded summary line for a burst of provider-replay lines.
 * Names a few providers; the full list stays reachable via /health and /model.
 */
export function foldProviderReplayLines(messages: readonly string[]): string {
  const names = messages.map(providerNameFromReplay);
  const count = names.length;
  const noun = count === 1 ? 'provider' : 'providers';
  const shown = names.slice(0, 3).join(', ');
  const extra = count > 3 ? `, +${count - 3} more` : '';
  return `[Local] Restored ${count} ${noun} from last session (${shown}${extra})`;
}

/**
 * Conversation-first spawn gate configuration and display helpers.
 * Semantic decisions live in daemon/batteries/conversation-gate.ts.
 *
 * Owner ruling: an inbound message, from ANY channel, gets a conversational
 * response. If it looks like it warrants a workstream, the agent PROPOSES one
 * and waits for agreement, it does not start one. Work that was already
 * agreed to (a schedule, a trigger, an on-exit chain, or a proposal the owner
 * just said yes to) was authorized when it was created and runs without
 * re-asking.
 *
 * goodvibes-tui is exempt: the operator is sitting in front of it and typed
 * the thing, so work starting is the expected outcome. TUI spawns never reach
 * this module, the gate is installed on the channel-surface adapter context
 * (see daemon/surface-actions.ts), which the TUI does not go through.
 *
 * This file is pure: no I/O, no clock beyond what callers inject. The pending
 * proposal state lives in work-proposal-store.ts; the per-surface confirmation
 * routing lives in daemon/work-proposal-reply.ts.
 */

/**
 * How the gate treats inbound channel messages.
 *
 * - 'propose'    (default) Conversation is free; work is proposed and waits
 *                for agreement over the channel it arrived on.
 * - 'confirm-all' Every inbound message that would start ANY agent run is
 *                confirmed first, including ones that read as pure chat.
 *                Maximum caution for a noisy or shared channel.
 * - 'off'        Legacy behavior: an inbound message starts work immediately.
 */
export type ConversationGateMode = 'propose' | 'confirm-all' | 'off';

const CONVERSATION_GATE_MODES: readonly ConversationGateMode[] = ['propose', 'confirm-all', 'off'];

export function isConversationGateMode(value: unknown): value is ConversationGateMode {
  return typeof value === 'string' && (CONVERSATION_GATE_MODES as readonly string[]).includes(value);
}

/**
 * Channel surfaces the gate applies to by default, every conversational
 * ingress surface the platform ships. 'webhook' is intentionally absent: a
 * generic webhook is machine-to-machine automation that was authorized when
 * the webhook was registered, so it is pre-authorized work by construction.
 */
export const CONVERSATION_GATE_DEFAULT_SURFACES: readonly string[] = [
  /**
   * Inbound mail. Listed even though the inbound-mail watcher never reaches
   * `gateSurfaceSpawn`, it is handed a purpose-built context with no way to
   * spawn anything, so the gate is not what protects it today.
   *
   * It is here because of what happens to the NEXT person. `isGatedSurface`
   * fails closed only for a surface it cannot identify: an un-annotated spawn
   * (`surfaceKind === undefined`) returns true. A known, non-TUI string like
   * `'email'` skips that branch and falls through to
   * `gatedSurfaces.includes(...)`, which was false, so an email adapter
   * written the ordinary way, passing `surface: 'email'`, would let any
   * message that reads as a work request spawn an agent immediately, skipping
   * propose-and-wait. A surface name that fails OPEN in a list whose entire
   * purpose is failing closed is a trap, and it costs one line to close.
   */
  'email',
  'ntfy',
  'telegram',
  'slack',
  'discord',
  'homeassistant',
  'google-chat',
  'signal',
  'whatsapp',
  'telephony',
  'imessage',
  'msteams',
  'bluebubbles',
  'mattermost',
  'matrix',
];

export interface ConversationGateConfig {
  readonly mode: ConversationGateMode;
  /** How long an unanswered proposal stays answerable. */
  readonly proposalTtlMs: number;
  /** Hard cap on simultaneously pending proposals across all surfaces. */
  readonly maxPendingProposals: number;
  /** Surfaces the gate applies to. Anything not listed spawns as before. */
  readonly gatedSurfaces: readonly string[];
}

export const CONVERSATION_GATE_DEFAULTS: ConversationGateConfig = {
  mode: 'propose',
  proposalTtlMs: 30 * 60_000,
  maxPendingProposals: 20,
  gatedSurfaces: CONVERSATION_GATE_DEFAULT_SURFACES,
};

/** Lower bound so a misconfigured TTL cannot make proposals unanswerable. */
const MIN_PROPOSAL_TTL_MS = 60_000;
/** Upper bound so a stale proposal cannot be answered days later. */
const MAX_PROPOSAL_TTL_MS = 24 * 60 * 60_000;
const MIN_PENDING_PROPOSALS = 1;
const MAX_PENDING_PROPOSALS = 200;

export interface ConversationGateConfigReader {
  get(key: string): unknown;
  /**
   * `gatedSurfaces` is an array, so it is not a scalar ConfigKey, it is read
   * through the category, mirroring how contract.gates is read.
   *
   * `string`, NOT the literal `'conversationGate'`. `ConfigManager.getCategory`
   * is generic over `keyof GoodVibesConfig`, and `conversationGate` joins that
   * union through a module augmentation declared in
   * config/schema-domain-conversation-gate.ts. Inside this package that
   * augmentation is always loaded, so the literal appeared to work, but a
   * CONSUMER's program only loads the declaration files its own imports reach,
   * and a consumer importing `ConfigManager` and `SharedSessionBroker` does not
   * necessarily pull that schema domain in. There, `keyof GoodVibesConfig` has
   * no `conversationGate` member and a plain ConfigManager is rejected by the
   * very interface that exists to accept it:
   *
   *   Type '"conversationGate"' is not assignable to type 'keyof GoodVibesConfig'
   *
   * which is what stopped both consumers from passing `conversationGateConfig`
   * at all. Typing the parameter as `string` makes the contract depend on no
   * augmentation. test/types/conversation-gate-config-reader.ts pins it from a
   * consumer's vantage point, resolving through the package name.
   */
  getCategory?(name: string): unknown;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Read the gate's configuration. Every value is bounded here rather than at
 * the use site, so a hand-edited config cannot produce a gate that never
 * expires a proposal or accepts an unbounded number of them.
 */
export function readConversationGateConfig(reader: ConversationGateConfigReader): ConversationGateConfig {
  const read = (key: string): unknown => {
    try {
      return reader.get(key);
    } catch {
      // An embedder with an older schema has no such key; fall back to defaults.
      return undefined;
    }
  };
  const category = (() => {
    try {
      return reader.getCategory?.('conversationGate') as Partial<ConversationGateConfig> | undefined;
    } catch {
      return undefined;
    }
  })();

  const rawMode = read('conversationGate.mode') ?? category?.mode;
  const rawTtl = read('conversationGate.proposalTtlMs') ?? category?.proposalTtlMs;
  const rawMax = read('conversationGate.maxPendingProposals') ?? category?.maxPendingProposals;
  const rawSurfaces = category?.gatedSurfaces;

  const surfaces: string[] | null = Array.isArray(rawSurfaces)
    ? (rawSurfaces as readonly unknown[]).filter(
        (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0,
      )
    : null;

  return {
    mode: isConversationGateMode(rawMode) ? rawMode : CONVERSATION_GATE_DEFAULTS.mode,
    proposalTtlMs: Number.isFinite(rawTtl)
      ? clamp(rawTtl as number, MIN_PROPOSAL_TTL_MS, MAX_PROPOSAL_TTL_MS)
      : CONVERSATION_GATE_DEFAULTS.proposalTtlMs,
    maxPendingProposals: Number.isFinite(rawMax)
      ? Math.floor(clamp(rawMax as number, MIN_PENDING_PROPOSALS, MAX_PENDING_PROPOSALS))
      : CONVERSATION_GATE_DEFAULTS.maxPendingProposals,
    gatedSurfaces: surfaces && surfaces.length > 0 ? surfaces : CONVERSATION_GATE_DEFAULTS.gatedSurfaces,
  };
}

export function isGatedSurface(config: ConversationGateConfig, surfaceKind: string | undefined): boolean {
  if (config.mode === 'off') return false;
  if (!surfaceKind) {
    // An un-annotated channel spawn. Conversation is the default, so an
    // unknown channel surface is gated rather than waved through, a new
    // adapter cannot silently opt out by forgetting to declare itself.
    return true;
  }
  if (surfaceKind === 'tui' || surfaceKind === 'local') return false;
  return config.gatedSurfaces.includes(surfaceKind);
}

/** A display-only summary. This never classifies or authorizes work. */
export function summarizeWorkRequest(text: string, maxLength = 90): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= maxLength ? collapsed : `${collapsed.slice(0, maxLength - 1).trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * The proposal message. One short line per real thing, readable on a phone
 * lock screen without expanding the notification.
 */
export function renderWorkProposalMessage(input: {
  readonly summary: string;
  readonly expiresInMs: number;
}): string {
  const minutes = Math.max(1, Math.round(input.expiresInMs / 60_000));
  return [
    `Start work on: ${input.summary}`,
    `Reply "yes" to start, "no" to skip (expires in ${minutes}m).`,
  ].join('\n');
}

export function renderProposalDeclinedMessage(summary: string): string {
  return `Skipped: ${summary}`;
}

export function renderProposalExpiredMessage(summary: string): string {
  return `That proposal expired: ${summary}. Ask again to restart it.`;
}

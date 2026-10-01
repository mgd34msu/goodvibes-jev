/**
 * presentation-bridge.ts, the semantic bridge from web UI status vocabulary
 * onto the SDK presentation contract's glyphs (@goodvibes-jev/engine/sdk/platform/presentation),
 * the same contract the TUI and agent already render through.
 *
 * HAND-WRITTEN, not generated, see src/lib/generated/presentation-tokens.ts
 * for the literal, checked-in snapshot this module reads from (produced by
 * scripts/generate-presentation-tokens.ts). This file owns the MAPPING
 * decisions; the generated module owns the raw contract DATA.
 *
 * Why a mapping layer at all, instead of repainting the web UI onto the
 * contract's own colors: the contract defines four severity buckets
 * (good / warn / bad / info, STATE_GLYPHS) plus a richer 16-key status
 * glyph vocabulary (GLYPHS.status). The web UI's own status vocabularies
 * (StatusBadge's free-text tone classification, the daemon-health axes in
 * daemon-health.ts) are HONEST, more specific labels than those four
 * buckets afford, "expiring" is genuinely more precise than "warn",
 * "Reachable" is deliberately not "Connected" (see daemon-health.ts). This
 * module keeps that wording exactly as-is and layers the CONTRACT'S GLYPH
 * on top of it, so the same visual glyph vocabulary the TUI/agent use shows
 * up here too, without inventing a wording correspondence that doesn't
 * genuinely exist.
 *
 * A webui state with no honest SDK-contract analogue is not force-fit here
 * (e.g. "unconfigured" / "status unavailable" are absent-health states, not
 * a severity level, they map to `info`, matching STATE_GLYPHS' own "this
 * isn't a fault" bucket, never to `bad`).
 */
import { CONTRACT_GLYPHS, CONTRACT_STATE_GLYPHS } from './generated/presentation-tokens';
import type { ContractStatusState } from './generated/presentation-tokens';
import type { AuthState, ConnectionState, SseState, WorkingState } from './daemon-health';
import type { MemoryTier } from './memory-governance';

export type { ContractStatusState };

/** The richer 16-key glyph vocabulary (GLYPHS.status), for a consumer that
 * wants a more specific glyph than the 4-bucket STATE_GLYPHS alias affords
 * (e.g. a "blocked" or "pending" glyph distinct from a generic "warn"). */
export type ContractGlyphKey = keyof typeof CONTRACT_GLYPHS.status;

/** Look up a specific contract status glyph by its full vocabulary key. */
export function contractGlyph(key: ContractGlyphKey): string {
  return CONTRACT_GLYPHS.status[key];
}

// ---------------------------------------------------------------------------
// StatusBadge tone <-> contract severity bucket
// ---------------------------------------------------------------------------

/** The tone bucket StatusBadge has always rendered, unchanged so its CSS
 * classes (`.badge.ok` / `.badge.warning` / `.badge.bad` / `.badge.neutral`)
 * and existing tests keep working verbatim. */
export type BadgeTone = 'ok' | 'warning' | 'bad' | 'neutral';

const BADGE_TONE_TO_CONTRACT_STATE: Record<BadgeTone, ContractStatusState> = {
  ok: 'good',
  warning: 'warn',
  bad: 'bad',
  // "neutral" webui states (unconfigured, status unavailable, idle, closed) are
  // honestly absent-health, not a severity, STATE_GLYPHS' `info` bucket is the
  // contract's own "not a fault" state, the correct analogue.
  neutral: 'info',
};

/** Classify an arbitrary status string into a BadgeTone. Hoisted verbatim
 * from StatusBadge.tsx's inline heuristic (moved here so the classification
 * is independently testable and shared with any future consumer). Provider
 * auth-freshness labels (src/lib/provider-status.ts) are part of this
 * vocabulary: 'expired' is a bad state (credentials no longer work),
 * 'expiring' a warning (still working, needs attention). 'unconfigured' and
 * 'status unavailable' intentionally fall through to neutral, neither is a
 * fault, they are honest absent/not-set-up states. */
export function classifyBadgeTone(value: string): BadgeTone {
  const normalized = value.toLowerCase();
  if (
    normalized.includes('error') ||
    normalized.includes('fail') ||
    normalized.includes('denied') ||
    normalized.includes('expired')
  ) {
    return 'bad';
  }
  if (
    normalized.includes('warn') ||
    normalized.includes('pending') ||
    normalized.includes('blocked') ||
    normalized.includes('expiring')
  ) {
    return 'warning';
  }
  if (
    normalized.includes('healthy') ||
    normalized.includes('ok') ||
    normalized.includes('ready') ||
    normalized.includes('active')
  ) {
    return 'ok';
  }
  return 'neutral';
}

/** The contract's 4-bucket glyph for a StatusBadge tone. */
export function contractGlyphForBadgeTone(tone: BadgeTone): string {
  return CONTRACT_STATE_GLYPHS[BADGE_TONE_TO_CONTRACT_STATE[tone]];
}

/** The contract severity bucket a StatusBadge tone corresponds to. */
export function contractStateForBadgeTone(tone: BadgeTone): ContractStatusState {
  return BADGE_TONE_TO_CONTRACT_STATE[tone];
}

// ---------------------------------------------------------------------------
// Daemon-health axes (StatusStrip) <-> contract severity bucket
//
// Each mapping below is a RULING, not a mechanical default, recorded so the
// next consumer doesn't have to re-derive it, and so a state with no honest
// analogue is refused (not force-fit) rather than silently guessed at.
// ---------------------------------------------------------------------------

const CONNECTION_TO_CONTRACT_STATE: Record<ConnectionState, ContractStatusState> = {
  // REACHABLE axis. connected/reconnecting/down are genuine good/warn/bad
  // severities, this is the one daemon-health axis with an exact, honest
  // 3-of-4-bucket correspondence.
  connected: 'good',
  reconnecting: 'warn',
  down: 'bad',
};

/** Contract glyph for the daemon REACHABLE axis (ConnectionState). */
export function contractGlyphForConnection(state: ConnectionState): string {
  return CONTRACT_STATE_GLYPHS[CONNECTION_TO_CONTRACT_STATE[state]];
}

/** Contract severity bucket for the daemon REACHABLE axis (ConnectionState). */
export function contractStateForConnection(state: ConnectionState): ContractStatusState {
  return CONNECTION_TO_CONTRACT_STATE[state];
}

const AUTH_TO_CONTRACT_STATE: Record<AuthState, ContractStatusState> = {
  'signed-in': 'good',
  // Being signed out is not itself a fault (mirrors the 'unconfigured' honesty
  // ruling above), it is an absent-state, not a bad one.
  'signed-out': 'info',
  unknown: 'info',
};

/** Contract severity bucket for the SIGNED-IN axis (AuthState). */
export function contractStateForAuth(state: AuthState): ContractStatusState {
  return AUTH_TO_CONTRACT_STATE[state];
}

const WORKING_TO_CONTRACT_STATE: Record<WorkingState, ContractStatusState> = {
  working: 'good',
  // Reachable + signed-in but blocked (a scope-less token) is a genuine fault
  //, the whole reason this axis exists (see daemon-health.ts's WorkingState
  // doc comment) is to catch that silently-failing case, so it maps to bad.
  blocked: 'bad',
  unknown: 'info',
};

/** Contract severity bucket for the WORKING axis (WorkingState). */
export function contractStateForWorking(state: WorkingState): ContractStatusState {
  return WORKING_TO_CONTRACT_STATE[state];
}

const SSE_TO_CONTRACT_STATE: Record<SseState, ContractStatusState> = {
  active: 'good',
  connecting: 'info',
  error: 'bad',
  // Deliberately-off is not a fault.
  disabled: 'info',
  // Streaming genuinely cannot work over the relay (a documented capability gap,
  // not a fault to fix by retrying), same "this isn't a fault" bucket as disabled.
  'relay-unsupported': 'info',
};

/** Contract severity bucket for the realtime-stream axis (SseState). */
export function contractStateForSse(state: SseState): ContractStatusState {
  return SSE_TO_CONTRACT_STATE[state];
}

// ---------------------------------------------------------------------------
// Memory pressure tier (ops.memory.get, SDK 1.9.0-dev) <-> contract severity bucket
// ---------------------------------------------------------------------------

const MEMORY_TIER_TO_CONTRACT_STATE: Record<MemoryTier, ContractStatusState> = {
  // 'normal' is a genuine good, the governor is not shedding anything.
  normal: 'good',
  // 'elevated' is the one tier between "fine" and "a real warning": still working,
  // worth a glance, not yet a fault, the contract's own "not a fault" bucket is the
  // honest analogue (matches memory-governance.ts's memoryTierBadgeClass mapping to
  // the webui's '.badge.info' tone for the same reason).
  elevated: 'info',
  high: 'warn',
  critical: 'bad',
};

/** Contract glyph for the memory-pressure tier axis (MemoryTier). */
export function contractGlyphForMemoryTier(tier: MemoryTier): string {
  return CONTRACT_STATE_GLYPHS[MEMORY_TIER_TO_CONTRACT_STATE[tier]];
}

/** Contract severity bucket for the memory-pressure tier axis (MemoryTier). */
export function contractStateForMemoryTier(tier: MemoryTier): ContractStatusState {
  return MEMORY_TIER_TO_CONTRACT_STATE[tier];
}

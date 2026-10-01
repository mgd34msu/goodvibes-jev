/**
 * compaction.ts, parse and format the SDK's compaction runtime events.
 *
 * GROUNDED: `@goodvibes-jev/engine/sdk/events/compaction` ships a real, typed
 * `CompactionEvent` discriminated union (COMPACTION_CHECK, _MICROCOMPACT,
 * _COLLAPSE, _AUTOCOMPACT, _REACTIVE, _BOUNDARY_COMMIT, _DONE, _FAILED,
 * _RESUME_REPAIR, _QUALITY_SCORE, _STRATEGY_SWITCH, and the mandatory
 * COMPACTION_RECEIPT emitted after every automatic/manual compaction). These
 * ride the 'compaction' runtime-event-bus domain (RUNTIME_EVENT_DOMAINS), which
 * the daemon relays over the raw control-plane SSE stream the same way it
 * relays 'permissions'/'fleet'/'tasks', see useRealtimeInvalidation.ts's header
 * comment for the multiplexed-stream mechanism this reuses.
 *
 * The wire type for a domain frame's payload is untyped JSON at the contracts
 * layer (RuntimeEventRecord, `{ readonly type: string } & Record<string, JsonValue>`),
 * so this module reads it defensively (asRecord/typeof guards), never trusting the
 * frame shape blindly, matching this codebase's established tolerant-read idiom
 * (src/lib/object.ts).
 *
 * No numeric context-window/token-budget value is exposed anywhere else on the
 * wire for an arbitrary remote session (checked: sessions.get/list, fleet.snapshot,
 * config.get all lack one). COMPACTION_CHECK's `tokenCount`/`threshold` pair is the
 * only SDK-provided numeric usage signal available to a remote client, and
 * COMPACTION_RECEIPT's `tokensBefore`/`tokensAfter` the only post-compaction one,
 * both consumed here, never invented.
 */

import { asRecord } from './object';

/**
 * The mandatory first line of every compaction-continuation user message
 * (SDK: `COMPACTION_HANDOFF_HEADER` in platform/core/compaction-sections).
 * Duplicated here as a literal because the SDK's platform/core barrel is not
 * a browser-safe import for the vite bundle; compaction-handoff-contract.test.ts
 * pins this copy byte-for-byte against the SDK's export.
 */
export const COMPACTION_HANDOFF_HEADER =
  'IMPORTANT: This session is not new! Context was compacted, please read the following for proper handoff so you may resume work!';

/** True when a user-role message is the compactor's continuation handoff, not typed input. */
export function isCompactionHandoffMessage(text: string): boolean {
  return text.startsWith(COMPACTION_HANDOFF_HEADER);
}

export type CompactionTrigger = 'auto' | 'manual';
export type CompactionOutcome = 'applied' | 'kept-original' | 'failed';

export interface CompactionReceipt {
  readonly sessionId: string;
  readonly trigger: CompactionTrigger;
  readonly strategy: string;
  /**
   * The strategy that was ASKED for (`behavior.compactionStrategy`), when it
   * differs from `strategy`, i.e. a fallback happened (e.g. `distiller`
   * requested, `structured` ran because the distillation was unavailable or
   * scored below the quality floor). The daemon only stamps this field on the
   * wire when a fallback actually occurred (conversation-compaction.ts:
   * `...(strategyFellBack ? { requestedStrategy } : {})`); absent when the
   * requested strategy ran as-is.
   */
  readonly requestedStrategy?: string;
  /**
   * Why the requested strategy fell back to `strategy`, when known. Only
   * present alongside a genuine fallback (same conditional-spread wire
   * behavior as `requestedStrategy`).
   */
  readonly strategyFallbackReason?: string;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly messagesBefore: number;
  readonly messagesAfter: number;
  readonly qualityScore: number;
  readonly qualityGrade: string;
  readonly lowQuality: boolean;
  readonly instructionsReinjected: boolean;
  readonly validationPassed: boolean;
  readonly outcome: CompactionOutcome;
  readonly detail?: string;
  /** Client-stamped arrival time (the wire event carries no timestamp field), used
   *  only for ordering receipts within a session, never rendered as an SDK-provided
   *  time. */
  readonly receivedAt: number;
}

export interface CompactionCheck {
  readonly sessionId: string;
  readonly tokenCount: number;
  readonly threshold: number;
  readonly receivedAt: number;
}

const OUTCOMES: readonly string[] = ['applied', 'kept-original', 'failed'];
const TRIGGERS: readonly string[] = ['auto', 'manual'];

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

function boolField(record: Record<string, unknown>, key: string): boolean {
  return record[key] === true;
}

/** Parse a raw 'compaction' domain frame into a CompactionReceipt, or null when
 *  it is not a COMPACTION_RECEIPT frame (or is malformed). */
export function parseCompactionReceipt(payload: unknown, receivedAt: number = Date.now()): CompactionReceipt | null {
  const record = asRecord(payload);
  if (record.type !== 'COMPACTION_RECEIPT') return null;
  const sessionId = stringField(record, 'sessionId');
  if (!sessionId) return null;
  const trigger = stringField(record, 'trigger');
  const outcome = stringField(record, 'outcome');
  const requestedStrategy = typeof record.requestedStrategy === 'string' ? record.requestedStrategy : undefined;
  const strategyFallbackReason = typeof record.strategyFallbackReason === 'string' ? record.strategyFallbackReason : undefined;
  return {
    sessionId,
    trigger: TRIGGERS.includes(trigger) ? (trigger as CompactionTrigger) : 'auto',
    strategy: stringField(record, 'strategy'),
    ...(requestedStrategy ? { requestedStrategy } : {}),
    ...(strategyFallbackReason ? { strategyFallbackReason } : {}),
    tokensBefore: numberField(record, 'tokensBefore'),
    tokensAfter: numberField(record, 'tokensAfter'),
    messagesBefore: numberField(record, 'messagesBefore'),
    messagesAfter: numberField(record, 'messagesAfter'),
    qualityScore: numberField(record, 'qualityScore'),
    qualityGrade: stringField(record, 'qualityGrade'),
    lowQuality: boolField(record, 'lowQuality'),
    instructionsReinjected: boolField(record, 'instructionsReinjected'),
    validationPassed: boolField(record, 'validationPassed'),
    outcome: OUTCOMES.includes(outcome) ? (outcome as CompactionOutcome) : 'failed',
    detail: typeof record.detail === 'string' ? record.detail : undefined,
    receivedAt,
  };
}

/** Parse a raw 'compaction' domain frame into a CompactionCheck (the live
 *  token-usage signal), or null when it is not a COMPACTION_CHECK frame. */
export function parseCompactionCheck(payload: unknown, receivedAt: number = Date.now()): CompactionCheck | null {
  const record = asRecord(payload);
  if (record.type !== 'COMPACTION_CHECK') return null;
  const sessionId = stringField(record, 'sessionId');
  if (!sessionId) return null;
  return {
    sessionId,
    tokenCount: numberField(record, 'tokenCount'),
    threshold: numberField(record, 'threshold'),
    receivedAt,
  };
}

/** Badge tone for a receipt's outcome, mirrors this codebase's .badge ok/warning/bad
 *  vocabulary (see FleetView's stateTone for the same pattern). */
export function outcomeTone(receipt: Pick<CompactionReceipt, 'outcome' | 'lowQuality'>): 'ok' | 'warning' | 'bad' {
  if (receipt.outcome === 'failed') return 'bad';
  if (receipt.outcome === 'kept-original' || receipt.lowQuality) return 'warning';
  return 'ok';
}

export function outcomeLabel(outcome: CompactionOutcome): string {
  if (outcome === 'applied') return 'applied';
  if (outcome === 'kept-original') return 'kept original';
  return 'failed';
}

/** Whole-percent usage against threshold, honest only when the daemon supplied
 *  both numbers (threshold > 0), never a guessed denominator. */
export function checkUsagePct(check: Pick<CompactionCheck, 'tokenCount' | 'threshold'>): number | null {
  if (check.threshold <= 0) return null;
  return Math.round((check.tokenCount / check.threshold) * 100);
}

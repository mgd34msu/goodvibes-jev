import { readFileSync } from 'node:fs';
import { logger, summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import type { PromptContextReceipt, PromptContextTurnOutcome } from './prompt-context-receipts.ts';

/**
 * Reading, parsing, and pruning the prompt-context receipt journal.
 *
 * Split out of prompt-context-receipts.ts, whose job is composing the prompt.
 * Deciding what the model sees and maintaining the audit file on disk are
 * different concerns, and the composer is the file someone opens to find out
 * what goes into a turn, it should not be half journal-keeping. The type
 * import below is erased at build time, so this module is only ever imported
 * BY the composer, never the other way around at runtime.
 */

export function isReceipt(value: unknown): value is PromptContextReceipt {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { readonly receiptId?: unknown; readonly createdAt?: unknown; readonly sequence?: unknown };
  return typeof candidate.receiptId === 'string' && typeof candidate.createdAt === 'number' && typeof candidate.sequence === 'number';
}
export function isTurnOutcome(value: unknown): value is PromptContextTurnOutcome {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as {
    readonly turnId?: unknown;
    readonly status?: unknown;
    readonly terminalEvent?: unknown;
    readonly stopReason?: unknown;
    readonly completedAt?: unknown;
    readonly receiptIds?: unknown;
  };
  return typeof candidate.turnId === 'string'
    && (candidate.status === 'completed' || candidate.status === 'error' || candidate.status === 'cancelled')
    && (candidate.terminalEvent === 'TURN_COMPLETED' || candidate.terminalEvent === 'TURN_ERROR' || candidate.terminalEvent === 'TURN_CANCEL')
    && typeof candidate.stopReason === 'string'
    && typeof candidate.completedAt === 'number'
    && Array.isArray(candidate.receiptIds);
}
export function parseReceiptLine(line: string): { readonly receipt?: PromptContextReceipt; readonly outcome?: PromptContextTurnOutcome } | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (isReceipt(parsed)) return { receipt: parsed };
    if (parsed && typeof parsed === 'object') {
      const candidate = parsed as { readonly kind?: unknown; readonly receipt?: unknown; readonly outcome?: unknown };
      if (candidate.kind === 'receipt' && isReceipt(candidate.receipt)) return { receipt: candidate.receipt };
      if (candidate.kind === 'turn_outcome' && isTurnOutcome(candidate.outcome)) return { outcome: candidate.outcome };
    }
    return null;
  } catch {
    return null;
  }
}
export interface ReceiptJournalContents {
  readonly receipts: readonly PromptContextReceipt[];
  readonly outcomes: readonly PromptContextTurnOutcome[];
  /** Lines that did not parse into an accepted shape, torn tails, zero-filled blocks. */
  readonly invalidLines: number;
  readonly bytes: number;
}
/**
 * Read the journal, dropping any line that does not parse into a shape the guards
 * accept, a crash's trailing half-line, a zero-filled block, anything. Never
 * throws: an unreadable journal degrades to "no receipts".
 */
export function readReceiptJournal(path: string): ReceiptJournalContents {
  let raw = '';
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (error) {
    logger.warn('Prompt context receipt journal could not be read; continuing with no receipts', { path, error: summarizeError(error) });
    return { receipts: [], outcomes: [], invalidLines: 0, bytes: 0 };
  }
  const lines = raw.split('\n').filter(Boolean);
  const parsed = lines.map(parseReceiptLine)
    .filter((entry): entry is NonNullable<ReturnType<typeof parseReceiptLine>> => Boolean(entry));
  return {
    receipts: parsed.map((entry) => entry.receipt).filter((receipt): receipt is PromptContextReceipt => Boolean(receipt)),
    outcomes: parsed.map((entry) => entry.outcome).filter((outcome): outcome is PromptContextTurnOutcome => Boolean(outcome)),
    invalidLines: lines.length - parsed.length,
    bytes: Buffer.byteLength(raw, 'utf-8'),
  };
}
export interface ReceiptJournalSurvivors {
  readonly receipts: readonly PromptContextReceipt[];
  readonly outcomes: readonly PromptContextTurnOutcome[];
  readonly expiredReceipts: number;
  readonly overflowReceipts: number;
  readonly droppedOutcomes: number;
}
/**
 * Apply BOTH bounds, age TTL first, then the count cap, and retire every
 * turn-outcome line whose receipt/turn no longer survives. Receipts arrive in
 * append order, so the tail is the newest set.
 */
export function selectReceiptJournalSurvivors(contents: ReceiptJournalContents, limit: number, maxAgeMs: number, now: number): ReceiptJournalSurvivors {
  // A non-finite or future createdAt is kept: a clock oddity must never read as "old enough to delete".
  const fresh = contents.receipts.filter((receipt) => !Number.isFinite(receipt.createdAt) || now - receipt.createdAt <= maxAgeMs);
  const kept = fresh.slice(-Math.max(1, limit));
  const keptReceiptIds = new Set(kept.map((receipt) => receipt.receiptId));
  const keptTurnIds = new Set(kept.map((receipt) => receipt.turnId).filter((turnId): turnId is string => Boolean(turnId)));
  const keptOutcomes = contents.outcomes.filter((outcome) => (
    keptTurnIds.has(outcome.turnId) || outcome.receiptIds.some((receiptId) => keptReceiptIds.has(receiptId))
  ));
  return {
    receipts: kept,
    outcomes: keptOutcomes,
    expiredReceipts: contents.receipts.length - fresh.length,
    overflowReceipts: fresh.length - kept.length,
    droppedOutcomes: contents.outcomes.length - keptOutcomes.length,
  };
}
export function formatReceiptJournal(survivors: ReceiptJournalSurvivors): string {
  const lines = [
    ...survivors.receipts.map((receipt) => JSON.stringify(receipt)),
    ...survivors.outcomes.map((outcome) => JSON.stringify({ kind: 'turn_outcome', outcome })),
  ];
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

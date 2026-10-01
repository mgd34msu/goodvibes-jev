/**
 * memory-consolidation-proposals.ts
 *
 * Adopts the SDK's memory.consolidation.receipts verb SHAPE (receipts +
 * pendingProposals, see the SDK's daemon-sdk/src/integration-routes.ts
 * getMemoryConsolidationReceipts handler) for this repo's memory-review
 * surface, WITHOUT going over the wire: this runtime IS the consolidation
 * scheduler's owner (services.memoryConsolidationScheduler, constructed in
 * runtime/services.ts), so the same derivation the daemon's HTTP handler
 * does, flatten every retained receipt's `proposed` array, runs directly
 * in-process. A judgment proposal (a contradiction, a cross-scope duplicate,
 * a stale-delete candidate) was previously computed and logged but reached no
 * surface a human could act on; this makes it legible (what, why) and
 * jumpable into the EXISTING review flow (`/memory review <id> <state>`,
 * handleRecallReview in input/commands/recall-review.ts) rather than adding a
 * second, parallel review mechanism.
 */
import type { MemoryConsolidationProposal, MemoryConsolidationRunReceipt } from '@goodvibes-jev/engine/sdk/platform/state';

/** The narrow scheduler slice this module needs, mirrors the SDK's memoryConsolidation route dependency shape. */
export interface ConsolidationReceiptSource {
  listReceipts(): readonly MemoryConsolidationRunReceipt[];
}

/**
 * Every proposal carried by the retained receipt ring (bounded, see
 * MemoryConsolidationScheduler's RECEIPT_RING_SIZE), newest-receipt-last, in
 * the SAME order the SDK's memory.consolidation.receipts verb returns them
 * (receipts.flatMap(r => r.proposed)), kept identical on purpose so a
 * consumer of either surface sees the same list.
 */
export function listPendingConsolidationProposals(
  source: ConsolidationReceiptSource,
): readonly MemoryConsolidationProposal[] {
  return source.listReceipts().flatMap((receipt) => receipt.proposed);
}

const PROPOSAL_KIND_LABELS: Readonly<Record<MemoryConsolidationProposal['kind'], string>> = {
  contradiction: 'contradiction',
  'cross-scope-duplicate': 'cross-scope duplicate',
  'stale-delete': 'stale, never referenced',
};

/**
 * One legible review-queue line per proposal: what kind of judgment flagged
 * it, why, which record ids it references, and the exact command that jumps
 * into the existing review flow for the first referenced id, so a proposal
 * is never just a queue entry with no story.
 */
export function formatConsolidationProposalForReview(proposal: MemoryConsolidationProposal): string {
  const kindLabel = PROPOSAL_KIND_LABELS[proposal.kind] ?? proposal.kind;
  const idList = proposal.ids.join(', ');
  const jumpId = proposal.ids[0];
  const jumpHint = jumpId ? `, review: /memory review ${jumpId} <state>` : '';
  return `  [${kindLabel}] ${idList}: ${proposal.reason}${jumpHint}`;
}

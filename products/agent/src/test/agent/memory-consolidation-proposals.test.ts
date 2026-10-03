import { describe, expect, test } from 'bun:test';
import type { MemoryConsolidationRunReceipt } from '@goodvibes-jev/engine/sdk/platform/state';
import {
  formatConsolidationProposalForReview,
  listPendingConsolidationProposals,
} from '../../agent/memory-consolidation-proposals.ts';

function receipt(overrides: Partial<MemoryConsolidationRunReceipt> = {}): MemoryConsolidationRunReceipt {
  return {
    runId: 'run-1',
    ranAt: new Date(0).toISOString(),
    trigger: 'idle',
    idle: true,
    scanned: 10,
    merged: [],
    archived: [],
    decayed: [],
    proposed: [],
    usageSignalAvailable: false,
    note: '',
    ...overrides,
  };
}

describe('listPendingConsolidationProposals', () => {
  test('flattens proposed[] across every retained receipt, in receipt order', () => {
    const source = {
      listReceipts: () => [
        receipt({
          runId: 'run-1',
          proposed: [{ kind: 'contradiction' as const, ids: ['mem-1', 'mem-2'], route: '/memory/review', reason: 'disagree on X' }],
        }),
        receipt({
          runId: 'run-2',
          proposed: [{ kind: 'cross-scope-duplicate' as const, ids: ['mem-3'], route: '/memory/review', reason: 'duplicate of mem-1' }],
        }),
      ],
    };
    const proposals = listPendingConsolidationProposals(source);
    expect(proposals).toHaveLength(2);
    expect(proposals[0]!.kind).toBe('contradiction');
    expect(proposals[1]!.kind).toBe('cross-scope-duplicate');
  });

  test('a receipt with no proposals contributes nothing', () => {
    const source = { listReceipts: () => [receipt({ proposed: [] })] };
    expect(listPendingConsolidationProposals(source)).toHaveLength(0);
  });

  test('no receipts at all -> empty list, never throws', () => {
    const source = { listReceipts: () => [] };
    expect(listPendingConsolidationProposals(source)).toHaveLength(0);
  });
});

describe('formatConsolidationProposalForReview', () => {
  test('names the kind, the reason, the referenced ids, and a jump-in review command', () => {
    const line = formatConsolidationProposalForReview({
      kind: 'contradiction',
      ids: ['mem-1', 'mem-2'],
      route: '/memory/review',
      reason: 'these two disagree about deploy cadence',
    });
    expect(line).toContain('contradiction');
    expect(line).toContain('mem-1');
    expect(line).toContain('mem-2');
    expect(line).toContain('these two disagree about deploy cadence');
    expect(line).toContain('/memory review mem-1');
  });

  test('cross-scope-duplicate and stale-delete get legible (not raw-enum) labels', () => {
    const dup = formatConsolidationProposalForReview({
      kind: 'cross-scope-duplicate',
      ids: ['mem-9'],
      route: '/memory/review',
      reason: 'duplicate across scopes',
    });
    expect(dup).toContain('cross-scope duplicate');
    expect(dup).not.toContain('cross-scope-duplicate');

    const stale = formatConsolidationProposalForReview({
      kind: 'stale-delete',
      ids: ['mem-10'],
      route: '/memory/review',
      reason: 'never referenced since creation',
    });
    expect(stale).toContain('stale, never referenced');
  });
});

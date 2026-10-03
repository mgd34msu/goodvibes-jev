import { describe, expect, test } from 'bun:test';
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentPromptContextReceiptStore, type PromptContextReceiptDraft } from '../../agent/prompt-context-receipts.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { leftoverStoreTempFiles } from '../helpers/store-temp-files.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

function withJournal<T>(fn: (journalPath: string) => T): T {
  const root = makeProjectTempDir('gv-prompt-receipt-journal');
  try {
    return fn(join(root, 'prompt-context-receipts.jsonl'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function receiptLine(sequence: number, createdAt: number): string {
  return JSON.stringify({
    receiptId: `promptctx-${sequence}`,
    createdAt,
    sequence,
    sessionId: 'session-1',
    turnId: `turn-${sequence}`,
    source: 'turn',
    provider: 'test-provider',
    model: 'test-model',
    contextWindow: 200_000,
    promptHash: 'hash',
    promptChars: 24,
    approxPromptTokens: 6,
    activeRecords: 0,
    suppressedRecords: 0,
    segments: [],
  });
}

function outcomeLine(sequence: number): string {
  return JSON.stringify({
    kind: 'turn_outcome',
    outcome: {
      turnId: `turn-${sequence}`,
      status: 'completed',
      terminalEvent: 'TURN_COMPLETED',
      stopReason: 'end_turn',
      completedAt: Date.now(),
      receiptIds: [`promptctx-${sequence}`],
    },
  });
}

function draft(turnId: string): PromptContextReceiptDraft {
  return {
    sessionId: 'session-1',
    turnId,
    source: 'turn',
    provider: 'test-provider',
    model: 'test-model',
    contextWindow: 200_000,
    promptHash: 'hash',
    promptChars: 24,
    approxPromptTokens: 6,
    activeRecords: 0,
    suppressedRecords: 0,
    segments: [],
  };
}

function journalLines(journalPath: string): readonly string[] {
  return readFileSync(journalPath, 'utf-8').split('\n').filter(Boolean);
}

describe('prompt context receipt journal housekeeping', () => {
  test('degrades a zero-byte journal to no receipts instead of throwing', () => {
    withJournal((journalPath) => {
      writeFileSync(journalPath, '');
      const store = new AgentPromptContextReceiptStore(journalPath, 10);
      expect(store.count()).toBe(0);
      expect(store.latest()).toBeNull();
    });
  });

  test('rejects a crash-truncated trailing line, serves the intact records, and rewrites the torn line away', () => {
    withJournal((journalPath) => {
      const now = Date.now();
      writeFileSync(journalPath, [
        receiptLine(1, now - 2000),
        receiptLine(2, now - 1000),
        '{"receiptId":"promptctx-3","createdAt":17530',
      ].join('\n'));

      const store = new AgentPromptContextReceiptStore(journalPath, 10);
      expect(store.count()).toBe(2);
      expect(store.latest()?.receiptId).toBe('promptctx-2');
      expect(store.get('promptctx-3')).toBeNull();

      const compaction = store.lastCompaction();
      expect(compaction?.droppedInvalidLines).toBe(1);
      expect(compaction?.rewritten).toBe(true);
      expect(journalLines(journalPath)).toHaveLength(2);
      expect(readFileSync(journalPath, 'utf-8')).not.toContain('promptctx-3');
    });
  });

  test('shrinks the journal on disk at load, keeping the newest records, and discloses what was reclaimed', () => {
    withJournal((journalPath) => {
      const now = Date.now();
      const lines = Array.from({ length: 50 }, (_, index) => receiptLine(index + 1, now - (50 - index) * 1000));
      writeFileSync(journalPath, `${lines.join('\n')}\n`);
      const bytesBefore = statSync(journalPath).size;

      const store = new AgentPromptContextReceiptStore(journalPath, 10);
      const compaction = store.lastCompaction();

      expect(compaction?.overflowReceipts).toBe(40);
      expect(compaction?.expiredReceipts).toBe(0);
      expect(compaction?.keptReceipts).toBe(10);
      expect(compaction?.rewritten).toBe(true);
      expect(compaction?.bytesBefore).toBe(bytesBefore);
      expect(compaction?.bytesReclaimed).toBeGreaterThan(0);

      const bytesAfter = statSync(journalPath).size;
      expect(bytesAfter).toBeLessThan(bytesBefore);
      expect(compaction?.bytesAfter).toBe(bytesAfter);

      const kept = journalLines(journalPath);
      expect(kept).toHaveLength(10);
      // The newest records are the ones kept.
      expect(kept[0]).toContain('"promptctx-41"');
      expect(kept[9]).toContain('"promptctx-50"');
      expect(store.latest()?.receiptId).toBe('promptctx-50');
    });
  });

  test('expires records past the age TTL while recent ones survive', () => {
    withJournal((journalPath) => {
      const now = Date.now();
      writeFileSync(journalPath, [
        receiptLine(1, now - 40 * DAY_MS),
        receiptLine(2, now - 30 * DAY_MS),
        receiptLine(3, now - 1 * DAY_MS),
      ].join('\n'));

      const store = new AgentPromptContextReceiptStore(journalPath, 100, 14 * DAY_MS);
      expect(store.lastCompaction()?.expiredReceipts).toBe(2);
      expect(store.count()).toBe(1);
      expect(store.latest()?.receiptId).toBe('promptctx-3');
      expect(journalLines(journalPath)).toHaveLength(1);
    });
  });

  test('retires turn-outcome lines whose receipt no longer survives', () => {
    withJournal((journalPath) => {
      const now = Date.now();
      writeFileSync(journalPath, [
        receiptLine(1, now - 40 * DAY_MS),
        outcomeLine(1),
        receiptLine(2, now - 1000),
        outcomeLine(2),
      ].join('\n'));

      const store = new AgentPromptContextReceiptStore(journalPath, 100, 14 * DAY_MS);
      const compaction = store.lastCompaction();
      expect(compaction?.expiredReceipts).toBe(1);
      expect(compaction?.droppedOutcomes).toBe(1);
      expect(compaction?.keptOutcomes).toBe(1);

      const remaining = readFileSync(journalPath, 'utf-8');
      expect(remaining).not.toContain('"turn-1"');
      expect(remaining).toContain('"turn-2"');
      // The surviving receipt still carries its outcome after reload.
      expect(store.latest()?.turnOutcome?.turnId).toBe('turn-2');
    });
  });

  test('compacts during a long run once the append threshold is passed, not only at startup', () => {
    withJournal((journalPath) => {
      const store = new AgentPromptContextReceiptStore(journalPath, 2, 14 * DAY_MS, 3);
      for (let index = 1; index <= 6; index += 1) store.record(draft(`turn-${index}`));

      // 6 appends with a 3-append threshold means two mid-run compactions; the
      // file is bounded by the count cap rather than growing with the run.
      expect(journalLines(journalPath).length).toBeLessThanOrEqual(2);
      expect(store.count()).toBe(2);
      expect(store.lastCompaction()?.reason).toBe('append-threshold');
      expect(store.latest()?.turnId).toBe('turn-6');
    });
  });

  test('compacting an already-compacted journal a second time changes nothing', () => {
    withJournal((journalPath) => {
      const now = Date.now();
      const lines = Array.from({ length: 20 }, (_, index) => receiptLine(index + 1, now - (20 - index) * 1000));
      writeFileSync(journalPath, `${lines.join('\n')}\n`);

      const first = new AgentPromptContextReceiptStore(journalPath, 5);
      expect(first.lastCompaction()?.rewritten).toBe(true);
      const afterFirst = readFileSync(journalPath, 'utf-8');

      const second = new AgentPromptContextReceiptStore(journalPath, 5);
      const secondCompaction = second.lastCompaction();
      expect(secondCompaction?.rewritten).toBe(false);
      expect(secondCompaction?.overflowReceipts).toBe(0);
      expect(secondCompaction?.expiredReceipts).toBe(0);
      expect(secondCompaction?.droppedInvalidLines).toBe(0);
      expect(secondCompaction?.bytesReclaimed).toBe(0);
      expect(readFileSync(journalPath, 'utf-8')).toBe(afterFirst);

      // And an explicit sweep is likewise a no-op.
      expect(second.compactNow()?.rewritten).toBe(false);
      expect(readFileSync(journalPath, 'utf-8')).toBe(afterFirst);
    });
  });

  test('leaves no compaction temp files behind', () => {
    withJournal((journalPath) => {
      const now = Date.now();
      const lines = Array.from({ length: 30 }, (_, index) => receiptLine(index + 1, now - (30 - index) * 1000));
      writeFileSync(journalPath, `${lines.join('\n')}\n`);
      const store = new AgentPromptContextReceiptStore(journalPath, 5);
      expect(store.lastCompaction()?.rewritten).toBe(true);
      expect(readFileSync(journalPath, 'utf-8').length).toBeGreaterThan(0);
      expect(leftoverStoreTempFiles(journalPath)).toEqual([]);
    });
  });
});

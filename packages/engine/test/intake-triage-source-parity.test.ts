/** Original daemon scorer/pipeline assertions, adapted to the inventoried Jev contract. */
import { describe, expect, test } from 'bun:test';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { labelToTag } from '../sdk/src/platform/intake/triage/evidence.js';
import { scoreInboxTriage } from '../sdk/src/platform/intake/triage/scorer.js';
import { enrichItemsWithTriage, readTriageMetadataBatch, runInboxTriage } from '../sdk/src/platform/intake/triage/pipeline.js';
import type { TriageInput, TriageStoredRecord, TriageStore } from '../sdk/src/platform/intake/triage/types.js';

const item = (id = 'original-fixture'): TriageInput => ({ id, surface: 'synthetic', subject: 'Synthetic message', snippet: 'Offline fixture only.' });
const recorded = (spam = .01, urgency = .01) => fakePort(name => noulAnswer(name.endsWith('spam') ? spam : urgency));
function memory() {
  const rows = new Map<string, TriageStoredRecord>();
  const reads: string[][] = [];
  let writes = 0, closes = 0;
  const store: TriageStore = {
    async readBatch(ids) { reads.push([...ids]); return new Map(rows); },
    async commit(receipts) {
      writes++;
      for (const receipt of receipts) rows.set(receipt.id, { latest: receipt,
        settled: receipt.status === 'settled' ? receipt : rows.get(receipt.id)?.settled ?? null });
    },
    async close() { closes++; },
  };
  return { store, rows, reads, writes: () => writes, closes: () => closes };
}

describe('original triage code assertions with recorded readings', () => {
  test('all three labels retain their exact provider tag spelling', () => {
    expect(labelToTag('spam')).toBe('GoodVibes/Spam');
    expect(labelToTag('priority')).toBe('GoodVibes/Priority');
    expect(labelToTag('normal')).toBe('GoodVibes/Normal');
  });

  test('spam wins a tie, stronger urgency wins, and two negative readings are normal', async () => {
    for (const [spam, urgency, label] of [[.99, .99, 'spam'], [.995, .985, 'spam'], [.985, .995, 'priority'], [.01, .01, 'normal']] as const) {
      const receipt = (await scoreInboxTriage([item()], recorded(spam, urgency).port))[0]!;
      expect(receipt.status).toBe('settled');
      if (receipt.status !== 'settled') throw new Error('Recorded decisive fixture must settle');
      expect(receipt.label).toBe(label);
      expect(receipt.tags).toEqual([labelToTag(label)]);
    }
  });

  test('replaying the same recorded readings reproduces the complete receipt', async () => {
    const first = await scoreInboxTriage([item()], recorded(.01, .99).port);
    const replay = await scoreInboxTriage([item()], recorded(.01, .99).port);
    expect(replay).toEqual(first);
  });

  test('score and both reported signals round to two decimals', async () => {
    const receipt = (await scoreInboxTriage([item()], recorded(.014, .986).port))[0]!;
    expect(receipt.status).toBe('settled');
    if (receipt.status !== 'settled') throw new Error('Recorded decisive fixture must settle');
    expect(receipt.score).toBe(.99);
    expect(receipt.signals).toEqual({ spam: .01, urgency: .99 });
  });

  test('pipeline persists every item, re-scores by ID, and reads current tags in one batch', async () => {
    const owner = memory(); const items = [item('a'), item('b')];
    await runInboxTriage(items, { store: owner.store, port: recorded(.99, .01).port });
    expect(owner.rows.size).toBe(2); expect(owner.writes()).toBe(1);
    await runInboxTriage([items[0]!], { store: owner.store, port: recorded(.01, .99).port });
    expect(owner.rows.size).toBe(2); expect(owner.writes()).toBe(2);
    const result = await readTriageMetadataBatch(items, owner.store);
    expect(result.get('a')?.label).toBe('priority');
    expect(result.get('a')?.tags).toEqual(['GoodVibes/Priority']);
    expect(result.get('b')?.label).toBe('spam');
    expect(owner.reads).toEqual([['a', 'b']]); expect(owner.closes()).toBe(0);
  });

  test('enrichment overlays matching evidence and preserves an unscored semantic item', async () => {
    const owner = memory(); const scored = item('scored'), unscored = item('unscored');
    await runInboxTriage([scored], { store: owner.store, port: recorded(.01, .99).port });
    const enriched = await enrichItemsWithTriage([scored, unscored], owner.store);
    expect(enriched[0]?.triage?.label).toBe('priority');
    expect(enriched[1]).toEqual(unscored);
    expect(owner.reads).toEqual([['scored', 'unscored']]);
  });

  test('dry run and empty pipeline/enrichment do not read, write or close borrowed storage', async () => {
    const owner = memory(); const answer = recorded();
    expect(await runInboxTriage([], { store: owner.store, port: answer.port })).toEqual([]);
    expect(await enrichItemsWithTriage([], owner.store)).toEqual([]);
    expect(answer.requests).toHaveLength(0);
    expect(await runInboxTriage([item()], { store: owner.store, port: answer.port, dryRun: true })).toHaveLength(1);
    expect(owner.reads).toEqual([]); expect(owner.writes()).toBe(0); expect(owner.closes()).toBe(0);
  });

  test('ambiguous duplicate semantic IDs refuse before judgment or storage instead of silently deduplicating', async () => {
    const owner = memory(); const answer = recorded(); const duplicate = [item(), item()];
    await expect(runInboxTriage(duplicate, { store: owner.store, port: answer.port })).rejects.toThrow();
    await expect(readTriageMetadataBatch(duplicate, owner.store)).rejects.toThrow();
    expect(answer.requests).toHaveLength(0); expect(owner.reads).toEqual([]);
    expect(owner.writes()).toBe(0); expect(owner.closes()).toBe(0);
  });
});

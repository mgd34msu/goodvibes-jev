import { describe, expect, test } from 'bun:test';
import { createGoodVibesSdk, GoodVibesSdkError } from '@goodvibes-jev/engine/sdk';
import {
  createMemoryConsolidationGateway,
  classifyConsolidationFetchError,
  type MemoryConsolidationReceiptsResult,
} from '@goodvibes-jev/engine/sdk/platform/knowledge';

const receipts: MemoryConsolidationReceiptsResult = {
  receipts: [{
    runId: 'fixture-run-1', ranAt: '2026-10-08T05:00:00.000Z', trigger: 'scheduled',
    idle: false, scanned: 5,
    merged: [{ ids: ['c', 'd'], retainedId: 'c' }],
    archived: [{ id: 'e', reason: 'Expired fact.' }],
    decayed: [{ id: 'a', previousConfidence: 80, confidence: 60 }],
    proposed: [{ kind: 'contradiction', ids: ['a', 'b'], route: '/recall review', reason: 'Conflicting claims.' }],
    usageSignalAvailable: true, note: 'Fixture retained run receipt.',
  }],
  pendingProposals: [
    { kind: 'contradiction', ids: ['a', 'b'], route: '/recall review', reason: 'Conflicting claims.' },
    { kind: 'cross-scope-duplicate', ids: ['c', 'd'], route: '/recall review', reason: 'Shared fact.' },
    { kind: 'stale-delete', ids: ['e'], route: '/recall review', reason: 'Expired fact.' },
  ],
};

describe('canonical memory consolidation receipt seam', () => {
  test('preserves unavailable reason without constructing a gateway', () => {
    expect(createMemoryConsolidationGateway({ available: false, reason: 'daemon disabled' }))
      .toEqual({ available: false, reason: 'daemon disabled' });
  });

  test('uses the typed receipt HTTP route lazily and preserves a retained run and all proposals', async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const sdk = createGoodVibesSdk({ baseUrl: 'https://fixture.invalid', fetch: async (input, init) => {
      requests.push({ url: String(input), method: init?.method ?? 'GET' });
      return Response.json(receipts);
    } });
    const resolution = createMemoryConsolidationGateway({ available: true, sdk });
    expect(requests).toEqual([]);
    if (!resolution.available) throw new Error('fixture connection must resolve');
    expect(await resolution.gateway.fetchReceipts()).toEqual(receipts);
    expect(requests).toEqual([{ url: 'https://fixture.invalid/api/memory/consolidation/receipts', method: 'GET' }]);
  });

  for (const status of [401, 403, 404, 500, 501]) {
    test(`classifies SDK ${status} while preserving caller wording`, () => {
      const error = new GoodVibesSdkError('fixture failure', { category: 'service', source: 'runtime', recoverable: false, status });
      let described: unknown;
      const result = classifyConsolidationFetchError(error, value => { described = value; return `surface ${status}`; });
      expect(described).toBe(error);
      expect(result).toEqual(status === 404 || status === 501
        ? { kind: 'unavailable', reason: `surface ${status}` }
        : { kind: 'error', message: `surface ${status}` });
    });
  }

  for (const error of [new Error('offline'), { status: 404 }, 'failed', null]) {
    test(`does not infer absent verb from an ordinary failure: ${String(error)}`, () => {
      expect(classifyConsolidationFetchError(error, () => 'unchanged wording'))
        .toEqual({ kind: 'error', message: 'unchanged wording' });
    });
  }

  test('propagates transport rejection rather than fabricating empty receipts', async () => {
    const error = new Error('offline');
    const sdk = createGoodVibesSdk({ baseUrl: 'https://fixture.invalid', fetch: async () => { throw error; } });
    const resolution = createMemoryConsolidationGateway({ available: true, sdk });
    if (!resolution.available) throw new Error('fixture connection must resolve');
    await expect(resolution.gateway.fetchReceipts()).rejects.toThrow();
  });
});

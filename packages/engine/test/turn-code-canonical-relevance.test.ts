/** Offline proofs through the real passive injection caller and canonical rerank owner. */
import { afterEach, expect, test } from 'bun:test';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort, bindJudgmentPortAuthority } from '../errors/src/index.js';
import { buildPerTurnKnowledgeInjection, type TurnCodeIndexSource } from '../sdk/src/platform/agents/turn-knowledge-injection.js';
import { rankCodeInjectionSnapshots } from '../sdk/src/platform/state/code-injection-ranking.js';
import type { CodeContextResult } from '../sdk/src/platform/state/code-index-types.js';
import type { MemoryRecord } from '../sdk/src/platform/state/memory-store.js';

let previous: ReturnType<typeof installJudgmentPort>;
let installed = false;
function use(port: Parameters<typeof installJudgmentPort>[0]) { if (!installed) { previous = installJudgmentPort(port); installed = true; } else installJudgmentPort(port); }
afterEach(() => { if (installed) installJudgmentPort(previous); installed = false; });
function hit(path: string, similarity: number): CodeContextResult {
  return { chunk: { chunkId: path, path, symbol: 'handle', kind: 'function', lang: 'ts', startLine: 1, endLine: 2, contentHash: 'hash', fileHash: 'file', mtimeMs: 1 }, similarity, distance: 2 * (1 - similarity), label: 'semantic' };
}
const irrelevant = hit('src/retry-label.ts', 0.99), relevant = hit('src/backoff.ts', 0.01);
function source(hits = [irrelevant, relevant], options: { signal?: AbortSignal; assertCurrent?: () => Promise<void>; code?: string } = {}): TurnCodeIndexSource {
  return {
    stats: () => ({ available: true, indexedChunks: hits.length, semanticRetrievalAvailable: true }),
    search: async () => hits,
    rankForInjection: (query, selected) => rankCodeInjectionSnapshots(query, selected.map(hit => ({ hit, code: options.code ?? (hit === irrelevant ? 'export const label = "Retry";' : 'await sleep(base * 2 ** attempt);') })), {
      signal: options.signal, assertCurrent: options.assertCurrent ?? (async () => {}),
    }),
  };
}
function run(codeIndex: TurnCodeIndexSource, over: Partial<Parameters<typeof buildPerTurnKnowledgeInjection>[0]> = {}) {
  return buildPerTurnKnowledgeInjection({ task: 'retry with exponential backoff', conversationTail: [], memoryRegistry: { getAll: () => [] },
    budgetTokens: 4000, relevanceFloor: 95, alreadyInjectedIds: [], turn: 1, codeInjectionEnabled: true, codeIndex, ...over });
}
test('semantic no drops a 0.99 vector neighbor, yes admits 0.01; registered owner receives source code', async () => {
  const fake = fakePort((_name, _question, state) => noulAnswer(JSON.stringify(state).includes('await sleep') ? 0.91 : 0.02)); use(fake.port);
  const result = await run(source());
  expect(result.record.injectedIds).toEqual(['src/backoff.ts:1-2']);
  expect(result.record.codeCandidatesConsidered).toBe(2);
  expect(fake.requests.every(request => request.context?.battery === 'engine.state.code-search')).toBe(true);
  expect(fake.requests).toHaveLength(2);
});
test('probability ×190 competes with memory in the existing shared budget', async () => {
  use(fakePort((_name, _question, state) => noulAnswer(typeof state === 'object' && state !== null && 'candidate' in state ? 0.9 : 0.95)).port);
  const record: MemoryRecord = { id: 'memory', scope: 'project', cls: 'fact', summary: 'retry budget', detail: undefined, tags: [], provenance: [], confidence: 90, reviewState: 'reviewed', createdAt: 1, updatedAt: 1 };
  const memoryRegistry = { getAll: () => [record] };
  const full = await run(source([irrelevant]), { memoryRegistry });
  expect(full.record.injectedIds).toEqual(['memory', 'src/retry-label.ts:1-2']);
  const tight = await run(source([irrelevant]), { memoryRegistry, budgetTokens: full.record.tokenCost - 1 });
  expect(tight.record.injectedIds).toEqual(['memory']);
  expect(tight.record.droppedForBudget).toEqual(['src/retry-label.ts:1-2']);
  const floor = await run(source([irrelevant]), { relevanceFloor: 175 }); // .9*190=171, .99*200=198
  expect(floor.block).toBeNull();
});
test('missing rank capability cannot resurrect vector confidence', async () => {
  const code = source([irrelevant]); delete code.rankForInjection;
  expect((await run(code)).record.codeInjectionSkipped).toBe('code relevance unavailable');
});
for (const [name, probability] of [['unsettled', 0.5], ['malformed', Number.NaN]] as const) {
  test(`${name} reading holds injection without vector fallback`, async () => {
    use(fakePort(() => noulAnswer(probability)).port);
    await expect(run(source([irrelevant]))).rejects.toThrow();
  });
}
test('unavailable port holds injection', async () => { use(undefined); await expect(run(source([irrelevant]))).rejects.toThrow(); });
test('port replacement during a reading invalidates authority', async () => {
  const replacement = fakePort(() => noulAnswer(0.99)).port;
  use(fakePort(() => { installJudgmentPort(replacement); return noulAnswer(0.99); }).port);
  await expect(run(source([irrelevant]))).rejects.toThrow();
});
test('generation change during a reading invalidates consumption', async () => {
  let stale = false;
  use(fakePort(() => { stale = true; return noulAnswer(0.99); }).port);
  await expect(run(source([irrelevant], { assertCurrent: async () => { if (stale) throw new Error('generation stale'); } }))).rejects.toThrow('generation stale');
});
test('canceling a pending uncooperative reading returns no injection', async () => {
  const stop = new AbortController(); const fake = fakePort(() => noulAnswer(0.99));
  use({ ...fake.port, ask: async () => { stop.abort(); return new Promise(() => {}); } });
  await expect(run(source([irrelevant], { signal: stop.signal }))).rejects.toThrow('canceled');
});
test('entire source privacy is checked before clipping or port access', async () => {
  const fake = fakePort(() => noulAnswer(0.99)); use(fake.port);
  const code = ' '.repeat(7000) + '\nAuthorization: Bearer synthetic-not-a-real-credential';
  await expect(run(source([irrelevant], { code }))).rejects.toThrow('Refused before judgment');
  expect(fake.requests).toHaveLength(0);
});
test('a later operation reads again instead of reusing authority', async () => {
  const fake = fakePort(() => noulAnswer(0.99)); use(fake.port); const code = source([irrelevant]);
  await run(code); await run(code);
  expect(fake.requests).toHaveLength(2);
});


test('restoring the same port after another installation cannot revive its reading', async () => {
  const fake = fakePort(() => noulAnswer(0.99)); use(fake.port);
  const reading = await source([irrelevant]).rankForInjection!('retry', [irrelevant]);
  installJudgmentPort(fakePort(() => noulAnswer(0.99)).port); installJudgmentPort(fake.port);
  await expect(reading.assertCurrent()).rejects.toThrow();
});
test('retiring a source authority holds a pending noncooperating port', async () => {
  const owner = new AbortController(); const fake = fakePort(() => noulAnswer(0.99));
  const port = { ...fake.port, ask: async () => { owner.abort(); return new Promise<never>(() => {}); } };
  bindJudgmentPortAuthority(port, () => ({ identity: {}, signal: owner.signal, assertCurrent() {} })); use(port);
  await expect(run(source([irrelevant]))).rejects.toThrow();
});

import { createCanonicalLiveCodeSource } from './_helpers/code-injection-readings.js';

test('real live vector source requires current policy before code enters canonical judgment', async () => {
  const fake = fakePort(() => noulAnswer(0.99)); use(fake.port);
  const live = await createCanonicalLiveCodeSource();
  try {
    await expect(run(live.store)).rejects.toThrow('current read authority');
    await expect(run(live.store, { codeAuthority: { readAccessFilter: async path => path !== live.path } })).rejects.toThrow('access-restricted');
    expect(fake.requests).toHaveLength(0);
    const result = await run(live.store, { codeAuthority: { readAccessFilter: live.readAccessFilter } });
    expect(result.record.injectedSources).toEqual(['code-index']);
    live.deny();
    await expect(result.assertCodeCurrent!()).rejects.toThrow('access-restricted');
  } finally { live.dispose(); }
});
test('real live source mutation during canonical reading cannot publish a chunk', async () => {
  const live = await createCanonicalLiveCodeSource();
  use(fakePort(() => { live.mutate(); return noulAnswer(0.99); }).port);
  try { await expect(run(live.store, { codeAuthority: { readAccessFilter: live.readAccessFilter } })).rejects.toThrow('stale'); }
  finally { live.dispose(); }
});


test('live retained authority rechecks exact intermediate-directory policy, independently of file access', async () => {
  use(fakePort(() => noulAnswer(0.99)).port);
  const live = await createCanonicalLiveCodeSource(true); let directoryAllowed = true;
  try {
    const result = await run(live.store, { codeAuthority: { readAccessFilter: async path => path !== live.directory || directoryAllowed } });
    expect(result.record.injectedSources).toEqual(['code-index']);
    directoryAllowed = false;
    await expect(result.assertCodeCurrent!()).rejects.toThrow('access-restricted');
  } finally { live.dispose(); }
});

import { afterEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import type { MemoryRecord, MemoryRegistry, MemorySemanticSearchResult, MemoryUsageStatsStore } from '@goodvibes-jev/engine/sdk/platform/state';
import { buildReviewedMemoryPrompt } from '../../agent/memory-prompt.ts';
import { composeRuntimePromptWithReceipt, type PromptContextReceiptDraft } from '../../agent/prompt-context-receipts.ts';
import { deliverAgentChannelMessage } from '../../agent/channel-delivery.ts';
import { MemoryUsageTracker } from '../../runtime/memory-usage-wiring.ts';
import { readLiveAgentMemoryCounters } from '../../input/agent-workspace-snapshot.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { createShellPathService } from '../../runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

let previous: JudgmentPort | undefined;
let installed = false;
afterEach(() => { if (installed) installJudgmentPort(previous); installed = false; });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function delayedReading(probability: number) {
  const gate = deferred<void>();
  const fake = fakePort(() => noulAnswer(probability));
  previous = installJudgmentPort({ ...fake.port, ask: async (request) => { await gate.promise; return fake.port.ask(request); } });
  installed = true;
  return gate;
}
const record = { id: 'fixture-memory', scope: 'project', cls: 'fact', summary: 'Use the fixture rollout script', detail: '', tags: [], provenance: [], confidence: 90, reviewState: 'reviewed', createdAt: 1, updatedAt: 1 } as unknown as MemoryRecord;
function registry(searchSemantic: () => Promise<unknown>) {
  return { getAll: () => [record], get: () => record, vectorStats: () => ({ enabled: true, available: true, indexedRecords: 1 }), searchSemantic } as unknown as MemoryRegistry;
}

test('prompt ranking waits for semantic results and propagates rejection', async () => {
  const reading = deferred<MemorySemanticSearchResult[]>();
  let finished = false;
  const pending = buildReviewedMemoryPrompt(registry(() => reading.promise), { turnText: 'fixture query' }).then(result => { finished = true; return result; });
  await Promise.resolve();
  expect(finished).toBe(false);
  reading.resolve([{ record, similarity: 0.9, score: 90, distance: 0.1 }]);
  expect(await pending).toContain(record.summary);
  await expect(buildReviewedMemoryPrompt(registry(async () => { throw new Error('reading unavailable'); }), { turnText: 'query' })).rejects.toThrow('reading unavailable');
});

test('prompt and receipt share exactly one async ranking', async () => {
  const root = makeProjectTempDir('agent-async-prompt');
  let calls = 0;
  const memoryRegistry = registry(async () => { calls++; return [{ record, similarity: 0.9, score: 90, distance: 0.1 }]; });
  const result = await composeRuntimePromptWithReceipt({ sessionId: 'fixture', provider: 'fixture', model: null, contextWindow: null, runtimePrompt: 'Base', tierPrompt: '', operatorPolicy: 'Policy', shellPaths: createShellPathService({ workingDirectory: root, homeDirectory: root }), memoryRegistry, turnText: 'query' });
  expect(calls).toBe(1);
  expect(result.prompt).toContain(record.summary);
  expect(result.receipt.segments.find(segment => segment.id === 'memory')?.selected?.some(entry => entry.id === record.id)).toBe(true);
});

test.each([0.99, 0.01])('delivery waits for the card reading (%s) before any router call', async (probability) => {
  const gate = delayedReading(probability);
  let delivered = 0;
  const router = { listStrategies: () => [], deliver: async () => { delivered++; return 'fixture-response'; } };
  const pending = deliverAgentChannelMessage(router, { message: 'Expires 12/30', webhook: 'https://example.test/hook' });
  await Promise.resolve();
  expect(delivered).toBe(0);
  gate.resolve();
  if (probability > 0.5) { await expect(pending).rejects.toThrow(); expect(delivered).toBe(0); }
  else { await pending; expect(delivered).toBe(1); }
});

test('unavailable card reading never reaches delivery', async () => {
  const gate = delayedReading(0.01);
  let delivered = false;
  const pending = deliverAgentChannelMessage({ listStrategies: () => [], deliver: async () => { delivered = true; return 'fixture'; } }, { message: 'Expires 12/30', webhook: 'https://example.test/hook' });
  gate.reject(new Error('fixture reading unavailable'));
  await expect(pending).rejects.toThrow('fixture reading unavailable');
  expect(delivered).toBe(false);
});

test('memory reference credit waits for the reader and is consumed once', async () => {
  const gate = delayedReading(0.99);
  const credited: string[] = [];
  const store = { recordInjected: () => {}, recordReferenced: (ids: string[]) => credited.push(...ids) } as unknown as MemoryUsageStatsStore;
  const tracker = new MemoryUsageTracker(store, registry(async () => []));
  tracker.onComposed('turn', { segments: [{ id: 'memory', selected: [{ id: record.id }] }] } as unknown as PromptContextReceiptDraft);
  const pending = tracker.onTurnCompleted('turn', 'fixture response');
  await Promise.resolve();
  expect(credited).toEqual([]);
  gate.resolve();
  await pending;
  expect(credited).toEqual([record.id]);
  await tracker.onTurnCompleted('turn', 'duplicate');
  expect(credited).toHaveLength(1);
});

test('passive counters use capped queue cardinality without launching a ranking', () => {
  const context = { clients: { agentKnowledgeApi: { memory: { getAll: () => Array.from({ length: 105 }, (_, i) => ({ ...record, id: `m${i}` })), reviewQueue: () => { throw new Error('must not rank on repaint'); } } } } } as unknown as CommandContext;
  const counters = readLiveAgentMemoryCounters(context);
  expect(counters.count).toBe(105);
  expect(counters.reviewQueueCount).toBe(100);
});

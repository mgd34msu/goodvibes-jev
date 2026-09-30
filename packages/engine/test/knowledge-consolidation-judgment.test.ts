/** Synthetic storage and explicit readings only; no provider or user state. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ConfigManager } from '../sdk/src/platform/config/manager.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { inferKnowledgeInjectionTrustTier } from '../sdk/src/platform/knowledge/shared.js';
import {
  decideKnowledgeConsolidationCandidate as decide,
  refreshKnowledgeConsolidationCandidates as refresh,
  runKnowledgeConsolidation as run,
  type KnowledgeConsolidationContext,
} from '../sdk/src/platform/knowledge/consolidation.js';
import { MemoryEmbeddingProviderRegistry, MemoryRegistry, MemoryStore } from '../sdk/src/platform/state/index.js';

const roots: string[] = [];
const memories: MemoryStore[] = [];
let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => {
  installJudgmentPort(previous);
  for (const memory of memories.splice(0)) memory.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function readings(keep = 0.97, cls = 'architecture', confidence = 0.97) {
  const fake = fakePort((name, question) => {
    if (name === 'keep') return noulAnswer(keep);
    if (name === 'memory_class') return choiceAnswer(question, cls, confidence);
    throw new Error(`Unexpected fixture question: ${name}`);
  });
  installJudgmentPort(fake.port);
  return fake;
}

async function harness() {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-consolidation-judgment-'));
  roots.push(root);
  const configManager = new ConfigManager({ configDir: join(root, 'config') });
  const memory = new MemoryStore(join(root, 'memory.sqlite'), {
    embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager }), enableVectorIndex: false,
  });
  memories.push(memory);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  await store.init();
  const context: KnowledgeConsolidationContext = { store, memoryRegistry: new MemoryRegistry(memory), syncReviewedMemory: async () => {} };
  async function source(summary = 'Persist order and outbox event in the same transaction.', count = 1) {
    const record = await store.upsertSource({ connectorId: 'url', sourceType: 'url', title: 'Outbox invariant', summary, sessionId: 'synthetic-session', tags: ['outbox'], status: 'indexed' });
    for (let i = 0; i < count; i++) await store.upsertUsageRecord({ targetKind: 'source', targetId: record.id, usageKind: 'search-hit', sessionId: 'synthetic-session', score: 1 });
    return record;
  }
  return { context, store, memory, source };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

function pauseReading(fake: ReturnType<typeof readings>) {
  const started = deferred(); const release = deferred();
  installJudgmentPort({ ...fake.port, async ask(request) {
    started.resolve(); await release.promise; return fake.port.ask(request);
  } });
  return { started: started.promise, release: release.resolve };
}

describe('knowledge consolidation reading', () => {
  test('a rarely used durable decision reaches the queue and uses its content class', async () => {
    const h = await harness(); await h.source(); const fake = readings();
    const [candidate] = await refresh(h.context);
    expect(candidate?.score).toBe(97);
    expect(candidate?.suggestedMemoryClass).toBe('architecture');
    expect(candidate?.metadata.judgmentOutcome).toBe('act');
    expect(candidate?.metadata.usageCount).toBe(1);
    expect(candidate?.evidence).toContain('used 1 time(s) in the last 30 days');
    expect(fake.requests).toHaveLength(1);
    expect(JSON.stringify(fake.requests[0]?.state)).toContain('Persist order and outbox event');
    expect(h.memory.isReady).toBe(false);
  });

  test('the complete summary is judged and retained rather than a misleading display prefix', async () => {
    const h = await harness();
    const summary = 'Historical design detail. '.repeat(20) + 'This approach is superseded; do not use it for current orders.';
    await h.source(summary); const fake = readings(); const [candidate] = await refresh(h.context);
    expect(JSON.stringify(fake.requests[0]?.state)).toContain('This approach is superseded');
    expect(candidate?.summary).toBe(summary);
  });

  test('the requested limit bounds model requests independently of worth', async () => {
    const h = await harness(); await h.source(); await h.source('Another invariant.');
    const fake = readings(0.03); expect(await refresh(h.context, 1)).toEqual([]);
    expect(fake.requests).toHaveLength(1);
  });

  test('structured source identifiers retain every colon and their exact provenance', async () => {
    const h = await harness();
    const source = await h.store.upsertSource({ id: 'source:fixture:outbox', connectorId: 'url', sourceType: 'url', title: 'Outbox invariant', summary: 'Persist order and outbox event in one transaction.', status: 'indexed' });
    await h.store.upsertUsageRecord({ targetKind: 'source', targetId: source.id, usageKind: 'search-hit' });
    readings(); await run(h.context, 'deep-consolidation', { autoPromote: true });
    expect(h.store.listConsolidationCandidates()[0]?.subjectId).toBe(source.id);
    expect(h.memory.retrieve()[0]?.provenance).toContainEqual({ kind: 'event', ref: source.id, label: 'knowledge source' });
  });

  test('high usage and relations do not override a no reading', async () => {
    const h = await harness(); await h.source('Lunch arrives in five minutes.', 30); readings(0.03, 'fact');
    const report = await run(h.context, 'deep-consolidation', { autoPromote: true });
    expect(report.metrics.acceptedCount).toBe(0);
    expect(h.store.listConsolidationCandidates()).toHaveLength(0);
    expect(h.memory.isReady).toBe(false);
  });

  test('confirm-band worth is review staging, never an unattended durable write', async () => {
    const h = await harness(); await h.source(); readings(0.75);
    await run(h.context, 'deep-consolidation', { autoPromote: true });
    const [candidate] = h.store.listConsolidationCandidates();
    expect(candidate?.status).toBe('open');
    expect(candidate?.metadata.judgmentOutcome).toBe('confirm');
    expect(h.memory.isReady).toBe(false);
    await decide(h.context, candidate!.id, 'accept', { decidedBy: 'owner', memoryClass: 'decision' });
    expect(h.memory.retrieve()[0]?.cls).toBe('decision');
    const memory = h.memory.retrieve()[0]!;
    expect(memory.reviewState).toBe('reviewed');
    expect(memory.reviewedBy).toBe('owner');
    expect(memory.reviewedAt).toBeNumber();
    expect(inferKnowledgeInjectionTrustTier(memory.reviewState)).toBe('reviewed');
    expect(h.store.getConsolidationCandidate(candidate!.id)?.metadata.decisionAuthority).toBe('operator');
  });

  test('uncertain class blocks automatic promotion even when worth acts', async () => {
    const h = await harness(); await h.source(); readings(0.97, 'architecture', 0.65);
    await run(h.context, 'deep-consolidation', { autoPromote: true });
    expect(h.store.listConsolidationCandidates()[0]?.metadata.classOutcome).toBe('confirm');
    expect(h.memory.isReady).toBe(false);
  });

  test('unsettled worth does not stage, supersede or write', async () => {
    const h = await harness(); await h.source(); readings(); const [before] = await refresh(h.context);
    readings(0.5); await run(h.context, 'deep-consolidation', { autoPromote: true });
    expect(h.store.getConsolidationCandidate(before!.id)).toEqual(before!);
    expect(h.memory.isReady).toBe(false);
  });

  test('missing and failed ports preserve state and fail visibly', async () => {
    const h = await harness(); await h.source();
    await expect(run(h.context, 'deep-consolidation', { autoPromote: true })).rejects.toThrow('No judgment port');
    const fake = readings();
    installJudgmentPort({ ...fake.port, async ask() { throw new Error('Synthetic transport unavailable'); } });
    await expect(refresh(h.context)).rejects.toThrow('Synthetic transport unavailable');
    expect(h.store.listConsolidationCandidates()).toHaveLength(0);
    expect(h.memory.isReady).toBe(false);
  });

  test('a later unavailable reading holds the entire automatic promotion batch', async () => {
    const h = await harness(); await h.source(); await h.source('A second independently observed constraint.');
    const fake = readings(); let calls = 0;
    installJudgmentPort({ ...fake.port, async ask(request) {
      if (++calls === 2) throw new Error('Synthetic later reading unavailable');
      return fake.port.ask(request);
    } });
    await expect(run(h.context, 'deep-consolidation', { autoPromote: true })).rejects.toThrow('later reading unavailable');
    expect(h.store.listConsolidationCandidates()).toHaveLength(1);
    expect(h.store.listConsolidationCandidates()[0]?.status).toBe('open');
    expect(h.memory.isReady).toBe(false);
  });

  test('source-refresh remains a review candidate rather than a memory promotion', async () => {
    const h = await harness(); const source = await h.source();
    await h.store.upsertSource({ ...source, status: 'stale' }); readings();
    await run(h.context, 'deep-consolidation', { autoPromote: true });
    expect(h.store.listConsolidationCandidates()[0]?.candidateType).toBe('source-refresh');
    expect(h.store.listConsolidationCandidates()[0]?.status).toBe('open');
    expect(h.memory.isReady).toBe(false);
  });

  test('known protected content is refused before the fake port receives it', async () => {
    const h = await harness(); await h.source('Authorization: Bearer synthetic-secret-token'); const fake = readings();
    await expect(refresh(h.context)).rejects.toThrow();
    expect(fake.requests).toHaveLength(0);
    expect(h.store.listConsolidationCandidates()).toHaveLength(0);
  });

  test('auto promotion keeps source and session provenance, and reruns are idempotent', async () => {
    const h = await harness(); const source = await h.source(); const fake = readings(0.97, 'runbook');
    await run(h.context, 'deep-consolidation', { autoPromote: true });
    const candidate = h.store.listConsolidationCandidates()[0]!;
    const memory = h.memory.retrieve()[0]!;
    expect(candidate.status).toBe('accepted');
    expect(memory.cls).toBe('runbook');
    expect(memory.provenance).toEqual(expect.arrayContaining([
      { kind: 'session', ref: source.sessionId },
      { kind: 'event', ref: source.id, label: 'knowledge source' },
      { kind: 'event', ref: candidate.id, label: 'knowledge consolidation candidate' },
    ]));
    expect(memory.confidence).toBe(97);
    expect(memory.reviewState).toBe('fresh');
    expect(memory.reviewedBy).toBeUndefined();
    expect(memory.reviewedAt).toBeUndefined();
    expect(inferKnowledgeInjectionTrustTier(memory.reviewState)).toBe('fresh');
    expect(candidate.metadata.decisionAuthority).toBe('automatic');
    await run(h.context, 'deep-consolidation', { autoPromote: true });
    await decide(h.context, candidate.id, 'accept', { decidedBy: 'later retry' });
    expect(h.memory.retrieve()).toHaveLength(1);
    expect(h.store.getConsolidationCandidate(candidate.id)).toEqual(candidate);
    expect(fake.requests).toHaveLength(1);
  });

  test('terminal history cannot fill the result limit and starve a new open candidate', async () => {
    const h = await harness(); await h.source(); readings();
    await run(h.context, 'deep-consolidation', { autoPromote: true, limit: 1 });
    const settled = h.store.listConsolidationCandidates()[0]!;
    await h.source('The billing transaction keeps its own outbox event.'); readings(0.9);
    await run(h.context, 'deep-consolidation', { autoPromote: true, limit: 1 });
    expect(h.memory.retrieve()).toHaveLength(2);
    expect(h.store.getConsolidationCandidate(settled.id)).toEqual(settled);
  });

  test('terminal operator decisions survive refresh without another model call', async () => {
    const h = await harness(); await h.source(); const fake = readings(); const [candidate] = await refresh(h.context);
    const rejected = await decide(h.context, candidate!.id, 'reject', { decidedBy: 'owner', memoryClass: 'fact' });
    installJudgmentPort(undefined);
    expect(await refresh(h.context)).toEqual([rejected]);
    expect(fake.requests).toHaveLength(1);
    expect(h.memory.isReady).toBe(false);
  });

  test('an operator decision during the reading preserves the complete terminal record', async () => {
    const h = await harness(); await h.source(); const fake = readings(); const [candidate] = await refresh(h.context);
    const paused = pauseReading(fake); const refreshing = refresh(h.context); await paused.started;
    const rejected = await decide(h.context, candidate!.id, 'reject', { decidedBy: 'owner', memoryClass: 'ownership' });
    paused.release(); await refreshing;
    expect(h.store.getConsolidationCandidate(candidate!.id)).toEqual(rejected);
  });

  test('changed content during a reading cannot authorize the new subject', async () => {
    const h = await harness(); const source = await h.source(); const paused = pauseReading(readings());
    const refreshing = refresh(h.context); await paused.started;
    await h.store.upsertSource({ ...source, summary: 'The design was superseded; this assertion is no longer true.' });
    paused.release(); expect(await refreshing).toEqual([]);
    expect(h.memory.isReady).toBe(false);
  });

  test('an explicitly accepted stale snapshot fails before memory write', async () => {
    const h = await harness(); const source = await h.source(); readings(); const [candidate] = await refresh(h.context);
    await h.store.upsertSource({ ...source, summary: 'Changed after the reading.' });
    await expect(decide(h.context, candidate!.id, 'accept')).rejects.toThrow('stale');
    expect(h.memory.isReady).toBe(false);
  });

  test('concurrent accepts serialize and create one durable record', async () => {
    const h = await harness(); await h.source(); readings(); const [candidate] = await refresh(h.context);
    const results = await Promise.all([decide(h.context, candidate!.id, 'accept'), decide(h.context, candidate!.id, 'accept')]);
    expect(results[0]?.metadata.acceptedMemoryId).toBe(results[1]?.metadata.acceptedMemoryId);
    expect(h.memory.retrieve()).toHaveLength(1);
  });

  test('retry after candidate persistence failure recovers the committed memory by provenance', async () => {
    const h = await harness(); await h.source(); readings(); const [candidate] = await refresh(h.context);
    const upsert = h.store.upsertConsolidationCandidate.bind(h.store);
    h.store.upsertConsolidationCandidate = async () => { throw new Error('Synthetic candidate save failure'); };
    await expect(decide(h.context, candidate!.id, 'accept')).rejects.toThrow('Synthetic candidate save failure');
    expect(h.memory.retrieve()).toHaveLength(1);
    h.store.upsertConsolidationCandidate = upsert;
    await decide(h.context, candidate!.id, 'accept');
    expect(h.memory.retrieve()).toHaveLength(1);
    expect(h.store.getConsolidationCandidate(candidate!.id)?.status).toBe('accepted');
  });
});

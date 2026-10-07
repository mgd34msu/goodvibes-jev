import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { KnowledgeService } from '../sdk/src/platform/knowledge/service.js';
import { buildKnowledgePacket, buildKnowledgePromptPacket, prepareKnowledgePromptPacket, readPreparedKnowledgePromptPacket,
  searchKnowledge, type KnowledgePacketContext, type PreparedKnowledgePromptPacket } from '../sdk/src/platform/knowledge/packet.js';
import { estimateTokens, renderKnowledgePacketItem } from '../sdk/src/platform/knowledge/shared.js';

const roots: string[] = [];
let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const task = 'How do I recover wireless settings?';
const text = 'Hold the recessed switch for ten seconds. Only the European variant supports recovery; the North American variant must be serviced.';
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-packet-reading-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); await store.init();
  const usage: Parameters<KnowledgePacketContext['deferUsage']>[0][] = [];
  let events = 0;
  const context: KnowledgePacketContext = { store, deferUsage: (entry) => { usage.push(entry); }, emitIfReady: () => { events++; } };
  return { store, context, usage, events: () => events };
}
async function source(store: KnowledgeStore, id: string, summary = text) {
  return store.upsertSource({ id, connectorId: 'synthetic', sourceType: 'document', title: id, summary, status: 'indexed' });
}
function readings(accepted: readonly string[], excerpt = 0.99) {
  const fake = fakePort((name, _question, state) => {
    if (name === 'excerptUseful') return noulAnswer(excerpt);
    if (name !== 'useful') throw new Error(`Unexpected packet reading ${name}`);
    return noulAnswer(accepted.includes((state as { candidate: { title: string } }).candidate.title) ? 0.99 : 0.01);
  });
  installJudgmentPort(fake.port); return fake;
}

describe('public semantic packet assembly and synchronous prepared consumption', () => {
  test('a first public lookup awaits evidence and keeps the old result payload and uncomputed score units', async () => {
    const f = await fixture(); const useful = await source(f.store, 'recovery'); await source(f.store, 'wireless settings official manual', 'Buy now.');
    const fake = readings(['recovery']);
    const pending = searchKnowledge(f.context, task, 1);
    expect(pending).toBeInstanceOf(Promise);
    const results = await pending;
    expect(results).toHaveLength(1); expect(results[0]).toMatchObject({ id: useful.id, kind: 'source', source: useful, score: 0 });
    expect(results[0]!.reason).toContain('not computed'); expect(fake.requests).toHaveLength(2);
    expect(f.usage).toHaveLength(1); expect(f.events()).toBe(0);
  });
  test('compact layout retains exact late qualifications instead of the former prefix clip', async () => {
    const f = await fixture(); const exact = `${'Recovery instructions. '.repeat(12)}${text}`;
    await source(f.store, 'recovery', exact); readings(['recovery']);
    const packet = await buildKnowledgePacket(f.context, task, [], 6, { detail: 'compact' });
    expect(packet.items[0]!.summary).toBe(exact);
    expect(packet.items[0]!.summary).toContain('must be serviced.'); expect(packet.items[0]!.evidence).toEqual([]);
    expect(packet.items[0]!.estimatedTokens).toBe(estimateTokens(renderKnowledgePacketItem(packet.items[0]!)));
  });
  test('settled empty excerpts never revive the source summary or description', async () => {
    const f = await fixture(); await source(f.store, 'recovery'); readings(['recovery'], 0.01);
    const packet = await buildKnowledgePacket(f.context, task);
    expect(packet.items).toHaveLength(1); expect(packet.items[0]!.summary).toBeUndefined(); expect(packet.items[0]!.evidence).toEqual([]);
    const prompt = await buildKnowledgePromptPacket(f.context, task);
    expect(prompt).not.toContain(text); expect(prompt).toContain('Curated Project Knowledge');
  });
  test('item-cap and token-budget omissions remain distinct and the first full item is preserved', async () => {
    const f = await fixture(); const ids = Array.from({ length: 8 }, (_, index) => `manual-${index}`);
    for (const id of ids) await source(f.store, id, 'widget calibration guide');
    readings(ids);
    const capped = await buildKnowledgePacket(f.context, 'widget', [], 2, { budgetLimit: 100_000 });
    expect(capped.items).toHaveLength(2); expect(capped.totalCandidates).toBe(8); expect(capped.droppedCount).toBe(6);
    expect(capped.droppedForBudget).toBe(0); expect(capped.budgetExhausted).toBe(false);
    const complete = await buildKnowledgePacket(f.context, 'widget', [], 50);
    expect(complete.items).toHaveLength(8); expect(complete.truncated).toBe(false);
    const budget = await buildKnowledgePacket(f.context, 'widget', [], 50, { budgetLimit: 80 });
    expect(budget.items.length).toBeGreaterThanOrEqual(1); expect(budget.budgetExhausted).toBe(true);
    expect(budget.droppedForBudget).toBeGreaterThan(0); expect(budget.droppedCount).toBeGreaterThanOrEqual(budget.droppedForBudget);
  });
  test('prepared packets are real opaque exact-request readings, reusable only while current', async () => {
    const f = await fixture(); const row = await source(f.store, 'recovery'); const fake = readings(['recovery']); const scope = ['src/radio'];
    const prepared = await prepareKnowledgePromptPacket(f.context, task, scope);
    const calls = fake.requests.length;
    const first = readPreparedKnowledgePromptPacket(prepared, task, scope);
    expect(first).toContain(text); expect(readPreparedKnowledgePromptPacket(prepared, task, [...scope])).toBe(first);
    expect(fake.requests).toHaveLength(calls);
    expect(() => readPreparedKnowledgePromptPacket({} as PreparedKnowledgePromptPacket, task, scope)).toThrow('held (malformed)');
    expect(() => readPreparedKnowledgePromptPacket(prepared, 'Other task', scope)).toThrow();
    expect(() => readPreparedKnowledgePromptPacket(prepared, task, ['other'])).toThrow();
    (row as { summary?: string }).summary = 'Changed evidence';
    expect(() => readPreparedKnowledgePromptPacket(prepared, task, scope)).toThrow();
    expect(fake.requests).toHaveLength(calls);
  });
  test('an actually settled empty packet has a handle, and new corpus membership revokes it', async () => {
    const f = await fixture();
    const prepared = await prepareKnowledgePromptPacket(f.context, task);
    expect(readPreparedKnowledgePromptPacket(prepared, task)).toBeNull();
    await source(f.store, 'later');
    expect(() => readPreparedKnowledgePromptPacket(prepared, task)).toThrow();
  });
  test('packet options changed during reading stop later dispatch and emit no success effects', async () => {
    const f = await fixture(); await source(f.store, 'one'); await source(f.store, 'two'); const fake = readings(['one', 'two']);
    const options = { budgetLimit: 720 };
    installJudgmentPort({ ...fake.port, async ask(request) { options.budgetLimit = 100; return fake.port.ask(request); } });
    await expect(buildKnowledgePacket(f.context, task, [], 6, options)).rejects.toMatchObject({ reason: 'stale' });
    expect(f.usage).toEqual([]); expect(f.events()).toBe(0); expect(fake.requests).toHaveLength(1);
  });
  test('late excerpt unavailability yields no usage, packet event or prepared handle', async () => {
    const f = await fixture(); await source(f.store, 'one'); const fake = readings(['one']);
    installJudgmentPort({ ...fake.port, async ask(request) {
      if ('excerptUseful' in request.questions) throw new Error('Owned fixture unavailable'); return fake.port.ask(request);
    } });
    await expect(prepareKnowledgePromptPacket(f.context, task)).rejects.toMatchObject({ reason: 'unavailable' });
    expect(f.usage).toEqual([]); expect(f.events()).toBe(0);
  });
  test('a caller cancellation revokes a completed handle without starting another reading', async () => {
    const f = await fixture(); await source(f.store, 'one'); const fake = readings(['one']); const controller = new AbortController();
    const prepared = await prepareKnowledgePromptPacket(f.context, task, [], 6, { signal: controller.signal });
    const calls = fake.requests.length; controller.abort();
    expect(() => readPreparedKnowledgePromptPacket(prepared, task)).toThrow(); expect(fake.requests).toHaveLength(calls);
  });
  test('an event listener queued before the public return cannot release a revoked packet', async () => {
    const f = await fixture(); const row = await source(f.store, 'one'); readings(['one']);
    const context: KnowledgePacketContext = { ...f.context, emitIfReady() {
      queueMicrotask(() => { (row as { summary?: string }).summary = 'Replacement evidence'; });
    } };
    await expect(buildKnowledgePacket(context, task)).rejects.toMatchObject({ reason: 'stale' });
  });
  test('public service wrappers capture query and packet scope before even a ready init yields', async () => {
    const f = await fixture(); await source(f.store, 'one'); const fake = readings(['one']);
    const service = { store: f.store, getPacketContext: () => f.context } as unknown as KnowledgeService;
    const input = { query: task };
    const pendingSearch = KnowledgeService.prototype.searchScoped.call(service, input);
    input.query = 'Replacement question';
    await expect(pendingSearch).rejects.toMatchObject({ reason: 'stale' });
    expect(fake.requests).toHaveLength(0);
    const scope = ['original/path'];
    const pendingPacket = KnowledgeService.prototype.preparePromptPacket.call(service, task, scope);
    scope[0] = 'replacement/path';
    await expect(pendingPacket).rejects.toMatchObject({ reason: 'stale' });
    expect(fake.requests).toHaveLength(0); expect(f.usage).toEqual([]); expect(f.events()).toBe(0);
  });
  test('public scoped search rejects request accessors without executing them', async () => {
    const f = await fixture(); let invoked = 0;
    const service = { store: f.store, getPacketContext: () => f.context } as unknown as KnowledgeService;
    await expect(KnowledgeService.prototype.searchScoped.call(service, { get query() { invoked++; return task; } })).rejects.toThrow();
    expect(invoked).toBe(0);
  });
  test('blank search remains deterministic empty input without touching protected records or needing a port', async () => {
    const f = await fixture(); await source(f.store, 'protected', 'password=synthetic-credential');
    let reads = 0;
    f.store.listSources = () => { reads++; throw new Error('Blank search must not inspect the corpus'); };
    expect(await searchKnowledge(f.context, ' \n\t ')).toEqual([]);
    expect(reads).toBe(0); expect(f.usage).toEqual([]);
    const input = { query: ' ' };
    const service = { store: f.store, getPacketContext: () => f.context } as unknown as KnowledgeService;
    const pending = KnowledgeService.prototype.searchScoped.call(service, input);
    input.query = task;
    await expect(pending).rejects.toMatchObject({ reason: 'stale' });
    expect(reads).toBe(0);
  });
});

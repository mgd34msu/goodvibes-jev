import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { createKnowledgePageSourceReader, isUsefulKnowledgePageSource, knowledgePageSourceWeight, rankKnowledgePageSources, KnowledgeSourceQualityHeldError } from '../sdk/src/platform/knowledge/source-quality.js';
import type { KnowledgeSourceRecord } from '../sdk/src/platform/knowledge/types.js';
let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
function source(id: string): KnowledgeSourceRecord {
  return { id, title: id, summary: 'A concrete documented reference.', connectorId: 'url', sourceType: 'url', status: 'indexed', tags: [], metadata: {}, createdAt: 1790726400000, updatedAt: 1790726400000 };
}
function readings(table: Record<string, { useful: number; authority?: 'official-vendor' | 'vendor' | 'secondary' | 'unverified'; confidence?: number }>) {
  const fake = fakePort((name, question, state) => {
    const title = (state as { candidate: { title: string } }).candidate.title;
    const value = table[title]; if (!value) throw new Error(`Missing source quality fixture: ${title}`);
    if (name === 'useful') return noulAnswer(value.useful);
    if (name === 'authority') return choiceAnswer(question, value.authority ?? 'secondary', value.confidence ?? 0.97);
    throw new Error(`Unexpected source quality question: ${name}`);
  }); installJudgmentPort(fake.port); return fake;
}

describe('knowledge page source quality readings', () => {
  test('pending source usefulness is read without a manual/support URL keyword prerequisite', async () => {
    const selected = { ...source('measurements'), status: 'pending' as const, canonicalUri: 'https://example.test/a', summary: 'Documented device power measurements.' };
    const fake = readings({ measurements: { useful: 0.94, authority: 'secondary' } });
    expect(await isUsefulKnowledgePageSource(selected)).toBe(true);
    expect(JSON.stringify(fake.requests)).toContain('Documented device power measurements');
    expect(JSON.stringify(fake.requests)).not.toContain('1790726400000');
  });
  test('claimed official keywords and lookup order do not override an explicit no', async () => {
    const bad = { ...source('bad'), summary: 'Official support manual specifications', metadata: { sourceDiscovery: { sourceRank: 1, trustReason: 'official-vendor-domain' } } };
    const good = source('good'); readings({ bad: { useful: 0.03, authority: 'unverified' }, good: { useful: 0.91, authority: 'secondary' } });
    expect(await rankKnowledgePageSources([bad, good])).toEqual([good]);
  });
  test('weights are measured probabilities, and repeated use shares a reading within one operation', async () => {
    const a = source('a'); const fake = readings({ a: { useful: 0.89, authority: 'vendor' } });
    const reader = createKnowledgePageSourceReader();
    const first = await reader.read(a); const ranked = await reader.rank([a]);
    expect(first.probability).toBe(0.89); expect(ranked[0]?.authority).toBe('vendor'); expect(fake.requests).toHaveLength(1);
    expect(await knowledgePageSourceWeight(a)).toBe(0.89);
    expect(fake.requests).toHaveLength(2); // A separate operation deliberately rereads.
  });
  test('an exact content change holds the operation rather than mixing source versions', async () => {
    const a = source('a'); const fake = readings({ a: { useful: 0.9 } }); const reader = createKnowledgePageSourceReader();
    await reader.read(a);
    await expect(reader.read({ ...a, summary: 'Corrected content.' })).rejects.toThrow('changed');
    expect(fake.requests).toHaveLength(1);
    await createKnowledgePageSourceReader().read({ ...a, summary: 'Corrected content.' });
    expect(fake.requests).toHaveLength(2);
  });
  test('structural failed/stale/generated exclusions and empty sets do not require a port', async () => {
    expect(await rankKnowledgePageSources([])).toEqual([]);
    expect(await rankKnowledgePageSources([{ ...source('failed'), status: 'failed' }, { ...source('stale'), status: 'stale' }])).toEqual([]);
    expect(await isUsefulKnowledgePageSource(source('generated'), { isGeneratedSource: () => true })).toBe(false);
  });
  test('usefulness or authority uncertainty holds rather than guessing a source weight', async () => {
    const a = source('a'); readings({ a: { useful: 0.65 } }); await expect(isUsefulKnowledgePageSource(a)).rejects.toBeInstanceOf(KnowledgeSourceQualityHeldError);
    readings({ a: { useful: 0.97, confidence: 0.5 } }); await expect(knowledgePageSourceWeight(a)).rejects.toBeInstanceOf(KnowledgeSourceQualityHeldError);
  });
  test('failed custom ports become a typed hold for downstream bookkeeping catches', async () => {
    const fake = readings({ a: { useful: 0.97 } }); installJudgmentPort({ ...fake.port, async ask() { throw new Error('Synthetic port unavailable'); } });
    await expect(isUsefulKnowledgePageSource(source('a'))).rejects.toBeInstanceOf(KnowledgeSourceQualityHeldError);
  });
  test('protected later candidates prevent every concurrent request in the operation', async () => {
    const fake = readings({ safe: { useful: 0.97 } });
    await expect(createKnowledgePageSourceReader().readCandidates([{ source: source('safe') }, { source: { ...source('private'), description: 'Authorization: Bearer synthetic-value' } }])).rejects.toThrow();
    expect(fake.requests).toHaveLength(0);
  });
  test('prior source text and incoming text are both protected before a candidate reading', async () => {
    const fake = readings({ safe: { useful: 0.97 } });
    await expect(createKnowledgePageSourceReader().read(source('safe'), { ...source('safe'), summary: 'api_key=synthetic' })).rejects.toThrow();
    expect(fake.requests).toHaveLength(0);
  });
  test('an aborted operation never asks the port or returns an old cached decision', async () => {
    const controller = new AbortController(); const fake = readings({ a: { useful: 0.97 } });
    const reader = createKnowledgePageSourceReader({ signal: controller.signal }); await reader.read(source('a')); controller.abort();
    await expect(reader.read(source('a'))).rejects.toThrow('cancelled'); expect(fake.requests).toHaveLength(1);
  });
  test('duplicate IDs with conflicting contents hold before reading either version', async () => {
    const a = source('a'); const fake = readings({ a: { useful: 0.97 } });
    await expect(rankKnowledgePageSources([a, { ...a, summary: 'Conflicting supplied version.' }])).rejects.toBeInstanceOf(KnowledgeSourceQualityHeldError);
    expect(fake.requests).toHaveLength(0);
  });

});

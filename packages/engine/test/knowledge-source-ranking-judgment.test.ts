import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { rankAnswerSources, KnowledgeSourceRankingHeldError } from '../sdk/src/platform/knowledge/semantic/answer-source-ranking.js';
import type { KnowledgeNodeRecord, KnowledgeSourceRecord } from '../sdk/src/platform/knowledge/types.js';
let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

function source(id: string, summary = 'A concrete source-backed procedure.'): KnowledgeSourceRecord {
  return { id, connectorId: 'url', sourceType: 'url', title: id, summary, tags: [], status: 'indexed', metadata: {}, createdAt: 0, updatedAt: 0 };
}
function readings(table: Record<string, number>) {
  const fake = fakePort((name, _question, state) => {
    if (name !== 'match') throw new Error(`Unexpected question: ${name}`);
    const title = ((state as { candidate: { title: string } }).candidate).title;
    if (!(title in table)) throw new Error(`Missing explicit source reading: ${title}`);
    return noulAnswer(table[title]!);
  });
  installJudgmentPort(fake.port); return fake;
}
const evidence = (...sources: KnowledgeSourceRecord[]) => sources.map((item, index) => ({ source: item, score: 1000 - index }));

describe('knowledge answer source ranking', () => {
  test('orders by actual support rather than retrieval points or claimed official status', async () => {
    const official = { ...source('promotional'), metadata: { sourceDiscovery: { trustReason: 'official-vendor-domain', sourceRank: 1 } } };
    const manual = source('manual'); const fake = readings({ promotional: 0.04, manual: 0.95 });
    expect((await rankAnswerSources(evidence(official, manual), [], 'How do I reset it?')).map((item) => item.id)).toEqual(['manual']);
    expect(fake.requests).toHaveLength(2);
    expect(JSON.stringify(fake.requests)).toContain('untrusted reference material');
  });
  test('preserves original records and stable exact-ID ties without duplicate candidates', async () => {
    const a = source('source:a'); const b = source('source:b'); const fake = readings({ 'source:a': 0.9, 'source:b': 0.9 });
    const result = await rankAnswerSources(evidence(b, a, a), [], 'Procedure');
    expect(result).toEqual([a, b]); expect(result[0]).toBe(a); expect(fake.requests).toHaveLength(2);
  });
  test('returns no source when every settled reading says no', async () => {
    const a = source('unrelated'); readings({ unrelated: 0.03 });
    expect(await rankAnswerSources(evidence(a), [], 'Unrepresented subject')).toEqual([]);
  });
  test('unsettled or unavailable readings do not fall back to retrieval scores', async () => {
    const a = source('unclear'); readings({ unclear: 0.65 });
    await expect(rankAnswerSources(evidence(a), [], 'Unclear query')).rejects.toBeInstanceOf(KnowledgeSourceRankingHeldError);
    installJudgmentPort(undefined);
    await expect(rankAnswerSources(evidence(a), [], 'Unclear query')).rejects.toThrow('No judgment port');
  });
  test('empty and structurally excluded sets do not need a judgment port', async () => {
    expect(await rankAnswerSources([], [], 'Anything')).toEqual([]);
    expect(await rankAnswerSources(evidence({ ...source('stale'), status: 'stale' }, { ...source('failed'), status: 'failed' }), [], 'Anything')).toEqual([]);
  });
  test('complete batch preflight prevents an earlier safe source being sent before a protected one', async () => {
    const fake = readings({ safe: 0.95 });
    await expect(rankAnswerSources(evidence(source('safe'), source('protected', 'Authorization: Bearer synthetic-secret')), [], 'Procedure')).rejects.toThrow();
    expect(fake.requests).toHaveLength(0);
  });
  test('only selected content and source-linked fact evidence reaches the reader', async () => {
    const selected = { ...source('selected'), metadata: { apiKey: 'untransmitted-synthetic-value' } };
    const fact: KnowledgeNodeRecord = { id: 'fact-1', kind: 'fact', slug: 'f', title: 'Step', summary: 'Disconnect power before opening the enclosure.', aliases: [], status: 'active', confidence: 90, sourceId: selected.id, metadata: {}, createdAt: 0, updatedAt: 0 };
    const fake = readings({ selected: 0.95 });
    await rankAnswerSources(evidence(selected), [fact, { ...fact, sourceId: 'outside', summary: 'Unrelated outside source text.' }], 'How do I open it?');
    const sent = JSON.stringify(fake.requests);
    expect(sent).toContain('Disconnect power'); expect(sent).not.toContain('Unrelated outside');
    expect(sent).not.toContain('untransmitted-synthetic-value'); expect(sent).not.toContain('createdAt');
  });
  test('source ranking includes the actual excerpt rather than only its generic title', async () => {
    const selected = source('manual', 'Hardware manual.'); const fake = readings({ manual: 0.95 });
    await rankAnswerSources([{ source: selected, score: 1, excerpt: 'Hold the reset switch for ten seconds.' }], [], 'How long should I hold reset?');
    expect(JSON.stringify(fake.requests[0]?.state)).toContain('Hold the reset switch for ten seconds.');
  });

  test('real evidence excludes generated projections when both are present', async () => {
    const real = source('real'); const generated = { ...source('projection'), metadata: { generatedProjection: true } };
    const fake = readings({ real: 0.95 });
    expect(await rankAnswerSources(evidence(generated, real), [], 'Procedure')).toEqual([real]);
    expect(fake.requests).toHaveLength(1);
  });
  test('the explicit 50-source request budget caps work without ranking by a guessed score', async () => {
    const sources = Array.from({ length: 55 }, (_, index) => source(`source-${String.fromCharCode(65 + index)}`));
    const fake = readings(Object.fromEntries(sources.map((item) => [item.title!, 0.9])));
    expect(await rankAnswerSources(evidence(...sources), [], 'Procedure')).toHaveLength(50);
    expect(fake.requests).toHaveLength(50);
  });
});

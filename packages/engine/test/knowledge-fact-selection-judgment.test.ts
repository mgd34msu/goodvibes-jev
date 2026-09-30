import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { filterFactsForQuery, hasFeatureIntentForQuery, renderFactForPrompt, KnowledgeFactSelectionHeldError } from '../sdk/src/platform/knowledge/semantic/answer-fact-selection.js';
import type { KnowledgeNodeRecord } from '../sdk/src/platform/knowledge/types.js';
let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
function fact(id: string, summary: string, metadata: Record<string, unknown> = {}): KnowledgeNodeRecord {
  return { id, kind: 'fact', slug: id, title: id, summary, aliases: [], status: 'active', confidence: 90, metadata, createdAt: 0, updatedAt: 0 };
}
function readings(table: Record<string, number>, featureProbability = 0.97) {
  const fake = fakePort((name, _question, state) => {
    if (name === 'features') return noulAnswer(featureProbability);
    if (name !== 'match') throw new Error(`Unexpected fixture question: ${name}`);
    const title = (state as { candidate: { title: string } }).candidate.title;
    if (!(title in table)) throw new Error(`Missing fact fixture: ${title}`);
    return noulAnswer(table[title]!);
  }); installJudgmentPort(fake.port); return fake;
}

describe('knowledge fact selection readings', () => {
  test('selects maintenance evidence when asked, despite old feature keyword intent', async () => {
    const ports = fact('ports', 'The display has four HDMI ports.', { factKind: 'feature', extractor: 'llm', sourceAuthority: 'official-vendor' });
    const repair = fact('repair', 'Disconnect power before cleaning the filter.', { factKind: 'maintenance', extractor: 'deterministic' });
    const fake = readings({ ports: 0.03, repair: 0.95 });
    expect(await filterFactsForQuery('How do I maintain the air-filter feature?', [ports, repair])).toEqual([repair]);
    expect(fake.requests).toHaveLength(2);
  });
  test('orders selected facts by returned support rather than extractor/authority points', async () => {
    const a = fact('a', 'Broad content.', { extractor: 'llm', sourceAuthority: 'official-vendor' });
    const b = fact('b', 'Specific answer.', { extractor: 'deterministic' }); readings({ a: 0.8, b: 0.97 });
    expect(await filterFactsForQuery('Specific question', [a, b])).toEqual([b, a]);
  });
  test('query intent follows the explicit reading rather than feature words', async () => {
    readings({}, 0.03); expect(await hasFeatureIntentForQuery('Disable the feature following this procedure')).toBe(false);
    readings({}, 0.97); expect(await hasFeatureIntentForQuery('Can it play music in two rooms?')).toBe(true);
  });
  test('no and uncertainty remain distinct, and unavailable does not recover old points', async () => {
    const a = fact('a', 'A fact.'); readings({ a: 0.03 }); expect(await filterFactsForQuery('Other subject', [a])).toEqual([]);
    readings({ a: 0.65 }); await expect(filterFactsForQuery('Ambiguous', [a])).rejects.toBeInstanceOf(KnowledgeFactSelectionHeldError);
    readings({}, 0.5); await expect(hasFeatureIntentForQuery('Ambiguous')).rejects.toBeInstanceOf(KnowledgeFactSelectionHeldError);
    installJudgmentPort(undefined); await expect(filterFactsForQuery('Anything', [a])).rejects.toThrow('No judgment port');
  });
  test('stale and empty candidate sets need no port', async () => {
    expect(await filterFactsForQuery('Anything', [])).toEqual([]);
    expect(await filterFactsForQuery('Anything', [{ ...fact('stale', 'Historical fact.'), status: 'stale' }])).toEqual([]);
  });
  test('a protected candidate prevents all concurrent batch requests', async () => {
    const fake = readings({ a: 0.97 });
    await expect(filterFactsForQuery('Question', [fact('a', 'Normal text.'), fact('b', 'Normal text.', { evidence: 'Authorization: Bearer synthetic-secret' })])).rejects.toThrow();
    expect(fake.requests).toHaveLength(0);
  });
  test('rendering preserves source evidence even when it contains former blacklist words', () => {
    const entry = fact('warranty', 'The filter is under warranty.', { evidence: 'Included accessories have a two-year warranty.' });
    expect(renderFactForPrompt(entry)).toContain('Included accessories have a two-year warranty.');
  });
});

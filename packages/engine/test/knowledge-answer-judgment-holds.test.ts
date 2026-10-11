import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { EntryType, JudgmentPort, Question } from '@goodvibes-jev/judgment';
import { fakePort, choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { KnowledgeSemanticService } from '../sdk/src/platform/knowledge/semantic/service.js';
import { knowledgeScopeSelection } from '../sdk/src/platform/knowledge/batteries/scope-selection.js';
import { answerFactRerank } from '../sdk/src/platform/knowledge/semantic/ranking/fact-rerank.js';
const roots: string[] = [];
let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function scopedManualFixtures(entries: readonly { title: string; summary: string; factTitle: string; value?: string; sections?: string[] }[]) {
  const sources = entries.map(({ title, summary, sections = [] }) => ({ kind: 'source', content: { title, summary, sourceType: 'manual', tags: [], meaning: {},
    extraction: { summary, format: 'text', sections, structure: { searchText: summary } } } }));
  return entries.flatMap(({ summary, factTitle, value }, index) => [
    { view: 'ordinary', candidate: sources[index], related: [], associations: { outsideRequestedScope: false } },
    { view: 'ordinary', candidate: { kind: 'node', content: { title: factTitle, summary, kind: 'fact', aliases: [],
      meaning: { semanticKind: 'fact', factKind: 'specification', ...(value ? { value } : {}), evidence: summary } } },
      related: [sources[index]], associations: { outsideRequestedScope: false } },
  ]);
}
function readScopeFixture(name: string, question: Question, state: EntryType,
  fixtures: ReturnType<typeof scopedManualFixtures>) {
  if (name !== 'included') return undefined;
  if (question.type !== 'noul' || question.instructions !== knowledgeScopeSelection.items.included.question.instructions
    || !fixtures.some(fixture => isDeepStrictEqual(fixture, state))) throw new Error('Unknown complete manual scope fixture');
  return noulAnswer(0.99);
}

describe('answer judgment holds before generation or repair writes', () => {
  for (const mode of ['missing', 'failed', 'uncertain'] as const) {
    test(`${mode} fact reading preserves stored knowledge and does not spend on synthesis`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'goodvibes-answer-hold-')); roots.push(root);
      const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
      const source = await store.upsertSource({ id: 'manual-fixture', connectorId: 'manual', sourceType: 'manual', title: 'Router HDMI inputs', summary: 'The router has four HDMI inputs.', status: 'indexed' });
      await store.upsertExtraction({ sourceId: source.id, extractorId: 'synthetic', format: 'text', summary: 'The router has four HDMI inputs.', sections: ['Inputs'], structure: { searchText: 'The router has four HDMI inputs.' } });
      const seedPort = installJudgmentPort(fakePort((name) => { if (name !== 'serve') throw new Error('Unexpected seed reading'); return noulAnswer(0.99); }).port);
      await store.upsertNode({ kind: 'fact', slug: 'hdmi-inputs', title: 'HDMI inputs', summary: 'The router has four HDMI inputs.', status: 'active', sourceId: source.id, metadata: { semanticKind: 'fact', factKind: 'specification', sourceIds: [source.id], value: 'four HDMI inputs', evidence: 'The router has four HDMI inputs.' } });
      installJudgmentPort(seedPort);
      const before = { sources: store.listSources(), nodes: store.listNodes(), edges: store.listEdges(), issues: store.listIssues() };
      let synthesisCalls = 0;
      const service = new KnowledgeSemanticService(store, { llm: {
        async completeJson() { synthesisCalls += 1; return null; }, async completeText() { synthesisCalls += 1; return null; },
      } });
      let factReadings: ReturnType<typeof fakePort> | undefined;
      if (mode !== 'missing') {
        const scopes = scopedManualFixtures([{ title: 'Router HDMI inputs', summary: 'The router has four HDMI inputs.', factTitle: 'HDMI inputs', value: 'four HDMI inputs', sections: ['Inputs'] }]);
        const fake = fakePort((name, question, state) => {
          const scoped = readScopeFixture(name, question, state, scopes);
          if (scoped !== undefined) return scoped;
          if (name === 'useful' && ['Router HDMI inputs', 'HDMI inputs'].includes((state as { candidate?: { title?: string } }).candidate?.title ?? ''))
            return noulAnswer(0.99); // Initial relevance settles before the tested fact-reading hold.
          if (name === 'excerptUseful') return noulAnswer(0.01); // Unselected spans cannot bypass the barrier under test.
          if (name === 'features') return noulAnswer(0.97);
          if (name === 'match') {
            if (mode === 'failed') throw new Error('Synthetic unavailable fact reader');
            return noulAnswer(0.5);
          }
          throw new Error(`Unknown HDMI hold fixture question: ${name}`);
        }); factReadings = fake; installJudgmentPort(fake.port);
      }
      await expect(service.answer({ query: 'How many HDMI inputs does the router have?', candidateSourceIds: [source.id], strictCandidates: true })).rejects.toThrow();
      if (factReadings) expect(factReadings.requests.some(request => request.context?.battery === answerFactRerank.name)).toBe(true);
      expect(synthesisCalls).toBe(0);
      expect({ sources: store.listSources(), nodes: store.listNodes(), edges: store.listEdges(), issues: store.listIssues() }).toEqual(before);
    });
  }
  test('a rejected source is not re-added by claimed authority or shown to the generation model', async () => {
    const root = mkdtempSync(join(tmpdir(), 'goodvibes-answer-source-')); roots.push(root);
    const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
    const seedPort = installJudgmentPort(fakePort((name) => { if (name !== 'serve') throw new Error('Unexpected seed reading'); return noulAnswer(0.99); }).port);
    for (const [id, title, detail] of [['rejected', 'Rejected official manual', 'HDMI inputs include the unsupported purple marker.'], ['accepted', 'Accepted manual', 'HDMI inputs include four supported connectors.']] as const) {
      await store.upsertSource({ id, connectorId: 'manual', sourceType: 'manual', title, summary: detail, status: 'indexed', metadata: { sourceDiscovery: { trustReason: 'official-vendor-domain' } } });
      await store.upsertExtraction({ sourceId: id, extractorId: 'synthetic', format: 'text', summary: detail, structure: { searchText: detail } });
      await store.upsertNode({ kind: 'fact', slug: id, title, summary: detail, status: 'active', sourceId: id, metadata: { semanticKind: 'fact', factKind: 'specification', sourceIds: [id], evidence: detail } });
    }
    installJudgmentPort(seedPort);
    const prompts: string[] = [];
    const service = new KnowledgeSemanticService(store, { llm: {
      async completeJson() { throw new Error("No answer JSON generation"); }, async completeText(input) { prompts.push(input.prompt); return null; },
    } });
    const scopes = scopedManualFixtures([
      { title: 'Rejected official manual', summary: 'HDMI inputs include the unsupported purple marker.', factTitle: 'Rejected official manual' },
      { title: 'Accepted manual', summary: 'HDMI inputs include four supported connectors.', factTitle: 'Accepted manual' },
    ]);
    const fixtureReadings = fakePort((name, question, state) => {
      const scoped = readScopeFixture(name, question, state, scopes);
      if (scoped !== undefined) return scoped;
      if (name === 'fidelity') return choiceAnswer(question, 'supported', 0.97);
      if (name === 'enough' || name === 'complete') return noulAnswer(0.97);
      if (name === 'excerptUseful') return noulAnswer(0.01); // Unselected spans cannot bypass the barrier under test.
    if (name === 'features') return noulAnswer(0.97);
      if (name === 'useful') return noulAnswer((state as { candidate: { title: string } }).candidate.title === 'Rejected official manual' ? 0.03 : 0.97);
      if (name !== 'match') throw new Error(`Unexpected fixture question: ${name}`);
      const candidate = (state as { candidate: { sourceType?: string; title: string } }).candidate;
      return noulAnswer(candidate.sourceType && candidate.title === 'Rejected official manual' ? 0.03 : 0.97);
    });
    installJudgmentPort(fixtureReadings.port);
    const result = await service.answer({ query: 'How many HDMI inputs are supported?', autoRepairGaps: false });
    expect(result.answer.sources.map((source) => source.id)).toEqual(['accepted']);
    expect(prompts.join(' ')).not.toContain('unsupported purple marker');
    expect(result.answer.facts.some((fact) => fact.sourceId === 'rejected')).toBe(false);
  });

});

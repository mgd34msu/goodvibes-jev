import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { KnowledgeSemanticService } from '../sdk/src/platform/knowledge/semantic/service.js';
const roots: string[] = [];
let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('answer judgment holds before generation or repair writes', () => {
  for (const mode of ['missing', 'failed', 'uncertain'] as const) {
    test(`${mode} fact reading preserves stored knowledge and does not spend on synthesis`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'goodvibes-answer-hold-')); roots.push(root);
      const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
      const source = await store.upsertSource({ id: 'manual-fixture', connectorId: 'manual', sourceType: 'manual', title: 'Router HDMI inputs', summary: 'The router has four HDMI inputs.', status: 'indexed' });
      await store.upsertExtraction({ sourceId: source.id, extractorId: 'synthetic', format: 'text', summary: 'The router has four HDMI inputs.', sections: ['Inputs'], structure: { searchText: 'The router has four HDMI inputs.' } });
      await store.upsertNode({ kind: 'fact', slug: 'hdmi-inputs', title: 'HDMI inputs', summary: 'The router has four HDMI inputs.', status: 'active', sourceId: source.id, metadata: { semanticKind: 'fact', factKind: 'specification', sourceIds: [source.id], value: 'four HDMI inputs', evidence: 'The router has four HDMI inputs.' } });
      const before = { sources: store.listSources(), nodes: store.listNodes(), edges: store.listEdges(), issues: store.listIssues() };
      let synthesisCalls = 0;
      const service = new KnowledgeSemanticService(store, { llm: {
        async completeJson() { synthesisCalls += 1; return null; }, async completeText() { synthesisCalls += 1; return null; },
      } });
      if (mode !== 'missing') {
        const fake = fakePort((name) => {
          if (mode === 'failed') throw new Error('Synthetic unavailable reader');
          if (name === 'features') return noulAnswer(0.97);
          return noulAnswer(0.5);
        }); installJudgmentPort(fake.port);
      }
      await expect(service.answer({ query: 'How many HDMI inputs does the router have?', candidateSourceIds: [source.id], strictCandidates: true })).rejects.toThrow();
      expect(synthesisCalls).toBe(0);
      expect({ sources: store.listSources(), nodes: store.listNodes(), edges: store.listEdges(), issues: store.listIssues() }).toEqual(before);
    });
  }
  test('a rejected source is not re-added by claimed authority or shown to the generation model', async () => {
    const root = mkdtempSync(join(tmpdir(), 'goodvibes-answer-source-')); roots.push(root);
    const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
    for (const [id, title, detail] of [['rejected', 'Rejected official manual', 'HDMI inputs include the unsupported purple marker.'], ['accepted', 'Accepted manual', 'HDMI inputs include four supported connectors.']] as const) {
      await store.upsertSource({ id, connectorId: 'manual', sourceType: 'manual', title, summary: detail, status: 'indexed', metadata: { sourceDiscovery: { trustReason: 'official-vendor-domain' } } });
      await store.upsertExtraction({ sourceId: id, extractorId: 'synthetic', format: 'text', summary: detail, structure: { searchText: detail } });
      await store.upsertNode({ kind: 'fact', slug: id, title, summary: detail, status: 'active', sourceId: id, metadata: { semanticKind: 'fact', factKind: 'specification', sourceIds: [id], evidence: detail } });
    }
    const prompts: string[] = [];
    const service = new KnowledgeSemanticService(store, { llm: {
      async completeJson() { throw new Error("No answer JSON generation"); }, async completeText(input) { prompts.push(input.prompt); return null; },
    } });
    installJudgmentPort(fakePort((name, question, state) => {
      if (name === 'fidelity') return choiceAnswer(question, 'supported', 0.97);
      if (name === 'enough' || name === 'complete') return noulAnswer(0.97);
      if (name === 'features') return noulAnswer(0.97);
      if (name !== 'match') throw new Error(`Unexpected fixture question: ${name}`);
      const candidate = (state as { candidate: { sourceType?: string; title: string } }).candidate;
      return noulAnswer(candidate.sourceType && candidate.title === 'Rejected official manual' ? 0.03 : 0.97);
    }).port);
    const result = await service.answer({ query: 'How many HDMI inputs are supported?', autoRepairGaps: false });
    expect(result.answer.sources.map((source) => source.id)).toEqual(['accepted']);
    expect(prompts.join(' ')).not.toContain('unsupported purple marker');
    expect(result.answer.facts.some((fact) => fact.sourceId === 'rejected')).toBe(false);
  });

});

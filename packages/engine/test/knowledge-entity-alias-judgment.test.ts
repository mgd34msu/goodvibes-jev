import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ArtifactStore } from '../sdk/src/platform/artifacts/store.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { KnowledgeConnectorRegistry } from '../sdk/src/platform/knowledge/connectors.js';
import { compileKnowledgeSource, compileKnowledgeStructuredEntityHints } from '../sdk/src/platform/knowledge/ingest-compile.js';
import { JudgmentInputError } from '../sdk/src/platform/gate/judgment-input.js';
import { KnowledgeEntityAliasHoldError, readKnowledgeEntityAliases, MAX_ENTITY_ALIAS_REQUESTS, MAX_ENTITY_ALIAS_EVIDENCE_CHARS } from '../sdk/src/platform/knowledge/entity-aliases.js';
import { entityAlias } from '../sdk/src/platform/knowledge/batteries/entity-alias.js';
import { registry } from '../sdk/src/platform/knowledge/aliases/judgment-registry.js';

let previous: JudgmentPort | undefined;
let root: string;
beforeEach(() => {
  previous = installJudgmentPort(undefined);
  root = mkdtempSync(join(tmpdir(), 'knowledge-entity-alias-'));
});
afterEach(() => { installJudgmentPort(previous); rmSync(root, { recursive: true, force: true }); });
function context() {
  return {
    store: new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }),
    artifactStore: new ArtifactStore({ rootDir: join(root, 'artifacts') }),
    connectorRegistry: new KnowledgeConnectorRegistry(),
    emitIfReady: () => {}, syncReviewedMemory: async () => {}, lint: async () => [], listConnectors: () => [],
  };
}
const entity = { kind: 'project', title: 'Aurora Runtime' };
const evidence = { title: 'AR deployment', summary: 'Aurora Runtime (AR) requires deployment deployment deployment.', extractionSummary: '', sections: [] };
function answers(read: (state: { entity: { kind: string; title: string }; candidate: string; evidence: string }) => number) {
  const fake = fakePort((name, _question, state) => {
    expect(name).toBe('alias');
    return noulAnswer(read(state as Parameters<typeof read>[0]));
  });
  installJudgmentPort(fake.port);
  return fake;
}

describe('knowledge entity alias readings', () => {
  test('registers labelled yes/no fixtures and exercises them with deterministic fixture answers', async () => {
    expect(registry.get(entityAlias.name)).toBe(entityAlias);
    const table = new Map(entityAlias.fixtures.map((fixture) => [JSON.stringify(fixture.state), fixture.expect.alias]));
    const fake = fakePort((_name, _question, state) => {
      const expected = table.get(JSON.stringify(state));
      expect(expected).toBeDefined();
      return noulAnswer(expected === 'yes' ? 0.99 : 0.01);
    });
    const checks = await entityAlias.checkFixtures(fake.port);
    expect(checks.length).toBe(entityAlias.fixtures.length);
    expect(checks.every((check) => check.correct)).toBe(true);
  });

  test('aliases belong only to the judged entity; frequency and nearby topics confer no identity', async () => {
    const ctx = context();
    const tags = ['project:Aurora Runtime', 'project:Borealis', 'repo:acme/core', 'owner:Writer'];
    const source = await ctx.store.upsertSource({ connectorId: 'manual', sourceType: 'document', ...evidence, tags, status: 'indexed', metadata: { knowledgeSpaceId: 'lab', apiKey: 'synthetic-local-only' } });
    const fake = answers(({ entity: target, candidate }) => target.title === entity.title && candidate === 'AR' ? 0.99 : 0.01);
    await compileKnowledgeSource(ctx, source);
    const nodes = ctx.store.listNodes(100).filter((node) => node.kind !== 'topic');
    expect(nodes).toHaveLength(4);
    expect(nodes.find((node) => node.title === entity.title)?.aliases).toEqual(['AR']);
    for (const node of nodes.filter((node) => node.title !== entity.title)) expect(node.aliases).toEqual([]);
    expect(nodes.map((node) => node.title)).toEqual(expect.arrayContaining(['Aurora Runtime', 'Borealis', 'acme/core', 'Writer']));
    for (const node of nodes) {
      expect(node.metadata.compiledFrom).toBe(source.id);
      expect(node.metadata.tags).toEqual(tags);
      expect(node.metadata.knowledgeSpaceId).toBe('lab');
      expect(ctx.store.listEdges().some((edge) => edge.fromId === source.id && edge.toId === node.id)).toBe(true);
    }
    expect(fake.requests.every((request) => request.context?.battery === entityAlias.name && request.context.site === 'knowledge.ingest.entity-alias')).toBe(true);
    const wire = JSON.stringify(fake.requests);
    expect(wire).not.toContain('synthetic-local-only');
    expect(wire).not.toContain(source.id);
    expect(wire).not.toContain('project:Aurora');
  });

  test('short and multilingual candidates are kept verbatim when their readings accept them', async () => {
    const fake = answers(({ candidate }) => ['A', 'TS', '朝日'].includes(candidate) ? 0.99 : 0.01);
    expect(await readKnowledgeEntityAliases([entity], { ...evidence, title: 'A TS 朝日' })).toEqual([['A', 'TS', '朝日']]);
    expect(fake.requests.some((request) => (request.state as { candidate: string }).candidate === 'A')).toBe(true);
  });

  test('confident no leaves deterministic entities and provenance intact with no guessed aliases', async () => {
    const ctx = context();
    const source = await ctx.store.upsertSource({ connectorId: 'manual', sourceType: 'repo', title: 'acme/core', tags: ['env:prod'], status: 'indexed' });
    answers(() => 0.01);
    await compileKnowledgeStructuredEntityHints(ctx, source);
    const nodes = ctx.store.listNodes(100);
    expect(nodes.map((node) => node.title)).toEqual(expect.arrayContaining(['acme/core', 'prod']));
    expect(nodes.every((node) => node.aliases.length === 0 && node.metadata.compiledFrom === source.id)).toBe(true);
    expect(ctx.store.listEdges().map((edge) => edge.relation)).toEqual(expect.arrayContaining(['references_repo', 'references_environment']));
  });

  for (const mode of ['uncertain', 'confirm', 'missing', 'unavailable', 'malformed'] as const) {
    test(`${mode} readings never create aliases or mutate existing compiled graph records`, async () => {
      const ctx = context();
      const source = await ctx.store.upsertSource({ connectorId: 'manual', sourceType: 'document', ...evidence, tags: ['project:Aurora Runtime'], status: 'indexed', sourceUri: 'https://example.invalid/document', artifactId: 'artifact-1' });
      answers(({ candidate }) => candidate === 'AR' ? 0.99 : 0.01);
      await compileKnowledgeSource(ctx, source);
      const nodes = ctx.store.listNodes(100);
      const edges = ctx.store.listEdges();
      if (mode === 'missing') installJudgmentPort(undefined);
      else if (mode === 'unavailable') installJudgmentPort(fakePort(() => { throw new Error('synthetic-outage-private-detail'); }).port);
      else if (mode === 'malformed') installJudgmentPort(fakePort(() => ({ type: 'noul', noul: Number.NaN })).port);
      else {
        let count = 0;
        answers(() => ++count === 1 ? 0.99 : mode === 'confirm' ? 0.8 : 0.5);
      }
      await expect(compileKnowledgeSource(ctx, source)).rejects.toBeInstanceOf(KnowledgeEntityAliasHoldError);
      expect(ctx.store.listNodes(100)).toEqual(nodes);
      expect(ctx.store.listEdges()).toEqual(edges);
      expect(ctx.store.getSource(source.id)).toEqual(source);
    });
  }

  test('late held readings also create no new graph nodes, edges, or partial aliases', async () => {
    const ctx = context();
    const source = await ctx.store.upsertSource({ connectorId: 'manual', sourceType: 'document', ...evidence, tags: ['project:Aurora Runtime', 'project:Borealis'], status: 'indexed', sourceUri: 'https://example.invalid/document' });
    answers(({ entity: target }) => target.title === entity.title ? 0.99 : 0.5);
    await expect(compileKnowledgeSource(ctx, source)).rejects.toBeInstanceOf(KnowledgeEntityAliasHoldError);
    expect(ctx.store.listNodes()).toEqual([]);
    expect(ctx.store.listEdges()).toEqual([]);
  });

  test('preflights every complete field and later entity before any request or graph write', async () => {
    const ctx = context();
    const fake = answers(() => 0.99);
    const tail = 'ordinary '.repeat(700) + 'password=synthetic-fixture';
    for (const input of [
      { ...evidence, title: tail }, { ...evidence, summary: tail },
      { ...evidence, extractionSummary: tail }, { ...evidence, sections: ['safe', tail] },
      { ...evidence, sections: ['4111 1111 1111 1111'] },
    ]) await expect(readKnowledgeEntityAliases([entity], input)).rejects.toBeInstanceOf(JudgmentInputError);
    await expect(readKnowledgeEntityAliases([entity, { kind: 'user', title: tail }], evidence)).rejects.toBeInstanceOf(JudgmentInputError);
    const source = await ctx.store.upsertSource({ connectorId: 'manual', sourceType: 'document', ...evidence, tags: ['project:Aurora Runtime', 'owner:password=synthetic-fixture'], status: 'indexed' });
    await expect(compileKnowledgeSource(ctx, source)).rejects.toBeInstanceOf(JudgmentInputError);
    expect(fake.requests).toHaveLength(0);
    expect(ctx.store.listNodes()).toEqual([]);
  });

  test('empty entity or lexical candidate sets and exact identity need no judgment port', async () => {
    expect(await readKnowledgeEntityAliases([], evidence)).toEqual([]);
    expect(await readKnowledgeEntityAliases([entity], { title: '', summary: '', extractionSummary: '', sections: [] })).toEqual([[]]);
    expect(await readKnowledgeEntityAliases([{ kind: 'project', title: 'AR' }], { title: 'AR', summary: '', extractionSummary: '', sections: [] })).toEqual([[]]);
  });

  test('request and text budgets do not change exact entity identity or permit frequency fallback', async () => {
    const fake = answers(() => 0.99);
    const entities = Array.from({ length: 56 }, (_, index) => ({ kind: 'project', title: `Exact Entity ${index}` }));
    const result = await readKnowledgeEntityAliases(entities, { ...evidence, title: Array.from({ length: 100 }, (_, index) => `word${index}`).join(' '), summary: 'bounded '.repeat(1000) });
    expect(fake.requests.length).toBeLessThanOrEqual(MAX_ENTITY_ALIAS_REQUESTS);
    expect(fake.requests).toHaveLength(112);
    expect(result.every((aliases) => aliases.length <= 4)).toBe(true);
    expect(fake.requests.every((request) => (request.state as { evidence: string }).evidence.length <= MAX_ENTITY_ALIAS_EVIDENCE_CHARS)).toBe(true);
    const before = fake.requests.length;
    await expect(readKnowledgeEntityAliases(Array.from({ length: 129 }, () => entity), evidence)).rejects.toBeInstanceOf(KnowledgeEntityAliasHoldError);
    await expect(readKnowledgeEntityAliases([{ kind: 'project', title: 'x'.repeat(513) }], evidence)).rejects.toBeInstanceOf(KnowledgeEntityAliasHoldError);
    expect(fake.requests).toHaveLength(before);
  });
});

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ArtifactStore } from '../sdk/src/platform/artifacts/store.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { KnowledgeConnectorRegistry } from '../sdk/src/platform/knowledge/connectors.js';
import { ingestKnowledgeArtifact, ingestKnowledgeUrl } from '../sdk/src/platform/knowledge/ingest-inputs.js';
import { KnowledgeEntityAliasHoldError } from '../sdk/src/platform/knowledge/entity-aliases.js';
import { KnowledgeNodeActivationHeldError } from '../sdk/src/platform/knowledge/activation/types.js';
import { createKnowledgeNodeOperatorMutation, KnowledgeNodeMutationHeldError } from '../sdk/src/platform/knowledge/store-node-authority.js';
import { getKnowledgeNodeObservation, prepareStagedObservedKnowledgeNodeInput } from '../sdk/src/platform/knowledge/store-node-observation.js';
import { KnowledgeExtractionJudgmentHoldError } from '../sdk/src/platform/knowledge/extraction-policy.js';
import { createCompressedPdfBuffer } from './_helpers/homegraph-service-fixtures.js';

let root: string;
let previous: JudgmentPort | undefined;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'knowledge-ingest-alias-')); previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); rmSync(root, { recursive: true, force: true }); });
const uri = 'https://example.invalid/aurora-manual.txt';
const tags = ['project:Aurora Runtime'];
const routes = ['artifact', 'url'] as const;
function snapshot(store: KnowledgeStore) {
  const byId = <T extends { readonly id: string }>(records: T[]) => records.sort((left, right) => left.id.localeCompare(right.id));
  return { sources: byId(store.listSources()), extractions: byId(store.listExtractions()), nodes: byId(store.listNodes()), edges: byId(store.listEdges()),
    revisions: byId(store.listNodes()).map((node) => store.listNodeRevisions(node.id)), status: store.status() };
}
async function fixture(route: typeof routes[number]) {
  const dbPath = join(root, 'knowledge.sqlite');
  const store = new KnowledgeStore({ dbPath });
  const artifactStore = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  await store.init();
  const first = await artifactStore.createFromStream({ kind: 'document', filename: 'original.txt', mimeType: 'text/plain', sourceUri: uri, stream: ['Aurora Runtime (AR) retains original usable knowledge.'] });
  const replacement = await artifactStore.createFromStream({ kind: 'document', filename: 'replacement.txt', mimeType: 'text/plain', sourceUri: uri, stream: ['Aurora Runtime (AR) replacement information.'] });
  let selected = first;
  const fetch = spyOn(artifactStore, 'create').mockImplementation(async () => selected);
  const ctx = { store, artifactStore, connectorRegistry: new KnowledgeConnectorRegistry(), emitIfReady: () => {},
    syncReviewedMemory: async () => {}, lint: async () => [], listConnectors: () => [] };
  const ingest = (replace = false, signal?: AbortSignal) => {
    selected = replace ? replacement : first;
    const input = { title: replace ? 'Replacement title' : 'Original title', tags, metadata: { knowledgeSpaceId: 'alias-lab' }, signal };
    return route === 'artifact' ? ingestKnowledgeArtifact(ctx, { ...input, artifactId: selected.id, uri }) : ingestKnowledgeUrl(ctx, { ...input, url: uri });
  };
  const reopen = async () => { const opened = new KnowledgeStore({ dbPath }); await opened.init(); return snapshot(opened); };
  return { ctx, ingest, reopen, first, replacement, fetch };
}
function settled() { const fake = fakePort(() => noulAnswer(0.99)); installJudgmentPort(fake.port); return fake; }

for (const route of routes) describe(`${route} aliases before source publication`, () => {
  for (const mode of ['missing', 'failed', 'uncertain', 'late-hold'] as const) {
    test(`${mode} aliases preserve first-ingest and reingest state in memory and SQLite`, async () => {
      const { ctx, ingest, reopen, first, replacement, fetch } = await fixture(route);
      try {
        const hold = () => {
          let aliases = 0;
          installJudgmentPort(mode === 'missing' ? undefined : fakePort((name) => {
            expect(name).toBe('alias');
            if (mode === 'failed') throw new Error('Synthetic port outage');
            return noulAnswer(mode === 'late-hold' && ++aliases === 1 ? 0.99 : 0.5);
          }).port);
        };
        const empty = snapshot(ctx.store);
        hold();
        await expect(ingest()).rejects.toBeInstanceOf(KnowledgeEntityAliasHoldError);
        expect(snapshot(ctx.store)).toEqual(empty);
        expect(await reopen()).toEqual(empty);
        settled();
        const indexed = await ingest();
        expect(indexed.source.status).toBe('indexed');
        expect(indexed.extraction?.metadata.knowledgeSpaceId).toBe('alias-lab');
        const before = snapshot(ctx.store);
        hold();
        await expect(ingest(true)).rejects.toBeInstanceOf(KnowledgeEntityAliasHoldError);
        expect(snapshot(ctx.store)).toEqual(before);
        expect(await reopen()).toEqual(before);
        expect((await ctx.artifactStore.readContent(first.id)).buffer.toString()).toContain('original usable knowledge');
        expect((await ctx.artifactStore.readContent(replacement.id)).buffer.toString()).toContain('replacement information');
      } finally { fetch.mockRestore(); }
    });
  }

  test('a competing first ingest for the reserved URI prevents duplicate publication', async () => {
    const { ctx, ingest, reopen, fetch } = await fixture(route);
    try {
      let published = false;
      const answers = fakePort(() => noulAnswer(0.99)).port;
      installJudgmentPort({ model: answers.model, async ask(request) {
        if (!published) {
          published = true;
          await ctx.store.upsertSource({ id: 'competing-source', connectorId: 'fixture', sourceType: 'document',
            canonicalUri: uri, sourceUri: uri, title: 'Concurrent first source', status: 'indexed' });
        }
        return answers.ask(request);
      } });
      await expect(ingest()).rejects.toBeInstanceOf(KnowledgeEntityAliasHoldError);
      expect(ctx.store.listSources().map((source) => source.id)).toEqual(['competing-source']);
      expect(ctx.store.listExtractions()).toHaveLength(0);
      expect(ctx.store.listNodes()).toHaveLength(0);
      expect(ctx.store.listEdges()).toHaveLength(0);
      expect(await reopen()).toEqual(snapshot(ctx.store));
    } finally { fetch.mockRestore(); }
  });

  test('a source edit between extraction preparation and finalization cannot be overwritten', async () => {
    const { ctx, ingest, reopen, fetch } = await fixture(route);
    settled(); await ingest();
    const before = snapshot(ctx.store);
    let edit: Promise<unknown> | undefined;
    const started = spyOn(ctx, 'emitIfReady').mockImplementation(() => {
      edit ??= ctx.store.upsertSource({ ...before.sources[0]!, title: 'Concurrent edit before finalization' });
    });
    try {
      await expect(ingest(true)).rejects.toBeInstanceOf(KnowledgeExtractionJudgmentHoldError);
      await edit;
      expect(ctx.store.listSources()[0]!.title).toBe('Concurrent edit before finalization');
      expect(snapshot(ctx.store).extractions).toEqual(before.extractions);
      expect(snapshot(ctx.store).nodes).toEqual(before.nodes);
      expect(snapshot(ctx.store).edges).toEqual(before.edges);
      expect(await reopen()).toEqual(snapshot(ctx.store));
    } finally { started.mockRestore(); fetch.mockRestore(); }
  });

  test('settled aliases commit the replacement and do not publish anything during the reading batch', async () => {
    const { ctx, ingest, reopen, replacement, fetch } = await fixture(route);
    try {
      settled(); await ingest();
      const before = snapshot(ctx.store);
      const aliasEvidence: string[] = [];
      installJudgmentPort(fakePort((name, _question, state) => {
        if (name === 'alias') {
          expect(snapshot(ctx.store)).toEqual(before);
          aliasEvidence.push((state as { evidence: string }).evidence);
        }
        return noulAnswer(0.99);
      }).port);
      const result = await ingest(true);
      expect(result.source.status).toBe('indexed');
      expect(result.source.title).toBe('Replacement title');
      expect(result.source.artifactId).toBe(replacement.id);
      expect(result.extraction?.summary).toContain('replacement information');
      expect(aliasEvidence.length).toBeGreaterThan(1);
      expect(aliasEvidence.every((evidence) => evidence.includes('Replacement title') && evidence.includes('replacement information'))).toBe(true);
      expect(await reopen()).toEqual(snapshot(ctx.store));
    } finally { fetch.mockRestore(); }
  });

  for (const mode of ['uncertain', 'failed', 'reviewed-node', 'cancelled'] as const) {
    test(`a ${mode} structured-node dependency holds the whole replacement before publication`, async () => {
      const { ctx, ingest, reopen, fetch } = await fixture(route);
      try {
        settled(); await ingest();
        if (mode === 'reviewed-node') {
          const project = ctx.store.listNodes().find((node) => node.kind === 'project')!;
          await ctx.store.upsertNode(project, createKnowledgeNodeOperatorMutation(project, { action: 'accept', reviewer: 'synthetic-reviewer' }));
        }
        const before = snapshot(ctx.store);
        const controller = new AbortController();
        let serving = 0;
        installJudgmentPort(fakePort((name) => {
          expect(snapshot(ctx.store)).toEqual(before);
          if (name === 'serve') {
            serving++;
            if (mode === 'failed') throw new Error('Synthetic activation failure');
            if (mode === 'cancelled') controller.abort();
            return noulAnswer(0.5);
          }
          return noulAnswer(0.99);
        }).port);
        await expect(ingest(true, controller.signal)).rejects.toBeInstanceOf(mode === 'reviewed-node' ? KnowledgeNodeMutationHeldError : KnowledgeNodeActivationHeldError);
        if (mode !== 'reviewed-node') expect(serving).toBeGreaterThan(0);
        expect(snapshot(ctx.store)).toEqual(before);
        expect(await reopen()).toEqual(before);
      } finally { fetch.mockRestore(); }
    });
  }

  test('committed catalog observations remain bound to their live source', async () => {
    const { ctx, ingest, fetch } = await fixture(route);
    try {
      settled(); await ingest();
      const domain = ctx.store.listNodes().find((node) => node.kind === 'domain')!;
      expect(domain.status).toBe('active');
      const observation = getKnowledgeNodeObservation(domain, domain)!;
      expect(observation).toBeDefined();
      expect(() => observation.assertCurrent()).not.toThrow();
      await ctx.store.upsertSource({ ...ctx.store.listSources()[0]!, title: 'Changed after ingest' });
      expect(() => observation.assertCurrent()).toThrow(KnowledgeNodeActivationHeldError);
    } finally { fetch.mockRestore(); }
  });

  test('cancellation interrupts an unresponsive alias port without later writes', async () => {
    const { ctx, ingest, reopen, fetch } = await fixture(route);
    try {
      settled(); await ingest();
      const before = snapshot(ctx.store);
      const controller = new AbortController();
      const responder = fakePort(() => noulAnswer(0.99)).port;
      let release = () => {};
      let started = () => {};
      const pending = new Promise<void>((resolve) => { release = resolve; });
      const reading = new Promise<void>((resolve) => { started = resolve; });
      installJudgmentPort({ model: responder.model, async ask(request) { started(); await pending; return responder.ask(request); } });
      const attempt = ingest(true, controller.signal);
      await reading;
      controller.abort();
      await expect(attempt).rejects.toBeInstanceOf(KnowledgeEntityAliasHoldError);
      release();
      await Promise.resolve();
      expect(snapshot(ctx.store)).toEqual(before);
      expect(await reopen()).toEqual(before);
    } finally { fetch.mockRestore(); }
  });

  for (const change of ['source', 'extraction', 'artifact', 'port', 'cancellation'] as const) {
    test(`a ${change} change during alias preparation never publishes the proposed replacement`, async () => {
      const { ctx, ingest, reopen, replacement, fetch } = await fixture(route);
      let restoreRecord = () => {};
      try {
        settled(); await ingest();
        let expected = snapshot(ctx.store);
        const controller = new AbortController();
        const answer = fakePort(() => noulAnswer(0.99)).port;
        let changed = false;
        const port: JudgmentPort = { model: answer.model, async ask(request) {
          if (!changed) {
            changed = true;
            if (change === 'source') await ctx.store.upsertSource({ ...ctx.store.listSources()[0]!, title: 'Concurrent source edit' });
            if (change === 'extraction') await ctx.store.upsertExtraction({ ...ctx.store.listExtractions()[0]!, summary: 'Concurrent extraction edit' });
            if (change === 'artifact') {
              const old = ctx.artifactStore.getRecord(replacement.id)!;
              const changedRecord = spyOn(ctx.artifactStore, 'getRecord').mockImplementation((id) => id === replacement.id ? { ...old, sha256: 'changed' } : null);
              // The fixture uses only this artifact after the pending read began.
              restoreRecord = () => changedRecord.mockRestore();
            }
            if (change === 'port') installJudgmentPort(answer);
            if (change === 'cancellation') controller.abort();
            expected = snapshot(ctx.store);
          }
          return answer.ask(request);
        } };
        installJudgmentPort(port);
        await expect(ingest(true, controller.signal)).rejects.toBeInstanceOf(change === 'artifact' ? KnowledgeExtractionJudgmentHoldError : KnowledgeEntityAliasHoldError);
        expect(changed).toBe(true);
        expect(snapshot(ctx.store)).toEqual(expected);
        expect(await reopen()).toEqual(expected);
      } finally { restoreRecord(); fetch.mockRestore(); }
    });
  }
});

test('ordinary URL fetch and artifact parse failures still produce failed source records', async () => {
  const { ctx, ingest, reopen, fetch } = await fixture('url');
  try {
    settled(); await ingest();
    fetch.mockRejectedValue(new Error('Synthetic fetch failed'));
    const failed = await ingest(true);
    expect(failed.source.status).toBe('failed');
    expect(failed.source.crawlError).toContain('Synthetic fetch failed');
    const empty = await ctx.artifactStore.createFromStream({ kind: 'document', filename: 'empty.pdf', mimeType: 'application/pdf', stream: [createCompressedPdfBuffer('')] });
    const parsed = await ingestKnowledgeArtifact(ctx, { artifactId: empty.id, title: 'Empty PDF' });
    expect(parsed.source.status).toBe('failed');
    expect(parsed.source.crawlError).toContain('PDF extraction failed');
    expect(await reopen()).toEqual(snapshot(ctx.store));
  } finally { fetch.mockRestore(); }
});

for (const copied of [false, true]) test(`staged catalog authority ${copied ? 'does not survive identical JSON copying' : 'survives trusted preparation'}`, async () => {
  const { ctx, reopen, fetch } = await fixture('artifact');
  try {
    const sourceId = 'source-staged-observation';
    await ctx.store.applyPreparedIngest({
      sources: [{ id: sourceId, connectorId: 'fixture', sourceType: 'document', title: 'Source evidence', status: 'indexed' }],
      extractions: [{ sourceId, extractorId: 'text', format: 'text', excerpt: 'Extracted source evidence.', sections: [], links: [] }],
      nodes: [], edges: [], issues: [],
    }, async (stage) => {
      const source = stage.sources[0]!;
      const branded = prepareStagedObservedKnowledgeNodeInput(ctx.store, {
        kind: 'topic', slug: 'staged-topic', title: 'Staged topic', sourceId,
      }, source, () => ctx.store.getSource(sourceId), stage.assertCurrent);
      return { nodes: [copied ? JSON.parse(JSON.stringify(branded)) as typeof branded : branded], edges: [], issues: [] };
    });
    const node = ctx.store.listNodes()[0]!;
    expect(node.status).toBe(copied ? 'draft' : 'active');
    expect(node.metadata.nodeObservation !== undefined).toBe(!copied);
    expect(await reopen()).toEqual(snapshot(ctx.store));
  } finally { fetch.mockRestore(); }
});

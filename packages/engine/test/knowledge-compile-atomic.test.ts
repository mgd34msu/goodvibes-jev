import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ArtifactStore } from '../sdk/src/platform/artifacts/store.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { KnowledgeConnectorRegistry } from '../sdk/src/platform/knowledge/connectors.js';
import { compileKnowledgeSource, compileKnowledgeStructuredEntityHints, recompileKnowledgeSource } from '../sdk/src/platform/knowledge/ingest-compile.js';
import { KnowledgeEntityAliasHoldError } from '../sdk/src/platform/knowledge/entity-aliases.js';
import { KnowledgeNodeActivationHeldError } from '../sdk/src/platform/knowledge/activation/types.js';
import { createKnowledgeNodeOperatorMutation, KnowledgeNodeMutationHeldError } from '../sdk/src/platform/knowledge/store-node-authority.js';
import { getKnowledgeNodeObservation } from '../sdk/src/platform/knowledge/store-node-observation.js';
import { KnowledgeExtractionJudgmentHoldError, KNOWLEDGE_EXTRACTOR_VERSION } from '../sdk/src/platform/knowledge/extraction-policy.js';
import type { SQLiteStore } from '../sdk/src/platform/state/sqlite-store.js';

let root: string;
let previous: JudgmentPort | undefined;
const opened: KnowledgeStore[] = [];
const sqlite = (store: KnowledgeStore) => (store as unknown as { sqlite: SQLiteStore }).sqlite;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'knowledge-compile-atomic-')); previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); opened.splice(0).forEach((store) => sqlite(store).close()); rmSync(root, { recursive: true, force: true }); });
function settled() { const fake = fakePort(() => noulAnswer(0.99)); installJudgmentPort(fake.port); return fake; }
function state(store: KnowledgeStore) {
  const byId = <T extends { readonly id: string }>(rows: T[]) => rows.sort((left, right) => left.id.localeCompare(right.id));
  return { sources: byId(store.listSources()), extractions: byId(store.listExtractions()), nodes: byId(store.listNodes()),
    edges: byId(store.listEdges()), issues: byId(store.listIssues()), revisions: byId(store.listNodes()).map((node) => store.listNodeRevisions(node.id)) };
}
const routes = ['compile', 'recompile', 'structured'] as const;
async function fixture(route: typeof routes[number]) {
  const dbPath = join(root, 'knowledge.sqlite');
  const store = new KnowledgeStore({ dbPath }); opened.push(store);
  const artifactStore = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  const ctx = { store, artifactStore, connectorRegistry: new KnowledgeConnectorRegistry(), emitIfReady: () => {},
    syncReviewedMemory: async () => {}, lint: async () => [], listConnectors: () => [] };
  const artifact = await artifactStore.createFromStream({ kind: 'document', filename: 'aurora.txt', mimeType: 'text/plain',
    sourceUri: 'https://example.invalid/aurora', stream: ['Aurora Runtime (AR) and Borealis replacement information.'] });
  const source = await store.upsertSource({ connectorId: 'fixture', sourceType: 'document', title: 'Original title',
    sourceUri: artifact.sourceUri, canonicalUri: artifact.sourceUri, artifactId: artifact.id, status: 'indexed',
    tags: ['project:Aurora Runtime', 'project:Borealis'], metadata: { knowledgeSpaceId: 'compile-lab', taint: 'external' } });
  const extraction = await store.upsertExtraction({ sourceId: source.id, artifactId: artifact.id, extractorId: 'text', format: 'text',
    summary: 'Prior usable extraction', excerpt: 'Aurora Runtime (AR) and Borealis original information.',
    sections: ['Original section'], metadata: { extractorVersion: 0 } });
  settled(); await compileKnowledgeSource(ctx, source, extraction);
  const edited = await store.upsertSource({ ...source, title: 'Replacement title', tags: [...source.tags, 'newly-compiled-topic'] });
  const run = (signal?: AbortSignal) => route === 'compile' ? compileKnowledgeSource(ctx, edited, store.getExtractionBySourceId(source.id), { signal })
    : route === 'structured' ? compileKnowledgeStructuredEntityHints(ctx, edited, store.getExtractionBySourceId(source.id), { signal }) : recompileKnowledgeSource(ctx, edited, { signal });
  const reopen = async () => { const copy = new KnowledgeStore({ dbPath }); opened.push(copy); await copy.init(); return state(copy); };
  return { ctx, dbPath, edited, artifact, run, reopen };
}

describe('atomic knowledge compilation', () => {
  test('a refresh followed by alias hold retains the old extraction and complete graph', async () => {
    const { ctx, dbPath, run, reopen } = await fixture('recompile');
    const before = state(ctx.store), bytes = readFileSync(dbPath);
    installJudgmentPort(fakePort(() => noulAnswer(0.5)).port);
    await expect(run()).rejects.toBeInstanceOf(KnowledgeEntityAliasHoldError);
    expect(state(ctx.store)).toEqual(before); expect(readFileSync(dbPath)).toEqual(bytes); expect(await reopen()).toEqual(before);
  });

  for (const route of routes) {
    test(`${route}: late activation hold retains every cache and SQLite row`, async () => {
      const { ctx, dbPath, run, reopen } = await fixture(route);
      const before = state(ctx.store), bytes = readFileSync(dbPath);
      let serving = 0;
      installJudgmentPort(fakePort((name) => noulAnswer(name === 'serve' && ++serving === 2 ? 0.5 : 0.99)).port);
      await expect(run()).rejects.toBeInstanceOf(KnowledgeNodeActivationHeldError);
      expect(serving).toBe(2);
      expect(state(ctx.store)).toEqual(before); expect(readFileSync(dbPath)).toEqual(bytes); expect(await reopen()).toEqual(before);
    });

    test(`${route}: late edge SQL failure rolls back preceding extraction, node and revision writes`, async () => {
      const { ctx, dbPath, run, reopen } = await fixture(route);
      const before = state(ctx.store), bytes = readFileSync(dbPath), database = sqlite(ctx.store), originalRun = database.run.bind(database);
      let edges = 0, nodeWrites = 0, extractionWrites = 0, revisions = 0;
      database.run = (sql, params) => {
        if (sql.includes('INSERT OR REPLACE INTO knowledge_nodes')) nodeWrites++;
        if (sql.includes('INSERT OR REPLACE INTO knowledge_extractions')) extractionWrites++;
        if (sql.includes('INTO knowledge_node_revisions')) revisions++;
        if (sql.includes('INSERT OR REPLACE INTO knowledge_edges') && ++edges === 2) throw new Error('fixture late compile SQL failure');
        originalRun(sql, params);
      };
      try { await expect(run()).rejects.toThrow('fixture late compile SQL failure'); }
      finally { database.run = originalRun; }
      expect(nodeWrites).toBeGreaterThan(0); expect(revisions).toBeGreaterThan(0);
      if (route === 'recompile') expect(extractionWrites).toBe(1);
      expect(state(ctx.store)).toEqual(before); expect(readFileSync(dbPath)).toEqual(bytes);
      await database.save(); expect(await reopen()).toEqual(before);
    });

    test(`${route}: success publishes only after all readings, with stable identities on replay`, async () => {
      const { ctx, dbPath, edited, run, reopen } = await fixture(route);
      const before = state(ctx.store), bytes = readFileSync(dbPath), evidence: string[] = [];
      const fake = fakePort((name, _question, request) => {
        expect(state(ctx.store)).toEqual(before); expect(readFileSync(dbPath)).toEqual(bytes);
        evidence.push(JSON.stringify(request));
        return noulAnswer(name === 'alias' ? 0.01 : 0.99);
      });
      installJudgmentPort(fake.port); await run();
      expect(fake.requests.length).toBeGreaterThan(2);
      const after = state(ctx.store);
      expect(after.sources).toEqual(before.sources);
      expect(after.nodes.filter((node) => node.kind === 'project').every((node) => node.status === 'active'
        && node.metadata.compiledFrom === edited.id && node.metadata.knowledgeSpaceId === 'compile-lab'
        && node.metadata.review === undefined && node.metadata.reviewProvenance !== undefined)).toBe(true);
      if (route === 'recompile') {
        expect(after.extractions[0]?.summary).toContain('replacement information');
        expect(evidence.every((entry) => entry.includes('replacement information'))).toBe(true);
        expect(after.extractions[0]?.metadata.knowledgeSpaceId).toBe('compile-lab');
      } else expect(after.extractions).toEqual(before.extractions);
      if (route !== 'structured') {
        const topic = after.nodes.find((node) => node.title === 'newly-compiled-topic')!;
        expect(topic.status).toBe('active'); expect(topic.metadata.nodeActivation).toBeUndefined();
        expect(topic.metadata.nodeObservation).toMatchObject({ origin: 'catalog-structure' });
        expect(() => getKnowledgeNodeObservation(topic, topic)!.assertCurrent()).not.toThrow();
      }
      expect(await reopen()).toEqual(after);
      installJudgmentPort(fakePort((name) => noulAnswer(name === 'alias' ? 0.01 : 0.99)).port);
      await run();
      const replay = state(ctx.store);
      expect(replay.nodes).toEqual(after.nodes); expect(replay.revisions).toEqual(after.revisions);
      expect(replay.extractions).toEqual(after.extractions);
      expect(replay.edges.map((edge) => edge.id)).toEqual(after.edges.map((edge) => edge.id));
      expect(await reopen()).toEqual(replay);
    });

    test(`${route}: operator-reviewed conflict prevents every compilation write`, async () => {
      const { ctx, dbPath, run, reopen } = await fixture(route);
      const project = ctx.store.listNodes().find((node) => node.kind === 'project')!;
      await ctx.store.upsertNode(project, createKnowledgeNodeOperatorMutation(project, { action: 'accept', reviewer: 'fixture operator' }));
      const before = state(ctx.store), bytes = readFileSync(dbPath);
      await expect(run()).rejects.toBeInstanceOf(KnowledgeNodeMutationHeldError);
      expect(state(ctx.store)).toEqual(before); expect(readFileSync(dbPath)).toEqual(bytes); expect(await reopen()).toEqual(before);
    });

    for (const phase of ['alias', 'serve'] as const) for (const change of ['source', 'extraction', 'port', 'cancel'] as const) {
      test(`${route}: ${change} during ${phase} preserves intervening state`, async () => {
        const { ctx, edited, dbPath, run, reopen } = await fixture(route);
        const answer = settled().port, controller = new AbortController();
        let changed = false, expected = state(ctx.store), bytes = readFileSync(dbPath);
        installJudgmentPort({ model: answer.model, async ask(request) {
          if (!changed && phase in request.questions) {
            changed = true;
            if (change === 'source') await ctx.store.upsertSource({ ...edited, title: 'Concurrent edit' });
            if (change === 'extraction') await ctx.store.upsertExtraction({ ...ctx.store.getExtractionBySourceId(edited.id)!, summary: 'Concurrent extraction' });
            if (change === 'port') installJudgmentPort(answer);
            if (change === 'cancel') controller.abort();
            expected = state(ctx.store); bytes = readFileSync(dbPath);
          }
          return answer.ask(request);
        } });
        await expect(run(controller.signal)).rejects.toBeInstanceOf(phase === 'serve'
          ? KnowledgeNodeActivationHeldError : KnowledgeEntityAliasHoldError);
        expect(changed).toBe(true);
        expect(state(ctx.store)).toEqual(expected); expect(readFileSync(dbPath)).toEqual(bytes); expect(await reopen()).toEqual(expected);
      });
    }
  }

  for (const route of ['compile', 'structured'] as const) {
    test(`${route}: stale caller evidence cannot gain catalog observation authority`, async () => {
      const { ctx, edited, reopen } = await fixture(route);
      const stale = { ...edited, tags: [...edited.tags, 'fabricated-topic'] }, before = state(ctx.store), fake = settled();
      await expect(route === 'compile' ? compileKnowledgeSource(ctx, stale) : compileKnowledgeStructuredEntityHints(ctx, stale))
        .rejects.toBeInstanceOf(KnowledgeEntityAliasHoldError);
      expect(fake.requests).toHaveLength(0); expect(state(ctx.store)).toEqual(before); expect(await reopen()).toEqual(before);
    });

    test(`${route}: caller mutations cannot change the detached source or extraction being compiled`, async () => {
      const { ctx, edited, reopen } = await fixture(route);
      const source = { ...structuredClone(edited), tags: [...edited.tags] };
      const retained = ctx.store.getExtractionBySourceId(edited.id)!;
      const extraction = { ...structuredClone(retained), sections: [...retained.sections] };
      let changed = false;
      installJudgmentPort(fakePort(() => {
        if (!changed) {
          changed = true; source.tags.push('injected-topic'); source.metadata.project = 'Injected project'; extraction.sections.push('Injected section');
        }
        return noulAnswer(0.99);
      }).port);
      await (route === 'compile' ? compileKnowledgeSource(ctx, source, extraction) : compileKnowledgeStructuredEntityHints(ctx, source, extraction));
      expect(changed).toBe(true);
      expect(ctx.store.listNodes().some((node) => /injected/i.test(node.title))).toBe(false);
      expect(await reopen()).toEqual(state(ctx.store));
    });

    test(`${route}: foreign-space evidence holds without publishing local catalog nodes`, async () => {
      const { ctx, edited, run, reopen } = await fixture(route);
      await ctx.store.upsertExtraction({ ...ctx.store.getExtractionBySourceId(edited.id)!, metadata: { knowledgeSpaceId: 'foreign-space' } });
      const before = state(ctx.store);
      await expect(run()).rejects.toMatchObject({ name: 'KnowledgeNodeActivationHeldError', reason: 'foreign-space' });
      expect(state(ctx.store)).toEqual(before); expect(await reopen()).toEqual(before);
    });
  }

  test('a changed refresh artifact holds the old extraction through the last activation', async () => {
    const { ctx, artifact, run, reopen } = await fixture('recompile');
    const before = state(ctx.store), original = ctx.artifactStore.getRecord.bind(ctx.artifactStore);
    let changed = false;
    const read = spyOn(ctx.artifactStore, 'getRecord').mockImplementation((id) => {
      const record = original(id); return changed && id === artifact.id && record ? { ...record, sha256: 'changed' } : record;
    });
    installJudgmentPort(fakePort((name) => { if (name === 'serve') changed = true; return noulAnswer(0.99); }).port);
    try { await expect(run()).rejects.toBeInstanceOf(KnowledgeExtractionJudgmentHoldError); }
    finally { read.mockRestore(); }
    expect(changed).toBe(true); expect(state(ctx.store)).toEqual(before); expect(await reopen()).toEqual(before);
  });

  test('cancelling an unresponsive extraction freshness read returns promptly and never publishes', async () => {
    const { ctx, edited, run, reopen } = await fixture('recompile');
    await ctx.store.upsertExtraction({ ...ctx.store.getExtractionBySourceId(edited.id)!, metadata: { extractorVersion: KNOWLEDGE_EXTRACTOR_VERSION } });
    const before = state(ctx.store), answer = settled().port, controller = new AbortController();
    let release = () => {}, started = () => {};
    const pending = new Promise<void>((resolve) => { release = resolve; }), reading = new Promise<void>((resolve) => { started = resolve; });
    installJudgmentPort({ model: answer.model, async ask(request) { started(); await pending; return answer.ask(request); } });
    const attempt = run(controller.signal); await reading; controller.abort();
    await expect(attempt).rejects.toBeInstanceOf(KnowledgeEntityAliasHoldError);
    release(); await Promise.resolve();
    expect(state(ctx.store)).toEqual(before); expect(await reopen()).toEqual(before);
  });

  test('an operational artifact read failure still rejects without replacing the source or extraction', async () => {
    const { ctx, run, reopen } = await fixture('recompile');
    const before = state(ctx.store), read = spyOn(ctx.artifactStore, 'readContent').mockRejectedValue(new Error('fixture artifact read failure'));
    try { await expect(run()).rejects.toThrow('fixture artifact read failure'); }
    finally { read.mockRestore(); }
    expect(state(ctx.store)).toEqual(before); expect(await reopen()).toEqual(before);
  });
});

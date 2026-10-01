/**
 * knowledge-jobruns-retention.test.ts
 *
 * The job-run history is bounded in memory AND on disk: settled runs beyond the
 * cap are pruned oldest-first (active runs never pruned), the cap holds across
 * a store reload (restart), and the MemoryGovernor trim hook actually reclaims.
 * Companion gate: every background self-improvement trigger routes through the
 * governed scheduler, no caller bypasses it with a direct scheduleBackground
 * self-improve.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { KnowledgeSemanticService } from '../sdk/src/platform/knowledge/semantic/service.js';
import {
  enrichAndImproveHomeGraphSource,
  enrichHomeGraphSpaceSources,
  runHomeGraphSyncSelfImprovementPump,
} from '../sdk/src/platform/knowledge/home-graph/sync-self-improvement.js';
import { createStores } from './_helpers/knowledge-semantic-fixtures.js';

describe('job-run history retention (bounded memory + disk)', () => {
  test('settled runs beyond the cap are pruned; active runs survive; reload stays bounded', async () => {
    const { store } = createStores();
    await store.init();
    // 520 settled runs + 3 active ones.
    for (let i = 0; i < 520; i++) {
      await store.upsertJobRun({ jobId: `job-${i % 5}`, status: 'completed', mode: 'background', result: {}, metadata: {} });
    }
    const active: string[] = [];
    for (let i = 0; i < 3; i++) {
      const run = await store.upsertJobRun({ jobId: 'job-live', status: 'running', mode: 'background', result: {}, metadata: {} });
      active.push(run.id);
    }
    const retained = store.listJobRuns(10_000);
    expect(retained.length).toBeLessThanOrEqual(503); // cap (500) + the 3 active
    for (const id of active) {
      expect(retained.some((r) => r.id === id)).toBe(true); // active never pruned
    }
    // The MemoryGovernor trim reclaims down to its floor, keeping active runs.
    store.pruneJobRuns(10);
    const afterTrim = store.listJobRuns(10_000);
    expect(afterTrim.length).toBeLessThanOrEqual(13);
    for (const id of active) expect(afterTrim.some((r) => r.id === id)).toBe(true);
  });

  test('the cap holds across a reload (no accretion across restarts)', async () => {
    const { store } = createStores();
    await store.init();
    for (let i = 0; i < 600; i++) {
      await store.upsertJobRun({ jobId: 'job-a', status: 'completed', mode: 'background', result: {}, metadata: {} });
    }
    const dbPath = (store as unknown as { sqlite: { dbPath: string } }).sqlite.dbPath;
    const reloaded = new KnowledgeStore({ dbPath });
    await reloaded.init();
    expect(reloaded.listJobRuns(10_000).length).toBeLessThanOrEqual(500);
  });
});

describe('no self-improve scheduler bypasses (gate)', () => {
  test('every .selfImprove( caller in the SDK source is on the governed allowlist', () => {
    const root = 'sdk/src';
    // Files allowed to call selfImprove directly:
    //  - semantic/service.ts: the scheduler itself + the answer path (deferRepair task-queue pass)
    //  - home-graph/sync-self-improvement.ts: the delayed, single-flight sync pump,
    //    governed via a between-rounds isBackgroundWorkPaused() gate plus
    //    { stopWhenPaused: true } threaded into the runner's per-gap yield
    //    points (real for space-scoped rounds), and the in-run admission gate
    //  - knowledge/service.ts: the manual reindex/selfImprove verb surface (operator-invoked,
    //    admission-gated inside runSelfImproveUnlocked)
    const allowed = new Set([
      'platform/knowledge/semantic/service.ts',
      'platform/knowledge/home-graph/sync-self-improvement.ts',
      'platform/knowledge/service.ts',
      // The scheduled-job executor (the deliberate hourly cadence); its verb
      // entry (KnowledgeService.runJob) is admission-gated, and the run itself
      // passes through runSelfImproveUnlocked's in-run admission check.
      'platform/knowledge/service-jobs.ts',
      // The operator-invoked Home Graph refinement verb (foreground, targeted
      // gapIds), admission-gated in-run like every non-deferRepair run.
      'platform/knowledge/home-graph/refinement.ts',
    ]);
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        const text = readFileSync(full, 'utf-8');
        if (/\.selfImprove\(/.test(text)) {
          const rel = full.slice(root.length + 1);
          if (!allowed.has(rel)) offenders.push(rel);
        }
      }
    };
    walk(root);
    expect(
      offenders,
      `New .selfImprove( caller(s) outside the governed allowlist: ${offenders.join(', ')}. ` +
      'Background self-improvement triggers must route through KnowledgeSemanticService.queueBackgroundSelfImprove ' +
      '(floor + coalescing + zero-gap backoff + governor pause), never a direct scheduleBackground self-improve.',
    ).toEqual([]);
  });
});

describe('governor pause at background entrypoints', () => {
  async function pauseFixture() {
    const { store, artifactStore } = createStores();
    const spaceId = 'homeassistant:pause-fixture';
    const source = await store.upsertSource({
      connectorId: 'semantic-gap-repair', sourceType: 'url', title: 'Device specifications',
      canonicalUri: 'https://fixture.invalid/device', tags: [], status: 'indexed',
      metadata: { knowledgeSpaceId: spaceId },
    });
    for (const slug of ['pause-gap-1', 'pause-gap-2', 'pause-gap-3']) {
      await store.upsertNode({
        kind: 'knowledge_gap', slug, title: `What does ${slug} need?`, aliases: [],
        confidence: 75, sourceId: source.id,
        metadata: { knowledgeSpaceId: spaceId, semanticKind: 'gap', gapKind: 'answer', sourceIds: [source.id] },
      });
    }
    let paused = false;
    let repairCalls = 0;
    const semanticService = new KnowledgeSemanticService(store, {
      isBackgroundPaused: () => paused,
      gapRepairer: async () => {
        repairCalls += 1;
        paused = true;
        return { searched: true, evidenceSufficient: false, acceptedSourceIds: [], ingestedSourceIds: [], skippedUrls: [] };
      },
    });
    return {
      spaceId, source, repairCalls: () => repairCalls,
      runtime: { store, artifactStore, semanticService, reportBackgroundError: () => {} },
    };
  }

  test('a whole-store sweep stops inside its first space after a governor pause', async () => {
    const fixture = await pauseFixture();
    const result = await fixture.runtime.semanticService.selfImprove({ force: true }, { stopWhenPaused: true });
    expect(fixture.repairCalls()).toBe(1);
    expect(result.processedGaps).toBe(1);
    expect(result.truncated).toBe(true);
    expect(result.budgetExhausted).toBe(true);
  });

  test('whole-space enrichment stops repairing gaps when the governor pauses', async () => {
    const fixture = await pauseFixture();
    await enrichHomeGraphSpaceSources(fixture.runtime, fixture.spaceId);
    expect(fixture.repairCalls()).toBe(1);
  });

  test('a sync-pump round stops repairing gaps when the governor pauses', async () => {
    const fixture = await pauseFixture();
    const controller = new AbortController();
    const service = fixture.runtime.semanticService;
    const selfImprove = service.selfImprove.bind(service);
    const results: Awaited<ReturnType<typeof selfImprove>>[] = [];
    service.selfImprove = async (...args) => {
      const result = await selfImprove(...args);
      results.push(result);
      // Stop only AFTER the real round finishes; cancellation must not be
      // what prevents that round from repairing its remaining gaps.
      controller.abort();
      return result;
    };
    await runHomeGraphSyncSelfImprovementPump(fixture.runtime, fixture.spaceId, 'pause-fixture', controller.signal);
    expect(fixture.repairCalls()).toBe(1);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ processedGaps: 1, truncated: true, budgetExhausted: true });
  });

  test('useful per-source enrichment queues governed work instead of starting a repair directly', async () => {
    const { store, artifactStore } = createStores();
    const spaceId = 'source-fixture';
    const source = await store.upsertSource({
      connectorId: 'fixture', sourceType: 'document', title: 'Device specifications',
      canonicalUri: 'fixture://device', tags: [], status: 'indexed', metadata: { knowledgeSpaceId: spaceId },
    });
    const fact = await store.upsertNode({
      kind: 'fact', slug: 'hdmi-inputs', title: 'Four HDMI inputs', aliases: [], confidence: 95,
      sourceId: source.id, metadata: { knowledgeSpaceId: spaceId, semanticKind: 'fact', factKind: 'specification' },
    });
    await store.upsertEdge({
      fromKind: 'source', fromId: source.id, toKind: 'node', toId: fact.id,
      relation: 'supports_fact', metadata: { knowledgeSpaceId: spaceId },
    });
    const queued: unknown[] = [];
    let enrichCalls = 0;
    await enrichAndImproveHomeGraphSource({
      store, artifactStore, reportBackgroundError: () => {},
      semanticService: {
        isBackgroundWorkPaused: () => false,
        admitBackgroundWork: () => ({ allowed: true }),
        enrichSource: async () => { enrichCalls += 1; },
        queueBackgroundSelfImprove: (input: unknown) => { queued.push(input); },
        selfImprove: () => { throw new Error('ingestion bypassed the background scheduler'); },
      } as unknown as KnowledgeSemanticService,
    }, source.id, spaceId);
    expect(enrichCalls).toBe(1);
    expect(queued).toEqual([expect.objectContaining({ knowledgeSpaceId: spaceId, sourceIds: [source.id], reason: 'ingest' })]);
  });
});

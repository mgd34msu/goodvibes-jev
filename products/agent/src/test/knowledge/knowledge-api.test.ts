import { useMemoryReadings } from '../helpers/memory-readings.ts';
import { withPublicKnowledgeReadings } from '../helpers/public-knowledge-readings.ts';
import { beforeEach, describe, expect, test } from 'bun:test';
import { createKnowledgeApi } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import { resetTestRuntimeServices, getTestRuntimeServices } from '../helpers/runtime-services.ts';

describe('KnowledgeApi', () => {
  beforeEach(() => {
    resetTestRuntimeServices();
  });

  test('groups status, connector, and query surfaces over the knowledge runtime', async () => {
    const runtimeServices = getTestRuntimeServices();
    readings.use({});
    const api = createKnowledgeApi(runtimeServices.knowledgeService, {
      memoryRegistry: runtimeServices.memoryRegistry,
    });

    const status = await api.status.get();
    expect(status).toMatchObject({
      ready: expect.any(Boolean),
      note: expect.stringContaining('Structured knowledge'),
    });

    const connectors = api.connectors.list();
    expect(connectors.length).toBeGreaterThan(0);
    expect(api.connectors.get(connectors[0]!.id)?.id).toBe(connectors[0]!.id);

    const sourceQuery = api.sources.query({ limit: 5 });
    expect(sourceQuery).toMatchObject({
      total: expect.any(Number),
      items: expect.any(Array),
    });
    expect(api.graph.nodes.query({ limit: 5 })).toMatchObject({
      total: expect.any(Number),
      items: expect.any(Array),
    });

    await runtimeServices.memoryRegistry.getStore().init();
    await runtimeServices.memoryRegistry.add({
      cls: 'runbook',
      summary: 'Keep knowledge intent semantics explicit for foundation consumers.',
      tags: ['knowledge', 'foundation'],
      provenance: [{ kind: 'file', ref: 'src/knowledge/knowledge-api.ts' }],
      review: { state: 'reviewed', confidence: 93 },
    });
    const explain = await api.memory?.explain('update knowledge api', ['src/knowledge']);
    expect(explain?.injections[0]).toMatchObject({
      trustTier: 'reviewed',
      useAs: 'reference-material',
      retention: 'task-only',
      provenance: {
        source: 'project-memory',
        links: [{ kind: 'file', ref: 'src/knowledge/knowledge-api.ts' }],
      },
    });
    expect(explain?.prompt).toContain('Explicit semantics');
  });

  test('surfaces ingest, packets, projections, jobs, and consolidation through grouped domains', async () => {
    const runtimeServices = getTestRuntimeServices();
    readings.use({});
    const api = createKnowledgeApi(runtimeServices.knowledgeService);
    const artifact = await runtimeServices.artifactStore.create({
      filename: 'knowledge-api.txt',
      kind: 'document',
      text: 'GoodVibes knowledge api artifact body',
    });

    const ingest = await api.ingest.artifact({
      artifactId: artifact.id,
      title: 'Knowledge API Artifact',
      tags: ['sdk-ready'],
      fetchMode: 'public-only',
    });
    expect(ingest.source.id.length).toBeGreaterThan(0);
    expect(ingest.source.metadata).toMatchObject({
      knowledgeIntent: {
        ingestMode: 'artifact',
        remoteFetchMode: 'public-only',
      },
    });

    const packet = await withPublicKnowledgeReadings(['Knowledge API Artifact'], ['GoodVibes knowledge api artifact body'],
      () => api.packets.build('knowledge api artifact', [], 5, { budgetLimit: 2_000 }));
    expect(packet.items.length).toBeGreaterThan(0);

    const targets = await api.projections.listTargets(10);
    expect(targets.length).toBeGreaterThan(0);

    const jobs = api.jobs.list();
    expect(jobs.length).toBeGreaterThan(0);
    const job = jobs[0]!;
    expect(api.jobs.get(job.id)?.id).toBe(job.id);

    const run = await api.jobs.run(job.id, { mode: 'inline' });
    expect(run.jobId).toBe(job.id);
    expect(api.jobs.runs(10, job.id)).toContainEqual(
      expect.objectContaining({ id: run.id }),
    );

    const candidates = api.consolidation.candidates(10);
    expect(candidates).toEqual(expect.any(Array));
    expect(api.consolidation.reports(10)).toEqual(expect.any(Array));
  });
});

const readings = useMemoryReadings();

import { describe, expect, test } from 'bun:test';
import type { ArtifactCreateInput, ArtifactDescriptor, ArtifactRecord, ArtifactStore } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import {
  createAgentReviewPacketPresetsTool,
  registerAgentReviewPacketPresetsTool,
} from '../../tools/agent-review-packet-presets-tool.ts';

function artifactStore() {
  const inputs: ArtifactCreateInput[] = [];
  const records: ArtifactRecord[] = [];
  const contents = new Map<string, Buffer>();
  const addArtifact = (input: {
    readonly id: string;
    readonly createdAt: number;
    readonly purpose: string;
    readonly filename?: string;
    readonly metadata?: Record<string, unknown>;
  }): ArtifactRecord => {
    const buffer = Buffer.from(`${input.id}\n`, 'utf-8');
    const record: ArtifactRecord = {
      id: input.id,
      kind: 'data',
      mimeType: 'application/json',
      filename: input.filename ?? `${input.id}.json`,
      sizeBytes: buffer.byteLength,
      sha256: `sha-${input.id}`,
      createdAt: input.createdAt,
      acquisitionMode: 'inline-data',
      fetchMode: 'not-applicable',
      metadata: { purpose: input.purpose, ...(input.metadata ?? {}) },
      contentPath: `/tmp/${input.id}.json`,
      metadataPath: `/tmp/${input.id}.metadata.json`,
    };
    records.push(record);
    contents.set(input.id, buffer);
    return record;
  };
  const store: Pick<ArtifactStore, 'create' | 'list' | 'readContent'> = {
    async create(input: ArtifactCreateInput): Promise<ArtifactDescriptor> {
      inputs.push(input);
      const id = `artifact-${inputs.length}`;
      const buffer = Buffer.from(input.text ?? '', 'utf-8');
      const record: ArtifactRecord = {
        id,
        kind: input.kind ?? 'data',
        mimeType: input.mimeType ?? 'application/json',
        filename: input.filename,
        sizeBytes: buffer.byteLength,
        sha256: `sha-${inputs.length}`,
        createdAt: Date.now() + inputs.length,
        acquisitionMode: 'inline-data',
        fetchMode: 'not-applicable',
        metadata: input.metadata ?? {},
        contentPath: `/tmp/${id}.json`,
        metadataPath: `/tmp/${id}.metadata.json`,
      };
      records.push(record);
      contents.set(id, buffer);
      return record;
    },
    list(limit = 100): ArtifactDescriptor[] {
      return [...records].reverse().slice(0, limit);
    },
    async readContent(id: string): Promise<{ record: ArtifactRecord; buffer: Buffer }> {
      const record = records.find((entry) => entry.id === id);
      const buffer = contents.get(id);
      if (!record || !buffer) throw new Error(`Unknown artifact: ${id}`);
      return { record, buffer };
    },
  };
  return { addArtifact, inputs, records, store };
}

describe('agent_review_packet_presets tool', () => {
  test('previews preset saves until explicitly confirmed', async () => {
    const artifacts = artifactStore();
    const tool = createAgentReviewPacketPresetsTool(artifacts.store);

    const result = await tool.execute({
      mode: 'save',
      name: 'Launch review packet',
      documentId: 'doc_launch',
      revealedJudgmentArtifactId: 'artifact-judge',
      relatedArtifactIds: ['artifact-doc', 'artifact-route'],
      explicitUserRequest: 'Save this packet preset.',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Agent review packet preset preview');
    expect(result.error).toContain('confirmation required');
    expect(artifacts.inputs).toHaveLength(0);
  });

  test('saves, lists, and shows reusable review packet presets', async () => {
    const artifacts = artifactStore();
    const tool = createAgentReviewPacketPresetsTool(artifacts.store);

    const saved = await tool.execute({
      mode: 'save',
      name: 'Launch review packet',
      documentId: 'doc_launch',
      documentTitle: 'Launch Plan',
      documentExportArtifactId: 'artifact-doc',
      comparisonArtifactId: 'artifact-compare',
      judgmentArtifactId: 'artifact-judge-hidden',
      revealedJudgmentArtifactId: 'artifact-judge',
      routeDecisionArtifactId: 'artifact-route',
      routeDecision: 'left-unchanged',
      handoffArtifactId: 'artifact-handoff',
      handoffArchiveArtifactId: 'artifact-archive',
      relatedArtifactIds: ['artifact-doc', 'artifact-route'],
      summary: 'document doc_launch; source artifact-judge; handoff artifact-handoff; 2 related',
      confirm: true,
      explicitUserRequest: 'Save this packet preset.',
    });

    expect(saved.success).toBe(true);
    expect(saved.output).toContain('Review packet preset saved');
    expect(saved.output).toContain('agent_review_packet_presets mode:"show" artifactId:"artifact-1"');
    expect(artifacts.records[0]?.metadata).toMatchObject({
      purpose: 'agent-review-packet-preset',
      name: 'Launch review packet',
      documentId: 'doc_launch',
      revealedJudgmentArtifactId: 'artifact-judge',
      routeDecisionArtifactId: 'artifact-route',
      handoffArtifactId: 'artifact-handoff',
      handoffArchiveArtifactId: 'artifact-archive',
      relatedArtifactIds: ['artifact-doc', 'artifact-route'],
    });

    const stored = await artifacts.store.readContent('artifact-1');
    const body = JSON.parse(stored.buffer.toString('utf-8')) as {
      readonly schema: string;
      readonly policy: { readonly modelRouteChanged: boolean };
      readonly packet: { readonly documentId: string; readonly relatedArtifactIds: readonly string[] };
    };
    expect(body.schema).toBe('goodvibes-agent.review-packet-preset');
    expect(body.policy.modelRouteChanged).toBe(false);
    expect(body.packet.documentId).toBe('doc_launch');
    expect(body.packet.relatedArtifactIds).toEqual(['artifact-doc', 'artifact-route']);

    const listed = await tool.execute({ mode: 'list' });
    expect(listed.success).toBe(true);
    expect(listed.output).toContain('Launch review packet');
    expect(listed.output).toContain('artifact-handoff');

    const shown = await tool.execute({ mode: 'show', artifactId: 'artifact-1' });
    expect(shown.success).toBe(true);
    expect(shown.output).toContain('Saved review packet preset');
    expect(shown.output).toContain('sideBySide agent_model_compare mode:"sideBySide" artifactId:"artifact-judge"');
    expect(shown.output).toContain('handoff agent_model_compare mode:"handoff" artifactId:"artifact-judge"');
    expect(shown.output).toContain('routeDecision agent_model_compare mode:"routeDecision" artifactId:"artifact-judge"');
    expect(shown.output).toContain('archive agent_model_compare mode:"handoffArchive" artifactId:"artifact-handoff"');
  });

  test('audits preset freshness and routes reuse through newer matching evidence', async () => {
    const artifacts = artifactStore();
    artifacts.addArtifact({
      id: 'doc-old',
      createdAt: 1_000,
      purpose: 'agent-document-export',
      metadata: { documentId: 'doc_launch', versionId: 'v1' },
    });
    artifacts.addArtifact({
      id: 'compare-old',
      createdAt: 2_000,
      purpose: 'agent-model-compare',
      metadata: { comparisonId: 'cmp_launch', documentId: 'doc_launch', sourceArtifactId: 'doc-old' },
    });
    artifacts.addArtifact({
      id: 'judge-old',
      createdAt: 3_000,
      purpose: 'agent-model-compare-judgment',
      metadata: { comparisonId: 'cmp_launch', documentId: 'doc_launch', sourceArtifactId: 'doc-old', revealIncludedInJudgment: true, winnerModel: 'openai:gpt-5' },
    });
    artifacts.addArtifact({
      id: 'route-old',
      createdAt: 4_000,
      purpose: 'agent-model-compare-route-decision',
      metadata: { comparisonId: 'cmp_launch', judgmentArtifactId: 'judge-old', decision: 'left-unchanged' },
    });
    artifacts.addArtifact({
      id: 'handoff-old',
      createdAt: 5_000,
      purpose: 'agent-model-compare-handoff',
      metadata: { comparisonId: 'cmp_launch', sourceArtifactId: 'judge-old', sourceKind: 'judgment', relatedArtifactIds: ['doc-old'] },
    });
    artifacts.addArtifact({
      id: 'archive-old',
      createdAt: 6_000,
      purpose: 'agent-model-compare-handoff-archive',
      metadata: { comparisonId: 'cmp_launch', handoffArtifactId: 'handoff-old', sourceArtifactId: 'judge-old' },
    });
    artifacts.addArtifact({
      id: 'doc-new',
      createdAt: 7_000,
      purpose: 'agent-document-export',
      metadata: { documentId: 'doc_launch', versionId: 'v2' },
    });
    artifacts.addArtifact({
      id: 'compare-new',
      createdAt: 8_000,
      purpose: 'agent-model-compare',
      metadata: { comparisonId: 'cmp_launch_2', documentId: 'doc_launch', sourceArtifactId: 'doc-new' },
    });
    artifacts.addArtifact({
      id: 'judge-new',
      createdAt: 9_000,
      purpose: 'agent-model-compare-judgment',
      metadata: { comparisonId: 'cmp_launch', documentId: 'doc_launch', sourceArtifactId: 'doc-new', revealIncludedInJudgment: true, winnerModel: 'openai:gpt-5.5' },
    });
    artifacts.addArtifact({
      id: 'route-new',
      createdAt: 10_000,
      purpose: 'agent-model-compare-route-decision',
      metadata: { comparisonId: 'cmp_launch', judgmentArtifactId: 'judge-old', decision: 'applied-winner' },
    });
    artifacts.addArtifact({
      id: 'handoff-new',
      createdAt: 11_000,
      purpose: 'agent-model-compare-handoff',
      metadata: { comparisonId: 'cmp_launch', sourceArtifactId: 'judge-new', sourceKind: 'judgment', relatedArtifactIds: ['doc-new'] },
    });
    artifacts.addArtifact({
      id: 'archive-new',
      createdAt: 12_000,
      purpose: 'agent-model-compare-handoff-archive',
      metadata: { comparisonId: 'cmp_launch', handoffArtifactId: 'handoff-new', sourceArtifactId: 'judge-new' },
    });
    const tool = createAgentReviewPacketPresetsTool(artifacts.store);

    await tool.execute({
      mode: 'save',
      name: 'Launch stale packet',
      documentId: 'doc_launch',
      documentExportArtifactId: 'doc-old',
      comparisonArtifactId: 'compare-old',
      revealedJudgmentArtifactId: 'judge-old',
      routeDecisionArtifactId: 'route-old',
      routeDecision: 'left-unchanged',
      handoffArtifactId: 'handoff-old',
      handoffArchiveArtifactId: 'archive-old',
      relatedArtifactIds: ['doc-old'],
      confirm: true,
      explicitUserRequest: 'Save this packet preset.',
    });

    const listed = await tool.execute({ mode: 'list' });
    expect(listed.success).toBe(true);
    expect(listed.output).toContain('Launch stale packet');
    expect(listed.output).toContain('freshness needs-review');

    const shown = await tool.execute({ mode: 'show', artifactId: 'artifact-1' });
    expect(shown.success).toBe(true);
    expect(shown.output).toContain('newer document export doc-old -> doc-new');
    expect(shown.output).toContain('newer revealed judgment judge-old -> judge-new');
    expect(shown.output).toContain('sideBySide agent_model_compare mode:"sideBySide" artifactId:"judge-new" relatedArtifactIds:["doc-new"]');
    expect(shown.output).toContain('routeDecision agent_model_compare mode:"routeDecision" artifactId:"judge-new"');
    expect(shown.output).toContain('archive agent_model_compare mode:"handoffArchive" artifactId:"handoff-new"');
    expect(shown.output).toContain('inspectArchive agent_artifacts mode:"show" artifactId:"archive-new"');
  });

  test('reports missing preset artifact ids and recommends replacements when metadata is sufficient', async () => {
    const artifacts = artifactStore();
    artifacts.addArtifact({
      id: 'doc-new',
      createdAt: 7_000,
      purpose: 'agent-document-export',
      metadata: { documentId: 'doc_launch', versionId: 'v2' },
    });
    const tool = createAgentReviewPacketPresetsTool(artifacts.store);

    await tool.execute({
      mode: 'save',
      name: 'Missing packet',
      documentId: 'doc_launch',
      documentExportArtifactId: 'doc-missing',
      confirm: true,
      explicitUserRequest: 'Save this packet preset.',
    });

    const shown = await tool.execute({ mode: 'show', artifactId: 'artifact-1' });
    expect(shown.success).toBe(true);
    expect(shown.output).toContain('missing document export doc-missing; recommended doc-new');
  });

  test('refreshes stale presets into new local preset artifacts from freshness recommendations', async () => {
    const artifacts = artifactStore();
    artifacts.addArtifact({
      id: 'doc-old',
      createdAt: 1_000,
      purpose: 'agent-document-export',
      metadata: { documentId: 'doc_launch', versionId: 'v1' },
    });
    artifacts.addArtifact({
      id: 'doc-new',
      createdAt: 2_000,
      purpose: 'agent-document-export',
      metadata: { documentId: 'doc_launch', versionId: 'v2' },
    });
    const tool = createAgentReviewPacketPresetsTool(artifacts.store);

    await tool.execute({
      mode: 'save',
      name: 'Launch packet',
      documentId: 'doc_launch',
      documentExportArtifactId: 'doc-old',
      relatedArtifactIds: ['doc-old'],
      summary: 'document doc_launch; source doc-old; 1 related',
      confirm: true,
      explicitUserRequest: 'Save this packet preset.',
    });

    const shown = await tool.execute({ mode: 'show', artifactId: 'artifact-1' });
    expect(shown.success).toBe(true);
    expect(shown.output).toContain('refreshPreset agent_review_packet_presets mode:"refresh" artifactId:"artifact-1"');

    const preview = await tool.execute({
      mode: 'refresh',
      artifactId: 'artifact-1',
      explicitUserRequest: 'Refresh this stale packet preset.',
    });
    expect(preview.success).toBe(false);
    expect(preview.error).toContain('Agent review packet preset refresh preview');
    expect(preview.error).toContain('documentExport doc-new');
    expect(artifacts.inputs).toHaveLength(1);

    const refreshed = await tool.execute({
      mode: 'refresh',
      artifactId: 'artifact-1',
      name: 'Launch packet refreshed',
      confirm: true,
      explicitUserRequest: 'Refresh this stale packet preset.',
    });
    expect(refreshed.success).toBe(true);
    expect(refreshed.output).toContain('Review packet preset refreshed');
    expect(refreshed.output).toContain('refreshedFrom artifact-1');
    expect(refreshed.output).toContain('documentExport doc-new');
    expect(refreshed.output).toContain('freshness repaired 1; unresolved 0');
    expect(artifacts.records.at(-1)?.metadata).toMatchObject({
      purpose: 'agent-review-packet-preset',
      name: 'Launch packet refreshed',
      documentId: 'doc_launch',
      documentExportArtifactId: 'doc-new',
      relatedArtifactIds: ['doc-new'],
      refreshOfArtifactId: 'artifact-1',
      freshnessMissingCount: 0,
      freshnessSupersededCount: 1,
      freshnessUnresolvedCount: 0,
    });

    const stored = await artifacts.store.readContent('artifact-2');
    const body = JSON.parse(stored.buffer.toString('utf-8')) as {
      readonly refresh: { readonly sourceArtifactId: string; readonly supersededCount: number };
      readonly packet: { readonly documentExportArtifactId: string; readonly relatedArtifactIds: readonly string[]; readonly summary: string };
    };
    expect(body.refresh.sourceArtifactId).toBe('artifact-1');
    expect(body.refresh.supersededCount).toBe(1);
    expect(body.packet.documentExportArtifactId).toBe('doc-new');
    expect(body.packet.relatedArtifactIds).toEqual(['doc-new']);
    expect(body.packet.summary).toContain('source doc-new');
  });

  test('refresh mode does not create a duplicate artifact when the preset is current', async () => {
    const artifacts = artifactStore();
    artifacts.addArtifact({
      id: 'doc-current',
      createdAt: 1_000,
      purpose: 'agent-document-export',
      metadata: { documentId: 'doc_launch', versionId: 'v1' },
    });
    const tool = createAgentReviewPacketPresetsTool(artifacts.store);

    await tool.execute({
      mode: 'save',
      name: 'Current packet',
      documentId: 'doc_launch',
      documentExportArtifactId: 'doc-current',
      confirm: true,
      explicitUserRequest: 'Save this packet preset.',
    });

    const refreshed = await tool.execute({
      mode: 'refresh',
      artifactId: 'artifact-1',
      confirm: true,
      explicitUserRequest: 'Refresh this packet preset.',
    });
    expect(refreshed.success).toBe(true);
    expect(refreshed.output).toContain('Review packet preset already current');
    expect(refreshed.output).toContain('no new preset artifact created');
    expect(artifacts.inputs).toHaveLength(1);
  });

  test('registers the preset tool', () => {
    const registry = new ToolRegistry();
    registerAgentReviewPacketPresetsTool(registry, artifactStore().store);

    expect(registry.has('agent_review_packet_presets')).toBe(true);
  });
});

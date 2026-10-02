import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { ArtifactDescriptor, ArtifactRecord, ArtifactStore } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import type { ChannelDeliveryRequest } from '@goodvibes-jev/engine/sdk/platform/channels';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import {
  createAgentReviewPacketShareTool,
  registerAgentReviewPacketShareTool,
} from '../../tools/agent-review-packet-share-tool.ts';

function fakeRouter(requests: ChannelDeliveryRequest[]) {
  return {
    listStrategies: () => [{ id: 'fake-channel', canHandle: () => true, deliver: async () => ({}) }],
    deliver: async (request: ChannelDeliveryRequest) => {
      requests.push(request);
      return 'review-packet-share-1';
    },
  };
}

function archiveRecord(overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    id: 'artifact-archive',
    kind: 'archive',
    mimeType: 'application/zip',
    filename: 'blind-model-comparison-handoff-archive.zip',
    sizeBytes: 2048,
    sha256: 'sha-archive',
    createdAt: Date.now(),
    acquisitionMode: 'inline-data',
    fetchMode: 'not-applicable',
    metadata: {
      purpose: 'agent-model-compare-handoff-archive',
      archiveId: 'hndarc_launch',
      handoffArtifactId: 'artifact-handoff',
      handoffId: 'hnd_launch',
      sourceArtifactId: 'artifact-judgment',
      sourceKind: 'judgment',
      relatedArtifactIds: ['artifact-doc', 'artifact-source'],
      routeDecisionArtifactIds: ['artifact-route'],
      includedArtifactIds: ['artifact-handoff', 'artifact-judgment', 'artifact-doc', 'artifact-source', 'artifact-route'],
      comparisonId: 'cmp_launch',
      artifactCount: 5,
      archiveBytes: 4096,
      revealIncludedInHandoff: true,
    },
    contentPath: '/tmp/archive.zip',
    metadataPath: '/tmp/archive.json',
    ...overrides,
  };
}

function artifactStore(records: ArtifactRecord[] = [archiveRecord()]) {
  const store: Pick<ArtifactStore, 'get' | 'list' | 'readContent'> = {
    get(id: string): ArtifactDescriptor | null {
      return records.find((record) => record.id === id) ?? null;
    },
    list(limit = 100): ArtifactDescriptor[] {
      return records.slice(0, limit);
    },
    async readContent(id: string): Promise<{ record: ArtifactRecord; buffer: Buffer }> {
      const record = records.find((entry) => entry.id === id);
      if (!record) throw new Error(`Unknown artifact: ${id}`);
      return { record, buffer: Buffer.from('zip-bytes-never-printed') };
    },
  };
  return store;
}

describe('agent_review_packet_share tool', () => {
  let previousPort: ReturnType<typeof installJudgmentPort>;
  let readings: ReturnType<typeof fakePort>;
  let cardProbability: number;

  beforeEach(() => {
    cardProbability = 0.03;
    readings = fakePort((name, _question, state) => {
      if (name !== 'security_code') throw new Error(`Unexpected packet-share question: ${name}`);
      expect(String(state)).toContain('Reviewer packet evidence:');
      expect(String(state)).toContain('#### bytes');
      return noulAnswer(cardProbability);
    });
    previousPort = installJudgmentPort(readings.port);
  });

  afterEach(() => {
    installJudgmentPort(previousPort);
  });

  test('previews archive delivery without sending when confirmation is missing', async () => {
    const requests: ChannelDeliveryRequest[] = [];
    const tool = createAgentReviewPacketShareTool(artifactStore(), fakeRouter(requests));

    const result = await tool.execute({
      archiveArtifactId: 'artifact-archive',
      channel: 'slack:review:Review',
      explicitUserRequest: 'Share this review packet.',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Agent review packet share preview');
    expect(result.error).toContain('artifact-archive');
    expect(result.error).toContain('cmp_launch');
    expect(result.error).toContain('slack');
    expect(result.error).toContain('confirmation required');
    expect(result.error).not.toContain('zip-bytes-never-printed');
    expect(readings.requests).toHaveLength(0);
    expect(requests).toEqual([]);
  });

  test('sends one plain-text archive reference after explicit confirmation', async () => {
    const requests: ChannelDeliveryRequest[] = [];
    const tool = createAgentReviewPacketShareTool(artifactStore(), fakeRouter(requests));

    const result = await tool.execute({
      archiveArtifactId: 'artifact-archive',
      title: 'Launch packet',
      message: 'Please review the final packet.',
      channel: 'slack:review:Review',
      confirm: true,
      explicitUserRequest: 'Share this review packet with the review channel.',
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('Agent review packet shared');
    expect(result.output).toContain('review-packet-share-1');
    expect(result.output).toContain('agent_artifacts mode:"export" artifactId:"artifact-archive"');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.target).toMatchObject({ kind: 'surface', surfaceKind: 'slack', routeId: 'review', label: 'Review' });
    expect(requests[0]?.title).toBe('Launch packet');
    expect(requests[0]?.body).toContain('Please review the final packet.');
    expect(requests[0]?.body).toContain('Archive: artifact-archive');
    expect(requests[0]?.body).toContain('Included artifacts: 5');
    expect(requests[0]?.body).not.toContain('zip-bytes-never-printed');
    expect(readings.requests).toHaveLength(1);
    expect(Object.keys(readings.requests[0]!.questions)).toEqual(['security_code']);
  });

  test('a card-material reading refuses even a confirmed share without sending', async () => {
    cardProbability = 0.97;
    const requests: ChannelDeliveryRequest[] = [];
    const tool = createAgentReviewPacketShareTool(artifactStore(), fakeRouter(requests));
    const result = await tool.execute({
      archiveArtifactId: 'artifact-archive',
      channel: 'slack:review:Review',
      confirm: true,
      explicitUserRequest: 'Share this review packet with the review channel.',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("I can't take card details over slack");
    expect(result.error).not.toContain('4096');
    expect(requests).toEqual([]);
    expect(readings.requests).toHaveLength(1);
  });

  test('rejects non-handoff archive artifacts without delivery', async () => {
    const requests: ChannelDeliveryRequest[] = [];
    const tool = createAgentReviewPacketShareTool(artifactStore([
      archiveRecord({
        id: 'artifact-other',
        metadata: { purpose: 'agent-document-export' },
      }),
    ]), fakeRouter(requests));

    const result = await tool.execute({
      archiveArtifactId: 'artifact-other',
      channel: 'slack:review:Review',
      confirm: true,
      explicitUserRequest: 'Share this review packet.',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('requires a saved reviewer handoff archive');
    expect(requests).toEqual([]);
  });

  test('requires explicit user request and registers in the tool registry', async () => {
    const requests: ChannelDeliveryRequest[] = [];
    const tool = createAgentReviewPacketShareTool(artifactStore(), fakeRouter(requests));

    const result = await tool.execute({
      archiveArtifactId: 'artifact-archive',
      channel: 'slack:review:Review',
      confirm: true,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('explicitUserRequest is required');
    expect(requests).toEqual([]);
    expect(readings.requests).toHaveLength(0);

    const registry = new ToolRegistry();
    registerAgentReviewPacketShareTool(registry, artifactStore(), fakeRouter(requests));
    expect(registry.has('agent_review_packet_share')).toBe(true);
  });
});

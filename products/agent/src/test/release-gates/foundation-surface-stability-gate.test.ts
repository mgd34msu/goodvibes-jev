import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import * as Knowledge from '@goodvibes-jev/engine/sdk/platform/knowledge';
import * as Providers from '@goodvibes-jev/engine/sdk/platform/providers';
import type { KnowledgeApi } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import type { ProviderApi } from '@goodvibes-jev/engine/sdk/platform/providers';
import {
  createDirectTransportServices,
  createOperatorClientServices,
  createPeerClientDependencies,
} from '@/runtime/index.ts';
import { createOperatorClient, type OperatorClient } from '@/runtime/index.ts';
import { createPeerClient, type PeerClient } from '@/runtime/index.ts';
import {
  createDirectTransport,
  createDirectTransportFromServices,
  type DirectTransport,
} from '@/runtime/index.ts';
import { getTestRuntimeServices, resetTestRuntimeServices } from '../helpers/runtime-services.ts';

function resetPeerFoundationState(): void {
  const services = getTestRuntimeServices();
  services.distributedRuntime.pairRequests.clear();
  services.distributedRuntime.peers.clear();
  services.distributedRuntime.work.clear();
  services.distributedRuntime.audit.length = 0;
  services.distributedRuntime.waiters.clear();
  services.distributedRuntime.loaded = true;
  services.remoteRunnerRegistry.clear();
}

function sortedKeys(value: object): string[] {
  return Object.keys(value).slice().sort((left, right) => left.localeCompare(right));
}

describe('foundation surface stability gate', () => {
  let previousPort: ReturnType<typeof installJudgmentPort> | undefined;
  beforeEach(() => {
    resetTestRuntimeServices();
  });

  afterEach(() => {
    if (previousPort) installJudgmentPort(previousPort);
    previousPort = undefined;
    resetTestRuntimeServices();
  });

  test('foundation surfaces support one coherent in-process consumer workflow', async () => {
    const runtimeServices = getTestRuntimeServices();
    resetPeerFoundationState();
    const note = '# Foundation Surface Note\n\nThis note proves the in-process knowledge API remains consumable.\n';
    const rejected: string[] = [];
    const readings = fakePort((name, question, state) => {
      const facts = state as { filename?: string; mimeType?: string; sample?: string };
      if (name === 'kind' && facts.filename === 'foundation-surface-note.md' && facts.mimeType === 'text/markdown') {
        return choiceAnswer(question, 'document', 0.99);
      }
      if (name === 'readable' && facts.sample === note) return noulAnswer(0.99);
      if (name === 'wanted') {
        const extraction = state as { query: string; subjects: string[]; text: string; source: unknown; extraction: unknown; category: { title: string } };
        expect(extraction.query).toBe('complete features specifications capabilities');
        expect(extraction.subjects).toEqual([]);
        expect(extraction.source).toEqual({ title: 'Foundation Surface Note', sourceType: 'document' });
        expect(extraction.extraction).toEqual({ format: 'markdown', title: 'Foundation Surface Note' });
        expect(extraction.text).toBe(`Foundation Surface Note\n\n${note}\n${note}\nFoundation Surface Note\n\n${note.trimEnd()}`);
        expect([
          'Display and picture specifications', 'Input and output ports',
          'Smart TV platform and integrations', 'Network and wireless capabilities',
        ]).toContain(extraction.category.title);
        // This consumer-workflow note contains no device features/specifications.
        return noulAnswer(0.01);
      }
      rejected.push(`${name}:${JSON.stringify(state)}`);
      throw new Error(`Unexpected foundation reading: ${name}`);
    });
    previousPort = installJudgmentPort(readings.port);
    const configDir = runtimeServices.configManager.getControlPlaneConfigDir();
    for (const gateway of ['aihubmix', 'vercel-ai-gateway']) {
      writeFileSync(join(configDir, `gateway-pricing-${gateway}.json`), JSON.stringify({
        version: 1, fetchedAt: Date.now(), ttlMs: 86_400_000, models: {},
      }));
    }
    const foundationServices = {
      operator: createOperatorClientServices(runtimeServices.asDaemonGradeView()),
      peer: createPeerClientDependencies(runtimeServices),
    };

    const operator: OperatorClient = createOperatorClient(foundationServices.operator);
    const peer: PeerClient = createPeerClient(foundationServices.peer);
    const transport: DirectTransport = createDirectTransportFromServices(foundationServices);
    const providers: ProviderApi = Providers.createProviderApi({
      providerRegistry: runtimeServices.providerRegistry,
      favoritesStore: runtimeServices.favoritesStore,
      benchmarkStore: runtimeServices.benchmarkStore,
    });
    const knowledge: KnowledgeApi = Knowledge.createKnowledgeApi(runtimeServices.knowledgeService);

    const session = await operator.sessions.ensureSession({
      sessionId: 'foundation-surface-session',
      title: 'Foundation Surface Session',
      participant: {
        surfaceKind: 'tui',
        surfaceId: 'foundation-shell',
        lastSeenAt: 123,
      },
    });
    expect(operator.sessions.get(session.id)?.title).toBe('Foundation Surface Session');
    expect(operator.controlPlane.snapshot().sessions.map((entry) => entry.id)).toContain(session.id);

    const providerIds = providers.listProviderIds();
    const currentModel = await providers.getCurrentModel();
    const selectableModels = await providers.listModels({ selectableOnly: true });
    const favorites = await providers.getFavorites();
    const runtimeMetadata = await providers.queryRuntimeMetadata({ scope: 'all' });
    expect(providerIds.length).toBeGreaterThan(0);
    expect(providerIds).toContain(currentModel.providerId);
    expect(selectableModels.map((model) => model.selectable)).not.toContain(false);
    expect(favorites.pinned).toEqual([]);
    expect(favorites.recent).toEqual([]);
    expect(runtimeMetadata.scope).toBe('all');
    if (runtimeMetadata.scope !== 'all') {
      throw new Error(`Expected all runtime metadata scope, received ${runtimeMetadata.scope}`);
    }
    expect(runtimeMetadata.snapshots.length).toBeGreaterThanOrEqual(providerIds.length);
    const legacyTransport = createDirectTransport(runtimeServices.asDaemonGradeView());
    expect(sortedKeys(legacyTransport.operator)).toEqual(sortedKeys(transport.operator));
    expect(sortedKeys(legacyTransport.peer)).toEqual(sortedKeys(transport.peer));

    const artifactPath = join(runtimeServices.shellPaths.workingDirectory, 'foundation-surface-note.md');
    writeFileSync(artifactPath, note, 'utf-8');
    const ingest = await knowledge.ingest.artifact({
      path: artifactPath,
      connectorId: 'artifact',
      sessionId: session.id,
      tags: ['foundation-surface'],
    });
    expect(knowledge.sources.list(10).map((source) => source.id)).toContain(ingest.source.id);

    const packet = await knowledge.packets.build('foundation surface note', [], 5, { budgetLimit: 2_000 });
    expect(packet.items.length).toBeGreaterThan(0);
    const status = await knowledge.status.get();
    expect(status.ready).toBe(true);
    expect(rejected).toEqual([]);
    expect(readings.requests.length).toBeGreaterThan(0);

    const pair = await peer.pairing.request({
      peerKind: 'node',
      label: 'foundation-surface-peer',
      requestedId: 'foundation-surface-peer',
      requestedBy: 'operator',
      capabilities: ['invoke'],
      commands: ['status'],
    });
    await peer.pairing.approve(pair.request.id, { actor: 'operator', note: 'approved by release gate' });
    const verified = await peer.pairing.verify(pair.request.id, pair.challenge, {
      remoteAddress: '10.10.0.20',
    });
    if (verified === null) throw new Error('expected foundation peer verification to succeed');
    expect(verified.peer.status).toBe('connected');

    const transportSnapshot = await transport.snapshot();
    expect(transport.kind).toBe('direct');
    expect(transportSnapshot.kind).toBe('direct');
    expect(transportSnapshot.operator.sessions.map((entry) => entry.id)).toContain(session.id);
    expect(transportSnapshot.operator.providers.providerIds).toEqual(transport.operator.providers.listIds());
    expect(transportSnapshot.peer.peers.map((entry) => entry.id)).toContain(verified.peer.id);
    expect(transportSnapshot.peer.nodeHostContract.basePath).toBe('/api/remote');
  });
});

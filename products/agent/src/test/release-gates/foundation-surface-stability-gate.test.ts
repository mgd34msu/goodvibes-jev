import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  beforeEach(() => {
    resetTestRuntimeServices();
  });

  afterEach(() => {
    resetTestRuntimeServices();
  });

  test('foundation surfaces support one coherent in-process consumer workflow', async () => {
    const runtimeServices = getTestRuntimeServices();
    resetPeerFoundationState();
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
    writeFileSync(artifactPath, '# Foundation Surface Note\n\nThis note proves the in-process knowledge API remains consumable.\n', 'utf-8');
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

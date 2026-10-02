import { seedProviderMetadataCacheFixture } from '../helpers/provider-metadata-cache-fixture.ts';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { DaemonServer } from '@goodvibes-jev/engine/sdk/platform/daemon';
import { RuntimeEventBus, createEventEnvelope, type AgentEvent } from '@/runtime/index.ts';
import { createFeatureFlagManager } from '@/runtime/index.ts';
import { createDirectTransport } from '@/runtime/index.ts';
import { createHttpTransport } from '@/runtime/index.ts';
import { createRealtimeTransport } from '@/runtime/index.ts';
import { createAuthenticatedWebSocket } from '../helpers/authenticated-websocket.ts';
import { createRuntimeServices } from '../../runtime/services.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { UserAuthManager } from '@goodvibes-jev/engine/sdk/platform/security';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

type TransportKind = 'direct' | 'http' | 'realtime';

interface TransportHarness {
  readonly kind: TransportKind;
  ensureSession(sessionId: string, title: string): Promise<{ readonly id: string; readonly title?: string }>;
  listSessionIds(): Promise<readonly string[]>;
  getSession(sessionId: string): Promise<{ readonly id: string; readonly title?: string } | null>;
  listProviderIds(): Promise<readonly string[]>;
  requestPairing(): Promise<{ readonly request: { readonly id: string }; readonly challenge: string }>;
  approvePairing(requestId: string): Promise<void>;
  verifyPairing(requestId: string, challenge: string): Promise<{ readonly peer: { readonly id: string } } | null>;
  listPeerIds(): Promise<readonly string[]>;
  nodeHostBasePath(): Promise<string>;
  snapshotKind(): Promise<TransportKind>;
  onAgentSpawning(listener: (event: Extract<AgentEvent, { type: 'AGENT_SPAWNING' }>) => void): () => void;
  waitForEventReady(): Promise<void>;
  emitAgentSpawning(agentId: string, task: string): void;
  dispose(): Promise<void>;
}

const TEST_TOKEN = 'transport-parity-token-abc123';

function createTransportFeatureFlags() {
  const featureFlags = createFeatureFlagManager();
  featureFlags.loadFromConfig({
    flags: {
      'control-plane-gateway': 'enabled',
      'unified-runtime-task': 'enabled',
    },
  });
  return featureFlags;
}

async function waitFor<T>(fn: () => Promise<T | undefined | null> | T | undefined | null, timeoutMs = 3_000, intervalMs = 10): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined && value !== null) return value;
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error('Timed out waiting for value');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function createUserAuth(homeDir: string): UserAuthManager {
  return new UserAuthManager({
    bootstrapFilePath: join(homeDir, 'auth-users.json'),
    bootstrapCredentialPath: join(homeDir, 'auth-bootstrap.txt'),
    users: [{
      username: 'admin',
      passwordHash: UserAuthManager.hashPassword('admin'),
      roles: ['admin'],
    }],
  });
}

function createRuntimeFixture(prefix: string) {
  const tempRoot = makeProjectTempDir(`${prefix}`);
  const workingDir = join(tempRoot, 'workspace');
  const homeDir = join(tempRoot, 'home');
  mkdirSync(workingDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  const runtimeBus = new RuntimeEventBus();
  const configManager = new ConfigManager({ surfaceRoot: 'tui',
    configDir: join(homeDir, '.goodvibes', 'tui'),
    workingDir,
    homeDir,
  });
  seedProviderMetadataCacheFixture({ configManager, homeDirectory: homeDir, workingDirectory: workingDir });
  const runtimeServices = createRuntimeServices({
      // Opt out: this process does not outlive the unawaited sweep.
      modelDiscovery: 'skip',
    runtimeStore: createRuntimeStore(),
    runtimeBus,
    configManager,
    workingDir,
    homeDirectory: homeDir,
    featureFlags: createTransportFeatureFlags(),
    getConversationTitle: () => prefix,
  });
  runtimeServices.distributedRuntime.pairRequests.clear();
  runtimeServices.distributedRuntime.peers.clear();
  runtimeServices.distributedRuntime.work.clear();
  runtimeServices.distributedRuntime.audit.length = 0;
  runtimeServices.distributedRuntime.waiters.clear();
  runtimeServices.distributedRuntime.loaded = true;
  runtimeServices.remoteRunnerRegistry.clear();
  return {
    tempRoot,
    runtimeBus,
    runtimeServices,
    dispose(): void {
      rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

async function createDirectHarness(): Promise<TransportHarness> {
  const fixture = createRuntimeFixture('gv-transport-parity-direct');
  const transport = createDirectTransport(fixture.runtimeServices.asDaemonGradeView());
  return {
    kind: 'direct',
    ensureSession: async (sessionId, title) => await transport.operator.sessions.ensureSession({
      sessionId,
      title,
      participant: {
        surfaceKind: 'tui',
        surfaceId: 'direct-parity',
        lastSeenAt: Date.now(),
      },
    }),
    listSessionIds: async () => transport.operator.sessions.list().map((entry) => entry.id),
    getSession: async (sessionId) => transport.operator.sessions.get(sessionId),
    listProviderIds: async () => transport.operator.providers.listIds(),
    requestPairing: async () => await transport.peer.pairing.request({
      peerKind: 'node',
      label: 'transport parity peer',
      requestedId: 'transport-parity-peer',
      requestedBy: 'operator',
      capabilities: ['invoke'],
      commands: ['sync'],
    }),
    approvePairing: async (requestId) => {
      await transport.peer.pairing.approve(requestId, { actor: 'tester', note: 'approved by parity gate' });
    },
    verifyPairing: async (requestId, challenge) => await transport.peer.pairing.verify(requestId, challenge, {
      remoteAddress: '10.0.0.91',
    }),
    listPeerIds: async () => transport.peer.peers.list().map((entry) => entry.id),
    nodeHostBasePath: async () => transport.peer.getNodeHostContract().basePath,
    snapshotKind: async () => (await transport.snapshot()).kind,
    onAgentSpawning: (listener) => transport.operator.events.agents.on('AGENT_SPAWNING', listener),
    waitForEventReady: async () => {},
    emitAgentSpawning: (agentId, task) => {
      fixture.runtimeBus.emit('agents', createEventEnvelope('AGENT_SPAWNING', {
        type: 'AGENT_SPAWNING',
        agentId,
        task,
      }, {
        source: 'transport-parity-test',
        sessionId: 'transport-parity-session',
      }));
    },
    dispose: async () => {
      fixture.dispose();
    },
  };
}

async function createRemoteHarness(kind: 'http' | 'realtime'): Promise<TransportHarness> {
  const fixture = createRuntimeFixture(`gv-transport-parity-${kind}`);
  let boundPort: number | null = null;
  const serveFactory = ((options: Parameters<typeof Bun.serve>[0]) => {
    const server = Bun.serve({
      ...(options as unknown as Record<string, unknown>),
      port: 0,
      hostname: '127.0.0.1',
    } as unknown as Parameters<typeof Bun.serve>[0]);
    boundPort = server.port ?? null;
    return server;
  }) as typeof Bun.serve;
  const daemon = new DaemonServer({
    port: 0,
    host: '127.0.0.1',
    runtimeServices: fixture.runtimeServices.asDaemonGradeView(),
    userAuth: createUserAuth(join(fixture.tempRoot, 'home')),
    serveFactory,
  });
  daemon.enable({ daemon: true }, TEST_TOKEN);
  await daemon.start();
  if (boundPort === null) {
    throw new Error(`Unable to resolve ${kind} daemon test port`);
  }
  const baseUrl = `http://127.0.0.1:${boundPort}`;
  const transport = kind === 'http'
    ? createHttpTransport({ baseUrl, authToken: TEST_TOKEN })
    : createRealtimeTransport({
      baseUrl,
      authToken: TEST_TOKEN,
      webSocketImpl: createAuthenticatedWebSocket(TEST_TOKEN),
    });

  return {
    kind,
    ensureSession: async (sessionId, title) => await transport.operator.sessions.ensureSession({
      sessionId,
      title,
      participant: {
        surfaceKind: 'web',
        surfaceId: `${kind}-parity`,
      },
    }),
    listSessionIds: async () => (await transport.operator.sessions.list()).map((entry) => entry.id),
    getSession: async (sessionId) => await transport.operator.sessions.get(sessionId),
    listProviderIds: async () => await transport.operator.providers.listIds(),
    requestPairing: async () => await transport.peer.pairing.request({
      peerKind: 'node',
      label: `${kind} parity peer`,
      requestedId: `transport-parity-${kind}-peer`,
      capabilities: ['invoke'],
      commands: ['sync'],
    }),
    approvePairing: async (requestId) => {
      await transport.peer.pairing.approve(requestId, 'tester', 'approved by parity gate');
    },
    verifyPairing: async (requestId, challenge) => await transport.peer.pairing.verify(requestId, challenge, '10.0.0.92'),
    listPeerIds: async () => (await transport.peer.peers.list()).map((entry) => entry.id),
    nodeHostBasePath: async () => (await transport.peer.getNodeHostContract()).basePath,
    snapshotKind: async () => (await transport.snapshot()).kind,
    onAgentSpawning: (listener) => transport.operator.events.agents.on('AGENT_SPAWNING', listener),
    waitForEventReady: async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    },
    emitAgentSpawning: (agentId, task) => {
      fixture.runtimeBus.emit('agents', createEventEnvelope('AGENT_SPAWNING', {
        type: 'AGENT_SPAWNING',
        agentId,
        task,
      }, {
        source: 'transport-parity-test',
        sessionId: 'transport-parity-session',
      }));
    },
    dispose: async () => {
      await daemon.stop();
      fixture.dispose();
    },
  };
}

const activeDisposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (activeDisposers.length > 0) {
    const dispose = activeDisposers.pop();
    if (dispose) await dispose();
  }
});

describe('transport parity gate', () => {
  test('common operator and peer workflows stay transport-compatible across direct, HTTP, and realtime surfaces', async () => {
    const harnesses = await Promise.all([
      createDirectHarness(),
      createRemoteHarness('http'),
      createRemoteHarness('realtime'),
    ]);
    activeDisposers.push(...harnesses.map((harness) => harness.dispose));

    let expectedProviderIds: readonly string[] | null = null;
    for (const harness of harnesses) {
      const session = await harness.ensureSession(`transport-parity-${harness.kind}`, `Transport Parity ${harness.kind}`);
      expect((await harness.listSessionIds())).toContain(session.id);
      expect((await harness.getSession(session.id))?.title).toBe(`Transport Parity ${harness.kind}`);
      const providerIds = await harness.listProviderIds();
      if (expectedProviderIds === null) {
        expectedProviderIds = providerIds;
      } else {
        expect(providerIds).toEqual(expectedProviderIds);
      }

      const pair = await harness.requestPairing();
      await harness.approvePairing(pair.request.id);
      const verified = await harness.verifyPairing(pair.request.id, pair.challenge);
      if (verified === null) throw new Error(`pairing verification failed for ${harness.kind}`);
      expect(verified.peer.id).toMatch(/^node-[a-f0-9]+$/);
      expect(await harness.nodeHostBasePath()).toBe('/api/remote');
      expect(await harness.snapshotKind()).toBe(harness.kind);
      expect(await harness.listPeerIds()).toContain(verified.peer.id);
    }
  });

  test('agent spawning events stay transport-compatible across direct, HTTP, and realtime surfaces', async () => {
    const harnesses = await Promise.all([
      createDirectHarness(),
      createRemoteHarness('http'),
      createRemoteHarness('realtime'),
    ]);
    activeDisposers.push(...harnesses.map((harness) => harness.dispose));

    for (const harness of harnesses) {
      const seen: Array<{ type: string; agentId: string; task: string }> = [];
      const unsubscribe = harness.onAgentSpawning((event) => {
        seen.push({
          type: event.type,
          agentId: event.agentId,
          task: event.task,
        });
      });
      try {
        await harness.waitForEventReady();
        const agentId = `agent-${harness.kind}`;
        const task = `transport parity ${harness.kind}`;
        const event = await waitFor(() => {
          if (!seen[0]) {
            harness.emitAgentSpawning(agentId, task);
          }
          return seen[0];
        }, 5_000, 25).catch((error: unknown) => {
          throw new Error(`${harness.kind} agent spawning event was not observed`, { cause: error });
        });
        expect(event).toEqual({
          type: 'AGENT_SPAWNING',
          agentId,
          task,
        });
      } finally {
        unsubscribe();
      }
    }
  });
});

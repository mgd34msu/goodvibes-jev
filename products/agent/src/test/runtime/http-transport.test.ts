import { seedProviderMetadataCacheFixture } from '../helpers/provider-metadata-cache-fixture.ts';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { DaemonServer } from '@goodvibes-jev/engine/sdk/platform/daemon';
import type { AgentEvent } from '@/runtime/index.ts';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { createFeatureFlagManager } from '@/runtime/index.ts';
import { createHttpTransport } from '@/runtime/index.ts';
import { createRuntimeServices } from '../../runtime/services.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { UserAuthManager } from '@goodvibes-jev/engine/sdk/platform/security';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const TEST_TOKEN = 'http-transport-token-abc123';

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

async function waitFor<T>(fn: () => T | undefined | null, timeoutMs = 2_000, intervalMs = 10): Promise<T> {
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

async function reservePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Unable to reserve test port')));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

describe('HttpTransport', () => {
  let daemon: DaemonServer;
  let tempRoot: string;
  let workingDir: string;
  let homeDir: string;
  let port: number;

  beforeEach(async () => {
    tempRoot = makeProjectTempDir('gv-http-transport');
    workingDir = join(tempRoot, 'workspace');
    homeDir = join(tempRoot, 'home');
    port = await reservePort();
    mkdirSync(workingDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    const configManager = new ConfigManager({ surfaceRoot: 'tui', configDir: join(homeDir, '.goodvibes', 'tui'), workingDir, homeDir });
    seedProviderMetadataCacheFixture({ configManager, homeDirectory: homeDir, workingDirectory: workingDir });
    const runtimeServices = createRuntimeServices({
      // Opt out: this process does not outlive the unawaited sweep.
      modelDiscovery: 'skip',
      runtimeStore: createRuntimeStore(),
      runtimeBus: new RuntimeEventBus(),
      configManager,
      workingDir,
      homeDirectory: homeDir,
      featureFlags: createTransportFeatureFlags(),
      getConversationTitle: () => 'http-transport-test',
    });
    daemon = new DaemonServer({
      port,
      host: '127.0.0.1',
      // The daemon-grade view: this test stands up a REAL DaemonServer to be
      // the host the client half talks to, and a server wants the register.
      runtimeServices: runtimeServices.asDaemonGradeView(),
      userAuth: createUserAuth(homeDir),
    });
  });

  afterEach(async () => {
    await daemon?.stop();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test('exposes the daemon contract over HTTP and SSE', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const transport = createHttpTransport({
      baseUrl: `http://127.0.0.1:${port}`,
      authToken: TEST_TOKEN,
    });

    const session = await transport.operator.sessions.ensureSession({
      sessionId: 'http-transport-session',
      title: 'HTTP Transport Session',
      participant: {
        surfaceKind: 'tui',
        surfaceId: 'http-shell',
      },
    });
    expect(session.id).toBe('http-transport-session');
    expect((await transport.operator.sessions.list()).map((entry) => entry.id)).toContain(session.id);
    const currentAuth = await transport.operator.controlPlane.currentAuth();
    expect(currentAuth.authenticated).toBe(true);
    expect(currentAuth.authMode).toBe('shared-token');
    expect(currentAuth.scopes).toContain('read:control-plane');
    expect(currentAuth.scopes).toContain('read:telemetry');

    const providers = await transport.operator.providers.snapshot();
    expect(providers.providerIds.length).toBeGreaterThanOrEqual(0);
    expect((await transport.peer.getNodeHostContract()).basePath).toBe('/api/remote');

    const pair = await transport.peer.pairing.request({
      peerKind: 'node',
      label: 'http transport peer',
      requestedId: 'http-transport-peer',
      capabilities: ['invoke'],
      commands: ['sync'],
    });
    await transport.peer.pairing.approve(pair.request.id, 'tester', 'paired for http transport test');
    const verified = await transport.peer.pairing.verify(pair.request.id, pair.challenge, '10.0.0.71');
    expect(verified).toEqual(expect.objectContaining({
      peer: expect.objectContaining({
        id: expect.stringMatching(/^node-/),
        requestedId: 'http-transport-peer',
        status: 'connected',
      }),
      token: expect.objectContaining({ value: expect.stringMatching(/^gvrt_/) }),
    }));
    const verifiedPeerId = verified?.peer.id ?? '';

    const invoked = await transport.peer.work.invoke({
      peerId: verifiedPeerId,
      command: 'sync-status',
      payload: { source: 'http-transport-test' },
    });
    expect(invoked.work).toEqual(expect.objectContaining({
      id: expect.stringMatching(/\S/),
      peerId: verifiedPeerId,
      command: 'sync-status',
    }));

    const seen: Array<{ type: string; agentId: string }> = [];
    const streamedTelemetry: string[] = [];
    let telemetryReady = false;
    const unsubscribe = transport.operator.events.agents.on('AGENT_SPAWNING', (event: Extract<AgentEvent, { type: 'AGENT_SPAWNING' }>) => {
      seen.push({ type: event.type, agentId: event.agentId });
    });
    const stopTelemetry = await transport.operator.telemetry.stream({
      onReady: () => {
        telemetryReady = true;
      },
      onRecord: (record) => {
        streamedTelemetry.push(record.type);
      },
    }, { limit: 10 });
    const task = await transport.operator.tasks.submit({ task: 'cancel me over http transport' });
    expect(task).toEqual(expect.objectContaining({
      agentId: expect.stringMatching(/\S/),
    }));
    const taskAgentId = task.agentId ?? '';
    const taskRecord = await waitFor(async () => {
      const tasks = await transport.operator.tasks.list();
      return tasks.find((entry) => entry.title === 'cancel me over http transport') ?? null;
    });
    expect(taskRecord).toEqual(expect.objectContaining({
      id: expect.stringMatching(/\S/),
      title: 'cancel me over http transport',
    }));
    try {
      await waitFor(() => seen[0]);
      await waitFor(() => telemetryReady ? streamedTelemetry[0] : null);
      await transport.operator.tasks.cancel(taskRecord!.id);
    } finally {
      unsubscribe();
      stopTelemetry();
    }

    expect(seen[0]).toEqual({
      type: 'AGENT_SPAWNING',
      agentId: taskAgentId,
    });
    expect(streamedTelemetry.length).toBeGreaterThan(0);
    const telemetrySnapshot = await transport.operator.telemetry.snapshot(10);
    expect(telemetrySnapshot.capabilities.signals.events).toBe(true);
    const telemetryEvents = await transport.operator.telemetry.events(10);
    expect(telemetryEvents.items.length).toBeGreaterThan(0);
    expect(telemetryEvents.view).toBe('safe');
    const telemetryMetrics = await transport.operator.telemetry.metrics();
    expect(telemetryMetrics.aggregates.totalEvents).toBeGreaterThan(0);
    const telemetryLogs = await transport.operator.telemetry.otlpLogs({ limit: 5, view: 'safe' });
    expect((telemetryLogs as { resourceLogs?: unknown[] }).resourceLogs).toEqual(expect.any(Array));
    const snapshot = await transport.snapshot();
    expect(snapshot.kind).toBe('http');
    expect(snapshot.operator.sessions.map((entry: { readonly id: string }) => entry.id)).toContain(session.id);
    expect(snapshot.peer.peers.map((entry: { readonly id: string }) => entry.id)).toContain(verifiedPeerId);
  });
});

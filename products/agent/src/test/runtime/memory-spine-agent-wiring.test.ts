/**
 * The agent's own memory-spine wiring (services.ts's memorySpineClient +
 * memorySpineTransport, and the reconcileMemorySpineAdoption policy bootstrap.ts
 * runs against a real reachability probe). Complements the SDK's generic
 * memory-spine-client tests and this repo's memory-spine-rest-transport tests with
 * proof that THIS agent's construction behaves correctly end to end:
 *
 *  - offline (no daemon configured/reachable): the spine stays local and every op
 *    lands in services.memoryRegistry directly, the hard offline-embedded
 *    requirement.
 *  - adopted (a real daemon, bootDaemon-style on a reserved port, is reachable):
 *    reconcileMemorySpineAdoption activates the spine, every op after that goes
 *    over the wire into the DAEMON's own store, and the agent's own local store is
 *    NEVER touched again (proven with a spy wrapping memoryRegistry.add).
 *  - deactivate-on-loss: stopping the daemon and re-running the SAME reconcile
 *    check hands the spine back to local, proven by a subsequent add() landing
 *    in the agent's own local store again.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { DaemonServer } from '@goodvibes-jev/engine/sdk/platform/daemon';
import { UserAuthManager } from '@goodvibes-jev/engine/sdk/platform/security';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { createFeatureFlagManager } from '@/runtime/index.ts';
import { createRuntimeServices, type RuntimeServices } from '../../runtime/services.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { reconcileMemorySpineAdoption } from '../../runtime/memory-spine-adoption.ts';
import { createSpineConnectionResolver } from '../../runtime/session-spine-rest-transport.ts';
import { createSessionSpineRestProbe as createSpineRestProbe } from '@goodvibes-jev/engine/sdk/platform/runtime/session-spine';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const TEST_TOKEN = 'memory-spine-agent-wiring-token-456';

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

function createUserAuth(homeDir: string): UserAuthManager {
  return new UserAuthManager({
    bootstrapFilePath: join(homeDir, 'auth-users.json'),
    bootstrapCredentialPath: join(homeDir, 'auth-bootstrap.txt'),
    users: [{ username: 'admin', passwordHash: UserAuthManager.hashPassword('admin'), roles: ['admin'] }],
  });
}

function buildAgentServices(homeDir: string, workingDir: string): RuntimeServices {
  return createRuntimeServices({
      // Opt out: this process does not outlive the unawaited sweep.
      modelDiscovery: 'skip',
    runtimeStore: createRuntimeStore(),
    runtimeBus: new RuntimeEventBus(),
    configManager: new ConfigManager({ surfaceRoot: 'agent', configDir: join(homeDir, '.goodvibes', 'agent'), workingDir, homeDir }),
    workingDir,
    homeDirectory: homeDir,
    featureFlags: createFeatureFlagManager(),
    getConversationTitle: () => 'memory-spine-agent-wiring-test',
  });
}

/** A reachability probe against a REAL connection, reusing the same probe the agent uses in production. */
function realReachabilityProbe(services: RuntimeServices, homeDir: string): () => Promise<'unknown' | 'online' | 'offline'> {
  const resolveConnection = createSpineConnectionResolver(services.configManager, homeDir);
  const probe = createSpineRestProbe({ resolveConnection, probeTimeoutMs: 800 });
  return async () => (await probe()) ? 'online' : 'offline';
}

describe('agent memory-spine wiring', () => {
  let agentRoot: string;
  let agentHomeDir: string;
  let agentServices: RuntimeServices;

  beforeEach(async () => {
    agentRoot = makeProjectTempDir('gv-memory-spine-agent');
    agentHomeDir = join(agentRoot, 'agent-home');
    const agentWorkingDir = join(agentRoot, 'agent-workspace');
    mkdirSync(agentHomeDir, { recursive: true });
    mkdirSync(agentWorkingDir, { recursive: true });
    agentServices = buildAgentServices(agentHomeDir, agentWorkingDir);
    await agentServices.memoryStore.init();
    // NEVER rely on the default controlPlane port (3421) to mean "unreachable",
    // this is a real developer machine and a real goodvibes daemon may genuinely be
    // listening there. Point at a freshly reserved-then-released port instead, so
    // "no daemon" is verified, not assumed.
    const unusedPort = await reservePort();
    agentServices.configManager.set('controlPlane.host', '127.0.0.1');
    agentServices.configManager.set('controlPlane.port', unusedPort);
  });

  afterEach(() => {
    rmSync(agentRoot, { recursive: true, force: true });
  });

  test('offline: no daemon reachable: the spine stays local and add() lands in the agent\'s own memoryRegistry', async () => {
    expect(agentServices.memorySpineClient.mode()).toBe('local');

    const probeReachability = realReachabilityProbe(agentServices, agentHomeDir);
    // The reserved port above was released before this probe runs, so nothing is
    // listening there, a genuine "no daemon" case, not an assumption about the
    // default port. The check must leave the spine local, never guess it's adopted.
    await reconcileMemorySpineAdoption({
      memorySpineClient: agentServices.memorySpineClient,
      transport: agentServices.memorySpineTransport,
      probeReachability,
    });
    expect(agentServices.memorySpineClient.mode()).toBe('local');

    const added = await agentServices.memorySpineClient.add({ cls: 'fact', scope: 'project', summary: 'offline embedded write' });
    expect(agentServices.memoryRegistry.get(added.id)?.summary).toBe('offline embedded write');
  });

  describe('with a real daemon reachable', () => {
    let daemon: DaemonServer;
    let daemonServices: RuntimeServices;
    let daemonRoot: string;
    let port: number;

    beforeEach(async () => {
      daemonRoot = makeProjectTempDir('gv-memory-spine-daemon');
      const daemonHomeDir = join(daemonRoot, 'daemon-home');
      const daemonWorkingDir = join(daemonRoot, 'daemon-workspace');
      mkdirSync(daemonHomeDir, { recursive: true });
      mkdirSync(daemonWorkingDir, { recursive: true });
      port = await reservePort();
      daemonServices = createRuntimeServices({
      // Opt out: this process does not outlive the unawaited sweep.
      modelDiscovery: 'skip',
        runtimeStore: createRuntimeStore(),
        runtimeBus: new RuntimeEventBus(),
        configManager: new ConfigManager({ surfaceRoot: 'tui', configDir: join(daemonHomeDir, '.goodvibes', 'tui'), workingDir: daemonWorkingDir, homeDir: daemonHomeDir }),
        workingDir: daemonWorkingDir,
        homeDirectory: daemonHomeDir,
        featureFlags: createFeatureFlagManager(),
        getConversationTitle: () => 'memory-spine-daemon-side',
      });
      daemon = new DaemonServer({ port, host: '127.0.0.1', runtimeServices: daemonServices.asDaemonGradeView(), userAuth: createUserAuth(daemonHomeDir) });
      daemon.enable({ daemon: true }, TEST_TOKEN);
      await daemon.start();

      // Point the AGENT's connection resolver at this real daemon: config + the
      // canonical connected-host operator token path it reads from.
      agentServices.configManager.set('controlPlane.host', '127.0.0.1');
      agentServices.configManager.set('controlPlane.port', port);
      mkdirSync(join(agentHomeDir, '.goodvibes', 'daemon'), { recursive: true });
      writeFileSync(join(agentHomeDir, '.goodvibes', 'daemon', 'operator-tokens.json'), JSON.stringify({ token: TEST_TOKEN }));
    });

    afterEach(async () => {
      await daemon?.stop();
      rmSync(daemonRoot, { recursive: true, force: true });
    });

    test('adopted: reconcile activates the spine and every op routes to the DAEMON store, never the agent\'s own local store', async () => {
      let localWrites = 0;
      const originalLocalAdd = agentServices.memoryRegistry.add.bind(agentServices.memoryRegistry);
      agentServices.memoryRegistry.add = (async (...args: Parameters<typeof originalLocalAdd>) => {
        localWrites += 1;
        return originalLocalAdd(...args);
      }) as typeof originalLocalAdd;

      const probeReachability = realReachabilityProbe(agentServices, agentHomeDir);
      await reconcileMemorySpineAdoption({
        memorySpineClient: agentServices.memorySpineClient,
        transport: agentServices.memorySpineTransport,
        probeReachability,
      });
      expect(agentServices.memorySpineClient.mode()).toBe('client');
      expect(agentServices.memorySpineClient.active).toBe(true);

      const added = await agentServices.memorySpineClient.add({ cls: 'fact', scope: 'project', summary: 'adopted-mode write' });
      // Reached the DAEMON's own store...
      expect(daemonServices.memoryRegistry.get(added.id)?.summary).toBe('adopted-mode write');
      // ...and the agent's own local registry.add was NEVER called (single-writer proof).
      expect(localWrites).toBe(0);
      expect(agentServices.memoryRegistry.getAll().some((r) => r.id === added.id)).toBe(false);
    });

    test('deactivate-on-loss: stopping the daemon and re-reconciling hands the spine back to local', async () => {
      const probeReachability = realReachabilityProbe(agentServices, agentHomeDir);
      await reconcileMemorySpineAdoption({
        memorySpineClient: agentServices.memorySpineClient,
        transport: agentServices.memorySpineTransport,
        probeReachability,
      });
      expect(agentServices.memorySpineClient.mode()).toBe('client');

      await daemon.stop();

      await reconcileMemorySpineAdoption({
        memorySpineClient: agentServices.memorySpineClient,
        transport: agentServices.memorySpineTransport,
        probeReachability,
      });
      expect(agentServices.memorySpineClient.mode()).toBe('local');
      expect(agentServices.memorySpineClient.active).toBe(false);

      // Post-loss, ops resolve locally again, never keep routing to the dead wire.
      const added = await agentServices.memorySpineClient.add({ cls: 'fact', scope: 'project', summary: 'post-loss local write' });
      expect(agentServices.memoryRegistry.get(added.id)?.summary).toBe('post-loss local write');
    });
  });
});

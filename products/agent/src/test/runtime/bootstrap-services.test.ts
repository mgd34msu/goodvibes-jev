import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { RuntimeEventBus, startExternalServices } from '@/runtime/index.ts';
import { HookDispatcher } from '@goodvibes-jev/engine/sdk/platform/hooks';
import { getTestRuntimeServices } from '../helpers/runtime-services.ts';

function createConfig(overrides: {
  daemon?: boolean;
  httpListener?: boolean;
  controlPlaneHost?: string;
  controlPlanePort?: number;
  httpListenerHost?: string;
  httpListenerPort?: number;
} = {}) {
  return {
    get(
      key:
        | 'daemon.enabled'
        | 'danger.httpListener'
        | 'controlPlane.host'
        | 'controlPlane.port'
        | 'httpListener.host'
        | 'httpListener.port',
    ): boolean | string | number {
      if (key === 'daemon.enabled') return overrides.daemon ?? false;
      if (key === 'danger.httpListener') return overrides.httpListener ?? false;
      if (key === 'controlPlane.host') return overrides.controlPlaneHost ?? '127.0.0.1';
      if (key === 'controlPlane.port') return overrides.controlPlanePort ?? 3421;
      if (key === 'httpListener.host') return overrides.httpListenerHost ?? '127.0.0.1';
      return overrides.httpListenerPort ?? 3422;
    },
  };
}

describe('startExternalServices (Agent: adopt-only)', () => {
  let runtimeBus: RuntimeEventBus;
  let hookDispatcher: HookDispatcher;
  let runtimeServices: ReturnType<typeof getTestRuntimeServices>;

  beforeEach(() => {
    runtimeBus = new RuntimeEventBus();
    hookDispatcher = new HookDispatcher();
    runtimeServices = getTestRuntimeServices();
  });

  test('never spawns or embeds a daemon even when legacy flags are enabled', async () => {
    const spawnDetachedDaemon = mock(() => ({ pid: 1, unref: () => {} }));
    const probeDaemonPortInUse = mock(async () => false);

    // httpListener stays at its default (disabled) here so this test never
    // reaches the (unrelated) real HTTP-listener embed path.
    const services = await startExternalServices(
      createConfig({ daemon: true }),
      runtimeBus,
      hookDispatcher,
      runtimeServices.asDaemonGradeView(),
      {
        adoptOnly: true,
        spawnDetachedDaemon,
        probeDaemonPortInUse,
      },
    );

    // adoptOnly never spawns/embeds the daemon regardless of daemon.enabled:
    // with the port free, adoptOnly steers the decision to 'adopt-only-idle'
    // rather than 'spawn', so the detached-spawn seam is never invoked.
    expect(spawnDetachedDaemon).not.toHaveBeenCalled();
    expect(probeDaemonPortInUse).toHaveBeenCalledTimes(1);
    expect(services.daemonServer).toBeNull();
    expect(services.httpListener).toBeNull();
    expect(services.daemonStatus.mode).toBe('unavailable');
    expect(services.daemonStatus.reason).toContain('adopt-only');
    expect(services.httpListenerStatus.mode).toBe('disabled');

    await services.stop();
    expect(services.listRecentControlPlaneEvents(100)).toEqual([]);
  });

  test('adopts a reachable, version-compatible daemon on the configured endpoint', async () => {
    const probeDaemonIdentity = mock(async () => ({
      kind: 'goodvibes' as const,
      status: 'running',
      version: '1.0.0',
    }));

    const services = await startExternalServices(
      createConfig({
        daemon: true,
        controlPlaneHost: '0.0.0.0',
        controlPlanePort: 4444,
      }),
      runtimeBus,
      hookDispatcher,
      runtimeServices.asDaemonGradeView(),
      {
        adoptOnly: true,
        probeDaemonPortInUse: async () => true,
        probeDaemonIdentity,
        localDaemonVersion: '1.0.0',
        isDaemonVersionCompatible: (local, remote) => local === remote,
      },
    );

    expect(probeDaemonIdentity).toHaveBeenCalledTimes(1);
    expect(services.daemonStatus).toMatchObject({
      mode: 'external',
      host: '0.0.0.0',
      port: 4444,
      // 0.0.0.0 (bind-all) normalizes to a reachable loopback address in the
      // probe/report base URL, see formatBaseUrl's normalizeProbeHost.
      baseUrl: 'http://127.0.0.1:4444',
      version: '1.0.0',
    });
  });

  test('refuses to adopt a daemon reporting an incompatible wire version', async () => {
    // Deliberately unrelated fixture strings (not the live SDK VERSION) so
    // this assertion never drifts with a real version bump, the injected
    // isDaemonVersionCompatible predicate is the sole source of truth here.
    const probeDaemonIdentity = mock(async () => ({
      kind: 'goodvibes' as const,
      status: 'running',
      version: 'incompatible-fixture-version',
    }));

    const services = await startExternalServices(
      createConfig({ daemon: true }),
      runtimeBus,
      hookDispatcher,
      runtimeServices.asDaemonGradeView(),
      {
        adoptOnly: true,
        probeDaemonPortInUse: async () => true,
        probeDaemonIdentity,
        localDaemonVersion: 'local-fixture-version',
        isDaemonVersionCompatible: () => false,
      },
    );

    expect(services.daemonServer).toBeNull();
    expect(services.daemonStatus.mode).toBe('incompatible');
    expect(services.daemonStatus.version).toBe('incompatible-fixture-version');
  });

  test('reports a blocked port when the occupant does not verify as a GoodVibes daemon', async () => {
    const services = await startExternalServices(
      createConfig({ daemon: true }),
      runtimeBus,
      hookDispatcher,
      runtimeServices.asDaemonGradeView(),
      {
        adoptOnly: true,
        probeDaemonPortInUse: async () => true,
        probeDaemonIdentity: async () => ({ kind: 'unknown', reason: 'connection reset' }),
      },
    );

    expect(services.daemonServer).toBeNull();
    expect(services.daemonStatus.mode).toBe('blocked');
  });

  test('runtime hook dispatcher does not configure local agent hook spawning', async () => {
    runtimeServices.hookDispatcher.clear();
    runtimeServices.hookDispatcher.register('Pre:tool:read', {
      match: 'read',
      type: 'agent',
      prompt: 'spawn a background checker',
    });

    const result = await runtimeServices.hookDispatcher.fire({
      path: 'Pre:tool:read',
      phase: 'Pre',
      category: 'tool',
      specific: 'read',
      sessionId: 'session-agent-hook-block',
      timestamp: Date.now(),
      payload: {},
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('agent hook runner is not configured');
    expect(runtimeServices.agentManager.list()).toHaveLength(0);
  });
});

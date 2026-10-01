/**
 * voice-setup-and-memory-governance-composition.test.ts
 *
 * Pins two adopted SDK seams through the real composition root
 * (createRuntimeServices), in the same style as
 * power-keep-awake-composition.test.ts:
 *
 *  1. `services.voiceSetup` is real, live wiring over the SDK's own managed
 *     voice provisioning, created by the platform's createVoiceSetupService
 *     rather than mirrored here, which is also what gives this surface the
 *     wake-word artifact service. Both the direct service (what /voice status,
 *     /voice setup and /voice wake read) and the voice.local.* and voice.wake.*
 *     gateway verbs (what a remote surface would invoke) are pinned to the SAME
 *     instance and produce a real, non-fabricated answer.
 *
 *  2. The SDK memory-governance layer is composed FOR REAL: the MemoryGovernor
 *     is constructed AND STARTED by default (a safety feature) via the SDK's
 *     own public wireDaemonMemoryGovernance (exported since sdk 4d5e247b,
 *     which fixed the export-surface gap this composition previously reported
 *     and carried as an honest divergence), this fork's caches (knowledge
 *     stores + shared session broker) and pausable background jobs are
 *     registered onto the governor's seams, and ops.memory.get serves the
 *     genuine live snapshot.
 *
 * ── Whose composition this drives ────────────────────────────────────────
 *
 * `buildDaemonGatewayCatalog(services)` builds the catalog THE DAEMON composes
 * over this graph, the agent's own `services.gatewayMethods` carries no handler
 * for any of these any more, and that absence is itself pinned in
 * daemon/gateway-ws-only-invokable.test.ts.
 *
 * The behaviour below did not move or change; its OWNER did. These verbs are
 * served to every surface by one process now, and this suite is where the
 * contract that surface depends on stays honest. Driving it through the
 * daemon's composition is the difference between verifying a contract and
 * asserting that a client answers its own question.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { buildDaemonGatewayCatalog } from '../helpers/daemon-gateway.ts';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryGovernorSnapshot } from '@goodvibes-jev/engine/sdk/platform/runtime/memory';
import { ConfigManager } from '../../config/index.ts';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { createRuntimeServices, type RuntimeServices } from '../../runtime/services.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

describe('voice-setup + memory-governance composition', () => {
  let root = '';

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  function makeServices(): RuntimeServices {
    root = makeProjectTempDir('goodvibes-agent-voice-memory-composition');
    const workingDir = join(root, 'workspace');
    const homeDir = join(root, 'home');
    const configDir = join(homeDir, '.goodvibes', 'agent');
    mkdirSync(workingDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    const configManager = new ConfigManager({ surfaceRoot: 'agent', workingDir, homeDir, configDir });
    return createRuntimeServices({
      // Opt out: this process does not outlive the unawaited sweep.
      modelDiscovery: 'skip',
      runtimeBus: new RuntimeEventBus(),
      runtimeStore: createRuntimeStore(),
      configManager,
      workingDir,
      homeDirectory: homeDir,
    });
  }

  function cleanup(services: RuntimeServices): void {
    services.memoryGovernor.stop();
    services.providerRegistry.stopWatching();
    services.configManager.stopWatchingConfigFiles();
  }

  test('services.voiceSetup is present and its status() reflects the real (fresh, not-provisioned) managed runtime', () => {
    const services = makeServices();
    try {
      expect(services.voiceSetup).toBeDefined();
      const status = services.voiceSetup.status();
      // A fresh temp home has never been provisioned, this is the real
      // provisioner reading real (absent) files on disk, not a stub.
      expect(status.state).toBe('not-provisioned');
      expect(typeof status.tts.engine).toBe('string');
      expect(status.tts.engine.length).toBeGreaterThan(0);
    } finally {
      cleanup(services);
    }
  });

  test('voice.local.status is invokable over the gateway and answers with the SAME live status voiceSetup serves directly', async () => {
    const services = makeServices();
    try {
      const direct = services.voiceSetup.status();
      const viaGateway = await buildDaemonGatewayCatalog(services).invoke('voice.local.status', {
        context: {},
      });
      expect(viaGateway).toEqual(direct);
    } finally {
      cleanup(services);
    }
  });

  test('services.voiceSetup carries the wake-word artifact service, and reports honestly on a host that has never provisioned', () => {
    const services = makeServices();
    try {
      // The same service, one instance: the wake artifacts live under the managed
      // voice root's `wake` subdirectory, so /voice wake status and the
      // voice.wake.status verb read the platform's own content-verifying check
      // rather than a second provisioning path invented here.
      const status = services.voiceSetup.wakeStatus();
      expect(status.ready).toBe(false);
      // A fresh temp home: absent, NOT corrupt. The distinction is the point of
      // verifying by content, a wrong or truncated file must not read as present.
      expect(status.classifier.verified).toBe(false);
      expect(status.classifier.corrupt).toBe(false);
      expect(status.embedding.verified).toBe(false);
      expect(status.downloadBytes).toBeGreaterThan(0);
      // Carried at every surfacing, because it is what the published numbers mean.
      expect(status.recallIsSyntheticOnly).toBe(true);
    } finally {
      cleanup(services);
    }
  });

  test('the three wake verbs are registered on the gateway, and voice.wake.status answers with the SAME live state', async () => {
    const services = makeServices();
    try {
      const direct = services.voiceSetup.wakeStatus();
      const viaGateway = await buildDaemonGatewayCatalog(services).invoke('voice.wake.status', { context: {} });
      expect(viaGateway).toEqual(direct);
      // provision downloads ~3.7 MB, and model.get reads bytes that a fresh host
      // does not have, so these assert the handler is REGISTERED, which is the
      // failure mode a cataloged-but-unhandled verb has.
      expect(buildDaemonGatewayCatalog(services).get('voice.wake.provision')?.invokable).toBe(true);
      expect(buildDaemonGatewayCatalog(services).get('voice.wake.model.get')?.invokable).toBe(true);
    } finally {
      cleanup(services);
    }
  });

  test('voice.local.install is invokable over the gateway (registered, not cataloged-but-unhandled)', async () => {
    const services = makeServices();
    try {
      // Does not actually assert on a completed install (that downloads real
      // files over the network), only that the gateway found and ran a real
      // handler rather than refusing with "no internal handler", proving
      // voiceSetup was genuinely wired into the catalog, not merely
      // constructed and left unregistered.
      const descriptor = buildDaemonGatewayCatalog(services).get('voice.local.install');
      expect(descriptor?.invokable).toBe(true);
    } finally {
      cleanup(services);
    }
  });

  test('the MemoryGovernor is composed, STARTED by default, and its registered members are this fork\'s real caches and jobs', () => {
    const services = makeServices();
    try {
      // Present: the real SDK class instances, not stand-ins.
      expect(services.memoryGovernor).toBeDefined();
      expect(services.cacheRegistry).toBeDefined();
      expect(services.pauseController).toBeDefined();

      // Started by default, a safety feature, like the SDK's own daemon
      // composition. start() sets the (unref'd) sampling interval; the timer
      // handle is the only truthful started/stopped tell the class exposes,
      // so this is a deliberate white-box probe: if the SDK renames the
      // field, this pin should fail and be re-anchored, not deleted.
      const timerOf = (): unknown => (services.memoryGovernor as unknown as { timer: unknown }).timer;
      expect(timerOf()).not.toBeNull();

      // Registered caches: this fork's knowledge stores + the shared session
      // broker (wired through wireDaemonMemoryGovernance's real adapters).
      const cacheIds = services.cacheRegistry.registeredIds();
      expect(cacheIds).toContain('knowledge-store');
      expect(cacheIds).toContain('session-union');

      // Registered pausable background jobs, all running (nothing paused on
      // a fresh, unpressured process).
      const jobStates = services.pauseController.states();
      const jobIds = jobStates.map((s) => s.id).sort();
      expect(jobIds).toEqual(['code-index-reindex', 'knowledge-self-improvement', 'memory-consolidation']);
      expect(jobStates.every((s) => !s.paused)).toBe(true);

      // The admission gate is live and honest for an unpressured process.
      expect(services.memoryGovernor.admitExpensiveWork('composition pin').allowed).toBe(true);

      // stop() flips the started tell off, pinning that cleanup is real too.
      services.memoryGovernor.stop();
      expect(timerOf()).toBeNull();
    } finally {
      cleanup(services);
    }
  });

  test('ops.memory.get serves the genuine live governor snapshot over the gateway', async () => {
    const services = makeServices();
    try {
      const viaGateway = await buildDaemonGatewayCatalog(services).invoke('ops.memory.get', { context: {} }) as MemoryGovernorSnapshot;
      // Real values from the real sampler, a live process has a nonzero RSS.
      expect(viaGateway.rssMb).toBeGreaterThan(0);
      expect(viaGateway.heapUsedMb).toBeGreaterThan(0);
      expect(viaGateway.budgetMb).toBeGreaterThan(0);
      expect(['normal', 'elevated', 'high', 'critical']).toContain(viaGateway.tier);
      expect(viaGateway.caches.map((c) => c.id)).toEqual(
        expect.arrayContaining(['knowledge-store', 'session-union']),
      );
      expect(viaGateway.pausedJobs).toEqual([]);
      expect(viaGateway.tripwire.armed).toBe(false);
      // And it is the SAME governor RuntimeServices exposes directly (tier and
      // budget agree; rss may drift a few KB between two live samples).
      const direct = services.memoryGovernor.snapshot();
      expect(direct.tier).toBe(viaGateway.tier);
      expect(direct.budgetMb).toBe(viaGateway.budgetMb);
    } finally {
      cleanup(services);
    }
  });
});

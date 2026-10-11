import { expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { WorkspaceCheckpointManager } from '@goodvibes-jev/engine/sdk/platform/workspace';
import { createEventEnvelope } from '@goodvibes-jev/engine/transport-core';
import { acquireCrossProcessLock } from '../../../../../packages/engine/sdk/src/platform/workspace/checkpoint/cross-process-lock.ts';
import { createSessionSurface, RuntimeEventBus } from '../../runtime/index.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { createRuntimeServices } from '../../runtime/services.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { seedProviderMetadataCacheFixture } from '../helpers/provider-metadata-cache-fixture.ts';

test('Agent close drains native checkpoint initialization before closing its client and removes late subscriptions', async () => {
  const root = makeProjectTempDir('agent-checkpoint-close');
  const home = join(root, 'home'), work = join(root, 'work');
  mkdirSync(home, { recursive: true }); mkdirSync(work, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: work, timeout: 10_000 });
  const surface = createSessionSurface({ surfaceRoot: 'agent', workingDirectory: work, homeDirectory: home });
  const lockPath = join(surface.checkpointsDir, 'git', '.gv-lock');
  const releaseNativeLock = await acquireCrossProcessLock(lockPath);
  const configManager = new ConfigManager({ surfaceRoot: 'agent', configDir: join(home, 'config'), workingDir: work, homeDir: home });
  seedProviderMetadataCacheFixture({ configManager, homeDirectory: home, workingDirectory: work });
  const runtimeBus = new RuntimeEventBus();
  const services = createRuntimeServices({ configManager, runtimeBus, runtimeStore: createRuntimeStore(),
    workingDir: work, homeDirectory: home, modelDiscovery: 'skip' });
  const checkpointManager = services.workspaceCheckpointManager;
  expect(checkpointManager).toBeInstanceOf(WorkspaceCheckpointManager);
  expect(services.surface.checkpointsDir).toBe(surface.checkpointsDir);
  const initialized = checkpointManager.init();
  let initFinished = false; void initialized.then(() => { initFinished = true; });
  const drainEntered = Promise.withResolvers<void>();
  const nativeDrain = checkpointManager.drain;
  const drain = spyOn(checkpointManager, 'drain').mockImplementation(function(this: WorkspaceCheckpointManager) {
    drainEntered.resolve(); return nativeDrain.call(this);
  });
  const clientClose = spyOn(services.judgment.decisionLog, Symbol.dispose);
  const governorStop = spyOn(services.memoryGovernor, 'stop');
  const automaticCreate = spyOn(checkpointManager, 'create');
  let closing: Promise<void> | undefined;
  try {
    closing = services.close();
    expect(services.close()).toBe(closing);
    const first = await Promise.race([closing.then(() => 'closed'), drainEntered.promise.then(() => 'draining')]);
    expect(initFinished).toBe(false);
    expect(existsSync(join(surface.checkpointsDir, 'git', 'HEAD'))).toBe(false);
    expect(first).toBe('draining');
    expect(governorStop).toHaveBeenCalledTimes(1);
    expect(clientClose).not.toHaveBeenCalled();
    services.dispose(); expect(drain).toHaveBeenCalledTimes(1);
    releaseNativeLock();
    await closing; await initialized;
    expect(initFinished).toBe(true);
    expect(existsSync(join(surface.checkpointsDir, 'git', 'HEAD'))).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    expect(clientClose).toHaveBeenCalledTimes(1);
    runtimeBus.emit('turn', createEventEnvelope('TURN_COMPLETED', {
      type: 'TURN_COMPLETED', turnId: 'after-native-close', response: 'done', stopReason: 'completed',
    }, { sessionId: 'checkpoint-close', source: 'checkpoint-close', turnId: 'after-native-close' }));
    await Promise.resolve();
    expect(automaticCreate).not.toHaveBeenCalled();
    expect(services.close()).toBe(closing); services.dispose();
    expect(drain).toHaveBeenCalledTimes(1); expect(governorStop).toHaveBeenCalledTimes(1);
  } finally {
    releaseNativeLock();
    try { await initialized; await (closing ?? services.close()); await nativeDrain.call(checkpointManager); }
    finally {
      drain.mockRestore(); clientClose.mockRestore(); governorStop.mockRestore(); automaticCreate.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 30_000);

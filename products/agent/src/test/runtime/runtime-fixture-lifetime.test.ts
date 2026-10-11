import { expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { RuntimeEventBus } from '../../runtime/index.ts';
import { createRuntimeServices, type RuntimeServices } from '../../runtime/services.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { seedProviderMetadataCacheFixture } from '../helpers/provider-metadata-cache-fixture.ts';

test('real graph close cancels scheduled governor work while a sibling owner keeps sampling', async () => {
  const roots: string[] = [], runtimes: RuntimeServices[] = [];
  const restore: (() => void)[] = [];
  function runtime(): RuntimeServices {
    const root = makeProjectTempDir('agent-fixture-native-lifetime');
    roots.push(root);
    const home = join(root, 'home'), work = join(root, 'work');
    mkdirSync(home, { recursive: true }); mkdirSync(work, { recursive: true });
    const configManager = new ConfigManager({ surfaceRoot: 'agent', workingDir: work, homeDir: home,
      configDir: join(home, 'config') });
    seedProviderMetadataCacheFixture({ configManager, homeDirectory: home, workingDirectory: work });
    const services = createRuntimeServices({ configManager, workingDir: work, homeDirectory: home,
      runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore(), modelDiscovery: 'skip' });
    runtimes.push(services);
    return services;
  }
  async function sampled(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    expect(predicate()).toBe(true);
  }
  function observe(governor: RuntimeServices['memoryGovernor']) {
    const sample = governor.sampleOnce, stop = governor.stop;
    const originalSample = Object.getOwnPropertyDescriptor(governor, 'sampleOnce');
    const originalStop = Object.getOwnPropertyDescriptor(governor, 'stop');
    const calls = { samples: 0, stops: 0 };
    Object.defineProperties(governor, {
      sampleOnce: { configurable: true, writable: true, value: function(this: typeof governor) {
        calls.samples++; sample.call(this);
      } },
      stop: { configurable: true, writable: true, value: function(this: typeof governor) {
        calls.stops++; stop.call(this);
      } },
    });
    restore.push(() => {
      if (originalSample) Object.defineProperty(governor, 'sampleOnce', originalSample);
      else Reflect.deleteProperty(governor, 'sampleOnce');
      if (originalStop) Object.defineProperty(governor, 'stop', originalStop);
      else Reflect.deleteProperty(governor, 'stop');
    });
    return calls;
  }
  try {
    const first = runtime(), sibling = runtime();
    const firstCalls = observe(first.memoryGovernor), siblingCalls = observe(sibling.memoryGovernor);
    await sampled(() => firstCalls.samples > 0 && siblingCalls.samples > 0);
    await first.close();
    const firstCount = firstCalls.samples, siblingCount = siblingCalls.samples;
    expect(firstCalls.stops).toBe(1); expect(siblingCalls.stops).toBe(0);
    await sampled(() => siblingCalls.samples > siblingCount);
    expect(firstCalls.samples).toBe(firstCount);
    await sibling.close();
    expect(siblingCalls.stops).toBe(1);
  } finally {
    const shutdowns = runtimes.flatMap(services => [
      () => services.close(), () => services.workspaceCheckpointManager.drain(),
    ]);
    const outcomes = await Promise.allSettled(shutdowns.map(async shutdown => shutdown()));
    for (const callback of restore) callback();
    const failures: unknown[] = outcomes.flatMap(outcome => outcome.status === 'rejected' ? [outcome.reason] : []);
    if (failures.length) throw new AggregateError(failures, 'Native fixture teardown failed');
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});

/**
 * watcher-failure-retryable.test.ts
 *
 * WATCHER_FAILED carries `retryable`: whether the watcher's next interval run
 * can clear the failure. It used to be `true` for every failure; it is now the
 * failure transience reading of the thrown error (readFailureTransience), so a
 * failure no retry clears is published as such.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WatcherRegistry } from '../sdk/src/platform/watchers/registry.js';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.ts';
import type { AutomationSourceRecord } from '../sdk/src/platform/automation/sources.js';
import { useFailureReadings } from './_helpers/failure-readings.js';

const roots: string[] = [];
const registries: WatcherRegistry[] = [];

afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const source = {
  id: 'source-1', kind: 'watcher', label: 'Source 1', enabled: true, createdAt: 1, updatedAt: 1, metadata: {},
} as AutomationSourceRecord;

async function failedEventFor(message: string): Promise<{ retryable: boolean; error: string }> {
  const root = mkdtempSync(join(tmpdir(), 'gv-watcher-failed-'));
  roots.push(root);
  const registry = new WatcherRegistry({
    storePath: join(root, 'watchers.json'),
    featureFlags: { isEnabled: (id: string): boolean => id === 'watcher-framework' },
  });
  registries.push(registry);
  const bus = new RuntimeEventBus();
  const seen: Array<{ retryable: boolean; error: string }> = [];
  bus.on('WATCHER_FAILED', (envelope) => {
    const payload = envelope.payload as { retryable: boolean; error: string };
    seen.push({ retryable: payload.retryable, error: payload.error });
  });
  registry.attachRuntime({ runtimeBus: bus });
  registry.registerWatcher({ id: 'w1', label: 'W1', source, run: () => { throw new Error(message); } });
  await registry.runWatcherNow('w1');
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(seen).toHaveLength(1);
  return seen[0]!;
}

describe('a failed watcher run publishes whether a retry can clear it', () => {
  useFailureReadings([
    ['socket hang up', { category: 'network', transientNetwork: true }],
    ['401: the feed token was revoked', { category: 'authentication' }],
  ]);

  test('a dropped connection is published as retryable', async () => {
    expect((await failedEventFor('socket hang up')).retryable).toBe(true);
  });

  test('a revoked credential is published as not retryable', async () => {
    expect((await failedEventFor('401: the feed token was revoked')).retryable).toBe(false);
  });
});

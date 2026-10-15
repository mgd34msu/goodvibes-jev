/**
 * watcher-persist-containment.test.ts, a watcher-store write that fails must
 * not be able to kill the process that attempted it.
 *
 * Mutations contain write failures. Reads derive freshness without publishing
 * state or writing files: doing either from a render caused a render feedback loop.
 */
import { afterEach, describe, expect, test, spyOn } from 'bun:test';
import type { Mock } from 'bun:test';
import { existsSync, mkdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { WatcherRegistry } from '../sdk/src/platform/watchers/registry.ts';
import { logger } from '../sdk/src/platform/utils/logger.ts';
import type { AutomationSourceRecord } from '../sdk/src/platform/automation/sources.ts';
import { createRuntimeStore } from '../sdk/src/platform/runtime/store/index.ts';

/** The watcher-framework gate every registry operation sits behind. */
const watcherFlagsOn = { isEnabled: (id: string): boolean => id === 'watcher-framework' };

const registries: WatcherRegistry[] = [];

afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose();
});

function track(registry: WatcherRegistry): WatcherRegistry {
  registries.push(registry);
  return registry;
}

function automationSource(): AutomationSourceRecord {
  return {
    id: 'source-1',
    kind: 'watcher',
    label: 'Source 1',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    metadata: {},
  } as AutomationSourceRecord;
}

/**
 * A store path with a regular file partway down it, so creating the store's
 * parent directory has to traverse through a file and every write fails with
 * ENOTDIR, the same class of unwritable store as the ENOENT that crashed the
 * agent, and deterministic rather than timing-dependent.
 */
function unwritableStorePath(): string {
  const dir = makeProjectTempDir('gv-watcher-persist');
  mkdirSync(dir, { recursive: true });
  const blocker = join(dir, 'not-a-directory');
  writeFileSync(blocker, 'a file where the store directory should be', 'utf-8');
  return join(blocker, 'nested', 'watchers.json');
}

describe('watcher snapshot persistence failures are contained', () => {
  test('registering a watcher against an unwritable store does not throw and keeps the record in memory', () => {
    const registry = track(new WatcherRegistry({ storePath: unwritableStorePath(), featureFlags: watcherFlagsOn }));

    const record = registry.registerWatcher({
      id: 'poller-1',
      label: 'Poller 1',
      kind: 'polling',
      source: automationSource(),
      intervalMs: 600_000,
    });

    expect(record.id).toBe('poller-1');
    expect(registry.getWatcher('poller-1')?.id).toBe('poller-1');
  });

  test('mutation write failures are logged with path and errno while subsequent reads remain usable', () => {
    const storePath = unwritableStorePath();
    const registry = track(new WatcherRegistry({ storePath, featureFlags: watcherFlagsOn }));
    registry.registerWatcher({
      id: 'poller-1',
      label: 'Poller 1',
      kind: 'polling',
      source: automationSource(),
      intervalMs: 600_000,
    });

    const errorSpy = spyOn(logger, 'error') as Mock<typeof logger.error>;
    try {
      registry.stopWatcher('poller-1');
      const firstTick = registry.list();
      const secondTick = registry.list();

      expect(firstTick.map((watcher) => watcher.id)).toEqual(['poller-1']);
      expect(secondTick.map((watcher) => watcher.id)).toEqual(['poller-1']);

      const reports = errorSpy.mock.calls.filter(([message]) => String(message).includes('[watchers/store]'));
      expect(reports).toHaveLength(1);
      const [, data] = reports[0] as [string, Record<string, unknown>];
      expect(data.filePath).toBe(storePath);
      expect(data.code).toBe('ENOTDIR');
      expect(typeof data.error).toBe('string');
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('reading live freshness neither rewrites the snapshot nor dispatches another render', () => {
    const storePath = join(makeProjectTempDir('gv-watcher-persist'), 'watchers.json');
    const registry = track(new WatcherRegistry({ storePath, featureFlags: watcherFlagsOn }));
    registry.registerWatcher({
      id: 'poller-1',
      label: 'Poller 1',
      kind: 'polling',
      source: automationSource(),
      intervalMs: 600_000,
    });

    expect(existsSync(storePath)).toBe(true);
    utimesSync(storePath, new Date(1000), new Date(1000));
    const stamp = statSync(storePath).mtimeMs;
    const runtimeStore = createRuntimeStore();
    registry.attachRuntime({ runtimeStore });
    let updates = 0;
    const unsubscribe = runtimeStore.subscribe(() => { updates++; });
    const clock = spyOn(Date, 'now').mockReturnValue(2000);
    try {
      const first = registry.list()[0]!;
      clock.mockReturnValue(4000);
      const second = registry.getWatcher('poller-1')!;
      expect(second.sourceLagMs! - first.sourceLagMs!).toBe(2000);
      expect(registry.list().map(watcher => watcher.id)).toEqual(['poller-1']);
      expect(updates).toBe(0);
      expect(statSync(storePath).mtimeMs).toBe(stamp);
    } finally { clock.mockRestore(); unsubscribe(); }
  });
});

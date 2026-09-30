import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { inboxSurface, surfaceIdFor } from '@goodvibes-jev/engine/sdk/platform/cluster';
import { createClusterComposition, inboxPollerGate } from '../../runtime/cluster-composition.js';
import { startClusterServices } from '../../runtime/cluster-group-composition.js';
import type { ShellPathService } from '../../runtime/index.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
async function turns() { for (let i = 0; i < 10; i++) await Promise.resolve(); }

test('constructing the coordinator is inert, including node identity state', () => {
  const root = makeOwnedTempDir('daemon-cluster-inert');
  const coordinator = createClusterComposition({
    configManager: { getCategory: () => ({ enabled: true }) } as Pick<ConfigManager, 'getCategory'>,
    shellPaths: { resolveProjectPath: (...parts: string[]) => join(root, ...parts) } as unknown as ShellPathService,
  });
  expect(coordinator.running).toBe(false);
  expect(readdirSync(root)).toEqual([]);
});

test('an account gate awaits the actual start and stop operations', async () => {
  const acquiring = deferred(); const releasing = deferred();
  const gate = inboxPollerGate('fixture-account', { start: () => acquiring.promise, stop: () => releasing.promise });
  let started = false; const start = gate.start({ replayFromMs: null, reason: 'fixture election' }).then(() => { started = true; });
  await turns(); expect(started).toBe(false);
  acquiring.resolve(); await start;
  let stopped = false; const stop = gate.stop('fixture handoff').then(() => { stopped = true; });
  await turns(); expect(stopped).toBe(false);
  releasing.resolve(); await stop;
  expect(started && stopped).toBe(true);
  expect(gate.id).toBe('inbox-poller:fixture-account');
  expect(surfaceIdFor(gate.surface)).toBe(surfaceIdFor(inboxSurface('fixture-account')));
});

test('each inbox account retains its own election surface', () => {
  const control = { async start() {}, async stop() {} };
  const first = inboxPollerGate('first-fixture', control);
  const second = inboxPollerGate('second-fixture', control);
  expect(surfaceIdFor(first.surface)).not.toBe(surfaceIdFor(second.surface));
});

test('coordinator startup waits for group readiness, including its return announcement', async () => {
  const ready = deferred(); const calls: string[] = [];
  const start = startClusterServices({
    clusterGroup: { async start() { calls.push('group'); await ready.promise; } },
    clusterCoordinator: { async start() { calls.push('election'); } },
  });
  await turns(); expect(calls).toEqual(['group']);
  ready.resolve(); await start;
  expect(calls).toEqual(['group', 'election']);
});

test('failed group startup does not start an unsigned election', async () => {
  let elections = 0;
  await expect(startClusterServices({
    clusterGroup: { async start() { throw new Error('fixture group unavailable'); } },
    clusterCoordinator: { async start() { elections++; } },
  })).rejects.toThrow('fixture group unavailable');
  expect(elections).toBe(0);
});

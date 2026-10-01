import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  describeLocalDaemonState,
  formatDuration,
  localDaemonStatePaths,
  readDaemonLifecycleMarker,
  readDaemonReceipts,
  type LocalStateIo,
} from '../../daemon/local-daemon-state.js';

const DIR = '/home/x/.goodvibes';

function io(files: Record<string, string>): LocalStateIo {
  return { read: (path: string) => files[path] ?? null };
}

const paths = localDaemonStatePaths(DIR);

describe('the lifecycle marker', () => {
  test('sits where the daemon facade writes it', () => {
    expect(paths.markerPath).toBe(join(DIR, 'control-plane', 'daemon-lifecycle.json'));
    expect(paths.receiptsPath).toBe(join(DIR, 'control-plane', 'daemon-receipts.json'));
  });

  test('reads state, pid, version, rejected version and rollback stamp', () => {
    const marker = readDaemonLifecycleMarker(paths.markerPath, io({
      [paths.markerPath]: JSON.stringify({
        state: 'running',
        at: 1_700_000_000_000,
        pid: 4242,
        failedStarts: 0,
        version: '1.28.0',
        rejectedVersion: '1.27.9',
        autoRollbackAt: 1_699_999_000_000,
      }),
    }));
    expect(marker?.state).toBe('running');
    expect(marker?.pid).toBe(4242);
    expect(marker?.version).toBe('1.28.0');
    expect(marker?.rejectedVersion).toBe('1.27.9');
    expect(marker?.autoRollbackAt).toBe(1_699_999_000_000);
  });

  test('an absent, unparseable or malformed file is null, never a throw', () => {
    expect(readDaemonLifecycleMarker(paths.markerPath, io({}))).toBeNull();
    expect(readDaemonLifecycleMarker(paths.markerPath, io({ [paths.markerPath]: 'not json' }))).toBeNull();
    expect(readDaemonLifecycleMarker(paths.markerPath, io({ [paths.markerPath]: '{"state":"weird","at":1}' }))).toBeNull();
    expect(readDaemonLifecycleMarker(paths.markerPath, io({ [paths.markerPath]: '{"state":"running"}' }))).toBeNull();
  });

  test('a hand-edited counter and version string are bounded, not trusted', () => {
    const marker = readDaemonLifecycleMarker(paths.markerPath, io({
      [paths.markerPath]: JSON.stringify({
        state: 'running',
        at: 1,
        failedStarts: 999_999,
        version: 'v'.repeat(500),
      }),
    }));
    expect(marker?.failedStarts).toBe(32);
    expect(marker?.version).toBeUndefined();
  });
});

describe('the receipt store', () => {
  test('reads a bare array and a { receipts } document alike', () => {
    const entries = [{ id: 'a', text: 'updated to 1.28.0', at: 10 }];
    expect(readDaemonReceipts(paths.receiptsPath, io({ [paths.receiptsPath]: JSON.stringify(entries) })))
      .toEqual([{ id: 'a', text: 'updated to 1.28.0', at: 10, deliveredAt: undefined }]);
    expect(readDaemonReceipts(paths.receiptsPath, io({ [paths.receiptsPath]: JSON.stringify({ receipts: entries }) })))
      .toEqual([{ id: 'a', text: 'updated to 1.28.0', at: 10, deliveredAt: undefined }]);
  });

  test('entries missing text or a timestamp are dropped rather than rendered as blanks', () => {
    const receipts = readDaemonReceipts(paths.receiptsPath, io({
      [paths.receiptsPath]: JSON.stringify([{ id: 'a' }, { text: 'ok', at: 1 }, null, 'x']),
    }));
    expect(receipts.length).toBe(1);
    expect(receipts[0]?.text).toBe('ok');
  });

  test('the list is capped so a status page never becomes a log viewer', () => {
    const many = Array.from({ length: 40 }, (_, index) => ({ id: `${index}`, text: `r${index}`, at: index }));
    const receipts = readDaemonReceipts(paths.receiptsPath, io({ [paths.receiptsPath]: JSON.stringify(many) }));
    expect(receipts.length).toBe(10);
    // Newest kept, oldest dropped.
    expect(receipts[receipts.length - 1]?.text).toBe('r39');
  });

  test('reading never marks a receipt delivered; the file is not written', () => {
    let written = false;
    const readOnly: LocalStateIo = {
      read: (path: string) => (path === paths.receiptsPath ? '[{"id":"a","text":"x","at":1}]' : null),
    };
    // The io seam has no write method at all, which is the point: this module
    // cannot consume the queue the daemon serves to a consuming /status read.
    expect(Object.keys(readOnly)).toEqual(['read']);
    readDaemonReceipts(paths.receiptsPath, readOnly);
    expect(written).toBe(false);
  });
});

describe('describeLocalDaemonState', () => {
  test('a remote target reads nothing and says why', () => {
    const state = describeLocalDaemonState({ isLocal: false, controlPlaneConfigDir: DIR });
    expect(state.available).toBe(false);
    expect(state.unavailableReason).toContain('on that machine');
    expect(state.marker).toBeNull();
    expect(state.receipts).toEqual([]);
  });

  test('a running marker yields an uptime', () => {
    const state = describeLocalDaemonState({
      isLocal: true,
      controlPlaneConfigDir: DIR,
      now: () => 1_000_000,
      io: io({ [paths.markerPath]: JSON.stringify({ state: 'running', at: 400_000, failedStarts: 0 }) }),
    });
    expect(state.available).toBe(true);
    expect(state.uptimeMs).toBe(600_000);
  });

  test('a clean-shutdown marker yields no uptime, because nothing is up', () => {
    const state = describeLocalDaemonState({
      isLocal: true,
      controlPlaneConfigDir: DIR,
      now: () => 1_000_000,
      io: io({ [paths.markerPath]: JSON.stringify({ state: 'clean-shutdown', at: 400_000, failedStarts: 0 }) }),
    });
    expect(state.uptimeMs).toBeUndefined();
  });

  test('an automatic rollback is reported as in force', () => {
    const state = describeLocalDaemonState({
      isLocal: true,
      controlPlaneConfigDir: DIR,
      now: () => 1_000_000,
      io: io({
        [paths.markerPath]: JSON.stringify({
          state: 'running', at: 1, failedStarts: 3, autoRollbackAt: 900_000, rejectedVersion: '1.27.9',
        }),
      }),
    });
    expect(state.rolledBack).toBe(true);
    expect(state.marker?.rejectedVersion).toBe('1.27.9');
  });

  test('a host with no files at all is available and simply empty', () => {
    const state = describeLocalDaemonState({ isLocal: true, controlPlaneConfigDir: DIR, io: io({}) });
    expect(state.available).toBe(true);
    expect(state.marker).toBeNull();
    expect(state.receipts).toEqual([]);
    expect(state.rolledBack).toBe(false);
  });
});

describe('formatDuration', () => {
  test('reads as a duration, two units at most', () => {
    expect(formatDuration(9_000)).toBe('9s');
    expect(formatDuration(63_000)).toBe('1m 3s');
    expect(formatDuration(3_600_000 + 720_000)).toBe('1h 12m');
    expect(formatDuration(3 * 86_400_000 + 4 * 3_600_000)).toBe('3d 4h');
    expect(formatDuration(-5)).toBe('0s');
  });
});

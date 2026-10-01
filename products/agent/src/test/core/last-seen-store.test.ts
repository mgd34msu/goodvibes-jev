import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { LastSeenStore, lastSeenStorePath } from '../../core/last-seen-store.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function tempStore(): { store: LastSeenStore; paths: ReturnType<typeof createShellPathService> } {
  const root = makeProjectTempDir('goodvibes-last-seen');
  const paths = createShellPathService({ workingDirectory: root, homeDirectory: root });
  return { store: LastSeenStore.fromShellPaths(paths), paths };
}

describe('LastSeenStore', () => {
  test('returns null when file does not exist (first run)', () => {
    const { store } = tempStore();
    expect(store.read()).toBeNull();
  });

  test('round-trip: save then read returns the same timestamp', () => {
    const { store } = tempStore();
    const ts = Date.now();
    store.save(ts);
    expect(store.read()).toBe(ts);
  });

  test('round-trip: overwrite with a newer timestamp', () => {
    const { store } = tempStore();
    const first = 1_700_000_000_000;
    const second = 1_700_000_060_000;
    store.save(first);
    store.save(second);
    expect(store.read()).toBe(second);
  });

  test('defaults to Date.now() when save() is called without argument', () => {
    const { store } = tempStore();
    const before = Date.now();
    store.save();
    const after = Date.now();
    const read = store.read();
    expect(read).not.toBeNull();
    expect(read!).toBeGreaterThanOrEqual(before);
    expect(read!).toBeLessThanOrEqual(after);
  });

  test('fromShellPaths resolves into GOODVIBES_AGENT_SURFACE_ROOT/last-seen.json', () => {
    const { paths } = tempStore();
    const p = lastSeenStorePath(paths);
    expect(p).toContain('last-seen.json');
    expect(p).toContain('agent');
  });

  test('read() returns null for corrupt file content', () => {
    const { store, paths } = tempStore();
    // Write a corrupt file by first saving a valid one, then overwriting
    store.save(1_700_000_000_000);
    // Corrupt the file via direct write
    const p = lastSeenStorePath(paths);
    writeFileSync(p, 'not-valid-json', 'utf-8');
    expect(store.read()).toBeNull();
  });
});

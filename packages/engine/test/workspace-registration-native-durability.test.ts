import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { promises as fs, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PersistentStore } from '../sdk/src/platform/state/persistent-store.ts';
import { WorkspaceRegistrationStore } from '../sdk/src/platform/workspace/registration/store.ts';
import * as atomic from '../sdk/src/platform/utils/atomic-json-store.ts';

const owned: string[] = [];
afterEach(() => { for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'native-scope-durability-')); owned.push(home);
  const root = join(home, 'project'); const other = join(home, 'other');
  mkdirSync(root); mkdirSync(other);
  const path = join(home, 'state', 'nested', 'registry.json');
  const make = () => new WorkspaceRegistrationStore({ path, homeDir: home, daemonStateDir: join(home, 'state'), probe: () => ({}) });
  return { home, root, other, path, make };
}

/** Preserve the reviewer's failure point: FileHandle.sync on the directory AFTER rename. */
function failDirectorySync(directory: string) {
  const open = fs.open.bind(fs);
  return spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
    const handle = await open(path, flags, mode);
    if (String(path) !== directory || flags !== 'r') return handle;
    return new Proxy(handle, {
      get(target, property) {
        if (property === 'sync') return async () => { throw new Error('fixture directory sync failed after rename'); };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });
}

describe('required native workspace publication durability', () => {
  test('PersistentStore keeps default behavior but required mode propagates post-rename directory sync failures', async () => {
    const f = fixture(); const store = new PersistentStore<{ value: string }>(f.path);
    const failure = failDirectorySync(dirname(f.path));
    try {
      await expect(store.persist({ value: 'default compatibility' })).resolves.toBeUndefined();
      await expect(store.persist({ value: 'strict visible bytes' }, { durable: true })).rejects.toThrow('directory sync failed after rename');
      expect(JSON.parse(readFileSync(f.path, 'utf8'))).toEqual({ value: 'strict visible bytes' });
    } finally { failure.mockRestore(); }
  });

  test('required directory durability covers every ancestor, including newly created directory entries', async () => {
    const f = fixture(); const store = new PersistentStore<{ value: number }>(f.path);
    const visited: string[] = []; const open = fs.open.bind(fs);
    const observed = spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      if (flags === 'r') visited.push(String(path));
      return open(path, flags, mode);
    });
    try { await store.persist({ value: 1 }, { durable: true }); } finally { observed.mockRestore(); }
    for (let directory = dirname(f.path);; directory = dirname(directory)) {
      expect(visited).toContain(directory);
      if (dirname(directory) === directory) break;
    }
  });

  test('add rejects a post-rename sync failure and the same owner refuses visible scope until an actual durable mutation', async () => {
    const f = fixture(); const store = f.make(); const failure = failDirectorySync(dirname(f.path));
    try { await expect(store.add(f.root)).rejects.toThrow('directory sync failed after rename'); } finally { failure.mockRestore(); }
    // New bytes may be visible: the fix must not roll them back or delete them.
    const visible = JSON.parse(readFileSync(f.path, 'utf8'));
    expect(visible.workspaces[0].root).toBe(f.root);
    expect(visible.workspaces[0].nativeScope.id).toMatch(/^workspace:/);
    expect(() => store.currentScope(f.root)).toThrow('unavailable');
    await store.add(f.root); // Idempotent, no durable mutation, no recovery.
    expect(() => store.currentScope(f.root)).toThrow('unavailable');
    await store.add(f.other); // Explicit new event commits the visible state durably.
    expect(store.currentScope(f.root).scopeId).toBe(visible.workspaces[0].nativeScope.id);
  });

  test('failed removal is never acknowledged or rolled back, and its owner fences other scopes too', async () => {
    const f = fixture(); const store = f.make(); await store.add(f.root); await store.add(f.other);
    const old = store.currentScope(f.root); const other = store.currentScope(f.other);
    const failure = failDirectorySync(dirname(f.path));
    try { await expect(store.remove(f.root)).rejects.toThrow('directory sync failed after rename'); } finally { failure.mockRestore(); }
    const visible = JSON.parse(readFileSync(f.path, 'utf8'));
    expect(visible.workspaces.some((row: { root: string }) => row.root === f.root)).toBe(false);
    expect(visible.scopeTombstones.some((row: { scopeId?: string }) => row.scopeId === old.scopeId)).toBe(true);
    expect(() => store.currentScope(f.other)).toThrow('unavailable');
    expect((await store.remove(f.root)).removed).toBe(false); // No-op cannot clear the fence.
    expect(() => store.currentScope(f.other)).toThrow('unavailable');
    await store.add(f.root); // Explicit recovery is a NEW incarnation, never the removed one.
    expect(store.currentScope(f.root).scopeId).not.toBe(old.scopeId);
    expect(store.currentScope(f.other).scopeId).toBe(other.scopeId);
  });

  test('a restarted owner must confirm visible authority durability and remains fenced if confirmation fails', async () => {
    const f = fixture(); const failedWriter = f.make(); const failure = failDirectorySync(dirname(f.path));
    try { await expect(failedWriter.add(f.root)).rejects.toThrow('directory sync failed after rename'); } finally { failure.mockRestore(); }
    const visible = JSON.parse(readFileSync(f.path, 'utf8'));
    const restarted = f.make();
    const confirmation = spyOn(atomic, 'confirmFileDurable').mockImplementation(() => { throw new Error('fixture restart durability uncertainty'); });
    try {
      expect(() => restarted.currentScope(f.root)).toThrow('unavailable');
      expect(confirmation).toHaveBeenCalledWith(f.path);
    } finally { confirmation.mockRestore(); }
    expect(() => restarted.currentScope(f.root)).toThrow('unavailable');
    expect(f.make().currentScope(f.root).scopeId).toBe(visible.workspaces[0].nativeScope.id);
    // Recovery explicitly commits the state, rather than retrying an ambiguous read.
    await restarted.add(f.other);
    expect(restarted.currentScope(f.root).scopeId).toBe(visible.workspaces[0].nativeScope.id);
  });

  test('confirmation of replaced bytes cannot attest the snapshot read before it', async () => {
    const f = fixture(); const store = f.make(); await store.add(f.root);
    const confirm = atomic.confirmFileDurable;
    const changed = spyOn(atomic, 'confirmFileDurable').mockImplementation((path) => {
      confirm(path);
      const bytes = JSON.parse(readFileSync(path, 'utf8'));
      bytes.scopeGeneration += 1;
      writeFileSync(path, JSON.stringify(bytes)); // Owned fixture simulates another writer.
    });
    try { expect(() => f.make().currentScope(f.root)).toThrow('unavailable'); } finally { changed.mockRestore(); }
  });
});

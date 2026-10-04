import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { AtomicWriteDurabilityError, confirmFileDurable, writeJsonFileAtomic } from '../sdk/src/platform/utils/atomic-json-store.js';
import { PairingTokenManager } from '../sdk/src/platform/pairing/pairing-token-store.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'gv-json-durable-')); roots.push(root);
  return { root, file: join(root, 'new', 'nested', 'state.json') };
}
function failure(operation: () => unknown): AtomicWriteDurabilityError {
  let caught: unknown;
  try { operation(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(AtomicWriteDurabilityError);
  return caught as AtomicWriteDurabilityError;
}
function sameInode(a: fs.Stats, b: fs.Stats) { return a.dev === b.dev && a.ino === b.ino; }

// Keep the original file-only repro as a compatibility assertion: strict
// durability is explicit, not an unbounded change to all historical writers.
test('historical atomic JSON defaults still fsync the file only', () => {
  const { file } = fixture(); const calls: string[] = []; const actual = fs.fsyncSync;
  const sync = spyOn(fs, 'fsyncSync').mockImplementation(fd => {
    calls.push(fs.fstatSync(fd).isDirectory() ? 'directory' : 'file'); actual(fd);
  });
  try { writeJsonFileAtomic(file, { value: 'default' }); } finally { sync.mockRestore(); }
  expect(calls).toEqual(['file']);
});

describe('strict atomic JSON durability', () => {
  test('strict publication fsyncs temp, renames, then confirms file and every ancestor through root', () => {
    const { file } = fixture(); const calls: string[] = []; const actualSync = fs.fsyncSync, actualRename = fs.renameSync;
    const sync = spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      const identity = fs.fstatSync(fd);
      if (!identity.isDirectory()) calls.push('file');
      else {
        for (let path = dirname(file);; path = dirname(path)) {
          if (sameInode(identity, fs.statSync(path))) { calls.push(path); break; }
          if (dirname(path) === path) throw new Error('Unexpected directory');
        }
      }
      actualSync(fd);
    });
    const rename = spyOn(fs, 'renameSync').mockImplementation((...args) => { calls.push('rename'); actualRename(...args); });
    try { writeJsonFileAtomic(file, { value: 'strict' }, { durable: true }); }
    finally { sync.mockRestore(); rename.mockRestore(); }
    const expected = ['file', 'rename', 'file'];
    for (let path = dirname(file);; path = dirname(path)) { expected.push(path); if (dirname(path) === path) break; }
    expect(calls).toEqual(expected);
  });

  test('failure before rename reports before-publication and leaves the old image untouched', () => {
    const { file } = fixture(); writeJsonFileAtomic(file, { value: 'old' });
    const old = fs.readFileSync(file, 'utf8');
    const sync = spyOn(fs, 'fsyncSync').mockImplementation(() => { throw new Error('injected file fsync failure'); });
    try {
      expect(failure(() => writeJsonFileAtomic(file, { value: 'next' }, { durable: true })).phase).toBe('before-publication');
      expect(fs.readFileSync(file, 'utf8')).toBe(old);
    } finally { sync.mockRestore(); }
  });

  test('serialization and short-write failures are before-publication', () => {
    const { file } = fixture(); writeJsonFileAtomic(file, { value: 'old' });
    const old = fs.readFileSync(file, 'utf8'); const circular: { value?: unknown } = {}; circular.value = circular;
    expect(failure(() => writeJsonFileAtomic(file, circular, { durable: true })).phase).toBe('before-publication');
    const write = spyOn(fs, 'writeSync').mockImplementation(() => 0);
    try {
      expect(failure(() => writeJsonFileAtomic(file, { value: 'next' }, { durable: true })).phase).toBe('before-publication');
      expect(fs.readFileSync(file, 'utf8')).toBe(old);
    } finally { write.mockRestore(); }
  });

  test('rename-parent failure is published-indeterminate, never rollback or successful acknowledgment', () => {
    const { file } = fixture(); writeJsonFileAtomic(file, { value: 'old' }); const actual = fs.fsyncSync;
    const sync = spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      if (fs.fstatSync(fd).isDirectory()) throw new Error('injected rename-parent fsync failure');
      actual(fd);
    });
    try {
      const error = failure(() => writeJsonFileAtomic(file, { value: 'next' }, { durable: true }));
      expect(error.phase).toBe('published-indeterminate');
      expect(error.cause).toBeInstanceOf(Error);
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ value: 'next' });
      expect(failure(() => confirmFileDurable(file)).phase).toBe('published-indeterminate');
    } finally { sync.mockRestore(); }
    expect(() => confirmFileDurable(file)).not.toThrow();
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ value: 'next' });
  });

  test('failure above the immediate parent also prevents a durable success', () => {
    const { file, root } = fixture(); const rootIdentity = fs.statSync(root), actual = fs.fsyncSync;
    const sync = spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      if (sameInode(fs.fstatSync(fd), rootIdentity)) throw new Error('injected ancestor fsync failure');
      actual(fd);
    });
    try { expect(failure(() => writeJsonFileAtomic(file, { value: 'next' }, { durable: true })).phase).toBe('published-indeterminate'); }
    finally { sync.mockRestore(); }
  });

  test('confirmation includes every intermediate symlink parent, not only final realpath ancestry', () => {
    const { root } = fixture();
    const outer = join(root, 'outer'), middle = join(root, 'middle'), actualRoot = join(root, 'actual');
    fs.mkdirSync(outer); fs.mkdirSync(middle); fs.mkdirSync(join(actualRoot, 'nested'), { recursive: true });
    fs.symlinkSync('../actual', join(middle, 'second'));
    fs.symlinkSync('../middle/second', join(outer, 'first'));
    const file = join(outer, 'first', 'nested', 'state.json'); writeJsonFileAtomic(file, {});
    const directories = [join(actualRoot, 'nested'), actualRoot, middle, outer];
    for (let path = root;; path = dirname(path)) { directories.push(path); if (dirname(path) === path) break; }
    const observed = new Set<string>(), actualSync = fs.fsyncSync;
    const sync = spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      const identity = fs.fstatSync(fd);
      if (identity.isDirectory()) for (const path of directories) if (sameInode(identity, fs.statSync(path))) observed.add(path);
      actualSync(fd);
    });
    try { confirmFileDurable(file); } finally { sync.mockRestore(); }
    expect([...observed].sort()).toEqual([...directories].sort());
  });

  test('retargeting a symlink during confirmation is indeterminate even for identical contents', () => {
    const { root } = fixture(); const first = join(root, 'first'), second = join(root, 'second'), alias = join(root, 'alias');
    fs.mkdirSync(first); fs.mkdirSync(second); writeJsonFileAtomic(join(first, 'state.json'), {}); writeJsonFileAtomic(join(second, 'state.json'), {});
    fs.symlinkSync(first, alias);
    const actualSync = fs.fsyncSync; let replaced = false;
    const sync = spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      actualSync(fd);
      if (!replaced && fs.fstatSync(fd).isFile()) { replaced = true; fs.unlinkSync(alias); fs.symlinkSync(second, alias); }
    });
    try { expect(failure(() => confirmFileDurable(join(alias, 'state.json'))).phase).toBe('published-indeterminate'); }
    finally { sync.mockRestore(); }
  });
});

describe('paired owner durable publication', () => {
  test('revoke cannot acknowledge a rename whose parent fsync failed; restart must reconfirm before native auth', () => {
    const { file } = fixture(); const manager = new PairingTokenManager(file);
    const revoked = manager.mint({ name: 'Synthetic revoked device' });
    const survivor = manager.mint({ name: 'Synthetic surviving device' });
    const actualSync = fs.fsyncSync; const calls: string[] = [];
    const sync = spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      const kind = fs.fstatSync(fd).isDirectory() ? 'directory' : 'file'; calls.push(kind);
      if (kind === 'directory') throw new Error('injected paired rename-parent failure');
      actualSync(fd);
    });
    let restarted: PairingTokenManager;
    try {
      expect(failure(() => manager.revoke(revoked.id)).phase).toBe('published-indeterminate');
      expect(calls).toEqual(['file', 'file', 'directory']);
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).tokens.map((token: { id: string }) => token.id)).toEqual([survivor.id]);
      expect(manager.authenticateNative(survivor.token)).toBeNull();
      restarted = new PairingTokenManager(file);
      expect(restarted.authenticateNative(survivor.token)).toBeNull();
      expect(restarted.authenticateNative(revoked.token)).toBeNull();
    } finally { sync.mockRestore(); }
    // An owner that observed failed confirmation retains its uncertainty fence
    // until an explicit durable recovery, including a no-change retry.
    expect(restarted!.authenticateNative(survivor.token)).toBeNull();
    expect(restarted!.revoke(revoked.id)).toBe(false);
    expect(restarted!.authenticateNative(survivor.token)?.tokenId).toBe(survivor.id);
    // A fresh owner still has to establish full durability before admission.
    expect(new PairingTokenManager(file).authenticateNative(survivor.token)?.tokenId).toBe(survivor.id);
    // Ordinary telemetry cannot clear the failed owner's uncertainty fence.
    manager.authenticate(survivor.token);
    expect(manager.authenticateNative(survivor.token)).toBeNull();
    // The explicit retry has no record left to delete, but must still confirm
    // current publication before it can clear the owner's uncertainty fence.
    expect(manager.revoke(revoked.id)).toBe(false);
    expect(manager.authenticateNative(survivor.token)?.tokenId).toBe(survivor.id);
    expect(new PairingTokenManager(file).authenticateNative(revoked.token)).toBeNull();
  });

  test('failed rename remains fenced through restart until current authority is durably confirmed', () => {
    const { file } = fixture(); const manager = new PairingTokenManager(file);
    const paired = manager.mint({ name: 'Synthetic device' }); const actualSync = fs.fsyncSync;
    const sync = spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      if (fs.fstatSync(fd).isDirectory()) throw new Error('injected paired directory failure');
      actualSync(fd);
    });
    try {
      expect(failure(() => manager.rename(paired.id, 'Published but unconfirmed')).phase).toBe('published-indeterminate');
      expect(manager.authenticateNative(paired.token)).toBeNull();
      expect(new PairingTokenManager(file).authenticateNative(paired.token)).toBeNull();
    } finally { sync.mockRestore(); }
    expect(new PairingTokenManager(file).authenticateNative(paired.token)?.tokenId).toBe(paired.id);
    expect(manager.authenticateNative(paired.token)).toBeNull();
    expect(manager.rename(paired.id, 'Recovered')).toBe(true);
    expect(manager.authenticateNative(paired.token)?.tokenId).toBe(paired.id);
  });
});

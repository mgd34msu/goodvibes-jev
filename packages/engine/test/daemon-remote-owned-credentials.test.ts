import { describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { OwnedCredentialDirectory, probeCredentialOwner, type CredentialOwnerStatus } from '../sdk/src/platform/runtime/remote/host/backends/owned-credential-directory.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const logger = { info() {}, warn() {}, error() {} };
function fixtureRoot() { return join(makeProjectTempDir('remote-owned-credentials'), 'ssh-keys'); }
function seedOwner(root: string, pid: number, nonce = 'abcdefghijklmnop') {
  const name = `owner-${pid}-${nonce}`;
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'owner.json'), JSON.stringify({ kind: 'goodvibes-remote-credential-owner', version: 1, pid, directory: name }));
  writeFileSync(join(path, 'fixture.key'), 'dummy credential');
  return path;
}

describe('owned credential scratch', () => {
  test('single-file cleanup can remove only this instance created files', async () => {
    const root = fixtureRoot();
    const owned = new OwnedCredentialDirectory({ rootDirectory: root, logger });
    const file = await owned.write('dummy', 'cred');
    const legacy = join(root, 'legacy.key');
    writeFileSync(legacy, 'dummy legacy');
    await expect(owned.remove(legacy)).rejects.toThrow('not owned');
    await owned.remove(file);
    expect(existsSync(file)).toBe(false);
    await owned.close();
    expect(readFileSync(legacy, 'utf8')).toBe('dummy legacy');
  });

  test('concurrent instances retain separate private files through individual teardown', async () => {
    const root = fixtureRoot();
    const a = new OwnedCredentialDirectory({ rootDirectory: root, logger });
    const b = new OwnedCredentialDirectory({ rootDirectory: root, logger });
    const [fileA, fileB] = await Promise.all([a.write('dummy A', 'key'), b.write('dummy B', 'cred')]);
    expect(dirname(fileA)).not.toBe(dirname(fileB));
    expect(readFileSync(fileA, 'utf8')).toBe('dummy A');
    expect(readFileSync(fileB, 'utf8')).toBe('dummy B');
    if (process.platform !== 'win32') {
      expect(statSync(fileA).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(fileA)).mode & 0o777).toBe(0o700);
    }
    await a.close();
    expect(existsSync(fileA)).toBe(false);
    expect(readFileSync(fileB, 'utf8')).toBe('dummy B');
    await b.close();
    expect(readdirSync(root)).toEqual([]);
  });

  test('deletes only marker-proven dead owners, preserving live, unknown and legacy entries', async () => {
    const root = fixtureRoot();
    const dead = seedOwner(root, 1001);
    const live = seedOwner(root, 1002);
    const unknown = seedOwner(root, 1003);
    const invalid = seedOwner(root, 1004);
    writeFileSync(join(invalid, 'owner.json'), '{malformed');
    const legacy = join(root, 'legacy.abcd1234.key');
    writeFileSync(legacy, 'dummy legacy credential');
    const probeOwner = (pid: number): CredentialOwnerStatus => pid === 1001 ? 'dead' : pid === 1002 ? 'alive' : 'unknown';
    const owned = new OwnedCredentialDirectory({ rootDirectory: root, logger, probeOwner });
    await owned.write('dummy new credential', 'cred');
    expect(existsSync(dead)).toBe(false);
    for (const path of [live, unknown, invalid]) expect(existsSync(join(path, 'fixture.key'))).toBe(true);
    expect(readFileSync(legacy, 'utf8')).toBe('dummy legacy credential');
    await owned.close();
    for (const path of [live, unknown, invalid, legacy]) expect(existsSync(path)).toBe(true);
  });

  test('a marker must match its directory and PID before a dead-owner probe can delete', async () => {
    const root = fixtureRoot();
    const invalid = seedOwner(root, 1111);
    writeFileSync(join(invalid, 'owner.json'), JSON.stringify({ kind: 'goodvibes-remote-credential-owner', version: 1, pid: 9999, directory: basename(invalid) }));
    let probes = 0;
    const owned = new OwnedCredentialDirectory({ rootDirectory: root, logger, probeOwner: () => { probes += 1; return 'dead'; } });
    await owned.directory();
    expect(probes).toBe(0);
    expect(existsSync(invalid)).toBe(true);
    await owned.close();
  });

  // Real POSIX symlink fixtures require no extra OS privileges. Windows
  // symlink privilege/configuration is not part of this test environment.
  if (process.platform !== 'win32') {
    test('POSIX: symlinked roots or parent components refuse without touching the target', async () => {
      const base = makeProjectTempDir('credential-root-symlink');
      const target = join(base, 'target');
      mkdirSync(target);
      writeFileSync(join(target, 'preserved'), 'untouched');
      const linked = join(base, 'linked');
      symlinkSync(target, linked, 'dir');
      for (const root of [linked, join(linked, 'nested')]) {
        const owned = new OwnedCredentialDirectory({ rootDirectory: root, logger });
        await expect(owned.write('dummy', 'cred')).rejects.toThrow('could not be prepared');
        await owned.close();
      }
      expect(readdirSync(target)).toEqual(['preserved']);
    });

    test('POSIX: symlinked entries and marker files are never followed by cleanup', async () => {
      const root = fixtureRoot();
      mkdirSync(root, { recursive: true });
      const outside = makeProjectTempDir('credential-outside');
      writeFileSync(join(outside, 'preserved'), 'untouched');
      const dead = seedOwner(root, 1000);
      symlinkSync(outside, join(dead, 'outside-link'), 'dir');
      symlinkSync(outside, join(root, 'owner-1001-abcdefghijklmnop'), 'dir');
      const markerLink = join(root, 'owner-1002-abcdefghijklmnop');
      mkdirSync(markerLink);
      const externalMarker = join(outside, 'owner.json');
      writeFileSync(externalMarker, JSON.stringify({ kind: 'goodvibes-remote-credential-owner', version: 1, pid: 1002, directory: basename(markerLink) }));
      symlinkSync(externalMarker, join(markerLink, 'owner.json'));
      const owned = new OwnedCredentialDirectory({ rootDirectory: root, logger, probeOwner: () => 'dead' });
      await owned.directory();
      await owned.close();
      expect(readFileSync(join(outside, 'preserved'), 'utf8')).toBe('untouched');
      expect(existsSync(dead)).toBe(false);
      expect(existsSync(markerLink)).toBe(true);
      expect(existsSync(externalMarker)).toBe(true);
    });
  } else {
    console.warn('[coverage] Real POSIX symlink cleanup assertions are unavailable on Windows.');
  }

  test('unknown file kinds refuse before creating a directory', async () => {
    const root = fixtureRoot();
    const owned = new OwnedCredentialDirectory({ rootDirectory: root, logger });
    await expect(owned.write('dummy', '../../escape' as 'key')).rejects.toThrow('Unknown');
    await owned.close();
    expect(existsSync(root)).toBe(false);
  });

  test('close waits for an in-flight write, then removes only its own directory', async () => {
    const root = fixtureRoot();
    const owned = new OwnedCredentialDirectory({ rootDirectory: root, logger });
    const directory = await owned.directory();
    let release!: () => void;
    let enter!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const originalOpen = fsPromises.open;
    const openSpy = spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('.cred')) { enter(); await held; }
      return originalOpen(...args);
    });
    let pending: Promise<string> | undefined;
    let closing: Promise<void> | undefined;
    let closed = false;
    try {
      pending = owned.write('dummy pending credential', 'cred');
      await entered;
      closing = owned.close().then(() => { closed = true; });
      await Promise.resolve();
      expect(closed).toBe(false);
    } finally {
      release();
      await pending;
      await closing;
      openSpy.mockRestore();
    }
    expect(existsSync(directory)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
    await expect(owned.write('dummy late credential', 'cred')).rejects.toThrow('closed');
  });
});

test('only ESRCH is definite dead-owner evidence', () => {
  const kill = spyOn(process, 'kill');
  try {
    kill.mockImplementation(() => true);
    expect(probeCredentialOwner(123)).toBe('alive');
    for (const code of ['EPERM', 'EINVAL']) {
      kill.mockImplementation(() => { throw Object.assign(new Error('fixture probe'), { code }); });
      expect(probeCredentialOwner(123)).toBe('unknown');
    }
    kill.mockImplementation(() => { throw Object.assign(new Error('fixture probe'), { code: 'ESRCH' }); });
    expect(probeCredentialOwner(123)).toBe('dead');
  } finally { kill.mockRestore(); }
});

import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUpstreamSourceSnapshot, verifyUpstreamSourceSnapshot } from '../scripts/upstream-source-snapshot.ts';

const script = fileURLToPath(new URL('../scripts/upstream-source-snapshot.ts', import.meta.url));
const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(directory: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8', timeout: 10_000 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr);
  return result.stdout.trim();
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'gv-upstream-source-'));
  tempDirs.push(directory);
  git(directory, 'init', '-q', '--object-format=sha1');
  git(directory, 'config', 'user.name', 'Snapshot Fixture');
  git(directory, 'config', 'user.email', 'snapshot@example.invalid');
  git(directory, 'config', 'commit.gpgsign', 'false');
  mkdirSync(join(directory, 'src'));
  writeFileSync(join(directory, 'src', 'entry.ts'), 'export const value = "first";\n');
  writeFileSync(join(directory, 'run.sh'), '#!/bin/sh\nexit 0\n');
  git(directory, 'add', '.');
  git(directory, 'update-index', '--chmod=+x', 'run.sh');
  git(directory, 'commit', '-qm', 'first');
  const first = git(directory, 'rev-parse', 'HEAD');
  writeFileSync(join(directory, 'src', 'entry.ts'), 'export const value = "second";\n');
  git(directory, 'add', 'src/entry.ts');
  git(directory, 'commit', '-qm', 'second');
  return { directory, first, second: git(directory, 'rev-parse', 'HEAD') };
}

function cli(...args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 10_000 });
  expect(result.error).toBeUndefined();
  return result;
}

describe('pinned upstream source snapshots', () => {
  test('same paths with changed content have different object identities; an exact record passes', () => {
    const { directory, first, second } = fixture();
    const older = createUpstreamSourceSnapshot(directory, first);
    const newer = createUpstreamSourceSnapshot(directory, second);
    expect(older.entries.map((entry) => entry.path)).toEqual(newer.entries.map((entry) => entry.path));
    expect(older.entries.find((entry) => entry.path === 'src/entry.ts')?.object).not.toBe(newer.entries.find((entry) => entry.path === 'src/entry.ts')?.object);
    expect(older.tree).not.toBe(newer.tree);
    expect(older.entries.find((entry) => entry.path === 'run.sh')?.mode).toBe('100755');
    expect(() => verifyUpstreamSourceSnapshot(directory, first, older)).not.toThrow();
    expect(() => verifyUpstreamSourceSnapshot(directory, second, older)).toThrow('commit mismatch');
    expect(() => verifyUpstreamSourceSnapshot(directory, second, { ...older, commit: second, tree: newer.tree })).toThrow('object mismatch at "src/entry.ts"');
  });

  test('an explicit older commit remains stable after HEAD, index, worktree, and replacement refs change', () => {
    const { directory, first, second } = fixture();
    const snapshot = createUpstreamSourceSnapshot(directory, first);
    writeFileSync(join(directory, 'src', 'entry.ts'), 'third committed version\n');
    git(directory, 'add', 'src/entry.ts');
    git(directory, 'commit', '-qm', 'third');
    writeFileSync(join(directory, 'src', 'entry.ts'), 'staged content\n');
    git(directory, 'add', 'src/entry.ts');
    writeFileSync(join(directory, 'src', 'entry.ts'), 'unstaged content\n');
    writeFileSync(join(directory, 'untracked.txt'), 'untracked content\n');
    git(directory, 'replace', first, second);
    const beforeStatus = git(directory, 'status', '--porcelain=v1');
    const beforeHead = git(directory, 'rev-parse', 'HEAD');
    expect(createUpstreamSourceSnapshot(directory, first)).toEqual(snapshot);
    expect(() => verifyUpstreamSourceSnapshot(directory, first, snapshot)).not.toThrow();
    expect(git(directory, 'status', '--porcelain=v1')).toBe(beforeStatus);
    expect(git(directory, 'rev-parse', 'HEAD')).toBe(beforeHead);
  });

  test('tampered content, file modes, paths, omitted entries, and root trees fail', () => {
    const { directory, first, second } = fixture();
    const snapshot = createUpstreamSourceSnapshot(directory, first);
    const changed = createUpstreamSourceSnapshot(directory, second).entries.find((entry) => entry.path === 'src/entry.ts')!;
    for (const [field, value, message] of [
      ['object', changed.object, 'object mismatch'],
      ['mode', '100755', 'mode mismatch'],
      ['path', 'src/renamed.ts', 'Unexpected snapshot path'],
    ] as const) {
      const entries = snapshot.entries.map((entry) => entry.path === 'src/entry.ts' ? { ...entry, [field]: value } : entry);
      expect(() => verifyUpstreamSourceSnapshot(directory, first, { ...snapshot, entries })).toThrow(message);
    }
    expect(() => verifyUpstreamSourceSnapshot(directory, first, { ...snapshot, entries: snapshot.entries.slice(1) })).toThrow('Missing snapshot path');
    expect(() => verifyUpstreamSourceSnapshot(directory, first, { ...snapshot, tree: second })).toThrow('root tree mismatch');
  });

  test('unusual UTF-8 paths, symlinks, and gitlinks retain their exact identities', () => {
    const { directory, first } = fixture();
    const path = 'src/sp ace\tline\nλ.ts';
    writeFileSync(join(directory, path), 'odd path\n');
    symlinkSync('src/entry.ts', join(directory, 'entry-link'));
    git(directory, 'add', '.');
    git(directory, 'update-index', '--add', '--cacheinfo', `160000,${first},vendor/pinned`);
    git(directory, 'commit', '-qm', 'special entries');
    const commit = git(directory, 'rev-parse', 'HEAD');
    const snapshot = createUpstreamSourceSnapshot(directory, commit);
    expect(snapshot.entries.find((entry) => entry.path === path)).toMatchObject({ mode: '100644', type: 'blob', object: git(directory, 'rev-parse', `${commit}:${path}`) });
    expect(snapshot.entries.find((entry) => entry.path === 'entry-link')).toMatchObject({ mode: '120000', type: 'blob', object: git(directory, 'rev-parse', `${commit}:entry-link`) });
    expect(snapshot.entries.find((entry) => entry.path === 'vendor/pinned')).toEqual({ path: 'vendor/pinned', mode: '160000', type: 'commit', object: first });
    expect(() => verifyUpstreamSourceSnapshot(directory, commit, JSON.parse(JSON.stringify(snapshot)))).not.toThrow();
  });

  test('malformed revisions, non-commit pins, and inconsistent snapshots are rejected', () => {
    const { directory, first } = fixture();
    for (const revision of ['HEAD', first.slice(0, 12), `${first}^{tree}`, '--help', `${first}; echo injected`]) {
      expect(() => createUpstreamSourceSnapshot(directory, revision)).toThrow('explicit full lowercase Git object ID');
    }
    const snapshot = createUpstreamSourceSnapshot(directory, first);
    expect(() => createUpstreamSourceSnapshot(directory, snapshot.tree)).toThrow('not a commit');
    for (const [value, message] of [
      [{ ...snapshot, schemaVersion: 2 }, 'schemaVersion 1'],
      [{ ...snapshot, entries: [...snapshot.entries, snapshot.entries[0]] }, 'Duplicate'],
      [{ ...snapshot, entries: [{ ...snapshot.entries[0], type: 'commit' }] }, 'mode/type'],
      [{ ...snapshot, entries: [{ ...snapshot.entries[0], object: 'not-an-object' }] }, 'object ID'],
      [{ ...snapshot, entries: [{ ...snapshot.entries[0], path: '../outside' }] }, 'Invalid source snapshot path'],
    ] as const) {
      expect(() => verifyUpstreamSourceSnapshot(directory, first, value)).toThrow(message);
    }
  });

  test('the selected repository wins over inherited Git settings and missing pins are never fetched', () => {
    const { directory, first } = fixture();
    const remote = fixture();
    writeFileSync(join(remote.directory, 'src', 'entry.ts'), 'available only in the remote\n');
    git(remote.directory, 'add', 'src/entry.ts');
    git(remote.directory, 'commit', '-qm', 'remote only');
    const remoteCommit = git(remote.directory, 'rev-parse', 'HEAD');
    const file = join(directory, 'snapshot.json');
    const selected = spawnSync(process.execPath, [script, '--source-dir', directory, '--commit', first, '--snapshot', file], {
      env: { ...process.env, GIT_DIR: join(remote.directory, '.git'), GIT_WORK_TREE: remote.directory },
      encoding: 'utf8', timeout: 10_000,
    });
    expect(selected.error).toBeUndefined();
    expect(selected.status).toBe(0);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(createUpstreamSourceSnapshot(directory, first));

    // A promisor remote could satisfy this pin, but verification must use only
    // already-present objects and leave the source repository unchanged.
    git(directory, 'config', 'remote.origin.url', remote.directory);
    git(directory, 'config', 'remote.origin.promisor', 'true');
    git(directory, 'config', 'remote.origin.partialclonefilter', 'blob:none');
    const before = git(directory, 'count-objects', '-v');
    expect(() => createUpstreamSourceSnapshot(directory, remoteCommit)).toThrow('Git read failed for source');
    expect(git(directory, 'count-objects', '-v')).toBe(before);
    expect(git(directory, 'rev-parse', 'HEAD')).not.toBe(remoteCommit);
  });

  test('CLI writes and checks the exact pin, reports tampering, and preserves Git failure status', () => {
    const { directory, first, second } = fixture();
    const file = join(directory, 'snapshot.json');
    const args = ['--source-dir', directory, '--commit', first, '--snapshot', file];
    expect(cli(...args).status).toBe(0);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(createUpstreamSourceSnapshot(directory, first));
    expect(cli(...args, '--check').status).toBe(0);
    const mismatch = cli('--source-dir', directory, '--commit', second, '--snapshot', file, '--check');
    expect(mismatch.status).toBe(1);
    expect(mismatch.stderr).toContain('commit mismatch');
    const snapshot = createUpstreamSourceSnapshot(directory, first);
    writeFileSync(file, JSON.stringify({ ...snapshot, entries: [] }));
    const tampered = cli(...args, '--check');
    expect(tampered.status).toBe(1);
    expect(tampered.stderr).toContain('Missing snapshot path');
    const unavailable = cli('--source-dir', join(directory, 'absent'), '--commit', first, '--snapshot', file, '--check');
    expect(unavailable.status).toBe(128);
    expect(unavailable.stderr).toContain('Git read failed for source');
    const missingCommit = cli('--source-dir', directory, '--commit', '0'.repeat(40), '--snapshot', file);
    expect(missingCommit.status).toBe(128);
    expect(missingCommit.stderr).toContain('Git read failed for source');
    // A failed generation must leave the previous evidence intact.
    expect(readFileSync(file, 'utf8')).toBe(JSON.stringify({ ...snapshot, entries: [] }));
  });
});

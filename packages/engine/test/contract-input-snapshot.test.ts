import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertContractInputObjects, assertContractInputOwner, assertContractInputView, captureContractInput, contractInputPath, isContractInputSnapshot, materializeContractInput, initializeContractMemberWorktree } from '../sdk/src/platform/contract/input-snapshot.js';

const roots: string[] = [];
function git(root: string, ...args: string[]): Buffer {
  const r = spawnSync('git', ['-C', root, ...args]);
  if (r.status !== 0) throw new Error(r.stderr.toString());
  return r.stdout;
}
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'contract-input-test-')); roots.push(root);
  git(root, 'init', '-q'); git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(root, '.gitignore'), '.goodvibes/\nignored.txt\n');
  writeFileSync(join(root, 'tracked.ts'), 'export const value = 1;\n');
  mkdirSync(join(root, 'removed')); writeFileSync(join(root, 'removed/deleted.ts'), 'delete me');
  git(root, 'add', '.'); git(root, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture');
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function view(root: string, snapshot: Awaited<ReturnType<typeof captureContractInput>>): Promise<string> {
  const path = contractInputPath(snapshot);
  git(root, '-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--no-checkout', '-b', `input/${snapshot.id}`, path, snapshot.inputCommit);
  await materializeContractInput(snapshot, path);
  return path;
}

describe('local frozen contract input', () => {
  test('preserves staged, unstaged, deleted, untracked, binary and executable bytes without changing owner/index/branch', async () => {
    const root = repo();
    writeFileSync(join(root, 'tracked.ts'), 'staged\n'); git(root, 'add', 'tracked.ts');
    writeFileSync(join(root, 'tracked.ts'), 'staged plus unstaged\n');
    writeFileSync(join(root, 'untracked.ts'), 'new file\n');
    writeFileSync(join(root, 'binary.bin'), Buffer.from([0, 255, 34, 0, 128]));
    writeFileSync(join(root, 'executable.sh'), 'synthetic executable\n'); chmodSync(join(root, 'executable.sh'), 0o755);
    rmSync(join(root, 'removed'), { recursive: true });
    writeFileSync(join(root, 'ignored.txt'), 'not input');
    mkdirSync(join(root, '.goodvibes')); writeFileSync(join(root, '.goodvibes/runtime'), 'not input');
    mkdirSync(join(root, '.aws')); writeFileSync(join(root, '.aws/credentials'), 'synthetic excluded marker');
    const index = readFileSync(join(root, '.git/index')); const head = git(root, 'rev-parse', 'HEAD');
    const snapshot = await captureContractInput(root);
    expect(snapshot.dirty).toBe(true); expect(isContractInputSnapshot(snapshot)).toBe(true);
    expect(snapshot.files.some((f) => f.path.startsWith('.aws') || f.path.startsWith('.goodvibes') || f.path === 'ignored.txt')).toBe(false);
    expect(snapshot.files.find((f) => f.path === 'removed/deleted.ts')?.kind).toBe('missing');
    expect(readFileSync(join(root, '.git/index'))).toEqual(index); expect(git(root, 'rev-parse', 'HEAD')).toEqual(head);
    const frozen = await view(root, snapshot);
    expect(readFileSync(join(frozen, 'tracked.ts'), 'utf8')).toBe('staged plus unstaged\n');
    expect(readFileSync(join(frozen, 'binary.bin'))).toEqual(Buffer.from([0, 255, 34, 0, 128]));
    expect(readFileSync(join(frozen, 'untracked.ts'), 'utf8')).toBe('new file\n');
    expect(lstatSync(join(frozen, 'executable.sh')).mode & 0o111).not.toBe(0);
    expect(existsSync(join(frozen, 'removed/deleted.ts'))).toBe(false);
    await assertContractInputView(snapshot); await assertContractInputOwner(snapshot);
    writeFileSync(join(root, 'tracked.ts'), 'later owner edit\n');
    expect(readFileSync(join(frozen, 'tracked.ts'), 'utf8')).toBe('staged plus unstaged\n');
    await expect(assertContractInputOwner(snapshot)).rejects.toThrow('owner changed');
  });

  test('clean generations use owner HEAD; concurrent captures have isolated ids and temporary indexes', async () => {
    const root = repo(); const index = readFileSync(join(root, '.git/index'));
    const [a, b] = await Promise.all([captureContractInput(root), captureContractInput(root)]);
    expect(a.id).not.toBe(b.id); expect(a.inputCommit).toBe(a.ownerHead); expect(a.dirty).toBe(false);
    expect(b.inputTree).toBe(a.inputTree); expect(readFileSync(join(root, '.git/index'))).toEqual(index);
    assertContractInputObjects(a, root);
  });

  test('staged-only input is dirty even when working bytes equal HEAD', async () => {
    const root = repo(); writeFileSync(join(root, 'tracked.ts'), 'staged only'); git(root, 'add', 'tracked.ts');
    writeFileSync(join(root, 'tracked.ts'), 'export const value = 1;\n');
    const snapshot = await captureContractInput(root);
    expect(snapshot.inputCommit).toBe(snapshot.ownerHead); expect(snapshot.dirty).toBe(true);
  });

  test('does not execute capture hooks or clean/smudge filters', async () => {
    const root = repo();
    writeFileSync(join(root, '.gitattributes'), '*.ts filter=marker\n');
    git(root, 'config', 'filter.marker.clean', 'touch CAPTURE_FILTER_RAN; cat');
    git(root, 'config', 'filter.marker.smudge', 'touch CAPTURE_FILTER_RAN; cat');
    const hook = join(root, '.git/hooks/post-checkout'); writeFileSync(hook, '#!/bin/sh\ntouch CAPTURE_HOOK_RAN\n'); chmodSync(hook, 0o755);
    const snapshot = await captureContractInput(root); const frozen = await view(root, snapshot);
    expect(existsSync(join(root, 'CAPTURE_FILTER_RAN'))).toBe(false); expect(existsSync(join(frozen, 'CAPTURE_FILTER_RAN'))).toBe(false);
    expect(existsSync(join(frozen, 'CAPTURE_HOOK_RAN'))).toBe(false);
  });

  test('preserves contained file symlinks and holds escaping, dangling or cyclic links', async () => {
    const root = repo(); symlinkSync('tracked.ts', join(root, 'link.ts'));
    const snapshot = await captureContractInput(root); const frozen = await view(root, snapshot);
    expect(lstatSync(join(frozen, 'link.ts')).isSymbolicLink()).toBe(true);
    symlinkSync('/etc/passwd', join(root, 'outside'));
    await expect(captureContractInput(root)).rejects.toThrow('absolute or ambiguous'); unlinkSync(join(root, 'outside'));
    symlinkSync('absent', join(root, 'dangling')); await expect(captureContractInput(root)).rejects.toThrow('uncaptured'); unlinkSync(join(root, 'dangling'));
    symlinkSync('cycle-b', join(root, 'cycle-a')); symlinkSync('cycle-a', join(root, 'cycle-b'));
    await expect(captureContractInput(root)).rejects.toThrow('cycle');
  });

  test('holds FIFO, replaced file/index, cancelled and bounded captures without source mutation', async () => {
    const root = repo(); const before = readFileSync(join(root, '.git/index'));
    const fifo = spawnSync('mkfifo', [join(root, 'pipe')]); expect(fifo.status).toBe(0);
    await expect(captureContractInput(root)).rejects.toThrow('special file'); unlinkSync(join(root, 'pipe'));
    await expect(captureContractInput(root, { signal: AbortSignal.abort() })).rejects.toThrow();
    await expect(captureContractInput(root, { maxBytes: 1 })).rejects.toThrow('byte bound');
    expect(readFileSync(join(root, '.git/index'))).toEqual(before);
    const snapshot = await captureContractInput(root);
    const bytes = readFileSync(join(root, 'tracked.ts')); renameSync(join(root, 'tracked.ts'), join(root, 'old')); writeFileSync(join(root, 'tracked.ts'), bytes); unlinkSync(join(root, 'old'));
    await expect(assertContractInputOwner(snapshot)).rejects.toThrow('owner changed');
    const second = await captureContractInput(root); writeFileSync(join(root, 'tracked.ts'), 'staged replacement'); git(root, 'add', 'tracked.ts');
    await expect(assertContractInputOwner(second)).rejects.toThrow('index changed');
  });

  test('receipt corruption and changed recorded view hold recovery', async () => {
    const root = repo(); const snapshot = await captureContractInput(root); const frozen = await view(root, snapshot);
    expect(isContractInputSnapshot({ ...snapshot, version: 2 })).toBe(false);
    expect(isContractInputSnapshot({ ...snapshot, files: [...snapshot.files, snapshot.files[0]] })).toBe(false);
    expect(() => assertContractInputObjects({ ...snapshot, inputTree: '0'.repeat(40) }, root)).toThrow('mismatch');
    writeFileSync(join(frozen, 'tracked.ts'), 'changed snapshot');
    await expect(assertContractInputView(snapshot)).rejects.toThrow('view changed');
  });
});


test('denied captured source exports stay withheld from the repository map', async () => {
  const { defaultRepositoryMap } = await import('../sdk/src/platform/contract/planner.js');
  const { createContractInputAuthority, withContractInputAuthority } = await import('../sdk/src/platform/contract/input-authority.js');
  const root = repo(); writeFileSync(join(root, 'secret.ts'), 'export const SYNTHETIC_PRIVATE_EXPORT = 123;\n');
  const snapshot = await captureContractInput(root); const frozen = await view(root, snapshot);
  const authority = await createContractInputAuthority({ projectRoot: root, inputSnapshot: snapshot } as import('../sdk/src/platform/contract/types.js').Contract, frozen);
  const checked: string[] = [];
  const map = await withContractInputAuthority(authority, () => defaultRepositoryMap(frozen, async (path) => { checked.push(path); return !path.endsWith('/secret.ts'); }));
  expect(checked.some((path) => path === join(frozen, 'secret.ts'))).toBe(true);
  expect(map).not.toContain('SYNTHETIC_PRIVATE_EXPORT');
});

test('raw member initializer preserves captured bytes and runs neither smudge nor checkout/reference hooks', async () => {
  const { IsolatedWorktree } = await import('../sdk/src/platform/agents/worktree.js');
  const root = repo();
  writeFileSync(join(root, '.gitattributes'), '*.ts filter=marker\n');
  git(root, 'config', 'filter.marker.smudge', 'touch FILTER_RAN; cat');
  for (const name of ['post-checkout', 'reference-transaction']) {
    const hook = join(root, '.git/hooks', name); writeFileSync(hook, '#!/bin/sh\ntouch HOOK_RAN\n'); chmodSync(hook, 0o755);
  }
  const snapshot = await captureContractInput(root); const frozen = await view(root, snapshot);
  const path = join(root, '.goodvibes/member');
  await initializeContractMemberWorktree(frozen, new IsolatedWorktree(frozen, path, 'member/input', `input/${snapshot.id}`));
  expect(readFileSync(join(path, 'tracked.ts'))).toEqual(readFileSync(join(frozen, 'tracked.ts')));
  for (const directory of [root, frozen, path]) {
    expect(existsSync(join(directory, 'FILTER_RAN'))).toBe(false); expect(existsSync(join(directory, 'HOOK_RAN'))).toBe(false);
  }
});


test('an observed racing source writer holds admission rather than silently selecting another generation', async () => {
  const root = repo(); let writes = 0;
  const timer = setInterval(() => { writeFileSync(join(root, 'tracked.ts'), `racing value ${++writes}\n`); }, 1);
  try { await expect(captureContractInput(root)).rejects.toThrow(/changed|replaced/); }
  finally { clearInterval(timer); }
  expect(writes).toBeGreaterThan(0);
});

test('an index replaced during capture holds even if the logical staged entries are identical', async () => {
  const root = repo(); const contents = readFileSync(join(root, '.git/index')); let swaps = 0;
  const timer = setInterval(() => {
    writeFileSync(join(root, '.git/index-swap'), contents);
    renameSync(join(root, '.git/index-swap'), join(root, '.git/index'));
    swaps++;
  }, 1);
  try { await expect(captureContractInput(root)).rejects.toThrow('index replaced'); }
  finally { clearInterval(timer); }
  expect(swaps).toBeGreaterThan(0); expect(readFileSync(join(root, '.git/index'))).toEqual(contents);
});

test('redirected runtime storage is held before materialization', async () => {
  const { prepareContractInputParent } = await import('../sdk/src/platform/contract/input-snapshot.js');
  const root = repo(); const outside = mkdtempSync(join(tmpdir(), 'contract-input-outside-')); roots.push(outside);
  symlinkSync(outside, join(root, '.goodvibes'));
  const snapshot = await captureContractInput(root);
  await expect(prepareContractInputParent(snapshot, contractInputPath(snapshot))).rejects.toThrow('redirected');
  expect(existsSync(join(outside, '.worktrees'))).toBe(false);
});

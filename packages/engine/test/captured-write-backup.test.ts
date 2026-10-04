import { judgmentInputBoundary } from '../sdk/src/platform/gate/boundary.js';
import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync,
  renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import {
  authorizeContractInputPath, createContractInputAuthority, revokeContractInputAuthority,
} from '../sdk/src/platform/contract/input-authority.js';
import { captureContractInput, contractInputPath, materializeContractInput } from '../sdk/src/platform/contract/input-snapshot.js';
import type { Contract } from '../sdk/src/platform/contract/types.js';
import type { CapturedExecAuthority } from '../sdk/src/platform/tools/exec/captured-exec.js';
import { prepareCapturedWriteBackup } from '../sdk/src/platform/tools/shared/captured-write-backup.js';
import type { ReadAccessFilter } from '../sdk/src/platform/tools/shared/read-access.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function git(root: string, ...args: string[]): void {
  const result = spawnSync('git', ['-C', root, ...args]);
  if (result.status !== 0) throw new Error(result.stderr.toString());
}
async function fixture(mutable = true) {
  const owner = mkdtempSync(join(tmpdir(), 'captured-write-backup-')); roots.push(owner);
  git(owner, 'init', '-q'); git(owner, 'config', 'user.name', 'Fixture'); git(owner, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(owner, '.gitignore'), '.goodvibes/\n');
  mkdirSync(join(owner, 'nested'));
  const bytes = Buffer.from([0, 255, 13, 10, 128, 65]);
  writeFileSync(join(owner, 'nested/source.bin'), bytes);
  git(owner, 'add', '.'); git(owner, 'commit', '-qm', 'fixture');
  const inputSnapshot = await captureContractInput(owner);
  const root = contractInputPath(inputSnapshot);
  const branch = `input/${inputSnapshot.id}`;
  git(owner, 'worktree', 'add', '--no-checkout', '-b', branch, root, inputSnapshot.inputCommit);
  await materializeContractInput(inputSnapshot, root);
  const controller = new AbortController();
  const authority = await createContractInputAuthority({ projectRoot: owner, inputSnapshot } as Contract,
    root, { mutable, branch, signal: controller.signal });
  const binding: CapturedExecAuthority = { authority, root, readAccessFilter: async () => true, signal: controller.signal };
  return { owner, root, authority, binding, controller, bytes, source: join(root, 'nested/source.bin') };
}

test('generated captured backup preserves bytes, mode, exact permissions and member-only receipt', async () => {
  const f = await fixture(); const checked: string[] = [];
  chmodSync(f.source, 0o640);
  const binding = { ...f.binding, readAccessFilter: async (path: string) => { checked.push(path); return true; } };
  const backup = await prepareCapturedWriteBackup(binding, f.source);
  const rel = relative(f.root, backup.path);
  expect(rel).toMatch(/^\.goodvibes[/\\]\.backups[/\\]nested[/\\]source\.bin\.owned_[a-t_]+$/);
  expect(existsSync(backup.path)).toBe(false);
  expect(judgmentInputBoundary('read', { path: backup.path }, f.owner).passed).toBe(true);
  expect(existsSync(join(f.root, '.goodvibes'))).toBe(false);
  expect(checked).toContain(join(f.owner, 'nested/source.bin')); expect(checked).toContain(f.source);
  expect(checked).toContain(join(f.owner, rel)); expect(checked).toContain(backup.path);
  backup.create();
  expect(readFileSync(backup.path)).toEqual(f.bytes);
  expect(statSync(backup.path).mode & 0o777).toBe(0o640);
  expect(existsSync(join(f.owner, rel))).toBe(false);
  expect(readFileSync(join(f.owner, 'nested/source.bin'))).toEqual(f.bytes);
  // Normal atomic source replacement must not invalidate the actual backup.
  writeFileSync(join(f.root, 'replacement'), 'replacement'); renameSync(join(f.root, 'replacement'), f.source);
  await backup.assertCurrent();
  expect(() => backup.create()).toThrow('single-use');
  await expect(authorizeContractInputPath(f.authority, backup.path, binding.readAccessFilter)).rejects.toThrow('outside authorized');
});

test('backup planning is side-effect-free and each generated receipt is unique', async () => {
  const f = await fixture();
  const first = await prepareCapturedWriteBackup(f.binding, f.source);
  const second = await prepareCapturedWriteBackup(f.binding, f.source);
  expect(first.path).not.toBe(second.path);
  await first.assertCurrent(); await second.assertCurrent();
  expect(existsSync(join(f.root, '.goodvibes'))).toBe(false);
});

for (const side of ['original', 'copy'] as const)
  for (const destination of ['source', 'backup'] as const)
    test(`denied ${side} ${destination} cannot create a captured backup`, async () => {
      const f = await fixture(); const deniedRoot = side === 'original' ? f.owner : f.root;
      const filter: ReadAccessFilter = async (path) => destination === 'source'
        ? path !== join(deniedRoot, 'nested/source.bin')
        : !path.startsWith(`${join(deniedRoot, '.goodvibes', '.backups')}${sep}`);
      await expect(prepareCapturedWriteBackup({ ...f.binding, readAccessFilter: filter }, f.source)).rejects.toThrow();
      expect(existsSync(join(f.root, '.goodvibes'))).toBe(false);
    });

for (const side of ['original', 'copy'] as const)
  test(`existing ${side} generated destination is never opened or overwritten`, async () => {
    const f = await fixture(); const backup = await prepareCapturedWriteBackup(f.binding, f.source);
    const destination = side === 'original' ? join(f.owner, relative(f.root, backup.path)) : backup.path;
    mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, 'existing runtime secret');
    expect(() => backup.create()).toThrow();
    await expect(backup.assertCurrent()).rejects.toThrow();
    expect(readFileSync(destination, 'utf8')).toBe('existing runtime secret');
  });

test('an original destination introduced by a callback never reaches the original destination filter', async () => {
  const f = await fixture(); let originalDestination = ''; let destinationChecks = 0; let inject = false;
  const binding = { ...f.binding, readAccessFilter: async (path: string) => {
    if (inject && path === join(f.owner, 'nested/source.bin')) {
      mkdirSync(dirname(originalDestination), { recursive: true }); writeFileSync(originalDestination, 'runtime secret');
    }
    if (path.startsWith(`${join(f.owner, '.goodvibes', '.backups')}${sep}`)) {
      originalDestination = path; destinationChecks++;
    }
    return true;
  } };
  const backup = await prepareCapturedWriteBackup(binding, f.source);
  const checked = destinationChecks;
  inject = true;
  await expect(backup.assertCurrent()).rejects.toThrow();
  expect(destinationChecks).toBe(checked);
  expect(existsSync(backup.path)).toBe(false);
});

test('a copy destination introduced during original permission is not passed to the copy filter', async () => {
  const f = await fixture(); let copiedDestination = ''; let copyChecks = 0;
  await expect(prepareCapturedWriteBackup({ ...f.binding, readAccessFilter: async (path: string) => {
    if (path.startsWith(`${join(f.owner, '.goodvibes', '.backups')}${sep}`)) {
      copiedDestination = join(f.root, relative(f.owner, path));
      mkdirSync(dirname(copiedDestination), { recursive: true }); writeFileSync(copiedDestination, 'unrelated runtime bytes');
    }
    if (path.startsWith(`${join(f.root, '.goodvibes', '.backups')}${sep}`)) copyChecks++;
    return true;
  } }, f.source)).rejects.toThrow();
  expect(copyChecks).toBe(0);
  expect(readFileSync(copiedDestination, 'utf8')).toBe('unrelated runtime bytes');
});

for (const side of ['original', 'copy'] as const)
  test(`a created backup still requires current ${side} source and destination permissions`, async () => {
    const f = await fixture(); let denied = '';
    const backup = await prepareCapturedWriteBackup({ ...f.binding, readAccessFilter: async (path: string) => path !== denied }, f.source);
    backup.create();
    denied = join(side === 'original' ? f.owner : f.root, 'nested/source.bin');
    await expect(backup.assertCurrent()).rejects.toThrow();
    denied = side === 'original' ? join(f.owner, relative(f.root, backup.path)) : backup.path;
    await expect(backup.assertCurrent()).rejects.toThrow();
    denied = ''; await backup.assertCurrent();
  });

for (const side of ['original', 'copy'] as const)
  for (const alias of ['symlink', 'hardlink'] as const)
    test(`${side} source ${alias} is rejected before permission callbacks can read it`, async () => {
      const f = await fixture(); let calls = 0;
      const target = join(side === 'original' ? f.owner : f.root, 'nested/source.bin');
      const privateFile = join(f.owner, 'private'); writeFileSync(privateFile, 'private bytes'); rmSync(target);
      if (alias === 'symlink') symlinkSync(privateFile, target); else linkSync(privateFile, target);
      await expect(prepareCapturedWriteBackup({ ...f.binding, readAccessFilter: async () => { calls++; return true; } }, f.source)).rejects.toThrow();
      expect(calls).toBe(0);
      expect(existsSync(join(f.root, '.goodvibes'))).toBe(false);
    });

for (const side of ['original', 'copy'] as const)
  test(`${side} runtime parent symlinks cannot redirect captured backups`, async () => {
    const f = await fixture();
    const outside = mkdtempSync(join(tmpdir(), 'captured-backup-outside-')); roots.push(outside);
    const parent = join(side === 'original' ? f.owner : f.root, '.goodvibes', '.backups');
    mkdirSync(dirname(parent), { recursive: true }); symlinkSync(outside, parent);
    await expect(prepareCapturedWriteBackup(f.binding, f.source)).rejects.toThrow();
  });

for (const mutation of ['replace', 'change', 'hardlink'] as const)
  test(`a ${mutation} of the generated backup is rejected before destination permissions`, async () => {
    const f = await fixture(); let destinationChecks = 0;
    const binding = { ...f.binding, readAccessFilter: async (path: string) => {
      if (path.startsWith(`${join(f.root, '.goodvibes', '.backups')}${sep}`)) destinationChecks++;
      return true;
    } };
    const backup = await prepareCapturedWriteBackup(binding, f.source); backup.create();
    const checked = destinationChecks;
    if (mutation === 'replace') {
      writeFileSync(join(f.root, 'replacement'), 'unrelated'); renameSync(join(f.root, 'replacement'), backup.path);
    } else if (mutation === 'change') writeFileSync(backup.path, 'modified bytes');
    else linkSync(backup.path, join(f.root, 'alias'));
    await expect(backup.assertCurrent()).rejects.toThrow();
    expect(destinationChecks).toBe(checked);
  });

test('changed sources and newly introduced backup-parent aliases cannot publish stale plans', async () => {
  const f = await fixture(); const first = await prepareCapturedWriteBackup(f.binding, f.source);
  writeFileSync(f.source, 'new source');
  expect(() => first.create()).toThrow('source changed');
  const second = await prepareCapturedWriteBackup(f.binding, f.source);
  mkdirSync(join(f.root, '.goodvibes')); symlinkSync(join(f.owner, '.goodvibes'), join(f.root, '.goodvibes', '.backups'));
  expect(() => second.create()).toThrow('alias');
});

test('forged, immutable, mismatched and unfiltered authorities cannot prepare backups', async () => {
  const f = await fixture(); const immutable = await fixture(false);
  await expect(prepareCapturedWriteBackup({ ...f.binding, authority: { kind: 'contract-input-authority' } }, f.source)).rejects.toThrow();
  await expect(prepareCapturedWriteBackup(immutable.binding, immutable.source)).rejects.toThrow();
  await expect(prepareCapturedWriteBackup({ ...f.binding, root: immutable.root }, immutable.source)).rejects.toThrow();
  await expect(prepareCapturedWriteBackup({ ...f.binding, readAccessFilter: undefined }, f.source)).rejects.toThrow();
  await expect(prepareCapturedWriteBackup(f.binding, join(f.root, '.goodvibes', 'private'))).rejects.toThrow();
});

for (const interruption of ['revoke', 'binding abort', 'call abort'] as const)
  test(`${interruption} is rechecked synchronously before creating any backup`, async () => {
    const f = await fixture(); const call = new AbortController();
    const backup = await prepareCapturedWriteBackup(f.binding, f.source, call.signal);
    if (interruption === 'revoke') revokeContractInputAuthority(f.authority);
    else if (interruption === 'binding abort') f.controller.abort();
    else call.abort();
    expect(() => backup.create()).toThrow();
    await expect(backup.assertCurrent()).rejects.toThrow();
    expect(existsSync(join(f.root, '.goodvibes'))).toBe(false);
  });

test('a stalled destination permission callback is cancellable and never creates a backup', async () => {
  const f = await fixture(); let reached!: () => void;
  const entered = new Promise<void>((resolve) => { reached = resolve; });
  const call = new AbortController();
  const pending = prepareCapturedWriteBackup({ ...f.binding, readAccessFilter: async (path: string) => {
    if (path.includes(`${sep}.backups${sep}`)) { reached(); return new Promise<boolean>(() => {}); }
    return true;
  } }, f.source, call.signal);
  await entered; call.abort();
  await expect(pending).rejects.toThrow();
  expect(existsSync(join(f.root, '.goodvibes'))).toBe(false);
});

import { withCapturedPublication, type CapturedPublicationLease } from '../sdk/src/platform/tools/shared/captured-publication.js';
import { captureCapturedWriteRevision } from '../sdk/src/platform/tools/shared/captured-write-revision.js';
test('backup accepts only the exact intermediate revision issued by its still-active batch', async () => {
  const f = await fixture(); let previousLease!: CapturedPublicationLease;
  await withCapturedPublication(f.authority, async (lease) => { previousLease = lease; });
  await withCapturedPublication(f.authority, async (lease) => {
    const backup = await prepareCapturedWriteBackup(f.binding, f.source, undefined, lease);
    writeFileSync(f.source, 'owned replacement');
    expect(() => backup.create()).toThrow('changed');
    const revision = captureCapturedWriteRevision(f.authority, lease, f.source, Buffer.from('owned replacement'));
    expect(() => backup.create({ ...revision })).toThrow('matching');
    expect(() => captureCapturedWriteRevision(f.authority, previousLease, f.source, Buffer.from('owned replacement'))).toThrow('owner');
    writeFileSync(join(f.root, 'other'), 'other owned');
    const other = captureCapturedWriteRevision(f.authority, lease, join(f.root, 'other'), Buffer.from('other owned'));
    expect(() => backup.create(other)).toThrow('matching');
    backup.create(revision);
    expect(readFileSync(backup.path, 'utf8')).toBe('owned replacement');
    await backup.assertCurrent();
  });
});

test('an owned revision cannot authorize later external changes or survive its publication owner', async () => {
  const f = await fixture(); let retained!: ReturnType<typeof captureCapturedWriteRevision>;
  let plan!: Awaited<ReturnType<typeof prepareCapturedWriteBackup>>;
  await withCapturedPublication(f.authority, async (lease) => {
    plan = await prepareCapturedWriteBackup(f.binding, f.source, undefined, lease);
    writeFileSync(f.source, 'owned'); retained = captureCapturedWriteRevision(f.authority, lease, f.source, Buffer.from('owned'));
    writeFileSync(f.source, 'external replacement');
    expect(() => plan.create(retained)).toThrow('changed');
    expect(existsSync(plan.path)).toBe(false);
  });
  expect(() => plan.create(retained)).toThrow('owner'); expect(existsSync(plan.path)).toBe(false);
});

test('missing backup source requires a lease-bound revision from its own batch creation', async () => {
  const f = await fixture(); const source = join(f.root, 'new.txt');
  await expect(prepareCapturedWriteBackup(f.binding, source)).rejects.toThrow('regular source');
  await withCapturedPublication(f.authority, async (lease) => {
    const plan = await prepareCapturedWriteBackup(f.binding, source, undefined, lease);
    expect(() => plan.create()).toThrow('not been created');
    writeFileSync(source, 'created by batch');
    expect(() => plan.create()).toThrow('changed');
    const revision = captureCapturedWriteRevision(f.authority, lease, source, Buffer.from('created by batch'));
    plan.create(revision); expect(readFileSync(plan.path, 'utf8')).toBe('created by batch');
  });
});


test('an uncreated backup plan cannot write after its batch lease settles', async () => {
  const f = await fixture(); let plan!: Awaited<ReturnType<typeof prepareCapturedWriteBackup>>;
  await withCapturedPublication(f.authority, async (lease) => { plan = await prepareCapturedWriteBackup(f.binding, f.source, undefined, lease); });
  expect(() => plan.create()).toThrow('owner'); expect(existsSync(plan.path)).toBe(false);
});

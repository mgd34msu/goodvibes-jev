import { afterEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureContractInput, contractInputPath, materializeContractInput } from '../sdk/src/platform/contract/input-snapshot.js';
import { createContractInputAuthority, revokeContractInputAuthority, type ContractInputAuthority } from '../sdk/src/platform/contract/input-authority.js';
import type { Contract } from '../sdk/src/platform/contract/types.js';
import { createCapturedExecBunRuntimeAdmission } from '../sdk/src/platform/tools/exec/captured-bun-runtime-input.js';
import { probeCapturedExecAvailability, runCapturedCommand, type CapturedExecAuthority } from '../sdk/src/platform/tools/exec/captured-exec.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const availability = await probeCapturedExecAvailability();
if (process.env.GOODVIBES_TEST_REQUIRE_EXEC_CONTAINMENT === '1' && !availability.available)
  throw new Error('required Bun runtime admission containment backend is unavailable');
function git(root: string, ...args: string[]): void {
  const result = spawnSync('git', ['-C', root, ...args]);
  if (result.status !== 0) throw new Error(result.stderr.toString());
}
async function fixture(filter: (path: string) => boolean | Promise<boolean> = () => true) {
  const dir = mkdtempSync(join(tmpdir(), 'captured-bun-input-')); roots.push(dir);
  const owner = join(dir, 'owner'); mkdirSync(owner);
  git(owner, 'init', '-q'); git(owner, 'config', 'user.name', 'Fixture'); git(owner, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(owner, 'input.txt'), 'CAPTURED_INPUT'); git(owner, 'add', '.'); git(owner, 'commit', '-qm', 'fixture');
  const inputSnapshot = await captureContractInput(owner); const root = contractInputPath(inputSnapshot);
  git(owner, 'worktree', 'add', '--no-checkout', '-b', `input/${inputSnapshot.id}`, root, inputSnapshot.inputCommit);
  await materializeContractInput(inputSnapshot, root);
  const authority = await createContractInputAuthority({ projectRoot: owner, inputSnapshot } as Contract, root, { mutable: true, branch: `input/${inputSnapshot.id}` });
  return { dir, owner, binding: { authority, root, readAccessFilter: async (path: string) => filter(path) } satisfies CapturedExecAuthority };
}

for (const denied of ['source', 'canonical', 'alias'] as const) {
  test(`Bun admission requires original-owner permission for ${denied}`, async () => {
    let restricted = '';
    const f = await fixture(path => path !== restricted);
    const source = join(f.dir, 'declared-bun'); symlinkSync(process.execPath, source);
    restricted = denied === 'source' ? source : denied === 'canonical' ? process.execPath : '/captured-runtime/bin/bun';
    const admission = createCapturedExecBunRuntimeAdmission(f.binding, { bunExecutable: source });
    await expect(admission()).rejects.toThrow('access-restricted');
  });
}

test('missing and relative declarations never select a PATH fallback', async () => {
  const f = await fixture();
  await expect(createCapturedExecBunRuntimeAdmission(f.binding, { bunExecutable: 'bun' })()).rejects.toThrow('absolute');
  await expect(createCapturedExecBunRuntimeAdmission(f.binding, { bunExecutable: join(f.dir, 'missing-bun') })()).rejects.toThrow();
});

test('runtime identity is pinned before any asynchronous admission', async () => {
  const f = await fixture(); const source = join(f.dir, 'runtime');
  copyFileSync('/bin/true', source); chmodSync(source, 0o755);
  const admission = createCapturedExecBunRuntimeAdmission(f.binding, { bunExecutable: source });
  chmodSync(source, 0o700);
  await expect(admission()).rejects.toThrow('changed since trusted construction');
});

test.skipIf(!availability.available)('a non-interpreter cannot be admitted by an exit-zero executable', async () => {
  const f = await fixture();
  await expect(createCapturedExecBunRuntimeAdmission(f.binding, { bunExecutable: '/bin/true' })()).rejects.toThrow('not an available ordinary interpreter');
});

test.skipIf(!availability.available)('genuine runtime tokens cannot be forged, copied or moved to another authority', async () => {
  const f = await fixture(); const other = await fixture();
  const input = await createCapturedExecBunRuntimeAdmission(f.binding)();
  for (const [binding, bunRuntimeInput] of [[f.binding, { ...input }], [other.binding, input]] as const) {
    const result = await runCapturedCommand({ ...binding, bunRuntimeInput }, 'echo MUST_NOT_RUN', {}, binding.root, 5000);
    expect(result.success).toBe(false); expect(result.stdout).toBe('');
  }
});

test.skipIf(!availability.available)('runtime read revocation is rechecked after successful admission', async () => {
  let allowed = true;
  const f = await fixture(path => path !== '/captured-runtime/bin/bun' || allowed);
  const bunRuntimeInput = await createCapturedExecBunRuntimeAdmission(f.binding)();
  allowed = false;
  const result = await runCapturedCommand({ ...f.binding, bunRuntimeInput }, 'echo MUST_NOT_RUN', {}, f.binding.root, 5000);
  expect(result.success).toBe(false); expect(result.stdout).toBe('');
});

test.skipIf(!availability.available)('later mutation of an admitted binary holds the next execution', async () => {
  const f = await fixture(); const source = join(f.dir, 'bun');
  copyFileSync(process.execPath, source); chmodSync(source, 0o755);
  const bunRuntimeInput = await createCapturedExecBunRuntimeAdmission(f.binding, { bunExecutable: source })();
  chmodSync(source, 0o700);
  const result = await runCapturedCommand({ ...f.binding, bunRuntimeInput }, 'echo MUST_NOT_RUN', {}, f.binding.root, 5000);
  expect(result.success).toBe(false); expect(result.stdout).toBe('');
});

test.skipIf(!availability.available)('completed invocation cancellation does not poison the owner runtime admission', async () => {
  const f = await fixture(); const first = new AbortController();
  const bunRuntimeInput = await createCapturedExecBunRuntimeAdmission(f.binding)(first.signal);
  first.abort();
  const result = await runCapturedCommand({ ...f.binding, bunRuntimeInput }, "bun --no-env-file --print '6*7'", {}, f.binding.root, 5000);
  expect(result.success).toBe(true); expect(result.stdout).toBe('42\n');
});


test('revocation inside a runtime permission await prevents opening executable bytes', async () => {
  let authority: ContractInputAuthority | undefined;
  const f = await fixture(path => { if (path === process.execPath && authority) revokeContractInputAuthority(authority); return true; });
  authority = f.binding.authority;
  const admission = createCapturedExecBunRuntimeAdmission(f.binding);
  const opened: string[] = []; const read = fs.readFile;
  const tap = spyOn(fs, 'readFile').mockImplementation(((path, ...args) => { opened.push(String(path)); return read(path, ...args); }) as typeof fs.readFile);
  try {
    await expect(admission()).rejects.toThrow();
    expect(opened).not.toContain(process.execPath);
  } finally { tap.mockRestore(); }
});

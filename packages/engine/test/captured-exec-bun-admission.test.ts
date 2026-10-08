/** Lightweight admission/projection seam tests. All bubblewrap processes are
 * synthetic here; compiled/real-process acceptance lives in its own fixture. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import * as syncFs from 'node:fs';
import * as fs from 'node:fs/promises';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureContractInput, contractInputPath, materializeContractInput } from '../sdk/src/platform/contract/input-snapshot.js';
import { createContractInputAuthority, revokeContractInputAuthority } from '../sdk/src/platform/contract/input-authority.js';
import type { Contract } from '../sdk/src/platform/contract/types.js';
import { createCapturedExecBunRuntimeAdmission } from '../sdk/src/platform/tools/exec/captured-bun-runtime-input.js';
import { runCapturedCommand, type CapturedExecAuthority } from '../sdk/src/platform/tools/exec/captured-exec.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture(filter: (path: string) => boolean | Promise<boolean> = () => true) {
  const dir = mkdtempSync(join(tmpdir(), 'captured-direct-bun-unit-')); roots.push(dir);
  const owner = join(dir, 'owner'); mkdirSync(owner);
  for (const args of [['init', '-q'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) {
    const result = childProcess.spawnSync('git', ['-C', owner, ...args]);
    if (result.status !== 0) throw new Error(result.stderr.toString());
  }
  writeFileSync(join(owner, 'input.txt'), 'CAPTURED_INPUT');
  for (const args of [['add', '.'], ['commit', '-qm', 'fixture']]) childProcess.spawnSync('git', ['-C', owner, ...args]);
  const inputSnapshot = await captureContractInput(owner); const root = contractInputPath(inputSnapshot);
  const worktree = childProcess.spawnSync('git', ['-C', owner, 'worktree', 'add', '--no-checkout', '-b', `input/${inputSnapshot.id}`, root, inputSnapshot.inputCommit]);
  if (worktree.status !== 0) throw new Error(worktree.stderr.toString());
  await materializeContractInput(inputSnapshot, root);
  const authority = await createContractInputAuthority({ projectRoot: owner, inputSnapshot } as Contract, root, { mutable: true, branch: `input/${inputSnapshot.id}` });
  const source = join(dir, 'declared-bun'); copyFileSync('/bin/true', source); chmodSync(source, 0o755);
  return { dir, source, binding: { authority, root, readAccessFilter: async (path: string) => filter(path) } satisfies CapturedExecAuthority };
}

function boundary(onCommand?: () => void) {
  const launches: { argv: string[]; runtime: string | undefined }[] = [];
  const original = childProcess.spawnSync;
  const sync = spyOn(childProcess, 'spawnSync').mockImplementation(((...args: Parameters<typeof original>) => args[0] === '/usr/bin/bwrap'
    ? { status: 0, stdout: '', stderr: '' } : original(...args)) as typeof childProcess.spawnSync);
  const spawn = spyOn(childProcess, 'spawn').mockImplementation(((...args: Parameters<typeof childProcess.spawn>) => {
    const [command, argv] = args;
    if (command !== '/usr/bin/bwrap' || !Array.isArray(argv)) throw new Error('unexpected process in unit fixture');
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: 987654, exitCode: null, kill: () => true });
    const runtimeIndex = argv.indexOf('/captured-runtime/bin/bun');
    const runtime = runtimeIndex >= 2 && argv[runtimeIndex - 2] === '--ro-bind' ? argv[runtimeIndex - 1] : undefined;
    launches.push({ argv: [...argv], runtime: runtime && existsSync(runtime) ? readFileSync(runtime).subarray(0, 200).toString() : undefined });
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(argv.includes('--print') ? 'GOODVIBES_CAPTURED_ORDINARY_BUN\n' : 'SYNTHETIC_COMMAND_OUTPUT\n'));
      if (!argv.includes('--print')) onCommand?.();
      child.emit('close', 0);
    });
    return child;
  }) as unknown as typeof childProcess.spawn);
  return { launches, restore: () => { spawn.mockRestore(); sync.mockRestore(); } };
}
const run = (binding: CapturedExecAuthority, signal?: AbortSignal) => runCapturedCommand(binding, 'bun test', {}, binding.root, 5000, signal);

test('direct Bun exec consumes its pinned admission without a prior REPL or validator', async () => {
  const f = await fixture(); const mock = boundary();
  const admit = createCapturedExecBunRuntimeAdmission(f.binding, { bunExecutable: f.source });
  let calls = 0;
  try {
    const result = await run({ ...f.binding, bunRuntimeAdmission: async signal => { calls++; return admit(signal); } });
    expect(result.success).toBe(true);
    expect(calls).toBe(1);
    expect(mock.launches).toHaveLength(2);
    const command = mock.launches.at(-1)!;
    expect(command.argv).not.toContain(process.execPath);
    expect(command.runtime).toBe(readFileSync(f.source).subarray(0, 200).toString());
  } finally { mock.restore(); }
});

for (const admitted of [false, true]) test(`OS Bun aliases cannot substitute an ambient interpreter with ${admitted ? 'admitted' : 'unavailable'} Bun`, async () => {
  const f = await fixture(); const mock = boundary();
  const bunRuntimeAdmission = admitted
    ? createCapturedExecBunRuntimeAdmission(f.binding, { bunExecutable: f.source })
    : async () => { throw new Error('unavailable'); };
  const exists = syncFs.existsSync; const canonical = syncFs.realpathSync;
  const aliases = new Set(['/usr/bin/bun', '/usr/bin/bunx']);
  const existsTap = spyOn(syncFs, 'existsSync').mockImplementation(path => aliases.has(String(path)) || exists(path));
  const canonicalTap = spyOn(syncFs, 'realpathSync').mockImplementation(((path: syncFs.PathLike, options?: unknown) =>
    aliases.has(String(path)) ? '/usr/bin/true' : canonical(path, options as Parameters<typeof canonical>[1])) as typeof canonical);
  try {
    await run({ ...f.binding, bunRuntimeAdmission });
    const argv = mock.launches.at(-1)!.argv; const index = argv.indexOf('/usr/bin/true');
    expect(index).toBeGreaterThan(1);
    expect(argv[index - 2]).toBe('--ro-bind');
    expect(argv[index - 1]).toEndWith('/bun-runtime-unavailable');
    expect(argv.filter(part => part === '/usr/bin/true')).toHaveLength(1);
  } finally { canonicalTap.mockRestore(); existsTap.mockRestore(); mock.restore(); }
});

for (const interruption of ['cancel', 'revoke', 'runtime-denial'] as const) test(`${interruption} after project output withholds delivery`, async () => {
  let allowed = true;
  const f = await fixture(path => path !== '/captured-runtime/bin/bun' || allowed); const controller = new AbortController();
  const mock = boundary(() => {
    if (interruption === 'cancel') controller.abort();
    else if (interruption === 'revoke') revokeContractInputAuthority(f.binding.authority);
    else allowed = false;
  });
  const bunRuntimeAdmission = createCapturedExecBunRuntimeAdmission(f.binding, { bunExecutable: f.source });
  try {
    const result = await run({ ...f.binding, bunRuntimeAdmission }, controller.signal);
    expect(mock.launches).toHaveLength(2);
    expect(result.success).toBe(false); expect(result.stdout).toBe('');
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_COMMAND_OUTPUT');
  } finally { mock.restore(); }
});

for (const denied of ['source', 'canonical', 'alias'] as const) test(`direct Bun ${denied} denial does not read executable bytes or mount the host interpreter`, async () => {
  let restricted = '';
  const f = await fixture(path => path !== restricted);
  const source = join(f.dir, 'runtime-alias'); symlinkSync(f.source, source);
  restricted = denied === 'source' ? source : denied === 'canonical' ? f.source : '/captured-runtime/bin/bun';
  const admit = createCapturedExecBunRuntimeAdmission(f.binding, { bunExecutable: source });
  const mock = boundary(); const opened: string[] = []; const read = fs.readFile;
  const tap = spyOn(fs, 'readFile').mockImplementation(((path, ...args) => { opened.push(String(path)); return read(path, ...args); }) as typeof read);
  try {
    await run({ ...f.binding, bunRuntimeAdmission: admit });
    expect(opened).not.toContain(source); expect(opened).not.toContain(f.source);
    expect(mock.launches).toHaveLength(1);
    expect(mock.launches[0]!.argv).not.toContain(process.execPath);
    expect(mock.launches[0]!.runtime).toContain('Captured Bun runtime is unavailable or access-restricted.');
  } finally { tap.mockRestore(); mock.restore(); }
});

for (const admission of ['missing-declaration', 'failed', 'missing-token'] as const) test(`${admission} Bun admission leaves a refusal mount`, async () => {
  const f = await fixture(); const mock = boundary();
  const admit = admission === 'missing-declaration'
    ? createCapturedExecBunRuntimeAdmission(f.binding, { bunExecutable: join(f.dir, 'missing') })
    : admission === 'failed' ? async () => { throw new Error('unavailable'); }
      : async () => undefined as unknown as Awaited<ReturnType<ReturnType<typeof createCapturedExecBunRuntimeAdmission>>>;
  try {
    const result = await run({ ...f.binding, bunRuntimeAdmission: admit });
    expect(result.success).toBe(true);
    expect(mock.launches).toHaveLength(1);
    expect(mock.launches[0]!.argv).not.toContain(process.execPath);
    expect(mock.launches[0]!.runtime).toContain('Captured Bun runtime is unavailable or access-restricted.');
  } finally { mock.restore(); }
});

test('literal shell primitives do not wait for an unused Bun runtime admission', async () => {
  const f = await fixture(); const mock = boundary(); let admissions = 0;
  try {
    const result = await runCapturedCommand({ ...f.binding, bunRuntimeAdmission: () => { admissions++; return new Promise(() => {}); } },
      'echo SHELL_CONTROL && printf "%s" bun && true', {}, f.binding.root, 5000);
    expect(result.success).toBe(true); expect(admissions).toBe(0);
    expect(mock.launches).toHaveLength(1);
    expect(mock.launches[0]!.argv).not.toContain(process.execPath);
    expect(mock.launches[0]!.runtime).toContain('Captured Bun runtime is unavailable or access-restricted.');
  } finally { mock.restore(); }
});

for (const command of ['node script.js', 'npm test', 'sh -c "bun test"', 'echo "$(bun --version)"'])
  test(`potentially indirect Bun execution still selects runtime admission: ${command}`, async () => {
    const f = await fixture(); const mock = boundary(); let admissions = 0;
    const admit = createCapturedExecBunRuntimeAdmission(f.binding, { bunExecutable: f.source });
    try {
      const result = await runCapturedCommand({ ...f.binding, bunRuntimeAdmission: signal => { admissions++; return admit(signal); } },
        command, {}, f.binding.root, 5000);
      expect(result.success).toBe(true); expect(admissions).toBe(1);
      expect(mock.launches).toHaveLength(2);
      expect(mock.launches.at(-1)!.argv).not.toContain(process.execPath);
    } finally { mock.restore(); }
  });

test('compiled host without a Bun capability never mounts its product executable', async () => {
  const f = await fixture(); const mock = boundary(); const main = Bun.main;
  try {
    Reflect.set(Bun, 'main', '/$bunfs/root/compiled-product');
    await run(f.binding);
    expect(mock.launches).toHaveLength(1);
    expect(mock.launches[0]!.argv).not.toContain(process.execPath);
    expect(mock.launches[0]!.runtime).toContain('Captured Bun runtime is unavailable or access-restricted.');
  } finally { Reflect.set(Bun, 'main', main); mock.restore(); }
});

test('forged and wrong-owner Bun capabilities are never retried or replaced', async () => {
  const f = await fixture(); const other = await fixture(); const mock = boundary();
  try {
    const token = await createCapturedExecBunRuntimeAdmission(other.binding, { bunExecutable: other.source })();
    const before = mock.launches.length; let calls = 0;
    for (const bunRuntimeInput of [{ kind: 'captured-exec-bun-runtime' as const }, token]) {
      const result = await run({ ...f.binding, bunRuntimeInput, bunRuntimeAdmission: async () => { calls++; return token; } });
      expect(result.denied).toBe(true); expect(result.stdout).toBe('');
    }
    expect(calls).toBe(0); expect(mock.launches).toHaveLength(before);
  } finally { mock.restore(); }
});

test('a replaced runtime cannot be silently readmitted or fall back to the source-host interpreter', async () => {
  const f = await fixture(); const mock = boundary();
  const bunRuntimeAdmission = createCapturedExecBunRuntimeAdmission(f.binding, { bunExecutable: f.source });
  try {
    expect((await run({ ...f.binding, bunRuntimeAdmission })).success).toBe(true);
    const before = mock.launches.length; chmodSync(f.source, 0o700);
    const result = await run({ ...f.binding, bunRuntimeAdmission });
    expect(result.denied).toBe(true); expect(result.stdout).toBe('');
    expect(mock.launches).toHaveLength(before);
  } finally { mock.restore(); }
});

for (const interruption of ['cancel', 'revoke'] as const) test(`${interruption} during Bun admission await starts no project command or late projection`, async () => {
  const f = await fixture(); const mock = boundary(); const controller = new AbortController();
  let release!: () => void; let reached!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); const waiting = new Promise<void>(resolve => { reached = resolve; });
  const admit = createCapturedExecBunRuntimeAdmission(f.binding, { bunExecutable: f.source });
  const binding = { ...f.binding, bunRuntimeAdmission: async (signal?: AbortSignal) => { reached(); await gate; return admit(signal); } };
  const pending = run(binding, controller.signal);
  try {
    await waiting;
    if (interruption === 'cancel') controller.abort(); else revokeContractInputAuthority(f.binding.authority);
    release(); const result = await pending;
    expect(result.denied).toBe(true); expect(result.stdout).toBe('');
    expect(mock.launches).toHaveLength(0);
    expect(existsSync(join(f.binding.root, 'late.txt'))).toBe(false);
  } finally { controller.abort(); release(); await pending; mock.restore(); }
});

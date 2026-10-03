import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureContractInput, materializeContractInput, contractInputPath } from '../sdk/src/platform/contract/input-snapshot.js';
import { createContractInputAuthority, revokeContractInputAuthority } from '../sdk/src/platform/contract/input-authority.js';
import type { Contract } from '../sdk/src/platform/contract/types.js';
import { runCapturedCommand, probeCapturedExecAvailability, type CapturedExecAuthority } from '../sdk/src/platform/tools/exec/captured-exec.js';
import { formatResult } from '../sdk/src/platform/tools/exec/result-format.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const availability = await probeCapturedExecAvailability();
const supported = availability.available;

test('required captured containment proof cannot silently skip an unavailable host', () => {
  const required = process.env.GOODVIBES_TEST_REQUIRE_EXEC_CONTAINMENT;
  if (required !== undefined) {
    expect(required).toBe('1');
    expect(availability).toEqual({ available: true, backend: 'linux-bwrap-projection' });
  } else if (!availability.available) {
    expect(availability.reason).toBeString();
    expect(availability.message).toBeString();
  }
});
function git(root: string, ...args: string[]): void {
  const result = spawnSync('git', ['-C', root, ...args]);
  if (result.status !== 0) throw new Error(result.stderr.toString());
}
async function fixture(filter: (path: string) => boolean | Promise<boolean> = () => true): Promise<CapturedExecAuthority & { owner: string }> {
  const owner = mkdtempSync(join(tmpdir(), 'captured-exec-test-')); roots.push(owner);
  git(owner, 'init', '-q'); git(owner, 'config', 'user.name', 'Fixture'); git(owner, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(owner, 'input.txt'), 'captured-fixture\n');
  writeFileSync(join(owner, 'private.txt'), 'SYNTHETIC_DENIED_MARKER');
  git(owner, 'add', '.'); git(owner, 'commit', '-qm', 'fixture');
  const inputSnapshot = await captureContractInput(owner);
  const root = contractInputPath(inputSnapshot);
  git(owner, 'worktree', 'add', '--no-checkout', '-b', `input/${inputSnapshot.id}`, root, inputSnapshot.inputCommit);
  await materializeContractInput(inputSnapshot, root);
  const authority = await createContractInputAuthority({ projectRoot: owner, inputSnapshot } as Contract, root, { mutable: true, branch: `input/${inputSnapshot.id}` });
  return { authority, root, owner, readAccessFilter: async (path) => filter(path) };
}
const run = (binding: CapturedExecAuthority, command: string, signal?: AbortSignal) => runCapturedCommand(binding, command, {}, binding.root, 5000, signal);

test.skipIf(!supported)('real captured shell and Bun build/test use admitted files and return member output', async () => {
  const binding = await fixture();
  writeFileSync(join(binding.root, 'answer.ts'), 'export const answer = 42;\n');
  writeFileSync(join(binding.root, 'answer.test.ts'), 'import { expect, test } from "bun:test"; import { answer } from "./answer"; test("answer", () => expect(answer).toBe(42));');
  const result = await run(binding, 'bun build ./answer.ts --outdir ./dist && bun test ./answer.test.ts && cat input.txt');
  expect(result.stderr).not.toContain('Captured exec held');
  expect(result.success).toBe(true);
  expect(result.sandboxed).toBe(true);
  expect(result.stdout).toContain('captured-fixture');
  expect(readFileSync(join(binding.root, 'dist/answer.js'), 'utf8')).toContain('42');
  expect(existsSync(join(binding.owner, 'dist/answer.js'))).toBe(false);
});
for (const deniedSide of ['original', 'copy'] as const)
  test.skipIf(!supported)(`denied ${deniedSide} paths, runtime exclusions and host files are absent from real subprocess`, async () => {
    let owner = ''; let root = '';
    const binding = await fixture((path) => path !== join(deniedSide === 'original' ? owner : root, 'private.txt'));
    owner = binding.owner; root = binding.root;
    mkdirSync(join(root, '.aws')); writeFileSync(join(root, '.aws/credentials'), 'SYNTHETIC_EXCLUDED_MARKER');
    const result = await run(binding, `test ! -e private.txt && test ! -e .git && test ! -e .aws/credentials && test ! -e '${owner}/input.txt' && test ! -e /etc/passwd && cat input.txt`);
    expect(result.success).toBe(true);
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_DENIED_MARKER');
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_EXCLUDED_MARKER');
    expect(readFileSync(join(root, 'private.txt'), 'utf8')).toBe('SYNTHETIC_DENIED_MARKER');
  });
test.skipIf(!supported)('socket calls fail while normal filesystem build calls work', async () => {
  const binding = await fixture();
  const result = await run(binding, `bun -e 'try { Bun.listen({hostname:"127.0.0.1",port:0,socket:{data(){}}}); process.exit(1) } catch { console.log("NETWORK_BLOCKED") }'`);
  expect(result.success).toBe(true); expect(result.stdout).toContain('NETWORK_BLOCKED');
});
test.skipIf(!supported)('outside-view cwd, symlink output and excluded output never apply back', async () => {
  const binding = await fixture();
  expect((await runCapturedCommand(binding, 'echo OUTSIDE', { cwd: binding.owner }, binding.root, 5000)).denied).toBe(true);
  expect((await run(binding, 'ln -s /etc/passwd escape')).denied).toBe(true);
  expect(existsSync(join(binding.root, 'escape'))).toBe(false);
  expect((await run(binding, 'mkdir .aws; echo synthetic > .aws/new')).denied).toBe(true);
  expect(existsSync(join(binding.root, '.aws'))).toBe(false);
});
for (const interruption of ['abort', 'revoke', 'permission'] as const)
  test.skipIf(!supported)(`${interruption} during real subprocess withholds output and prevents delayed changes`, async () => {
    let allowed = true;
    const binding = await fixture(() => allowed);
    const controller = new AbortController();
    const pending = run(binding, 'echo BEFORE; sleep 1; echo LATE > late.txt; echo AFTER', controller.signal);
    setTimeout(() => {
      if (interruption === 'abort') controller.abort();
      else if (interruption === 'revoke') revokeContractInputAuthority(binding.authority);
      else allowed = false;
    }, 200);
    const result = await pending;
    expect(result.success).toBe(false); expect(result.stdout).toBe('');
    expect(JSON.stringify(result)).not.toContain('BEFORE\\n');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(existsSync(join(binding.root, 'late.txt'))).toBe(false);
  });
test.skipIf(!supported)('forged authority and detached commands cannot select a host fallback', async () => {
  const binding = await fixture();
  expect((await run({ ...binding, authority: { kind: 'contract-input-authority' } }, 'echo FORGED')).denied).toBe(true);
  expect((await run({ ...binding, readAccessFilter: undefined }, 'echo NO_FILTER')).denied).toBe(true);
  expect((await runCapturedCommand(binding, 'echo DETACHED', { background: true }, binding.root, 5000)).denied).toBe(true);
});
test('captured backend identity is construction-owned, not a copied name or model property', async () => {
  const { createExecTool, isCapturedExecTool } = await import('../sdk/src/platform/tools/exec/runtime.js');
  const { ProcessManager } = await import('../sdk/src/platform/tools/shared/process-manager.js');
  const { OverflowHandler } = await import('../sdk/src/platform/tools/shared/overflow.js');
  const binding = await fixture();
  const tool = createExecTool(new ProcessManager(), {
    overflowHandler: new OverflowHandler({ baseDir: binding.root }), defaultWorkingDirectory: binding.root, capturedInput: binding,
  });
  expect(isCapturedExecTool(tool, binding.authority)).toBe(true);
  expect(isCapturedExecTool({ ...tool }, binding.authority)).toBe(false);
  expect(isCapturedExecTool(tool, { kind: 'contract-input-authority' })).toBe(false);
  const ordinary = createExecTool(new ProcessManager(), { overflowHandler: new OverflowHandler({ baseDir: binding.root }) });
  expect(isCapturedExecTool(ordinary, binding.authority)).toBe(false);
});

test('unsupported platform is typed and survives every result verbosity', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const binding = await fixture();
  try {
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'darwin' });
    const capability = await probeCapturedExecAvailability();
    expect(capability.available).toBe(false);
    if (!capability.available) expect(capability.reason).toBe('unsupported-platform');
    const result = await run(binding, 'echo MUST_NOT_RUN');
    expect(result.stdout).toBe('');
    expect(result.denied).toBe(true);
    expect(result.captured_exec_availability).toEqual(capability);
    for (const verbosity of ['count_only', 'minimal', 'standard', 'verbose'] as const) {
      expect(formatResult(result, verbosity).captured_exec_availability).toEqual(capability);
    }
  } finally { Object.defineProperty(process, 'platform', descriptor); }
});

test('unsupported ABI has a typed availability refusal without executing a command', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const arch = Object.getOwnPropertyDescriptor(process, 'arch')!;
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    Object.defineProperty(process, 'arch', { ...arch, value: 'unsupported-fixture' });
    const capability = await probeCapturedExecAvailability();
    expect(capability.available).toBe(false);
    if (!capability.available) expect(capability.reason).toBe('unsupported-architecture');
  } finally {
    Object.defineProperty(process, 'platform', platform);
    Object.defineProperty(process, 'arch', arch);
  }
});

import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { admitCapturedExecDependency } from '../sdk/src/platform/tools/exec/captured-exec-dependencies.js';
import { useToolReadings } from './_helpers/tool-readings.js';
useToolReadings([], [['CAPTURE_NETWORK_POLICY', { catastrophic: false, needsNetwork: true }]]);
import { captureContractInput, materializeContractInput, contractInputPath } from '../sdk/src/platform/contract/input-snapshot.js';
import { assertContractInputReadAccess, createContractInputAuthority, revokeContractInputAuthority } from '../sdk/src/platform/contract/input-authority.js';
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

for (const policy of ['disabled', 'enabled', 'denied'] as const)
  test.skipIf(!supported)(`captured exec preserves existing ${policy} sandbox network policy`, async () => {
    const { createExecTool } = await import('../sdk/src/platform/tools/exec/runtime.js');
    const { ProcessManager } = await import('../sdk/src/platform/tools/shared/process-manager.js');
    const { OverflowHandler } = await import('../sdk/src/platform/tools/shared/overflow.js');
    const binding = await fixture();
    let escalations = 0;
    const tool = createExecTool(new ProcessManager(), {
      capturedInput: binding, defaultWorkingDirectory: binding.root, overflowHandler: new OverflowHandler({ baseDir: binding.root }),
      sandbox: {
        featureEnabled: true,
        config: { enabled: true, egressAllowlist: policy === 'disabled' ? [] : ['*'], workspaceWritable: [] },
        availability: { available: true, backend: 'bubblewrap', bwrapPath: '/usr/bin/bwrap', networkIsolationGuaranteed: true, reason: 'fixture uses actual captured capability probe' },
        requestEscalation: async () => { escalations++; return policy !== 'denied'; },
      },
    });
    const command = `bun -e '/* CAPTURE_NETWORK_POLICY */ try { const s=Bun.listen({hostname:"127.0.0.1",port:0,socket:{data(){}}});s.stop();console.log("SOCKET_ALLOWED") } catch { console.log("SOCKET_BLOCKED") }'`;
    const result = await tool.execute({ commands: [{ cmd: command }] });
    const output = JSON.parse(result.output ?? '{}') as { stdout?: string; denied?: boolean; sandbox_network?: string };
    if (policy === 'denied') { expect(result.success).toBe(false); expect(output.denied).toBe(true); }
    else {
      expect(result.success).toBe(true);
      expect(output.stdout).toBe(policy === 'enabled' ? 'SOCKET_ALLOWED' : 'SOCKET_BLOCKED');
      expect(output.sandbox_network).toBe(policy);
    }
    expect(escalations).toBeGreaterThan(0);
  });

test.skipIf(!supported)('real ignored TypeScript dependency requires admitted immutable original and alias inputs', async () => {
  const binding = await fixture((path) => !path.endsWith('/DENIED_RUNTIME_SENTINEL'));
  const dependencies = join(binding.owner, 'node_modules');
  mkdirSync(dependencies);
  cpSync(dirname(require.resolve('typescript/package.json')), join(dependencies, 'typescript'), { recursive: true });
  writeFileSync(join(dependencies, 'DENIED_RUNTIME_SENTINEL'), 'SYNTHETIC_RUNTIME_PRIVATE');
  writeFileSync(join(binding.root, 'compile.ts'), 'export const value: number = 42;\n');
  expect((await run(binding, 'bun node_modules/typescript/bin/tsc compile.ts --outDir dist --skipLibCheck')).success).toBe(false);
  const admitted = await admitCapturedExecDependency(binding, { sourceRoot: dependencies, targetRelativePath: 'node_modules' });
  expect(admitted).toBeDefined();
  const authorized = { ...binding, dependencyInputs: [admitted!] };
  const result = await run(authorized, 'test ! -e node_modules/DENIED_RUNTIME_SENTINEL && if echo BAD > node_modules/typescript/package.json; then exit 1; fi; bun node_modules/typescript/bin/tsc compile.ts --outDir dist --skipLibCheck && cat dist/compile.js');
  expect(result.success).toBe(true);
  expect(result.stdout).toContain('42');
  expect(result.stdout).not.toContain('SYNTHETIC_RUNTIME_PRIVATE');
  expect(readFileSync(join(binding.root, 'dist/compile.js'), 'utf8')).toContain('42');
  expect(readFileSync(join(dependencies, 'typescript/package.json'), 'utf8')).not.toBe('BAD\n');
  expect(existsSync(join(binding.root, 'node_modules/typescript/package.json'))).toBe(false);
  // The admitted bytes cannot be silently replaced with a newer dependency.
  writeFileSync(join(dependencies, 'typescript/package.json'), 'changed after admission');
  const held = await run(authorized, 'echo SHOULD_BE_WITHHELD');
  expect(held.denied).toBe(true); expect(held.stdout).toBe('');
}, 60_000);

for (const deniedSide of ['original', 'alias'] as const)
  test.skipIf(!supported)(`dependency ${deniedSide} restriction cannot be bypassed by a declared runtime root`, async () => {
    let forbidden = '';
    const binding = await fixture((path) => path !== forbidden);
    const dependencies = join(binding.owner, 'node_modules');
    mkdirSync(join(dependencies, 'package'), { recursive: true });
    writeFileSync(join(dependencies, 'package/index.js'), 'console.log("DEPENDENCY_PRIVATE_MARKER")');
    forbidden = join(deniedSide === 'original' ? binding.owner : binding.root, 'node_modules/package/index.js');
    const admitted = await admitCapturedExecDependency(binding, { sourceRoot: dependencies, targetRelativePath: 'node_modules' });
    const result = await run({ ...binding, dependencyInputs: [admitted!] }, 'test ! -e node_modules/package/index.js');
    expect(result.success).toBe(true);
    expect(JSON.stringify(result)).not.toContain('DEPENDENCY_PRIVATE_MARKER');
  });

test.skipIf(!supported)('dependency admission rejects escaped aliases and forged tokens', async () => {
  const binding = await fixture();
  const dependencies = join(binding.owner, 'node_modules');
  mkdirSync(dependencies);
  const outside = mkdtempSync(join(tmpdir(), 'outside-dependency-test-')); roots.push(outside);
  writeFileSync(join(outside, 'synthetic.txt'), 'SYNTHETIC_OUTSIDE');
  symlinkSync(join(outside, 'synthetic.txt'), join(dependencies, 'escape'));
  await expect(admitCapturedExecDependency(binding, { sourceRoot: dependencies, targetRelativePath: 'node_modules' })).rejects.toThrow('escapes');
  const forged = { ...binding, dependencyInputs: [{ kind: 'captured-exec-dependency-input' as const }] };
  expect((await run(forged, 'echo FORGED_DEPENDENCY')).denied).toBe(true);
});

test.skipIf(!supported)('dependency permission revocation stops output and future provider delivery', async () => {
  let allowed = true;
  const binding = await fixture((path) => allowed || !path.includes('/node_modules/'));
  const dependencies = join(binding.owner, 'node_modules');
  mkdirSync(dependencies);
  writeFileSync(join(dependencies, 'public.js'), 'export const value=42;');
  const token = await admitCapturedExecDependency(binding, { sourceRoot: dependencies, targetRelativePath: 'node_modules' });
  const pending = run({ ...binding, dependencyInputs: [token!] }, 'cat node_modules/public.js; sleep 1; echo late > late.txt');
  setTimeout(() => { allowed = false; }, 200);
  const result = await pending;
  expect(result.success).toBe(false); expect(result.stdout).toBe('');
  expect(existsSync(join(binding.root, 'late.txt'))).toBe(false);
  await expect(assertContractInputReadAccess(binding.authority, binding.readAccessFilter)).rejects.toThrow('restricted');
});

async function workspaceFixture(filter: (path: string) => Promise<boolean> = async () => true) {
  const binding = await fixture(filter);
  const originalPackage = join(binding.owner, 'packages/math');
  const capturedPackage = join(binding.root, 'packages/math');
  for (const directory of [originalPackage, capturedPackage]) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'workspace-math', type: 'module', exports: './index.ts' }));
  }
  writeFileSync(join(originalPackage, 'index.ts'), 'throw new Error("LIVE_OWNER_TARGET_MUST_NOT_RUN"); export const answer=999;');
  writeFileSync(join(capturedPackage, 'index.ts'), 'export const answer=41;');
  const dependencyRoot = join(binding.owner, 'node_modules');
  mkdirSync(dependencyRoot);
  symlinkSync('../packages/math', join(dependencyRoot, 'workspace-math'));
  const token = await admitCapturedExecDependency(binding, { sourceRoot: dependencyRoot, targetRelativePath: 'node_modules' });
  return { binding: { ...binding, dependencyInputs: [token!] }, capturedPackage, originalPackage };
}

test.skipIf(!supported)('workspace-linked dependency builds and tests current captured bytes, never live owner bytes', async () => {
  const { binding, capturedPackage, originalPackage } = await workspaceFixture();
  // A member edit after dependency admission must remain visible through the
  // workspace package alias. Live owner changes must never supply its bytes.
  writeFileSync(join(capturedPackage, 'index.ts'), 'export const answer=42;');
  writeFileSync(join(originalPackage, 'index.ts'), 'throw new Error("LATER_LIVE_OWNER_TARGET_MUST_NOT_RUN"); export const answer=1000;');
  writeFileSync(join(binding.root, 'entry.ts'), 'import {answer} from "workspace-math"; console.log(`WORKSPACE_ANSWER=${answer}`);');
  writeFileSync(join(binding.root, 'entry.test.ts'), 'import {test,expect} from "bun:test";import {answer} from "workspace-math";test("workspace",()=>expect(answer).toBe(42));');
  const result = await run(binding, 'bun build entry.ts --outdir dist && bun dist/entry.js && bun test entry.test.ts');
  expect(result.success).toBe(true);
  expect(result.stdout).toContain('WORKSPACE_ANSWER=42');
  expect(result.stdout).not.toContain('LIVE_OWNER_TARGET');
  expect(readFileSync(join(binding.root, 'dist/entry.js'), 'utf8')).toContain('42');
});

for (const deniedSide of ['original-alias', 'captured-alias', 'original-target'] as const)
  test.skipIf(!supported)(`workspace remapping honors ${deniedSide} authorization`, async () => {
    let denied = '';
    const { binding, originalPackage } = await workspaceFixture(async (path) => path !== denied);
    denied = deniedSide === 'original-target' ? join(originalPackage, 'index.ts')
      : join(deniedSide === 'original-alias' ? binding.owner : binding.root, 'node_modules/workspace-math/index.ts');
    const result = await run(binding, 'bun -e "import {answer} from \'workspace-math\'; console.log(answer)"');
    expect(result.success).toBe(false);
    expect(result.stdout).toBe('');
    expect(JSON.stringify(result)).not.toContain('999');
  });

test.skipIf(!supported)('workspace remapping refuses an owner target absent from captured input', async () => {
  const binding = await fixture();
  mkdirSync(join(binding.owner, 'uncaptured'), { recursive: true });
  writeFileSync(join(binding.owner, 'uncaptured/index.js'), 'SYNTHETIC_UNCAPTURED');
  const dependencies = join(binding.owner, 'node_modules');
  mkdirSync(dependencies);
  symlinkSync('../uncaptured', join(dependencies, 'workspace-late'));
  await expect(admitCapturedExecDependency(binding, { sourceRoot: dependencies, targetRelativePath: 'node_modules' })).rejects.toThrow();
});

test.skipIf(!supported)('workspace remapping refuses excluded owner targets', async () => {
  const binding = await fixture();
  mkdirSync(join(binding.owner, '.aws'), { recursive: true });
  writeFileSync(join(binding.owner, '.aws/synthetic'), 'SYNTHETIC_EXCLUDED_WORKSPACE_TARGET');
  const dependencies = join(binding.owner, 'node_modules');
  mkdirSync(dependencies);
  symlinkSync('../.aws', join(dependencies, 'excluded-workspace'));
  await expect(admitCapturedExecDependency(binding, { sourceRoot: dependencies, targetRelativePath: 'node_modules' })).rejects.toThrow('escapes');
});

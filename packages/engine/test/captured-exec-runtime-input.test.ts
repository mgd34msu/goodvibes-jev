import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { captureContractInput, materializeContractInput, contractInputPath } from '../sdk/src/platform/contract/input-snapshot.js';
import { createContractInputAuthority } from '../sdk/src/platform/contract/input-authority.js';
import type { Contract } from '../sdk/src/platform/contract/types.js';
import { runCapturedCommand, probeCapturedExecAvailability, type CapturedExecAuthority } from '../sdk/src/platform/tools/exec/captured-exec.js';
import { admitCapturedExecNodeRuntime } from '../sdk/src/platform/tools/exec/captured-exec-runtime-input.js';
import { admitCapturedExecDependency } from '../sdk/src/platform/tools/exec/captured-exec-dependencies.js';
import { useToolReadings } from './_helpers/tool-readings.js';
useToolReadings();
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


function copyPackage(source: string, target: string, seen = new Set<string>()): void {
  const metadata = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  if (seen.has(metadata.name)) return;
  seen.add(metadata.name);
  const destination = join(target, metadata.name);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, dereference: true, filter: (path) => path === source || !path.slice(source.length + 1).split('/').includes('node_modules') });
  for (const name of Object.keys(metadata.dependencies ?? {})) {
    let cursor = source;
    while (!existsSync(join(cursor, 'node_modules', name)) && dirname(cursor) !== cursor) cursor = dirname(cursor);
    const dependency = join(cursor, 'node_modules', name);
    if (!existsSync(dependency)) throw new Error(`fixture dependency missing: ${name}`);
    copyPackage(realpathSync(dependency), target, seen);
  }
}

test.skipIf(!supported)('admitted real Node/npm runs unchanged local typecheck and lint commands', async () => {
  const binding = await fixture();
  const nodeRuntimeInput = await admitCapturedExecNodeRuntime(binding);
  const modules = join(binding.owner, 'node_modules'); mkdirSync(modules);
  copyPackage(realpathSync(join(import.meta.dir, '../../../node_modules/typescript')), modules);
  // ESLint is an existing workspace dependency; find its package through Bun's installed store.
  const store = realpathSync(join(import.meta.dir, '../../../node_modules/.bun'));
  const eslintEntry = (await import('node:fs/promises')).readdir(store).then((entries) => entries.find((entry) => entry.startsWith('eslint@')));
  const eslint = await eslintEntry;
  expect(eslint).toBeDefined();
  copyPackage(join(store, eslint!, 'node_modules/eslint'), modules);
  mkdirSync(join(modules, '.bin'));
  symlinkSync('../typescript/bin/tsc', join(modules, '.bin/tsc'));
  symlinkSync('../eslint/bin/eslint.js', join(modules, '.bin/eslint'));
  const dependency = await admitCapturedExecDependency(binding, { sourceRoot: modules, targetRelativePath: 'node_modules' });
  writeFileSync(join(binding.root, 'package.json'), '{"private":true}');
  writeFileSync(join(binding.root, 'answer.ts'), 'export const answer: number = 42;');
  writeFileSync(join(binding.root, 'tsconfig.json'), '{"compilerOptions":{"strict":true,"skipLibCheck":true},"files":["answer.ts"]}');
  writeFileSync(join(binding.root, 'answer.js'), 'const answer = 42; console.log(answer);');
  writeFileSync(join(binding.root, 'eslint.config.mjs'), 'export default [{files:["**/*.js"],rules:{"no-unused-vars":"error"}}];');
  const admitted = { ...binding, nodeRuntimeInput, dependencyInputs: [dependency!] };
  const result = await runCapturedCommand(admitted, 'npx tsc --noEmit && npx eslint --no-error-on-unmatched-pattern', {}, binding.root, 30000);
  expect(result.stderr).not.toContain('Captured exec held');
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(result.sandboxed).toBe(true);
  const escaped = await run(admitted, 'test ! -e /opt/codex && test ! -e /home/captured/.npmrc && node -e "console.log(process.version)"');
  expect(escaped.success).toBe(true);
  expect(escaped.stdout).toMatch(/^v/);
}, 180000);

for (const denied of ['/captured-runtime/bin/node', '/captured-runtime/node/lib/node_modules/npm/package.json'])
  test(`runtime admission rejects denied alias ${denied}`, async () => {
    const binding = await fixture((path) => path !== denied);
    await expect(admitCapturedExecNodeRuntime(binding)).rejects.toThrow('access-restricted');
  });
test('missing and malformed declarations fail explicitly', async () => {
  const binding = await fixture();
  await expect(admitCapturedExecNodeRuntime(binding, { nodeExecutable: '/synthetic-missing/node', npmExecutable: '/synthetic-missing/npm', npxExecutable: '/synthetic-missing/npx' })).rejects.toThrow();
  await expect(admitCapturedExecNodeRuntime(binding, { nodeExecutable: 'node', npmExecutable: 'npm', npxExecutable: 'npx' })).rejects.toThrow('absolute');
});
test.skipIf(!supported)('forged runtime inputs cannot claim a construction grant', async () => {
  const binding = await fixture();
  expect((await run({ ...binding, nodeRuntimeInput: { kind: 'captured-exec-node-runtime' } }, 'echo forbidden')).denied).toBe(true);
});
function syntheticRuntime(binding: CapturedExecAuthority & { owner: string }) {
  const runtime = join(binding.owner, 'synthetic-runtime');
  const npm = join(runtime, 'lib/node_modules/npm');
  mkdirSync(join(runtime, 'bin'), { recursive: true });
  for (const part of ['bin', 'lib', 'node_modules']) mkdirSync(join(npm, part), { recursive: true });
  writeFileSync(join(runtime, 'bin/node'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(npm, 'package.json'), '{"name":"npm"}');
  for (const part of ['index.js', 'bin/npm-cli.js', 'bin/npx-cli.js']) writeFileSync(join(npm, part), '');
  return { nodeExecutable: join(runtime, 'bin/node'), npmExecutable: join(npm, 'bin/npm-cli.js'), npxExecutable: join(npm, 'bin/npx-cli.js') };
}
test.skipIf(!supported)('changed runtime identities and cross-owner tokens cannot execute', async () => {
  const binding = await fixture();
  const declaration = syntheticRuntime(binding);
  const nodeRuntimeInput = await admitCapturedExecNodeRuntime(binding, declaration);
  const other = await fixture();
  expect((await run({ ...other, nodeRuntimeInput }, 'echo forbidden')).denied).toBe(true);
  writeFileSync(declaration.nodeExecutable, '#!/bin/sh\necho changed\n');
  const result = await run({ ...binding, nodeRuntimeInput }, 'echo forbidden');
  expect(result.denied).toBe(true); expect(result.stdout).toBe('');
});
test('original runtime denial and escaping package path fail admission', async () => {
  let denied = '';
  const binding = await fixture((path) => path !== denied);
  const declaration = syntheticRuntime(binding);
  denied = declaration.nodeExecutable;
  await expect(admitCapturedExecNodeRuntime(binding, declaration)).rejects.toThrow('access-restricted');
  denied = '';
  symlinkSync(join(binding.owner, 'private.txt'), join(dirname(declaration.npmExecutable), 'escape.js'));
  await expect(admitCapturedExecNodeRuntime(binding, declaration)).rejects.toThrow('symlinks');
});
test('cancellation settles a pending runtime permission callback', async () => {
  const controller = new AbortController();
  const binding = await fixture(() => new Promise<boolean>(() => {}));
  const declaration = syntheticRuntime(binding);
  const pending = admitCapturedExecNodeRuntime({ ...binding, signal: controller.signal }, declaration);
  setTimeout(() => controller.abort(), 50);
  await expect(pending).rejects.toThrow();
});
test.skipIf(!supported)('an executable alias cannot materialize an unadmitted canonical target', async () => {
  let denied = '';
  const binding = await fixture((path) => path !== denied);
  const modules = join(binding.owner, 'node_modules');
  mkdirSync(join(modules, '.bin'), { recursive: true });
  mkdirSync(join(modules, 'package'));
  writeFileSync(join(modules, 'package/tool.js'), 'console.log("UNADMITTED_TARGET");');
  symlinkSync('../package/tool.js', join(modules, '.bin/tool'));
  denied = join(binding.root, 'node_modules/package/tool.js');
  const dependency = await admitCapturedExecDependency(binding, { sourceRoot: modules, targetRelativePath: 'node_modules' });
  const result = await run({ ...binding, dependencyInputs: [dependency!] }, 'cat node_modules/.bin/tool');
  expect(result.denied).toBe(true); expect(result.stdout).toBe('');
});
test.skipIf(!supported)('call-only cancellation cannot recreate a cleaned runtime projection after a late permission answer', async () => {
  let armed = false; let nodePath = '';
  let release!: () => void; let reached!: () => void;
  const waiting = new Promise<void>((resolve) => { reached = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const binding = await fixture(async (path) => {
    if (armed && path === nodePath) { armed = false; reached(); await gate; }
    return true;
  });
  const declaration = syntheticRuntime(binding); nodePath = declaration.nodeExecutable;
  const nodeRuntimeInput = await admitCapturedExecNodeRuntime(binding, declaration);
  const before = new Set(readdirSync(tmpdir()));
  const cancel = new AbortController();
  armed = true;
  const pending = run({ ...binding, nodeRuntimeInput }, 'echo should-not-start', cancel.signal);
  try {
    await waiting;
    const created = readdirSync(tmpdir()).filter((name) => name.startsWith('goodvibes-captured-exec-') && !before.has(name));
    expect(created).toHaveLength(1);
    const directory = join(tmpdir(), created[0]!);
    cancel.abort();
    const result = await pending;
    expect(result.success).toBe(false); expect(result.stdout).toBe('');
    expect(existsSync(directory)).toBe(false);
    release();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(existsSync(directory)).toBe(false);
  } finally { cancel.abort(); release(); await pending; }
});

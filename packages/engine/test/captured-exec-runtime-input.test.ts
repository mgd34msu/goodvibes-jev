import { checkCapturedInputsInBatches } from '../sdk/src/platform/tools/exec/captured-exec-validation.js';
import { executePolicyCheck } from '../sdk/src/platform/gate/execute-policy-check.js';
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as childProcess from 'node:child_process';
import * as asyncFs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { captureContractInput, materializeContractInput, contractInputPath } from '../sdk/src/platform/contract/input-snapshot.js';
import { assertContractInputReadAccess, createContractInputAuthority, revokeContractInputAuthority } from '../sdk/src/platform/contract/input-authority.js';
import type { Contract } from '../sdk/src/platform/contract/types.js';
import { runCapturedCommand, probeCapturedExecAvailability, type CapturedExecAuthority } from '../sdk/src/platform/tools/exec/captured-exec.js';
import { admitCapturedExecNodeRuntime, createCapturedExecNodeRuntimeAdmission } from '../sdk/src/platform/tools/exec/captured-exec-runtime-input.js';
import { admitCapturedExecDependency } from '../sdk/src/platform/tools/exec/captured-exec-dependencies.js';
import { createCapturedValidatorRunner } from '../sdk/src/platform/tools/shared/captured-validators.js';
import { capturedInputTool } from '../sdk/src/platform/tools/shared/captured-input-tools.js';
import { createWriteTool } from '../sdk/src/platform/tools/write/index.js';
import { FileStateCache } from '../sdk/src/platform/state/file-cache.js';
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

test.skipIf(!supported)('direct commands consume the construction-owned Node/npm admission', async () => {
  const binding = await fixture((path) => !path.endsWith('/private.txt'));
  const nodeRuntimeAdmission = createCapturedExecNodeRuntimeAdmission(binding);
  writeFileSync(join(binding.root, 'package.json'), JSON.stringify({ private: true, scripts: { test: 'node check.test.cjs' } }));
  writeFileSync(join(binding.root, 'check.test.cjs'), [
    'const { test } = require("node:test");',
    'const assert = require("node:assert/strict");',
    'const fs = require("node:fs");',
    'test("contained direct runtime", () => {',
    '  assert.equal(fs.existsSync("private.txt"), false);',
    '  assert.equal(fs.existsSync("/opt/codex"), false);',
    '  assert.equal(fs.existsSync("/home/captured/.npmrc"), false);',
    '  assert.equal(process.env.HOME, "/home/captured");',
    '  assert.equal(fs.readFileSync("input.txt", "utf8"), "captured-fixture\\n");',
    '  fs.writeFileSync("node-proof.txt", "REAL_CONTAINED_NODE\\n");',
    '});',
  ].join('\n'));
  const opened: string[] = [];
  const read = asyncFs.readFile;
  const tap = spyOn(asyncFs, 'readFile').mockImplementation(((...args: Parameters<typeof read>) => {
    opened.push(String(args[0]));
    return read(...args);
  }) as typeof read);
  let result;
  try { result = await runCapturedCommand({ ...binding, nodeRuntimeAdmission }, 'node --version && npm test && npx --version', {}, binding.root, 30000); }
  finally { tap.mockRestore(); }
  expect(opened).toContain(join(binding.root, 'input.txt'));
  expect(opened.some((path) => path.endsWith('/private.txt'))).toBe(false);
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(result.sandboxed).toBe(true);
  expect(result.stdout).toContain('contained direct runtime');
  expect(readFileSync(join(binding.root, 'node-proof.txt'), 'utf8')).toBe('REAL_CONTAINED_NODE\n');
  expect(existsSync(join(binding.owner, 'node-proof.txt'))).toBe(false);
  expect(JSON.stringify(result)).not.toContain('SYNTHETIC_DENIED_MARKER');
}, 120000);

test.skipIf(!supported)('simple Bun and shell commands do not admit an unused npm closure', async () => {
  const binding = await fixture();
  writeFileSync(join(binding.root, 'answer.ts'), 'export const answer = 42;');
  writeFileSync(join(binding.root, 'package.json'), JSON.stringify({ scripts: { build: 'bun build answer.ts --outdir dist' } }));
  writeFileSync(join(binding.root, 'answer.test.ts'), 'import { test, expect } from "bun:test"; import { answer } from "./answer"; test("answer", () => expect(answer).toBe(42));');
  let admissions = 0;
  const nodeRuntimeAdmission = async () => { admissions++; throw new Error('unused runtime must stay lazy'); };
  const result = await runCapturedCommand({ ...binding, nodeRuntimeAdmission }, `'bun' 'run' 'build' && 'bun' 'test' answer.test.ts && echo node && printf "%s" npm`, {}, binding.root, 10000);
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(result.stdout).toContain('node');
  expect(result.stdout).toContain('npm');
  expect(readFileSync(join(binding.root, 'dist/answer.js'), 'utf8')).toContain('42');
  expect(admissions).toBe(0);
});

for (const command of [
  'node',
  'NODE_ENV=test node',
  'env NODE_ENV=test node',
  'sh -c "node"',
  'command node',
  '/captured-runtime/bin/node',
  '/captured-runtime/bin/node test',
  '>echo node',
  '"/captured-runtime/bin/node" echo',
  'printf fixture; node',
  'echo "$(node)"',
  'echo fixture\nnode',
  ': & node',
  '$(printf node)',
  `${'echo '.repeat(1100)}; node`,
  `echo ${'x'.repeat(66000)}; node`,
])
  test.skipIf(!supported)(`direct runtime selection supports ${command.length > 100 ? `bounded fallback (${command.length} characters)` : JSON.stringify(command)}`, async () => {
    const binding = await fixture();
    const declaration = syntheticRuntime(binding);
    writeFileSync(declaration.nodeExecutable, '#!/bin/sh\necho SELECTED_RUNTIME\n', { mode: 0o755 });
    const admit = createCapturedExecNodeRuntimeAdmission(binding, declaration);
    let admissions = 0;
    const nodeRuntimeAdmission = (signal?: AbortSignal) => { admissions++; return admit(signal); };
    const result = await run({ ...binding, nodeRuntimeAdmission }, command);
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(command === '>echo node' ? readFileSync(join(binding.root, 'echo'), 'utf8') : result.stdout).toContain('SELECTED_RUNTIME');
    expect(admissions).toBe(1);
  });

test.skipIf(!supported)('a PATH override cannot disguise a project Node wrapper as a shell primitive', async () => {
  const binding = await fixture();
  const declaration = syntheticRuntime(binding);
  writeFileSync(declaration.nodeExecutable, '#!/bin/sh\necho PROJECT_WRAPPER_RUNTIME\n', { mode: 0o755 });
  writeFileSync(join(binding.root, 'sleep'), '#!/bin/sh\nexec /captured-runtime/bin/node\n', { mode: 0o755 });
  const nodeRuntimeAdmission = createCapturedExecNodeRuntimeAdmission(binding, declaration);
  const result = await runCapturedCommand({ ...binding, nodeRuntimeAdmission }, 'sleep', { env: { PATH: `${binding.root}:/captured-runtime/bin:/usr/bin:/bin` } }, binding.root, 5000);
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(result.stdout).toBe('PROJECT_WRAPPER_RUNTIME\n');
});

for (const deniedSide of ['original', 'alias'] as const)
  test.skipIf(!supported)(`direct runtime admission respects ${deniedSide} denial without runtime fallback`, async () => {
    let denied = '';
    const binding = await fixture((path) => path !== denied);
    const declaration = syntheticRuntime(binding);
    writeFileSync(declaration.nodeExecutable, '#!/bin/sh\necho SYNTHETIC_RUNTIME_PRIVATE\n', { mode: 0o755 });
    denied = deniedSide === 'original' ? declaration.nodeExecutable : '/captured-runtime/bin/node';
    const nodeRuntimeAdmission = createCapturedExecNodeRuntimeAdmission(binding, declaration);
    const opened: string[] = [];
    const read = asyncFs.readFile;
    const tap = spyOn(asyncFs, 'readFile').mockImplementation(((...args: Parameters<typeof read>) => {
      opened.push(String(args[0]));
      return read(...args);
    }) as typeof read);
    let result;
    try { result = await run({ ...binding, nodeRuntimeAdmission }, 'node'); }
    finally { tap.mockRestore(); }
    expect(opened).not.toContain(declaration.nodeExecutable);
    expect(result.success).toBe(false);
    expect(result.exit_code).toBe(126);
    expect(result.stdout).toBe('');
    expect((result.stderr ?? '').length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_RUNTIME_PRIVATE');
    expect((await run({ ...binding, nodeRuntimeAdmission }, 'bun -e "console.log(42)"')).stdout).toBe('42\n');
  });

for (const admitted of [false, true])
  test.skipIf(!supported)(`known OS runtime aliases stay blocked with ${admitted ? 'admitted' : 'unavailable'} direct runtime`, async () => {
    const binding = await fixture();
    const declaration = syntheticRuntime(binding);
    writeFileSync(declaration.nodeExecutable, '#!/bin/sh\necho ADMITTED_RUNTIME\n', { mode: 0o755 });
    const nodeRuntimeAdmission = createCapturedExecNodeRuntimeAdmission(binding, admitted ? declaration : {
      nodeExecutable: '/synthetic-missing/node', npmExecutable: '/synthetic-missing/npm', npxExecutable: '/synthetic-missing/npx',
    });
    // Model a system Node alias sharing an existing OS payload. The real
    // subprocess must see the readonly refusal mount, with no host changes.
    const exists = fs.existsSync;
    const canonical = fs.realpathSync;
    const existsTap = spyOn(fs, 'existsSync').mockImplementation((path) => String(path) === '/usr/bin/node' || exists(path));
    const canonicalTap = spyOn(fs, 'realpathSync').mockImplementation(((path: fs.PathLike, options?: unknown) =>
      String(path) === '/usr/bin/node' ? '/usr/bin/true' : canonical(path, options as Parameters<typeof canonical>[1])) as typeof canonical);
    try {
      const result = await run({ ...binding, nodeRuntimeAdmission }, '/usr/bin/true');
      expect(result.success).toBe(false);
      expect(result.exit_code).toBe(126);
      expect((result.stderr ?? '').length).toBeGreaterThan(0);
      if (admitted) expect((await run({ ...binding, nodeRuntimeAdmission }, 'node')).stdout).toBe('ADMITTED_RUNTIME\n');
    } finally { existsTap.mockRestore(); canonicalTap.mockRestore(); }
  });

test.skipIf(!supported)('a Node host never binds its executable after optional runtime admission fails', async () => {
  const binding = await fixture();
  const nodeRuntimeAdmission = createCapturedExecNodeRuntimeAdmission(binding, {
    nodeExecutable: '/synthetic-missing/node', npmExecutable: '/synthetic-missing/npm', npxExecutable: '/synthetic-missing/npx',
  });
  const hostNode = spawnSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' }).stdout.trim();
  expect(hostNode).toBeTruthy();
  const executable = Object.getOwnPropertyDescriptor(process, 'execPath')!;
  const bun = Object.getOwnPropertyDescriptor(process.versions, 'bun')!;
  const spawn = childProcess.spawn;
  const commands: string[][] = [];
  const tap = spyOn(childProcess, 'spawn').mockImplementation(((...args: Parameters<typeof spawn>) => {
    if (args[0] === '/usr/bin/bwrap' && Array.isArray(args[1])) commands.push([...args[1]]);
    return spawn(...args);
  }) as typeof spawn);
  try {
    Object.defineProperty(process.versions, 'bun', { ...bun, value: undefined });
    Object.defineProperty(process, 'execPath', { ...executable, value: hostNode });
    const result = await run({ ...binding, nodeRuntimeAdmission }, 'node --version');
    expect(result.exit_code).toBe(126);
    expect(result.stdout).toBe('');
    expect(commands).toHaveLength(1);
    expect(commands[0]).not.toContain(hostNode);
  } finally {
    tap.mockRestore();
    Object.defineProperty(process.versions, 'bun', bun);
    Object.defineProperty(process, 'execPath', executable);
  }
});

for (const interruption of ['cancel', 'revoke'] as const)
  test.skipIf(!supported)(`${interruption} during direct runtime admission starts no command or late projection`, async () => {
    let nodePath = '';
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const waiting = new Promise<void>((resolve) => { reached = resolve; });
    const binding = await fixture(async (path) => {
      if (path === nodePath) { reached(); await gate; }
      return true;
    });
    const declaration = syntheticRuntime(binding);
    nodePath = declaration.nodeExecutable;
    const nodeRuntimeAdmission = createCapturedExecNodeRuntimeAdmission(binding, declaration);
    const controller = new AbortController();
    let started = 0;
    const before = new Set(readdirSync(tmpdir()));
    const pending = runCapturedCommand({ ...binding, nodeRuntimeAdmission }, 'node; echo LATE > late.txt', {}, binding.root, 5000, controller.signal, 'disabled', {}, { onStarted: () => { started++; } });
    try {
      await waiting;
      if (interruption === 'cancel') controller.abort();
      else { revokeContractInputAuthority(binding.authority); release(); }
      const result = await pending;
      expect(result.denied).toBe(true);
      expect(result.stdout).toBe('');
      expect(started).toBe(0);
      release();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(existsSync(join(binding.root, 'late.txt'))).toBe(false);
      expect(readdirSync(tmpdir()).filter((name) => name.startsWith('goodvibes-captured-exec-') && !before.has(name))).toEqual([]);
    } finally { controller.abort(); release(); await pending; }
  });

test.skipIf(!supported)('direct memoized runtime admission never hides changed or forged token failures', async () => {
  const binding = await fixture();
  const declaration = syntheticRuntime(binding);
  writeFileSync(declaration.nodeExecutable, '#!/bin/sh\necho ADMITTED_RUNTIME\n', { mode: 0o755 });
  const nodeRuntimeAdmission = createCapturedExecNodeRuntimeAdmission(binding, declaration);
  const admitted = { ...binding, nodeRuntimeAdmission };
  expect((await run(admitted, 'node')).stdout).toBe('ADMITTED_RUNTIME\n');
  writeFileSync(declaration.nodeExecutable, '#!/bin/sh\necho CHANGED_RUNTIME\n');
  const changed = await run(admitted, 'node');
  expect(changed.denied).toBe(true);
  expect(changed.stdout).toBe('');
  let calls = 0;
  const forged = await run({ ...binding, nodeRuntimeInput: { kind: 'captured-exec-node-runtime' }, nodeRuntimeAdmission: async () => { calls++; return nodeRuntimeAdmission(); } }, 'echo FORGED');
  expect(forged.denied).toBe(true);
  expect(forged.stdout).toBe('');
  expect(calls).toBe(0);
});

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
test.skipIf(!supported)('direct exec and fixed validators reuse one opaque runtime with fresh denial', async () => {
  let denied = '';
  const base = await fixture((path) => path !== denied);
  const declaration = syntheticRuntime(base);
  writeFileSync(declaration.nodeExecutable, '#!/bin/sh\necho DIRECT_RUNTIME\n', { mode: 0o755 });
  writeFileSync(declaration.npxExecutable, '#!/bin/sh\ncase "$*" in "tsc --noEmit"|"eslint --no-error-on-unmatched-pattern") printf "%s\\n" "$*" >> validators.txt; echo FIXED_VALIDATOR; exit 0;; *) exit 87;; esac\n', { mode: 0o755 });
  fs.chmodSync(declaration.npxExecutable, 0o755);
  const admit = createCapturedExecNodeRuntimeAdmission(base, declaration);
  const tokens: unknown[] = [];
  const binding = { ...base, nodeRuntimeAdmission: async (signal?: AbortSignal) => {
    const token = await admit(signal); tokens.push(token); return token;
  } };
  expect((await run(binding, 'node')).stdout).toBe('DIRECT_RUNTIME\n');
  const validatorRunner = createCapturedValidatorRunner(binding);
  const write = capturedInputTool(createWriteTool({ projectRoot: base.root, fileCache: new FileStateCache(), validatorRunner }), base.authority, base.root, base.readAccessFilter, undefined);
  const result = await write.execute({ files: [{ path: 'source.ts', content: 'checked', mode: 'overwrite' }], validate: { after: ['typecheck', 'lint'] }, verbosity: 'standard' });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(JSON.parse(result.output!).validation_passed, JSON.stringify(result)).toBe(true);
  expect(readFileSync(join(base.root, 'validators.txt'), 'utf8')).toBe('tsc --noEmit\neslint --no-error-on-unmatched-pattern\n');
  expect(tokens.length).toBe(3);
  expect(tokens[1]).toBe(tokens[0]); expect(tokens[2]).toBe(tokens[0]);
  expect(existsSync(join(base.owner, 'validators.txt'))).toBe(false);
  denied = '/captured-runtime/bin/node';
  const refused = await write.execute({ files: [{ path: 'source.ts', content: 'forbidden', mode: 'overwrite' }], validate: { after: ['typecheck'] } });
  expect(refused.success).toBe(false);
  expect(readFileSync(join(base.root, 'source.ts'), 'utf8')).toBe('checked');
});

test('fixed-validator runtime admission is lazy, pinned and memoized', async () => {
  let reads = 0;
  const binding = await fixture(() => { reads++; return true; });
  const declaration = syntheticRuntime(binding);
  const admit = createCapturedExecNodeRuntimeAdmission(binding, declaration);
  expect(reads).toBe(0);
  const first = await admit(); const after = reads;
  expect(await admit()).toBe(first); expect(reads).toBe(after);
  const changed = createCapturedExecNodeRuntimeAdmission(binding, declaration);
  writeFileSync(declaration.nodeExecutable, '#!/bin/sh\nexit 1\n');
  await expect(changed()).rejects.toThrow('changed since trusted construction');
});
test.skipIf(!supported)('unused unavailable Node runtime preserves an ordinary Bun command', async () => {
  const binding = await fixture();
  const nodeRuntimeAdmission = createCapturedExecNodeRuntimeAdmission(binding, {
    nodeExecutable: '/synthetic-missing/node', npmExecutable: '/synthetic-missing/npm', npxExecutable: '/synthetic-missing/npx',
  });
  const result = await run({ ...binding, nodeRuntimeAdmission }, 'bun -e "console.log(42)"');
  expect(result.success).toBe(true); expect(result.stdout).toBe('42\n');
  await expect(nodeRuntimeAdmission()).rejects.toThrow();
  for (const command of ['node --version', 'npm --version', 'npx --version']) {
    const absent = await run({ ...binding, nodeRuntimeAdmission }, command);
    expect(absent.exit_code).toBe(126);
    expect(absent.success).toBe(false);
    expect(absent.stdout).toBe('');
  }
});
for (const mutation of ['branch', 'revoke'] as const)
  test(`metadata sweep rechecks ${mutation} changes before provider delivery`, async () => {
    let act: (() => void) | undefined;
    const binding = await fixture(() => { const current = act; act = undefined; current?.(); return true; });
    const modules = join(binding.owner, 'node_modules');
    mkdirSync(modules);
    writeFileSync(join(modules, 'dependency.js'), 'export const answer = 42;');
    await admitCapturedExecDependency(binding, { sourceRoot: modules, targetRelativePath: 'node_modules' });
    act = mutation === 'branch'
      ? () => git(binding.root, 'switch', '-c', 'changed-during-sweep')
      : () => revokeContractInputAuthority(binding.authority);
    await expect(assertContractInputReadAccess(binding.authority, binding.readAccessFilter)).rejects.toThrow();
  });

test.skipIf(!supported)('call-only cancellation cannot recreate a cleaned dependency projection after a late permission answer', async () => {
  let armed = false; let dependencyPath = '';
  let release!: () => void; let reached!: () => void;
  const waiting = new Promise<void>((resolve) => { reached = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const binding = await fixture(async (path) => {
    if (armed && path === dependencyPath) { armed = false; reached(); await gate; }
    return true;
  });
  const modules = join(binding.owner, 'node_modules');
  mkdirSync(modules); dependencyPath = join(modules, 'dependency.js');
  writeFileSync(dependencyPath, 'export const answer = 42;');
  const dependency = await admitCapturedExecDependency(binding, { sourceRoot: modules, targetRelativePath: 'node_modules' });
  const before = new Set(readdirSync(tmpdir()));
  const cancel = new AbortController();
  armed = true;
  const pending = run({ ...binding, dependencyInputs: [dependency!] }, 'echo should-not-start', cancel.signal);
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
test('a failed validation batch cancels peers and drains every started check', async () => {
  let active = 0; let maximum = 0; let started = 0;
  await expect(checkCapturedInputsInBatches(Array.from({ length: 24 }, (_, i) => i), async (value, signal) => {
    started++; active++; maximum = Math.max(maximum, active);
    try {
      if (value === 0) { await Promise.resolve(); throw new Error('denied fixture input'); }
      await executePolicyCheck(() => new Promise<void>(() => {}), signal);
    } finally { await new Promise((resolve) => setTimeout(resolve, 5)); active--; }
  })).rejects.toThrow('denied fixture input');
  expect(active).toBe(0); expect(maximum).toBeLessThanOrEqual(8); expect(started).toBeLessThanOrEqual(8);
});
for (const mutation of ['branch', 'revoke'] as const)
  test(`private dependency admission never releases a token after ${mutation} changes during collection`, async () => {
    let act: (() => void) | undefined;
    const binding = await fixture(() => { const current = act; act = undefined; current?.(); return true; });
    const modules = join(binding.owner, 'node_modules'); mkdirSync(modules);
    writeFileSync(join(modules, 'dependency.js'), 'export const answer = 42;');
    act = mutation === 'branch'
      ? () => git(binding.root, 'switch', '-c', 'changed-during-private-admission')
      : () => revokeContractInputAuthority(binding.authority);
    await expect(admitCapturedExecDependency(binding, { sourceRoot: modules, targetRelativePath: 'node_modules' })).rejects.toThrow();
  });

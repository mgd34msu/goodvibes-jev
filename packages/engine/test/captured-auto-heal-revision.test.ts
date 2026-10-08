import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigManager } from '../sdk/src/platform/config/manager.js';
import { createContractInputAuthority } from '../sdk/src/platform/contract/input-authority.js';
import { captureContractInput, contractInputPath, materializeContractInput } from '../sdk/src/platform/contract/input-snapshot.js';
import type { Contract } from '../sdk/src/platform/contract/types.js';
import { FileStateCache } from '../sdk/src/platform/state/file-cache.js';
import { createEditTool } from '../sdk/src/platform/tools/edit/index.js';
import { AutoHealer } from '../sdk/src/platform/tools/shared/auto-heal.js';
import { createCapturedAutoHealBackend, type CapturedAutoHealBackend } from '../sdk/src/platform/tools/shared/captured-auto-heal.js';
import { capturedInputTool } from '../sdk/src/platform/tools/shared/captured-input-tools.js';
import type { ValidatorRunner } from '../sdk/src/platform/tools/shared/validators.js';
import { createWriteTool } from '../sdk/src/platform/tools/write/index.js';
import { useToolReadings } from './_helpers/tool-readings.js';

useToolReadings([['', { fixesErrors: true, onlyTheFix: true }]]);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const original = 'export const original = 1;\n';
const broken = 'export const broken = ;\n';
const repaired = 'export const repaired = 2;\n';

function git(root: string, ...args: string[]): void {
  const result = spawnSync('git', ['-C', root, ...args]);
  if (result.status !== 0) throw new Error(result.stderr.toString());
}
async function fixture() {
  const owner = mkdtempSync(join(tmpdir(), 'captured-heal-revision-')); roots.push(owner);
  git(owner, 'init', '-q'); git(owner, 'config', 'user.name', 'Fixture'); git(owner, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(owner, '.gitignore'), '.goodvibes/\n');
  writeFileSync(join(owner, 'repair.ts'), original);
  writeFileSync(join(owner, 'first.txt'), 'first original\n');
  writeFileSync(join(owner, 'second.txt'), 'second original\n');
  git(owner, 'add', '.'); git(owner, 'commit', '-qm', 'fixture');
  const inputSnapshot = await captureContractInput(owner); const root = contractInputPath(inputSnapshot);
  const branch = `input/${inputSnapshot.id}`;
  git(owner, 'worktree', 'add', '--no-checkout', '-b', branch, root, inputSnapshot.inputCommit);
  await materializeContractInput(inputSnapshot, root);
  const authority = await createContractInputAuthority({ projectRoot: owner, inputSnapshot } as Contract, root, { mutable: true, branch });
  const filter = async () => true;
  const binding = { authority, root, readAccessFilter: filter };
  const backend = createCapturedAutoHealBackend(binding);
  const config = (enabled = true) => ({ get: (() => enabled) as ConfigManager['get'], getWorkingDirectory: () => root });
  const write = (chat: () => Promise<string>, capturedAutoHeal: CapturedAutoHealBackend = backend) =>
    capturedInputTool(createWriteTool({ projectRoot: root, configManager: config(), toolLLM: { chat }, capturedAutoHeal }), authority, root, filter, undefined);
  const edit = (chat: () => Promise<string>, enabled = true, capturedAutoHeal: CapturedAutoHealBackend | undefined = backend) => {
    const validatorRunner: ValidatorRunner = async (name) => ({ validator: name, passed: false, exitCode: 1, stdout: '', stderr: 'Synthetic validation failure' });
    return capturedInputTool(createEditTool(new FileStateCache(), { cwd: root, configManager: config(enabled), toolLLM: { chat }, validatorRunner, capturedAutoHeal }), authority, root, filter, undefined);
  };
  return { owner, root, authority, binding, backend, config, write, edit };
}

for (const kind of ['existing', 'new'] as const)
  test(`atomic captured write preserves ${kind} later input changed during an earlier repair`, async () => {
    const f = await fixture(); let calls = 0;
    const target = kind === 'existing' ? 'second.txt' : 'created.txt';
    const tool = f.write(async () => { calls++; writeFileSync(join(f.root, target), 'newer external bytes\n'); return repaired; });
    const result = await tool.execute({ files: [
      { path: 'repair.ts', content: broken, mode: 'overwrite' },
      { path: target, content: 'requested replacement\n', mode: 'overwrite' },
    ], transaction: { mode: 'atomic' } });
    expect(calls).toBe(1); expect(result.success).toBe(false);
    expect(result.error).toContain('Atomic transaction failed');
    expect(readFileSync(join(f.root, target), 'utf8')).toBe('newer external bytes\n');
    expect(readFileSync(join(f.root, 'repair.ts'), 'utf8')).toBe(original);
    expect(readFileSync(join(f.owner, 'repair.ts'), 'utf8')).toBe(original);
  });

test('atomic captured repeated overwrite and rollback preserve a prior target changed during later repair', async () => {
  const f = await fixture(); let calls = 0;
  const tool = f.write(async () => { calls++; writeFileSync(join(f.root, 'first.txt'), 'newer first bytes\n'); return repaired; });
  const result = await tool.execute({ files: [
    { path: 'first.txt', content: 'first owned revision\n', mode: 'overwrite' },
    { path: 'repair.ts', content: broken, mode: 'overwrite' },
    { path: 'first.txt', content: 'later requested replacement\n', mode: 'overwrite' },
  ], transaction: { mode: 'atomic' } });
  expect(calls).toBe(1); expect(result.success).toBe(false);
  expect(result.error).toContain('Rollback failures');
  expect(readFileSync(join(f.root, 'first.txt'), 'utf8')).toBe('newer first bytes\n');
  expect(readFileSync(join(f.root, 'repair.ts'), 'utf8')).toBe(original);
  expect(readFileSync(join(f.owner, 'first.txt'), 'utf8')).toBe('first original\n');
});

test('atomic captured edit rollback preserves an earlier edited target changed during a later repair', async () => {
  const f = await fixture(); let calls = 0;
  const tool = f.edit(async () => {
    if (++calls === 2) writeFileSync(join(f.root, 'first.txt'), 'newer first bytes\n');
    return '';
  });
  const result = await tool.execute({ edits: [
    { path: 'first.txt', find: 'original', replace: 'edited' },
    { path: 'second.txt', find: 'original', replace: 'edited' },
  ], validate: { after: ['build'] }, transaction: { mode: 'atomic' } });
  expect(calls).toBe(2); expect(result.success).toBe(false);
  expect(result.error).toContain('rollback incomplete');
  expect(result.error).toContain('Rollback held');
  expect(readFileSync(join(f.root, 'first.txt'), 'utf8')).toBe('newer first bytes\n');
  expect(readFileSync(join(f.root, 'second.txt'), 'utf8')).toBe('second original\n');
  expect(readFileSync(join(f.owner, 'first.txt'), 'utf8')).toBe('first original\n');
});

test('disabled captured edit auto-heal does not require a repair backend or call a provider', async () => {
  const f = await fixture(); let calls = 0;
  const validatorRunner: ValidatorRunner = async (name) => ({ validator: name, passed: false, exitCode: 1, stdout: '', stderr: 'Synthetic validation failure' });
  const tool = capturedInputTool(createEditTool(new FileStateCache(), {
    cwd: f.root, configManager: f.config(false), toolLLM: { chat: async () => { calls++; return repaired; } }, validatorRunner,
  }), f.authority, f.root, f.binding.readAccessFilter, undefined);
  const result = await tool.execute({ edits: [{ path: 'first.txt', find: 'original', replace: 'edited' }], validate: { after: ['build'] }, transaction: { mode: 'atomic' } });
  expect(calls).toBe(0); expect(result.success).toBe(false);
  expect(result.error).toContain('Post-edit validation failed');
  expect(readFileSync(join(f.root, 'first.txt'), 'utf8')).toBe('first original\n');
});

for (const kind of ['forged', 'copied', 'different authority'] as const)
  test(`captured repair rejects a ${kind} backend before provider delivery`, async () => {
    const f = await fixture(); let calls = 0;
    const backend = kind === 'forged' ? { kind: 'captured-auto-heal-backend' as const }
      : kind === 'copied' ? { ...f.backend }
      : createCapturedAutoHealBackend((await fixture()).binding);
    const tool = f.write(async () => { calls++; return repaired; }, backend);
    const result = await tool.execute({ files: [{ path: 'repair.ts', content: broken, mode: 'overwrite' }] });
    expect(calls).toBe(0); expect(result.success).toBe(false);
    expect(result.error).toContain('Output withheld');
    expect(readFileSync(join(f.root, 'repair.ts'), 'utf8')).toBe(broken);
    expect(readFileSync(join(f.owner, 'repair.ts'), 'utf8')).toBe(original);
  });

test('non-authority contained stage failures still fall through formatter, linter and ToolLLM', async () => {
  const stages: string[] = [];
  const config = { get: (() => true) as ConfigManager['get'] };
  const healer = new AutoHealer(config, { chat: async () => { stages.push('llm'); return repaired; } }, {
    check: async () => {},
    checkSynchronous: () => {},
    transform: async (stage) => { stages.push(stage); throw new Error('Synthetic unavailable stage'); },
  });
  const result = await healer.heal('repair.ts', broken, ['Syntax failure']);
  expect(stages).toEqual(['formatter', 'linter', 'llm']);
  expect(result.healed).toBe(true); expect(result.content).toBe(repaired);
  expect(result.warnings?.some((warning) => warning.includes('formatter stage failed'))).toBe(true);
  expect(result.warnings?.some((warning) => warning.includes('linter stage failed'))).toBe(true);
});

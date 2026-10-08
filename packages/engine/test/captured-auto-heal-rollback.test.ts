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
import { FileUndoManager } from '../sdk/src/platform/state/file-undo.js';
import { createEditTool } from '../sdk/src/platform/tools/edit/index.js';
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
async function fixture(onRead?: (path: string, root: string) => void) {
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
  const filter = async (path: string) => { onRead?.(path, root); return true; };
  const binding = { authority, root, readAccessFilter: filter };
  const backend = createCapturedAutoHealBackend(binding);
  const config = (enabled = true) => ({ get: (() => enabled) as ConfigManager['get'], getWorkingDirectory: () => root });
  const write = (chat: () => Promise<string>, capturedAutoHeal: CapturedAutoHealBackend = backend, fileUndoManager?: FileUndoManager) =>
    capturedInputTool(createWriteTool({ projectRoot: root, configManager: config(), toolLLM: { chat }, capturedAutoHeal, fileUndoManager }), authority, root, filter, undefined);
  const edit = (chat: () => Promise<string>, enabled = true, capturedAutoHeal: CapturedAutoHealBackend | undefined = backend) => {
    const validatorRunner: ValidatorRunner = async (name) => ({ validator: name, passed: false, exitCode: 1, stdout: '', stderr: 'Synthetic validation failure' });
    return capturedInputTool(createEditTool(new FileStateCache(), { cwd: root, configManager: config(enabled), toolLLM: { chat }, validatorRunner, capturedAutoHeal }), authority, root, filter, undefined);
  };
  return { owner, root, authority, binding, backend, config, write, edit };
}

test('atomic captured write rolls back unchanged earlier files when the current repair target conflicts', async () => {
  const f = await fixture();
  const result = await f.write(async () => {
    writeFileSync(join(f.root, 'repair.ts'), 'newer repair bytes\n');
    return repaired;
  }).execute({ files: [
    { path: 'first.txt', content: 'first owned revision\n', mode: 'overwrite' },
    { path: 'repair.ts', content: broken, mode: 'overwrite' },
  ], transaction: { mode: 'atomic' } });
  expect(result.success).toBe(false);
  expect(readFileSync(join(f.root, 'repair.ts'), 'utf8')).toBe('newer repair bytes\n');
  expect(readFileSync(join(f.root, 'first.txt'), 'utf8')).toBe('first original\n');
});

test('atomic captured edit rolls back unchanged siblings when the current repair target conflicts', async () => {
  const f = await fixture(); let calls = 0;
  const result = await f.edit(async () => {
    if (++calls === 2) writeFileSync(join(f.root, 'second.txt'), 'newer second bytes\n');
    return '';
  }).execute({ edits: [
    { path: 'first.txt', find: 'original', replace: 'edited' },
    { path: 'second.txt', find: 'original', replace: 'edited' },
  ], validate: { after: ['build'] }, transaction: { mode: 'atomic' } });
  expect(calls).toBe(2); expect(result.success).toBe(false);
  expect(readFileSync(join(f.root, 'second.txt'), 'utf8')).toBe('newer second bytes\n');
  expect(readFileSync(join(f.root, 'first.txt'), 'utf8')).toBe('first original\n');
});


test('failed captured atomic repair preserves the existing undo and redo history', async () => {
  const f = await fixture(); const undo = new FileUndoManager();
  const historyPath = join(f.root, 'second.txt');
  undo.snapshot({ path: historyPath, beforeContent: 'second original\n', afterContent: 'earlier history\n', tool: 'write' });
  undo.snapshot({ path: historyPath, beforeContent: 'earlier history\n', afterContent: 'later history\n', tool: 'write' });
  undo.undo();
  const previous = undo.peekUndo();
  expect(undo.undoDepth()).toBe(1); expect(undo.redoDepth()).toBe(1);
  const result = await f.write(async () => {
    writeFileSync(join(f.root, 'repair.ts'), 'newer repair bytes\n');
    return repaired;
  }, f.backend, undo).execute({ files: [
    { path: 'first.txt', content: 'first owned revision\n', mode: 'overwrite' },
    { path: 'repair.ts', content: broken, mode: 'overwrite' },
  ], transaction: { mode: 'atomic' } });
  expect(result.success).toBe(false);
  expect(readFileSync(join(f.root, 'first.txt'), 'utf8')).toBe('first original\n');
  expect(readFileSync(join(f.root, 'repair.ts'), 'utf8')).toBe('newer repair bytes\n');
  expect(undo.undoDepth()).toBe(1); expect(undo.redoDepth()).toBe(1);
  expect(undo.peekUndo()).toBe(previous);
  expect(undo.redo()?.path).toBe(historyPath);
  expect(readFileSync(historyPath, 'utf8')).toBe('later history\n');
});

test('successful captured atomic repair records exact healed intermediate and final undo revisions', async () => {
  const f = await fixture(); const undo = new FileUndoManager();
  const final = 'export const final = 3;\n';
  const result = await f.write(async () => repaired, f.backend, undo).execute({ files: [
    { path: 'repair.ts', content: broken, mode: 'overwrite' },
    { path: 'repair.ts', content: final, mode: 'overwrite' },
  ], transaction: { mode: 'atomic' } });
  expect(result.success).toBe(true); expect(undo.undoDepth()).toBe(2);
  expect(undo.peekUndo()).toMatchObject({ beforeContent: repaired, afterContent: final });
  undo.undo(); expect(readFileSync(join(f.root, 'repair.ts'), 'utf8')).toBe(repaired);
  expect(undo.peekUndo()).toMatchObject({ beforeContent: original, afterContent: repaired });
  undo.undo(); expect(readFileSync(join(f.root, 'repair.ts'), 'utf8')).toBe(original);
  expect(readFileSync(join(f.owner, 'repair.ts'), 'utf8')).toBe(original);
});

test('captured atomic first-file revision failure never writes a later file', async () => {
  let firstReads = 0;
  const f = await fixture((path, root) => {
    // First admission reads the source, second checks the collected snapshots,
    // and third is the final first-file authorization after revisions are pinned.
    if (path === join(root, 'first.txt') && ++firstReads === 3)
      writeFileSync(path, 'newer first bytes\n');
  });
  const result = await f.write(async () => repaired).execute({ files: [
    { path: 'first.txt', content: 'requested first replacement\n', mode: 'overwrite' },
    { path: 'second.txt', content: 'must never be written\n', mode: 'overwrite' },
  ], transaction: { mode: 'atomic' } });
  expect(result.success).toBe(false); expect(result.error).toContain('Atomic transaction failed');
  expect(readFileSync(join(f.root, 'first.txt'), 'utf8')).toBe('newer first bytes\n');
  expect(readFileSync(join(f.root, 'second.txt'), 'utf8')).toBe('second original\n');
  expect(readFileSync(join(f.owner, 'first.txt'), 'utf8')).toBe('first original\n');
  expect(readFileSync(join(f.owner, 'second.txt'), 'utf8')).toBe('second original\n');
});

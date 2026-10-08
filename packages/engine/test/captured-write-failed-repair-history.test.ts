import { afterEach, expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as capturedRepair from '../sdk/src/platform/tools/shared/captured-auto-heal.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JudgmentError } from '@goodvibes-jev/judgment';
import type { ConfigManager } from '../sdk/src/platform/config/manager.js';
import { createContractInputAuthority, revokeContractInputAuthority } from '../sdk/src/platform/contract/input-authority.js';
import { captureContractInput, contractInputPath, materializeContractInput } from '../sdk/src/platform/contract/input-snapshot.js';
import type { Contract } from '../sdk/src/platform/contract/types.js';
import { FileUndoManager } from '../sdk/src/platform/state/file-undo.js';
import { createCapturedAutoHealBackend } from '../sdk/src/platform/tools/shared/captured-auto-heal.js';
import { capturedInputTool } from '../sdk/src/platform/tools/shared/captured-input-tools.js';
import { createWriteTool } from '../sdk/src/platform/tools/write/index.js';
import { useToolReadings } from './_helpers/tool-readings.js';

useToolReadings([['', { fixesErrors: true, onlyTheFix: true }]]);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const original = 'export const original = 1;\n';
const broken = 'export const broken = ;\n';
const repaired = 'export const repaired = 2;\n';
function git(root: string, ...args: string[]) {
  const result = spawnSync('git', ['-C', root, ...args]);
  if (result.status !== 0) throw new Error(result.stderr.toString());
}
async function fixture() {
  const owner = mkdtempSync(join(tmpdir(), 'captured-write-failed-repair-')); roots.push(owner);
  git(owner, 'init', '-q'); git(owner, 'config', 'user.name', 'Fixture'); git(owner, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(owner, '.gitignore'), '.goodvibes/\n');
  writeFileSync(join(owner, 'repair.ts'), original);
  writeFileSync(join(owner, 'later.txt'), 'later original');
  writeFileSync(join(owner, 'history.txt'), 'history before');
  git(owner, 'add', '.'); git(owner, 'commit', '-qm', 'fixture');
  const inputSnapshot = await captureContractInput(owner); const root = contractInputPath(inputSnapshot); const branch = `input/${inputSnapshot.id}`;
  git(owner, 'worktree', 'add', '--no-checkout', '-b', branch, root, inputSnapshot.inputCommit);
  await materializeContractInput(inputSnapshot, root);
  const controller = new AbortController();
  const authority = await createContractInputAuthority({ projectRoot: owner, inputSnapshot } as Contract, root, { mutable: true, branch, signal: controller.signal });
  let allowed = true;
  const filter = async () => allowed;
  const backend = createCapturedAutoHealBackend({ authority, root, readAccessFilter: filter, signal: controller.signal });
  const undo = new FileUndoManager(); const history = join(root, 'history.txt');
  undo.snapshot({ path: history, beforeContent: 'history original', afterContent: 'history before', tool: 'write' });
  undo.snapshot({ path: history, beforeContent: 'history before', afterContent: 'history after', tool: 'write' });
  undo.undo(); const previous = undo.peekUndo();
  let thrown: unknown;
  const tool = (chat: () => Promise<string>, missingBackend = false) => {
    const write = createWriteTool({
      projectRoot: root, configManager: { get: (() => true) as ConfigManager['get'] }, toolLLM: { chat },
      capturedAutoHeal: missingBackend ? undefined : backend, fileUndoManager: undo,
    });
    return capturedInputTool({ definition: write.definition, async execute(args, options) {
      try { return await write.execute(args, options); }
      catch (error) { thrown = error; throw error; }
    } }, authority, root, filter, controller.signal);
  };
  return { owner, root, authority, controller, undo, previous, tool, thrown: () => thrown, deny: () => { allowed = false; } };
}

for (const mode of ['none', 'partial'] as const) {
  for (const failure of ['missing-backend', 'judgment', 'conflict', 'deny', 'revoke', 'cancel'] as const) {
    test(`captured ${mode} failed repair ${failure} records only live-authorized exact-owned history`, async () => {
      const f = await fixture(); let calls = 0;
      const result = await f.tool(async () => {
        calls++;
        if (failure === 'conflict') writeFileSync(join(f.root, 'repair.ts'), 'newer external bytes');
        if (failure === 'deny') f.deny();
        if (failure === 'revoke') revokeContractInputAuthority(f.authority);
        if (failure === 'cancel') f.controller.abort();
        throw new JudgmentError('unavailable', 'terminal repair judgment');
      }, failure === 'missing-backend').execute({ files: [
        { path: 'repair.ts', content: broken, mode: 'overwrite' },
        { path: 'later.txt', content: 'must not write', mode: 'overwrite' },
      ], transaction: { mode } });
      expect(result.success).toBe(false); expect(result.output).toBeUndefined();
      expect(calls).toBe(failure === 'missing-backend' ? 0 : 1);
      expect(readFileSync(join(f.root, 'repair.ts'), 'utf8')).toBe(failure === 'conflict' ? 'newer external bytes' : broken);
      expect(readFileSync(join(f.root, 'later.txt'), 'utf8')).toBe('later original');
      expect(readFileSync(join(f.owner, 'repair.ts'), 'utf8')).toBe(original);
      if (failure === 'missing-backend' || failure === 'judgment') {
        expect(f.undo.undoDepth()).toBe(2); expect(f.undo.redoDepth()).toBe(0);
        expect(f.undo.peekUndo()).toMatchObject({ path: join(f.root, 'repair.ts'), beforeContent: original, afterContent: broken, tool: 'write' });
        expect(f.undo.undo()?.path).toBe(join(f.root, 'repair.ts'));
        expect(readFileSync(join(f.root, 'repair.ts'), 'utf8')).toBe(original);
        expect(f.undo.peekUndo()).toBe(f.previous);
      } else {
        expect(f.undo.undoDepth()).toBe(1); expect(f.undo.redoDepth()).toBe(1);
        expect(f.undo.peekUndo()).toBe(f.previous);
        expect(f.undo.redo()?.path).toBe(join(f.root, 'history.txt'));
      }
    });
  }
}

for (const mode of ['none', 'partial'] as const) {
  for (const failure of ['io', 'conflict', 'deny', 'revoke', 'cancel'] as const) {
    test(`captured ${mode} repair publication ${failure} stops with only verified retained history`, async () => {
      const f = await fixture(); const terminal = new Error('synthetic repair publication failure');
      let publicationError: unknown = terminal;
      const actualHeal = capturedRepair.healToolFile;
      const heal = spyOn(capturedRepair, 'healToolFile').mockImplementation(async (...args) => {
        const result = await actualHeal(...args);
        return { ...result, assertCurrent: async () => {
          if (failure === 'conflict') writeFileSync(join(f.root, 'repair.ts'), 'newer external bytes');
          if (failure === 'deny') f.deny();
          if (failure === 'revoke') revokeContractInputAuthority(f.authority);
          if (failure === 'cancel') f.controller.abort();
          try { await result.assertCurrent(); }
          catch (error) { publicationError = error; throw error; }
        } };
      });
      const actualRename = fs.renameSync;
      const rename = spyOn(fs, 'renameSync').mockImplementation((source, target) => {
        if (failure === 'io' && target === join(f.root, 'repair.ts') && readFileSync(source, 'utf8') === repaired) throw terminal;
        actualRename(source, target);
      });
      try {
        const result = await f.tool(async () => repaired).execute({ files: [
          { path: 'repair.ts', content: broken, mode: 'overwrite' },
          { path: 'later.txt', content: 'must not write', mode: 'overwrite' },
        ], transaction: { mode } });
        expect(result.success).toBe(false); expect(result.output).toBeUndefined();
        expect(f.thrown()).toBe(publicationError);
        expect(readFileSync(join(f.root, 'repair.ts'), 'utf8')).toBe(failure === 'conflict' ? 'newer external bytes' : broken);
        expect(readFileSync(join(f.root, 'later.txt'), 'utf8')).toBe('later original');
        if (failure === 'io') {
          expect(f.undo.undoDepth()).toBe(2); expect(f.undo.redoDepth()).toBe(0);
          expect(f.undo.peekUndo()).toMatchObject({ path: join(f.root, 'repair.ts'), beforeContent: original, afterContent: broken });
          expect(f.undo.undo()?.path).toBe(join(f.root, 'repair.ts'));
          expect(readFileSync(join(f.root, 'repair.ts'), 'utf8')).toBe(original);
          expect(f.undo.peekUndo()).toBe(f.previous);
        } else {
          expect(f.undo.undoDepth()).toBe(1); expect(f.undo.redoDepth()).toBe(1);
          expect(f.undo.peekUndo()).toBe(f.previous);
        }
      } finally { rename.mockRestore(); heal.mockRestore(); }
    });
  }

  test(`successful captured ${mode} repair records exactly one final history entry`, async () => {
    const f = await fixture();
    const result = await f.tool(async () => repaired).execute({ files: [{ path: 'repair.ts', content: broken, mode: 'overwrite' }], transaction: { mode } });
    expect(result.success).toBe(true);
    expect(f.undo.undoDepth()).toBe(2); expect(f.undo.redoDepth()).toBe(0);
    expect(f.undo.peekUndo()).toMatchObject({ path: join(f.root, 'repair.ts'), beforeContent: original, afterContent: repaired });
    expect(f.undo.undo()?.path).toBe(join(f.root, 'repair.ts'));
    expect(readFileSync(join(f.root, 'repair.ts'), 'utf8')).toBe(original);
    expect(f.undo.peekUndo()).toBe(f.previous);
  });
}

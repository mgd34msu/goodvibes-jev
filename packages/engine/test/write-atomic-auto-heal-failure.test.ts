import { afterEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JudgmentError } from '@goodvibes-jev/judgment';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import type { ConfigManager } from '../sdk/src/platform/config/manager.js';
import { FileUndoManager } from '../sdk/src/platform/state/file-undo.js';
import { createWriteTool } from '../sdk/src/platform/tools/write/index.js';
import { useToolReadings } from './_helpers/tool-readings.js';

useToolReadings([['', { fixesErrors: true, onlyTheFix: true }]]);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const original = Buffer.from([0, 255, 254, 128, 195, 40, 13, 10]);
const broken = 'export const broken = ;\n';
const repaired = 'export const repaired = 2;\n';
const first = { path: 'first.txt', content: 'changed first\n', mode: 'overwrite' };
const repair = { path: 'repair.ts', content: broken, mode: 'overwrite' };
const later = { path: 'later.txt', content: 'must not change\n', mode: 'overwrite' };

function fixture(existing = true, healError?: Error) {
  const root = fs.mkdtempSync(join(tmpdir(), 'write-atomic-heal-failure-')); roots.push(root);
  fs.writeFileSync(join(root, first.path), original);
  if (existing) { fs.writeFileSync(join(root, repair.path), original); fs.chmodSync(join(root, repair.path), 0o640); }
  fs.writeFileSync(join(root, later.path), 'later original\n');
  const undo = new FileUndoManager();
  const history = join(root, 'history.txt');
  fs.writeFileSync(history, 'history after');
  undo.snapshot({ path: history, beforeContent: 'history original', afterContent: 'history before', tool: 'write' });
  undo.snapshot({ path: history, beforeContent: 'history before', afterContent: 'history after', tool: 'write' });
  undo.undo();
  const previous = undo.peekUndo();
  const calls: string[] = [];
  const tool = createWriteTool({ projectRoot: root, fileUndoManager: undo,
    configManager: { get: ((key: string) => key === 'tools.autoHeal' ? true : 'on') as ConfigManager['get'] },
    toolLLM: { chat: async () => { calls.push('heal'); if (healError) throw healError; return repaired; } },
    validatorRunner: async () => { calls.push('validate'); throw new Error('must not run'); },
    diagnosticsProvider: { name: 'fixture', supports: () => true, collect: async () => { calls.push('diagnostics'); return []; } },
  });
  return { root, undo, previous, tool, calls };
}

function assertRestored(f: ReturnType<typeof fixture>, existing: boolean) {
  expect(fs.readFileSync(join(f.root, first.path))).toEqual(original);
  if (existing) {
    expect(fs.readFileSync(join(f.root, repair.path))).toEqual(original);
    expect(fs.statSync(join(f.root, repair.path)).mode & 0o777).toBe(0o640);
  } else expect(fs.existsSync(join(f.root, repair.path))).toBe(false);
  expect(fs.readFileSync(join(f.root, later.path), 'utf8')).toBe('later original\n');
  expect(f.undo.undoDepth()).toBe(1); expect(f.undo.redoDepth()).toBe(1);
  expect(f.undo.peekUndo()).toBe(f.previous);
  expect(f.undo.redo()?.path).toBe(join(f.root, 'history.txt'));
  expect(fs.readFileSync(join(f.root, 'history.txt'), 'utf8')).toBe('history after');
  expect(f.undo.undo()?.path).toBe(join(f.root, 'history.txt'));
  expect(f.undo.undo()?.path).toBe(join(f.root, 'history.txt'));
  expect(fs.readFileSync(join(f.root, 'history.txt'), 'utf8')).toBe('history original');
}

for (const kind of ['judgment', 'provider-judgment', 'missing-port'] as const) {
  for (const existing of [true, false]) {
    for (const priorWrite of [true, false]) {
      test(`ordinary atomic ${kind} failure restores ${existing ? 'existing' : 'new'} repair target ${priorWrite ? 'after earlier writes' : 'on the first write'}`, async () => {
        const terminal = new JudgmentError('unavailable', 'terminal heal judgment');
        const f = fixture(existing, kind === 'provider-judgment' ? terminal : undefined);
        const which = spyOn(Bun, 'which').mockReturnValue(null);
        let judgments = 0;
        const previous = installJudgmentPort(kind === 'missing-port' ? undefined : {
          model: 'fixture', ask: async () => { judgments++; throw terminal; },
        });
        try {
          const files = priorWrite ? [first, { ...first, content: 'changed again' }, { path: 'created.txt', content: 'new' }, repair, later] : [repair, later];
          let thrown: unknown;
          try { await f.tool.execute({ files, transaction: { mode: 'atomic' }, validate: { after: ['test'] } }); }
          catch (error) { thrown = error; }
          if (kind !== 'missing-port') expect(thrown).toBe(terminal);
          else expect(thrown).toBeInstanceOf(JudgmentPortMissingError);
          expect(judgments).toBe(kind === 'judgment' ? 1 : 0);
          expect(f.calls).toEqual(['heal']);
          expect(fs.existsSync(join(f.root, 'created.txt'))).toBe(false);
          assertRestored(f, existing);
        } finally { installJudgmentPort(previous); which.mockRestore(); }
      });
    }
  }
}

for (const mode of ['atomic', 'none', 'partial'] as const) {
  test(`ordinary ${mode} repair rewrite failure ${mode === 'atomic' ? 'rolls back and stops' : 'keeps warning and continuation behavior'}`, async () => {
    const f = fixture();
    const which = spyOn(Bun, 'which').mockReturnValue(null);
    const actualRename = fs.renameSync;
    let failedRewrites = 0;
    const rename = spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      if (target === join(f.root, repair.path) && fs.readFileSync(source, 'utf8') === repaired) {
        failedRewrites++; throw new Error('synthetic repaired-file rename failure');
      }
      actualRename(source, target);
    });
    try {
      const result = await f.tool.execute({ files: [first, repair, later], transaction: { mode } });
      expect(failedRewrites).toBe(1);
      expect(f.calls).toEqual(mode === 'atomic' ? ['heal'] : ['heal', 'diagnostics', 'diagnostics', 'diagnostics']);
      if (mode === 'atomic') {
        expect(result.success).toBe(false);
        expect(result.error).toContain('Auto-heal rewrite failed');
        expect(result.error).toContain('Rolled back 2 file(s)');
        assertRestored(f, true);
      } else {
        expect(result.success).toBe(true);
        expect(result.warnings?.join('\n')).toContain('rewrite failed');
        expect(fs.readFileSync(join(f.root, repair.path), 'utf8')).toBe(broken);
        expect(fs.readFileSync(join(f.root, later.path), 'utf8')).toBe(later.content);
        expect(f.undo.undoDepth()).toBe(4); expect(f.undo.redoDepth()).toBe(0);
      }
    } finally { rename.mockRestore(); which.mockRestore(); }
  });
}

for (const mode of ['none', 'partial'] as const) {
  test(`ordinary ${mode} terminal heal errors still propagate without atomic rollback`, async () => {
    const f = fixture();
    const which = spyOn(Bun, 'which').mockReturnValue(null);
    const terminal = new JudgmentError('unavailable', 'terminal heal judgment');
    const previous = installJudgmentPort({ model: 'fixture', ask: async () => { throw terminal; } });
    try {
      await expect(f.tool.execute({ files: [first, repair, later], transaction: { mode } })).rejects.toBe(terminal);
      expect(fs.readFileSync(join(f.root, first.path), 'utf8')).toBe(first.content);
      expect(fs.readFileSync(join(f.root, repair.path), 'utf8')).toBe(broken);
      expect(fs.readFileSync(join(f.root, later.path), 'utf8')).toBe('later original\n');
      expect(f.undo.undoDepth()).toBe(2); expect(f.undo.redoDepth()).toBe(0);
      expect(f.calls).toEqual(['heal']);
    } finally { installJudgmentPort(previous); which.mockRestore(); }
  });
}

test('ordinary atomic dry run never invokes auto-heal or changes files and history', async () => {
  const f = fixture();
  const result = await f.tool.execute({ files: [first, repair, later], transaction: { mode: 'atomic' }, dry_run: true });
  expect(result.success).toBe(true); expect(f.calls).toEqual([]);
  assertRestored(f, true);
});

for (const frozen of [false, true]) {
  test(`ordinary terminal error ${frozen ? 'stays frozen' : 'reports incomplete rollback'} when rollback I/O fails`, async () => {
    const terminal = new JudgmentError('unavailable', 'terminal heal judgment');
    if (frozen) Object.freeze(terminal);
    const f = fixture(true, terminal);
    const which = spyOn(Bun, 'which').mockReturnValue(null);
    const actualRename = fs.renameSync;
    const rename = spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      if (target === join(f.root, first.path) && fs.readFileSync(source).equals(original))
        throw new Error('synthetic rollback rename failure');
      actualRename(source, target);
    });
    try {
      await expect(f.tool.execute({ files: [first, repair, later], transaction: { mode: 'atomic' } })).rejects.toBe(terminal);
      expect(terminal).toBeInstanceOf(JudgmentError);
      expect(terminal.kind).toBe('unavailable');
      if (frozen) expect(terminal.message).toBe('terminal heal judgment');
      else {
        expect(terminal.message).toContain('Atomic rollback incomplete');
        expect(terminal.message).toContain('synthetic rollback rename failure');
      }
      expect(fs.readFileSync(join(f.root, first.path), 'utf8')).toBe(first.content);
      expect(fs.readFileSync(join(f.root, repair.path))).toEqual(original);
      expect(fs.readFileSync(join(f.root, later.path), 'utf8')).toBe('later original\n');
      expect(f.undo.undoDepth()).toBe(1); expect(f.undo.redoDepth()).toBe(1);
      expect(f.undo.peekUndo()).toBe(f.previous);
      expect(f.calls).toEqual(['heal']);
    } finally { rename.mockRestore(); which.mockRestore(); }
  });
}

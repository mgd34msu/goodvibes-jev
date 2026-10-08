import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { useToolReadings } from './_helpers/tool-readings.js';
import { createWriteTool } from '../sdk/src/platform/tools/write/index.js';
import { FileUndoManager } from '../sdk/src/platform/state/file-undo.js';

useToolReadings();
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'write-atomic-failure-')); roots.push(root);
  writeFileSync(join(root, 'first.txt'), 'first original\n');
  writeFileSync(join(root, 'second.txt'), 'second original\n');
  const undo = new FileUndoManager();
  const kept = join(root, 'history-kept.txt');
  writeFileSync(kept, 'kept after');
  undo.snapshot({ path: kept, beforeContent: 'kept before', afterContent: 'kept after', tool: 'write' });
  const history = join(root, 'history.txt');
  writeFileSync(history, 'after');
  undo.snapshot({ path: history, beforeContent: 'before', afterContent: 'after', tool: 'write' });
  undo.undo();
  const changes: string[] = [];
  const tool = createWriteTool({ projectRoot: root, fileUndoManager: undo,
    changeTracker: { recordChange: (path) => { changes.push(path); } } });
  return { root, tool, undo, changes };
}
const first = { path: 'first.txt', content: 'first replacement\n', mode: 'overwrite' };
const second = { path: 'second.txt', content: 'second replacement\n', mode: 'overwrite' };
const blocked = { ...first, mode: 'fail_if_exists' };
function unchanged(f: ReturnType<typeof fixture>) {
  expect(readFileSync(join(f.root, 'first.txt'), 'utf8')).toBe('first original\n');
  expect(readFileSync(join(f.root, 'second.txt'), 'utf8')).toBe('second original\n');
}
function noHistoryEffects(f: ReturnType<typeof fixture>) {
  expect(f.undo.undoDepth()).toBe(1);
  expect(f.undo.redoDepth()).toBe(1);
  expect(f.undo.peekUndo()?.path).toBe(join(f.root, 'history-kept.txt'));
  expect(f.changes).toEqual([]);
}

test('ordinary atomic first fail_if_exists stops before overwriting the next file and preserves history', async () => {
  const f = fixture();
  const result = await f.tool.execute({ files: [blocked, second], transaction: { mode: 'atomic' }, verbosity: 'standard' });
  expect(result.success).toBe(false);
  expect(result.error).toContain('Rolled back 0 file(s)');
  expect(result.output).toBeUndefined();
  unchanged(f); noHistoryEffects(f);
});

for (const failure of [null, { path: '', content: 'invalid' }, { path: 42, content: 'invalid' }, { content: 'missing path' }]) {
  test(`ordinary atomic invalid path ${JSON.stringify(failure)} stops before later effects`, async () => {
    const f = fixture();
    const result = await f.tool.execute({ files: [failure, second], transaction: { mode: 'atomic' } });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Rolled back 0 file(s)');
    unchanged(f); noHistoryEffects(f);
  });
}

test('ordinary atomic invalid entry after a write restores the earlier file and skips later files', async () => {
  const f = fixture();
  const result = await f.tool.execute({ files: [first, { content: 'missing path' }, second], transaction: { mode: 'atomic' } });
  expect(result.success).toBe(false);
  expect(result.error).toContain('Rolled back 1 file(s): first.txt');
  unchanged(f);
  expect(f.changes).toEqual([join(f.root, 'first.txt')]);
  expect(f.undo.undoDepth()).toBe(1); expect(f.undo.redoDepth()).toBe(1);
  expect(f.undo.peekUndo()?.path).toBe(join(f.root, 'history-kept.txt'));
  expect(f.undo.redo()?.path).toBe(join(f.root, 'history.txt'));
  unchanged(f);
});

test('ordinary atomic unsafe snapshot rolls back earlier writes before returning its warning', async () => {
  const f = fixture(); mkdirSync(join(f.root, 'directory'));
  const result = await f.tool.execute({ files: [first, { path: 'directory', content: 'bad', mode: 'overwrite' }, second], transaction: { mode: 'atomic' } });
  expect(result.success).toBe(false);
  expect(result.error).toContain('cannot safely snapshot');
  expect(result.error).toContain('Rolled back 1 file(s): first.txt');
  expect(result.warnings).toHaveLength(1);
  unchanged(f); expect(statSync(join(f.root, 'directory')).isDirectory()).toBe(true);
  expect(f.undo.undoDepth()).toBe(1); expect(f.undo.redoDepth()).toBe(1);
  expect(f.undo.peekUndo()?.path).toBe(join(f.root, 'history-kept.txt'));
});

test('ordinary atomic later write failure restores existing bytes and modes and removes new files once', async () => {
  const f = fixture(); chmodSync(join(f.root, 'first.txt'), 0o640);
  const result = await f.tool.execute({ files: [first, { ...first, content: 'again' }, { path: 'new.txt', content: 'new' }, blocked, second], transaction: { mode: 'atomic' } });
  expect(result.success).toBe(false);
  expect(result.error).toContain('Rolled back 2 file(s): first.txt, new.txt');
  unchanged(f); expect(existsSync(join(f.root, 'new.txt'))).toBe(false);
  expect(statSync(join(f.root, 'first.txt')).mode & 0o777).toBe(0o640);
  expect(f.undo.undoDepth()).toBe(1); expect(f.undo.redoDepth()).toBe(1);
  expect(f.undo.peekUndo()?.path).toBe(join(f.root, 'history-kept.txt'));
});

for (const invalidEntry of [false, true]) {
  test(`ordinary atomic failed dry run preserves every file and history (${invalidEntry ? 'invalid entry' : 'write failure'})`, async () => {
    const f = fixture();
    const before = statSync(join(f.root, 'first.txt'));
    const result = await f.tool.execute({ files: [first, invalidEntry ? { content: 'missing path' } : blocked, second], transaction: { mode: 'atomic' }, dry_run: true });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Rolled back 0 file(s)');
    unchanged(f); noHistoryEffects(f);
    expect(statSync(join(f.root, 'first.txt')).ino).toBe(before.ino);
    expect(statSync(join(f.root, 'first.txt')).mtimeMs).toBe(before.mtimeMs);
  });
}

for (const mode of ['partial', 'none']) {
  test(`ordinary ${mode} still writes later valid files after a first failure`, async () => {
    const f = fixture();
    const result = await f.tool.execute({ files: [blocked, second], transaction: { mode }, verbosity: 'standard' });
    expect(result.success).toBe(false);
    expect(JSON.parse(result.output!)).toMatchObject({ files_written: 1, bytes_written: Buffer.byteLength(second.content), files: [{ path: 'second.txt' }] });
    expect(readFileSync(join(f.root, 'second.txt'), 'utf8')).toBe(second.content);
    expect(f.undo.undoDepth()).toBe(2); expect(f.undo.redoDepth()).toBe(0);
    expect(f.changes).toEqual([join(f.root, 'second.txt')]);
  });
}

test('ordinary successful atomic batch preserves result counts and history', async () => {
  const f = fixture();
  const result = await f.tool.execute({ files: [first, second], transaction: { mode: 'atomic' }, verbosity: 'standard' });
  expect(result.success).toBe(true);
  expect(JSON.parse(result.output!)).toMatchObject({ files_written: 2, bytes_written: Buffer.byteLength(first.content + second.content) });
  expect(readFileSync(join(f.root, 'first.txt'), 'utf8')).toBe(first.content);
  expect(readFileSync(join(f.root, 'second.txt'), 'utf8')).toBe(second.content);
  expect(f.undo.undoDepth()).toBe(3); expect(f.undo.redoDepth()).toBe(0); expect(f.changes).toHaveLength(2);
  expect(f.undo.undo()?.path).toBe(join(f.root, 'second.txt'));
  expect(f.undo.undo()?.path).toBe(join(f.root, 'first.txt'));
  unchanged(f); expect(f.undo.undoDepth()).toBe(1);
});

for (const failure of ['deny', 'throw'] as const) {
  test(`ordinary atomic access ${failure} rolls back earlier writes and skips later files`, async () => {
    const f = fixture();
    const tool = createWriteTool({ projectRoot: f.root, fileUndoManager: f.undo, capturedReadAccess: async (path) => {
      if (path !== join(f.root, 'second.txt')) return true;
      if (failure === 'throw') throw new Error('read access unavailable');
      return false;
    } });
    const result = await tool.execute({ files: [first, second, { path: 'new.txt', content: 'later' }], transaction: { mode: 'atomic' } });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Rolled back 1 file(s): first.txt');
    unchanged(f); expect(existsSync(join(f.root, 'new.txt'))).toBe(false);
    expect(f.undo.undoDepth()).toBe(1); expect(f.undo.redoDepth()).toBe(1);
  expect(f.undo.peekUndo()?.path).toBe(join(f.root, 'history-kept.txt'));
  });
}

test('ordinary atomic null entry after a write rolls back before any later effects', async () => {
  const f = fixture();
  const result = await f.tool.execute({ files: [first, null, second], transaction: { mode: 'atomic' } });
  expect(result.success).toBe(false);
  expect(result.error).toContain('Rolled back 1 file(s): first.txt');
  unchanged(f);
  expect(f.undo.undoDepth()).toBe(1); expect(f.undo.redoDepth()).toBe(1);
  expect(f.undo.peekUndo()?.path).toBe(join(f.root, 'history-kept.txt'));
});

test('ordinary atomic rollback restores exact original non-UTF-8 bytes', async () => {
  const f = fixture();
  const bytes = Buffer.from([0, 255, 254, 128, 195, 40, 13, 10]);
  writeFileSync(join(f.root, 'first.txt'), bytes);
  const result = await f.tool.execute({ files: [first, { ...second, mode: 'fail_if_exists' }], transaction: { mode: 'atomic' } });
  expect(result.success).toBe(false);
  expect(result.error).toContain('Rolled back 1 file(s): first.txt');
  expect(readFileSync(join(f.root, 'first.txt'))).toEqual(bytes);
  expect(f.undo.undoDepth()).toBe(1); expect(f.undo.redoDepth()).toBe(1);
  expect(f.undo.peekUndo()?.path).toBe(join(f.root, 'history-kept.txt'));
  expect(readFileSync(join(f.root, 'second.txt'), 'utf8')).toBe('second original\n');
});

for (const failure of [
  { path: 'bad.txt', content: 'bad', encoding: 'invalid' },
  { path: '../outside.txt', content: 'bad' },
  { path: 'bad.ipynb', content: 'not JSON' },
]) {
  test(`ordinary atomic first failure at ${failure.path} never runs later writes or post-write hooks`, async () => {
    const f = fixture(); const hooks: string[] = [];
    const tool = createWriteTool({ projectRoot: f.root, fileUndoManager: f.undo,
      validatorRunner: async () => { hooks.push('validate'); throw new Error('must not run'); },
      diagnosticsProvider: { name: 'test', supports: () => true, collect: async () => { hooks.push('diagnostics'); return []; } },
    });
    const result = await tool.execute({ files: [failure, second], transaction: { mode: 'atomic' }, validate: { after: ['test'] } });
    expect(result.success).toBe(false); expect(result.error).toContain('Rolled back 0 file(s)');
    unchanged(f); noHistoryEffects(f); expect(hooks).toEqual([]);
    expect(existsSync(join(f.root, 'bad.txt'))).toBe(false);
    expect(existsSync(join(f.root, 'bad.ipynb'))).toBe(false);
  });
}

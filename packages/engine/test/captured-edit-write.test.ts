import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureContractInput, contractInputPath, materializeContractInput } from '../sdk/src/platform/contract/input-snapshot.js';
import { createContractInputAuthority, revokeContractInputAuthority } from '../sdk/src/platform/contract/input-authority.js';
import type { Contract } from '../sdk/src/platform/contract/types.js';
import { capturedInputReadFilter, capturedInputTool } from '../sdk/src/platform/tools/shared/captured-input-tools.js';
import { createEditTool } from '../sdk/src/platform/tools/edit/index.js';
import { createWriteTool } from '../sdk/src/platform/tools/write/index.js';
import { FileStateCache } from '../sdk/src/platform/state/file-cache.js';
import type { ReadAccessFilter } from '../sdk/src/platform/tools/shared/read-access.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function git(root: string, ...args: string[]) {
  const result = spawnSync('git', ['-C', root, ...args]);
  if (result.status !== 0) throw new Error(result.stderr.toString());
}
const notebook = JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [
  { cell_type: 'code', id: 'first', source: ['old\n'], metadata: {}, outputs: [{ output_type: 'stream', text: 'old output' }], execution_count: 1 },
  { cell_type: 'markdown', id: 'second', source: ['remove'], metadata: {} },
] });
async function fixture(mutable = true) {
  const owner = mkdtempSync(join(tmpdir(), 'captured-edit-write-')); roots.push(owner);
  git(owner, 'init', '-q'); git(owner, 'config', 'user.name', 'Fixture'); git(owner, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(owner, '.gitignore'), '.goodvibes/\n');
  writeFileSync(join(owner, 'book.ipynb'), notebook); writeFileSync(join(owner, 'source.txt'), 'original source');
  git(owner, 'add', '.'); git(owner, 'commit', '-qm', 'fixture');
  const inputSnapshot = await captureContractInput(owner); const root = contractInputPath(inputSnapshot);
  const branch = `input/${inputSnapshot.id}`;
  git(owner, 'worktree', 'add', '--no-checkout', '-b', branch, root, inputSnapshot.inputCommit);
  await materializeContractInput(inputSnapshot, root);
  const signal = new AbortController();
  const authority = await createContractInputAuthority({ projectRoot: owner, inputSnapshot } as Contract, root, { mutable, branch, signal: signal.signal });
  const fileCache = new FileStateCache();
  const tools = (filter: ReadAccessFilter = async () => true) => {
    const read = capturedInputReadFilter(authority, root, filter, signal.signal, new Set());
    return {
      edit: capturedInputTool(createEditTool(fileCache, { cwd: root }), authority, root, filter, signal.signal),
      write: capturedInputTool(createWriteTool({ projectRoot: root, fileCache, capturedReadAccess: read }), authority, root, filter, signal.signal),
    };
  };
  return { owner, root, authority, signal, fileCache, tools };
}
const notebookEdit = () => ({ notebook_operations: { path: 'book.ipynb', operations: [
  { op: 'replace', cell_id: 'first', source: 'new\n', clear_outputs: true },
  { op: 'insert', cell_id: 'first', source: 'inserted', cell_type: 'markdown' },
  { op: 'delete', cell_id: 'second' },
] }, output: { format: 'with_diff' } });

test('captured notebook reuses replace/insert/delete, ids, output clearing and diff', async () => {
  const f = await fixture();
  const result = await f.tools().edit.execute(notebookEdit());
  expect(result.success).toBe(true); expect(result.output).toContain('Notebook operations applied: 3');
  const updated = JSON.parse(readFileSync(join(f.root, 'book.ipynb'), 'utf8'));
  expect(updated.cells).toHaveLength(2); expect(updated.cells[0].source).toEqual(['new\n', '']);
  expect(updated.cells[0].outputs).toEqual([]); expect(updated.cells[0].execution_count).toBeNull();
  expect(updated.cells[1].id).toBeString(); expect(updated.cells[1].source).toEqual(['inserted']);
  expect(readFileSync(join(f.owner, 'book.ipynb'), 'utf8')).toBe(notebook);
});

test('captured notebook dry run and immutable planner never write', async () => {
  const f = await fixture();
  expect((await f.tools().edit.execute({ ...notebookEdit(), dry_run: true })).success).toBe(true);
  expect(readFileSync(join(f.root, 'book.ipynb'), 'utf8')).toBe(notebook);
  const immutable = await fixture(false);
  expect((await immutable.tools().edit.execute(notebookEdit())).success).toBe(false);
  expect(readFileSync(join(immutable.root, 'book.ipynb'), 'utf8')).toBe(notebook);
});

for (const side of ['original', 'copy'] as const)
  test(`captured notebook denied ${side} cannot read, diff or write`, async () => {
    const f = await fixture();
    const filter: ReadAccessFilter = async (path) => path !== join(side === 'original' ? f.owner : f.root, 'book.ipynb');
    const result = await f.tools(filter).edit.execute(notebookEdit());
    expect(result.success).toBe(false); expect(result.output).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('old output');
    expect(readFileSync(join(f.root, 'book.ipynb'), 'utf8')).toBe(notebook);
  });

for (const interruption of ['abort', 'revoke', 'per-call abort'] as const)
  test(`captured notebook ${interruption} during permission prevents effects`, async () => {
    const f = await fixture(); const call = new AbortController();
    const filter: ReadAccessFilter = async () => {
      await Promise.resolve();
      if (interruption === 'abort') f.signal.abort();
      else if (interruption === 'revoke') revokeContractInputAuthority(f.authority);
      else call.abort();
      return true;
    };
    const result = await f.tools(filter).edit.execute(notebookEdit(), { signal: call.signal });
    expect(result.success).toBe(false); expect(result.output).toBeUndefined();
    expect(readFileSync(join(f.root, 'book.ipynb'), 'utf8')).toBe(notebook);
  });

test('captured notebook rechecks permission before publication and rejects aliases', async () => {
  const f = await fixture(); let reads = 0;
  const result = await f.tools(async (path) => path !== join(f.owner, 'book.ipynb') || ++reads < 2).edit.execute(notebookEdit());
  expect(result.success).toBe(false); expect(readFileSync(join(f.root, 'book.ipynb'), 'utf8')).toBe(notebook);
  rmSync(join(f.root, 'book.ipynb')); symlinkSync(join(f.owner, 'book.ipynb'), join(f.root, 'book.ipynb'));
  expect((await f.tools().edit.execute(notebookEdit())).success).toBe(false);
  expect(readFileSync(join(f.owner, 'book.ipynb'), 'utf8')).toBe(notebook);
});

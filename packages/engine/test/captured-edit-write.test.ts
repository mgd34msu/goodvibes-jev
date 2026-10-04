import { useToolReadings } from './_helpers/tool-readings.js';
useToolReadings();
import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureContractInput, contractInputPath, materializeContractInput } from '../sdk/src/platform/contract/input-snapshot.js';
import { createContractInputAuthority, revokeContractInputAuthority } from '../sdk/src/platform/contract/input-authority.js';
import type { Contract } from '../sdk/src/platform/contract/types.js';
import { capturedInputReadFilter, capturedInputTool } from '../sdk/src/platform/tools/shared/captured-input-tools.js';
import { createEditTool } from '../sdk/src/platform/tools/edit/index.js';
import { createCapturedValidatorRunner } from '../sdk/src/platform/tools/shared/captured-validators.js';
import { probeCapturedExecAvailability } from '../sdk/src/platform/tools/exec/captured-exec.js';
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
    const validatorRunner = createCapturedValidatorRunner({ authority, root, readAccessFilter: filter, signal: signal.signal });
    const read = capturedInputReadFilter(authority, root, filter, signal.signal, new Set());
    return {
      edit: capturedInputTool(createEditTool(fileCache, { cwd: root, validatorRunner }), authority, root, filter, signal.signal),
      write: capturedInputTool(createWriteTool({ projectRoot: root, fileCache, capturedReadAccess: read, validatorRunner }), authority, root, filter, signal.signal),
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

const containment = await probeCapturedExecAvailability();
const supported = containment.available;
test('required captured validator proof cannot skip containment', () => {
  if (process.env.GOODVIBES_TEST_REQUIRE_EXEC_CONTAINMENT !== undefined) {
    expect(process.env.GOODVIBES_TEST_REQUIRE_EXEC_CONTAINMENT).toBe('1');
    expect(supported).toBe(true);
  }
});

test.skipIf(!supported)('captured write build validator publishes through its owned lock and preserves source isolation', async () => {
  const f = await fixture();
  writeFileSync(join(f.root, 'package.json'), JSON.stringify({ scripts: { build: 'bun -e "const fs=require(\'fs\');fs.writeFileSync(\'build.txt\',fs.readFileSync(\'source.txt\'))"' } }));
  const result = await f.tools().write.execute({ files: [{ path: 'source.txt', content: 'validated member', mode: 'overwrite' }], validate: { after: ['build'] } });
  expect(result.success).toBe(true);
  expect(JSON.parse(result.output!).validation_passed).toBe(true);
  expect(readFileSync(join(f.root, 'build.txt'), 'utf8')).toBe('validated member');
  expect(readFileSync(join(f.owner, 'source.txt'), 'utf8')).toBe('original source');
  expect(existsSync(join(f.owner, 'build.txt'))).toBe(false);
});

test.skipIf(!supported)('captured edit before/after validators reuse test command and atomic rollback', async () => {
  const f = await fixture();
  writeFileSync(join(f.root, 'source.test.ts'), 'import {test,expect} from "bun:test";test("original",()=>expect(require("fs").readFileSync("source.txt","utf8")).toBe("original source"));');
  const result = await f.tools().edit.execute({ edits: [{ path: 'source.txt', find: 'original', replace: 'changed' }], validate: { before: ['test'], after: ['test'] } });
  expect(result.success).toBe(false); expect(result.error).toContain('Post-edit validation failed, edits rolled back');
  expect(readFileSync(join(f.root, 'source.txt'), 'utf8')).toBe('original source');
});

test.skipIf(!supported)('captured failed pre-edit validator has no edit effects and cannot see denied inputs', async () => {
  const f = await fixture();
  writeFileSync(join(f.root, 'source.test.ts'), 'import {test,expect} from "bun:test";test("fail before",()=>{expect(require("fs").existsSync("private.txt")).toBe(false);throw Error("EXPECTED_FAILURE")});');
  writeFileSync(join(f.root, 'private.txt'), 'HIDDEN_VALIDATOR_INPUT');
  const result = await f.tools(async (path) => !path.endsWith('/private.txt')).edit.execute({ edits: [{ path: 'source.txt', find: 'original', replace: 'changed' }], validate: { before: ['test'] } });
  expect(result.success).toBe(false); expect(result.error).toContain('Pre-edit validation failed');
  expect(JSON.stringify(result)).not.toContain('HIDDEN_VALIDATOR_INPUT');
  expect(readFileSync(join(f.root, 'source.txt'), 'utf8')).toBe('original source');
});


test('captured write backup keeps original bytes in one generated member-only artifact', async () => {
  const f = await fixture();
  const result = await f.tools().write.execute({ files: [{ path: 'source.txt', content: 'replacement', mode: 'backup' }], verbosity: 'standard' });
  expect(result.success).toBe(true);
  const path = JSON.parse(result.output!).files[0].backup_path;
  expect(path).toStartWith(join(f.root, '.goodvibes', '.backups', 'source.txt.'));
  expect(readFileSync(path, 'utf8')).toBe('original source');
  expect(readFileSync(join(f.root, 'source.txt'), 'utf8')).toBe('replacement');
  expect(readFileSync(join(f.owner, 'source.txt'), 'utf8')).toBe('original source');
  expect(existsSync(join(f.owner, '.goodvibes', '.backups'))).toBe(false);
});

test('captured backup dry run and atomic bad-entry preflight have zero file effects', async () => {
  const f = await fixture();
  const dry = await f.tools().write.execute({ files: [{ path: 'source.txt', content: 'replacement', mode: 'backup' }], dry_run: true, verbosity: 'standard' });
  expect(dry.success).toBe(true); expect(existsSync(JSON.parse(dry.output!).files[0].backup_path)).toBe(false);
  expect(existsSync(join(f.root, '.goodvibes', '.backups'))).toBe(false);
  const failed = await f.tools().write.execute({ files: [{ path: 'source.txt', content: 'replacement', mode: 'backup' }, { path: 'book.ipynb', content: 'invalid', mode: 'overwrite' }], transaction: { mode: 'atomic' } });
  expect(failed.success).toBe(false); expect(readFileSync(join(f.root, 'source.txt'), 'utf8')).toBe('original source');
  expect(existsSync(join(f.root, '.goodvibes', '.backups'))).toBe(false);
});

for (const side of ['original', 'copy'] as const)
  test(`captured backup ${side} destination denial and atomic later-path denial prevent all effects`, async () => {
    const f = await fixture(); const base = side === 'original' ? f.owner : f.root;
    const blocked = await f.tools(async (path) => !path.startsWith(join(base, '.goodvibes', '.backups'))).write.execute({ files: [{ path: 'source.txt', content: 'replacement', mode: 'backup' }] });
    expect(blocked.success).toBe(false); expect(readFileSync(join(f.root, 'source.txt'), 'utf8')).toBe('original source');
    expect(existsSync(join(f.root, '.goodvibes', '.backups'))).toBe(false);
    const atomic = await f.tools(async (path) => path !== join(base, 'denied.txt')).write.execute({ files: [{ path: 'new.txt', content: 'new' }, { path: 'denied.txt', content: 'denied' }], transaction: { mode: 'atomic' } });
    expect(atomic.success).toBe(false); expect(existsSync(join(f.root, 'new.txt'))).toBe(false); expect(existsSync(join(f.root, 'denied.txt'))).toBe(false);
  });

test('captured atomic successful batch and failed filesystem publication preserve exact rollback bytes', async () => {
  const f = await fixture();
  const success = await f.tools().write.execute({ files: [{ path: 'source.txt', content: 'first', mode: 'backup' }, { path: 'created.txt', content: 'second' }], transaction: { mode: 'atomic' } });
  expect(success.success).toBe(true); expect(readFileSync(join(f.root, 'created.txt'), 'utf8')).toBe('second');
  const bytes = Buffer.from([255, 0, 128, 1]); writeFileSync(join(f.root, 'binary.dat'), bytes);
  mkdirSync(join(f.root, 'locked')); writeFileSync(join(f.root, 'locked/target.txt'), 'locked'); chmodSync(join(f.root, 'locked'), 0o555);
  try {
    const failure = await f.tools().write.execute({ files: [{ path: 'binary.dat', content: 'changed', mode: 'overwrite' }, { path: 'temporary.txt', content: 'new' }, { path: 'locked/target.txt', content: 'unwritable', mode: 'overwrite' }], transaction: { mode: 'atomic' } });
    expect(failure.success).toBe(false); expect(failure.error).toContain('Rolled back 2 file(s)');
    expect(readFileSync(join(f.root, 'binary.dat'))).toEqual(bytes); expect(existsSync(join(f.root, 'temporary.txt'))).toBe(false);
  } finally { chmodSync(join(f.root, 'locked'), 0o755); }
});

test.skipIf(!supported)('contained validator and competing write remain serialized', async () => {
  const f = await fixture();
  writeFileSync(join(f.root, 'package.json'), JSON.stringify({ scripts: { build: 'sleep 0.3; cp source.txt validated.txt' } }));
  const { write } = f.tools();
  const first = write.execute({ files: [{ path: 'source.txt', content: 'first', mode: 'overwrite' }], validate: { after: ['build'] } });
  const second = write.execute({ files: [{ path: 'source.txt', content: 'second', mode: 'overwrite' }] });
  const results = await Promise.all([first, second]);
  expect(results.every((result) => result.success)).toBe(true);
  expect(readFileSync(join(f.root, 'validated.txt'), 'utf8')).toBe('first');
  expect(readFileSync(join(f.root, 'source.txt'), 'utf8')).toBe('second');
});

for (const interruption of ['abort', 'revoke', 'permission'] as const)
  test.skipIf(!supported)(`captured embedded validator ${interruption} withholds late diagnostics and publication`, async () => {
    const f = await fixture(); let allowed = true;
    writeFileSync(join(f.root, 'package.json'), JSON.stringify({ scripts: { build: 'echo HIDDEN_DELAYED_DIAGNOSTIC; sleep 1; echo late > late.txt' } }));
    const call = new AbortController();
    const pending = f.tools(async () => allowed).write.execute({ files: [{ path: 'source.txt', content: 'first', mode: 'overwrite' }], validate: { after: ['build'] } }, { signal: call.signal });
    setTimeout(() => {
      if (interruption === 'abort') call.abort();
      else if (interruption === 'revoke') revokeContractInputAuthority(f.authority);
      else allowed = false;
    }, 400);
    const result = await pending;
    expect(result.success).toBe(false); expect(JSON.stringify(result)).not.toContain('HIDDEN_DELAYED_DIAGNOSTIC');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(existsSync(join(f.root, 'late.txt'))).toBe(false); expect(existsSync(join(f.owner, 'late.txt'))).toBe(false);
  });

test.skipIf(!supported)('npx-backed validators report the actual contained runtime result without host fallback', async () => {
  const f = await fixture();
  const result = await f.tools().write.execute({ files: [{ path: 'source.txt', content: 'changed', mode: 'overwrite' }], validate: { after: ['typecheck', 'lint'] } });
  const output = JSON.parse(result.output!);
  // This host has npx only in its private runtime directory, outside the
  // executor's admitted system/Bun mounts. A real process must report that
  // dependency absence, never run the host package manager or claim success.
  if (!existsSync('/usr/bin/npx') && !existsSync('/bin/npx')) {
    expect(output.validation_failures).toHaveLength(2);
    expect(output.validation_failures.every((failure: { exit_code: number; stderr: string }) => failure.exit_code === 127 && failure.stderr.includes('npx'))).toBe(true);
    expect(output.validation_passed).toBeUndefined();
  } else {
    expect(output.validation_passed === true || Array.isArray(output.validation_failures)).toBe(true);
  }
});

import { publishWithinCapturedLease, withCapturedPublication, type CapturedPublicationLease } from '../sdk/src/platform/tools/shared/captured-publication.js';
test('validator publication lease rejects copied, wrong-owner, concurrent and expired callbacks', async () => {
  const f = await fixture(); const other = await fixture(); let retained!: CapturedPublicationLease;
  await withCapturedPublication(f.authority, async (lease) => {
    retained = lease;
    await expect(publishWithinCapturedLease({ ...lease }, f.authority, async () => {})).rejects.toThrow();
    await expect(publishWithinCapturedLease(lease, other.authority, async () => {})).rejects.toThrow();
    let finish!: () => void;
    const first = publishWithinCapturedLease(lease, f.authority, async () => { await new Promise<void>((resolve) => { finish = resolve; }); });
    await expect(publishWithinCapturedLease(lease, f.authority, async () => {})).rejects.toThrow();
    while (!finish) await new Promise((resolve) => setTimeout(resolve, 1));
    finish(); await first;
  });
  await expect(publishWithinCapturedLease(retained, f.authority, async () => {})).rejects.toThrow();
});

test('a settled publication owner drains and invalidates an in-flight borrowed callback before releasing the next writer', async () => {
  const f = await fixture(); let finish!: () => void; let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  let borrowed!: Promise<void>; let published = false; let next = false;
  const owner = withCapturedPublication(f.authority, async (lease) => {
    borrowed = publishWithinCapturedLease(lease, f.authority, async (assertCurrent) => {
      entered(); await new Promise<void>((resolve) => { finish = resolve; }); assertCurrent(); published = true;
    });
    void borrowed.catch(() => {});
    await ready;
  });
  await ready;
  const subsequent = withCapturedPublication(f.authority, async () => { next = true; });
  await new Promise((resolve) => setTimeout(resolve, 10)); expect(next).toBe(false);
  finish(); await expect(borrowed).rejects.toThrow('settled'); await owner; await subsequent;
  expect(published).toBe(false); expect(next).toBe(true);
});

test.skipIf(!supported)('captured validators retain configured network denial instead of granting sockets', async () => {
  const f = await fixture();
  writeFileSync(join(f.root, 'package.json'), JSON.stringify({ scripts: { build: 'bun network-check.ts' } }));
  writeFileSync(join(f.root, 'network-check.ts'), 'try { Bun.listen({hostname:"127.0.0.1",port:0,socket:{data(){}}}); process.exit(4); } catch { console.log("NETWORK_DISABLED"); }');
  const filter: ReadAccessFilter = async () => true;
  const validatorRunner = createCapturedValidatorRunner({ authority: f.authority, root: f.root, readAccessFilter: filter }, { sandbox: {
    config: { enabled: true, egressAllowlist: [], workspaceWritable: [] },
    featureEnabled: true,
    availability: { available: true, backend: 'bubblewrap', bwrapPath: '/usr/bin/bwrap', networkIsolationGuaranteed: true, reason: 'test host' },
  } });
  const tool = capturedInputTool(createWriteTool({ projectRoot: f.root, validatorRunner }), f.authority, f.root, filter, undefined);
  const result = await tool.execute({ files: [{ path: 'source.txt', content: 'network checked', mode: 'overwrite' }], validate: { after: ['build'] } });
  expect(result.success).toBe(true); expect(JSON.parse(result.output!).validation_passed).toBe(true);
});

test('captured validator command names cannot select arbitrary commands or fall back to host spawn', async () => {
  const f = await fixture();
  const result = await f.tools().write.execute({ files: [{ path: 'source.txt', content: 'new', mode: 'overwrite' }], validate: { after: ['bun -e "throw Error(123)"'] } });
  expect(JSON.parse(result.output!).validation_error).toContain('Unsupported validator');
  const unbound = capturedInputTool(createWriteTool({ projectRoot: f.root }), f.authority, f.root, async () => true, undefined);
  const held = await unbound.execute({ files: [{ path: 'source.txt', content: 'newer', mode: 'overwrite' }], validate: { after: ['build'] } });
  expect(JSON.parse(held.output!).validation_error).toContain('construction-owned contained runner');
});

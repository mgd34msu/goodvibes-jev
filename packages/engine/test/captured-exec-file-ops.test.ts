import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { authorizeContractInputPath, createContractInputAuthority, revokeContractInputAuthority } from '../sdk/src/platform/contract/input-authority.js';
import { captureContractInput, contractInputPath, materializeContractInput } from '../sdk/src/platform/contract/input-snapshot.js';
import type { Contract } from '../sdk/src/platform/contract/types.js';
import { executeCapturedFileOperations } from '../sdk/src/platform/tools/exec/captured-exec-file-ops.js';
import type { ExecFileOp } from '../sdk/src/platform/tools/exec/schema.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(files: Record<string, string> = { 'input.txt': 'SYNTHETIC_INPUT' }) {
  const temporary = mkdtempSync(join(tmpdir(), 'captured-file-ops-'));
  roots.push(temporary);
  const root = join(temporary, 'captured');
  const projection = join(temporary, 'projection');
  mkdirSync(root);
  for (const [path, data] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), data);
  }
  cpSync(root, projection, { recursive: true });
  const authorized: string[] = [];
  const authorize = async (path: string) => { authorized.push(path); return path; };
  return { temporary, root, projection, authorized, authorize };
}

for (const absolute of [false, true]) {
  test(`captured ${absolute ? 'absolute' : 'relative'} copy, move and delete stay in projection`, async () => {
    const f = fixture();
    const path = (name: string) => absolute ? join(f.root, name) : name;
    const result = await executeCapturedFileOperations(f.root, f.projection, [
      { op: 'copy', source: path('input.txt'), destination: path('copy.txt') },
      { op: 'move', source: path('copy.txt'), destination: path('moved.txt') },
      { op: 'delete', source: path('input.txt') },
    ], f.authorize);
    expect(result.fileOpError).toBeUndefined();
    expect(result.fileOpResults).toEqual([
      { op: 'copy', source: join(f.root, 'input.txt'), destination: join(f.root, 'copy.txt') },
      { op: 'move', source: join(f.root, 'copy.txt'), destination: join(f.root, 'moved.txt') },
      { op: 'delete', source: join(f.root, 'input.txt') },
    ]);
    expect(readFileSync(join(f.projection, 'moved.txt'), 'utf8')).toBe('SYNTHETIC_INPUT');
    expect(existsSync(join(f.projection, 'input.txt'))).toBe(false);
    expect(readFileSync(join(f.root, 'input.txt'), 'utf8')).toBe('SYNTHETIC_INPUT');
    expect(existsSync(join(f.root, 'moved.txt'))).toBe(false);
    expect(f.authorized.every((entry) => entry.startsWith(`${f.root}/`))).toBe(true);
  });
}

test('recursive copies authorize generated descendants and delete previews retain captured paths', async () => {
  const f = fixture({ 'src/nested/file.txt': 'SYNTHETIC_NESTED' });
  const result = await executeCapturedFileOperations(f.root, f.projection, [
    { op: 'copy', source: 'src', destination: 'copy', recursive: true },
    { op: 'delete', source: 'copy', dry_run: true },
    { op: 'delete', source: 'copy', recursive: true },
  ], f.authorize);
  expect(result.fileOpError).toBeUndefined();
  expect(result.fileOpResults[1]?.would_delete).toEqual([join(f.root, 'copy/nested/file.txt')]);
  expect(f.authorized).toContain(join(f.root, 'copy/nested/file.txt'));
  expect(f.authorized).toContain(join(f.root, 'src/nested/file.txt'));
  expect(existsSync(join(f.projection, 'copy'))).toBe(false);
  expect(readFileSync(join(f.root, 'src/nested/file.txt'), 'utf8')).toBe('SYNTHETIC_NESTED');
});

test('overwrite rules, missing-file warnings and operation errors preserve existing semantics', async () => {
  const f = fixture({ 'input.txt': 'SYNTHETIC_INPUT', 'copy.txt': 'SYNTHETIC_OLD' });
  const blocked = await executeCapturedFileOperations(f.root, f.projection, [
    { op: 'copy', source: 'input.txt', destination: 'copy.txt' },
  ], f.authorize);
  expect(blocked.fileOpError).toContain('destination already exists');
  expect(blocked.fileOpError).not.toContain(f.projection);
  expect(readFileSync(join(f.projection, 'copy.txt'), 'utf8')).toBe('SYNTHETIC_OLD');
  const result = await executeCapturedFileOperations(f.root, f.projection, [
    { op: 'copy', source: 'input.txt', destination: 'copy.txt', overwrite: true },
    { op: 'delete', source: 'missing.txt', dry_run: true },
  ], f.authorize);
  expect(readFileSync(join(f.projection, 'copy.txt'), 'utf8')).toBe('SYNTHETIC_INPUT');
  expect(result.fileOpResults[1]?.would_delete).toEqual([join(f.root, 'missing.txt')]);
  expect(result.fileOpWarnings?.[0]).toContain(join(f.root, 'missing.txt'));
  expect(JSON.stringify(result)).not.toContain(f.projection);
  expect(readFileSync(join(f.root, 'copy.txt'), 'utf8')).toBe('SYNTHETIC_OLD');
});

test('move import rewrites run after all operations and return captured paths', async () => {
  const f = fixture({
    'src/value.ts': 'export const value = 42;\n',
    'src/use.ts': 'import { value } from "./value"; const loaded = require("./value");\n',
  });
  const result = await executeCapturedFileOperations(f.root, f.projection, [
    { op: 'move', source: 'src/value.ts', destination: 'src/renamed.ts', update_imports: true },
    { op: 'copy', source: 'src/use.ts', destination: 'src/copied.ts' },
  ], f.authorize);
  expect(result.fileOpError).toBeUndefined();
  expect(result.fileOpResults[0]?.updated_imports?.sort()).toEqual([
    join(f.root, 'src/copied.ts'), join(f.root, 'src/use.ts'),
  ]);
  for (const path of ['src/use.ts', 'src/copied.ts']) {
    expect(readFileSync(join(f.projection, path), 'utf8')).toContain('from "./renamed"');
    expect(readFileSync(join(f.projection, path), 'utf8')).toContain('require("./renamed")');
    expect(f.authorized).toContain(join(f.root, path));
  }
  expect(readFileSync(join(f.root, 'src/use.ts'), 'utf8')).toContain('from "./value"');
});

for (const side of ['source', 'destination'] as const) {
  for (const path of ['../outside.txt', '.aws/credentials', '.git/config', '.goodvibes/runtime']) {
    test(`rejects ${side} outside/excluded path ${path}`, async () => {
      const f = fixture();
      const op: ExecFileOp = { op: 'copy', source: 'input.txt', destination: 'copy.txt', [side]: path };
      await expect(executeCapturedFileOperations(f.root, f.projection, [op], f.authorize)).rejects.toThrow();
      expect(existsSync(join(f.projection, 'copy.txt'))).toBe(false);
    });
  }
}

for (const location of ['source', 'destination', 'nested', 'imports', 'hardlink'] as const) {
  test(`rejects a projected ${location} alias before operating on host data`, async () => {
    const f = fixture({ 'src/input.ts': 'SYNTHETIC_INPUT' });
    const outside = join(f.temporary, 'outside.ts');
    writeFileSync(outside, 'SYNTHETIC_OUTSIDE');
    let op: ExecFileOp = { op: 'copy', source: 'src/input.ts', destination: 'copy.ts', overwrite: true };
    if (location === 'hardlink') linkSync(outside, join(f.projection, 'copy.ts'));
    else if (location === 'source') { symlinkSync(outside, join(f.projection, 'alias')); op.source = 'alias'; }
    else if (location === 'destination') symlinkSync(f.temporary, join(f.projection, 'alias'));
    else if (location === 'nested') {
      symlinkSync(outside, join(f.projection, 'src/alias'));
      op = { op: 'delete', source: 'src', recursive: true };
    } else {
      symlinkSync(outside, join(f.projection, 'alias.ts'));
      op = { op: 'move', source: 'src/input.ts', destination: 'src/moved.ts', update_imports: true };
    }
    if (location === 'destination') op.destination = 'alias/outside.ts';
    await expect(executeCapturedFileOperations(f.root, f.projection, [op], f.authorize)).rejects.toThrow();
    expect(readFileSync(outside, 'utf8')).toBe('SYNTHETIC_OUTSIDE');
    expect(readFileSync(join(f.root, 'src/input.ts'), 'utf8')).toBe('SYNTHETIC_INPUT');
  });
}

test('recursive destination authorization fails before any projected copy', async () => {
  const f = fixture({ 'src/nested/file.txt': 'SYNTHETIC_INPUT' });
  await expect(executeCapturedFileOperations(f.root, f.projection, [
    { op: 'copy', source: 'src', destination: 'copy', recursive: true },
  ], async (path) => {
    if (path === join(f.root, 'copy/nested/file.txt')) throw new Error('denied synthetic destination');
    return path;
  })).rejects.toThrow('denied synthetic destination');
  expect(existsSync(join(f.projection, 'copy'))).toBe(false);
});

test('later authority callbacks cannot redirect a previously checked source', async () => {
  const f = fixture();
  const outside = join(f.temporary, 'outside.txt');
  writeFileSync(outside, 'SYNTHETIC_OUTSIDE');
  await expect(executeCapturedFileOperations(f.root, f.projection, [
    { op: 'copy', source: 'input.txt', destination: 'copy.txt' },
  ], async (path) => {
    if (path === join(f.root, 'copy.txt') && !existsSync(join(f.projection, 'redirected'))) {
      rmSync(join(f.projection, 'input.txt'));
      symlinkSync(outside, join(f.projection, 'input.txt'));
      writeFileSync(join(f.projection, 'redirected'), 'synthetic marker');
    }
    return path;
  })).rejects.toThrow('alias');
  expect(existsSync(join(f.projection, 'copy.txt'))).toBe(false);
});

test('new unvalidated import-scan entries introduced during authorization are rejected', async () => {
  const f = fixture({ 'value.ts': 'SYNTHETIC_VALUE', 'use.ts': 'import { value } from "./value";' });
  const outside = join(f.temporary, 'outside.ts');
  writeFileSync(outside, 'import { value } from "./value";');
  await expect(executeCapturedFileOperations(f.root, f.projection, [
    { op: 'move', source: 'value.ts', destination: 'renamed.ts', update_imports: true },
  ], async (path) => {
    if (path === join(f.root, 'use.ts')) symlinkSync(outside, join(f.projection, 'late.ts'));
    return path;
  })).rejects.toThrow('tree changed');
  expect(readFileSync(outside, 'utf8')).toBe('import { value } from "./value";');
});

test('import-scan authority failures propagate instead of becoming warnings', async () => {
  const f = fixture({ 'value.ts': 'SYNTHETIC_VALUE', 'use.ts': 'import "./value";' });
  await expect(executeCapturedFileOperations(f.root, f.projection, [
    { op: 'move', source: 'value.ts', destination: 'renamed.ts', update_imports: true },
  ], async (path) => {
    if (path === join(f.root, 'use.ts')) throw new Error('denied synthetic importer');
    return path;
  })).rejects.toThrow('denied synthetic importer');
  expect(readFileSync(join(f.projection, 'use.ts'), 'utf8')).toBe('import "./value";');
  expect(existsSync(join(f.root, 'value.ts'))).toBe(true);
});

test('rejects direct original execution, redirected projection and redirected authorization', async () => {
  const f = fixture();
  const ops: ExecFileOp[] = [{ op: 'delete', source: 'input.txt' }];
  await expect(executeCapturedFileOperations(f.root, f.root, ops, f.authorize)).rejects.toThrow();
  const alias = join(f.temporary, 'projection-alias');
  symlinkSync(f.projection, alias);
  await expect(executeCapturedFileOperations(f.root, alias, ops, f.authorize)).rejects.toThrow();
  await expect(executeCapturedFileOperations(f.root, f.projection, ops, async () => join(f.temporary, 'outside'))).rejects.toThrow();
  expect(readFileSync(join(f.root, 'input.txt'), 'utf8')).toBe('SYNTHETIC_INPUT');
});

for (const deniedSide of ['original', 'captured', 'revoked'] as const) {
  test(`opaque authority enforces ${deniedSide} restrictions on recursive operations`, async () => {
    const f = fixture({ 'src/nested/file.txt': 'SYNTHETIC_INPUT' });
    const git = (...args: string[]) => {
      const result = spawnSync('git', ['-C', f.root, ...args]);
      if (result.status !== 0) throw new Error(result.stderr.toString());
    };
    git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    git('add', '.'); git('commit', '-qm', 'fixture');
    const inputSnapshot = await captureContractInput(f.root);
    const captured = contractInputPath(inputSnapshot);
    const branch = `input/${inputSnapshot.id}`;
    git('worktree', 'add', '--no-checkout', '-b', branch, captured, inputSnapshot.inputCommit);
    await materializeContractInput(inputSnapshot, captured);
    const authority = await createContractInputAuthority({ projectRoot: f.root, inputSnapshot } as Contract, captured, { mutable: true, branch });
    if (deniedSide === 'revoked') revokeContractInputAuthority(authority);
    const denied = join(deniedSide === 'original' ? f.root : captured, 'src/nested/file.txt');
    await expect(executeCapturedFileOperations(captured, f.projection, [
      { op: 'copy', source: 'src', destination: 'copy', recursive: true },
    ], (path) => authorizeContractInputPath(authority, path, async (candidate) => candidate !== denied))).rejects.toThrow();
    expect(existsSync(join(f.projection, 'copy'))).toBe(false);
    expect(relative(f.root, captured)).toContain('.goodvibes');
  });
}

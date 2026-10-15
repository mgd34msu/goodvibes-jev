import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { DirectoryWalk, walkDir, type WalkDirOptions } from '../sdk/src/platform/utils/walk-dir.ts';
import { collectGlobFiles, findNestedGitignoreFiles } from '../sdk/src/platform/tools/find/shared.ts';
import { collectTextFiles } from '../sdk/src/platform/tools/analyze/shared.ts';

const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function root() { const path = mkdtempSync(join(tmpdir(), 'gv-walk-')); roots.push(path); return path; }
function put(base: string, path: string, content = 'export const value = 1;\n') {
  mkdirSync(dirname(join(base, path)), { recursive: true }); writeFileSync(join(base, path), content);
}
async function files(path: string, options: WalkDirOptions = {}) {
  const result = []; for await (const file of walkDir(path, options)) result.push(relative(path, file)); return result.sort();
}

test('directory discovery and files over 1 MiB require no Jev availability or semantic permission', async () => {
  const path = root(); put(path, 'src/large.ts', 'x'.repeat(1024 * 1024 + 1)); put(path, 'target/source.ts');
  put(path, 'node_modules/package/index.ts'); put(path, '.hidden/source.ts');
  const previous = installJudgmentPort(undefined);
  try {
    expect(await files(path)).toEqual(['src/large.ts', 'target/source.ts']);
    expect(await files(path, { includeHidden: true })).toContain('.hidden/source.ts');
    expect(await files(path, { maxFileSize: 1024 })).toEqual(['target/source.ts']);
    expect(await files(join(path, 'node_modules'))).toEqual(['package/index.ts']);
    expect(await files(path, { selectDirectory: () => true })).toContain('node_modules/package/index.ts');
  } finally { installJudgmentPort(previous); }
});

test('analysis no longer silently stops after 500 source files', async () => {
  const path = root(); for (let i = 0; i < 505; i++) put(path, `src/${i}.ts`);
  expect(await collectTextFiles(path)).toHaveLength(505);
  expect(await collectTextFiles(path, 12)).toHaveLength(12);
});

test('hidden inclusion, literal glob selection and ignore discovery preserve caller scope', async () => {
  const path = root(); put(path, 'src/a.ts'); put(path, 'src/.gitignore', 'ignored.ts'); put(path, 'other/b.ts');
  const walk = new DirectoryWalk(path);
  expect([...await collectGlobFiles(path, ['src/**/*.ts'], false, false, undefined, walk)].map(file => relative(path, file))).toEqual(['src/a.ts']);
  expect(await findNestedGitignoreFiles(path, join(path, '.gitignore'), walk)).toContain(join(path, 'src/.gitignore'));
});

test('no-follow excludes file and directory aliases; following handles cycles', async () => {
  const path = root(); put(path, 'src/a.ts');
  symlinkSync(join(path, 'src'), join(path, 'alias')); symlinkSync(path, join(path, 'src/cycle'));
  symlinkSync(join(path, 'src/a.ts'), join(path, 'copy.ts'));
  expect(await files(path)).toEqual(['src/a.ts']);
  const followed = await files(path, { followSymlinks: true });
  expect(followed).toContain('src/a.ts'); expect(followed.length).toBeLessThan(10);
  expect(await new DirectoryWalk(path).excludesFile(join(path, 'alias/a.ts'))).toBe(true);
});

test('pre-cancelled and revoked traversals cannot deliver successful results', async () => {
  const path = root(); put(path, 'src/a.ts');
  const stop = new AbortController(); stop.abort(new Error('cancelled'));
  await expect(files(path, { signal: stop.signal })).rejects.toThrow('cancelled');
  let checks = 0;
  await expect(files(path, { beforeAttempt() { if (++checks > 3) throw new Error('owner changed'); } })).rejects.toThrow('owner changed');
});

test('full authority checks fence both traversal entry and delivery, including zero matches and early return', async () => {
  const path = root(); put(path, 'src/a.ts');
  for (const selectFile of [undefined, () => false]) {
    let checks = 0;
    await expect(files(path, { ...(selectFile ? { selectFile } : {}), beforeAsyncAttempt: async () => { if (++checks === 2) throw new Error('revoked at delivery'); } })).rejects.toThrow('revoked at delivery');
  }
  let checks = 0;
  const iterator = walkDir(path, { beforeAsyncAttempt: async () => { checks++; } });
  await iterator.next(); await iterator.return(undefined); expect(checks).toBe(2);
});

test('a replaced ancestor cannot redirect a no-follow walk after a yielded file', async () => {
  const path = root(); const outside = root(); put(path, 'src/a.ts'); put(path, 'src/b.ts'); put(outside, 'b.ts', 'private'); put(outside, 'a.ts', 'private');
  const iterator = walkDir(path); await iterator.next();
  renameSync(join(path, 'src'), join(path, 'original')); symlinkSync(outside, join(path, 'src'));
  await expect(iterator.next()).rejects.toThrow('path changed');
});

test('explicit path denial propagates instead of becoming an unreadable-file warning', async () => {
  const path = root(); put(path, 'src/a.ts');
  await expect(files(path, { assertPath(file) { if (file.endsWith('a.ts')) throw new Error('denied'); } })).rejects.toThrow('denied');
});

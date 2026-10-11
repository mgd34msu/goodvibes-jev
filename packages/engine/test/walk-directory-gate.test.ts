import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { JudgmentPort } from '@goodvibes-jev/judgment/decisions';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { WALK_SKIP_DIRS } from '@goodvibes-jev/engine/sdk/platform/utils';
import { DirectoryWalk, WALK_MAX_FILE_SIZE, walkDir, type WalkDirOptions } from '../sdk/src/platform/utils/walk-dir.ts';
import { collectGlobFiles, findNestedGitignoreFiles } from '../sdk/src/platform/tools/find/shared.ts';
import { executeFilesQuery } from '../sdk/src/platform/tools/find/files.ts';
import { createFindTool } from '../sdk/src/platform/tools/find/executor.ts';
import { collectInputFiles, collectTextFiles } from '../sdk/src/platform/tools/analyze/shared.ts';
import { runDependencies } from '../sdk/src/platform/tools/analyze/scan-modes.ts';

type Directory = { id: string; name: string; relativePath: string };
const roots: string[] = [];
let previous: ReturnType<typeof installJudgmentPort>;
let installed = false;
function usePort(port: JudgmentPort | undefined): void {
  if (!installed) { previous = installJudgmentPort(port); installed = true; }
  else installJudgmentPort(port);
}
function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'gv-walk-gate-'));
  roots.push(path);
  return path;
}
function put(root: string, path: string, content = 'export function authored() {}\n'): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}
function directoryPort(answer: (directory: Directory) => unknown = directory => noulAnswer(directory.relativePath === 'target' ? 0.99 : 0.01)) {
  return fakePort((key, _question, state) => {
    const directory = (state as { directories: Directory[] }).directories.find(value => value.id === key)!;
    return answer(directory);
  });
}
async function files(path: string, options: WalkDirOptions = {}): Promise<string[]> {
  const result: string[] = [];
  for await (const file of walkDir(path, options)) result.push(relative(path, file));
  return result.sort();
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function pausePort() {
  const fake = directoryPort();
  const started = deferred();
  const release = deferred();
  const port: JudgmentPort = { ...fake.port, async ask(request) {
    started.resolve();
    await release.promise;
    return fake.port.ask(request);
  } };
  usePort(port);
  return { fake, started, release };
}
afterEach(() => {
  if (installed) installJudgmentPort(previous);
  installed = false;
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

test('canonical gate skips generated target and retains authored src/dist, independent of basename', async () => {
  const path = root();
  put(path, 'target/generated.ts');
  // A protected child also proves the skipped directory is never descended.
  put(path, 'target/Authorization: Bearer fixture-secret/never.ts');
  put(path, 'src/dist/authored.ts');
  put(path, 'node_modules', 'an authored file, not a directory');
  const fake = directoryPort(); usePort(fake.port);
  expect(await files(path)).toEqual(['node_modules', 'src/dist/authored.ts']);
  const candidates = fake.requests.flatMap(request => (request.state as { directories: Directory[] }).directories);
  expect(candidates.map(value => value.relativePath).sort()).toEqual(['src', 'src/dist', 'target']);
  expect(fake.requests[0]!.context?.battery).toBe('engine.walk.skip-directory');
  expect(fake.requests[0]!.context?.batteryVersion).toBe(1);
  expect(fake.requests[0]!.context?.site).toBe('utils.walk-directory');
  expect(Object.keys(fake.requests[0]!.questions)).toHaveLength(2);
});

test('readings are keyed by full root-relative identity, reused only within the owned walk', async () => {
  const path = root(); put(path, 'generated/dist/a.ts'); put(path, 'src/dist/b.ts');
  const fake = directoryPort(directory => noulAnswer(directory.relativePath === 'generated/dist' ? 0.99 : 0.01));
  usePort(fake.port);
  const walk = new DirectoryWalk(path);
  const collect = async () => { const result = []; for await (const file of walk.files()) result.push(relative(path, file)); return result; };
  expect(await collect()).toEqual(['src/dist/b.ts']);
  const count = fake.requests.length;
  expect(await collect()).toEqual(['src/dist/b.ts']); expect(fake.requests).toHaveLength(count);
  expect(await files(path)).toEqual(['src/dist/b.ts']); expect(fake.requests).toHaveLength(count * 2);
  const other = root(); put(other, 'src/dist/c.ts');
  await files(other); expect(fake.requests.length).toBeGreaterThan(count * 2);
});

test('hidden-entry policy, exact 1 MiB limit and no-follow symlinks stay deterministic', async () => {
  const path = root(); put(path, '.hidden/ignored.ts'); put(path, '.file');
  put(path, 'visible.txt'); put(path, 'limit.txt', 'a'.repeat(WALK_MAX_FILE_SIZE));
  put(path, 'large.txt', 'a'.repeat(WALK_MAX_FILE_SIZE + 1));
  const outside = root(); put(outside, 'outside.txt');
  symlinkSync(outside, join(path, 'linked-directory')); symlinkSync(join(outside, 'outside.txt'), join(path, 'linked-file'));
  usePort(undefined);
  expect(await files(path)).toEqual(['limit.txt', 'visible.txt']);
});

test('glob scan honors patterns and explicit hidden inclusion and gates before descent', async () => {
  const path = root(); put(path, 'target/generated.ts'); put(path, 'src/dist/authored.ts'); put(path, 'src/other.js'); put(path, '.notes/a.ts');
  const fake = directoryPort(); usePort(fake.port);
  const found = await collectGlobFiles(path, ['src/**/*.ts', '**/*.ts'], false, false);
  expect([...found].map(file => relative(path, file))).toEqual(['src/dist/authored.ts']);
  expect(fake.requests.flatMap(request => (request.state as { directories: Directory[] }).directories).filter(value => value.relativePath === 'src')).toHaveLength(1);
  const hidden = await collectGlobFiles(path, ['**/*.ts'], true, false);
  expect([...hidden].map(file => relative(path, file)).sort()).toEqual(['.notes/a.ts', 'src/dist/authored.ts']);
});

test('followed symlinks retain real-file deduplication and cycle safety', async () => {
  const path = root(); put(path, 'src/a.ts');
  symlinkSync(join(path, 'src'), join(path, 'alias'));
  symlinkSync(path, join(path, 'src/loop'));
  symlinkSync(join(path, 'src/a.ts'), join(path, 'linked.ts'));
  usePort(directoryPort(() => noulAnswer(0.01)).port);
  const found = await collectGlobFiles(path, ['**/*.ts'], false, true);
  expect(found.size).toBe(1);
});

test('find files retains root gitignore and explicit excludes, and shares reads with nested-ignore discovery', async () => {
  const path = root(); put(path, 'src/dist/keep.ts'); put(path, 'src/dist/ignored.ts'); put(path, 'src/dist/excluded.ts'); put(path, 'target/generated.ts');
  put(path, '.gitignore', 'src/dist/ignored.ts\n'); put(path, 'src/.gitignore', 'not-applied.ts\n');
  const fake = directoryPort(); usePort(fake.port);
  const result = await executeFilesQuery({ id: 'q', mode: 'files', patterns: ['**/*.ts'], exclude: ['**/excluded.ts'] }, { format: 'files_only' }, path);
  expect(result.files).toEqual([join(path, 'src/dist/keep.ts')]);
  expect((result.warnings as string[]).some(value => value.includes('Nested .gitignore'))).toBe(true);
  const candidates = fake.requests.flatMap(request => (request.state as { directories: Directory[] }).directories);
  expect(candidates.map(value => value.relativePath).sort()).toEqual(['src', 'src/dist', 'target']);
});

test('nested ignore discovery is async, gated and capped at five', async () => {
  const path = root(); put(path, 'target/.gitignore');
  for (let i = 0; i < 7; i++) put(path, `src/d${i}/.gitignore`);
  usePort(directoryPort().port);
  const found = await findNestedGitignoreFiles(path, join(path, '.gitignore'));
  expect(found).toHaveLength(5); expect(found.every(file => file.includes('/src/'))).toBe(true);
});

for (const [name, answer] of [
  ['held', () => noulAnswer(0.5)], ['malformed', () => ({ type: 'noul', noul: 'yes' })],
] as const) {
  test(`${name} readings abort before yielding a level or returning a successful find/analyze result`, async () => {
    const path = root(); put(path, 'src/a.ts'); put(path, 'root.ts');
    usePort(directoryPort(answer).port);
    const yielded: string[] = [];
    await expect((async () => { for await (const file of walkDir(path)) yielded.push(file); })()).rejects.toThrow();
    expect(yielded).toEqual([]);
    const result = await createFindTool(path).execute({ queries: [{ id: 'q', mode: 'files' }] });
    expect(result.success).toBe(false);
    await expect(collectTextFiles(path)).rejects.toThrow();
    await expect(collectInputFiles(['.'], path, { expandDirectories: true })).rejects.toThrow();
  });
}

test('missing and failing ports propagate without the old name-list fallback', async () => {
  const path = root(); put(path, 'src/dist/a.ts');
  usePort(undefined);
  await expect(files(path)).rejects.toThrow('No judgment port');
  await expect(collectGlobFiles(path, ['**/*.ts'], false, false)).rejects.toThrow('No judgment port');
  await expect(collectInputFiles(['.'], path, { expandDirectories: true })).rejects.toThrow('No judgment port');
  const fake = directoryPort();
  usePort({ ...fake.port, async ask() { throw new Error('directory service unavailable'); } });
  await expect(files(path)).rejects.toThrow('directory service unavailable');
});

for (const name of ['Authorization: Bearer fixture-secret', '{"password":"fixture-secret"}', '4111111111111111', 'x'.repeat(180) + ' Authorization: Bearer fixture-secret']) {
  test(`complete protected directory identity is refused before any request (${name.length})`, async () => {
    const path = root(); put(path, `${name}/a.ts`);
    const fake = directoryPort(); usePort(fake.port);
    await expect(files(path)).rejects.toThrow('Refused before judgment');
    await expect(collectGlobFiles(path, ['**/*.ts'], false, false)).rejects.toThrow('Refused before judgment');
    expect(fake.requests).toHaveLength(0);
  });
}

test('a pre-aborted walk makes no judgment request', async () => {
  const path = root(); put(path, 'src/a.ts');
  const fake = directoryPort(); usePort(fake.port);
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  await expect(files(path, { signal: controller.signal })).rejects.toThrow('cancelled');
  expect(fake.requests).toHaveLength(0);
});

test('cancellation while awaiting judgment prevents descent and stale results in the real find tool', async () => {
  const path = root(); put(path, 'src/nested/a.ts');
  const { started, release, fake } = pausePort();
  const controller = new AbortController();
  const result = createFindTool(path).execute({ queries: [{ id: 'q', mode: 'files', respect_gitignore: false }] }, { signal: controller.signal });
  await started.promise; controller.abort(new Error('cancelled during reading')); release.resolve();
  expect(await result).toMatchObject({ success: false });
  expect(fake.requests).toHaveLength(1);
});

test('a stale owner is checked after the answer and before any child traversal, including cached reads', async () => {
  const path = root(); put(path, 'src/nested/a.ts');
  const { started, release, fake } = pausePort();
  let current = true;
  const assertCurrent = () => { if (!current) throw new Error('walk superseded'); };
  const result = files(path, { beforeAttempt: assertCurrent });
  await started.promise; current = false; release.resolve();
  await expect(result).rejects.toThrow('walk superseded'); expect(fake.requests).toHaveLength(1);
  usePort(directoryPort().port); current = true;
  const walk = new DirectoryWalk(path); for await (const _file of walk.files()) { /* warm only this invocation */ }
  current = false;
  await expect((async () => { for await (const _file of walk.files({ beforeAttempt: assertCurrent })) { /* must not yield */ } })()).rejects.toThrow('walk superseded');
});

test('analyze deadline is rechecked across directory judgment before descent', async () => {
  const path = root(); put(path, 'src/nested/a.ts');
  const deadline = Date.now() + 60_000;
  const { started, release, fake } = pausePort();
  const result = collectTextFiles(path, 500, deadline);
  await started.promise;
  const now = spyOn(Date, 'now').mockReturnValue(deadline + 1);
  try { release.resolve(); expect(await result).toEqual([]); expect(fake.requests).toHaveLength(1); }
  finally { now.mockRestore(); }
});

test('a no-follow directory replaced by a symlink while judgment waits is not traversed', async () => {
  const path = root(); put(path, 'src/original.ts');
  const outside = root(); put(outside, 'outside.ts');
  const { started, release } = pausePort();
  const result = files(path);
  await started.promise; rmSync(join(path, 'src'), { recursive: true }); symlinkSync(outside, join(path, 'src')); release.resolve();
  expect(await result).toEqual([]);
});

test('real find content/symbols and analyze dependencies callers honor the canonical directory outcome', async () => {
  const path = root(); put(path, 'target/generated.txt', 'export function generated() {}'); put(path, 'src/dist/authored.txt');
  usePort(directoryPort().port);
  const find = createFindTool(path);
  const result = await find.execute({ queries: [{ id: 'content', mode: 'content', pattern: 'function' }, { id: 'symbols', mode: 'symbols' }] });
  expect(result.success).toBe(true);
  const output = JSON.parse(result.output!);
  expect(output.content.count).toBe(1); expect(output.symbols.count).toBe(1);
  const surface = await runDependencies({ mode: 'dependencies' }, path);
  expect(Object.keys(surface.graph as object)).toEqual(['src/dist/authored.txt']);
  expect(JSON.stringify(surface)).toContain('src/dist/authored.txt');
  expect(JSON.stringify(surface)).not.toContain('target/generated.txt');
});

test('a safe basename cannot hide protected material assembled in the complete relative path', async () => {
  const path = root(); put(path, 'Authorization:/Bearer fixture-secret/a.ts');
  const fake = directoryPort(); usePort(fake.port);
  await expect(files(path)).rejects.toThrow('Refused before judgment');
  expect(fake.requests).toHaveLength(1);
  expect(JSON.stringify(fake.requests)).not.toContain('fixture-secret');
});

test('following an earlier alias cannot hide an explicitly matched original directory', async () => {
  const path = root(); put(path, 'src/a.ts'); symlinkSync(join(path, 'src'), join(path, 'alias'));
  usePort(directoryPort().port);
  const found = await collectGlobFiles(path, ['src/**/*.ts'], false, true);
  expect([...found]).toEqual([join(path, 'src/a.ts')]);
});

test('no-follow traversal rechecks the full ancestry after a deeper reading waits', async () => {
  const path = root(); put(path, 'src/nested/original.ts');
  const outside = root(); put(outside, 'nested/outside.ts');
  const fake = directoryPort(); const started = deferred(); const release = deferred();
  let asks = 0;
  usePort({ ...fake.port, async ask(request) {
    if (++asks === 2) { started.resolve(); await release.promise; }
    return fake.port.ask(request);
  } });
  const pending = files(path);
  await started.promise; rmSync(join(path, 'src'), { recursive: true }); symlinkSync(outside, join(path, 'src')); release.resolve();
  await expect(pending).rejects.toThrow('path changed');
  expect(fake.requests).toHaveLength(2);
});

test('a later skip verdict invalidates content-search cache eligibility without an mtime change', async () => {
  const path = root(); put(path, 'src/a.txt', 'needle');
  let skip = false; const fake = directoryPort(() => noulAnswer(skip ? 0.99 : 0.01)); usePort(fake.port);
  const find = createFindTool(path);
  const query = { queries: [{ id: 'q', mode: 'content', pattern: 'needle' }] };
  expect(JSON.parse((await find.execute(query)).output!).q.count).toBe(1);
  skip = true;
  expect(JSON.parse((await find.execute(query)).output!).q.count).toBe(0);
  skip = false;
  expect(JSON.parse((await find.execute(query)).output!).q.count).toBe(1);
  expect(fake.requests).toHaveLength(3);
});

test('the actual analyze executor cancels a pending directory judgment before descending', async () => {
  const { createAnalyzeTool } = await import('../sdk/src/platform/tools/analyze/index.ts');
  const path = root(); put(path, 'src/nested/a.ts');
  const { started, release, fake } = pausePort();
  const controller = new AbortController();
  const pending = createAnalyzeTool({ chat: async () => '{}' }, undefined, path).execute({ mode: 'dependencies' }, { signal: controller.signal });
  await started.promise; controller.abort(new Error('analyze cancelled')); release.resolve();
  expect(await pending).toMatchObject({ success: false }); expect(fake.requests).toHaveLength(1);
});

test('automatic file selection refuses symlink files and ancestor aliases', async () => {
  const path = root(); put(path, 'src/a.ts');
  symlinkSync(join(path, 'src'), join(path, 'alias'));
  symlinkSync(join(path, 'src/a.ts'), join(path, 'linked.ts'));
  usePort(directoryPort().port);
  const walk = new DirectoryWalk(path);
  expect(await walk.excludesFile(join(path, 'src/a.ts'))).toBe(false);
  expect(await walk.excludesFile(join(path, 'alias/a.ts'))).toBe(true);
  expect(await walk.excludesFile(join(path, 'linked.ts'))).toBe(true);
});

test('literal glob scope visits only matching ancestors and still gates selected directories', async () => {
  const path = root(); put(path, 'root.ts'); put(path, 'src/a.ts'); put(path, 'other/b.ts');
  put(path, 'unrelated/Authorization: Bearer fixture-secret/never.ts');
  const fake = directoryPort(() => noulAnswer(0.01)); usePort(fake.port);
  const found = await collectGlobFiles(path, ['root.ts', 'src/a.ts', join(path, 'other/b.ts')], false, false);
  expect([...found].map(file => relative(path, file)).sort()).toEqual(['other/b.ts', 'root.ts', 'src/a.ts']);
  expect(fake.requests.flatMap(request => (request.state as { directories: Directory[] }).directories)
    .map(directory => directory.relativePath).sort()).toEqual(['other', 'src']);
  expect(JSON.stringify(fake.requests)).not.toContain('fixture-secret');
  await expect(collectGlobFiles(path, ['**/*.ts'], false, false)).rejects.toThrow('Refused before judgment');
});

test('explicit glob selection equals unpruned Bun matching for literals and uncertain syntax', async () => {
  const path = root();
  for (const file of ['root.ts', 'root.js', 'src/a.ts', 'src/b.js', 'src/nested/c.ts', '.hidden/d.ts', 'space dir/e.ts', 'bang!/f.ts']) put(path, file);
  usePort(directoryPort(() => noulAnswer(0.01)).port);
  for (const includeHidden of [false, true]) {
    const all: string[] = []; for await (const file of new DirectoryWalk(path).files({ includeHidden })) all.push(file);
    for (const patterns of [
      ['root.ts'], ['src/a.ts'], [join(path, 'src/a.ts')], ['root.ts', 'src/a.ts', 'space dir/e.ts'],
      ['src/**/*.ts'], ['src/{a,b}.{ts,js}'], ['src/[ab].*'], ['!root.ts'], ['src/a.ts', '!root.ts'],
      ['src/\\a.ts'], ['./src/a.ts'], ['bang!/f.ts'], ['.hidden/d.ts'], ['missing.ts'],
    ]) {
      const globs = patterns.map(pattern => new Bun.Glob(pattern));
      const expected = all.filter(file => globs.some(glob => glob.match(relative(path, file)) || glob.match(file))).sort();
      const actual = [...await collectGlobFiles(path, patterns, includeHidden, false)].sort();
      expect({ patterns, includeHidden, actual }).toEqual({ patterns, includeHidden, actual: expected });
    }
  }
});

test('literal alias and original selection retain file identity without global directory suppression', async () => {
  const path = root(); put(path, 'src/a.ts'); symlinkSync(join(path, 'src'), join(path, 'alias'));
  usePort(directoryPort(() => noulAnswer(0.01)).port);
  for (const name of ['alias', 'src']) {
    expect([...await collectGlobFiles(path, [`${name}/a.ts`], false, true)]).toEqual([join(path, name, 'a.ts')]);
  }
  expect([...await collectGlobFiles(path, ['alias/a.ts'], false, false)]).toEqual([]);
});

test('nonmatching files add no per-file authority or metadata work to nested-ignore discovery', async () => {
  const path = root(); put(path, 'src/.gitignore');
  usePort(directoryPort(() => noulAnswer(0.01)).port);
  const scan = async () => {
    let checks = 0;
    const found = await findNestedGitignoreFiles(path, join(path, '.gitignore'), new DirectoryWalk(path), {
      beforeAsyncAttempt: async () => { checks++; },
    });
    return { found, checks };
  };
  const before = await scan();
  for (let index = 0; index < 100; index++) put(path, `src/unrelated-${index}.ts`);
  expect(await scan()).toEqual(before);
});

test('zero-match selections retain cancellation and owner checks before successful completion', async () => {
  const path = root(); put(path, 'unrelated.ts');
  const controller = new AbortController();
  await expect(files(path, {
    signal: controller.signal, selectFile: () => { controller.abort(new Error('selection cancelled')); return false; },
  })).rejects.toThrow('selection cancelled');
  let current = true;
  await expect(files(path, {
    selectFile: () => { current = false; return false; }, beforeAttempt: () => { if (!current) throw new Error('selection owner stale'); },
  })).rejects.toThrow('selection owner stale');
});

test('full readset replay is bounded by directory readings, never selected file count or cached batches', async () => {
  const path = root(); put(path, 'src/a.ts');
  const fake = directoryPort(() => noulAnswer(0.01)); usePort(fake.port);
  const walk = new DirectoryWalk(path);
  const scan = async () => {
    let full = 0; let cheap = 0;
    for await (const _file of walk.files({ beforeAttempt: () => { cheap++; }, beforeAsyncAttempt: async () => { full++; } })) { /* enumerate */ }
    return { full, cheap };
  };
  const first = await scan(); expect(first.full).toBe(4); expect(fake.requests).toHaveLength(1);
  for (let index = 0; index < 100; index++) put(path, `src/selected-${index}.ts`);
  const cached = await scan(); expect(cached.full).toBe(2); expect(cached.cheap).toBeGreaterThan(first.cheap);
  expect(fake.requests).toHaveLength(1);
});

for (const [boundary, rejectedCheck] of [['entry', 1], ['before reading', 2], ['after reading', 3], ['completion', 4]] as const) {
  test(`full authority rejection at ${boundary} holds traversal`, async () => {
    const path = root(); put(path, 'src/a.ts');
    const fake = directoryPort(() => noulAnswer(0.01)); usePort(fake.port);
    let checks = 0;
    await expect(files(path, { beforeAsyncAttempt: async () => {
      if (++checks >= rejectedCheck) throw new Error('readset revoked');
    } })).rejects.toThrow('readset revoked');
    expect(fake.requests).toHaveLength(rejectedCheck <= 2 ? 0 : 1);
  });
}

test('early iterator return replays full authority without turning graceful bounds into errors', async () => {
  const path = root(); put(path, 'a.ts'); put(path, 'b.ts');
  let allowed = true; let full = 0;
  const iterator = walkDir(path, { beforeAsyncAttempt: async () => { full++; if (!allowed) throw new Error('return revoked'); } });
  expect((await iterator.next()).done).toBe(false);
  allowed = false;
  await expect(iterator.return(undefined)).rejects.toThrow('return revoked'); expect(full).toBe(2);
  expect(await files(path, { shouldContinue: () => false })).toEqual([]);
});

test('each transport retry keeps the full readset fence before another directory transmission', async () => {
  const path = root(); put(path, 'src/a.ts');
  const fake = directoryPort(() => noulAnswer(0.01));
  let allowed = true; let transmissions = 0;
  usePort({ ...fake.port, async ask(request) {
    await request.beforeAsyncAttempt?.(); request.beforeAttempt?.(); transmissions++;
    allowed = false;
    await request.beforeAsyncAttempt?.(); request.beforeAttempt?.(); transmissions++;
    return fake.port.ask(request);
  } });
  await expect(files(path, { beforeAsyncAttempt: async () => { if (!allowed) throw new Error('retry revoked'); } })).rejects.toThrow('retry revoked');
  expect(transmissions).toBe(1); expect(fake.requests).toHaveLength(0);
});


test('deprecated public skip-set mutation cannot alter canonical walk or find selection', async () => {
  const path = root(); put(path, 'target/generated.ts'); put(path, 'dist/authored.ts');
  const compatibility: Set<string> = WALK_SKIP_DIRS;
  const original = [...compatibility];
  const fake = directoryPort(); usePort(fake.port);
  const expected = ['dist/authored.ts'];
  const findFiles = async () => [...await collectGlobFiles(path, ['**/*'], false, false)].map(file => relative(path, file)).sort();
  try {
    expect(await files(path)).toEqual(expected);
    expect(await findFiles()).toEqual(expected);
    compatibility.clear(); compatibility.add('dist'); compatibility.add('target');
    expect(await files(path)).toEqual(expected);
    expect(await findFiles()).toEqual(expected);
  } finally { compatibility.clear(); for (const value of original) compatibility.add(value); }
});

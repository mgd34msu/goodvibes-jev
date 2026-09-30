import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { CHUNK_SIZE, IGNORE_RULES, RESOLVERS, assertExactCoverage, packedExports, parseShard, planChecks, verifyAnalysis } from '../scripts/types-resolution-plan.ts';
import { checkChunk, runProcess } from '../scripts/types-resolution-runner.ts';
const pkg = { name: 'fixture', tarball: 'fixture.tgz', entrypoints: ['.', './a'] };
const analysis = () => ({ analysis: { packageName: pkg.name, types: { kind: 'included' }, entrypoints:
  Object.fromEntries(pkg.entrypoints.map((key) => [key, { resolutions: Object.fromEntries(RESOLVERS.map((mode) => [mode, { resolutionKind: mode }])) }])) } });

test('deterministic exact partition, bounded chunks, including small packages', () => {
  const packages = [pkg, { name: 'engine', tarball: 'engine.tgz', entrypoints: Array.from({ length: 259 }, (_, i) => `./${i}`) }];
  const lanes = planChecks(packages, 16);
  expect(planChecks([...packages].reverse(), 16)).toEqual(lanes);
  expect(lanes.flat().every((chunk) => chunk.entrypoints.length <= CHUNK_SIZE)).toBe(true);
  expect(lanes.flat().flatMap((chunk) => chunk.entrypoints)).toHaveLength(261);
  expect(lanes.map((lane) => lane.reduce((sum, chunk) => sum + chunk.entrypoints.length, 0)).sort()).toEqual([...Array(11).fill(16), ...Array(5).fill(17)].sort());
  expect(planChecks(packages, 1).flat().flatMap((chunk) => chunk.entrypoints)).toHaveLength(261);
  expect(planChecks([pkg], 16).filter((lane) => lane.length === 0)).toHaveLength(14);
});
test('rejects missing, duplicate, unexpected exports and bad arguments', () => {
  for (const actual of [['.'], ['.', '.'], ['.', './x']]) expect(() => assertExactCoverage(pkg.entrypoints, actual)).toThrow();
  expect(() => planChecks([pkg, pkg], 16)).toThrow();
  expect(() => planChecks([], 16)).toThrow();
  expect(() => planChecks([{ ...pkg, entrypoints: [] }], 16)).toThrow();
  for (const count of [0, -1, 1.5, 257]) expect(() => planChecks([pkg], count)).toThrow();
  for (const args of [['--shard', '16/16'], ['--shard', '0/0'], ['--shard', '-1/16'], ['--shard', '0/257'], ['--shard'], ['--other', '0/1']]) expect(() => parseShard(args)).toThrow();
  expect(parseShard([])).toEqual({ index: 0, count: 1 });
  expect(parseShard(['--shard', '15/16'])).toEqual({ index: 15, count: 16 });
});
test('published manifest discovery fails closed on unsupported export shapes', () => {
  expect(packedExports({ name: 'fixture', exports: { './a': { types: './a.d.ts', default: './a.js' }, '.': './index.js' } }, 'fixture.tgz')).toEqual(pkg);
  for (const exports of [undefined, {}, './index.js', { import: './index.js' }, { './*': './*.js' }, { '.': null }, { '.': [] }, { '.': { types: null, default: './index.js' } }]) expect(() => packedExports({ name: 'fixture', exports }, 'fixture.tgz')).toThrow();
});
test('requires correct package, exact exports and every resolver result', () => {
  expect(() => verifyAnalysis(JSON.stringify(analysis()), pkg)).not.toThrow();
  const wrongPackage = analysis(); wrongPackage.analysis.packageName = 'other';
  const missingExport = analysis(); delete missingExport.analysis.entrypoints['./a'];
  const missingMode = analysis(); delete missingMode.analysis.entrypoints['.']!.resolutions.bundler;
  for (const result of [{}, { analysis: { types: false } }, wrongPackage, missingExport, missingMode]) expect(() => verifyAnalysis(JSON.stringify(result), pkg)).toThrow();
  expect(() => verifyAnalysis('not json', pkg)).toThrow();
});
test('propagates nonzero exit, signal and timeout', async () => {
  expect(await runProcess('node', ['-e', 'process.stdout.write("ok")'])).toBe('ok');
  await expect(runProcess('node', ['-e', 'process.exit(7)'])).rejects.toThrow();
  await expect(runProcess('node', ['-e', 'process.kill(process.pid,"SIGTERM")'])).rejects.toThrow();
  const started = Date.now();
  await expect(runProcess('node', ['-e', 'setInterval(()=>{},1000)'], 100)).rejects.toThrow();
  expect(Date.now() - started).toBeLessThan(5000);
});
test('required aggregate always runs and fails unless every shard succeeded', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const matrix = workflow.split('  types-resolution-shards:')[1]!.split('  types-resolution-check:')[0]!;
  expect(matrix).toContain('fail-fast: false');
  expect(matrix).toContain('max-parallel: 4');
  const shardValues = matrix.match(/shard: \[([^\]]+)\]/)![1]!.split(',').map(Number);
  expect(shardValues).toEqual(Array.from({ length: 16 }, (_, i) => i));
  expect(matrix).toContain('types:resolution-check --shard ${{ matrix.shard }}/16');
  const aggregate = workflow.split('  types-resolution-check:')[1]!.split('  publint-check:')[0]!;
  expect(aggregate).toContain('name: Are the types wrong? (exports map resolution)');
  expect(aggregate).toContain('if: always()');
  expect(aggregate).toContain('needs: [build, types-resolution-shards]');
  for (const result of ['failure', 'cancelled', 'skipped', '']) expect(() => execFileSync('sh', ['-c', 'test "$BUILD_RESULT" = success && test "$SHARDS_RESULT" = success'], { env: { BUILD_RESULT: 'success', SHARDS_RESULT: result } })).toThrow();
});
test('real attw monolithic and chunked fixture have identical per-export semantics', async () => {
  const root = mkdtempSync(join(tmpdir(), 'attw-fixture-'));
  try {
    mkdirSync(join(root, 'package'));
    const exports = { '.': { types: './index.d.ts', default: './index.js' }, './a': { types: './a.d.ts', default: './a.js' } };
    writeFileSync(join(root, 'package/package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', type: 'module', exports }));
    for (const name of ['index', 'a']) {
      writeFileSync(join(root, `package/${name}.d.ts`), 'export declare const value: number;');
      writeFileSync(join(root, `package/${name}.js`), 'export const value = 1;');
    }
    const tarball = join(root, 'fixture.tgz');
    execFileSync('tar', ['-czf', tarball, '-C', root, 'package']);
    const require = createRequire(import.meta.url);
    const cli = join(require.resolve('@arethetypeswrong/cli/package.json'), '../dist/index.js');
    const run = async (entrypoints?: string[]) => JSON.parse(await runProcess('node', [cli, tarball, '--format', 'json', '--ignore-rules', ...IGNORE_RULES, ...(entrypoints ? ['--entrypoints', ...entrypoints] : [])]));
    const full = await run();
    for (const key of pkg.entrypoints) {
      const chunk = { ...pkg, tarball, entrypoints: [key] };
      const partial = await run([key]);
      verifyAnalysis(JSON.stringify(partial), chunk);
      // Problem indices are local to each invocation; compare resolved findings.
      const semantics = (result: typeof partial) => JSON.parse(JSON.stringify(result.analysis.entrypoints[key], (property, value) =>
        property === 'trace' ? undefined : property === 'visibleProblems' ? value.map((index: number) => result.analysis.problems[index]) : value));
      expect(semantics(partial)).toEqual(semantics(full));
      expect(partial.analysis.problems).toEqual(full.analysis.problems.filter((problem: { entrypoint: string }) => problem.entrypoint === key));
      await checkChunk(chunk);
    }
    // A real unignored attw finding must fail both the ordinary CLI and runner.
    writeFileSync(join(root, 'package/a.d.ts'), "export { missing } from './missing.js';");
    execFileSync('tar', ['-czf', tarball, '-C', root, 'package']);
    await expect(run()).rejects.toThrow();
    await expect(checkChunk({ ...pkg, tarball, entrypoints: ['./a'] })).rejects.toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);

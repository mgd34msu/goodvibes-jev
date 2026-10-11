import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runOwnedTestChild } from '@goodvibes-jev/engine/toolchain/test-runner';
import { runOwnedTestChild as compatibilityOwner } from '../../scripts/owned-test-child.ts';
import { normalizeManifest, readPackage } from '../../scripts/release-shared.ts';
import { capturePackManifest } from '../helpers/pack-manifest-output.ts';

const ENGINE = resolve(import.meta.dir, '../..');
const REPO = resolve(ENGINE, '../..');
const PUBLIC_ENTRY = '@goodvibes-jev/engine/toolchain/test-runner';
let root: string;
let consumer: string;
let installed: string;
let files: string[];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'goodvibes-test-runner-package-'));
  const stage = join(root, 'stage');
  consumer = join(root, 'consumer');
  mkdirSync(stage);
  mkdirSync(consumer);
  const manifest = normalizeManifest(readPackage('.'));
  const publishPaths = Array.isArray(manifest.files)
    ? manifest.files.filter((path): path is string => typeof path === 'string') : [];
  expect(publishPaths).toContain('toolchain/dist');
  expect(existsSync(join(ENGINE, 'toolchain/dist/test-runner/index.js')),
    'Build packages/engine/toolchain first; CI restores this output from its build job').toBe(true);
  // Only declared published files enter this stage. No scripts, source files,
  // workspace links or dependencies are installed in the consumer fixture.
  for (const path of publishPaths) {
    if (existsSync(join(ENGINE, path))) cpSync(join(ENGINE, path), join(stage, path), { recursive: true });
  }
  writeFileSync(join(stage, 'package.json'), JSON.stringify(manifest, null, 2));
  const packed = capturePackManifest('npm', ['pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', root], {
    cwd: stage, timeout: 20_000,
    env: { PATH: process.env.PATH, HOME: root, npm_config_cache: join(root, 'npm-cache') },
  });
  expect({ status: packed.status, error: packed.error?.message }, packed.stderr).toEqual({ status: 0, error: undefined });
  const records = JSON.parse(packed.stdout) as { filename: string; files: { path: string }[] }[];
  const record = records[0]!;
  files = record.files.map((file) => file.path);
  const scope = join(consumer, 'node_modules/@goodvibes-jev');
  mkdirSync(scope, { recursive: true });
  installed = join(scope, 'engine');
  mkdirSync(installed);
  const extracted = spawnSync('tar', ['-xzf', join(root, record.filename), '--strip-components=1', '-C', installed], { encoding: 'utf8' });
  expect(extracted.status, extracted.stderr).toBe(0);
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  const proof = process.env.GOODVIBES_TEST_PACKAGE_PROOF_DIR;
  if (proof) {
    mkdirSync(proof, { recursive: true });
    cpSync(join(root, record.filename), join(proof, 'toolchain-boundary.tgz'));
    const entries = ['package.json', ...files.filter((path) => path.startsWith('toolchain/dist/test-runner/'))];
    const exported = manifest.exports as Record<string, unknown> | undefined;
    writeFileSync(join(proof, 'packed-entry-hashes.json'), JSON.stringify({
      scope: 'Focused normalized engine toolchain boundary; not full engine release validation',
      entry: exported?.['./toolchain/test-runner'],
      files: Object.fromEntries(entries.map((path) => [path, createHash('sha256').update(readFileSync(join(installed, path))).digest('hex')])),
    }, null, 2));
  }
}, 30_000);

afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

test('the public source boundary and old script forwarder share one implementation', () => {
  expect(runOwnedTestChild).toBe(compatibilityOwner);
});

test('the normalized packed entry contains every emitted runtime and declaration file', () => {
  const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')) as {
    exports: Record<string, Record<string, string>>;
  };
  expect(manifest.exports['./toolchain/test-runner']).toEqual({
    types: './toolchain/dist/test-runner/index.d.ts', import: './toolchain/dist/test-runner/index.js',
  });
  for (const name of ['index', 'owned-test-child', 'test-child-watchdog', 'test-child-watchdog-env',
    'test-isolation', 'test-network-guard', 'test-network-preload', 'test-run-tmp', 'stale-tmp-sweep', 'temp-registry', 'test-temp-cleanup']) {
    for (const suffix of ['.js', '.d.ts']) expect(files).toContain(`toolchain/dist/test-runner/${name}${suffix}`);
  }
  expect(files.some((path) => path.startsWith('scripts/') || path.includes('/src/'))).toBe(false);
});

test('Node imports the packed boundary without a Bun runtime or test lifecycle', () => {
  const result = spawnSync('node', ['--input-type=module', '-e', `
    import { runOwnedTestChild } from '${PUBLIC_ENTRY}';
    console.log(JSON.stringify({ fn: typeof runOwnedTestChild, bun: typeof globalThis.Bun, resolved: import.meta.resolve('${PUBLIC_ENTRY}') }));
  `], { cwd: consumer, encoding: 'utf8', timeout: 5_000 });
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  expect(JSON.parse(result.stdout)).toEqual({
    fn: 'function', bun: 'undefined', resolved: pathToFileURL(join(installed, 'toolchain/dist/test-runner/index.js')).href,
  });
});

test('installed declarations describe the public caller contract without source resolution', () => {
  writeFileSync(join(consumer, 'consumer.mts'), `
    import { runOwnedTestChild, type OwnedTestChildResult, type OwnedTestChildStop } from '${PUBLIC_ENTRY}';
    import { Writable } from 'node:stream';
    const result: Promise<OwnedTestChildResult> = runOwnedTestChild({
      argv: ['fixture.test.ts'], cwd: '.', env: {}, fixtureEnv: {},
      ceilingMs: 1000, stallMs: 500, killGraceMs: 100, outputDrainGraceMs: 100,
      stdout: new Writable(), stderr: new Writable(), ownProcessGroup: true, expectedParentPid: 1,
    });
    const stop: OwnedTestChildStop = 'output-drain';
    void result; void stop;
  `);
  writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2024', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
      noEmit: true, types: ['node'], typeRoots: [join(REPO, 'node_modules/@types')],
    }, files: ['consumer.mts'],
  }));
  const result = spawnSync('node', ['--max-old-space-size=2048', join(REPO, 'node_modules/typescript/bin/tsc'), '--project', join(consumer, 'tsconfig.json'), '--pretty', 'false'], {
    cwd: consumer, encoding: 'utf8', timeout: 30_000,
  });
  expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({ status: 0, stdout: '', stderr: '' });
}, 40_000);

test.each(['pass', 'blocked'] as const)('installed Bun owner activates emitted preloads for %s fixture', (mode) => {
  const fixture = join(consumer, `${mode}.test.ts`);
  writeFileSync(fixture, `
    import { test, expect } from 'bun:test';
    test('installed guard and isolation', async () => {
      expect(process.env.OPENAI_API_KEY).toBeUndefined();
      ${mode === 'blocked' ? "try { await fetch('https://packed-runner-fixture.invalid/never-sent'); } catch {}" : ''}
      console.log('PACKED-FIXTURE-RAN');
    });
  `);
  const entry = join(consumer, 'run.mjs');
  writeFileSync(entry, `
    import { runOwnedTestChild } from '${PUBLIC_ENTRY}';
    import { Writable } from 'node:stream';
    let stdout = '', stderr = '';
    const result = await runOwnedTestChild({
      argv: [${JSON.stringify(fixture)}], cwd: process.cwd(),
      env: { ...process.env, OPENAI_API_KEY: 'synthetic-unusable-fixture' },
      ownProcessGroup: true, ceilingMs: 5000,
      stdout: new Writable({ write(chunk, _encoding, done) { stdout += String(chunk); done(); } }),
      stderr: new Writable({ write(chunk, _encoding, done) { stderr += String(chunk); done(); } }),
    });
    console.log(JSON.stringify({ result, stdout, stderr, resolved: import.meta.resolve('${PUBLIC_ENTRY}') }));
  `);
  const child = spawnSync(process.execPath, ['--no-env-file', entry], { cwd: consumer, encoding: 'utf8', timeout: 10_000 });
  expect({ status: child.status, error: child.error?.message, stderr: child.stderr }).toEqual({ status: 0, error: undefined, stderr: '' });
  const record = JSON.parse(child.stdout) as { result: { exitCode: number; stopped: string | null; outputTruncated: boolean }; stdout: string; stderr: string; resolved: string };
  expect(record.resolved.startsWith('file:') ? fileURLToPath(record.resolved) : record.resolved).toBe(join(installed, 'toolchain/dist/test-runner/index.js'));
  expect(record.stdout).toContain('PACKED-FIXTURE-RAN');
  expect(record.stderr).toContain('1 pass');
  expect(record.result).toMatchObject({ exitCode: mode === 'pass' ? 0 : 1, stopped: null, outputTruncated: false });
  if (mode === 'blocked') expect(record.stderr).toContain('unexpected external test I/O was blocked');
});

test.each(['pass', 'hard-exit'] as const)('installed emitted owner cleans registered paths on %s', (mode) => {
  const fixture = join(consumer, `cleanup-${mode}.test.ts`);
  const record = join(consumer, `cleanup-${mode}.json`);
  const registry = pathToFileURL(join(installed, 'toolchain/dist/test-runner/temp-registry.js')).href;
  writeFileSync(fixture, `
    import { test } from 'bun:test';
    import { mkdtempSync, writeFileSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { registerTempDirForCleanup } from ${JSON.stringify(registry)};
    const path = registerTempDirForCleanup(mkdtempSync(join(tmpdir(), 'packed-owned-')));
    writeFileSync(${JSON.stringify(record)}, JSON.stringify({ path, root: tmpdir() }));
    ${mode === 'hard-exit' ? 'process.exit(7);' : "test('owned fixture', () => {});"}
  `);
  const entry = join(consumer, `cleanup-${mode}.mjs`);
  writeFileSync(entry, `
    import { runOwnedTestChild } from '${PUBLIC_ENTRY}';
    import { Writable } from 'node:stream';
    let output = '';
    const result = await runOwnedTestChild({ argv: [${JSON.stringify(fixture)}], cwd: process.cwd(), env: process.env, ownProcessGroup: true, ceilingMs: 10000,
      stdout: new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } }),
    });
    console.log(JSON.stringify({ result, output }));
  `);
  const child = spawnSync(process.execPath, ['--no-env-file', entry], { cwd: consumer, encoding: 'utf8', timeout: 15000 });
  expect({ status: child.status, error: child.error?.message }).toEqual({ status: 0, error: undefined });
  const outcome = JSON.parse(child.stdout).result;
  expect(outcome.exitCode).toBe(mode === 'pass' ? 0 : 7);
  const owned = JSON.parse(readFileSync(record, 'utf8'));
  expect(existsSync(owned.path)).toBe(false); expect(existsSync(owned.root)).toBe(false);
}, 20000);

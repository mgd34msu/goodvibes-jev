/** Exercise the actual CLI against disposable package fixtures, without a model or credentials. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { packageReadme } from '../scripts/ci-readings/package-readme.ts';
import { readmeState } from '../scripts/ci-readings/package-readmes.ts';
import { decisionId, readingModel, stateHash, type StoredAnswer } from '../scripts/ci-readings/stored-readings.ts';

const SDK_ROOT = resolve(import.meta.dir, '..');
const YES: StoredAnswer = { verdict: 'yes', outcome: 'act', probability: 0.95 };
const NO: StoredAnswer = { verdict: 'no', outcome: 'act', probability: 0.05 };
const UNSETTLED: StoredAnswer = { verdict: 'uncertain', outcome: 'escalate', probability: 0.51 };
const SCRIPTS = [
  'package-metadata-check.ts', 'read-package-readmes.ts', 'docs-completeness-check.ts', 'bun-pin-rule.ts',
  'export-conditions.ts', 'release-shared.ts', 'workspace-lock.ts',
  'ci-readings/package-readme.ts', 'ci-readings/package-readmes.ts', 'ci-readings/stored-readings.ts',
];

let root: string;
let readingsPath: string;

function write(path: string, value: string): void {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, value);
}

function editManifest(edit: (manifest: Record<string, unknown>) => void): void {
  const path = join(root, 'packages/engine/package.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  edit(manifest);
  writeFileSync(path, JSON.stringify(manifest));
}

function writeEvidence(answers = { documents: YES, stale: NO }, overrides: Record<string, unknown> = {}): void {
  const readings = Object.fromEntries(['engine', 'judgment'].map((name) => {
    const state = readmeState(join(root, 'packages', name));
    return [stateHash(state), { subject: `${name}/README.md`, answers }];
  }));
  writeFileSync(readingsPath, JSON.stringify({
    decision: decisionId(packageReadme), model: readingModel(packageReadme), readings, ...overrides,
  }));
}

function run(script = 'package-metadata-check.ts', env: Record<string, string> = {}) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, '--preload', join(root, 'offline.ts'), join(root, 'packages/engine/scripts', script)],
    cwd: root,
    // Deliberately exclude real credentials and live judgment configuration.
    env: { PATH: process.env.PATH ?? '', PACKAGE_README_READINGS: readingsPath, ...env },
    timeout: 10_000,
  });
  return { exitCode: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'package-metadata-'));
  readingsPath = join(root, 'readings.json');
  const shared = {
    version: '1.0.0', description: 'Fixture package', license: 'MIT',
    homepage: 'https://github.com/acme/fixture',
    repository: { url: 'git+https://github.com/acme/fixture.git' },
    bugs: { url: 'https://github.com/acme/fixture/issues' },
    engines: { bun: '1.3.14', node: '>=22.0.0' },
  };
  write('package.json', JSON.stringify({
    ...shared, name: 'fixture', packageManager: 'bun@1.3.14', devDependencies: { '@types/bun': '1.3.14' },
  }));
  for (const name of ['engine', 'judgment']) {
    write(`packages/${name}/package.json`, JSON.stringify({
      ...shared, name: `@acme/${name}`, keywords: ['fixture'], files: ['dist', 'README.md'],
      publishConfig: { access: 'public' },
      exports: { '.': { bun: './src/index.ts', types: './dist/index.d.ts', import: './dist/index.js' } },
    }));
    write(`packages/${name}/src/index.ts`, 'export {};\n');
    write(`packages/${name}/README.md`, `# @acme/${name}\n\nA fixture package with installation and usage documentation.\n`);
  }
  write('packages/engine/examples/package.json', JSON.stringify({ devDependencies: { '@types/bun': '^1.3.14' } }));
  write('packages/engine/sdk/src/platform/node/capabilities.ts', 'export {};\n');
  write('packages/engine/contracts/src/generated/foundation-client-types.ts', 'export interface FixtureRequest {}\n');
  write('packages/engine/contracts/src/index.ts', "export type { FixtureRequest } from './generated/foundation-client-types.js';\n");
  write('.github/workflows/fixture.yml', 'bun-version: "1.3.14"\n');
  write('offline.ts', "globalThis.fetch = async () => { console.error('Unexpected network in offline fixture'); process.exit(97); };\n");
  for (const script of SCRIPTS) {
    const destination = join(root, 'packages/engine/scripts', script);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(SDK_ROOT, 'scripts', script), destination);
  }
  symlinkSync(resolve(SDK_ROOT, '../../node_modules'), join(root, 'node_modules'), 'junction');
  symlinkSync(resolve(SDK_ROOT, 'node_modules'), join(root, 'packages/engine/node_modules'), 'junction');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('required metadata checks and advisory editorial readings', () => {
  test('missing readings are advisory and need no model credentials', () => {
    const result = run();
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('package metadata check passed (structural checks)');
    expect(result.output).toContain('[package-readme editorial advisory]');
    expect(result.output).toContain('missing or stale content evidence');
  });

  test('a prose edit passes metadata validation without refreshing or rewriting favorable evidence', () => {
    writeEvidence();
    const before = run();
    expect(before.exitCode).toBe(0);
    expect(before.output).not.toContain('editorial advisory');
    const originalEvidence = readFileSync(readingsPath, 'utf8');
    write('packages/engine/README.md', '# @acme/engine\n\nUpdated installation and usage explanation.\n');
    const result = run();
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('has no stored engine.gates.package-readme reading for its current text');
    expect(readFileSync(readingsPath, 'utf8')).toBe(originalEvidence);
  });

  test.each(['decision', 'model'])('stale %s provenance is advisory', (field) => {
    writeEvidence(undefined, { [field]: 'previous-fixture-version' });
    const result = run();
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('stale editorial evidence');
    expect(result.output).toContain(`${field} previous-fixture-version`);
  });

  test('negative and unsettled answers remain visible without failing correctness validation', () => {
    writeEvidence({ documents: NO, stale: UNSETTLED });
    const result = run();
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('does not document the package');
    expect(result.output).toContain('uncertain, escalate, probability 0.51');
  });

  test('unreadable editorial evidence is reported as unavailable', () => {
    writeFileSync(readingsPath, '{ invalid JSON');
    const result = run();
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Stored editorial evidence unavailable');
  });

  test('a missing README still fails with favorable cached readings', () => {
    writeEvidence();
    rmSync(join(root, 'packages/engine/README.md'));
    const result = run();
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('is missing README.md');
  });

  test.each(['', ' \n\t\r\n'])('an empty or whitespace-only README still fails (%j)', (text) => {
    write('packages/engine/README.md', text);
    writeEvidence();
    const result = run();
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('README.md is empty');
  });

  test('invalid manifest metadata still fails without editorial evidence', () => {
    editManifest((manifest) => { manifest['description'] = ''; });
    const result = run();
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('is missing required field: description');
  });

  test('an export without a backing source still fails', () => {
    rmSync(join(root, 'packages/engine/src/index.ts'));
    const result = run();
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('source condition names a missing file');
  });

  test('an invalid wildcard export still fails', () => {
    editManifest((manifest) => { manifest['exports'] = { './*': './dist/*.js' }; });
    const result = run();
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('must not use wildcard exports');
  });

  test('a missing required document still fails the separate documentation gate', () => {
    const result = run('docs-completeness-check.ts');
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('Missing required SDK doc/example: ../../SECURITY.md');
  });

  test('an empty required document still fails the separate documentation gate', () => {
    write('SECURITY.md', ' \n\t');
    const result = run('docs-completeness-check.ts');
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('Empty required SDK doc/example: ../../SECURITY.md');
  });

  test('an omitted generated type re-export still fails after README validation', () => {
    write('packages/engine/contracts/src/index.ts', 'export {};\n');
    const result = run();
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('must re-export generated foundation client types: FixtureRequest');
  });

  test('Bun pin disagreement still fails after README validation', () => {
    write('.github/workflows/fixture.yml', 'bun-version: "1.3.13"\n');
    const result = run();
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('bun version pins disagree with root engines.bun');
  });

  test('the manual reader still reuses current evidence and preserves provenance offline', () => {
    writeEvidence();
    const result = run('read-package-readmes.ts', { TYPESAFE_API_KEY: 'fixture-only-not-a-real-key' });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('0 read, 2 reused, 2 package README(s)');
    const saved = JSON.parse(readFileSync(readingsPath, 'utf8'));
    expect(saved.decision).toBe(decisionId(packageReadme));
    expect(saved.model).toBe(readingModel(packageReadme));
  });
});

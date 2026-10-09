import { afterEach, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { inspectProductWorkspaces, inventoryDispositions, moduleSpecifiers, productCheckCommands, productTestMatrix, readProductSources, selectProductWorkspaces, type ProductSource } from '../scripts/product-workspace-contract.ts';
import { executeProductCommands } from '../scripts/product-workspaces.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const source: ProductSource = {
  name: 'daemon', path: 'products/daemon', packageName: '@goodvibes-jev/daemon',
  repository: 'mgd34msu/goodvibes-daemon', revision: 'a'.repeat(40),
  inventory: 'docs/inventory/daemon.md', inventoryPrefix: '', files: ['src/main.ts'],
};
function write(root: string, path: string, value: string | object): void {
  const file = join(root, path); mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}
function fixture(present = true): string {
  const root = mkdtempSync(join(tmpdir(), 'product-contract-')); roots.push(root);
  write(root, source.inventory, '| `src/main.ts` | PORT | Source fixture |\n');
  write(root, 'packages/engine/package.json', { exports: { './sdk/platform/config': {} } });
  if (!present) return root;
  write(root, 'products/daemon/package.json', {
    name: source.packageName, private: true, dependencies: { '@goodvibes-jev/engine': 'workspace:*' },
    scripts: { build: 'bun scripts/build.ts', typecheck: 'tsc --noEmit', 'typecheck:test': 'tsc --noEmit -p tsconfig.test.json', test: 'bun scripts/test.ts' },
  });
  write(root, 'products/daemon/tsconfig.json', {});
  write(root, 'products/daemon/tsconfig.test.json', {});
  write(root, 'products/daemon/scripts/build.ts', 'export const fixtureBuild = true;');
  write(root, 'products/daemon/scripts/test.ts', 'export const fixtureTestRunner = true;');
  write(root, 'products/daemon/src/main.ts', 'export function main() { return 42; }');
  write(root, 'products/daemon/src/main.test.ts', "import { test, expect } from 'bun:test'; test('main', () => expect(42).toBe(42));");
  write(root, 'products/daemon/migration.json', { sourceRevision: source.revision, entrypoints: ['src/main.ts'] });
  return root;
}
function mutate(root: string, file: string, update: (value: Record<string, unknown>) => void): void {
  const value = JSON.parse(readFileSync(join(root, file), 'utf8')) as Record<string, unknown>; update(value); write(root, file, value);
}

test('in-progress validation records missing products, while strict completion refuses them', () => {
  const root = fixture(false);
  expect(inspectProductWorkspaces(root, [source])).toEqual({ products: [], missing: ['daemon'], findings: [] });
  expect(inspectProductWorkspaces(root, [source], true).findings).toContain('products/daemon: product is missing');
});

test('a partial workspace runs each compiler project once without repeating product aggregates', () => {
  const root = fixture();
  const inspection = inspectProductWorkspaces(root, [source]);
  expect(inspection.findings).toEqual([]);
  for (const mode of ['build', 'test'] as const) expect(productCheckCommands(root, inspection.products, mode)).toEqual([{ kind: 'script', label: `daemon:${mode}`, cwd: join(root, source.path), script: mode }]);
  expect(productCheckCommands(root, inspection.products, 'typecheck').map((command) => command.kind === 'script' ? command.script : command.file.split('/').at(-1))).toEqual(['tsconfig.json', 'tsconfig.test.json']);
  expect(inspectProductWorkspaces(root, [source], true).findings).toContain('products/daemon: source module not accounted for: src/main.ts');
});

test('the product command runner executes the declared build and propagates its failure', async () => {
  const root = fixture();
  const commands = productCheckCommands(root, inspectProductWorkspaces(root, [source]).products, 'build');
  write(root, 'products/daemon/scripts/build.ts', "import { writeFileSync } from 'node:fs'; writeFileSync('build-marker', 'built');");
  await executeProductCommands(root, commands, 'build');
  expect(readFileSync(join(root, 'products/daemon/build-marker'), 'utf8')).toBe('built');
  write(root, 'products/daemon/scripts/build.ts', 'process.exit(7);');
  await expect(executeProductCommands(root, commands, 'build')).rejects.toThrow('daemon:build failed (exit code 7, signal none)');
});

test('a product typecheck printing errors cannot report success with exit zero', async () => {
  const root = fixture();
  const commands = productCheckCommands(root, inspectProductWorkspaces(root, [source]).products, 'typecheck');
  await expect(executeProductCommands(root, commands, 'typecheck', () => ({ status: 0, stdout: 'file.ts(1,1): error TS2322: incompatible type\n', stderr: '' }))).rejects.toThrow('failed');
});

test('direct compilation still catches an error owned only by a secondary project', async () => {
  const root = fixture();
  write(root, 'products/daemon/tsconfig.json', { compilerOptions: { types: [] }, include: ['src/main.ts', 'scripts'] });
  write(root, 'products/daemon/tsconfig.test.json', { compilerOptions: { types: [] }, files: ['src/main.test.ts'] });
  write(root, 'products/daemon/src/main.test.ts', 'export const result: string = 42;');
  const inspection = inspectProductWorkspaces(root, [source]);
  expect(inspection.findings).toEqual([]);
  const compiler = resolve(import.meta.dir, '../../../node_modules/typescript/bin/tsc');
  const projects: string[] = [];
  await expect(executeProductCommands(root, productCheckCommands(root, inspection.products, 'typecheck'), 'typecheck', (executable, args, cwd) => {
    projects.push(args[2]!);
    return spawnSync(executable, [compiler, ...args.slice(1)], { cwd, encoding: 'utf8', timeout: 20_000 });
  })).rejects.toThrow('daemon:tsconfig.test.json failed');
  expect(projects).toEqual([join(root, 'products/daemon/tsconfig.json'), join(root, 'products/daemon/tsconfig.test.json')]);
});

test('strict structural completion requires all module mappings and reviewable parity, proof and audit artifacts', () => {
  const root = fixture();
  for (const name of ['parity', 'proof', 'patternAudit']) write(root, `evidence/${name}.txt`, `Fixture ${name} evidence`);
  mutate(root, 'products/daemon/migration.json', (value) => {
    value.mappings = [{ source: 'src/main.ts', disposition: 'PORT', targets: ['products/daemon/src/main.ts'] }];
    value.verification = { parity: 'evidence/parity.txt', proof: 'evidence/proof.txt', patternAudit: 'evidence/patternAudit.txt' };
  });
  expect(inspectProductWorkspaces(root, [source], true).findings).toEqual([]);
  rmSync(join(root, 'evidence/proof.txt'));
  expect(inspectProductWorkspaces(root, [source], true).findings).toContain('products/daemon: missing proof evidence file');
});

test('empty shells, empty-success scripts and missing script files cannot green the gate', () => {
  const root = fixture();
  write(root, 'products/daemon/src/main.ts', '// no implementation\n');
  rmSync(join(root, 'products/daemon/src/main.test.ts'));
  mutate(root, 'products/daemon/package.json', (value) => { value.scripts = { build: 'echo pending', typecheck: 'true', test: 'bun scripts/missing.ts' }; });
  const findings = inspectProductWorkspaces(root, [source]).findings.join('\n');
  expect(findings).toContain('missing or empty source entrypoint');
  expect(findings).toContain('no actual test source');
  expect(findings).toContain('build must be a real failing check');
  expect(findings).toContain('typecheck must be a real failing check');
  expect(findings).toContain('test references missing script/source');
});

test('legacy dependencies, private engine imports and cross-workspace relative imports fail', () => {
  const root = fixture();
  mutate(root, 'products/daemon/package.json', (value) => { value.dependencies = { '@pellux/goodvibes-sdk': '2.0.23' }; });
  write(root, 'products/daemon/src/main.ts', "import x from '@pellux/goodvibes-sdk'; import y from '@goodvibes-jev/engine/sdk/private'; import z from '../../../packages/engine/sdk/src/index.ts'; export { x, y, z };");
  const findings = inspectProductWorkspaces(root, [source]).findings.join('\n');
  expect(findings).toContain('engine must be a workspace:* dependency');
  expect(findings).toContain('legacy dependency');
  expect(findings).toContain('legacy import');
  expect(findings).toContain('undeclared engine subpath');
  expect(findings).toContain('cross-workspace relative import');
});

test('selective TypeScript includes cannot hide source, tests or tooling from whole-tree checks', () => {
  const root = fixture();
  write(root, 'products/daemon/tsconfig.json', { files: ['src/main.ts'] });
  write(root, 'products/daemon/tsconfig.test.json', { files: ['src/main.test.ts'] });
  const findings = inspectProductWorkspaces(root, [source]).findings.join('\n');
  expect(findings).toContain('scripts/build.ts: source/test/tooling file is outside every TypeScript project');
  expect(findings).toContain('scripts/test.ts: source/test/tooling file is outside every TypeScript project');
});

test('inherited options are not compiled as projects and cannot hide unowned source files', async () => {
  const root = fixture();
  write(root, 'products/daemon/tsconfig.base.json', { compilerOptions: { target: 'ES2022', types: [], noEmit: true } });
  write(root, 'products/daemon/tsconfig.json', { extends: './tsconfig.base.json', compilerOptions: { jsx: 'preserve' }, include: ['src', 'scripts'] });
  write(root, 'products/daemon/tsconfig.test.json', { extends: './tsconfig.base.json', compilerOptions: { jsx: 'preserve' }, include: ['src'] });
  write(root, 'products/daemon/src/main.test.ts', 'export const fixture = true;');
  write(root, 'products/daemon/src/view.tsx', 'declare global { namespace JSX { interface IntrinsicElements { div: Record<string, never>; } } } export const view = <div />;');
  const inspection = inspectProductWorkspaces(root, [source]);
  expect(inspection.findings).toEqual([]);
  const programs = productCheckCommands(root, inspection.products, 'typecheck').filter((command) => command.kind === 'tsconfig');
  const compiler = resolve(import.meta.dir, '../../../node_modules/typescript/bin/tsc');
  await executeProductCommands(root, programs, 'typecheck', (executable, args, cwd) =>
    spawnSync(executable, [compiler, ...args.slice(1)], { cwd, encoding: 'utf8', timeout: 20_000 }));
  write(root, 'products/daemon/unowned/missing.ts', 'export const missing = true;');
  expect(inspectProductWorkspaces(root, [source]).findings.join('\n')).toContain('unowned/missing.ts: source/test/tooling file is outside every TypeScript project');
});

test('imports are parsed as code, including exports and dynamic imports, without reading prose', () => {
  expect(moduleSpecifiers('fixture.ts', "// import x from 'comment';\n const description = 'from prose'; export { x } from 'exported'; import('dynamic'); require('required');")).toEqual(['exported', 'dynamic', 'required']);
  expect(moduleSpecifiers('fixture.ts', '/// <reference types="ambient-types" />\nimport old = require("equals-import");')).toEqual(['ambient-types', 'equals-import']);
});

test('inventory/source drift, duplicate rows and mismatched mapping dispositions fail', () => {
  const root = fixture();
  write(root, source.inventory, '| `other.ts` | HOIST | Fixture |\n');
  mutate(root, 'products/daemon/migration.json', (value) => { value.mappings = [{ source: 'other.ts', disposition: 'PORT', targets: ['products/daemon/src/main.ts'] }]; });
  const findings = inspectProductWorkspaces(root, [source]).findings.join('\n');
  expect(findings).toContain('pinned source file omitted');
  expect(findings).toContain('file absent from pinned source');
  expect(findings).toContain('mapping disagrees with inventory');
  expect(() => inventoryDispositions('| `a` | PORT | A |\n| `a` | JEV | B |', '')).toThrow('Duplicate inventory');
});

test('checked-in sources match their inventories and present product workspaces', () => {
  const root = resolve(import.meta.dir, '../../..');
  const sources = readProductSources(root);
  const result = inspectProductWorkspaces(root, sources);
  expect(result.findings).toEqual([]);
});


test.each([0, 23])('the product runner drains both piped output streams before ending with status %i', (status) => {
  const root = fixture();
  const runner = resolve(import.meta.dir, '../scripts/product-workspaces.ts');
  const outputSize = 1024 * 1024;
  write(root, 'output-fixture.ts', `
    import { executeProductCommands } from ${JSON.stringify(runner)};
    await executeProductCommands(${JSON.stringify(root)}, [
      { kind: 'script', label: 'fixture:test', cwd: ${JSON.stringify(root)}, script: 'test' },
    ], 'test', () => ({
      status: ${status}, signal: null,
      stdout: 'O'.repeat(${outputSize}) + '\\nSTDOUT-END\\n',
      stderr: 'E'.repeat(${outputSize}) + '\\nSTDERR-END\\n',
    }));
  `);
  const run = spawnSync('bun', [join(root, 'output-fixture.ts')], { cwd: root, encoding: 'utf8', maxBuffer: 4 * outputSize });
  expect(run.error).toBeUndefined();
  expect(run.status).toBe(status === 0 ? 0 : 1);
  expect(run.stdout).toContain('O'.repeat(outputSize) + '\nSTDOUT-END\n');
  expect(run.stderr).toContain('E'.repeat(outputSize) + '\nSTDERR-END\n');
  expect(run.stdout).not.toContain('STDERR-END');
  expect(run.stderr).not.toContain('STDOUT-END');
  if (status !== 0) expect(run.stderr).toContain('fixture:test failed (exit code 23, signal none)');
});

test('product failures report a child signal and cannot run later commands', async () => {
  const root = fixture();
  const command = productCheckCommands(root, inspectProductWorkspaces(root, [source]).products, 'build')[0]!;
  let calls = 0;
  await expect(executeProductCommands(root, [command, command], 'build', () => {
    calls += 1;
    return { status: null, signal: 'SIGTERM', stdout: '', stderr: '' };
  })).rejects.toThrow('daemon:build failed (exit code null, signal SIGTERM)');
  expect(calls).toBe(1);
});

test('product failures retain spawn errors alongside missing exit status', async () => {
  const root = fixture();
  const commands = productCheckCommands(root, inspectProductWorkspaces(root, [source]).products, 'build');
  await expect(executeProductCommands(root, commands, 'build', () => ({
    status: null, signal: null, stdout: '', stderr: '', error: new Error('spawn bun ENOENT'),
  }))).rejects.toThrow('daemon:build failed (exit code null, signal none): spawn bun ENOENT');
});


test.each([0, 23])('real product commands inherit both complete output streams at exit %i', (status) => {
  const root = fixture();
  const runner = resolve(import.meta.dir, '../scripts/product-workspaces.ts');
  const outputSize = 1024 * 1024;
  write(root, 'package.json', { scripts: { test: 'bun child.ts' } });
  write(root, 'child.ts', `
    await Promise.all([
      new Promise<void>((resolve, reject) => process.stdout.write('O'.repeat(${outputSize}) + '\\nSTDOUT-END\\n', (error) => error ? reject(error) : resolve())),
      new Promise<void>((resolve, reject) => process.stderr.write('E'.repeat(${outputSize}) + '\\nSTDERR-END\\n', (error) => error ? reject(error) : resolve())),
    ]);
    process.exit(${status});
  `);
  write(root, 'output-fixture.ts', `
    import { executeProductCommands } from ${JSON.stringify(runner)};
    await executeProductCommands(${JSON.stringify(root)}, [
      { kind: 'script', label: 'fixture:test', cwd: ${JSON.stringify(root)}, script: 'test' },
    ], 'test');
  `);
  const run = spawnSync('bun', [join(root, 'output-fixture.ts')], { cwd: root, encoding: 'utf8', maxBuffer: 4 * outputSize, timeout: 10_000 });
  expect(run.error).toBeUndefined();
  expect(run.status).toBe(status === 0 ? 0 : 1);
  expect(run.stdout).toContain('O'.repeat(outputSize) + '\nSTDOUT-END\n');
  expect(run.stderr).toContain('E'.repeat(outputSize) + '\nSTDERR-END\n');
  expect(run.stdout).not.toContain('STDERR-END');
  expect(run.stderr).not.toContain('STDOUT-END');
  if (status !== 0) expect(run.stderr).toContain('fixture:test failed (exit code 23, signal none)');
});

test('real product progress reaches both outer sinks before the command exits', async () => {
  const root = fixture();
  const runner = resolve(import.meta.dir, '../scripts/product-workspaces.ts');
  write(root, 'package.json', { scripts: { test: 'bun child.ts' } });
  write(root, 'child.ts', `
    import { existsSync } from 'node:fs';
    console.log('LIVE-STDOUT');
    console.error('LIVE-STDERR');
    const deadline = Date.now() + 5_000;
    while (!existsSync('release')) {
      if (Date.now() > deadline) throw new Error('outer sinks did not receive live output');
      await Bun.sleep(10);
    }
    console.log('CHILD-FINISHED');
  `);
  write(root, 'output-fixture.ts', `
    import { executeProductCommands } from ${JSON.stringify(runner)};
    await executeProductCommands(${JSON.stringify(root)}, [
      { kind: 'script', label: 'fixture:test', cwd: ${JSON.stringify(root)}, script: 'test' },
    ], 'test');
  `);
  const child = spawn('bun', [join(root, 'output-fixture.ts')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let released = false;
  const release = (): void => {
    if (!released && stdout.includes('LIVE-STDOUT') && stderr.includes('LIVE-STDERR')) {
      expect(stdout).not.toContain('CHILD-FINISHED');
      released = true;
      write(root, 'release', 'observed both streams while running');
    }
  };
  child.stdout.on('data', (chunk) => { stdout += String(chunk); release(); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); release(); });
  const status = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  expect(released).toBe(true);
  expect(status, stderr).toBe(0);
  expect(stdout).toContain('CHILD-FINISHED');
}, 10_000);


test('product matrix and explicit lanes cover all present declared suites exactly once', () => {
  const root = fixture();
  const daemon = inspectProductWorkspaces(root, [source]).products[0]!;
  const products = ['daemon', 'tui', 'agent', 'webui'].map((name) => ({
    ...daemon, source: { ...source, name: name as ProductSource['name'], path: `products/${name}` },
  }));
  // Exercise every nonempty subset, including main and the two product branches.
  for (let mask = 1; mask < 16; mask++) {
    const present = products.filter((_, index) => mask & (1 << index));
    const matrix = productTestMatrix({ products: present, findings: [], missing: [] });
    expect(matrix).toEqual(present.map((product) => product.source.name));
    const aggregate = productCheckCommands(root, present, 'test');
    const lanes = matrix.flatMap((name) => productCheckCommands(root, selectProductWorkspaces(present, [name]), 'test'));
    expect(lanes).toEqual([...aggregate]);
    expect(selectProductWorkspaces(present, [])).toBe(present);
    expect(selectProductWorkspaces(present, [...matrix].reverse())).toEqual(present);
  }
});

test('product selectors and matrix reject omissions disguised as successful selection', () => {
  const root = fixture();
  const inspection = inspectProductWorkspaces(root, [source]);
  expect(() => selectProductWorkspaces(inspection.products, ['deamon'])).toThrow('Unknown product selector');
  expect(() => selectProductWorkspaces(inspection.products, ['tui'])).toThrow('Selected product tui is not present');
  expect(() => selectProductWorkspaces(inspection.products, ['daemon', 'daemon'])).toThrow('Duplicate product selector');
  expect(() => productTestMatrix({ products: [], missing: [], findings: [] })).toThrow('No present product');
  expect(() => productTestMatrix({ ...inspection, findings: ['unselected product is invalid'] })).toThrow('unselected product is invalid');
  expect(() => productTestMatrix({ ...inspection, products: [...inspection.products, ...inspection.products] })).toThrow('Duplicate product selector');
});


test('the product matrix CLI emits only complete inspected JSON and refuses selectors', () => {
  const root = resolve(import.meta.dir, '../../..');
  const runner = join(root, 'packages/engine/scripts/product-workspaces.ts');
  const expected = productTestMatrix(inspectProductWorkspaces(root, readProductSources(root)));
  const run = spawnSync('bun', [runner, 'matrix'], { cwd: root, encoding: 'utf8', timeout: 10_000 });
  expect(run.error).toBeUndefined();
  expect(run.status, run.stderr).toBe(0);
  expect(JSON.parse(run.stdout)).toEqual(expected);
  const filtered = spawnSync('bun', [runner, 'matrix', 'daemon'], { cwd: root, encoding: 'utf8', timeout: 10_000 });
  expect(filtered.status).toBe(1);
  expect(filtered.stderr).toContain('matrix does not accept product selectors');
});


function canonicalFixture(scope: 'engine' | 'workspace' = 'engine') {
  const root = fixture();
  const target = scope === 'engine' ? 'packages/engine/shared.ts' : 'workspace-tool.ts';
  write(root, target, 'export const realOwner = true;');
  write(root, 'docs/audit/owner.md', 'The original source is implemented by the shared owner; fixture evidence only.');
  const mapping = { source: 'src/main.ts', disposition: 'PORT', targets: [target],
    canonicalOwner: { scope, reason: 'Existing canonical implementation replaces duplicate product ownership.', evidence: ['docs/audit/owner.md'] } };
  mutate(root, 'products/daemon/migration.json', (value) => { value.mappings = [mapping]; });
  return { root, target, mapping };
}

test('explicit canonical owners preserve original PORT disposition while admitting real shared files', () => {
  for (const scope of ['engine', 'workspace'] as const) {
    const { root } = canonicalFixture(scope);
    expect(inspectProductWorkspaces(root, [source]).findings).toEqual([]);
    expect(inventoryDispositions(readFileSync(join(root, source.inventory), 'utf8'), '').get('src/main.ts')).toBe('PORT');
  }
});

test('canonical ownership cannot bypass missing original rows or strict parity/proof/audit evidence', () => {
  const { root } = canonicalFixture();
  write(root, source.inventory, '| `src/main.ts` | PORT | Original |\n| `src/other.ts` | PORT | Still missing |\n');
  const findings = inspectProductWorkspaces(root, [{ ...source, files: ['src/main.ts', 'src/other.ts'] }], true).findings.join('\n');
  expect(findings).toContain('source module not accounted for: src/other.ts');
  for (const evidence of ['parity', 'proof', 'patternAudit']) expect(findings).toContain(`missing ${evidence} evidence file`);
});

for (const [name, owner] of [
  ['null metadata', null], ['array metadata', []],
  ['unknown scope', { scope: 'anywhere', reason: 'reason', evidence: ['docs/audit/owner.md'] }],
  ['unknown keys', { scope: 'engine', reason: 'reason', evidence: ['docs/audit/owner.md'], waiveParity: true }],
  ['missing reason', { scope: 'engine', evidence: ['docs/audit/owner.md'] }],
  ['empty reason', { scope: 'engine', reason: '  ', evidence: ['docs/audit/owner.md'] }],
  ['missing evidence', { scope: 'engine', reason: 'reason' }],
  ['empty evidence', { scope: 'engine', reason: 'reason', evidence: [] }],
  ['nonstring evidence', { scope: 'engine', reason: 'reason', evidence: [false] }],
  ['duplicate evidence', { scope: 'engine', reason: 'reason', evidence: ['docs/audit/owner.md', 'docs/audit/owner.md'] }],
  ['missing evidence file', { scope: 'engine', reason: 'reason', evidence: ['docs/audit/missing.md'] }],
  ['escaped evidence', { scope: 'engine', reason: 'reason', evidence: ['../outside.md'] }],
] as const) {
  test(`canonical ownership rejects ${name}`, () => {
    const { root, mapping } = canonicalFixture();
    mutate(root, 'products/daemon/migration.json', (value) => { value.mappings = [{ ...mapping, canonicalOwner: owner }]; });
    expect(inspectProductWorkspaces(root, [source]).findings.join('\n')).toContain('canonicalOwner');
  });
}

test('canonical ownership rejects empty and out-of-workspace symlink evidence', () => {
  const { root } = canonicalFixture();
  write(root, 'docs/audit/owner.md', ' \n');
  expect(inspectProductWorkspaces(root, [source]).findings.join('\n')).toContain('empty or outside-workspace canonicalOwner evidence');
  const other = fixture(false); write(other, 'evidence.md', 'An outside file must not count.');
  rmSync(join(root, 'docs/audit/owner.md'));
  symlinkSync(join(other, 'evidence.md'), join(root, 'docs/audit/owner.md'));
  expect(inspectProductWorkspaces(root, [source]).findings.join('\n')).toContain('outside-workspace canonicalOwner evidence');
});

for (const [scope, target] of [
  ['engine', 'workspace-tool.ts'], ['engine', 'packages/other/shared.ts'], ['engine', 'products/daemon/src/main.ts'],
  ['workspace', 'packages/engine/shared.ts'], ['workspace', 'packages/other/shared.ts'], ['workspace', 'products/daemon/src/main.ts'],
  ['workspace', 'products/other/shared.ts'],
] as const) {
  test(`canonical ${scope} owner refuses target ${target}`, () => {
    const { root, mapping } = canonicalFixture(scope);
    write(root, target, 'export const wrongOwner = true;');
    mutate(root, 'products/daemon/migration.json', (value) => { value.mappings = [{ ...mapping, targets: [target] }]; });
    expect(inspectProductWorkspaces(root, [source]).findings.join('\n')).toContain('target does not belong to canonicalOwner');
  });
}

test('canonical ownership rejects absent and escaped targets, even with valid evidence', () => {
  const { root, mapping } = canonicalFixture();
  for (const target of ['packages/engine/missing.ts', '../outside.ts', join(root, 'packages/engine/shared.ts')]) {
    mutate(root, 'products/daemon/migration.json', (value) => { value.mappings = [{ ...mapping, targets: [target] }]; });
    expect(inspectProductWorkspaces(root, [source]).findings.join('\n')).toContain('missing or outside-workspace target');
  }
});

test('canonical ownership cannot use an in-workspace symlink to change the actual owner', () => {
  for (const scope of ['engine', 'workspace'] as const) {
    const { root, target } = canonicalFixture(scope);
    rmSync(join(root, target));
    symlinkSync(join(root, 'products/daemon/src/main.ts'), join(root, target));
    expect(inspectProductWorkspaces(root, [source]).findings.join('\n')).toContain('target does not belong to canonicalOwner');
  }
});

for (const disposition of ['HOIST', 'JEV', 'DROP'] as const) {
  test(`canonical ownership cannot override an original ${disposition} disposition`, () => {
    const { root, mapping } = canonicalFixture();
    write(root, source.inventory, `| \`src/main.ts\` | ${disposition} | Original |\n`);
    mutate(root, 'products/daemon/migration.json', (value) => { value.mappings = [{ ...mapping, disposition }]; });
    expect(inspectProductWorkspaces(root, [source]).findings.join('\n')).toContain('canonicalOwner is only allowed for original PORT rows');
  });
}

test('canonical ownership never authorizes changing the original disposition', () => {
  const { root, mapping } = canonicalFixture();
  mutate(root, 'products/daemon/migration.json', (value) => { value.mappings = [{ ...mapping, disposition: 'HOIST' }]; });
  expect(inspectProductWorkspaces(root, [source]).findings.join('\n')).toContain('mapping disagrees with inventory');
});

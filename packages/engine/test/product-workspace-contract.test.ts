import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { inspectProductWorkspaces, inventoryDispositions, moduleSpecifiers, productCheckCommands, readProductSources, type ProductSource } from '../scripts/product-workspace-contract.ts';
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

test('a real partial workspace participates in build, tests and every declared typecheck', () => {
  const root = fixture();
  const inspection = inspectProductWorkspaces(root, [source]);
  expect(inspection.findings).toEqual([]);
  for (const mode of ['build', 'test'] as const) expect(productCheckCommands(root, inspection.products, mode)).toEqual([{ kind: 'script', label: `daemon:${mode}`, cwd: join(root, source.path), script: mode }]);
  expect(productCheckCommands(root, inspection.products, 'typecheck').map((command) => command.kind === 'script' ? command.script : command.file.split('/').at(-1))).toEqual(['tsconfig.json', 'tsconfig.test.json', 'typecheck', 'typecheck:test']);
  expect(inspectProductWorkspaces(root, [source], true).findings).toContain('products/daemon: source module not accounted for: src/main.ts');
});

test('the product command runner executes the declared build and propagates its failure', () => {
  const root = fixture();
  const commands = productCheckCommands(root, inspectProductWorkspaces(root, [source]).products, 'build');
  write(root, 'products/daemon/scripts/build.ts', "import { writeFileSync } from 'node:fs'; writeFileSync('build-marker', 'built');");
  executeProductCommands(root, commands, 'build');
  expect(readFileSync(join(root, 'products/daemon/build-marker'), 'utf8')).toBe('built');
  write(root, 'products/daemon/scripts/build.ts', 'process.exit(7);');
  expect(() => executeProductCommands(root, commands, 'build')).toThrow('daemon:build failed');
});

test('a product typecheck printing errors cannot report success with exit zero', () => {
  const root = fixture();
  const commands = productCheckCommands(root, inspectProductWorkspaces(root, [source]).products, 'typecheck');
  expect(() => executeProductCommands(root, commands, 'typecheck', () => ({ status: 0, stdout: 'file.ts(1,1): error TS2322: incompatible type\n', stderr: '' }))).toThrow('failed');
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

test('all four real pinned source snapshots exactly match their inventories', () => {
  const root = resolve(import.meta.dir, '../../..');
  const sources = readProductSources(root);
  expect(sources.map((product) => [product.name, product.files.length])).toEqual([['daemon', 281], ['tui', 1618], ['agent', 1602], ['webui', 608]]);
  const result = inspectProductWorkspaces(root, sources);
  expect(result.findings).toEqual([]);
  const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts as Record<string, string>;
  expect(scripts.build).toContain('products:build');
  expect(scripts.test).toContain('products:test');
  expect(readFileSync(join(root, 'packages/engine/scripts/typecheck.ts'), 'utf8')).toContain("args: ['run', 'products:typecheck']");
  expect(scripts['migration:complete']).toContain('product-workspaces.ts complete');
});

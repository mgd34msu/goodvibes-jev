/** Original daemon optional-operation assertions over its installed workspace engine graph. */
import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { makeOwnedTempDir } from '../helpers/owned-temp.ts';
const productRoot = resolve(import.meta.dir, '../../..');
const productRequire = createRequire(join(productRoot, 'package.json'));
const engineManifest = productRequire.resolve('@goodvibes-jev/engine/package.json');
const engineRequire = createRequire(engineManifest);

test('daemon consumes its installed workspace engine rather than an external overlay', () => {
  const product = JSON.parse(readFileSync(join(productRoot, 'package.json'), 'utf8'));
  expect(product.dependencies['@goodvibes-jev/engine']).toBe('workspace:*');
  expect(JSON.parse(readFileSync(engineManifest, 'utf8')).name).toBe('@goodvibes-jev/engine');
  expect(realpathSync(dirname(engineManifest))).toBe(dirname(realpathSync(resolve(productRoot, '../../packages/engine/package.json'))));
  expect(product.scripts['sdk-dev']).toBeUndefined();
});

test('installed sql.js creates a table and reads its row', async () => {
  const { default: initSqlJs } = await import(engineRequire.resolve('sql.js'));
  const SQL = await initSqlJs(); const db = new SQL.Database();
  try {
    db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)');
    db.run('INSERT INTO t VALUES (1, ?)', ['hello']);
    const result = db.exec('SELECT val FROM t WHERE id = 1');
    expect(result.length).toBe(1); expect(result[0].values[0][0]).toBe('hello');
  } finally { db.close(); }
});

test('installed jszip builds an archive and reads the entry', async () => {
  const { default: JSZip } = await import(engineRequire.resolve('jszip'));
  const zip = new JSZip(); zip.file('note.txt', 'hello');
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  expect(bytes.byteLength).toBeGreaterThan(0);
  const reopened = await new JSZip().loadAsync(bytes);
  expect(await reopened.file('note.txt').async('string')).toBe('hello');
});

test('installed ast-grep parses TypeScript and finds the declaration', async () => {
  const { parse } = await import(engineRequire.resolve('@ast-grep/napi'));
  const root = parse('TypeScript', 'function hello(name: string): string { return name; }');
  const funcs = root.root().findAll({ rule: { kind: 'function_declaration' } });
  expect(funcs.length).toBeGreaterThan(0);
});

for (const [pkg, file] of [
  ['tree-sitter-typescript', 'tree-sitter-typescript.wasm'],
  ['tree-sitter-typescript', 'tree-sitter-tsx.wasm'],
  ['tree-sitter-javascript', 'tree-sitter-javascript.wasm'],
  ['tree-sitter-python', 'tree-sitter-python.wasm'],
  ['tree-sitter-json', 'tree-sitter-json.wasm'],
  ['tree-sitter-css', 'tree-sitter-css.wasm'],
  ['web-tree-sitter', 'web-tree-sitter.wasm'],
] as const) test(`installed ${pkg} ships ${file}`, () => {
  expect(existsSync(engineRequire.resolve(`${pkg}/${file}`))).toBe(true);
});

test('installed web-tree-sitter initializes its actual WASM runtime', async () => {
  const mod = await import(engineRequire.resolve('web-tree-sitter'));
  const Parser = mod.Parser ?? mod.default; await Parser.init();
  expect(Parser.init).toBeFunction();
});


test('the actual native prebuild CLI refuses version drift without implicit synchronization', () => {
  const root = makeOwnedTempDir('daemon-prebuild-policy');
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'scripts/check-version.ts'), readFileSync(join(productRoot, 'scripts/check-version.ts')));
  const manifest = JSON.stringify({ name: '@goodvibes-jev/daemon', version: '1.2.3' });
  const version = "let _version = '1.2.2';\n";
  writeFileSync(join(root, 'package.json'), manifest); writeFileSync(join(root, 'src/version.ts'), version);
  const result = Bun.spawnSync([process.execPath, 'scripts/check-version.ts'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  expect(result.exitCode).toBe(1);
  expect(new TextDecoder().decode(result.stderr)).toContain('fallback must match package.json');
  expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(manifest);
  expect(readFileSync(join(root, 'src/version.ts'), 'utf8')).toBe(version);
  const configuration = JSON.parse(readFileSync(join(productRoot, 'toolchain.config.json'), 'utf8'));
  expect(configuration.build.prebuild).toEqual([['bun', 'run', 'scripts/check-version.ts']]);
  expect(configuration.build.compileDriver).toBe('scripts/compile.ts');
});

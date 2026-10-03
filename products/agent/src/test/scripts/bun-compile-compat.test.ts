import { expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { bunCompileCompatibilityFiles } from '../../../scripts/bun-compile-compat.ts';
import { parseCompileArgs } from '../../../scripts/compile.ts';

const root = resolve(import.meta.dir, '../../..');
const engineRequire = createRequire(createRequire(join(root, 'package.json')).resolve('@goodvibes-jev/engine/package.json'));
const jsdomRoot = dirname(engineRequire.resolve('jsdom/package.json'));
const jsdomRequire = createRequire(join(jsdomRoot, 'package.json'));
const cssRoot = dirname(jsdomRequire.resolve('css-tree/package.json'));
const jsdomFiles = ['lib/jsdom/living/xhr/XMLHttpRequest-impl.js', 'lib/jsdom/living/css/helpers/computed-style.js', 'lib/jsdom/browser/default-stylesheet.css'];
const cssFiles = ['lib/data-patch.js', 'lib/data.js', 'lib/version.js'];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agent-compile-owners-'));
  const engine = join(root, 'packages/engine');
  const dom = join(root, 'store/jsdom');
  const css = join(root, 'store/css-tree');
  for (const dir of ['node_modules/@goodvibes-jev', 'packages/engine/node_modules', 'store/jsdom/node_modules', 'store/css-tree']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'agent-fixture', dependencies: { '@goodvibes-jev/engine': 'workspace:*' } }));
  writeFileSync(join(engine, 'package.json'), JSON.stringify({ name: '@goodvibes-jev/engine', version: '1.0.0', optionalDependencies: { jsdom: '29.1.1' } }));
  writeFileSync(join(dom, 'package.json'), JSON.stringify({ name: 'jsdom', version: '29.1.1', dependencies: { 'css-tree': '3.2.1' } }));
  writeFileSync(join(css, 'package.json'), JSON.stringify({ name: 'css-tree', version: '3.2.1' }));
  symlinkSync(engine, join(root, 'node_modules/@goodvibes-jev/engine'));
  symlinkSync(dom, join(engine, 'node_modules/jsdom'));
  symlinkSync(css, join(dom, 'node_modules/css-tree'));
  for (const [sourceRoot, targetRoot, files] of [[jsdomRoot, dom, jsdomFiles], [cssRoot, css, cssFiles]] as const) {
    for (const file of files) {
      mkdirSync(dirname(join(targetRoot, file)), { recursive: true });
      copyFileSync(join(sourceRoot, file), join(targetRoot, file));
    }
  }
  return { root, dom, css };
}

test('linked engine-owned jsdom resolves its own css-tree, without modifying either installation', () => {
  const setup = fixture();
  try {
    const target = realpathSync(join(setup.css, 'lib/data-patch.js'));
    const original = readFileSync(target, 'utf8');
    const files = bunCompileCompatibilityFiles(setup.root);
    expect(files[target]).toContain("import patch from '../data/patch.json'");
    expect(files[target]).not.toContain('createRequire');
    expect(Object.keys(files)).toContain(realpathSync(join(setup.dom, 'lib/jsdom/living/css/helpers/computed-style.js')));
    expect(readFileSync(target, 'utf8')).toBe(original);
    expect(bunCompileCompatibilityFiles(setup.root)).toEqual(files);
  } finally { rmSync(setup.root, { recursive: true, force: true }); }
});

test('a changed installed dependency source fails loudly rather than producing a broken binary', () => {
  const setup = fixture();
  try {
    writeFileSync(join(setup.css, 'lib/data-patch.js'), 'unknown upstream source');
    expect(() => bunCompileCompatibilityFiles(setup.root)).toThrow(/Unsupported Bun compile compatibility source/);
  } finally { rmSync(setup.root, { recursive: true, force: true }); }
});

test('a mismatched dependency identity is rejected, not adopted through the owner link', () => {
  const setup = fixture();
  try {
    writeFileSync(join(setup.css, 'package.json'), JSON.stringify({ name: 'different-parser', version: '3.2.1' }));
    expect(() => bunCompileCompatibilityFiles(setup.root)).toThrow(/Invalid installed dependency identity/);
  } finally { rmSync(setup.root, { recursive: true, force: true }); }
});

test('an absent optional parser is left absent', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-compile-absent-'));
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'agent-fixture', optionalDependencies: { jsdom: '29.1.1' } }));
    expect(bunCompileCompatibilityFiles(root)).toEqual({});
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the compile driver accepts structured target/output/external args and rejects unknown switches', () => {
  expect(parseCompileArgs(['src/main.ts', '--compile', '--target=bun-linux-x64', '--outfile', 'dist/space ; literal', '--external', 'sqlite-vec-linux-x64'])).toEqual({
    entrypoint: 'src/main.ts', target: 'bun-linux-x64', outfile: 'dist/space ; literal', external: ['sqlite-vec-linux-x64'],
  });
  expect(() => parseCompileArgs(['src/main.ts', '--compile', '--target=bun-plan9-x64', '--outfile', 'dist/app'])).toThrow(/supported target/);
  expect(() => parseCompileArgs(['src/main.ts', '--preload', 'unknown.ts'])).toThrow(/Unsupported/);
  expect(() => parseCompileArgs(['src/main.ts', '--external'])).toThrow(/requires a value/);
});

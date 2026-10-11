import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { daemonArchitecture } from '../scripts/daemon-architecture-check.ts';
import { runtimeArchitectureProblems, runtimeImportSpecifiers } from '../scripts/runtime-import-architecture.ts';

function fixture(run: (root: string, put: (path: string, body: string) => string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'runtime-architecture-'));
  const put = (path: string, body: string): string => { const file = join(root, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, body); return file; };
  try { run(root, put); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('syntax reader excludes comments and erased edges without hiding a value import of the same module', () => {
  expect(runtimeImportSpecifiers(`
    // import { pretend } from './fake.ts';
    import type { A } from './both.js';
    import { A } from './both.js';
    import { type B } from './types.ts';
    export type { C } from './types.ts';
    export { type D } from './types.ts';
    import './side-effect.ts';
    export * from './reexport.ts';
    const x = require('./required.ts');
    import Alias = require('./alias.ts');
  `)).toEqual(['./both.js', './side-effect.ts', './reexport.ts', './required.ts', './alias.ts']);
});
test('SCC detection resolves .js source edges, extensionless and directory index edges; type edges do not form cycles', () => fixture((root, put) => {
  const a = put('a.ts', "import './b.js';");
  const b = put('b.ts', "export * from './nested';");
  const c = put('nested/index.ts', "const a = require('../a');");
  const input = { files: [a, b, c], layer: () => undefined, rules: [] };
  expect(runtimeArchitectureProblems(input)).toHaveLength(1);
  expect(runtimeArchitectureProblems(input)[0]).toContain('runtime import cycle');
  put('a.ts', "import type { B } from './b.js';");
  expect(runtimeArchitectureProblems(input)).toEqual([]);
  put('a.ts', "import './a.js';");
  expect(runtimeArchitectureProblems(input)[0]).toContain('runtime import cycle');
}));
test('all four adapted boundaries reject real dependency edges, including hoisted cluster readers', () => fixture((root, put) => {
  const product = 'products/daemon/src/';
  for (const file of ['config/value.ts', 'core/value.ts', 'cli/parser.ts', 'cli/entrypoint.ts', 'runtime/value.ts']) put(product + file, 'export {};');
  put('packages/engine/terminal-shell/src/daemon-ws-call.ts', 'export {};');
  put('packages/engine/terminal-shell/src/raw-reply-route.ts', 'export {};');
  expect(runtimeArchitectureProblems(daemonArchitecture(root))).toEqual([]);
  const owners: Record<string, string> = {
    config: product + 'config/value.ts', core: product + 'core/value.ts', cli: product + 'cli/parser.ts',
    daemon: product + 'cli/entrypoint.ts', runtime: product + 'runtime/value.ts',
    cluster: 'packages/engine/terminal-shell/src/daemon-ws-call.ts',
  };
  const input = daemonArchitecture(root);
  for (const rule of input.rules) for (const target of rule.forbidden) {
    const fromFile = owners[rule.from]!;
    const targetFile = owners[target]!;
    const specifier = './' + relative(dirname(join(root, fromFile)), join(root, targetFile)).replace(/\.ts$/, '.js');
    put(fromFile, `import '${specifier}';`);
    expect(runtimeArchitectureProblems(daemonArchitecture(root)).some((problem) => problem.startsWith(`layer ${rule.from}:`))).toBe(true);
    put(fromFile, 'export {};');
  }
  put(product + 'runtime/value.ts', "import '../cli/entrypoint.js';");
  expect(runtimeArchitectureProblems(daemonArchitecture(root))).toEqual([]);
  // A newly added catalog file cannot silently become a composition exemption.
  put(product + 'cli/new-catalog.ts', "import './entrypoint.js';");
  expect(runtimeArchitectureProblems(daemonArchitecture(root))[0]).toContain('layer cli');
}));
test('missing mapped owners fail instead of making the boundary vacuous; test sources are excluded', () => fixture((root, put) => {
  put('products/daemon/src/cli/parser.ts', 'export {};');
  put('products/daemon/src/test/bad.test.ts', "import './bad.test.ts';");
  // Missing canonical cluster inputs refuse at file-read time as well.
  expect(() => runtimeArchitectureProblems(daemonArchitecture(root))).toThrow();
  put('packages/engine/terminal-shell/src/daemon-ws-call.ts', 'export {};');
  put('packages/engine/terminal-shell/src/raw-reply-route.ts', 'export {};');
  expect(runtimeArchitectureProblems(daemonArchitecture(root))).toContain('empty layer: config');
  expect(daemonArchitecture(root).files.some((file) => file.includes('/test/'))).toBe(false);
}));
test('the real daemon runtime and canonical cluster owners satisfy the adapted gate', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const input = daemonArchitecture(root);
  expect(input.files.length).toBeGreaterThan(80);
  expect(input.rules).toHaveLength(4);
  expect(runtimeArchitectureProblems(input)).toEqual([]);
});

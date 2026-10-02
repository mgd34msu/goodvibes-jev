import { describe, expect, test } from 'bun:test';
import { runPostBuildSmoke, scanArtifactForEagerNamespaceReads } from '../../toolchain/src/lib/post-build-smoke.ts';
import { captureLogger } from '../../toolchain/src/lib/effects.ts';

// The same unminified module/getter/initializer shapes emitted by Bun 1.3.14.
// Names deliberately differ from the dependency that exposed the false positive.
const HELPER = 'var __esm = (fn, res) => () => (fn && (res = fn(fn = 0)), res);\n';
const NAMESPACE = `// node_modules/example/external.js
var exports_fixture = {};
__export(exports_fixture, {
  construct: () => construct
});
var init_fixture = __esm(() => {
  init_dependency();
});
`;
const DEPENDENCY = `// node_modules/example/dependency.js
function construct() { return { ready: true }; }
var init_dependency = __esm(() => {
  ready = true;
});
`;
const WRAPPERS = `// node_modules/example/classic.js
var init_classic = __esm(() => {
  init_fixture();
  init_fixture();
});
// node_modules/example/index.js
var init_entry = __esm(() => {
  init_classic();
});
`;
const CALL = 'var Schema = exports_fixture.construct();';
const HIT = ['var Schema = exports_fixture.construct'];
const fixture = (prefix = 'init_entry();\n', read = CALL, wrappers = WRAPPERS) =>
  `${HELPER}${DEPENDENCY}${NAMESPACE}${wrappers}// src/schema.ts\n${prefix}${read}\n`;

describe('emitted namespace-call initializer dominance', () => {
  test('accepts a synchronous re-export chain before a constructor call', () => {
    expect(scanArtifactForEagerNamespaceReads(fixture())).toEqual([]);
  });
  test('accepts the namespace initializer called directly', () => {
    expect(scanArtifactForEagerNamespaceReads(fixture('init_fixture();\n'))).toEqual([]);
  });
  test('accepts every call after the same module prefix, without a namespace allowlist', () => {
    const text = fixture('init_entry();\n', `${CALL}\nvar Second = exports_fixture.construct({});`)
      .replaceAll('exports_fixture', 'exports_renamed').replaceAll('init_fixture', 'init_renamed');
    expect(scanArtifactForEagerNamespaceReads(text)).toEqual([]);
  });
  test('does not turn a dominating initializer into a direct-alias exception', () => {
    expect(scanArtifactForEagerNamespaceReads(fixture('init_entry();\n', 'var Schema = exports_fixture.construct;'))).toEqual(HIT);
  });
  test.each([
    ['', CALL],
    ['', `${CALL}\ninit_entry();`],
    ['if (ready) init_entry();\n', CALL],
    ['if (ready) {\ninit_entry();\n}\n', CALL],
    ['function later() {\ninit_entry();\n}\n', CALL],
    ['ready && init_entry();\n', CALL],
    ['// init_entry();\n', CALL],
    ['// other.ts\n', CALL],
  ])('retains missing, later, conditional, nested and commented root calls: %s', (prefix, read) => {
    expect(scanArtifactForEagerNamespaceReads(fixture(prefix, read))).toEqual(HIT);
  });
  test('does not inherit an initializer from another emitted module', () => {
    expect(scanArtifactForEagerNamespaceReads(fixture('init_entry();\n// src/other.ts\n'))).toEqual(HIT);
  });
  test.each([
    WRAPPERS.replace('  init_classic();', '  if (ready) init_classic();'),
    WRAPPERS.replace('  init_classic();', '  ready && init_classic();'),
    WRAPPERS.replace('  init_classic();', '  function later() { init_classic(); }'),
    WRAPPERS.replace('  init_classic();', '  init_missing();'),
    WRAPPERS.replace('  init_classic();', ''),
    WRAPPERS.replace('  init_classic();', '  init_entry();\n  init_classic();'),
    WRAPPERS.replace('  init_classic();', '  init_classic();\n  init_entry();'),
    WRAPPERS.replaceAll('  init_fixture();', '  init_entry();'),
  ])('retains conditional, missing, unrelated and cyclic initializer chains', (wrappers) => {
    expect(scanArtifactForEagerNamespaceReads(fixture('init_entry();\n', CALL, wrappers))).toEqual(HIT);
  });
  test('requires the chain declarations before the module executes', () => {
    expect(scanArtifactForEagerNamespaceReads(`${HELPER}${DEPENDENCY}${NAMESPACE}// src/schema.ts\ninit_entry();\n${CALL}\n${WRAPPERS}`)).toEqual(HIT);
  });
  test('requires the export table and owning initializer in one module', () => {
    expect(scanArtifactForEagerNamespaceReads(fixture().replace('var init_fixture', '// src/unrelated.ts\nvar init_fixture'))).toEqual(HIT);
  });
  test('does not infer ownership from matching namespace/initializer names', () => {
    expect(scanArtifactForEagerNamespaceReads(fixture().replace('__export(exports_fixture, {', '__export(exports_other, {'))).toEqual(HIT);
  });
  test('requires the requested getter in the namespace table', () => {
    expect(scanArtifactForEagerNamespaceReads(fixture().replace('  construct: () => construct', '  unrelated: () => construct'))).toEqual(HIT);
  });
  test('does not accept an async or conditional namespace initializer', () => {
    expect(scanArtifactForEagerNamespaceReads(fixture().replace('var init_fixture = __esm(()', 'var init_fixture = __esm(async ()'))).toEqual(HIT);
    expect(scanArtifactForEagerNamespaceReads(fixture().replace('  init_dependency();', '  if (ready) init_dependency();'))).toEqual(HIT);
  });
  test('requires the known synchronous emitted __esm helper', () => {
    expect(scanArtifactForEagerNamespaceReads(fixture().replace(HELPER, 'var __esm = () => () => {};\n'))).toEqual(HIT);
  });
  test('retains missing, later and ancestor-cycle dependencies in the owning initializer', () => {
    expect(scanArtifactForEagerNamespaceReads(fixture().replace(DEPENDENCY, ''))).toEqual(HIT);
    expect(scanArtifactForEagerNamespaceReads(`${fixture().replace(DEPENDENCY, '')}${DEPENDENCY}`)).toEqual(HIT);
    expect(scanArtifactForEagerNamespaceReads(fixture().replace('  init_dependency();', '  init_entry();'))).toEqual(HIT);
    expect(scanArtifactForEagerNamespaceReads(fixture().replace('  init_dependency();', '  init_fixture();'))).toEqual(HIT);
  });
  test('permits completed cycles inside namespace dependencies, outside the wrapper proof', () => {
    const internalCycle = `// node_modules/example/dependency.js
function construct() { return { ready: true }; }
var init_dependency = __esm(() => {
  init_other();
  ready = true;
});
// node_modules/example/other.js
var init_other = __esm(() => {
  init_dependency();
});
`;
    expect(scanArtifactForEagerNamespaceReads(fixture().replace(DEPENDENCY, internalCycle))).toEqual([]);
  });
  test('fails closed for redefined helpers, duplicate initializers and duplicate namespace tables', () => {
    expect(scanArtifactForEagerNamespaceReads(fixture().replace(HELPER, `${HELPER}var __esm = () => () => {};\n`))).toEqual(HIT);
    expect(scanArtifactForEagerNamespaceReads(fixture().replace(HELPER, `${HELPER}__esm = () => () => {};\n`))).toEqual(HIT);
    expect(scanArtifactForEagerNamespaceReads(fixture().replace(WRAPPERS, `${WRAPPERS}${WRAPPERS}`))).toEqual(HIT);
    expect(scanArtifactForEagerNamespaceReads(fixture().replace(NAMESPACE, `${NAMESPACE}${NAMESPACE}`))).toEqual(HIT);
  });
  test('does not accept an uninitialized getter target or an unrelated owner call', () => {
    expect(scanArtifactForEagerNamespaceReads(fixture().replace('function construct() { return { ready: true }; }', 'var construct;'))).toEqual(HIT);
    expect(scanArtifactForEagerNamespaceReads(fixture().replace('  init_dependency();', '  unrelated();'))).toEqual(HIT);
    expect(scanArtifactForEagerNamespaceReads(fixture().replace('  init_dependency();', '  init_unrelated();')
      .replace('// src/schema.ts', '// node_modules/example/unrelated.js\nvar init_unrelated = __esm(() => {\n  unrelated();\n});\n// src/schema.ts'))).toEqual(HIT);
  });
  test('retains namespace, member and getter-binding reassignment after the prefix', () => {
    for (const assignment of ['exports_fixture = {};', 'var exports_fixture = {};', 'exports_fixture.construct = undefined;', 'exports_fixture["construct"] = undefined;', 'construct = undefined;']) {
      expect(scanArtifactForEagerNamespaceReads(fixture(`init_entry();\n${assignment}\n`))).toEqual(HIT);
    }
  });
  test('rejects reassignment and redeclaration of every participating initializer', () => {
    for (const name of ['init_entry', 'init_classic', 'init_fixture', 'init_dependency']) {
      for (const declaration of ['', 'var ']) {
        const changed = fixture().replace('// src/schema.ts', `${declaration}${name} = () => {};\n// src/schema.ts`);
        expect(scanArtifactForEagerNamespaceReads(changed)).toEqual(HIT);
        expect(scanArtifactForEagerNamespaceReads(fixture(`init_entry();\n${declaration}${name} = () => {};\n`))).toEqual(HIT);
      }
    }
  });
  test('a passing version banner cannot waive an unproven constructor call', () => {
    const result = runPostBuildSmoke({
      binary: 'fixture',
      config: { bannerPrefix: 'goodvibes ', forbiddenStrings: [], binaryDefault: 'fixture' },
      exec: () => ({ status: 0, stdout: 'goodvibes 1.0\n', stderr: '' }),
      logger: captureLogger(), readArtifact: () => fixture(''),
    });
    expect(result.ok).toBe(false);
  });
  test('a proven constructor still goes through the version smoke', () => {
    const result = runPostBuildSmoke({
      binary: 'fixture',
      config: { bannerPrefix: 'goodvibes ', forbiddenStrings: [], binaryDefault: 'fixture' },
      exec: () => ({ status: 0, stdout: 'goodvibes 1.0\n', stderr: '' }),
      logger: captureLogger(), readArtifact: () => fixture(),
    });
    expect(result.ok).toBe(true);
  });
  test('safe constructor calls do not consume the unsafe report limit', () => {
    expect(scanArtifactForEagerNamespaceReads(fixture('init_entry();\n', `${CALL}\nvar alias = exports_fixture.construct;\nvar bad = exports_other.member;`), 1))
      .toEqual(['var alias = exports_fixture.construct']);
  });
});

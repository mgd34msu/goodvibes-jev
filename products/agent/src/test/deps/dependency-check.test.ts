import { describe, expect, test } from 'bun:test';

async function expectImportable(specifier: string): Promise<void> {
  expect(await import(specifier)).toEqual(expect.any(Object));
}

describe('dependency surface', () => {
  test('the browser driver is still resolvable, supplied by the SDK', async () => {
    // Not a declared dependency of this package, but it must be installed:
    // `bun run build` stages node_modules/playwright-core beside the binary.
    await expectImportable('playwright-core');
  });

  test('runtime import entrypoints used by the product resolve from installed dependencies', async () => {
    for (const specifier of [
      '@goodvibes-jev/engine/sdk/platform/config',
      '@goodvibes-jev/engine/sdk/platform/daemon',
      '@goodvibes-jev/engine/sdk/platform/security',
      'sql.js',
      'sqlite-vec',
      'typescript',
      'zustand/vanilla',
    ]) {
      await expectImportable(specifier);
    }
  });
});

describe('sql.js', () => {
  test('initializes an in-memory database and runs a basic query', async () => {
    const initSqlJs = (await import('sql.js')).default;
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    try {
      db.run('CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)');
      db.run('INSERT INTO test VALUES (1, ?)', ['hello']);
      const result = db.exec('SELECT val FROM test WHERE id = 1');
      expect(result).toHaveLength(1);
      expect(result[0]?.values[0]?.[0]).toBe('hello');
    } finally {
      db.close();
    }
  });
});

describe('zustand runtime store dependency', () => {
  test('creates a vanilla store without pulling the React entrypoint', async () => {
    const { createStore } = await import('zustand/vanilla');
    const store = createStore<{ count: number }>(() => ({ count: 1 }));
    expect(store.getState().count).toBe(1);
  });
});

describe('typescript', () => {
  test('transpiles a small TypeScript snippet', async () => {
    const ts = await import('typescript');
    const output = ts.transpileModule('const answer: number = 42;', {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext },
    });
    expect(output.outputText).toContain('const answer = 42');
  });
});

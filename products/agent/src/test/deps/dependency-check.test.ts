import { describe, expect, test } from 'bun:test';
import { DRIVER_VERSION, loadDriverModule, resolveDriver } from '@goodvibes-jev/engine/sdk/platform/browser';

async function expectImportable(specifier: string): Promise<void> {
  expect(await import(specifier)).toEqual(expect.any(Object));
}

describe('dependency surface', () => {
  test('the public engine browser API resolves and loads its owned driver', () => {
    const location = { surfaceRoot: 'agent' };
    // Resolve and load only. This must not launch, provision or download a browser.
    expect(resolveDriver(location)).toMatchObject({ available: true, version: DRIVER_VERSION, error: null });
    expect(loadDriverModule(location)?.chromium.executablePath).toBeFunction();
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

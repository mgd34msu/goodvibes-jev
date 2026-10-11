import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ConfigManager } from '../sdk/src/platform/config/manager.ts';
import { CONFIG_SCHEMA } from '../sdk/src/platform/config/schema.ts';
import { TREE_GLYPHS_CONFIG_KEY, readTreeGlyphSet } from '../sdk/src/platform/runtime/operations.ts';
import { laneGlyphs, resolveTreeGlyphSet } from './fixtures/upstream-tui-tree-glyphs.ts';
import { withTestTimeout } from './_helpers/test-timeout.ts';

describe('read-only tree-glyph presentation', () => {
  test('composes the live reader with the exact upstream renderer and terminal constraint', () => {
    const values: unknown[] = ['rounded', 'square', 'ascii', undefined, null, '', 'SQUARE', ' square ', 0, false, {}, [], () => 'square'];
    for (const value of values) {
      for (const unicodeCapable of [true, false]) {
        const expected = resolveTreeGlyphSet(value, unicodeCapable);
        const actual = readTreeGlyphSet(() => value, unicodeCapable);
        expect(actual).toBe(expected);
        expect(laneGlyphs(actual).role.head).toBe(actual === 'ascii' ? '+' : actual === 'square' ? '┌' : '╭');
      }
    }
  });

  test('reads once per render and applies live style and terminal changes', () => {
    let value: unknown = 'square';
    const keys: string[] = [];
    const get = (key: string): unknown => { keys.push(key); return value; };
    expect(readTreeGlyphSet(get, true)).toBe('square');
    value = 'ascii';
    expect(readTreeGlyphSet(get, true)).toBe('ascii');
    value = 'rounded';
    expect(readTreeGlyphSet(get, false)).toBe('ascii');
    expect(readTreeGlyphSet(get, true)).toBe('rounded');
    value = 'invalid';
    expect(readTreeGlyphSet(get, true)).toBe('rounded');
    expect(keys).toEqual(Array(5).fill('display.treeGlyphs'));
  });

  test('an older or failing getter keeps the terminal renderable', () => {
    for (const error of [new Error('Unknown config key'), new Error('synthetic-private-setting'), null]) {
      expect(readTreeGlyphSet(() => { throw error; }, true)).toBe('rounded');
      expect(readTreeGlyphSet(() => { throw error; }, false)).toBe('ascii');
    }
  });

  test('real ConfigManager reloads apply the registered presentation setting without writing during reads', () => {
    expect(CONFIG_SCHEMA.find((setting) => setting.key === TREE_GLYPHS_CONFIG_KEY)).toMatchObject({
      type: 'enum', default: 'rounded', enumValues: ['rounded', 'square', 'ascii'],
    });
    const directory = mkdtempSync(join(tmpdir(), 'tree-glyph-reader-'));
    const path = join(directory, 'settings.json');
    try {
      writeFileSync(path, '{}');
      const manager = new ConfigManager({ configDir: directory, readOnly: true });
      const get = (key: string): unknown => {
        if (key !== TREE_GLYPHS_CONFIG_KEY) throw new Error('Unexpected setting');
        return manager.get(key);
      };
      expect(readTreeGlyphSet(get, true)).toBe('rounded');
      expect(readFileSync(path, 'utf8')).toBe('{}');
      for (const value of ['square', 'ascii', 'rounded']) {
        const persisted = JSON.stringify({ display: { treeGlyphs: value } });
        writeFileSync(path, persisted);
        manager.load();
        expect(readTreeGlyphSet(get, true)).toBe(resolveTreeGlyphSet(value, true));
        expect(readTreeGlyphSet(get, false)).toBe('ascii');
        expect(readFileSync(path, 'utf8')).toBe(persisted);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('a stored selection survives bulk save, reset and reconstruction', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tree-glyph-persisted-'));
    const path = join(directory, 'settings.json');
    try {
      const manager = new ConfigManager({ configDir: directory });
      manager.set(TREE_GLYPHS_CONFIG_KEY, 'square');
      manager.save();
      expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ display: { treeGlyphs: 'square' } });
      const reloaded = new ConfigManager({ configDir: directory, readOnly: true });
      expect(reloaded.get(TREE_GLYPHS_CONFIG_KEY)).toBe('square');
      expect(readTreeGlyphSet(() => reloaded.get(TREE_GLYPHS_CONFIG_KEY), false)).toBe('ascii');
      expect(() => manager.setDynamic(TREE_GLYPHS_CONFIG_KEY, 'malformed')).toThrow('Invalid value');
      expect(manager.get(TREE_GLYPHS_CONFIG_KEY)).toBe('square');
      manager.reset(TREE_GLYPHS_CONFIG_KEY);
      expect(manager.get(TREE_GLYPHS_CONFIG_KEY)).toBe('rounded');
      expect(new ConfigManager({ configDir: directory, readOnly: true }).get(TREE_GLYPHS_CONFIG_KEY)).toBe('rounded');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('malformed async readers cannot select a style or leak a private rejection', async () => {
    const readerPath = resolve(import.meta.dir, '../sdk/src/platform/runtime/tree-glyph-setting.ts');
    const source = `
      import { readTreeGlyphSet } from ${JSON.stringify(readerPath)};
      const failure = () => new Error('synthetic-private-glyph-setting');
      let rejectLate;
      const lateFailure = new Promise((_, reject) => { rejectLate = reject; });
      let resolveLate;
      const lateStyle = new Promise((resolve) => { resolveLate = resolve; });
      const getters = [
        async () => { throw failure(); },
        () => Promise.reject(failure()),
        () => { throw Promise.reject(failure()); },
        () => { throw { get then() { throw failure(); } }; },
        () => lateFailure,
        () => ({ then(_resolve, reject) { reject(failure()); } }),
        () => ({ get then() { throw failure(); } }),
        () => ({ then() { throw failure(); } }),
        async () => 'square',
        () => Promise.resolve('ascii'),
        () => lateStyle,
      ];
      for (const unicodeCapable of [true, false]) {
        for (const get of getters) {
          if (readTreeGlyphSet(get, unicodeCapable) !== (unicodeCapable ? 'rounded' : 'ascii')) {
            throw new Error('Async value selected a tree style');
          }
        }
      }
      rejectLate(failure());
      resolveLate('square');
      await new Promise((resolve) => setTimeout(resolve, 30));
      console.log('malformed glyph readers contained');
    `;
    const child = Bun.spawn([process.execPath, '--eval', source], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    try {
      const [code, stdout, stderr] = await withTestTimeout(Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]), 30_000, 'Tree-glyph subprocess did not settle');
      expect(code, stderr).toBe(0);
      expect(stderr).toBe('');
      expect(stdout.trim()).toBe('malformed glyph readers contained');
    } finally {
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
      await child.exited.catch(() => undefined);
    }
  }, 35_000);
});

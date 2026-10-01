import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runOwnedTestChild } from '../scripts/owned-test-child.ts';

describe('lazy native imports', () => {
  test.each(['structural search', 'pattern edit'])('%s starts without the native dependency and reports feature unavailability', async (feature) => {
    const root = mkdtempSync(join(tmpdir(), 'lazy-native-'));
    try {
      const fixture = join(root, 'missing-native.test.ts');
      const structural = new URL('../sdk/src/platform/tools/find/structural.ts', import.meta.url).href;
      const editMatch = new URL('../sdk/src/platform/tools/edit/match.ts', import.meta.url).href;
      // A fresh process avoids module-cache or mock leakage into other suites.
      // The loader rejects the native package regardless of host installation.
      writeFileSync(fixture, `
        import { expect, mock, test } from 'bun:test';
        let nativeLoads = 0;
        mock.module('@ast-grep/napi', () => {
          nativeLoads++;
          throw new Error('native dependency unavailable in fixture');
        });
        test('startup and feature fallback', async () => {
          if (${JSON.stringify(feature)} === 'structural search') {
            const { executeStructuralQuery } = await import(${JSON.stringify(structural)});
            expect(nativeLoads).toBe(0);
            const search = await executeStructuralQuery({ path: '.', pattern: 'const $NAME = $VALUE' }, {}, ${JSON.stringify(root)});
            expect(search.error).toContain('structural mode requires @ast-grep/napi at runtime');
            expect(search.error).toContain('native dependency unavailable in fixture');
          } else {
            const { computeExactEdit, computeAstPatternEdit } = await import(${JSON.stringify(editMatch)});
            expect(nativeLoads).toBe(0);
            const item = { id: 'edit', path: 'sample.ts', find: '1', replace: '2' };
            expect(computeExactEdit('const value = 1;', item)).toEqual({ newContent: 'const value = 2;', occurrencesReplaced: 1 });
            expect(nativeLoads).toBe(0);
            const edit = await computeAstPatternEdit('const value = 1;', item, 'sample.ts');
            expect(edit).toMatchObject({ newContent: 'const value = 2;', occurrencesReplaced: 1 });
            expect(edit.warning).toContain('ast_pattern unavailable');
            expect(edit.warning).toContain('native dependency unavailable in fixture');
          }
          expect(nativeLoads).toBeGreaterThan(0);
        });
      `);
      const result = await runOwnedTestChild({ argv: [fixture], cwd: root, env: process.env });
      expect(result.exitCode).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

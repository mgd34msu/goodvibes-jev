import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeContentQuery } from '../sdk/src/platform/tools/find/content.ts';
import { executeFilesQuery } from '../sdk/src/platform/tools/find/files.ts';
import { FindRuntimeService, type ImportGraphLike } from '../sdk/src/platform/tools/find/shared.ts';
import { ImportGraph } from '../sdk/src/platform/intelligence/import-graph.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(fakePort(() => noulAnswer(0.001)).port); });
afterEach(() => { installJudgmentPort(previous); });

function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

class DegradedImportGraphRuntime extends FindRuntimeService {
  override async getImportGraph(_projectRoot: string): Promise<ImportGraphLike> {
    return {
      findImports: () => [],
      findDependents: () => [],
      getWarnings: () => ['Import graph build failed; relationship results may be incomplete: test failure'],
    };
  }
}

describe('find/search degradation observability', () => {
  test('old protected contract views cannot break live project search or disclose their contents', async () => {
    const root = tempRoot('gv-find-retained-contract-');
    const protectedRoot = join(root, '.goodvibes', '.worktrees', 'contract-input', 'old');
    mkdirSync(protectedRoot, { recursive: true });
    mkdirSync(join(root, 'src'));
    writeFileSync(join(protectedRoot, '.gitignore'), 'private.ts\n');
    writeFileSync(join(protectedRoot, 'private.ts'), 'export const PROTECTED_REVIEW_SOURCE = 1;');
    const live = join(root, 'src', 'live.ts');
    writeFileSync(live, 'export const LIVE_REVIEW_SOURCE = 1;');
    try {
      for (const include_hidden of [false, true]) {
        const result = await executeFilesQuery({ id: 'files', mode: 'files', patterns: ['**/*.ts'], include_hidden }, { format: 'files_only' }, root);
        expect(result.files).toEqual([live]);
        expect(result.error).toBeUndefined();
      }
      const content = await executeContentQuery({ id: 'content', mode: 'content', pattern: 'REVIEW_SOURCE' }, { format: 'matches' }, new FindRuntimeService(), root);
      expect(content.count).toBe(1);
      expect(JSON.stringify(content)).toContain('LIVE_REVIEW_SOURCE');
      expect(JSON.stringify(content)).not.toContain('PROTECTED_REVIEW_SOURCE');
      const explicit = await executeFilesQuery({ id: 'files', mode: 'files', path: protectedRoot }, {}, root);
      expect(explicit.error).toContain('construction-owned authority');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('import indexing lets input callbacks run while preserving the complete graph', async () => {
    const root = tempRoot('gv-import-responsive-');
    for (let i = 0; i < 500; i++) writeFileSync(join(root, `f${i}.ts`), i ? `export { value } from './f${i - 1}.ts';\n` : 'export const value = 1;\n');
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 0);
    const graph = new ImportGraph();
    try {
      await graph.build(root, async () => {
        // Model local access-check work even when the fixture's files are hot
        // in the OS cache; awaiting a resolved promise alone does not yield.
        const until = performance.now() + 0.1;
        while (performance.now() < until) { /* CPU work */ }
        return true;
      });
    } finally { clearInterval(timer); }
    expect(ticks).toBeGreaterThan(0);
    expect(graph.stats().files).toBe(500);
    expect(graph.stats().edges).toBe(499);
  });

  test('files mode warns when nested gitignore files are present but not applied', async () => {
    const root = tempRoot('gv-find-gitignore-');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', '.gitignore'), 'ignored.ts\n', 'utf-8');
    writeFileSync(join(root, 'src', 'ignored.ts'), 'export const ignored = true;\n', 'utf-8');

    const result = await executeFilesQuery(
      { id: 'files', mode: 'files', patterns: ['**/*.ts'] },
      { format: 'files_only' },
      root,
    );

    const files = result.files as string[];
    const warnings = result.warnings as string[];
    expect(files).toContain(join(root, 'src', 'ignored.ts'));
    expect(warnings.some((warning) => warning.includes('Nested .gitignore files are not applied'))).toBe(true);
  });

  test('content relationships include import graph degradation warnings', async () => {
    const root = tempRoot('gv-find-relationships-');
    writeFileSync(join(root, 'a.ts'), 'export const marker = 1;\n', 'utf-8');

    const result = await executeContentQuery(
      { id: 'content', mode: 'content', pattern: 'marker', relationships: true },
      { format: 'matches' },
      new DegradedImportGraphRuntime(),
      root,
    );

    expect(result.count).toBe(1);
    expect(result.relationships).toBeDefined();
    const warnings = result.warnings as string[];
    expect(warnings.some((warning) => warning.includes('Import graph build failed'))).toBe(true);
  });
});

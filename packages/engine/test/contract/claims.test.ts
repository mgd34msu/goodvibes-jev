/**
 * Claim verification (contract/claims.ts), moved from the engineer claim check:
 * the report parser and the on-disk and git checks, every result kind.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineerReport } from '../../sdk/src/platform/agents/completion-report.js';
import { parseUnitCompletionReport, verifyUnitClaims } from '../../sdk/src/platform/contract/claims.js';

function engineerReport(overrides: { filesCreated?: string[]; filesModified?: string[] }): EngineerReport {
  return {
    version: 1,
    archetype: 'engineer',
    summary: 'Done',
    gatheredContext: [],
    plannedActions: [],
    appliedChanges: ['Did the work'],
    filesCreated: overrides.filesCreated ?? [],
    filesModified: overrides.filesModified ?? [],
    filesDeleted: [],
    decisions: [],
    issues: [],
    uncertainties: [],
  };
}

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(result.stderr)}`);
}

/** A git repository with one commit of `tracked.ts`. */
function gitRepo(dir: string): void {
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  writeFileSync(join(dir, 'tracked.ts'), 'export const a = 1;\n');
  git(dir, 'add', 'tracked.ts');
  git(dir, 'commit', '-q', '-m', 'initial');
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'contract-claims-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('parseUnitCompletionReport', () => {
  test('a structured report is used as written, with the raw output kept', () => {
    const raw = ['Finished.', '```json', JSON.stringify(engineerReport({ filesCreated: ['src/a.ts'] })), '```'].join('\n');
    const report = parseUnitCompletionReport(raw);
    expect(report.archetype).toBe('engineer');
    expect((report as EngineerReport).filesCreated).toEqual(['src/a.ts']);
    expect(report.rawOutput).toBe(raw);
  });

  test('plain output becomes an implementation report that claims no files', () => {
    const report = parseUnitCompletionReport('I changed the parser.');
    expect(report.archetype).toBe('engineer');
    expect((report as EngineerReport).filesCreated).toEqual([]);
    expect(report.summary).toBe('I changed the parser.');
    expect(parseUnitCompletionReport('').summary).toBe('(no output)');
  });
});

describe('verifyUnitClaims outside git', () => {
  test('no claims and no git: unverifiable_no_claims, not verified', () => {
    const result = verifyUnitClaims(engineerReport({}), dir);
    expect(result.kind).toBe('unverifiable_no_claims');
    expect(result.verified).toBe(false);
    expect(result.claimedPaths).toHaveLength(0);
    expect(result.gitDiffDetected).toBeNull();
  });

  test('every claimed file exists: files_verified, and git is not consulted', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'app.ts'), 'export {}');
    const result = verifyUnitClaims(engineerReport({ filesCreated: ['src/app.ts'] }), dir);
    expect(result.kind).toBe('files_verified');
    expect(result.verified).toBe(true);
    expect(result.foundPaths).toEqual(['src/app.ts']);
    expect(result.gitDiffDetected).toBeNull();
  });

  test('a claimed file is missing and there is no git: unverified', () => {
    writeFileSync(join(dir, 'index.ts'), '// existing');
    const result = verifyUnitClaims(engineerReport({ filesModified: ['index.ts', 'missing.ts'] }), dir);
    expect(result.kind).toBe('unverified');
    expect(result.verified).toBe(false);
    expect(result.foundPaths).toEqual(['index.ts']);
    expect(result.missingPaths).toEqual(['missing.ts']);
    expect(result.summary).toContain('missing: missing.ts');
  });

  test('absolute claimed paths are checked as given', () => {
    const absolute = join(dir, 'abs.ts');
    writeFileSync(absolute, '// abs');
    const result = verifyUnitClaims(engineerReport({ filesCreated: [absolute] }), dir);
    expect(result.kind).toBe('files_verified');
  });

  test('a report that is not an implementation report skips verification', () => {
    const result = verifyUnitClaims({ version: 1, archetype: 'generic', summary: 'Done' } as Parameters<typeof verifyUnitClaims>[0], dir);
    expect(result.kind).toBe('verified_empty');
    expect(result.verified).toBe(true);
  });

  test('the summary names at most five missing paths and counts the rest', () => {
    const missing = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => `${name}.ts`);
    const result = verifyUnitClaims(engineerReport({ filesCreated: missing }), dir);
    expect(result.summary).toContain('missing: a.ts, b.ts, c.ts, d.ts, e.ts (+2 more)');
  });
});

describe('verifyUnitClaims in a git repository', () => {
  test('a claimed file is missing but git shows changes: git_corroborated', () => {
    gitRepo(dir);
    writeFileSync(join(dir, 'tracked.ts'), 'export const a = 2;\n');
    const result = verifyUnitClaims(engineerReport({ filesCreated: ['elsewhere.ts'] }), dir);
    expect(result.kind).toBe('git_corroborated');
    expect(result.verified).toBe(true);
    expect(result.gitDiffDetected).toBe(true);
  });

  test('no claims but git shows changes: verified_empty', () => {
    gitRepo(dir);
    writeFileSync(join(dir, 'tracked.ts'), 'export const a = 3;\n');
    const result = verifyUnitClaims(engineerReport({}), dir);
    expect(result.kind).toBe('verified_empty');
    expect(result.verified).toBe(true);
  });

  test('no claims and a clean tree: unverifiable_no_claims', () => {
    gitRepo(dir);
    const result = verifyUnitClaims(engineerReport({}), dir);
    expect(result.kind).toBe('unverifiable_no_claims');
    expect(result.gitDiffDetected).toBe(false);
    expect(result.summary).toContain('git diff: no changes detected');
  });

  test('a claimed file is missing and the tree is clean: unverified', () => {
    gitRepo(dir);
    const result = verifyUnitClaims(engineerReport({ filesCreated: ['ghost.ts'] }), dir);
    expect(result.kind).toBe('unverified');
    expect(result.verified).toBe(false);
  });
});

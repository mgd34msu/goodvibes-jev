/**
 * analyze mode semantic_diff: Jev reads two facts about the diff
 * (engine.tools.semantic-diff) and code composes the risk tier; the helper
 * model only writes the summary prose and is never asked for the tier.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { YesNoReading } from '@goodvibes-jev/judgment';
import { runSemanticDiff, semanticDiffRisk } from '../sdk/src/platform/tools/analyze/git-modes.ts';
import { useToolReadings } from './_helpers/tool-readings.ts';

const readings = useToolReadings([
  ['deleteUser', { breaksCallers: true, changesBehavior: true }],
  ['Math.floor', { changesBehavior: true }],
]);

const yes: YesNoReading = { kind: 'yes-no', probability: 0.97, verdict: 'yes', outcome: 'act' };
const no: YesNoReading = { kind: 'yes-no', probability: 0.03, verdict: 'no', outcome: 'act' };
const unsure: YesNoReading = { kind: 'yes-no', probability: 0.5, verdict: 'uncertain', outcome: 'escalate' };

describe('semanticDiffRisk', () => {
  test('breaking a caller is high, changing behavior is medium, neither is low', () => {
    expect(semanticDiffRisk({ breaks_callers: yes, changes_behavior: no })).toBe('high');
    expect(semanticDiffRisk({ breaks_callers: no, changes_behavior: yes })).toBe('medium');
    expect(semanticDiffRisk({ breaks_callers: no, changes_behavior: no })).toBe('low');
  });

  test('an uncertain fact counts toward the higher tier', () => {
    expect(semanticDiffRisk({ breaks_callers: unsure, changes_behavior: no })).toBe('high');
    expect(semanticDiffRisk({ breaks_callers: no, changes_behavior: unsure })).toBe('medium');
  });
});

describe('runSemanticDiff', () => {
  let repo: string;

  function git(...args: string[]): void {
    const result = Bun.spawnSync(['git', ...args], { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
  }

  function commit(content: string): void {
    writeFileSync(join(repo, 'tax.ts'), content);
    git('add', '.');
    git('commit', '-q', '-m', 'change');
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'gv-semantic-diff-'));
    git('init', '-q');
    commit('export function taxFor(cents: number, rate: number): number {\n  return Math.round(cents * rate);\n}\n');
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  test('the tier comes from the readings, and without helper prose the summary is built from them', async () => {
    commit('export function taxFor(cents: number, rate: number): number {\n  return Math.floor(cents * rate);\n}\n');
    const prompts: string[] = [];
    const result = await runSemanticDiff({ mode: 'semantic_diff' }, repo, { chat: async (prompt: string) => { prompts.push(prompt); return ''; } });

    expect(result.risk).toBe('medium');
    expect(result.risk_readings).toEqual({ breaks_callers: 'no', changes_behavior: 'yes' });
    expect(result.summary_source).toBe('readings');
    expect(result.summary).toBe('Changed tax.ts. Existing code behaves differently after this change.');
    expect(result.changed_files).toEqual(['tax.ts']);
    // The helper model is asked for prose only, never for a risk rating.
    expect(prompts[0]).not.toContain('Risk level');
    expect(readings.requests).toHaveLength(1);
  });

  test('helper prose supplies the summary and impact, never the tier', async () => {
    commit('export function taxFor(cents: number, rate: number): number {\n  return Math.round(cents * rate);\n}\nexport function deleteUser(): void {}\n');
    git('rm', '-q', 'tax.ts');
    git('commit', '-q', '-m', 'remove');
    const reply = JSON.stringify({ summary: 'Removes the tax module.', impact: ['checkout totals'], risk: 'low' });
    const result = await runSemanticDiff({ mode: 'semantic_diff' }, repo, { chat: async () => reply });

    expect(result.risk).toBe('high');
    expect(result.summary).toBe('Removes the tax module.');
    expect(result.impact).toEqual(['checkout totals']);
    expect(result.summary_source).toBe('llm');
  });
});

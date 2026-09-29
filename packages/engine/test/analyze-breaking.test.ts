/**
 * analyze mode breaking: an export gone from the diff is breaking in code;
 * whether a changed declaration breaks its callers is composed from the two
 * facts `engine.tools.export-break` reads per export, and an unchanged
 * declaration is never read.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { YesNoReading } from '@goodvibes-jev/judgment';
import { exportBreakVerdict, runBreaking } from '../sdk/src/platform/tools/analyze/git-modes.ts';
import { useToolReadings } from './_helpers/tool-readings.ts';

const readings = useToolReadings([
  ['"name":"sendWelcome"', { inputsBreak: true }],
  ['"name":"loadUser"', { outputBreaks: 'uncertain' }],
]);

const yes: YesNoReading = { kind: 'yes-no', probability: 0.97, verdict: 'yes', outcome: 'act' };
const no: YesNoReading = { kind: 'yes-no', probability: 0.03, verdict: 'no', outcome: 'act' };
const unsure: YesNoReading = { kind: 'yes-no', probability: 0.5, verdict: 'uncertain', outcome: 'escalate' };

describe('exportBreakVerdict', () => {
  test('either fact is breaking, both no is safe, and an uncertain fact with no yes is uncertain', () => {
    expect(exportBreakVerdict({ inputs_break: yes, output_breaks: no })).toBe('breaking');
    expect(exportBreakVerdict({ inputs_break: no, output_breaks: yes })).toBe('breaking');
    expect(exportBreakVerdict({ inputs_break: unsure, output_breaks: yes })).toBe('breaking');
    expect(exportBreakVerdict({ inputs_break: no, output_breaks: no })).toBe('safe');
    expect(exportBreakVerdict({ inputs_break: no, output_breaks: unsure })).toBe('uncertain');
  });
});

describe('runBreaking', () => {
  let repo: string;

  function git(...args: string[]): void {
    const result = Bun.spawnSync(['git', ...args], { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
  }

  function commit(content: string): void {
    writeFileSync(join(repo, 'api.ts'), content);
    git('add', '.');
    git('commit', '-q', '-m', 'change');
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'gv-breaking-'));
    git('init', '-q');
    commit([
      'export function sendWelcome(to: string): void {}',
      'export function search(query: string): string[] { return []; }',
      'export function loadUser(id: string): string { return id; }',
      'export function removed(): void {}',
      '',
    ].join('\n'));
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  test('a removed export breaks in code; changed exports are listed by their readings', async () => {
    commit([
      'export function sendWelcome(to: string, locale: string): void {}',
      'export function search(query: string, limit?: number): string[] { return []; }',
      'export function loadUser(id: string): string | undefined { return id; }',
      '',
    ].join('\n'));

    const result = await runBreaking({ mode: 'breaking' }, repo);

    expect(result.breaking_changes).toEqual([
      { name: 'removed', before: 'removed(): void', after: '(removed)', reason: 'export removed' },
      { name: 'sendWelcome', before: 'sendWelcome(to: string): void', after: 'sendWelcome(to: string, locale: string): void', reason: 'callers must change' },
      { name: 'loadUser', before: 'loadUser(id: string): string', after: 'loadUser(id: string): string | undefined', reason: 'callers may have to change', reading: 'uncertain' },
    ]);
    expect(result.safe_modifications).toEqual([{ name: 'search', before: 'search(query: string): string[]', after: 'search(query: string, limit?: number): string[]' }]);
    // One reading per changed export; the removed export asks nothing.
    const asked = readings.requests.map((request) => (request.state as { name: string }).name).sort();
    expect(asked).toEqual(['loadUser', 'search', 'sendWelcome']);
  });
});

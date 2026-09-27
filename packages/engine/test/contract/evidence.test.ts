/**
 * A unit's evidence (contract/evidence.ts, design 4.3): commands and written
 * paths from the agent's turns, changed paths from each isolation mode, what
 * each trigger collects, and trimming that keeps every check request inside
 * the Jev context budget, proven with validateContextBudget on the requests
 * the check really sends.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { estimateTokens, LIMITS, validateContextBudget } from '@goodvibes-jev/judgment';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { snapshotDirtyTree } from '../../sdk/src/platform/orchestration/dirty-guard.js';
import { RuntimeEventBus } from '../../sdk/src/platform/runtime/events/index.js';
import type { ContractConfigReader } from '../../sdk/src/platform/contract/config.js';
import { runUnitCheck } from '../../sdk/src/platform/contract/check.js';
import {
  collectChanges,
  collectUnitEvidence,
  commandsFromTurns,
  DIFF_FILE_CAP_CHARS,
  EVIDENCE_TOKEN_BUDGET,
  evidenceTokens,
  GATE_OUTPUT_CAP_CHARS,
  headAndTail,
  MAX_COMMANDS,
  OUTPUT_CAP_CHARS,
  splitUnifiedDiff,
  trimEvidence,
  writtenPaths,
  type ContractTurnRecord,
  type RawUnitEvidence,
} from '../../sdk/src/platform/contract/evidence.js';
import { checkPort } from './check-port.js';
import { makeContract, makeUnit } from './fixtures.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'contract-evidence-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(result.stderr)}`);
  return new TextDecoder().decode(result.stdout).trim();
}

function gitRepo(): void {
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'dirty.ts'), 'export const d = 1;\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'initial');
}

function noGates(): ContractConfigReader {
  return { get: () => undefined, getCategory: (name: string) => (name === 'contract' ? { gates: [] } : undefined) } as unknown as ContractConfigReader;
}

const TURNS: readonly ContractTurnRecord[] = [
  {
    turn: 1,
    toolCalls: [
      { name: 'write', arguments: { files: [{ path: 'src/a.ts', content: 'x' }, { path: 'src/b.ts', content: 'y' }] } },
      { name: 'exec', arguments: { commands: [{ cmd: 'bun test' }, { cmd_base64: Buffer.from('echo hi').toString('base64') }] } },
      { name: 'read', arguments: { path: 'README.md' } },
    ],
    results: [
      { callId: '1', success: true, output: 'wrote 2 files' },
      { callId: '2', success: false, output: Array.from({ length: 30 }, (_, i) => `out ${i + 1}`).join('\n') },
      { callId: '3', success: true, output: 'readme' },
    ],
    assistantText: 'Writing the parser.',
  },
  {
    turn: 2,
    toolCalls: [{ name: 'edit', arguments: { edits: [{ path: 'src/a.ts', find: 'x', replace: 'z' }, { path: 'src/c.ts', find: 'p', replace: 'q' }] } }],
    results: [{ callId: '4', success: true, output: 'edited' }],
    assistantText: 'Fixing.',
  },
];

describe('what the agent did, from its turns', () => {
  test('exec calls become commands with success and the first 20 lines of output', () => {
    const commands = commandsFromTurns(TURNS);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.command).toBe('bun test\necho hi');
    expect(commands[0]!.success).toBe(false);
    expect(commands[0]!.head.split('\n')).toHaveLength(20);
    expect(commands[0]!.head.endsWith('out 20')).toBe(true);
  });

  test('write and edit calls name the written paths, once each, in first-seen order', () => {
    expect(writtenPaths(TURNS)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });
});

describe('changed paths', () => {
  test('worktree mode splits the branch diff per file', async () => {
    const unifiedDiff = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n+one\ndiff --git a/src/b.ts b/src/b.ts\n+++ b/src/b.ts\n+two\n';
    const changes = await collectChanges({}, { cwd: dir, turns: [], worktree: { diff: async () => ({ files: ['src/a.ts', 'src/b.ts'], unifiedDiff, stat: '' }) } });
    expect(changes.map((change) => change.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(changes[1]!.diff).toBe('diff --git a/src/b.ts b/src/b.ts\n+++ b/src/b.ts\n+two');
    expect(splitUnifiedDiff('')).toEqual([]);
  });

  test('shared mode: changes since the baseline, staged or not, new files whole, untouched residue left out', async () => {
    gitRepo();
    writeFileSync(join(dir, 'dirty.ts'), 'export const d = 2;\n'); // dirty before the unit started
    const baseline = { head: git(dir, 'rev-parse', 'HEAD'), dirty: Object.fromEntries(snapshotDirtyTree(dir)) };
    writeFileSync(join(dir, 'a.ts'), 'export const a = 2;\n');
    git(dir, 'add', 'a.ts');
    writeFileSync(join(dir, 'new.ts'), 'export const n = 1;\n');
    const changes = await collectChanges({ baseline }, { cwd: dir, turns: [] });
    expect(changes.map((change) => change.path).sort()).toEqual(['a.ts', 'new.ts']);
    expect(changes.find((change) => change.path === 'a.ts')!.diff).toContain('+export const a = 2;');
    expect(changes.find((change) => change.path === 'new.ts')!.diff).toBe('new file new.ts\nexport const n = 1;\n');

    writeFileSync(join(dir, 'dirty.ts'), 'export const d = 3;\n'); // the unit changes the residue too
    expect((await collectChanges({ baseline }, { cwd: dir, turns: [] })).map((change) => change.path).sort()).toEqual(['a.ts', 'dirty.ts', 'new.ts']);
  });

  test('shared mode: work the agent committed is still its change', async () => {
    gitRepo();
    const baseline = { head: git(dir, 'rev-parse', 'HEAD'), dirty: {} };
    writeFileSync(join(dir, 'a.ts'), 'export const a = 5;\n');
    git(dir, 'commit', '-q', '-am', 'agent commit');
    const changes = await collectChanges({ baseline }, { cwd: dir, turns: [] });
    expect(changes.map((change) => change.path)).toEqual(['a.ts']);
    expect(changes[0]!.diff).toContain('+export const a = 5;');
  });

  test('outside git: the written paths with their current text', async () => {
    writeFileSync(join(dir, 'notes.md'), '# Notes\n');
    const turns: ContractTurnRecord[] = [{ turn: 1, toolCalls: [{ name: 'write', arguments: { files: [{ path: 'notes.md' }, { path: 'gone.md' }] } }], results: [], assistantText: '' }];
    const changes = await collectChanges({}, { cwd: dir, turns });
    expect(changes).toEqual([
      { path: 'notes.md', diff: 'notes.md\n# Notes\n' },
      { path: 'gone.md', diff: 'gone.md\n(gone.md no longer exists)' },
    ]);
  });
});

describe('what each trigger collects', () => {
  const contract = makeContract();
  const sources = () => ({ output: 'Done.', turns: TURNS, cwd: dir, configManager: noGates(), runtimeBus: new RuntimeEventBus() });

  test('turn-end: no claims and no gates', async () => {
    const evidence = await collectUnitEvidence(contract, makeUnit(), 'turn-end', sources());
    expect(evidence.claims).toBeUndefined();
    expect(evidence.gates).toBeUndefined();
    expect(evidence.commands).toHaveLength(1);
  });

  test('completion and resume: claims and gates (a check after a restart reads the report the earlier agent left)', async () => {
    for (const trigger of ['completion', 'resume'] as const) {
      const evidence = await collectUnitEvidence(contract, makeUnit(), trigger, sources());
      expect(evidence.claims?.kind).toBe('unverifiable_no_claims');
      expect(evidence.gates).toEqual([]);
    }
  });

  test('the other triggers run gates but not claims', async () => {
    for (const trigger of ['agent-failed', 'fix-passed', 'owner-amend'] as const) {
      const evidence = await collectUnitEvidence(contract, makeUnit(), trigger, sources());
      expect(evidence.claims).toBeUndefined();
      expect(evidence.gates).toEqual([]);
    }
  });
});

describe('trimming to the budget', () => {
  const unit = makeUnit({ goal: 'Parse every documented input form', brief: 'Write the parser.', files: ['src/wanted.ts'] });
  const big = (label: string, chars: number) => `${label}:`.padEnd(chars, 'x');

  function huge(): RawUnitEvidence {
    return {
      output: big('output', 200_000),
      changes: [
        ...Array.from({ length: 60 }, (_, index) => ({ path: `src/generated-${index}.ts`, diff: big(`diff ${index}`, 20_000) })),
        { path: 'src/wanted.ts', diff: big('wanted', 30_000) },
        { path: 'src/small.ts', diff: 'small diff' },
      ],
      gates: [{ gate: 'test', passed: false, output: `${big('head', 50_000)}THE FAILURE`, durationMs: 1 }],
      commands: Array.from({ length: 200 }, (_, index) => ({ command: `cmd ${index}`, success: true, head: big(`head ${index}`, 2_000) })),
    };
  }

  test('a huge unit stays under the evidence budget, with the caps applied', () => {
    const evidence = trimEvidence(huge(), unit);
    expect(evidenceTokens(unit, evidence)).toBeLessThanOrEqual(EVIDENCE_TOKEN_BUDGET);
    expect(evidence.output.length).toBeLessThanOrEqual(OUTPUT_CAP_CHARS + 100);
    expect(evidence.gates![0]!.output.length).toBeLessThanOrEqual(GATE_OUTPUT_CAP_CHARS + 100);
    expect(evidence.gates![0]!.output.endsWith('THE FAILURE')).toBe(true);
    expect(evidence.commands.length).toBeLessThanOrEqual(MAX_COMMANDS);
    expect(evidence.commands.at(-1)!.command).toBe('cmd 199');
    expect(evidence.changedPaths).toHaveLength(62);
    expect(evidence.omitted.length).toBeGreaterThan(0);
    expect(evidence.omitted.length + evidence.diff.split('\n\n').length).toBe(62);
  });

  test('the unit\'s own files fill first, capped per file, then the rest smallest first', () => {
    const evidence = trimEvidence(huge(), unit);
    expect(evidence.diff.startsWith('wanted:')).toBe(true);
    expect(evidence.diff).toContain(`[... ${30_000 - DIFF_FILE_CAP_CHARS} characters of src/wanted.ts omitted ...]`);
    expect(evidence.diff.split('\n\n')[1]).toBe('small diff');
    expect(evidence.omitted).not.toContain('src/wanted.ts');
  });

  test('small evidence passes through untouched', () => {
    const raw: RawUnitEvidence = { output: 'ok', changes: [{ path: 'a.ts', diff: '+a' }], commands: [] };
    expect(trimEvidence(raw, unit)).toEqual({ output: 'ok', changedPaths: ['a.ts'], diff: '+a', omitted: [], commands: [] });
  });

  test('head and tail keep both ends and state the cut', () => {
    expect(headAndTail('abcdefghij', 4)).toBe('ab\n[... 6 characters omitted ...]\nij');
    expect(headAndTail('abc', 4)).toBe('abc');
  });

  test('the requests a check sends with trimmed evidence pass validateContextBudget', async () => {
    const criteria = Array.from({ length: 30 }, (_, index) => `u1.c${index + 1}`);
    const wide = makeUnit({ ...unit, criteria: criteria.map((id) => ({ id, text: big(`criterion ${id}`, 300), origin: 'derived', serves: ['c1'], disposition: 'judged', status: 'unread', readings: [] })) });
    const evidence = trimEvidence(huge(), wide);
    const port = checkPort({});
    const previous = installJudgmentPort(port.port);
    try {
      await runUnitCheck({
        contract: makeContract(),
        unit: wide,
        trigger: 'completion',
        evidence,
        settings: { acceptanceStakes: 'high', evidenceNudgeLimit: 2, stallLimit: 3, maxNudgesPerUnit: 12 },
        now: 1,
      });
    } finally {
      installJudgmentPort(previous);
    }
    expect(port.requests).toHaveLength(2);
    for (const request of port.requests) {
      expect(() => validateContextBudget(request.state, request.questions)).not.toThrow();
      expect(estimateTokens(request.state)).toBeLessThanOrEqual(EVIDENCE_TOKEN_BUDGET);
      expect(estimateTokens(request.state)).toBeLessThan(LIMITS.maxStateWithQuestionTokens);
    }
  });

  test('untrimmed, the same evidence would break the budget', () => {
    const raw = huge();
    const untrimmed = { output: raw.output, changedPaths: [], diff: raw.changes.map((change) => change.diff).join('\n'), omitted: [], commands: raw.commands };
    expect(() => validateContextBudget(JSON.stringify({ goal: unit.goal, output: untrimmed.output, evidence: untrimmed }), {})).toThrow();
  });
});

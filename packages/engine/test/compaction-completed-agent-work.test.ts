/**
 * Compaction accounts for subagent and contract work.
 *
 * Covers:
 *  - buildCompletedAgentWork(): the "## Completed Agent Work" section, which
 *    lists contract and unit answers and standalone (no-contract)
 *    completed/failed agents, leaving out contracts summarized as older work.
 *  - buildRunningAgents(): running agents grouped under their contract.
 *  - buildAgentActivityTable(): one row per contract with its units, judged
 *    criteria met and a Files column from the units' touchedPaths.
 *  - buildOlderAgentSummaryPrompt(): older contracts given by status line.
 *  - resolveLineageOriginalTask(): the "Original task" mislabel fix, the
 *    lastUserMsg fallback must only fire on the very first compaction
 *    (compactionCount === 0), not on every subsequent manual compaction.
 */
import { describe, expect, test } from 'bun:test';
import {
  buildCompletedAgentWork,
  buildRunningAgents,
  buildAgentActivityTable,
  buildOlderAgentSummaryPrompt,
} from '../sdk/src/platform/core/compaction-sections.ts';
import { resolveLineageOriginalTask } from '../sdk/src/platform/core/context-compaction.ts';
import type { AgentRecord } from '../sdk/src/platform/tools/agent/manager.ts';
import { makeContract, makeCriterion, makeUnit } from './contract/fixtures.ts';

/** Build a minimal AgentRecord. */
function makeRecord(overrides: Partial<AgentRecord> & { id: string; task: string }): AgentRecord {
  return {
    template: overrides.template ?? 'engineer',
    tools: [],
    status: 'completed',
    startedAt: Date.now(),
    toolCallCount: 3,
    orchestrationDepth: 0,
    executionProtocol: 'direct',
    reviewMode: 'none',
    communicationLane: 'parent-only',
    ...overrides,
  };
}

function engineerReportOutput(files: { created?: string[]; modified?: string[]; deleted?: string[] }): string {
  return [
    '```json',
    JSON.stringify({
      version: 1,
      archetype: 'engineer',
      summary: 'did the work',
      gatheredContext: [],
      plannedActions: [],
      appliedChanges: [],
      filesCreated: files.created ?? [],
      filesModified: files.modified ?? [],
      filesDeleted: files.deleted ?? [],
      decisions: [],
      issues: [],
      uncertainties: [],
    }),
    '```',
  ].join('\n');
}

describe('buildCompletedAgentWork', () => {
  test('returns null when agents is empty', () => {
    expect(buildCompletedAgentWork([], [])).toBeNull();
  });

  test('returns null when all agents are still running/pending', () => {
    const agents = [
      makeRecord({ id: 'a1', task: 'still going', status: 'running' }),
      makeRecord({ id: 'a2', task: 'queued', status: 'pending' }),
    ];
    expect(buildCompletedAgentWork(agents, [])).toBeNull();
  });

  test('lists a plain completed agent with task, tool count, and DONE marker', () => {
    const agents = [
      makeRecord({ id: 'a1', task: 'refactor the widget', status: 'completed', toolCallCount: 5 }),
    ];
    const section = buildCompletedAgentWork(agents, []);
    expect(section).not.toBeNull();
    expect(section!.header).toBe('## Completed Agent Work');
    expect(section!.content).toContain('[DONE]');
    expect(section!.content).toContain('a1');
    expect(section!.content).toContain('refactor the widget');
    expect(section!.content).toContain('5 tool calls');
  });

  test('lists a plain failed agent with FAILED marker', () => {
    const agents = [
      makeRecord({ id: 'a2', task: 'broken task', status: 'failed', toolCallCount: 1 }),
    ];
    const section = buildCompletedAgentWork(agents, []);
    expect(section!.content).toContain('[FAILED]');
    expect(section!.content).toContain('1 tool call'); // singular, not "1 tool calls"
  });

  test('excludes an agent listed in a contract unit\'s agentIds even without contractId set', () => {
    const agents = [
      makeRecord({ id: 'eng-1', task: 'unit work', status: 'completed', contractId: undefined }),
    ];
    const contracts = [makeContract({ id: 'ctr-00000001', units: [makeUnit({ agentIds: ['eng-1'] })] })];
    expect(buildCompletedAgentWork(agents, contracts)).toBeNull();
  });

  test('excludes a planner agent listed in plannerAgentIds', () => {
    const agents = [makeRecord({ id: 'plan-1', task: 'plan it', status: 'completed' })];
    const contracts = [makeContract({ id: 'ctr-00000002', plannerAgentIds: ['plan-1'] })];
    expect(buildCompletedAgentWork(agents, contracts)).toBeNull();
  });

  test('excludes an agent with contractId set directly', () => {
    const agents = [
      makeRecord({ id: 'eng-2', task: 'unit work', status: 'completed', contractId: 'ctr-00000003' }),
    ];
    expect(buildCompletedAgentWork(agents, [])).toBeNull();
  });

  test('lists a contract answer and its unit answers', () => {
    const contracts = [makeContract({
      id: 'ctr-00000004',
      status: 'passed',
      goal: 'Parser for every input form',
      answer: 'Parser added with tests',
      units: [
        makeUnit({ id: 'u1', title: 'Parser', status: 'passed', answer: 'wrote src/parser.ts' }),
        makeUnit({ id: 'u2', title: 'Docs', status: 'running' }),
      ],
    })];
    const section = buildCompletedAgentWork([], contracts);
    expect(section).not.toBeNull();
    expect(section!.content).toContain('[PASSED] ctr-00000004 | Parser for every input form | Parser added with tests');
    expect(section!.content).toContain('u1 [passed] Parser: wrote src/parser.ts');
    expect(section!.content).not.toContain('u2');
  });

  test('lists unit answers of a contract still running', () => {
    const contracts = [makeContract({
      id: 'ctr-00000005',
      status: 'running',
      units: [makeUnit({ id: 'u1', status: 'passed', answer: 'unit done' })],
    })];
    const section = buildCompletedAgentWork([], contracts);
    expect(section!.content).toContain('[IN_PROGRESS] ctr-00000005');
    expect(section!.content).toContain('u1 [passed] Parser: unit done');
  });

  test('leaves out contracts named as older work', () => {
    const contracts = [makeContract({ id: 'ctr-00000006', status: 'passed', answer: 'old answer' })];
    expect(buildCompletedAgentWork([], contracts, new Set(['ctr-00000006']))).toBeNull();
  });

  test('shows files from a parseable engineer completion report', () => {
    const agents = [
      makeRecord({
        id: 'a3',
        task: 'add feature',
        status: 'completed',
        fullOutput: engineerReportOutput({ created: ['src/foo.ts'], modified: ['src/bar.ts'] }),
      }),
    ];
    const section = buildCompletedAgentWork(agents, []);
    expect(section!.content).toContain('files: src/foo.ts, src/bar.ts');
  });

  test('shows no files clause when fullOutput is absent (no crash)', () => {
    const agents = [makeRecord({ id: 'a4', task: 'no output agent', status: 'completed' })];
    const section = buildCompletedAgentWork(agents, []);
    expect(section!.content).not.toContain('files:');
  });

  test('shows no files clause when fullOutput is unparseable (no crash)', () => {
    const agents = [
      makeRecord({ id: 'a5', task: 'garbled output', status: 'completed', fullOutput: 'not json at all' }),
    ];
    const section = buildCompletedAgentWork(agents, []);
    expect(section!.content).not.toContain('files:');
  });

  test('truncates the files list with a "(+N more)" suffix beyond 5 paths', () => {
    const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts'];
    const agents = [
      makeRecord({
        id: 'a6',
        task: 'big change',
        status: 'completed',
        fullOutput: engineerReportOutput({ created: files }),
      }),
    ];
    const section = buildCompletedAgentWork(agents, []);
    expect(section!.content).toContain('(+2 more)');
    expect(section!.content).toContain('a.ts, b.ts, c.ts, d.ts, e.ts');
    expect(section!.content).not.toContain('f.ts');
  });
});

describe('buildRunningAgents', () => {
  test('returns null when no agent is running', () => {
    expect(buildRunningAgents([makeRecord({ id: 'a1', task: 'done' })], [])).toBeNull();
  });

  test('groups running agents under their contract, standalone agents last', () => {
    const contract = makeContract({
      id: 'ctr-00000010',
      status: 'running',
      goal: 'Parser for every input form',
      ownerAgentId: 'owner-1',
      plannerAgentIds: ['plan-1'],
      units: [makeUnit({ id: 'u1', agentIds: ['eng-1'] })],
    });
    const agents = [
      makeRecord({ id: 'solo-1', task: 'standalone task', status: 'running' }),
      makeRecord({ id: 'eng-1', task: 'write the parser', status: 'running', contractId: 'ctr-00000010', contractRole: 'unit', contractUnitId: 'u1' }),
      makeRecord({ id: 'plan-1', task: 'plan the parser', status: 'running' }),
      makeRecord({ id: 'owner-1', task: 'owner', status: 'completed' }),
    ];
    const section = buildRunningAgents(agents, [contract]);
    expect(section!.header).toBe('## Currently Running');
    expect(section!.content.split('\n')).toEqual([
      '- ctr-00000010 | running | Parser for every input form',
      '  - unit u1 | eng-1 | write the parser',
      '  - planner | plan-1 | plan the parser',
      '- no-contract | solo-1 | standalone task',
    ]);
  });

  test('names a contract it was not handed by id alone', () => {
    const agents = [makeRecord({ id: 'eng-9', task: 'work', status: 'running', contractId: 'ctr-000000ff', contractRole: 'unit', contractUnitId: 'u3' })];
    expect(buildRunningAgents(agents, [])!.content).toBe('- ctr-000000ff\n  - unit u3 | eng-9 | work');
  });
});

describe('buildAgentActivityTable', () => {
  test('returns no section and no remaining contracts when there are none', () => {
    expect(buildAgentActivityTable([], 6500)).toEqual({ section: null, remainingContracts: [] });
  });

  test('includes a file count over the units\' touchedPaths, each path once', () => {
    const contracts = [makeContract({
      units: [
        makeUnit({ id: 'u1', touchedPaths: ['x.ts', 'y.ts'] }),
        makeUnit({ id: 'u2', touchedPaths: ['y.ts', 'z.ts'] }),
      ],
    })];
    const { section } = buildAgentActivityTable(contracts, 6500);
    expect(section).not.toBeNull();
    expect(section!.content).toContain('| Files |');
    expect(section!.content).toContain('3 files');
  });

  test('shows "—" when no unit touched a path', () => {
    const { section } = buildAgentActivityTable([makeContract({ units: [makeUnit({ touchedPaths: [] })] })], 6500);
    expect(section!.content.split('\n')[2]).toEndWith('| — |');
  });

  test('shows units with their status, judged criteria met and the result', () => {
    const contract = makeContract({
      id: 'ctr-00000020',
      status: 'judging',
      goal: 'Parser for every input form',
      criteria: [makeCriterion({ id: 'c1', status: 'met' })],
      units: [
        makeUnit({ id: 'u1', status: 'passed', criteria: [makeCriterion({ id: 'u1.c1', status: 'met' })] }),
        makeUnit({ id: 'u2', status: 'fixing', criteria: [
          makeCriterion({ id: 'u2.c1', status: 'unmet' }),
          makeCriterion({ id: 'u2.c2', status: 'met', disposition: 'met-by-structure' }),
        ] }),
      ],
    });
    const { section } = buildAgentActivityTable([contract], 6500);
    expect(section!.content).toContain(
      '| ctr-00000020 | Parser for every input form | IN_PROGRESS (judging) | u1 passed, u2 fixing | 2/3 met | — |',
    );
  });

  test('maps the terminal statuses to their results', () => {
    const results = (['passed', 'failed', 'cancelled'] as const).map((status) =>
      buildAgentActivityTable([makeContract({ status })], 6500).section!.content.split('\n')[2]);
    expect(results[0]).toContain('| PASSED |');
    expect(results[1]).toContain('| FAILED |');
    expect(results[2]).toContain('| CANCELLED |');
  });

  test('puts the contracts that do not fit the budget in remainingContracts, oldest last', () => {
    const newest = makeContract({ id: 'ctr-00000031', createdAt: 3 });
    const middle = makeContract({ id: 'ctr-00000032', createdAt: 2 });
    const oldest = makeContract({ id: 'ctr-00000033', createdAt: 1 });
    const oneRow = buildAgentActivityTable([newest], 6500).section!.tokens;
    const { section, remainingContracts } = buildAgentActivityTable([oldest, newest, middle], oneRow + 5);
    expect(section!.content).toContain('ctr-00000031');
    expect(remainingContracts.map((c) => c.id)).toEqual(['ctr-00000032', 'ctr-00000033']);
  });
});

describe('buildOlderAgentSummaryPrompt', () => {
  test('returns an empty prompt when there are no older contracts', () => {
    expect(buildOlderAgentSummaryPrompt([])).toBe('');
  });

  test('gives each older contract by result and status line, its goal when it has none', () => {
    const prompt = buildOlderAgentSummaryPrompt([
      makeContract({ id: 'ctr-00000041', status: 'passed', statusLine: 'Contract passed: parser added' }),
      makeContract({ id: 'ctr-00000042', status: 'running', goal: 'Docs for the parser' }),
    ]);
    expect(prompt).toContain('- [PASSED] ctr-00000041: Contract passed: parser added');
    expect(prompt).toContain('- [IN_PROGRESS] ctr-00000042: Docs for the parser');
  });
});

describe('resolveLineageOriginalTask: "Original task" mislabel fix', () => {
  test('compactionCount === 0, originalTask undefined: falls back to lastUserMsg (legitimate first-compaction case)', () => {
    expect(resolveLineageOriginalTask(undefined, 'do the thing', 0)).toBe('do the thing');
  });

  test('compactionCount > 0, originalTask undefined: does NOT fall back to lastUserMsg (the bug)', () => {
    expect(resolveLineageOriginalTask(undefined, 'a much later task', 3)).toBeUndefined();
  });

  test('compactionCount > 0, originalTask set: returns the real original task', () => {
    expect(resolveLineageOriginalTask('the real original task', 'a later task', 2)).toBe(
      'the real original task',
    );
  });

  test('compactionCount === 0, originalTask set: returns the real original task (originalTask always wins)', () => {
    expect(resolveLineageOriginalTask('the real original task', 'a later task', 0)).toBe(
      'the real original task',
    );
  });
});

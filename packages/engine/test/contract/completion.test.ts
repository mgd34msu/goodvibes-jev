/**
 * Finishing a contract (docs/design/contract-runner.md section 6.5), on the
 * contract runner with the fake judgment port and a temporary repository:
 * the commit or apply in worktree mode, the scoped commit in shared mode, a
 * commit failure as a warning, the note outside git, and the answer on the
 * owner record with the status line on the operator audience only.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTRACT_PASSED_WITHOUT_OUTPUT, describeCommitOutcome, describeContractOutcome, renderContractAnswer } from '../../sdk/src/platform/contract/index.js';
import { makeHarness, oneUnitPlan, startContract, twoUnitPlan, waitFor, type AgentScript, type Harness } from './runner-support.js';
import { contractOf, finishes, git, terminal } from './steps-support.js';

let harness: Harness | undefined;
afterEach(() => {
  harness?.dispose();
  harness = undefined;
});

function use(h: Harness): Harness {
  harness = h;
  return h;
}

async function run(h: Harness): Promise<string> {
  const { contract } = startContract(h);
  await waitFor(() => terminal(h, contract.id), 'the contract to end', 15_000);
  return contract.id;
}

describe('the commit (6.5)', () => {
  test('worktree mode: the contract branch is merged into the base branch with a no-fast-forward commit naming the criteria', async () => {
    const h = use(makeHarness({ plan: oneUnitPlan(1), contract: { isolation: 'auto' }, scripts: { u1: finishes('export const parse = 1;') } }));
    const id = await run(h);
    const done = contractOf(h, id);
    expect(done.status).toBe('passed');
    expect(done.commit?.status).toBe('committed');
    expect(done.commit?.note).toBe(`committed ${done.commit!.hash!.slice(0, 8)}`);
    expect(git(h.root, 'rev-parse', 'HEAD').trim()).toBe(done.commit!.hash!);
    // A merge commit: two parents, the base and the contract branch.
    expect(git(h.root, 'rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ')).toHaveLength(3);
    const message = git(h.root, 'log', '-1', '--format=%B');
    expect(message).toContain('A CSV parser');
    expect(message).toContain(`Contract ${id}`);
    expect(message).toContain('Criteria met:\n- [c1] A CSV parser module exists');
    expect(message).toContain('Units:\n- u1 CSV parser');
    expect(git(h.root, 'show', 'HEAD:src/csv.ts')).toBe('export const parse = 1;\n');
    // The contract worktree is gone; its branch stays as the record of the work.
    expect(existsSync(done.worktreePath!)).toBe(false);
    expect(git(h.root, 'branch', '--list', done.branch!).trim()).toBe(done.branch!);
  }, 20_000);

  test('worktree mode with auto-commit off: the work is applied to the base tree as uncommitted changes', async () => {
    const h = use(makeHarness({ plan: oneUnitPlan(1), contract: { isolation: 'auto', autoCommit: false }, scripts: { u1: finishes('export const parse = 2;') } }));
    const head = git(h.root, 'rev-parse', 'HEAD').trim();
    const id = await run(h);
    const done = contractOf(h, id);
    expect(done.status).toBe('passed');
    expect(done.commit).toEqual({ status: 'applied', note: 'applied 1 file as uncommitted changes' });
    expect(git(h.root, 'rev-parse', 'HEAD').trim()).toBe(head);
    expect(readFileSync(join(h.root, 'src/csv.ts'), 'utf-8')).toBe('export const parse = 2;\n');
    expect(git(h.root, 'status', '--porcelain')).toContain('?? src/');
    expect(git(h.root, 'diff', '--cached', '--name-only').trim()).toBe('');
  }, 20_000);

  test('shared mode: exactly the touched paths are committed; a file already dirty at launch and untouched stays out', async () => {
    const h = use(makeHarness({ plan: oneUnitPlan(1), scripts: { u1: finishes('export const parse = 3;') } }));
    writeFileSync(join(h.root, 'README.md'), '# demo, edited by hand\n');
    const id = await run(h);
    const done = contractOf(h, id);
    expect(done.status).toBe('passed');
    expect(done.commit?.status).toBe('committed');
    expect(git(h.root, 'show', '--name-only', '--format=', 'HEAD').trim()).toBe('src/csv.ts');
    expect(git(h.root, 'status', '--porcelain').trim()).toBe('M README.md');
  }, 20_000);

  test('a commit that fails is a warning: the contract passes, and the commit and status line say so', async () => {
    const h = use(makeHarness({ plan: oneUnitPlan(1), scripts: { u1: finishes('export const parse = 4;') } }));
    const hook = join(h.root, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\necho "refused by the test hook" >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    const id = await run(h);
    const done = contractOf(h, id);
    expect(done.status).toBe('passed');
    expect(done.commit?.status).toBe('failed');
    expect(done.commit?.note).toStartWith('commit failed: ');
    expect(done.commit?.note).toEndWith('the changes are left in the working tree');
    expect(done.statusLine).toContain('; commit failed: ');
    expect(existsSync(join(h.root, 'src/csv.ts'))).toBe(true);
  }, 20_000);

  test('outside git the commit is skipped with a note', async () => {
    const script: AgentScript = () => [{ files: { 'src/csv.ts': 'export const parse = 5;\n' }, text: 'writing the parser', tool: true }, { text: 'parser written' }];
    const h = use(makeHarness({ plan: oneUnitPlan(1), contract: { midRunChecks: false }, scripts: { u1: script } }));
    rmSync(join(h.root, '.git'), { recursive: true, force: true });
    const id = await run(h);
    const done = contractOf(h, id);
    expect(done.status).toBe('passed');
    expect(done.commit).toEqual({ status: 'skipped', note: 'commit skipped: not a git repository' });
    expect(done.statusLine).toEndWith('; commit skipped: not a git repository');
  }, 20_000);
});

describe('answer and status (6.5)', () => {
  test("the integration unit's answer reaches the owner record; the status line only the operator audience", async () => {
    const h = use(makeHarness({
      scripts: {
        u1: finishes('parseCsv reads quoted fields'),
        u2: finishes('The convert command now reads CSV through parseCsv.', 'src/convert.ts'),
      },
    }));
    const { contract, owner } = startContract(h);
    await waitFor(() => terminal(h, contract.id), 'the contract to end', 15_000);
    const done = contractOf(h, contract.id);
    expect(done.status).toBe('passed');
    const record = h.manager.getStatus(owner.id)!;
    expect(record.status).toBe('completed');
    expect(record.fullOutput).toBe('The convert command now reads CSV through parseCsv.');
    expect(done.answer).toBe(record.fullOutput);
    expect(record.progressAudience).toBe('operator');
    expect(record.progress).toBe(done.statusLine);
    expect(done.statusLine).toBe(`Contract ${contract.id} passed (2 of 2 criteria met, 0 corrections); ${done.commit!.note}`);
    expect(record.fullOutput).not.toContain('Contract ');
  }, 20_000);

  test("the deliverable judge reads the integration unit's whole final output, and code never states success in its place", async () => {
    const report = 'Wired parseCsv into convert.\n\n```json\n{"version":1,"archetype":"integrator","summary":"Wired the parser into convert.","filesCreated":[],"filesModified":["src/convert.ts"]}\n```';
    for (const [integrationText, expected] of [[report, report], ['', '']] as const) {
      const outputs: unknown[] = [];
      const h = use(makeHarness({
        scripts: { u1: finishes('parseCsv reads quoted fields'), u2: finishes(integrationText, 'src/convert.ts') },
        port: ({ state }) => {
          // The deliverable judge's evidence carries the per-criterion summaries; a group judge's carries its units.
          const evidence = state['evidence'] as Record<string, unknown> | undefined;
          if (evidence !== undefined && 'criteria' in evidence && 'output' in state) outputs.push(state['output']);
          return undefined;
        },
      }));
      const id = await run(h);
      expect(contractOf(h, id).status).toBe('passed');
      expect(outputs.length).toBeGreaterThan(0);
      for (const output of outputs) {
        expect(output).toBe(expected);
        expect(output).not.toContain(CONTRACT_PASSED_WITHOUT_OUTPUT);
      }
      h.dispose();
      harness = undefined;
    }
  }, 40_000);

  test('a structured completion report is reduced to its summary, and a passing contract with no answer says so', () => {
    const report = '```json\n{"version":1,"archetype":"integrator","summary":"Wired the parser into convert.","filesCreated":[],"filesModified":["src/convert.ts"]}\n```';
    const plan = twoUnitPlan();
    const units = plan.groups.flatMap((group) => group.units.map((unit) => ({ id: unit.id, groupId: group.id, role: unit.role, answer: unit.role === 'integration' ? report : 'parser done' })));
    const groups = plan.groups.map((group) => ({ id: group.id, kind: group.kind }));
    expect(renderContractAnswer({ units, groups } as unknown as Parameters<typeof renderContractAnswer>[0])).toBe('Wired the parser into convert.');
    expect(renderContractAnswer({ units: [], groups: [] })).toBe('');
    expect(describeCommitOutcome(null, ['.goodvibes/x'], false)).toBe('commit skipped: 1 ignored path skipped');
    expect(describeCommitOutcome(null, [], true)).toBe('commit skipped: the contract changed no files');
    expect(describeContractOutcome({
      id: 'ctr-00000000',
      criteria: [
        { id: 'c1', text: 'a', origin: 'stated', serves: [], disposition: 'judged', status: 'met', readings: [] },
        { id: 'c2', text: 'b', origin: 'stated', serves: [], disposition: 'excluded', status: 'unread', readings: [] },
      ],
      units: [],
      commit: { status: 'skipped', note: 'commit skipped: not a git repository' },
    })).toBe('Contract ctr-00000000 passed (1 of 1 criterion met, 0 corrections, 1 excluded: requires an agent arrangement); commit skipped: not a git repository');
  });
});

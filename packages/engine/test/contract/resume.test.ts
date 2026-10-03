/**
 * Resume and zombie reaping (docs/design/contract-runner.md section 7.2), with
 * the fake judgment port, a scripted fake executor and a temporary git
 * repository. A first runner starts a contract and is stopped mid-flight (as a
 * process is by a restart), the contract file is set to the status under test
 * where the first runner cannot be stopped there by script, and a second
 * runner over the same repository resumes it with `resumeAll()`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { Contract, ContractView } from '../../sdk/src/platform/contract/index.js';
import { contractPath } from '../../sdk/src/platform/contract/index.js';
import type { DecompositionRunner } from '../../sdk/src/platform/core/plan-decomposition.js';
import { plannerOutput, type AnswerContext } from './plan-support.js';
import { eventsOf, makeHarness, makeRepo, oneUnitPlan, startContract, twoUnitPlan, waitFor, type AgentScript, type Harness, type HarnessOptions } from './runner-support.js';
import { answers, git, replyAnswers, terminal } from './steps-support.js';

const roots: string[] = [];
const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A planner that never answers: the contract stays in planning until the runner stops. */
const stuckPlanner: DecompositionRunner = { run: () => new Promise(() => undefined) };

/** An agent that writes the parser, reports the turn (a mid-run check reads it), and never finishes. */
const writesThenHangs: AgentScript = () => [
  { tool: true, files: { 'src/csv.ts': 'export const parse = (text: string) => text.split(",");\n' }, text: 'wrote the parser' },
  { text: '', stop: { kind: 'hang' } },
];

/** An agent script that fails the test when it runs: the unit must not be given an agent. */
const mustNotRun: AgentScript = () => {
  throw new Error('no agent should run for this unit');
};

type Options = Omit<HarnessOptions, 'root'>;

/** Runs a contract on a first runner until `until` holds of it, then stops that runner. Returns the repository and the contract id. */
async function interrupt(options: Options, until: (contract: ContractView) => boolean, what: string, count = 1): Promise<{ readonly root: string; readonly ids: string[] }> {
  const root = makeRepo();
  roots.push(root);
  const first = makeHarness({ ...options, root });
  const ids: string[] = [];
  try {
    for (let index = 0; index < count; index += 1) ids.push(startContract(first).contract.id);
    await waitFor(() => ids.every((id) => {
      const contract = first.store.get(id);
      return contract !== null && until(contract);
    }), what, 10_000);
    // Checks in flight settle and the debounced writes land; stopping the runner writes anything still pending.
    await sleep(300);
  } finally {
    first.dispose();
    // A restarted process has no surviving local cleanup. Model that barrier
    // before reusing its tree. The deliberately never-answering planner has
    // no engine/tree work and intentionally cannot provide a cleanup receipt.
    if (options.planner !== stuckPlanner) await Promise.all(ids.map((id) => first.runner.join(id)));
  }
  return { root, ids };
}

/** Changes the contract file as the stopped process would have left it. */
function editContract(root: string, id: string, edit: (contract: Contract) => void): void {
  const path = contractPath(root, id);
  const envelope = JSON.parse(readFileSync(path, 'utf-8')) as { contract: Contract };
  edit(envelope.contract);
  writeFileSync(path, JSON.stringify(envelope));
}

/** A second runner over the same repository, as after a restart. */
function restart(root: string, options: Options): Harness {
  const h = makeHarness({ ...options, root });
  harnesses.push(h);
  return h;
}

const contractIn = (h: Harness, id: string): ContractView => {
  const contract = h.store.get(id);
  if (contract === null) throw new Error(`no contract ${id}`);
  return contract;
};

const unitIn = (h: Harness, id: string, unitId: string) => contractIn(h, id).units.find((unit) => unit.id === unitId)!;

async function ended(h: Harness, id: string): Promise<ContractView> {
  await waitFor(() => terminal(h, id), `contract ${id} to end`, 15_000);
  return contractIn(h, id);
}

const running = (contract: ContractView) => contract.units[0]?.status === 'running' && (contract.units[0]?.checks.length ?? 0) >= 1;

describe('planning starts again', () => {
  test('a contract stopped while shaping is shaped again, planned and run', async () => {
    const { root, ids: [id] } = await interrupt({ plan: oneUnitPlan(1), planner: stuckPlanner, scripts: {} }, (contract) => contract.status === 'planning', 'planning');
    editContract(root, id!, (contract) => {
      contract.status = 'shaping';
      contract.shape = undefined;
    });
    const h = restart(root, { plan: oneUnitPlan(1), scripts: { u1: () => [{ files: { 'src/csv.ts': 'parse\n' }, text: 'Wrote the parser.' }] } });
    const report = await h.runner.resumeAll();
    expect(report.resumed).toEqual([{ contractId: id!, step: 'shape' }]);
    const done = await ended(h, id!);
    expect(done.status).toBe('passed');
    expect(eventsOf(h, 'CONTRACT_SHAPED')).toHaveLength(1);
    expect(done.decisions.some((decision) => decision.action === 'resumed' && decision.reason.includes('shaping starts again'))).toBe(true);
  }, 30_000);

  test.each(['planning', 'checking-plan'] as const)('a contract stopped in %s plans again from the beginning, keeping its shape', async (status) => {
    const { root, ids: [id] } = await interrupt({ plan: oneUnitPlan(1), planner: stuckPlanner, scripts: {} }, (contract) => contract.status === 'planning', 'planning');
    editContract(root, id!, (contract) => {
      contract.status = status;
    });
    let plannerRuns = 0;
    const h = restart(root, {
      plan: oneUnitPlan(1),
      planner: {
        run: async () => {
          plannerRuns += 1;
          return { status: 'completed', output: plannerOutput(oneUnitPlan(1)), elapsedMs: 1, agentId: 'planner-again' };
        },
      },
      scripts: { u1: () => [{ files: { 'src/csv.ts': 'parse\n' }, text: 'Wrote the parser.' }] },
    });
    const report = await h.runner.resumeAll();
    expect(report.resumed).toEqual([{ contractId: id!, step: 'plan' }]);
    const done = await ended(h, id!);
    expect(done.status).toBe('passed');
    expect(plannerRuns).toBe(1);
    // The shape read before the restart stands: shaping is not asked again.
    expect(eventsOf(h, 'CONTRACT_SHAPED')).toHaveLength(0);
    expect(done.decisions.some((decision) => decision.action === 'resumed' && decision.reason === `resumed after a restart in ${status}: planning starts again from the beginning`)).toBe(true);
  }, 30_000);
});

describe('units resume at their step', () => {
  test('a unit whose agent was working gets a fresh agent with its brief and "Previous checks"', async () => {
    const { root, ids: [id] } = await interrupt({ plan: oneUnitPlan(1), scripts: { u1: writesThenHangs } }, running, 'u1 running after a check');
    const h = restart(root, { plan: oneUnitPlan(1), scripts: { u1: () => [{ files: { 'src/csv.ts': 'export const parse = 2;\n' }, text: 'Finished the parser.' }] } });
    const report = await h.runner.resumeAll();
    expect(report).toEqual({ resumed: [{ contractId: id!, step: 'run' }], queued: [], reaped: [], skipped: [] });
    const done = await ended(h, id!);
    expect(done.status).toBe('passed');
    const spawned = eventsOf(h, 'CONTRACT_UNIT_SPAWNED');
    expect(spawned.map((event) => [event.unitId, event.purpose])).toEqual([['u1', 'resume']]);
    const task = h.manager.getStatus(spawned[0]!.agentId)!.task;
    expect(task).toContain('Write src/csv.ts.');
    expect(task).toContain('Previous checks');
    const u1 = done.units[0]!;
    // The agent from before the restart and the fresh one.
    expect(u1.agentIds).toHaveLength(2);
    expect(u1.checks.at(-1)).toMatchObject({ trigger: 'completion', result: 'pass' });
    expect(done.decisions.some((decision) => decision.action === 'resumed' && decision.targetId === 'u1')).toBe(true);
  }, 30_000);

  test.each(['held', 'checking'] as const)('a %s unit is checked again with trigger resume and passes on the work its agent left, with no agent', async (status) => {
    const { root, ids: [id] } = await interrupt({ plan: oneUnitPlan(1), scripts: { u1: writesThenHangs } }, running, 'u1 running after a check');
    editContract(root, id!, (contract) => {
      contract.units[0]!.status = status;
      contract.units[0]!.lastOutput = 'Wrote the parser in src/csv.ts.';
    });
    const h = restart(root, { plan: oneUnitPlan(1), scripts: { u1: mustNotRun } });
    await h.runner.resumeAll();
    const done = await ended(h, id!);
    expect(done.status).toBe('passed');
    expect(h.agentsOf('u1')).toEqual([]);
    expect(eventsOf(h, 'CONTRACT_UNIT_SPAWNED')).toEqual([]);
    const resumeCheck = done.units[0]!.checks.at(-1)!;
    expect(resumeCheck).toMatchObject({ trigger: 'resume', result: 'pass' });
    // A check after a restart verifies the completion report the earlier agent left.
    expect(resumeCheck.claims).toBeDefined();
    expect(done.units[0]!.answer).toBe('Wrote the parser in src/csv.ts.');
  }, 30_000);

  test('a resume check verifies the report stored on the unit, not the capped lastOutput', async () => {
    const { root, ids: [id] } = await interrupt({ plan: oneUnitPlan(1), scripts: { u1: writesThenHangs } }, running, 'u1 running after a check');
    const report = { version: 1, archetype: 'engineer', summary: 'Wrote the parser.', filesCreated: ['src/csv.ts'], filesModified: [] };
    editContract(root, id!, (contract) => {
      contract.units[0]!.status = 'held';
      // The head and tail of a long output: the report itself is not in it.
      contract.units[0]!.lastOutput = 'Wrote the parser. ...(cut)... all done.';
      contract.units[0]!.lastReport = report as never;
    });
    const h = restart(root, { plan: oneUnitPlan(1), scripts: { u1: mustNotRun } });
    await h.runner.resumeAll();
    const done = await ended(h, id!);
    expect(done.status).toBe('passed');
    // Re-parsing lastOutput would find no report and claim nothing (verified_empty).
    expect(done.units[0]!.checks.find((check) => check.trigger === 'resume')?.claims?.kind).toBe('files_verified');
  }, 30_000);

  test('a completion check stores the whole report on the unit though lastOutput is capped', async () => {
    const report = { version: 1, archetype: 'engineer', summary: `Wrote the parser. ${'detail '.repeat(4_000)}`, filesCreated: ['src/csv.ts'], filesModified: [], filesDeleted: [] };
    const text = `Finished.\n\`\`\`json\n${JSON.stringify(report)}\n\`\`\``;
    const root = makeRepo();
    roots.push(root);
    const h = restart(root, { plan: oneUnitPlan(1), scripts: { u1: () => [{ files: { 'src/csv.ts': 'export const parse = 1;\n' }, text }] } });
    const id = startContract(h).contract.id;
    const done = await ended(h, id);
    expect(done.status).toBe('passed');
    const u1 = done.units[0]!;
    expect(u1.lastReport).toEqual(report as never);
    expect(u1.lastOutput!.length).toBeLessThan(text.length);
    expect(u1.checks.find((check) => check.trigger === 'completion')?.claims?.kind).toBe('files_verified');
  }, 30_000);

  test('a nudged unit is checked again; the nudge goes to a fresh agent, which fixes the work', async () => {
    const { root, ids: [id] } = await interrupt({ plan: oneUnitPlan(1), scripts: { u1: writesThenHangs } }, running, 'u1 running after a check');
    editContract(root, id!, (contract) => {
      contract.units[0]!.status = 'nudged';
      contract.units[0]!.lastOutput = 'The parser is half done. [unmet]';
    });
    const h = restart(root, { plan: oneUnitPlan(1), scripts: { u1: () => [{ files: { 'src/csv.ts': 'export const parse = 3;\n' }, text: 'Finished the parser.' }] } });
    await h.runner.resumeAll();
    const done = await ended(h, id!);
    expect(done.status).toBe('passed');
    const u1 = done.units[0]!;
    expect(u1.checks.slice(-2).map((check) => [check.trigger, check.result])).toEqual([['resume', 'nudge'], ['completion', 'pass']]);
    const spawned = eventsOf(h, 'CONTRACT_UNIT_SPAWNED');
    expect(spawned.map((event) => event.purpose)).toEqual(['resume']);
    // The fresh agent's first turn carries the nudge after the brief and previous checks.
    const task = h.manager.getStatus(spawned[0]!.agentId)!.task;
    expect(task).toContain('Previous checks');
    expect(task).toContain(u1.nudges.at(-1)!.text);
  }, 30_000);

  test('a unit waiting on its owner stays waiting with its escalation; the owner\'s approval passes it with no agent', async () => {
    const { root, ids: [id] } = await interrupt({ plan: oneUnitPlan(1), scripts: { u1: writesThenHangs } }, running, 'u1 running after a check');
    editContract(root, id!, (contract) => {
      const u1 = contract.units[0]!;
      u1.status = 'awaiting-owner';
      u1.lastOutput = 'Wrote the parser.';
      u1.answer = 'Wrote the parser.';
      for (const criterion of u1.criteria) criterion.status = 'unshown';
      contract.statusBeforeOwner = 'running';
      contract.status = 'awaiting-owner';
      contract.escalations.push({ id: `${contract.id}.e1`, at: Date.now(), scope: 'unit', targetId: 'u1', reason: 'unsettled', question: 'Confirm the parser?', unmetCriterionIds: [] });
    });
    const h = restart(root, { plan: oneUnitPlan(1), scripts: { u1: mustNotRun }, port: replyAnswers([{ reading: 'approve' }]) });
    const report = await h.runner.resumeAll();
    expect(report.resumed).toEqual([{ contractId: id!, step: 'await-owner' }]);
    await sleep(300);
    expect(contractIn(h, id!).status).toBe('awaiting-owner');
    expect(contractIn(h, id!).escalations[0]!.resolvedAt).toBeUndefined();
    expect(h.agentsOf('u1')).toEqual([]);

    await h.runner.reply(id!, `${id!}.e1`, 'Yes, the parser is fine.');
    const done = await ended(h, id!);
    expect(done.status).toBe('passed');
    expect(h.agentsOf('u1')).toEqual([]);
    expect(done.statusBeforeOwner).toBeUndefined();
  }, 30_000);

  test('worktree mode: a held unit passes its resume check, its item commits and merges with no agent, and the contract commits', async () => {
    const options: Options = { plan: oneUnitPlan(1), contract: { isolation: 'auto' }, scripts: { u1: writesThenHangs } };
    const { root, ids: [id] } = await interrupt(options, running, 'u1 running after a check');
    editContract(root, id!, (contract) => {
      contract.units[0]!.status = 'held';
      contract.units[0]!.lastOutput = 'Wrote the parser in src/csv.ts.';
    });
    const h = restart(root, { ...options, scripts: { u1: mustNotRun } });
    await h.runner.resumeAll();
    const done = await ended(h, id!);
    expect(done.status).toBe('passed');
    expect(h.agentsOf('u1')).toEqual([]);
    expect(done.commit?.status).toBe('committed');
    expect(git(root, 'show', 'HEAD:src/csv.ts')).toContain('text.split');
  }, 30_000);
});

describe('the deliverable steps run again', () => {
  const finished = (contract: ContractView) => contract.status === 'passed';
  const scripts = { u1: () => [{ files: { 'src/csv.ts': 'export const parse = 4;\n' }, text: 'Wrote the parser.' }] };

  function rewind(contract: Contract, status: 'judging' | 'committing'): void {
    contract.status = status;
    contract.completedAt = undefined;
    contract.answer = undefined;
    contract.statusLine = undefined;
    contract.commit = undefined;
  }

  test('a contract stopped while judging is judged again with trigger resume, then commits', async () => {
    const { root, ids: [id] } = await interrupt({ plan: oneUnitPlan(1), scripts }, finished, 'the contract to pass');
    const checksBefore = (JSON.parse(readFileSync(contractPath(root, id!), 'utf-8')) as { contract: Contract }).contract.checks.length;
    editContract(root, id!, (contract) => rewind(contract, 'judging'));
    const h = restart(root, { plan: oneUnitPlan(1), scripts: { u1: mustNotRun } });
    const report = await h.runner.resumeAll();
    expect(report.resumed).toEqual([{ contractId: id!, step: 'judge' }]);
    const done = await ended(h, id!);
    expect(done.status).toBe('passed');
    expect(done.checks).toHaveLength(checksBefore + 1);
    expect(done.checks.at(-1)!.trigger).toBe('resume');
    expect(eventsOf(h, 'CONTRACT_COMMITTED')).toHaveLength(1);
  }, 30_000);

  test('a contract stopped while committing commits again without another check', async () => {
    const { root, ids: [id] } = await interrupt({ plan: oneUnitPlan(1), scripts }, finished, 'the contract to pass');
    editContract(root, id!, (contract) => rewind(contract, 'committing'));
    const h = restart(root, { plan: oneUnitPlan(1), scripts: { u1: mustNotRun } });
    const report = await h.runner.resumeAll();
    expect(report.resumed).toEqual([{ contractId: id!, step: 'commit' }]);
    const done = await ended(h, id!);
    expect(done.status).toBe('passed');
    expect(done.checks.some((check) => check.trigger === 'resume')).toBe(false);
    expect(eventsOf(h, 'CONTRACT_COMMITTED')).toHaveLength(1);
    expect(done.decisions.some((decision) => decision.action === 'resumed' && decision.reason.includes('the commit runs again'))).toBe(true);
  }, 30_000);
});

describe('the active-contract cap', () => {
  test('contracts beyond the cap wait in the queue and resume from their step when a slot opens', async () => {
    const { root, ids } = await interrupt({ plan: oneUnitPlan(1), planner: stuckPlanner, scripts: {} }, (contract) => contract.status === 'planning', 'both planning', 2);
    // Each contract's agent writes its own content, so the second has work of its own after the first committed.
    const h = restart(root, { plan: oneUnitPlan(1), contract: { maxActiveContracts: 1 }, scripts: { u1: (record) => [{ files: { 'src/csv.ts': `parse ${record.id}\n` }, text: 'Wrote the parser.' }] } });
    const report = await h.runner.resumeAll();
    expect(report.resumed).toHaveLength(1);
    expect(report.resumed[0]!.step).toBe('plan');
    const first = report.resumed[0]!.contractId;
    const second = ids.find((id) => id !== first);
    expect(report.queued).toEqual([second!]);
    expect(contractIn(h, second!).status).toBe('queued');
    expect(contractIn(h, second!).resumeFrom).toBe('planning');
    expect((await ended(h, first!)).status).toBe('passed');
    const later = await ended(h, second!);
    expect(later.status).toBe('passed');
    expect(later.resumeFrom).toBeUndefined();
    expect(later.decisions.some((decision) => decision.action === 'resumed' && decision.reason.includes('in planning'))).toBe(true);
  }, 40_000);
});

describe('zombies', () => {
  function expectReaped(h: Harness, id: string, reasonPart: string): void {
    const contract = contractIn(h, id);
    expect(contract.status).toBe('failed');
    expect(contract.failureKind).toBe('zombie');
    expect(contract.error).toContain(reasonPart);
    expect(contract.decisions.some((decision) => decision.action === 'reaped')).toBe(true);
    expect(eventsOf(h, 'CONTRACT_STATUS_CHANGED').some((event) => event.contractId === id && event.to === 'failed')).toBe(true);
    expect(eventsOf(h, 'CONTRACT_FAILED')).toEqual([expect.objectContaining({ contractId: id, failureKind: 'zombie', membersSettled: true })]);
    expect(h.agentsOf('u1')).toEqual([]);
  }

  test('a running group with no workstream snapshot is reaped as a zombie, naming the group', async () => {
    const { root, ids: [id] } = await interrupt({ plan: oneUnitPlan(1), scripts: { u1: writesThenHangs } }, running, 'u1 running after a check');
    rmSync(join(root, '.goodvibes', 'orchestration', id!, 'g1.json'));
    const h = restart(root, { plan: oneUnitPlan(1), scripts: { u1: mustNotRun } });
    const report = await h.runner.resumeAll();
    expect(report.reaped).toEqual([{ contractId: id!, reason: `contract ${id!} could not resume: group g1 is running but has no loadable workstream snapshot` }]);
    expectReaped(h, id!, 'group g1 is running but has no loadable workstream snapshot');
    // The failed tree is written, so the next start does not reap it again.
    await sleep(100);
    expect((JSON.parse(readFileSync(contractPath(root, id!), 'utf-8')) as { contract: Contract }).contract.status).toBe('failed');
  }, 30_000);

  test('a corrupt workstream snapshot is quarantined and the contract reaped', async () => {
    const { root, ids: [id] } = await interrupt({ plan: oneUnitPlan(1), scripts: { u1: writesThenHangs } }, running, 'u1 running after a check');
    const snapshot = join(root, '.goodvibes', 'orchestration', id!, 'g1.json');
    writeFileSync(snapshot, '{ not a snapshot');
    const h = restart(root, { plan: oneUnitPlan(1), scripts: { u1: mustNotRun } });
    await h.runner.resumeAll();
    expectReaped(h, id!, 'no loadable workstream snapshot');
    expect(existsSync(`${snapshot}.unrecognized`)).toBe(true);
  }, 30_000);

  test('worktree mode: a missing contract worktree reaps the contract, naming the path', async () => {
    const { root, ids: [id] } = await interrupt({ plan: oneUnitPlan(1), contract: { isolation: 'auto' }, scripts: { u1: writesThenHangs } }, running, 'u1 running after a check');
    const worktree = (JSON.parse(readFileSync(contractPath(root, id!), 'utf-8')) as { contract: Contract }).contract.worktreePath!;
    rmSync(worktree, { recursive: true, force: true });
    const h = restart(root, { plan: oneUnitPlan(1), contract: { isolation: 'auto' }, scripts: { u1: mustNotRun } });
    await h.runner.resumeAll();
    expectReaped(h, id!, `its contract worktree ${worktree} no longer exists`);
  }, 30_000);

  test('a terminal contract is held for viewing and never resumed or reaped', async () => {
    const { root, ids: [id] } = await interrupt({ plan: oneUnitPlan(1), scripts: { u1: () => [{ files: { 'src/csv.ts': 'x\n' }, text: 'Wrote the parser.' }] } }, (contract) => contract.status === 'passed', 'the contract to pass');
    const h = restart(root, { plan: oneUnitPlan(1), scripts: { u1: mustNotRun } });
    const report = await h.runner.resumeAll();
    expect(report).toEqual({ resumed: [], queued: [], reaped: [], skipped: [] });
    expect(h.runner.get(id!)?.status).toBe('passed');
  }, 30_000);
});

describe('a later group and the whole plan', () => {
  test('a two-group contract stopped while g1 ran resumes g1 and then runs g2', async () => {
    const { root, ids: [id] } = await interrupt({ plan: twoUnitPlan(), scripts: { u1: writesThenHangs } }, running, 'u1 running after a check');
    const h = restart(root, {
      plan: twoUnitPlan(),
      scripts: {
        u1: () => [{ files: { 'src/csv.ts': 'export const parse = 5;\n' }, text: 'Finished the parser.' }],
        u2: () => [{ files: { 'src/convert.ts': 'import { parse } from "./csv";\n' }, text: 'Wired convert.' }],
      },
    });
    await h.runner.resumeAll();
    const done = await ended(h, id!);
    expect(done.status).toBe('passed');
    expect(done.groups.map((group) => group.status)).toEqual(['passed', 'passed']);
    expect(eventsOf(h, 'CONTRACT_UNIT_SPAWNED').map((event) => [event.unitId, event.purpose])).toEqual([['u1', 'resume'], ['u2', 'unit']]);
  }, 30_000);
});

describe('session mode', () => {
  function noDelegation(context: AnswerContext): unknown {
    return context.name === 'forbids_delegation' ? noulAnswer(0.97) : undefined;
  }
  const waitingForTurn = (contract: ContractView) => contract.sessionMode === true && contract.units[0]?.status === 'running';

  test('a nudge that waited for the session\'s next turn waits again after the restart', async () => {
    const { root, ids: [id] } = await interrupt({ plan: oneUnitPlan(1), port: answers(noDelegation), scripts: {} }, waitingForTurn, 'the session-mode unit');
    editContract(root, id!, (contract) => {
      const u1 = contract.units[0]!;
      u1.status = 'nudged';
      u1.activeAgentId = 'turn-1';
      u1.agentIds.push('turn-1');
      u1.nudges.push({ id: 'u1.n1', checkId: 'u1.k1', at: Date.now(), kinds: ['unmet'], criterionIds: ['u1.c1'], text: 'Not met: parse quoted fields.', delivery: 'bus', agentId: 'turn-1' });
    });
    const h = restart(root, { plan: oneUnitPlan(1), port: answers(noDelegation), scripts: { u1: mustNotRun } });
    await h.runner.resumeAll();
    const record = h.runner.hooks().sessionTurn('session-1', 'turn-2');
    expect(record?.contractUnitId).toBe('u1');
    expect(h.runner.hooks().takeSessionNudge(record!)).toEqual({ message: 'Not met: parse quoted fields.', nudgeId: 'u1.n1' });
    expect(h.agentsOf('u1')).toEqual([]);
  }, 30_000);

  test('a held session-mode unit is checked again with trigger resume and passes; no sub-agent is spawned', async () => {
    const { root, ids: [id] } = await interrupt({ plan: oneUnitPlan(1), port: answers(noDelegation), scripts: {} }, waitingForTurn, 'the session-mode unit');
    // The session's turn wrote the parser before the restart.
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'csv.ts'), 'export const parse = 6;\n');
    editContract(root, id!, (contract) => {
      const u1 = contract.units[0]!;
      u1.status = 'held';
      u1.activeAgentId = 'turn-1';
      u1.lastOutput = 'Wrote the parser.';
    });
    const h = restart(root, { plan: oneUnitPlan(1), port: answers(noDelegation), scripts: { u1: mustNotRun } });
    await h.runner.resumeAll();
    const done = await ended(h, id!);
    expect(done.status).toBe('passed');
    expect(done.units[0]!.checks.at(-1)).toMatchObject({ trigger: 'resume', result: 'pass' });
    expect(h.manager.list().filter((record) => record.contractRole === 'unit')).toEqual([]);
  }, 30_000);
});

describe('the unit in the resumed tree', () => {
  test('the contract file of a running contract records what the restart needs', async () => {
    const { root, ids: [id] } = await interrupt({ plan: oneUnitPlan(1), scripts: { u1: writesThenHangs } }, running, 'u1 running after a check');
    // The engine's snapshot of the unit's item was written when the runner stopped: it is the resume point.
    const snapshot = JSON.parse(readFileSync(join(root, '.goodvibes', 'orchestration', id!, 'g1.json'), 'utf-8')) as { workstream: { items: { id: string; state: string }[] } };
    expect(snapshot.workstream.items.find((item) => item.id === 'u1')?.state).toBe('in-phase');
    const h = restart(root, { plan: oneUnitPlan(1), scripts: { u1: () => [{ files: { 'src/csv.ts': 'y\n' }, text: 'Finished.' }] } });
    await h.runner.resumeAll();
    await ended(h, id!);
    expect(unitIn(h, id!, 'u1').status).toBe('passed');
  }, 30_000);
});

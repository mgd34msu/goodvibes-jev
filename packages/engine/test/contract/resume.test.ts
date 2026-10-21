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
import { uptime } from 'node:os';
import { choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { JudgmentError } from '@goodvibes-jev/judgment';
import type { Contract, ContractView } from '../../sdk/src/platform/contract/index.js';
import { contractPath } from '../../sdk/src/platform/contract/index.js';
import type { DecompositionRunner } from '../../sdk/src/platform/core/plan-decomposition.js';
import { plannerOutput, type AnswerContext } from './plan-support.js';
import { eventsOf, makeHarness, makeRepo, oneUnitPlan, startContract, twoUnitPlan, waitFor, type AgentScript, type Harness, type HarnessOptions } from './runner-support.js';
import { answers, git, judgeOf, replyAnswers, terminal } from './steps-support.js';

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

test.each([false, true])('a rejected verifier request cannot cancel a sibling or pass unchecked work (persistent=%s)', async persistent => {
  const plan = twoUnitPlan();
  const firstUnit = plan.groups[0]!.units[0]!;
  firstUnit.role = 'research';
  plan.groups[0]!.units.push({ ...firstUnit, id: 'u3', files: ['src/independent.ts'], title: 'Independent review', criteria: [{ ...firstUnit.criteria[0]!, id: 'u3.c1' }] });
  plan.groups[1]!.units[0]!.title = 'Integration fixture';
  let failures = 0;
  const h = makeHarness({ plan, contract: { isolation: 'worktree', maxParallelUnits: 2 }, scripts: {
    u1: () => [{ text: 'First private report.' }, { text: 'Repaired private report.' }, { text: 'Bounded private report.' }],
    u3: () => [{ text: 'Independent source assessment.' }],
    u2: () => [{ files: { 'src/convert.ts': 'export const convert = () => true;\n' }, text: 'Integrated the parser.' }],
  }, port: context => {
    if (context.name === 'role') return choiceAnswer(context.question, (context.state['unit'] as { title?: string })?.title === 'Integration fixture' ? 'implement' : 'research', 0.98);
    if (judgeOf(context) === 'unit' && String(context.state['output']).includes('private report') && context.name === 'goal' && (persistent || failures === 0)) {
      failures++; throw new JudgmentError('rejected', 'fixture request rejection', { status: 400 });
    }
    return undefined;
  } });
  roots.push(h.root); harnesses.push(h);
  mkdirSync(join(h.root, 'src'), { recursive: true });
  writeFileSync(join(h.root, 'src/csv.ts'), 'export const parser = true;\n');
  writeFileSync(join(h.root, 'src/independent.ts'), 'export const independent = true;\n');
  const { contract } = startContract(h);
  if (persistent) {
    await waitFor(() => unitIn(h, contract.id, 'u3')?.status === 'passed' && failures === 3 && unitIn(h, contract.id, 'u1')?.status === 'held', 'only verifier-failing unit to wait');
    expect(contractIn(h, contract.id).status).toBe('running');
    expect(unitIn(h, contract.id, 'u1').checks).toEqual([]);
    expect(unitIn(h, contract.id, 'u1').criteria[0]!.status).toBe('unread');
  } else {
    expect((await ended(h, contract.id)).status).toBe('passed');
    expect(failures).toBe(1);
    expect(unitIn(h, contract.id, 'u1').checks).toHaveLength(1);
  }
  expect(eventsOf(h, 'CONTRACT_FAILED')).toEqual([]);
  expect(unitIn(h, contract.id, 'u3').status).toBe('passed');
});

test('read observations are persisted before a candidate or acceptance check exists', async () => {
  const root = makeRepo(); roots.push(root);
  const plan = oneUnitPlan(1);
  plan.groups[0]!.units[0]!.role = 'research';
  const first = makeHarness({ root, plan, contract: { midRunChecks: false }, scripts: { u1: () => [{ text: '', stop: { kind: 'hang' } }] },
    port: context => context.name === 'role' ? choiceAnswer(context.question, 'research', 0.98) : undefined });
  harnesses.push(first);
  const { contract } = startContract(first);
  await waitFor(() => first.agentsOf('u1').some(id => first.manager.getStatus(id)?.status === 'running'), 'research worker');
  const record = first.manager.getStatus(first.agentsOf('u1')[0]!)!;
  first.runner.hooks().onTurnEnd(record, { turn: 1, assistantText: 'Inspecting the source.',
    toolCalls: [{ name: 'read', arguments: { files: [{ path: 'src/review.ts' }] } }],
    results: [{ callId: 'read', success: true, output: JSON.stringify({ success: true, files: [{ path: 'src/review.ts', extract: 'lines', content: '1 | const a = 1;\n2 | const b = 2;' }] }) }] });
  await waitFor(() => {
    const disk = JSON.parse(readFileSync(contractPath(root, contract.id), 'utf8')).contract;
    return disk.units[0]?.readEvidence?.[0]?.returnedRanges.join() === '1-2';
  }, 'read evidence checkpoint before completion');
  const saved = JSON.parse(readFileSync(contractPath(root, contract.id), 'utf8')).contract;
  expect(saved.units[0].checks).toEqual([]);
  expect(saved.units[0].status).toBe('running');
  expect(saved.units[0].lastOutput).toBeUndefined();
  first.dispose();
  await first.runner.join(contract.id);
  const restored = JSON.parse(readFileSync(contractPath(root, contract.id), 'utf8')).contract;
  expect(restored.units[0].readEvidence[0].returnedRanges).toEqual(['1-2']);
});

test('a held read-only candidate and its observed source survive restart and receive a fresh check', async () => {
  const root = makeRepo(); roots.push(root);
  const plan = oneUnitPlan(1);
  plan.groups[0]!.units[0]!.role = 'research';
  plan.groups[0]!.units[0]!.files = ['src/review.ts'];
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/review.ts'), 'export function clamp(value, min, max) {\n  return Math.min(max, Math.max(min, value));\n}\n');
  const first = makeHarness({ root, plan, contract: { midRunChecks: false },
    scripts: { u1: () => [{ text: '', stop: { kind: 'hang' } }] },
    port: context => context.name === 'role' ? choiceAnswer(context.question, 'research', 0.98)
      : judgeOf(context) === 'unit' ? noulAnswer(0.98) : undefined });
  harnesses.push(first);
  const { contract } = startContract(first);
  await waitFor(() => first.agentsOf('u1').some(id => first.manager.getStatus(id)?.status === 'running'), 'the read-only worker to start');
  const record = first.manager.getStatus(first.agentsOf('u1')[0]!)!;
  first.runner.hooks().onTurnEnd(record, { turn: 1, assistantText: '',
    toolCalls: [{ name: 'read', arguments: { files: [{ path: 'src/review.ts' }] } }],
    results: [{ callId: 'actual-read', success: true, output: JSON.stringify({ success: true, files: [{ path: 'src/review.ts', extract: 'content',
      content: '    1 | export function clamp(value, min, max) {\n    2 |   return Math.min(max, Math.max(min, value));\n    3 | }' }] }) }] });
  const candidate = 'Reviewed src/review.ts:1-3. For min <= max, the inner max enforces the lower bound and the outer min the upper bound; zero inside the interval stays zero. This is source analysis; no test execution or native approval is claimed.';
  expect(await first.runner.hooks().holdCompletion(record, candidate)).toMatchObject({ kind: 'continue' });
  expect(unitIn(first, contract.id, 'u1').lastOutput).toBe(candidate);
  expect(unitIn(first, contract.id, 'u1').criteria[0]!.status).toBe('unmet');
  first.dispose();
  await first.runner.join(contract.id);
  const resumedStates: unknown[] = [];
  const second = restart(root, { plan, scripts: { u1: mustNotRun }, port: context => {
    if (context.name === 'role') return choiceAnswer(context.question, 'research', 0.98);
    if (judgeOf(context) !== 'unit') return undefined;
    resumedStates.push(context.state);
    const evidence = context.state['evidence'] as { sourceReads?: { returnedRanges: string[] }[] };
    return noulAnswer(context.state['output'] === candidate && evidence.sourceReads?.[0]?.returnedRanges.join() === '1-3' ? 0.02 : 0.98);
  } });
  await second.runner.resumeAll();
  expect((await ended(second, contract.id)).status).toBe('passed');
  expect(resumedStates.length).toBeGreaterThan(0);
  expect(unitIn(second, contract.id, 'u1').checks.at(-1)).toMatchObject({ trigger: 'resume', result: 'pass' });
  expect(second.agentsOf('u1')).toEqual([]);
}, 20_000);

describe('planning starts again', () => {
  test('resume restores the original owner and reports completion through that identity', async () => {
    const { root, ids: [id] } = await interrupt({ plan: oneUnitPlan(1), planner: stuckPlanner, scripts: {} }, c => c.status === 'planning', 'planning');
    const saved = JSON.parse(readFileSync(contractPath(root, id!), 'utf8')).contract as Contract;
    const ready = Promise.withResolvers<void>();
    const h = restart(root, { plan: oneUnitPlan(1), scripts: {
      u1: () => [{ before: () => ready.promise, files: { 'src/csv.ts': 'parse\n' }, text: 'Parser written.' }],
    } });
    const completed: string[] = [];
    h.bus.onDomain('agents', ({ payload }) => { if (payload.type === 'AGENT_COMPLETED') completed.push(payload.agentId); });
    await h.runner.resumeAll();
    const owner = h.manager.getStatus(saved.ownerAgentId)!;
    expect(owner).toMatchObject({ id: saved.ownerAgentId, contractId: id, contractRole: 'owner', status: 'running' });
    let settled = false;
    const joined = h.manager.join(owner.id).then(() => { settled = true; });
    await sleep(0);
    expect(settled).toBe(false);
    ready.resolve();
    const done = await ended(h, id!);
    await joined;
    expect(done.status).toBe('passed');
    expect(owner.status).toBe('completed');
    expect(owner.fullOutput).toBe(done.answer);
    expect(completed.filter(agentId => agentId === owner.id)).toEqual([owner.id]);
  }, 30_000);

  test('a saved writing-unclear question resumes planning without an owner reply', async () => {
    const { root, ids: [id] } = await interrupt({ plan: oneUnitPlan(1), planner: stuckPlanner, scripts: {} }, contract => contract.status === 'planning', 'planning');
    editContract(root, id!, contract => {
      contract.status = 'awaiting-owner';
      contract.shape = { ...contract.shape!, forbids_writing: { verdict: 'uncertain', probability: 0.5, outcome: 'escalate' } };
      contract.escalations.push({ id: `${contract.id}.e1`, at: Date.now(), scope: 'shape', targetId: contract.id,
        reason: 'writing-unclear', question: 'May files change?', unmetCriterionIds: [] });
    });
    const h = restart(root, { plan: oneUnitPlan(1), scripts: { u1: () => [{ files: { 'src/csv.ts': 'parse\n' }, text: 'Wrote the parser.' }] } });
    const report = await h.runner.resumeAll();
    expect(report.resumed).toEqual([{ contractId: id!, step: 'plan' }]);
    const done = await ended(h, id!);
    expect(done.status).toBe('passed');
    expect(done.shape!.forbids_writing.probability).toBe(0.5);
    expect(done.escalations[0]!.resolvedAt).toBeDefined();
    expect(done.escalations[0]!.reply).toBeUndefined();
    expect(eventsOf(h, 'CONTRACT_OWNER_REPLIED')).toHaveLength(0);
  });

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

  test('a completion check retains the complete report and last output', async () => {
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
    expect(u1.lastOutput).toBe(text);
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
      // Keep the actual met criteria from the preceding check. Owner approval
      // cannot manufacture evidence for unshown work.
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

  test('a held unit survives device renumbering with a fresh check and no repeated worker', async () => {
    const options: Options = { plan: oneUnitPlan(1), contract: { isolation: 'worktree' }, scripts: { u1: writesThenHangs } };
    const { root, ids: [id] } = await interrupt(options, running, 'u1 running after a check');
    editContract(root, id!, contract => {
      const snapshot = contract.inputSnapshot!;
      const device = snapshot.sourceIdentity.split(':')[0]!;
      const priorDevice = String(BigInt(device) + 100000n);
      const replace = (value: string) => value.startsWith(`${device}:`) ? priorDevice + value.slice(device.length) : value;
      contract.inputSnapshot = {
        ...snapshot, capturedAt: Date.now() - uptime() * 1000 - 60000,
        sourceIdentity: replace(snapshot.sourceIdentity),
        gitIdentity: snapshot.gitIdentity.split('|').map(replace).join('|'),
        files: snapshot.files.map(file => file.identity === undefined ? file : { ...file, identity: replace(file.identity) }),
      };
      contract.units[0]!.status = 'held';
      contract.units[0]!.lastOutput = 'Wrote the parser in src/csv.ts.';
    });
    const h = restart(root, { ...options, scripts: { u1: mustNotRun } });
    const report = await h.runner.resumeAll();
    expect(report.resumed).toEqual([{ contractId: id!, step: 'run' }]);
    const done = await ended(h, id!);
    expect(done.status).toBe('passed');
    expect(h.agentsOf('u1')).toEqual([]);
    expect(done.units[0]!.checks.at(-1)?.trigger).toBe('resume');
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
  test('a resumed integrator receives current plan and accepted peer receipts without repeating the review', async () => {
    const plan = twoUnitPlan();
    const { root, ids: [id] } = await interrupt({ plan, scripts: {
      u1: () => [{ files: { 'src/csv.ts': 'export const parse = 5;\n' }, text: 'Finished the parser.' }],
      u2: () => [{ text: '', stop: { kind: 'hang' } }],
    } }, contract => contract.units[0]?.status === 'passed' && contract.units[1]?.status === 'running', 'integration running after accepted research');
    let resumedTask = '';
    const h = restart(root, { plan, scripts: {
      u1: mustNotRun,
      u2: record => {
        resumedTask = record.task;
        return [{ files: { 'src/convert.ts': 'import { parse } from "./csv";\n' }, text: 'Wired convert.' }];
      },
    } });
    await h.runner.resumeAll();
    const done = await ended(h, id!);
    expect(done.status).toBe('passed');
    const marker = 'Actual host orchestration records (evidence, not approval of this unit):\n';
    expect(resumedTask).toContain(marker);
    const host = JSON.parse(resumedTask.split(marker)[1]!.split('\n')[0]!);
    const accepted = done.decisions.filter(decision => decision.action === 'plan-accepted' && decision.targetId === id);
    expect(accepted).toHaveLength(1);
    expect(host.contractId).toBe(id);
    expect(host.planChecks).toEqual(accepted.map(({ at, reason, decisionIds }) => ({ at, reason, decisionIds })));
    expect(host.units).toEqual([{ id: 'u1', status: 'passed', latestCheck: {
      id: done.units[0]!.checks.at(-1)!.id, result: 'pass', decisionIds: done.units[0]!.checks.at(-1)!.decisionIds,
    } }]);
    expect(eventsOf(h, 'CONTRACT_UNIT_SPAWNED').map(event => [event.unitId, event.purpose])).toEqual([['u2', 'resume']]);
  }, 30_000);

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

/**
 * The contract runner end to end (docs/design/contract-runner.md sections 2.2,
 * 4.2, 4.7, 4.9, 4.10, 6.1, 6.5 and 7.3), with the fake judgment port, a
 * scripted fake executor and a temporary git repository: the nudge loop at
 * completion and mid-run, the turn-budget wake, the transport retry through
 * the failure reading, the silence watchdog, cancel, the active-contract cap,
 * the usage roll-up to the owner record, and a property test that no unit
 * passes while a criterion reads unmet.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readingsOf, SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { installJudgmentPort, judgmentPort } from '@goodvibes-jev/engine/errors';
import type { DecompositionRunner } from '../../sdk/src/platform/core/plan-decomposition.js';
import { acquireSharedTree, sharedTreeWaiters } from '../../sdk/src/platform/contract/index.js';
import { emitAgentCompleted, emitAgentFailed } from '../../sdk/src/platform/runtime/emitters/agents.js';
import {
  eventsOf,
  makeHarness,
  makeRepo,
  oneUnitPlan,
  startContract,
  twoUnitPlan,
  waitFor,
  type AgentStep,
  type Harness,
} from './runner-support.js';

let harness: Harness | undefined;
afterEach(() => {
  harness?.dispose();
  harness = undefined;
});

function use(h: Harness): Harness {
  harness = h;
  return h;
}

const terminal = (h: Harness, contractId: string): boolean => {
  const status = h.store.get(contractId)?.status;
  return status === 'passed' || status === 'failed' || status === 'cancelled';
};

describe('the nudge loop', () => {
  test('a two-unit plan: u1 is nudged at completion, fixes, passes on re-check; u2 then passes and the owner carries the answer', async () => {
    const h = use(makeHarness({
      plan: twoUnitPlan(),
      scripts: {
        u1: () => [
          { files: { 'src/csv.ts': 'export const parse = () => [];\n' }, text: 'Wrote a first parser. [unmet]' },
          { files: { 'src/csv.ts': 'export const parse = (text: string) => text.split(",");\n' }, text: 'Fixed the parser.' },
        ],
        u2: () => [{ files: { 'src/convert.ts': 'import { parse } from "./csv";\n' }, text: 'Wired convert to the parser.' }],
      },
    }));
    const { contract, owner } = startContract(h);
    expect(owner.contractRole).toBe('owner');
    expect(owner.status).toBe('running');
    await waitFor(() => terminal(h, contract.id), 'the contract to end');

    const done = h.store.get(contract.id)!;
    expect(done.status).toBe('passed');
    const u1 = done.units.find((unit) => unit.id === 'u1')!;
    expect(u1.status).toBe('passed');
    expect(u1.checks.map((check) => [check.trigger, check.result])).toEqual([['completion', 'nudge'], ['completion', 'pass']]);
    expect(u1.nudges).toHaveLength(1);
    expect(u1.nudges[0]!.delivery).toBe('hold');
    expect(u1.nudges[0]!.text).toContain('Not met:');
    expect(u1.nudges[0]!.consumedAt).toBeDefined();
    expect(u1.criteria[0]!.readings.map((reading) => reading.verdict)).toEqual(['unmet', 'met']);
    // The same agent was held, nudged, and released: one agent for u1.
    expect(u1.agentIds).toHaveLength(1);
    expect(h.holds.filter((hold) => hold.agentId === u1.agentIds[0]).map((hold) => hold.outcome.kind)).toEqual(['continue', 'release']);

    const u2 = done.units.find((unit) => unit.id === 'u2')!;
    expect(u2.status).toBe('passed');
    expect(u2.nudges).toHaveLength(0);
    expect(done.groups.map((group) => group.status)).toEqual(['passed', 'passed']);
    // u2 started only after g1 passed, and its brief carried u1's answer (integration).
    const spawned = eventsOf(h, 'CONTRACT_UNIT_SPAWNED');
    expect(spawned.map((event) => event.unitId)).toEqual(['u1', 'u2']);
    expect(spawned[0]!.route.reason).toBe('test tier');
    expect(h.manager.getStatus(u2.agentIds[0]!)!.task).toContain('Fixed the parser.');

    const ownerRecord = h.manager.getStatus(owner.id)!;
    expect(ownerRecord.status).toBe('completed');
    expect(ownerRecord.fullOutput).toBe('Wired convert to the parser.');
    expect(ownerRecord.progressAudience).toBe('operator');
    expect(eventsOf(h, 'CONTRACT_PASSED')[0]).toMatchObject({ criteriaJudged: 2, nudges: 1 });
    expect(readFileSync(join(h.root, 'src/csv.ts'), 'utf-8')).toContain('split');
  });

  test('a mid-run regression is nudged through the message bus as a steer, and the unit then passes', async () => {
    let h: Harness;
    const checksDone = (count: number) => () => waitFor(() => eventsOf(h, 'CONTRACT_CHECKED').length >= count, `${count} checks`);
    h = use(makeHarness({
      plan: oneUnitPlan(1),
      scripts: {
        u1: () => [
          { tool: true, files: { 'src/csv.ts': 'v1\n' }, text: 'first version', after: checksDone(1) },
          { tool: true, files: { 'src/csv.ts': 'v2\n' }, text: 'broke it [unmet]', after: checksDone(2) },
          { files: { 'src/csv.ts': 'v3\n' }, text: 'restored the parser' },
        ],
      },
    }));
    const { contract } = startContract(h);
    await waitFor(() => terminal(h, contract.id), 'the contract to end');

    const done = h.store.get(contract.id)!;
    expect(done.status).toBe('passed');
    const u1 = done.units[0]!;
    expect(u1.checks.map((check) => [check.trigger, check.result])).toEqual([['turn-end', 'recorded'], ['turn-end', 'nudge'], ['completion', 'pass']]);
    expect(eventsOf(h, 'CONTRACT_CRITERION_REGRESSED')).toEqual([expect.objectContaining({ unitId: 'u1', criterionId: 'u1.c1', metAtCheckId: 'u1.k1', checkId: 'u1.k2' })]);
    const nudge = u1.nudges[0]!;
    expect(nudge.delivery).toBe('bus');
    expect(nudge.kinds).toEqual(['regression']);
    const steers = h.messageBus.getMessages(u1.agentIds[0]!).filter((message) => message.kind === 'steer');
    expect(steers).toEqual([expect.objectContaining({ id: nudge.id, from: 'contract-runner', content: nudge.text })]);
    expect(nudge.text).toContain('Regressed (these were met at check 1');
  });

  test('a turn-budget failure is checked, the agent is woken with the nudge, and it passes', async () => {
    const h = use(makeHarness({
      plan: oneUnitPlan(1),
      scripts: {
        u1: (_record, run) => run === 1
          ? [{ files: { 'src/csv.ts': 'half\n' }, text: 'ran out of turns [unmet]', stop: { kind: 'budget' } }]
          : [{ files: { 'src/csv.ts': 'whole\n' }, text: 'finished the parser' }],
      },
    }));
    const { contract } = startContract(h);
    await waitFor(() => terminal(h, contract.id), 'the contract to end');

    const done = h.store.get(contract.id)!;
    expect(done.status).toBe('passed');
    const u1 = done.units[0]!;
    expect(u1.checks.map((check) => [check.trigger, check.result])).toEqual([['agent-failed', 'nudge'], ['completion', 'pass']]);
    expect(u1.nudges[0]!.delivery).toBe('wake');
    expect(u1.agentIds).toHaveLength(1);
    expect(done.decisions.some((decision) => decision.action === 'woke' && decision.targetId === 'u1')).toBe(true);
  });
});

describe('transport retry through the failure reading', () => {
  test('a transport failure is retried once with a fresh agent carrying "Previous checks", which passes', async () => {
    let agents = 0;
    let h: Harness;
    h = use(makeHarness({
      plan: oneUnitPlan(1),
      scripts: {
        u1: () => {
          agents += 1;
          return agents === 1
            ? [
              { tool: true, files: { 'src/csv.ts': 'draft\n' }, text: 'draft [unmet]', after: () => waitFor(() => eventsOf(h, 'CONTRACT_CHECKED').length >= 1, 'the mid-run check') },
              { text: 'starting', stop: { kind: 'error', message: 'fetch failed: ECONNRESET (retry-once case)' } },
            ]
            : [{ files: { 'src/csv.ts': 'ok\n' }, text: 'parser written' }];
        },
      },
    }));
    const { contract } = startContract(h);
    await waitFor(() => terminal(h, contract.id), 'the contract to end');

    const done = h.store.get(contract.id)!;
    expect(done.status).toBe('passed');
    const u1 = done.units[0]!;
    expect(u1.transportRetries).toBe(1);
    expect(u1.agentIds).toHaveLength(2);
    const retried = h.manager.getStatus(u1.agentIds[1]!)!;
    expect(retried.task).toContain('Previous checks (the latest verdict on each criterion');
    expect(retried.task).toContain('[u1.c1] parser property 1: not met at check 1');
    expect(retried.routeReason).toBe('test tier');
    expect(eventsOf(h, 'CONTRACT_UNIT_SPAWNED').map((event) => event.purpose)).toEqual(['unit', 'transport-retry']);
    expect(done.decisions.filter((decision) => decision.action === 'transport-retry')).toHaveLength(1);
  });

  test('the retry decision names the failure reading in the decision log', async () => {
    let agents = 0;
    const h = use(makeHarness({
      plan: oneUnitPlan(1),
      scripts: {
        u1: () => {
          agents += 1;
          return agents === 1
            ? [{ text: 'starting', stop: { kind: 'error', message: 'fetch failed: ECONNRESET (decision-id case)' } }]
            : [{ files: { 'src/csv.ts': 'ok\n' }, text: 'parser written' }];
        },
      },
    }));
    const log = new SqliteDecisionLog(':memory:');
    installJudgmentPort(withDecisionLog(judgmentPort('test'), log));
    const { contract } = startContract(h);
    await waitFor(() => terminal(h, contract.id), 'the contract to end');
    const done = h.store.get(contract.id)!;
    expect(done.status).toBe('passed');
    expect(done.units[0]!.transportRetries).toBe(1);
    const retry = done.decisions.find((decision) => decision.action === 'transport-retry')!;
    expect(retry).toBeDefined();
    expect(retry.decisionIds).toHaveLength(1);
    const entry = log.get(retry.decisionIds[0]!)!;
    expect(entry).toMatchObject({ status: 'answered', context: { battery: 'engine.failure-reading', site: 'contract.transport-retry' } });
    expect(readingsOf(entry)).toMatchObject({
      category: { kind: 'choice', choice: 'network', outcome: 'act' },
      connection_failure: { kind: 'choice', choice: 'none', outcome: 'act' },
      transient_network: { kind: 'yes-no', verdict: 'yes', outcome: 'act' },
      before_response: { kind: 'yes-no', verdict: 'yes', outcome: 'act' },
    });
    log[Symbol.dispose]();
  });

  test('a second transport failure fails the unit and the contract with failureKind transport', async () => {
    const h = use(makeHarness({
      plan: oneUnitPlan(1),
      scripts: { u1: () => [{ text: 'starting', stop: { kind: 'error', message: 'socket hang up: ECONNRESET (fails twice)' } }] },
    }));
    const { contract, owner } = startContract(h);
    await waitFor(() => terminal(h, contract.id), 'the contract to end');

    const done = h.store.get(contract.id)!;
    expect(done.status).toBe('failed');
    expect(done.failureKind).toBe('transport');
    expect(done.units[0]!.status).toBe('failed');
    expect(done.units[0]!.transportRetries).toBe(1);
    expect(done.groups[0]!.status).toBe('failed');
    expect(h.manager.getStatus(owner.id)!.status).toBe('failed');
    expect(eventsOf(h, 'CONTRACT_FAILED')[0]).toMatchObject({ failureKind: 'transport' });
  });

  test('a failure Jev does not read as transient fails at once with failureKind other', async () => {
    using log = new SqliteDecisionLog(':memory:');
    const h = use(makeHarness({
      plan: oneUnitPlan(1),
      decisionLog: log,
      scripts: { u1: () => [{ text: 'starting', stop: { kind: 'error', message: 'TypeError: cannot read properties of undefined' } }] },
    }));
    const { contract } = startContract(h);
    await waitFor(() => terminal(h, contract.id), 'the contract to end');
    const done = h.store.get(contract.id)!;
    expect(done.failureKind).toBe('other');
    expect(done.units[0]!.transportRetries).toBe(0);
    const [entry] = log.query({ site: 'contract.transport-retry' });
    expect(entry?.status).toBe('answered');
    expect(readingsOf(entry!)).toMatchObject({
      category: { kind: 'choice', choice: 'unknown', outcome: 'act' },
      transient_network: { kind: 'yes-no', verdict: 'no', outcome: 'act' },
    });
  });
});

describe('the silence watchdog', () => {
  test('a silent unit agent is killed and retried once; silent again, the contract fails', async () => {
    const h = use(makeHarness({
      plan: oneUnitPlan(1),
      contract: { heartbeatTimeoutMs: 120 },
      scripts: { u1: () => [{ text: 'thinking', stop: { kind: 'hang' } }] },
    }));
    const { contract } = startContract(h);
    await waitFor(() => terminal(h, contract.id), 'the contract to end');

    const done = h.store.get(contract.id)!;
    expect(done.status).toBe('failed');
    expect(done.failureKind).toBe('other');
    expect(done.error).toBe('unit u1 went silent twice');
    expect(eventsOf(h, 'CONTRACT_UNIT_SILENT').map((event) => event.action)).toEqual(['retried', 'failed']);
    expect(eventsOf(h, 'CONTRACT_UNIT_SPAWNED').map((event) => event.purpose)).toEqual(['unit', 'silence-retry']);
    for (const agentId of done.units[0]!.agentIds) expect(h.manager.getStatus(agentId)!.status).toBe('cancelled');
  });
});

describe('cancel', () => {
  test('cancel marks the contract, its groups and units cancelled, stops the agents, and counts the modified files', async () => {
    let h: Harness;
    h = use(makeHarness({
      plan: twoUnitPlan(),
      scripts: {
        u1: () => [
          { tool: true, files: { 'src/csv.ts': 'x\n', 'src/csv.test.ts': 'y\n' }, text: 'wrote files', after: () => waitFor(() => eventsOf(h, 'CONTRACT_CHECKED').length >= 1, 'the mid-run check') },
          { text: 'still working', stop: { kind: 'hang' } },
        ],
        u2: () => [{ text: 'never runs' }],
      },
    }));
    const { contract, owner } = startContract(h);
    await waitFor(() => eventsOf(h, 'CONTRACT_CHECKED').length >= 1, 'the mid-run check');
    expect(h.runner.cancel(contract.id, 'stopped by the operator')).toBe(true);
    expect(h.runner.cancel(contract.id, 'again')).toBe(false);

    const done = h.store.get(contract.id)!;
    expect(done.status).toBe('cancelled');
    expect(done.units.map((unit) => unit.status)).toEqual(['cancelled', 'cancelled']);
    expect(done.groups.map((group) => group.status)).toEqual(['cancelled', 'cancelled']);
    expect(eventsOf(h, 'CONTRACT_CANCELLED')).toEqual([expect.objectContaining({ reason: 'stopped by the operator', filesModified: 2 })]);
    expect(done.statusLine).toBe(`Contract ${contract.id} cancelled; 2 files already modified on disk`);
    const ownerRecord = h.manager.getStatus(owner.id)!;
    expect(ownerRecord.status).toBe('cancelled');
    expect(ownerRecord.progress).toBe(done.statusLine);
    expect(h.manager.getStatus(done.units[0]!.agentIds[0]!)!.status).toBe('cancelled');
    // Its own kill of the unit agent is not read as an operator stop of another contract.
    expect(eventsOf(h, 'CONTRACT_FAILED')).toHaveLength(0);
  });

  test("an operator stopping a unit's agent cancels the whole contract", async () => {
    const h = use(makeHarness({ plan: oneUnitPlan(1), scripts: { u1: () => [{ text: 'working', stop: { kind: 'hang' } }] } }));
    const { contract } = startContract(h);
    await waitFor(() => (h.store.get(contract.id)?.units[0]?.agentIds.length ?? 0) === 1, 'the unit agent');
    h.manager.cancel(h.store.get(contract.id)!.units[0]!.agentIds[0]!, 'kill');
    await waitFor(() => terminal(h, contract.id), 'the contract to end');
    expect(h.store.get(contract.id)!.status).toBe('cancelled');
  });

  test('a completion or failure event for the owner record before the contract ends leaves the owner running and the contract going', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = use(makeHarness({
      plan: oneUnitPlan(1),
      scripts: { u1: () => [{ tool: true, files: { 'src/csv.ts': 'x\n' }, text: 'wrote the parser', after: () => gate }, { text: 'Parser done.' }] },
    }));
    const { contract, owner } = startContract(h);
    await waitFor(() => h.manager.list().some((record) => record.contractUnitId === 'u1' && record.status === 'running'), 'the unit agent to run');
    const ctx = { sessionId: 'test', traceId: 'test', source: 'test' };
    emitAgentCompleted(h.bus, ctx, { agentId: owner.id, durationMs: 1, output: 'too early' });
    emitAgentFailed(h.bus, ctx, { agentId: owner.id, error: 'too early', durationMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.manager.getStatus(owner.id)!.status).toBe('running');
    expect(h.store.get(contract.id)!.status).toBe('running');
    release();
    await waitFor(() => terminal(h, contract.id), 'the contract to end');
    expect(h.store.get(contract.id)!.status).toBe('passed');
    expect(h.manager.getStatus(owner.id)!.status).toBe('completed');
  });

  test("an operator stopping the contract's owner record cancels the contract and its unit agents", async () => {
    const h = use(makeHarness({ plan: oneUnitPlan(1), scripts: { u1: () => [{ text: 'working', stop: { kind: 'hang' } }] } }));
    const { contract, owner } = startContract(h);
    await waitFor(() => h.manager.list().some((record) => record.contractUnitId === 'u1' && record.status === 'running'), 'the unit agent to run');
    h.manager.cancel(owner.id);
    await waitFor(() => terminal(h, contract.id), 'the contract to end');
    const done = h.store.get(contract.id)!;
    expect(done.status).toBe('cancelled');
    expect(done.error).toBe(`the contract's owner record ${owner.id} was stopped by an operator`);
    const unitAgent = done.units[0]!.agentIds[0]!;
    await waitFor(() => h.manager.getStatus(unitAgent)?.status === 'cancelled', 'the unit agent to be stopped');
    expect(eventsOf(h, 'CONTRACT_CANCELLED')).toHaveLength(1);
  });
});

describe('the active-contract cap', () => {
  test('the seventh contract waits in the queue and starts when one of the six ends', async () => {
    // A planner that answers only when its caller stops it, so contracts stay active.
    const planner: DecompositionRunner = {
      run: (request) => new Promise((resolve) => {
        request.signal?.addEventListener('abort', () => resolve({ status: 'cancelled', output: '', elapsedMs: 1 }), { once: true });
      }),
    };
    const h = use(makeHarness({ plan: oneUnitPlan(1), scripts: {}, planner }));
    const started = Array.from({ length: 7 }, () => startContract(h).contract.id);
    await waitFor(() => started.slice(0, 6).every((id) => h.store.get(id)!.status === 'planning'), 'six contracts planning');
    const seventh = h.store.get(started[6]!)!;
    expect(seventh.status).toBe('queued');
    expect(seventh.decisions.map((decision) => decision.action)).toEqual(['created', 'queued']);

    h.runner.cancel(started[0]!, 'make room');
    await waitFor(() => h.store.get(started[6]!)!.status === 'planning', 'the seventh contract to start');
    expect(h.runner.list().map((contract) => contract.id).sort()).toEqual(started.slice(1).sort());
    for (const id of started.slice(1)) h.runner.cancel(id, 'done');
  });
});

describe('isolation', () => {
  test('worktree mode on a detached HEAD: the contract is measured against the HEAD commit and its work lands on it', async () => {
    const root = makeRepo();
    // No branch named main, and nothing checked out by name.
    spawnSync('git', ['-C', root, 'branch', '-m', 'main', 'trunk']);
    const head = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).stdout.trim();
    spawnSync('git', ['-C', root, 'checkout', '-q', '--detach', head]);
    const h = use(makeHarness({
      root,
      plan: oneUnitPlan(1),
      contract: { isolation: 'auto' },
      scripts: { u1: () => [{ files: { 'src/csv.ts': 'export const parse = 1;\n' }, text: 'parser written' }] },
    }));
    const { contract } = startContract(h);
    expect(contract.baseBranch).toBe(head);
    await waitFor(() => terminal(h, contract.id), 'the contract to end', 15_000);
    const done = h.store.get(contract.id)!;
    expect(done.status).toBe('passed');
    expect(done.commit?.status).toBe('committed');
    expect(spawnSync('git', ['-C', root, 'show', 'HEAD:src/csv.ts'], { encoding: 'utf-8' }).stdout).toBe('export const parse = 1;\n');
    h.dispose();
    harness = undefined;
    rmSync(root, { recursive: true, force: true });
  }, 20_000);

  test('worktree mode: the unit works in its own worktree, passes once its branch merged into the contract branch, and the deliverable is merged into the base branch', async () => {
    const h = use(makeHarness({
      plan: oneUnitPlan(1),
      contract: { isolation: 'auto' },
      scripts: { u1: () => [{ files: { 'src/csv.ts': 'export const parse = 1;\n' }, text: 'parser written' }] },
    }));
    const { contract } = startContract(h);
    expect(contract.isolation).toBe('worktree');
    await waitFor(() => terminal(h, contract.id), 'the contract to end', 15_000);
    const done = h.store.get(contract.id)!;
    expect(done.status).toBe('passed');
    const statuses = eventsOf(h, 'CONTRACT_UNIT_STATUS_CHANGED').map((event) => event.to);
    expect(statuses.slice(-2)).toEqual(['held-merge', 'passed']);
    const onBranch = spawnSync('git', ['-C', h.root, 'show', `${done.branch!}:src/csv.ts`], { encoding: 'utf-8' });
    expect(onBranch.stdout).toBe('export const parse = 1;\n');
    // The passing deliverable was merged into the base branch, and the contract worktree removed.
    expect(done.commit?.status).toBe('committed');
    expect(spawnSync('git', ['-C', h.root, 'show', 'main:src/csv.ts'], { encoding: 'utf-8' }).stdout).toBe('export const parse = 1;\n');
    expect(existsSync(done.worktreePath!)).toBe(false);
  });

  test('the shared-tree lock admits one holder at a time per tree, in arrival order, and a withdrawn waiter is skipped', async () => {
    const root = makeRepo();
    try {
      const order: string[] = [];
      const first = await acquireSharedTree(root);
      const withdraw = new AbortController();
      const second = acquireSharedTree(root, withdraw.signal).then((release) => { order.push('second'); return release; });
      const third = acquireSharedTree(root).then((release) => { order.push('third'); return release; });
      expect(sharedTreeWaiters(root)).toBe(3);
      withdraw.abort(new Error('stopped'));
      await expect(second).rejects.toThrow('stopped');
      expect(order).toEqual([]);
      first();
      (await third)();
      expect(order).toEqual(['third']);
      expect(sharedTreeWaiters(root)).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('usage roll-up', () => {
  test("the owner record's usage and tool calls are the sums over every agent the contract ran, and the tree is priced", async () => {
    const h = use(makeHarness({
      plan: twoUnitPlan(),
      scripts: {
        u1: () => [{ files: { 'src/csv.ts': 'a\n' }, text: 'first [unmet]' }, { files: { 'src/csv.ts': 'b\n' }, text: 'fixed' }],
        u2: () => [{ files: { 'src/convert.ts': 'c\n' }, text: 'wired' }],
      },
    }));
    const { contract, owner } = startContract(h);
    await waitFor(() => terminal(h, contract.id), 'the contract to end');
    const done = h.store.get(contract.id)!;
    const unitAgents = done.units.flatMap((unit) => unit.agentIds).map((id) => h.manager.getStatus(id)!);
    const sum = (read: (record: (typeof unitAgents)[number]) => number): number => unitAgents.reduce((total, record) => total + read(record), 0);

    const ownerRecord = h.manager.getStatus(owner.id)!;
    expect(ownerRecord.usage?.inputTokens).toBe(sum((record) => record.usage!.inputTokens));
    expect(ownerRecord.usage?.outputTokens).toBe(sum((record) => record.usage!.outputTokens));
    expect(ownerRecord.toolCallCount).toBe(sum((record) => record.toolCallCount));
    expect(done.usage.inputTokens).toBe(ownerRecord.usage!.inputTokens);
    expect(done.groups.reduce((total, group) => total + group.usage.inputTokens, 0)).toBe(done.usage.inputTokens);
    expect(done.usage.costState).toBe('priced');
    expect(done.judgmentUsage.calls).toBeGreaterThan(0);
  });
});

describe('the pass guarantee', () => {
  /** A small seeded generator, so a failing sequence can be replayed. */
  function generator(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state / 2_147_483_648;
    };
  }

  test('over random reading sequences, a unit never reaches passed while any criterion reads unmet', async () => {
    const choices = [0.03, 0.2, 0.45, 0.55, 0.8, 0.95];
    let passedSequences = 0;
    for (let seed = 1; seed <= 12; seed += 1) {
      const random = generator(seed);
      const outputs = Array.from({ length: 8 }, (_, attempt) => {
        const probabilities = [0, 1, 2].map(() => choices[Math.floor(random() * choices.length)]!);
        return `attempt ${attempt} [p=${probabilities.join(',')}]`;
      });
      outputs.push('final attempt [p=0.03,0.03,0.03]');
      const steps: AgentStep[] = outputs.map((text, index) => ({ files: { 'src/csv.ts': `${index}\n` }, text }));
      // Correction and the owner are not what this reads: a stall or an owner question ends the sequence.
      const h = makeHarness({
        plan: oneUnitPlan(3),
        contract: { stallLimit: 20, maxNudgesPerUnit: 20, evidenceNudgeLimit: 20 },
        scripts: { u1: () => steps },
        steps: {
          unitStalled: async (run, unitId) => run.control.fail('other', `unit ${unitId} stalled`),
          unitAwaitsOwner: async (run, unitId) => run.control.fail('other', `unit ${unitId} awaits the owner`),
        },
      });
      try {
        const violations: string[] = [];
        h.runner.on((event) => {
          if (event.type !== 'CONTRACT_UNIT_STATUS_CHANGED' || event.to !== 'passed') return;
          const unit = h.store.get(event.contractId)!.units.find((candidate) => candidate.id === event.unitId)!;
          const open = unit.criteria.filter((criterion) => criterion.status !== 'met');
          if (open.length > 0) violations.push(`seed ${seed}: ${unit.id} passed with ${open.map((criterion) => `${criterion.id}=${criterion.status}`).join(', ')}`);
        });
        const { contract } = startContract(h);
        await waitFor(() => terminal(h, contract.id), `seed ${seed} to end`, 10_000);
        expect(violations).toEqual([]);
        const done = h.store.get(contract.id)!;
        const unit = done.units[0]!;
        if (done.status === 'passed') {
          passedSequences += 1;
          // The one pass is the last check, and it read every criterion met.
          expect(unit.checks.filter((check) => check.result === 'pass')).toHaveLength(1);
          expect(unit.checks.at(-1)!.result).toBe('pass');
          for (const criterion of unit.criteria) expect(criterion.readings.at(-1)!.verdict).toBe('met');
        } else {
          // A sequence that stalls (a criterion regressed twice) never passed the unit.
          expect(unit.status).not.toBe('passed');
          expect(unit.checks.some((check) => check.result === 'pass')).toBe(false);
        }
      } finally {
        h.dispose();
      }
    }
    expect(passedSequences).toBeGreaterThan(0);
  }, 60_000);
});

describe('persistence', () => {
  test('the contract tree is written to the store, and get and list read it', async () => {
    const h = use(makeHarness({ plan: oneUnitPlan(1), scripts: { u1: () => [{ files: { 'src/csv.ts': 'ok\n' }, text: 'done' }] } }));
    const { contract } = startContract(h);
    await waitFor(() => terminal(h, contract.id), 'the contract to end');
    h.store.flush();
    expect(existsSync(join(h.root, '.goodvibes', 'contracts', `${contract.id}.json`))).toBe(true);
    expect(JSON.parse(h.runner.serializeContract(contract.id)!).contract.status).toBe('passed');
    expect(h.runner.get(contract.id)!.status).toBe('passed');
    expect(h.runner.list()).toEqual([]);
    expect(h.runner.list({ includeTerminal: true }).map((view) => view.id)).toEqual([contract.id]);
  });
});

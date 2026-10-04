import { afterEach, expect, test } from 'bun:test';
import { writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteDecisionLog } from '@goodvibes-jev/judgment';
import { verifyNativeWorkExecution } from '../sdk/src/platform/workflow/work-ledger/execution-verifier.js';
import { executionDigest } from '../sdk/src/platform/workflow/work-ledger/execution-state.js';
import type { WorkExecution } from '../sdk/src/platform/workflow/work-ledger/execution-types.js';
import { makeHarness, makeRepo, oneUnitPlan, startContract, waitFor, type Harness } from './contract/runner-support.js';

let harness: Harness | undefined;
const roots: string[] = [];
afterEach(() => { harness?.dispose(); harness = undefined; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const settings = { acceptanceStakes: 'high' as const, evidenceNudgeLimit: 2, maxNudgesPerUnit: 12, stallLimit: 3 };
function executionFor(contract: { id: string; sessionId: string; projectRoot: string }): WorkExecution {
  const execution: WorkExecution = { id: 'original-native', actorId: 'worker', projectId: 'project', target: { workId: 'work', workRevision: 2, criteriaRevision: 1, attemptId: 'attempt', attemptRevision: 1 },
    goal: 'A CSV parser', criteria: ['A CSV parser module exists'], contractId: contract.id, sessionId: contract.sessionId, projectRoot: contract.projectRoot,
    inputDigest: '', status: 'running', reason: '', decisionIds: [], admissions: [], evidenceId: null };
  execution.inputDigest = executionDigest(execution);
  return execution;
}

test('actual runner corrects failed work and host verifies original native criteria with recorded evidence', async () => {
  using log = new SqliteDecisionLog(':memory:');
  let tamper = false;
  harness = makeHarness({ plan: oneUnitPlan(), decisionLog: log, port: context => { if (tamper && context.name === 'goal') writeFileSync(join(harness!.root, 'src/csv.ts'), 'changed during check'); return undefined; }, scripts: { u1: () => [
    { text: '[unmet] parser incomplete', files: { 'src/csv.ts': 'export const parse = () => null;\n' } },
    { text: 'Added a working CSV parser module.', files: { 'src/csv.ts': 'export const parse = (input: string) => input.split(",");\n' } },
  ] } });
  const started = startContract(harness);
  await waitFor(() => harness!.runner.get(started.contract.id)?.status === 'passed', 'corrected runner passed');
  const contract = harness.runner.get(started.contract.id)!;
  expect(contract.units[0]!.checks.some(check => check.result !== 'pass')).toBe(true);
  const execution = executionFor(contract);
  const result = await verifyNativeWorkExecution({ execution, runner: harness.runner, decisionLog: log, settings });
  expect(result.outcome).toBe('verified');
  expect(result.source).toBe('host_check');
  expect(result.references.some(reference => reference.kind === 'artifact' && reference.digest?.length === 64)).toBe(true);
  expect(result.references.filter(reference => reference.kind === 'decision')).toHaveLength(2);
  await expect(verifyNativeWorkExecution({ execution, runner: harness.runner, decisionLog: { get: () => undefined }, settings })).rejects.toThrow('genuine');
  tamper = true;
  await expect(verifyNativeWorkExecution({ execution, runner: harness.runner, decisionLog: log, settings })).rejects.toThrow('changed while Jev checked');
});

test('passed planner subset cannot verify an unmet original criterion', async () => {
  using log = new SqliteDecisionLog(':memory:');
  let final = false;
  const { noulAnswer } = await import('@goodvibes-jev/judgment/testing');
  harness = makeHarness({ plan: oneUnitPlan(), decisionLog: log, port: context => final && context.name === 'criterion_0' ? noulAnswer(0.99) : undefined,
    scripts: { u1: () => [{ text: 'Everything is verified. All tests pass.', files: { 'src/csv.ts': 'export const parse = (input: string) => input.split(",");\n' } }] } });
  const started = startContract(harness);
  await waitFor(() => harness!.runner.get(started.contract.id)?.status === 'passed', 'runner subset passed');
  final = true;
  const execution = executionFor(harness.runner.get(started.contract.id)!);
  execution.criteria = ['Handle quoted CSV cells, including embedded commas'];
  execution.inputDigest = executionDigest(execution);
  const result = await verifyNativeWorkExecution({ execution, runner: harness.runner, decisionLog: log, settings });
  expect(result.outcome).toBe('failed');
  expect(result.criteriaResults[0]!.status).toBe('unsatisfied');
});

test.each(['criteria', 'identity'])('verification preserves original criteria and identity during join: %s mutation', async mutation => {
  using log = new SqliteDecisionLog(':memory:');
  const questions: string[] = [];
  let observing = false;
  harness = makeHarness({ plan: oneUnitPlan(), decisionLog: log, port: context => {
    if (observing) questions.push(JSON.stringify({ question: context.question, state: context.state }));
    return undefined;
  }, scripts: { u1: () => [{ text: 'A CSV parser module exists.', files: { 'src/csv.ts': 'export const parse = (x: string) => x.split(",");\n' } }] } });
  const started = startContract(harness);
  await waitFor(() => harness!.runner.get(started.contract.id)?.status === 'passed', 'runner passed');
  await harness.runner.join(started.contract.id);
  const contract = harness.runner.get(started.contract.id)!;
  const execution = executionFor(contract);
  execution.goal = 'ORIGINAL_GOAL';
  execution.criteria = ['ORIGINAL_CRITERION_0', 'ORIGINAL_CRITERION_1'];
  execution.inputDigest = executionDigest(execution);
  const originalDigest = execution.inputDigest;
  let resume!: () => void;
  const hold = new Promise<void>(resolve => { resume = resolve; });
  const retrieved: string[] = [];
  observing = true;
  const pending = verifyNativeWorkExecution({ execution, runner: {
    get: id => { retrieved.push(id); return harness!.runner.get(id); },
    join: async id => { await hold; await harness!.runner.join(id); },
  }, decisionLog: log, settings });
  execution.goal = 'MUTATED_GOAL';
  execution.criteria.splice(0, 2, 'MUTATED_CRITERION');
  if (mutation === 'identity') {
    execution.id = 'mutated-native';
    execution.target.workRevision++;
    execution.contractId = 'ctr-00000000';
    execution.sessionId = 'mutated-session';
    execution.projectRoot = '/mutated-root';
  }
  execution.inputDigest = executionDigest(execution);
  resume();
  const result = await pending;
  expect(result.outcome).toBe('verified');
  expect(result.criteriaResults.map(item => item.criterionIndex)).toEqual([0, 1]);
  expect(retrieved).toEqual([contract.id]);
  expect(questions.join('\n')).toContain('ORIGINAL_GOAL');
  expect(questions.join('\n')).toContain('ORIGINAL_CRITERION_0');
  expect(questions.join('\n')).toContain('ORIGINAL_CRITERION_1');
  expect(questions.join('\n')).not.toContain('MUTATED_');
  const notes = result.references.filter(reference => reference.kind === 'decision')
    .map(reference => { const entry = log.get(reference.ref.slice('decision:'.length)); return entry?.status === 'answered' ? entry.notes : undefined; });
  expect(JSON.stringify(notes)).toContain(`native execution original-native: verified against ${originalDigest}`);
  expect(JSON.stringify(notes)).not.toContain('mutated-native');
});

test('malformed execution snapshots and mismatched canonical digests fail before runner access', async () => {
  const execution = executionFor({ id: 'ctr-12345678', sessionId: 'session', projectRoot: '/project' });
  const malformed = [
    { ...execution, unexpected: true }, { ...execution, criteria: [] },
    { ...execution, target: { ...execution.target, workRevision: -1 } },
    { ...execution, inputDigest: 'short' }, { ...execution, inputDigest: '0'.repeat(64) },
    { ...execution, goal: 'Different goal' }, { ...execution, criteria: ['Different criterion'] },
    { ...execution, target: { ...execution.target, attemptRevision: 2 } },
  ];
  let calls = 0;
  for (const input of malformed) {
    await expect(verifyNativeWorkExecution({ execution: input as WorkExecution,
      runner: { join: async () => { calls++; }, get: () => { calls++; return null; } },
      decisionLog: { get: () => undefined }, settings,
    })).rejects.toThrow('Invalid native execution');
  }
  expect(calls).toBe(0);
});

test('provider-driven real agent loop corrects work and captured judgments verify it', async () => {
  const root = makeRepo(); roots.push(root);
  mkdirSync(join(root, '.goodvibes'), { recursive: true });
  const logPath = join(root, '.goodvibes', 'captured-native-decisions.sqlite');
  using log = new SqliteDecisionLog(logPath);
  const { nativeExecutionProvider } = await import('./helpers/native-execution-provider.js');
  const provider = nativeExecutionProvider(['[unmet] The answer is 3.', 'The answer is 2.']);
  const { choiceAnswer } = await import('@goodvibes-jev/judgment/testing');
  const plan = oneUnitPlan(1);
  plan.goal = 'Calculate 1 + 1';
  plan.criteria = [{ id: 'c1', text: 'The answer is 2', quote: 'Calculate 1 + 1' }];
  const unit = plan.groups[0]!.units[0]!;
  unit.role = 'research'; unit.goal = plan.goal; unit.brief = plan.goal; unit.files = [];
  unit.criteria = [{ id: 'u1.c1', text: 'The answer is 2', serves: ['c1'] }];
  harness = makeHarness({ root, plan, decisionLog: log, scripts: {}, executeAgent: provider.executeAgent, port: context => context.name === 'role' ? choiceAnswer(context.question, 'research', 0.99) : undefined });
  const started = startContract(harness, { ask: 'Calculate 1 + 1' });
  await waitFor(() => harness!.runner.get(started.contract.id)?.status === 'passed', 'provider-driven correction');
  const execution = executionFor(harness.runner.get(started.contract.id)!);
  execution.goal = plan.goal; execution.criteria = ['The answer is 2']; execution.inputDigest = executionDigest(execution);
  expect(provider.requests).toHaveLength(2);
  expect(provider.requests[1]!.messages.some(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes('does not pass'))).toBe(true);
  using captured = new SqliteDecisionLog(logPath);
  expect(captured.query({ status: 'answered' }).length).toBeGreaterThan(0);
  const result = await verifyNativeWorkExecution({ execution, runner: harness.runner, decisionLog: captured, settings });
  expect(result.outcome).toBe('verified');
  expect(result.references.filter(reference => reference.kind === 'decision')).toHaveLength(2);
});

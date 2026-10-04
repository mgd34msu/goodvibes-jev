import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import {
  captureNativeContractSource, nativeContractSourceForAdmission, contractPath, readContractSnapshot, serializeContract,
  type Contract, type NativeContractSource,
} from '../../sdk/src/platform/contract/index.js';
import { bindNativeContractSource, nativeSourceCriteria, nativeSourcePlan } from '../../sdk/src/platform/contract/native-source.js';
import { acceptEscalatedPlan, planContract, type ContractPlannerDeps } from '../../sdk/src/platform/contract/planner.js';
import { makeContract } from './fixtures.js';
import { configReader, planningPort, plannerOutput, PLANNER_ROUTE, scriptedRunner, shapeOf, type DraftPlan } from './plan-support.js';
import { makeHarness, makeRepo, oneUnitPlan, startContract, waitFor, type Harness } from './runner-support.js';
import { answers, criterionTextOf, finishes, fixPlan, judgeOf, replyAnswers, scriptsWith, stepPlanner, terminal } from './steps-support.js';

function source(): NativeContractSource {
  return { sourceId: 'work-7', sourceRevision: '12', inputRevision: 'input-19', criteriaId: 'criteria-7', criteriaRevision: '4',
    goal: '  The complete native goal.\nDo every part, preserving unicode \u2603 and trailing space. ',
    criteria: [' Keep exact spaces. ', 'Preserve the second criterion.\nAnd its second line.'] };
}
function nativePlan(): DraftPlan {
  const plan = oneUnitPlan();
  return { ...plan, ...nativeSourcePlan(source()), criteria: [...nativeSourcePlan(source()).criteria], groups: [{ ...plan.groups[0]!, units: [{ ...plan.groups[0]!.units[0]!, criteria: [
    { id: 'u1.c1', text: 'First requirement holds', serves: ['c1'] }, { id: 'u1.c2', text: 'Second requirement holds', serves: ['c2'] },
  ] }] }] };
}
function nativeContract(): Contract {
  const nativeSource = captureNativeContractSource(source());
  const contract = makeContract({ ask: 'A short display ask, without native criteria.', nativeSource, goal: nativeSource.goal,
    criteria: nativeSourceCriteria(nativeSource), status: 'planning', shape: shapeOf(), groups: [], units: [] });
  bindNativeContractSource(contract);
  return contract;
}
function planner(outputs: string[]) {
  const scripted = scriptedRunner(outputs.map(output => ({ status: 'completed' as const, output, elapsedMs: 1 })));
  const deps: ContractPlannerDeps = { decompositionRunner: scripted.runner, routeSelector: async () => PLANNER_ROUTE,
    native: { host: { authorityOf: () => ({ authorityId: 'test-host', authorityRevision: '1', scopeId: 'test-project', scopeRevision: '1' }) }, changed: () => {} },
    configManager: configReader({ planRepairLimit: 1 }), emit: () => {}, repositoryMap: async () => 'repository' };
  return { deps, requests: scripted.requests };
}
const harnesses: Harness[] = [];
const roots: string[] = [];
let previous: ReturnType<typeof installJudgmentPort>;
afterEach(() => {
  for (const h of harnesses.splice(0).reverse()) h.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  installJudgmentPort(previous);
  for (const log of logs.splice(0)) log[Symbol.dispose]();
});
const logs: SqliteDecisionLog[] = [];
function install(): void { const log = new SqliteDecisionLog(':memory:'); logs.push(log); previous = installJudgmentPort(withDecisionLog(planningPort().port, log)); }

describe('native contract source', () => {
  test('captures complete detached exact data, preserves duplicate criteria and refuses missing or empty criteria', () => {
    const original = { ...source(), goal: 'x'.repeat(30_000), criteria: ['same', 'same'] };
    const captured = captureNativeContractSource(original);
    original.criteria.reverse(); original.criteria[0] = 'changed'; original.goal = 'short';
    expect(captured.goal).toHaveLength(30_000);
    expect(captured.criteria).toEqual(['same', 'same']);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured.criteria)).toBe(true);
    for (const invalid of [{ ...source(), criteria: [] }, { ...source(), criteria: [''] }, { ...source(), criteria: Array(2) }, { ...source(), inputRevision: '' }, { goal: 'partial' }]) {
      expect(() => captureNativeContractSource(invalid)).toThrow('Invalid native contract source');
    }
    let accessed = false;
    expect(() => captureNativeContractSource({ ...source(), get goal() { accessed = true; return 'bad'; } })).toThrow();
    expect(accessed).toBe(false);
  });

  test.each(['goal', 'alter', 'drop', 'reorder', 'add'] as const)('%s in generated roots is repaired without replacing native requirements', async kind => {
    install();
    const canonical = nativePlan();
    const changed = { ...canonical, criteria: [...canonical.criteria] };
    if (kind === 'goal') changed.goal = 'Generated summary';
    if (kind === 'alter') changed.criteria[0] = { ...changed.criteria[0]!, text: 'Weaker replacement' };
    if (kind === 'drop') changed.criteria.pop();
    if (kind === 'reorder') changed.criteria.reverse();
    if (kind === 'add') changed.criteria.push({ id: 'c3', text: 'New requirement', quote: 'New requirement' });
    const contract = nativeContract(); const rootsBefore = contract.criteria;
    const h = planner([plannerOutput(changed), plannerOutput(canonical)]);
    const result = await planContract(contract, h.deps, { ownerInstruction: 'Drop the second root criterion.' });
    expect(result.kind).toBe('accepted');
    expect(contract.criteria).toBe(rootsBefore);
    expect(contract.goal).toBe(source().goal);
    expect(contract.criteria.map(item => item.text)).toEqual([...source().criteria]);
    expect(h.requests[1]!.userPrompt).toContain('native-source-changed');
    for (const request of h.requests) {
      expect(request.goal).toBe(source().goal);
      expect(request.userPrompt).toContain(JSON.stringify(source()));
      expect(request.userPrompt).not.toContain('rewording or dropping criteria as it says');
    }
    expect(nativeContractSourceForAdmission(contract)).toEqual({ goal: source().goal, criteria: source().criteria });
  });

  test('unresolved replacement cannot be approved through the legacy escalation path', async () => {
    install(); const contract = nativeContract();
    const plan = { ...nativePlan(), goal: 'Replacement' };
    const h = planner([plannerOutput(plan), plannerOutput(plan)]);
    const result = await planContract(contract, h.deps);
    expect(result.kind).toBe('failed');
    expect(contract.escalations).toHaveLength(0);
    expect((await acceptEscalatedPlan(contract, { id: 'old', at: 1, scope: 'plan', targetId: contract.id, reason: 'plan-unresolved', question: plannerOutput(plan), unmetCriterionIds: [] }, h.deps)).kind).toBe('unrunnable');
    expect(contract.goal).toBe(source().goal);
    expect(contract.units).toHaveLength(0);
  });

  test('persistence validates native source and restores runtime immutability without changing legacy snapshots', () => {
    const contract = nativeContract();
    const json = serializeContract(contract, 123)!;
    const read = readContractSnapshot(json);
    if ('rejected' in read) throw new Error(read.rejected);
    expect(read.snapshot.contract.nativeSource).toEqual(source());
    expect(() => { read.snapshot.contract.criteria[0]!.text = 'mutated'; }).toThrow();
    expect(() => { read.snapshot.contract.criteria.reverse(); }).toThrow();
    expect(() => { read.snapshot.contract.goal = 'mutated'; }).toThrow();
    read.snapshot.contract.criteria[0]!.status = 'met';
    for (const mutate of [
      (c: Contract) => { c.goal = 'changed'; },
      (c: Contract) => { c.criteria.reverse(); },
      (c: Contract) => { c.criteria.pop(); },
      (c: Contract) => { c.criteria[0]!.disposition = 'excluded'; },
      (c: Contract) => { Object.assign(c.nativeSource!, { inputRevision: '' }); },
    ]) {
      const raw = JSON.parse(json) as { contract: Contract }; mutate(raw.contract);
      expect(readContractSnapshot(JSON.stringify(raw))).toEqual({ rejected: 'invalid-contract' });
    }
    const oldNativeEnvelope = JSON.parse(json) as { schemaVersion: number }; oldNativeEnvelope.schemaVersion = 1;
    expect(readContractSnapshot(JSON.stringify(oldNativeEnvelope))).toEqual({ rejected: 'invalid-contract' });
    oldNativeEnvelope.schemaVersion = 2;
    expect(readContractSnapshot(JSON.stringify(oldNativeEnvelope))).toEqual({ rejected: 'invalid-contract' });
    const legacy = makeContract({ schemaVersion: 1 });
    const oldLegacyEnvelope = JSON.parse(serializeContract(legacy, 123)!) as { schemaVersion: number }; oldLegacyEnvelope.schemaVersion = 1;
    expect('snapshot' in readContractSnapshot(JSON.stringify(oldLegacyEnvelope))).toBe(true);
    oldLegacyEnvelope.schemaVersion = 2;
    // The union now has both durable and captured-input validators; valid source-less v2 records remain readable.
    expect('snapshot' in readContractSnapshot(JSON.stringify(oldLegacyEnvelope))).toBe(true);
    expect(() => nativeContractSourceForAdmission(legacy)).toThrow('no native source');
  });

  test('planned correction retains all original requirements and revisions through final re-verification', async () => {
    let checks = 0;
    const scripted = stepPlanner(nativePlan(), { fix: () => plannerOutput(fixPlan([{ serves: ['c1', 'c2'] }])) });
    const h = makeHarness({ recordNative: true, planner: scripted.runner,
      scripts: scriptsWith({ u1: finishes('initial result') }, unitId => unitId.endsWith('.f1.u1') ? finishes('corrected result') : undefined),
      port: context => { if (judgeOf(context) !== 'deliverable') return undefined; if (context.name === 'goal') checks += 1; return noulAnswer(checks <= 1 ? 0.9 : 0.03); } });
    harnesses.push(h);
    const { contract } = startContract(h, { nativeSource: source() });
    await waitFor(() => terminal(h, contract.id), 'corrected native completion', 15_000);
    const done = h.store.get(contract.id)!;
    expect(done.error).toBeUndefined();
    expect(done.status).toBe('passed');
    expect(done.nativeSource).toEqual(source());
    expect(done.criteria.map(item => item.text)).toEqual([...source().criteria]);
    expect(done.criteria.map(item => item.readings.map(reading => reading.verdict))).toEqual([['unmet', 'met'], ['unmet', 'met']]);
    expect(scripted.of('fix')[0]!.userPrompt).toContain(JSON.stringify(source()));
    expect(scripted.of('fix')[0]!.goal).toBe(source().goal);
  }, 20_000);

  test('legacy deliverable amendment cannot weaken native roots', async () => {
    const scripted = stepPlanner(nativePlan(), { amend: () => { throw new Error('Native roots must not reach the amendment planner'); } });
    const h = makeHarness({ recordNative: true, planner: scripted.runner, contract: { maxFixRounds: 0 }, scripts: { u1: finishes('initial result') },
      port: answers(context => judgeOf(context) === 'deliverable' ? noulAnswer(0.9) : undefined, replyAnswers([{ reading: 'amend' }])) });
    harnesses.push(h);
    const { contract } = startContract(h, { nativeSource: source() });
    await waitFor(() => terminal(h, contract.id), 'native refusal at exhausted correction boundary');
    const live = h.store.get(contract.id)!;
    expect(live.escalations).toHaveLength(0);
    expect(live.status).toBe('failed');
    expect(scripted.of('amend')).toHaveLength(0);
    expect(live.criteria.map(item => item.text)).toEqual([...source().criteria]);
    expect(live.nativeSource).toEqual(source());
  }, 20_000);

  test('start captures before caller mutation; restart planning and final verification retain exact native source', async () => {
    const root = makeRepo(); roots.push(root);
    const restartLog = new SqliteDecisionLog(':memory:'); logs.push(restartLog);
    const first = makeHarness({ recordNative: true, decisionLog: restartLog, root, scripts: {}, planner: { run: () => new Promise(() => undefined) } }); harnesses.push(first);
    const borrowed = { ...source(), criteria: [...source().criteria] };
    const { contract } = startContract(first, { nativeSource: borrowed });
    borrowed.goal = 'Changed later'; borrowed.criteria.reverse(); borrowed.criteria[0] = 'Changed later';
    expect(contract.nativeSource).toEqual(source());
    await waitFor(() => first.store.get(contract.id)?.status === 'planning', 'initial planning');
    first.dispose(); harnesses.splice(harnesses.indexOf(first), 1);
    const stored = JSON.parse(readFileSync(contractPath(root, contract.id), 'utf8')) as { contract: Contract };
    expect(stored.contract.nativeSource).toEqual(source());
    const seenCriteria: string[] = []; const seenGoals: string[] = []; const prompts: string[] = []; const sources: unknown[] = [];
    const second = makeHarness({ recordNative: true, decisionLog: restartLog, root, scripts: { u1: () => [{ files: { 'src/csv.ts': 'export const parsed = true;\n' }, text: 'Native requirements complete.' }] },
      planner: { run: async request => { prompts.push(request.userPrompt); return { status: 'completed', output: plannerOutput(nativePlan()), elapsedMs: 1 }; } },
      port: context => { if (context.name === 'role') sources.push(context.state['nativeSource']); if (judgeOf(context) === 'deliverable') { sources.push((context.state['evidence'] as Record<string, unknown>)['nativeSource']); seenCriteria.push(criterionTextOf(context)); if (typeof context.state['goal'] === 'string') seenGoals.push(context.state['goal']); } return undefined; } }); harnesses.push(second);
    const report = await second.runner.resumeAll();
    expect(report.resumed).toEqual([{ contractId: contract.id, step: 'plan' }]);
    await waitFor(() => terminal(second, contract.id), 'native completion', 15_000);
    const done = second.store.get(contract.id)!;
    expect(done.error).toBeUndefined();
    expect(done.status).toBe('passed');
    expect(done.nativeSource).toEqual(source());
    expect(done.criteria.map(item => item.text)).toEqual([...source().criteria]);
    expect(done.criteria.every(item => item.readings.length > 0)).toBe(true);
    expect(seenCriteria).toContain(source().criteria[0]!); expect(seenCriteria).toContain(source().criteria[1]!);
    expect(seenGoals).toContain(source().goal);
    expect(sources.length).toBeGreaterThan(1);
    expect(sources.every(item => JSON.stringify(item) === JSON.stringify(source()))).toBe(true);
    expect(prompts[0]).toContain(JSON.stringify(source()));
    expect(second.manager.list().find(record => record.contractUnitId === 'u1')?.task).toContain(JSON.stringify(source()));
  }, 20_000);
});

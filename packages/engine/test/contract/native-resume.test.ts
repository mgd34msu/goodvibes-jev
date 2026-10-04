import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { SqliteDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { contractPath, createContractIntake, type Contract, type NativeContractSource } from '../../sdk/src/platform/contract/index.js';
import type { NativeContractDecisionHost } from '../../sdk/src/platform/contract/native-decisions.js';
import { nativeSourceCriteria } from '../../sdk/src/platform/contract/native-source.js';
import { makeContract } from './fixtures.js';
import { makeHarness, makeRepo, oneUnitPlan, startContract, waitFor, type Harness } from './runner-support.js';
import { plannerOutput, shapeOf } from './plan-support.js';
import { finishes, terminal, stepPlanner, fixPlan, scriptsWith, judgeOf } from './steps-support.js';
const source: NativeContractSource = { sourceId: 'work-1', sourceRevision: '1', inputRevision: 'input-1', criteriaId: 'criteria-1', criteriaRevision: '1', goal: 'Complete original native goal', criteria: ['Preserve every original requirement'] };
function plan() { return { ...oneUnitPlan(1), goal: source.goal, criteria: [{ id: 'c1', text: source.criteria[0]!, quote: source.criteria[0]! }] }; }
function authority() { return { authorityId: 'host', authorityRevision: '1', scopeId: 'project', scopeRevision: '1' }; }
const harnesses: Harness[] = []; const roots: string[] = [];
afterEach(() => { for (const h of harnesses.splice(0).reverse()) h.dispose(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function add(h: Harness) { harnesses.push(h); return h; }
function root() { const value = makeRepo(); roots.push(value); return value; }
function writeSnapshot(path: string, contract: Contract, schemaVersion: number) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify({ schemaVersion, writtenAt: Date.now(), contract })); }

test('deferred plan survives restart; no replan, unit or old receipt runs before condition change', async () => {
  const directory = root(); using log = new SqliteDecisionLog(':memory:');
  let revision = '1'; let waits = 0; let wake: (() => void) | undefined;
  const host: NativeContractDecisionHost = { authorityOf: authority, conditions: (_contract, stage) => stage !== 'plan' ? [] : [{ ref: { id: 'build-evidence', revision }, description: 'Independent evidence arrives', current: () => ({ id: 'build-evidence', revision }),
    wait: signal => new Promise<void>((resolve, reject) => { waits += 1; wake = resolve; signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }) }] };
  const first = add(makeHarness({ root: directory, recordNative: true, decisionLog: log, nativeDecisions: host, plan: plan(), scripts: {}, port: context => context.name === 'disposition' ? choiceAnswer(context.question, 'defer_0', 0.99) : undefined }));
  const id = startContract(first, { nativeSource: source }).contract.id;
  await waitFor(() => waits === 1, 'first registered deferral');
  const prior = first.store.get(id)!.nativeDecisions!.history.at(-1)!.decision;
  first.dispose(); await first.runner.join(id); harnesses.splice(harnesses.indexOf(first), 1);
  let modelRuns = 0;
  const second = add(makeHarness({ root: directory, recordNative: true, decisionLog: log, nativeDecisions: host, scripts: { u1: finishes('parser complete') }, planner: { run: async () => { modelRuns += 1; throw new Error('Existing checked plan must be retained'); } } }));
  const report = await second.runner.resumeAll(); expect(report.resumed).toEqual([{ contractId: id, step: 'plan' }]);
  await waitFor(() => waits === 2, 'restored registered deferral');
  expect(second.agentsOf('u1')).toHaveLength(0); expect(modelRuns).toBe(0); expect(second.store.get(id)!.nativeDecisions!.spent.plan).toBe(1);
  revision = '2'; wake!(); await waitFor(() => terminal(second, id), 'resumed native contract'); await second.runner.join(id);
  const done = second.store.get(id)!; expect(done.error).toBeUndefined(); expect(done.status).toBe('passed'); expect(modelRuns).toBe(0);
  const receipt = done.nativeDecisions!.history.at(-1)!.decision;
  expect(receipt.outcome).toBe('act'); expect(receipt.decisionId).not.toBe(prior.decisionId); expect(receipt.binding.actionRevision).not.toBe(prior.binding.actionRevision);
  expect(done.criteria.map(item => item.text)).toEqual([...source.criteria]); expect(done.escalations).toHaveLength(0);
}, 20_000);

for (const field of ['authorityId', 'authorityRevision', 'scopeId', 'scopeRevision'] as const) {
  test.each(['before-resume', 'during-wait'] as const)(`deferred restart cancels when ${field} changes %s without adopting the changed identity`, async timing => {
    const directory = root(); using log = new SqliteDecisionLog(':memory:');
    const identity = authority(); let revision = '1'; let waits = 0; let wake: (() => void) | undefined;
    const host: NativeContractDecisionHost = { authorityOf: () => identity, conditions: (_contract, stage) => stage !== 'plan' ? [] : [{ ref: { id: 'build-evidence', revision }, description: 'Independent evidence arrives', current: () => ({ id: 'build-evidence', revision }),
      wait: signal => new Promise<void>((resolve, reject) => { waits += 1; wake = resolve; signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }) }] };
    const first = add(makeHarness({ root: directory, recordNative: true, decisionLog: log, nativeDecisions: host, plan: plan(), scripts: {}, port: context => context.name === 'disposition' ? choiceAnswer(context.question, 'defer_0', 0.99) : undefined }));
    const id = startContract(first, { nativeSource: source }).contract.id;
    await waitFor(() => waits === 1, 'original registered deferral');
    const prior = first.store.get(id)!.nativeDecisions!.history.at(-1)!.decision;
    first.dispose(); await first.runner.join(id); harnesses.splice(harnesses.indexOf(first), 1);
    if (timing === 'before-resume') { identity[field] = 'superseded'; revision = '2'; }
    let modelRuns = 0; let semanticReads = 0;
    const second = add(makeHarness({ root: directory, recordNative: true, decisionLog: log, nativeDecisions: host, scripts: { u1: finishes('parser complete') },
      planner: { run: async () => { modelRuns += 1; throw new Error('Changed authority cannot restart planning'); } },
      port: context => { if (context.name === 'disposition') semanticReads += 1; return undefined; } }));
    await second.runner.resumeAll();
    if (timing === 'during-wait') {
      await waitFor(() => waits === 2, 'restored registered deferral');
      identity[field] = 'superseded'; revision = '2'; wake!();
    }
    await waitFor(() => terminal(second, id), 'revoked deferred contract'); await second.runner.join(id);
    const done = second.store.get(id)!;
    expect(done.status).toBe('cancelled'); expect(second.agentsOf('u1')).toHaveLength(0);
    expect(modelRuns).toBe(0); expect(semanticReads).toBe(0); expect(done.nativeDecisions!.spent.plan).toBe(1);
    expect(done.nativeDecisions!.history.map(record => record.decision)).toEqual([prior]); expect(done.nativeSource).toEqual(source);
  }, 20_000);
}

test('historical native plan-owner wait is inspected and freshly refused without resetting spent repairs', async () => {
  const directory = root(); const bad = plan(); bad.criteria[0]!.text = 'Generated weaker requirement';
  const contract = makeContract({ schemaVersion: 3, projectRoot: directory, nativeSource: source, goal: source.goal, criteria: nativeSourceCriteria(source), shape: shapeOf(), groups: [], units: [],
    status: 'awaiting-owner', statusBeforeOwner: 'checking-plan', escalations: [{ id: 'old.e1', at: 10, scope: 'plan', targetId: 'old-plan', reason: 'plan-unresolved', question: plannerOutput(bad), unmetCriterionIds: [] }],
    decisions: [1, 2, 3].map(n => ({ id: `old.d${n}`, at: n, action: 'planned', targetId: 'old-plan', reason: 'historical attempt', decisionIds: [] })) });
  writeSnapshot(contractPath(directory, contract.id), contract, 3);
  let modelRuns = 0;
  const h = add(makeHarness({ root: directory, recordNative: true, contract: { planRepairLimit: 1 }, scripts: {}, planner: { run: async () => { modelRuns += 1; throw new Error('Spent budget cannot restart'); } } }));
  await h.runner.resumeAll(); await waitFor(() => terminal(h, contract.id), 'legacy native refusal');
  const done = h.store.get(contract.id)!; expect(done.status).toBe('failed'); expect(modelRuns).toBe(0); expect(done.nativeDecisions!.spent.plan).toBe(3);
  expect(done.nativeDecisions!.history.at(-1)!.decision.outcome).toBe('reject'); expect(done.criteria[0]!.text).toBe(source.criteria[0]!);
  expect(done.escalations).toEqual(contract.escalations); expect(h.events.some(event => event.type === 'CONTRACT_OWNER_REPLIED' || event.type === 'CONTRACT_ESCALATED')).toBe(false);
}, 20_000);

test('historical native unshown wait cannot become met by repeating the same evidence or approving it', async () => {
  const directory = root(); using log = new SqliteDecisionLog(':memory:'); let waiting = false;
  const host: NativeContractDecisionHost = { authorityOf: authority, conditions: (_contract, stage) => stage !== 'evidence' ? [] : [{ ref: { id: 'external', revision: '1' }, description: 'External evidence', current: () => ({ id: 'external', revision: '1' }),
    wait: signal => new Promise<void>((_resolve, reject) => { waiting = true; signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }) }] };
  const first = add(makeHarness({ root: directory, recordNative: true, decisionLog: log, nativeDecisions: host, plan: plan(), contract: { evidenceNudgeLimit: 0, maxFixRounds: 0 },
    scripts: { u1: () => [{ files: { 'src/csv.ts': 'unchanged evidence' }, text: '[p=0.2] unshown parser' }] },
    port: context => context.name === 'disposition' && String((context.state['binding'] as { actionId?: string })?.actionId).includes(':evidence:') ? choiceAnswer(context.question, 'defer_0', 0.99) : undefined }));
  const id = startContract(first, { nativeSource: source }).contract.id; await waitFor(() => waiting, 'evidence deferral');
  first.dispose(); await first.runner.join(id); harnesses.splice(harnesses.indexOf(first), 1);
  const path = contractPath(directory, id); const saved = (JSON.parse(readFileSync(path, 'utf8')) as { contract: Contract }).contract;
  delete saved.nativeDecisions; delete saved.nativeProgress; delete saved.nativeWaiting; saved.status = 'awaiting-owner'; saved.statusBeforeOwner = 'running'; saved.units[0]!.status = 'awaiting-owner';
  saved.escalations = [{ id: `${id}.old`, at: 10, scope: 'unit', targetId: 'u1', reason: 'unsettled', question: 'Historical request for approval', unmetCriterionIds: [] }];
  writeSnapshot(path, { ...saved, schemaVersion: 3 }, 3);
  const h = add(makeHarness({ root: directory, recordNative: true, decisionLog: log, contract: { maxFixRounds: 0 }, scripts: {}, port: context => context.name.startsWith('criterion_') ? noulAnswer(0.01) : undefined }));
  await h.runner.resumeAll(); await waitFor(() => terminal(h, id), 'fresh refusal of unchanged evidence'); await h.runner.join(id);
  const done = h.store.get(id)!; expect(done.status).toBe('failed'); expect(done.units[0]!.criteria[0]!.status).toBe('unshown'); expect(h.agentsOf('u1')).toHaveLength(0);
  expect(done.nativeDecisions!.history.at(-1)!.decision.outcome).toBe('reject'); expect(done.escalations[0]!.reply).toBeUndefined();
  expect(h.events.some(event => event.type === 'CONTRACT_OWNER_REPLIED' || event.type === 'CONTRACT_ESCALATED')).toBe(false);
}, 20_000);


test('deferred fix planner resumes its retained checked plan without resetting fix or planner budgets', async () => {
  const directory = root(); using log = new SqliteDecisionLog(':memory:'); let revision = '1'; let waits = 0; let wake: (() => void) | undefined;
  const host: NativeContractDecisionHost = { authorityOf: authority, conditions: (_contract, stage) => stage !== 'fix-plan' ? [] : [{ ref: { id: 'repair-resource', revision }, description: 'Repair resource becomes available', current: () => ({ id: 'repair-resource', revision }),
    wait: signal => new Promise<void>((resolve, reject) => { waits += 1; wake = resolve; signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }) }] };
  const planner = stepPlanner(plan(), { fix: () => plannerOutput(fixPlan([{ serves: ['c1'] }])) });
  const first = add(makeHarness({ root: directory, recordNative: true, decisionLog: log, nativeDecisions: host, planner: planner.runner, scripts: { u1: finishes('initial parser') },
    port: context => {
      if (judgeOf(context) === 'deliverable') return noulAnswer(0.9);
      if (context.name === 'disposition' && String((context.state['binding'] as { actionId?: string })?.actionId).includes(':fix-plan:')) return choiceAnswer(context.question, 'defer_0', 0.99);
      return undefined;
    } }));
  const id = startContract(first, { nativeSource: source }).contract.id; await waitFor(() => waits === 1, 'fix planner deferral');
  expect(first.store.get(id)!.fixRounds).toBe(1); first.dispose(); await first.runner.join(id); harnesses.splice(harnesses.indexOf(first), 1);
  let modelRuns = 0;
  const second = add(makeHarness({ root: directory, recordNative: true, decisionLog: log, nativeDecisions: host,
    scripts: scriptsWith({}, unitId => unitId.endsWith('.f1.u1') ? finishes('actual repaired parser') : undefined),
    planner: { run: async () => { modelRuns += 1; throw new Error('Retained fix plan must be re-evaluated instead'); } } }));
  await second.runner.resumeAll(); await waitFor(() => waits === 2, 'resumed fix condition'); expect(second.agentsOf(`${id}.f1.u1`)).toHaveLength(0);
  revision = '2'; wake!(); await waitFor(() => terminal(second, id), 'resumed fix completion', 15_000); await second.runner.join(id);
  const done = second.store.get(id)!; expect(done.error).toBeUndefined(); expect(done.status).toBe('passed'); expect(done.fixRounds).toBe(1); expect(done.nativeDecisions!.spent[`fix:${id}:1`]).toBe(1); expect(modelRuns).toBe(0);
  expect(done.criteria[0]!.readings.map(reading => reading.verdict)).toEqual(['unmet', 'met']);
}, 20_000);

test('a native-configured owner holds source-less historical records without activating legacy approval', async () => {
  const directory = root(); const contract = makeContract({ projectRoot: directory, status: 'awaiting-owner', statusBeforeOwner: 'running', escalations: [{ id: 'legacy.e1', at: 10, scope: 'unit', targetId: 'u1', reason: 'unsettled', question: 'Old approval request', unmetCriterionIds: [] }] });
  writeSnapshot(contractPath(directory, contract.id), contract, 1);
  const h = add(makeHarness({ root: directory, recordNative: true, scripts: {} }));
  expect(h.runner.nativeMode).toBe(true); const report = await h.runner.resumeAll(); expect(report.resumed).toHaveLength(0); expect(report.skipped).toEqual([contract.id]);
  expect(h.runner.get(contract.id)?.status).toBe('awaiting-owner'); expect(h.manager.list()).toHaveLength(0);
  expect(() => startContract(h)).toThrow('complete original source');
  await expect(h.runner.reply(contract.id, 'legacy.e1', 'Yes, approved')).rejects.toThrow();
  await expect(createContractIntake({ runner: h.runner, projectRoot: directory }).intake({ sessionId: contract.sessionId, text: 'Yes, approved' })).rejects.toThrow('source-bearing host admission');
  expect(h.runner.get(contract.id)?.escalations[0]!.reply).toBeUndefined(); expect(h.events.some(event => event.type === 'CONTRACT_OWNER_REPLIED')).toBe(false);
});

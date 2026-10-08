/** Lightweight projection tests. Full source-bound native lifecycle proof is separate. */
import { expect, test } from 'bun:test';
import { inspectContractIntegration } from '../../sdk/src/platform/contract/integration-inspection.js';
import { CONTRACT_INTEGRATION_MAX_BYTES, contractIntegrationInspectionSchema } from '../../sdk/src/platform/contract/integration-inspection-wire.js';
import { ContractRun } from '../../sdk/src/platform/contract/run-context.js';
import type { Contract, UnitCheck } from '../../sdk/src/platform/contract/types.js';
import type { OrchestrationEngine } from '../../sdk/src/platform/orchestration/engine.js';
import { emptyWorkItemUsage, type WorkItem, type Workstream } from '../../sdk/src/platform/orchestration/types.js';
import { readContractConfig } from '../../sdk/src/platform/contract/config.js';
import { configReader } from './plan-support.js';
import { makeContract, makeUnit } from './fixtures.js';

function item(contractId: string, unitId = 'u1', overrides: Partial<WorkItem> = {}): WorkItem {
  return { id: unitId, contractId, contractUnitId: unitId, title: 'Irrelevant prose', task: '', dependsOn: [], currentPhaseId: null,
    state: 'passed', allAgentIds: [], visits: new Map(), touchedPaths: [], usage: emptyWorkItemUsage(), transportRetryCount: 0, createdAt: 1, ...overrides };
}
function fixture(overrides: Partial<Contract> = {}) {
  const contract = makeContract({ id: 'ctr-11111111', isolation: 'worktree', ...overrides });
  const forbidden = () => { throw new Error('Inspection must not invoke runtime effects'); };
  const run = new ContractRun(contract, { now: forbidden, config: () => readContractConfig(configReader()), emit: forbidden, touchAgent: forbidden },
    { passGroup: forbidden, finishPassed: forbidden, fail: forbidden, cancel: forbidden });
  const workstreams: Workstream[] = [{ id: 'g1', title: 'Group', schemaVersion: 1, phases: [], items: [item(contract.id)], createdAt: 1 }];
  let reads = 0;
  run.engine = { listWorkstreams() { reads++; return workstreams; } } as unknown as OrchestrationEngine;
  return { contract, run, workstreams, reads: () => reads };
}
function live(f: ReturnType<typeof fixture>) {
  const result = inspectContractIntegration(f.run);
  expect(result.state).toBe('live');
  if (result.state !== 'live') throw new Error(`Expected live inspection: ${JSON.stringify(result)}`);
  return result;
}

test('actual unit and validated item facts are detached; repaired check does not rewrite old conflict', () => {
  const f = fixture(); const unit = f.contract.units[0]!;
  unit.status = 'passed'; unit.checks.push({ id: 'u1.k2', at: 42, trigger: 'fix-passed', result: 'pass' } as UnitCheck);
  const original = f.workstreams[0]!.items[0]!;
  Object.assign(original, { mergeState: 'conflict', conflictFiles: ['src/a,b.ts', 'src/\n\u001b[2J☃.ts'], worktreePath: '/real/kept/path', worktreeBranch: 'real/branch', worktreeKept: true,
    blockedReason: 'merge-conflict: never-parse-this.ts', conflictSessionId: 'must-not-disclose-a-session' });
  const result = live(f); const row = result.units[0]!;
  expect(row).toEqual({ unitId: 'u1', groupId: 'g1', unitStatus: 'passed', latestCheck: { id: 'u1.k2', at: 42, trigger: 'fix-passed', result: 'pass' },
    item: { state: 'recorded', itemId: 'u1', workstreamId: 'g1', integration: 'conflict', conflictFiles: ['src/a,b.ts', 'src/\n\u001b[2J☃.ts'], worktreePath: '/real/kept/path', worktreeBranch: 'real/branch', worktreeKept: true } });
  if (row.item.state !== 'recorded') throw new Error('missing item');
  row.item.conflictFiles!.push('not-real'); row.latestCheck!.result = 'nudge';
  expect(original.conflictFiles).toHaveLength(2); expect(unit.checks[0]!.result).toBe('pass');
  expect(JSON.stringify(result)).not.toContain('must-not-disclose'); expect(JSON.stringify(result)).not.toContain('needsAttention');
});

test('unrecorded, pending, merged/hash and merged/no-change preserve their actual recorded distinctions', () => {
  const f = fixture(); const original = f.workstreams[0]!.items[0]!;
  expect(live(f).units[0]!.item).toEqual({ state: 'recorded', itemId: 'u1', workstreamId: 'g1', integration: 'unrecorded' });
  for (const mergeState of ['pending', 'merged', 'conflict'] as const) {
    original.mergeState = mergeState;
    expect(live(f).units[0]!.item).toMatchObject({ integration: mergeState });
  }
  original.mergeState = 'merged'; original.mergeHash = 'abc123'; original.conflictFiles = []; original.worktreeKept = false;
  expect(live(f).units[0]!.item).toMatchObject({ integration: 'merged', mergeHash: 'abc123', conflictFiles: [], worktreeKept: false });
  delete original.mergeHash; delete original.conflictFiles; delete original.worktreeKept;
  expect(live(f).units[0]!.item).toEqual({ state: 'recorded', itemId: 'u1', workstreamId: 'g1', integration: 'merged' });
});

test('units in different contracts with identical IDs retain their own engine facts', () => {
  const a = fixture(); const b = fixture({ id: 'ctr-22222222' });
  a.workstreams[0]!.items[0]!.worktreePath = '/first'; b.workstreams[0]!.items[0]!.worktreePath = '/second';
  expect(live(a)).toMatchObject({ contractId: 'ctr-11111111', units: [{ item: { worktreePath: '/first' } }] });
  expect(live(b)).toMatchObject({ contractId: 'ctr-22222222', units: [{ item: { worktreePath: '/second' } }] });
});

test('missing bindings, wrong contracts/groups and ambiguous joins disclose no item facts', () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.workstreams[0]!.items[0] = item('ctr-99999999', 'u1', { worktreePath: '/foreign' }); },
    (f: ReturnType<typeof fixture>) => { f.workstreams[0] = { ...f.workstreams[0]!, id: 'g2' }; },
    (f: ReturnType<typeof fixture>) => { f.workstreams[0]!.items.push(item(f.contract.id)); },
  ]) {
    const f = fixture(); mutate(f);
    expect(live(f).units[0]!.item).toEqual({ state: 'unavailable', reason: 'invalid-join' });
  }
  for (const contractUnitId of [undefined, 'unknown-unit']) {
    const f = fixture(); f.workstreams[0]!.items[0] = item(f.contract.id, 'u1', { contractUnitId, worktreeBranch: 'u1', blockedReason: 'u1' });
    expect(live(f).units[0]!.item).toEqual({ state: 'unavailable', reason: 'missing-item' });
  }
});

test('best-of-N plan has no fabricated item and real attempts preserve exact IDs and parentage', () => {
  const first = makeUnit({ id: 'first-real-attempt', attemptOf: 'u1', attemptIndex: 0 });
  const attempt = makeUnit({ id: 'real-attempt', attemptOf: 'u1', attemptIndex: 1, status: 'passed' });
  const f = fixture({ units: [makeUnit({ attempts: 2, attemptUnits: [first, attempt] })] });
  const firstItem = item(f.contract.id, first.id, { attemptSourceId: 'u1', attemptIndex: 0, attemptGroupId: 'actual-group', attemptTotal: 2 });
  f.workstreams[0]!.items = [firstItem, item(f.contract.id, 'real-attempt', { id: 'actual-engine-item', attemptSourceId: 'u1', attemptIndex: 1, attemptGroupId: 'actual-group', attemptTotal: 2, worktreeBranch: 'deliberately-unrelated' })];
  expect(live(f).units).toEqual([
    { unitId: 'u1', groupId: 'g1', unitStatus: 'pending', latestCheck: null, item: { state: 'not-applicable', reason: 'best-of-n-plan' } },
    { unitId: first.id, groupId: 'g1', attemptOf: 'u1', attemptIndex: 0, unitStatus: 'pending', latestCheck: null,
      item: { state: 'recorded', itemId: first.id, workstreamId: 'g1', integration: 'unrecorded' } },
    { unitId: 'real-attempt', groupId: 'g1', attemptOf: 'u1', attemptIndex: 1, unitStatus: 'passed', latestCheck: null,
      item: { state: 'recorded', itemId: 'actual-engine-item', workstreamId: 'g1', integration: 'unrecorded', worktreeBranch: 'deliberately-unrelated' } },
  ]);
  for (const override of [{ attemptSourceId: 'wrong-parent' }, { attemptIndex: 0 }, { attemptSourceId: undefined }, { attemptIndex: undefined }, { attemptGroupId: undefined }, { attemptTotal: 1 }, { attemptGroupId: 'wrong-group' }]) {
    f.workstreams[0]!.items = [firstItem, item(f.contract.id, 'real-attempt', { attemptSourceId: 'u1', attemptIndex: 1, attemptGroupId: 'actual-group', attemptTotal: 2, ...override })];
    expect(live(f).units[2]!.item).toEqual({ state: 'unavailable', reason: 'invalid-join' });
  }
  const invalidParent = fixture({ units: [makeUnit({ attemptUnits: [makeUnit({ id: 'actual-child', attemptOf: 'wrong-parent', attemptIndex: 0 })] })] });
  expect(inspectContractIntegration(invalidParent.run)).toEqual({ state: 'unavailable', reason: 'invalid-data' });
  const wrongGroup = fixture(); wrongGroup.contract.groups[0]!.unitIds = ['other-unit'];
  expect(live(wrongGroup).units[0]!.item).toEqual({ state: 'unavailable', reason: 'invalid-join' });
});

test('out-of-range or duplicate attempt indexes and cross-parent engine groups are unavailable', () => {
  for (const indexes of [[-1, 1], [0, 2], [0, 0]]) {
    const children = indexes.map((attemptIndex, index) => makeUnit({ id: `attempt-${index}`, attemptOf: 'u1', attemptIndex }));
    expect(inspectContractIntegration(fixture({ units: [makeUnit({ attempts: 2, attemptUnits: children })] }).run)).toEqual({ state: 'unavailable', reason: 'invalid-data' });
  }
  const a = makeUnit({ id: 'a', attemptOf: 'u1', attemptIndex: 0 }); const b = makeUnit({ id: 'b', attemptOf: 'u2', attemptIndex: 0 });
  const f = fixture({ units: [makeUnit({ id: 'u1', attemptUnits: [a] }), makeUnit({ id: 'u2', attemptUnits: [b] })] });
  f.contract.groups[0]!.unitIds = ['u1', 'u2'];
  f.workstreams[0]!.items = [item(f.contract.id, 'a', { attemptSourceId: 'u1', attemptIndex: 0, attemptGroupId: 'reused-group', attemptTotal: 1 }),
    item(f.contract.id, 'b', { attemptSourceId: 'u2', attemptIndex: 0, attemptGroupId: 'reused-group', attemptTotal: 1 })];
  const rows = live(f).units;
  expect(rows.find(row => row.unitId === 'a')!.item).toEqual({ state: 'unavailable', reason: 'invalid-join' });
  expect(rows.find(row => row.unitId === 'b')!.item).toEqual({ state: 'unavailable', reason: 'invalid-join' });
});

test('shared/session, absent engines, terminal/cancelled/aborted/disposed runs never retain live rows', () => {
  for (const status of ['passed', 'failed', 'cancelled'] as const) {
    const f = fixture({ status }); expect(inspectContractIntegration(f.run)).toEqual({ state: 'unavailable', reason: 'not-live' }); expect(f.reads()).toBe(0);
  }
  const f = fixture();
  expect(inspectContractIntegration(undefined)).toEqual({ state: 'unavailable', reason: 'not-live' });
  expect(inspectContractIntegration(f.run, true)).toEqual({ state: 'unavailable', reason: 'not-live' });
  f.run.abort.abort(); expect(inspectContractIntegration(f.run)).toEqual({ state: 'unavailable', reason: 'not-live' }); expect(f.reads()).toBe(0);
  const absent = fixture(); absent.run.engine = null;
  expect(inspectContractIntegration(absent.run)).toEqual({ state: 'unavailable', reason: 'no-engine' });
  for (const [overrides, reason] of [[{ isolation: 'shared' }, 'shared-isolation'], [{ sessionMode: true }, 'session-mode']] as const) {
    const shared = fixture(overrides); expect(inspectContractIntegration(shared.run)).toEqual({ state: 'not-applicable', contractId: shared.contract.id, reason }); expect(shared.reads()).toBe(0);
  }
});

test('oversize observations fail bounded without truncating paths or rows; duplicate unit IDs fail closed', () => {
  const f = fixture(); const path = '☃'.repeat(CONTRACT_INTEGRATION_MAX_BYTES);
  f.workstreams[0]!.items[0]!.conflictFiles = [path];
  expect(inspectContractIntegration(f.run)).toEqual({ state: 'unavailable', reason: 'limit' });
  expect(f.workstreams[0]!.items[0]!.conflictFiles).toEqual([path]);
  expect(inspectContractIntegration(fixture({ units: [makeUnit(), makeUnit()] }).run)).toEqual({ state: 'unavailable', reason: 'invalid-data' });
  expect(inspectContractIntegration(fixture({ units: Array.from({ length: 257 }, (_, n) => makeUnit({ id: String(n) })) }).run)).toEqual({ state: 'unavailable', reason: 'limit' });
  expect(contractIntegrationInspectionSchema.safeParse({ state: 'live', contractId: f.contract.id, isolation: 'worktree', units: [], resolve: true }).success).toBe(false);
});

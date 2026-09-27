/**
 * The runtime store's `contracts` domain (design 8.2): contract events fold
 * into contract records with each unit's latest verdicts, events for a
 * contract not seen yet still land, the totals count every contract ever
 * seen, and ended contracts are bounded.
 */
import { describe, expect, test } from 'bun:test';
import { createDomainDispatch, createRuntimeStore } from '../../sdk/src/platform/runtime/store/index.js';
import { selectContracts } from '../../sdk/src/platform/runtime/store/selectors/index.js';
import { MAX_RETAINED_CONTRACTS, updateContractsState } from '../../sdk/src/platform/runtime/store/helpers/reducers/contracts.js';
import { createInitialContractsState } from '../../sdk/src/platform/runtime/store/domains/contracts.js';
import type { ContractEvent } from '../../sdk/src/events/index.js';
import { ALL_CONTRACT_EVENTS, CTR, SAMPLES } from './event-samples.js';

function fold(events: readonly ContractEvent[]) {
  return events.reduce(updateContractsState, createInitialContractsState());
}

const criterion = (criterionId: string, verdict: 'met' | 'unmet' | 'unshown') => ({ criterionId, verdict, probabilityUnmet: verdict === 'met' ? 0.05 : 0.8, outcome: 'act' as const });

describe('the contracts store domain', () => {
  test('a contract lifecycle folds into one record with its plan, statuses and latest verdicts', () => {
    const state = fold([
      SAMPLES.CONTRACT_CREATED,
      { type: 'CONTRACT_STATUS_CHANGED', contractId: CTR, from: 'queued', to: 'running' },
      SAMPLES.CONTRACT_PLANNED,
      { type: 'CONTRACT_GROUP_STATUS_CHANGED', contractId: CTR, groupId: 'g1', from: 'pending', to: 'running' },
      { type: 'CONTRACT_UNIT_SPAWNED', contractId: CTR, unitId: 'u1', agentId: 'a1', route: { model: 'm', provider: 'p', reason: 'r' }, purpose: 'unit' },
      { type: 'CONTRACT_UNIT_STATUS_CHANGED', contractId: CTR, groupId: 'g1', unitId: 'u1', from: 'pending', to: 'running', agentId: 'a1' },
      { ...SAMPLES.CONTRACT_CHECKED, criteria: [criterion('u1.c1', 'unmet'), criterion('u1.c2', 'met')] },
      SAMPLES.CONTRACT_NUDGED,
      { ...SAMPLES.CONTRACT_CHECKED, checkId: 'u1.k2', result: 'pass', criteria: [criterion('u1.c1', 'met')] },
      { ...SAMPLES.CONTRACT_CHECKED, scope: 'group', targetId: 'g1', checkId: 'g1.k1', result: 'pass', criteria: [criterion('g1.c1', 'met')] },
      { ...SAMPLES.CONTRACT_CHECKED, scope: 'deliverable', targetId: CTR, checkId: `${CTR}.k1`, result: 'pass', criteria: [criterion('c1', 'met')] },
      SAMPLES.CONTRACT_COMMITTED,
      SAMPLES.CONTRACT_PASSED,
    ]);
    const record = state.contracts.get(CTR)!;
    expect(record.ask).toBe('Add a parser');
    expect(record.ownerAgentId).toBe('a-owner');
    expect(record.goal).toBe('A parser');
    expect(record.status).toBe('passed');
    expect(record.endedAt).toBeNumber();
    expect(record.groups.get('g1')).toMatchObject({ title: 'Parsing', kind: 'work', status: 'running', unitIds: ['u1'], verdicts: { 'g1.c1': 'met' } });
    // The unit keeps each criterion's latest verdict: u1.c1 went unmet then met, u1.c2 stays met.
    expect(record.units.get('u1')).toMatchObject({
      groupId: 'g1', title: 'Parser', role: 'implement', status: 'running', agentId: 'a1',
      verdicts: { 'u1.c1': 'met', 'u1.c2': 'met' }, lastCheckId: 'u1.k2', lastCheckResult: 'pass', nudges: 1,
    });
    expect(record.nudges).toBe(1);
    expect(record.criteria.find((entry) => entry.id === 'c1')).toMatchObject({ verdict: 'met', checkId: `${CTR}.k1` });
    // Excluded and met-by-structure criteria are kept with their disposition, never read.
    expect(record.criteria.find((entry) => entry.id === 'c2')).toMatchObject({ disposition: 'met-by-structure' });
    expect(record.criteria.find((entry) => entry.id === 'c2')?.verdict).toBeUndefined();
    expect(record.commit).toEqual({ status: 'committed', hash: 'abc123', note: 'committed on main' });
    expect(record.lastCheck).toEqual({ scope: 'deliverable', targetId: CTR, checkId: `${CTR}.k1`, result: 'pass' });
    expect(state).toMatchObject({ activeContractIds: [], totalContracts: 1, totalPassed: 1, totalFailed: 0, totalCancelled: 0 });
  });

  test('events for a contract not seen yet still land, and the creation fills in the rest', () => {
    const state = fold([
      { type: 'CONTRACT_STATUS_CHANGED', contractId: CTR, from: 'queued', to: 'running' },
      { type: 'CONTRACT_UNIT_STATUS_CHANGED', contractId: CTR, groupId: 'g1', unitId: 'u1', from: 'pending', to: 'held' },
      SAMPLES.CONTRACT_CREATED,
    ]);
    const record = state.contracts.get(CTR)!;
    expect(record.status).toBe('running');
    expect(record.ask).toBe('Add a parser');
    expect(record.units.get('u1')).toMatchObject({ groupId: 'g1', status: 'held' });
    expect(state.activeContractIds).toEqual([CTR]);
  });

  test('an escalation stays open until the owner replies or the contract ends', () => {
    const escalated = fold([SAMPLES.CONTRACT_CREATED, SAMPLES.CONTRACT_ESCALATED]);
    expect(escalated.contracts.get(CTR)?.openEscalations).toEqual([
      { escalationId: 'e1', scope: 'unit', targetId: 'u1', reason: 'unsettled', question: 'Contract needs your decision.' },
    ]);
    expect(updateContractsState(escalated, SAMPLES.CONTRACT_OWNER_REPLIED).contracts.get(CTR)?.openEscalations).toEqual([]);
    const cancelled = updateContractsState(escalated, SAMPLES.CONTRACT_CANCELLED).contracts.get(CTR)!;
    expect(cancelled).toMatchObject({ status: 'cancelled', reason: 'stopped by the owner', openEscalations: [] });
    const failed = updateContractsState(escalated, SAMPLES.CONTRACT_FAILED).contracts.get(CTR)!;
    expect(failed).toMatchObject({ status: 'failed', failureKind: 'max_turns', reason: 'unit u1 spent its turn budget', openEscalations: [] });
  });

  test('the spawn guard is counted, and events the record does not keep change nothing', () => {
    const base = fold([SAMPLES.CONTRACT_CREATED]);
    expect(updateContractsState(base, SAMPLES.CONTRACT_SPAWN_GUARD_TRIGGERED).spawnGuardTrips).toBe(1);
    for (const kept of [SAMPLES.CONTRACT_SHAPED, SAMPLES.CONTRACT_PLAN_CHECKED, SAMPLES.CONTRACT_NUDGE_CONSUMED, SAMPLES.CONTRACT_GATE_RESULT, SAMPLES.CONTRACT_MERGE_CONFLICT]) {
      expect(updateContractsState(base, kept)).toBe(base);
    }
  });

  test('every event type folds without throwing, through the store dispatch', () => {
    const store = createRuntimeStore();
    const dispatch = createDomainDispatch(store);
    for (const event of ALL_CONTRACT_EVENTS) dispatch.dispatchContractEvent(event);
    const state = selectContracts(store.getState());
    expect(state.contracts.get(CTR)?.status).toBe('cancelled');
    expect(state.totalContracts).toBe(1);
    expect(state.spawnGuardTrips).toBe(1);
    expect(state.revision).toBeGreaterThan(0);
  });

  test('ended contracts beyond the bound are dropped oldest first; live ones never are, and totals still count them', () => {
    let state = createInitialContractsState();
    const live = 'ctr-live0000';
    state = updateContractsState(state, { ...SAMPLES.CONTRACT_CREATED, contractId: live });
    for (let index = 0; index < MAX_RETAINED_CONTRACTS + 5; index += 1) {
      const contractId = `ctr-${String(index).padStart(8, '0')}`;
      state = updateContractsState(state, { ...SAMPLES.CONTRACT_CREATED, contractId });
      state = updateContractsState(state, { ...SAMPLES.CONTRACT_PASSED, contractId });
    }
    expect(state.contracts.size).toBe(MAX_RETAINED_CONTRACTS);
    expect(state.contracts.has(live)).toBe(true);
    expect(state.contracts.has('ctr-00000000')).toBe(false);
    expect(state.contracts.has(`ctr-${String(MAX_RETAINED_CONTRACTS + 4).padStart(8, '0')}`)).toBe(true);
    expect(state.totalContracts).toBe(MAX_RETAINED_CONTRACTS + 6);
    expect(state.totalPassed).toBe(MAX_RETAINED_CONTRACTS + 5);
    expect(state.activeContractIds).toEqual([live]);
  });
});

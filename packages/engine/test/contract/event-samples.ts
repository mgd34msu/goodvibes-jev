/**
 * One contract event of every type, with every optional field present, for
 * the event-domain tests and the tests of each consumer of the domain.
 * Keyed by type, so a type added to the union without a sample does not
 * compile.
 */
import { CONTRACT_EVENT_TYPES, type ContractEvent, type ContractEventType } from '../../sdk/src/events/index.js';

export const CTR = 'ctr-0a1b2c3d';
const shape = { verdict: 'no', probability: 0.08, outcome: 'act' } as const;

export const SAMPLES: { readonly [T in ContractEventType]: Extract<ContractEvent, { type: T }> } = {
  CONTRACT_CREATED: { type: 'CONTRACT_CREATED', contractId: CTR, sessionId: 's1', origin: 'turn', ask: 'Add a parser', ownerAgentId: 'a-owner' },
  CONTRACT_STATUS_CHANGED: { type: 'CONTRACT_STATUS_CHANGED', contractId: CTR, from: 'queued', to: 'shaping' },
  CONTRACT_SHAPED: {
    type: 'CONTRACT_SHAPED', contractId: CTR, forbidsDelegation: shape, requestsParallelAgents: { verdict: 'yes', probability: 0.91, outcome: 'act' },
    forbidsWriting: { verdict: 'uncertain', probability: 0.5, outcome: 'escalate' }, asksForAttempts: shape, decisionIds: ['d1', 'd2'],
  },
  CONTRACT_PLANNED: {
    type: 'CONTRACT_PLANNED', contractId: CTR, goal: 'A parser',
    criteria: [
      { id: 'c1', text: 'Parses dates', origin: 'stated', quote: 'parse dates', serves: [], disposition: 'judged' },
      { id: 'c2', text: 'One agent per file', origin: 'stated', quote: 'one agent per file', serves: [], disposition: 'met-by-structure', dispositionReason: 'group g1 runs one unit per file' },
    ],
    groups: [{ id: 'g1', title: 'Parsing', kind: 'work', dependsOn: [], unitIds: ['u1'] }],
    units: [{ id: 'u1', groupId: 'g1', title: 'Parser', role: 'implement', dependsOn: [], attempts: 1 }],
    repair: 0,
  },
  CONTRACT_PLAN_CHECKED: {
    type: 'CONTRACT_PLAN_CHECKED', contractId: CTR, check: 'criterion-trace', targetId: 'c1', passed: false,
    problems: [{ code: 'quote-not-found', targetId: 'c1', message: 'The quote is not in the request.' }], decisionIds: ['d3'],
  },
  CONTRACT_GROUP_STATUS_CHANGED: { type: 'CONTRACT_GROUP_STATUS_CHANGED', contractId: CTR, groupId: 'g1', from: 'pending', to: 'running' },
  CONTRACT_UNIT_STATUS_CHANGED: { type: 'CONTRACT_UNIT_STATUS_CHANGED', contractId: CTR, groupId: 'g1', unitId: 'u1', from: 'held', to: 'nudged', agentId: 'a1' },
  CONTRACT_UNIT_SPAWNED: {
    type: 'CONTRACT_UNIT_SPAWNED', contractId: CTR, unitId: 'u1', agentId: 'a1',
    route: { model: 'm', provider: 'p', reasoningEffort: 'high', reason: 'implementation tier' }, purpose: 'unit',
  },
  CONTRACT_CHECKED: {
    type: 'CONTRACT_CHECKED', contractId: CTR, scope: 'unit', targetId: 'u1', checkId: 'u1.k1', trigger: 'completion', result: 'nudge',
    criteria: [{ criterionId: 'u1.c1', verdict: 'unmet', probabilityUnmet: 0.83, outcome: 'act' }],
    goal: { verdict: 'unshown', outcome: 'confirm' },
    quality: [{ item: 'placeholder', verdict: 'yes', outcome: 'act' }],
    gates: [{ gate: 'test', passed: false, skipped: false }], claims: 'files_verified', decisionIds: ['d4'],
  },
  CONTRACT_NUDGED: {
    type: 'CONTRACT_NUDGED', contractId: CTR, unitId: 'u1', nudgeId: 'u1.n1', checkId: 'u1.k1',
    kinds: ['unmet', 'gate'], criterionIds: ['u1.c1'], delivery: 'hold', agentId: 'a1',
  },
  CONTRACT_NUDGE_CONSUMED: { type: 'CONTRACT_NUDGE_CONSUMED', contractId: CTR, unitId: 'u1', nudgeId: 'u1.n1', agentId: 'a1', turn: 4 },
  CONTRACT_CRITERION_REGRESSED: { type: 'CONTRACT_CRITERION_REGRESSED', contractId: CTR, unitId: 'u1', criterionId: 'u1.c2', metAtCheckId: 'u1.k1', checkId: 'u1.k2' },
  CONTRACT_STALLED: {
    type: 'CONTRACT_STALLED', contractId: CTR, scope: 'unit', targetId: 'u1', route: 'split', unmetCriterionIds: ['u1.c1'],
    reason: 'three checks without progress', decisionId: 'd5',
  },
  CONTRACT_FIX_PLANNED: { type: 'CONTRACT_FIX_PLANNED', contractId: CTR, scope: 'unit', targetId: 'u1', groupId: 'u1.f1', unitIds: ['u1.f1.u1'], round: 1 },
  CONTRACT_ESCALATED: {
    type: 'CONTRACT_ESCALATED', contractId: CTR, escalationId: 'e1', scope: 'unit', targetId: 'u1', reason: 'unsettled',
    question: 'Contract needs your decision.', unmetCriterionIds: [],
  },
  CONTRACT_OWNER_REPLIED: { type: 'CONTRACT_OWNER_REPLIED', contractId: CTR, escalationId: 'e1', reading: 'approve', outcome: 'act', action: 'unit passed on owner confirmation' },
  CONTRACT_GATE_RESULT: { type: 'CONTRACT_GATE_RESULT', contractId: CTR, targetId: 'u1', gate: 'lint', passed: true, skipped: true, durationMs: 0 },
  CONTRACT_UNIT_SILENT: { type: 'CONTRACT_UNIT_SILENT', contractId: CTR, unitId: 'u1', agentId: 'a1', silentMs: 120_000, action: 'retried' },
  CONTRACT_MERGE_CONFLICT: { type: 'CONTRACT_MERGE_CONFLICT', contractId: CTR, unitId: 'u1', branch: 'ws/ab/cd', path: '/tmp/wt', files: ['src/a.ts'] },
  CONTRACT_ATTEMPTS_SELECTED: {
    type: 'CONTRACT_ATTEMPTS_SELECTED', contractId: CTR, unitId: 'u1', candidateIds: ['u1#1', 'u1#2'], chosen: null, outcome: 'escalate', decisionId: 'd6',
  },
  CONTRACT_COMMITTED: { type: 'CONTRACT_COMMITTED', contractId: CTR, status: 'committed', hash: 'abc123', note: 'committed on main' },
  CONTRACT_PASSED: { type: 'CONTRACT_PASSED', contractId: CTR, criteriaMet: 4, criteriaJudged: 4, excluded: 1, nudges: 2 },
  CONTRACT_FAILED: {
    type: 'CONTRACT_FAILED', contractId: CTR, reason: 'unit u1 spent its turn budget', failureKind: 'max_turns',
    membersSettled: true, turnLimit: 40, turnLimitSource: 'policy-bound',
  },
  CONTRACT_CANCELLED: { type: 'CONTRACT_CANCELLED', contractId: CTR, reason: 'stopped by the owner', filesModified: 3 },
  CONTRACT_SPAWN_GUARD_TRIGGERED: {
    type: 'CONTRACT_SPAWN_GUARD_TRIGGERED', contractId: CTR, agentId: 'a1', depth: 2, activeAgents: 5, reason: 'units are leaves; the contract plans sub-work',
  },
};

/** Every sample, in the order the design lists the types. */
export const ALL_CONTRACT_EVENTS: readonly ContractEvent[] = CONTRACT_EVENT_TYPES.map((type) => SAMPLES[type] as ContractEvent);

import type { ContractView, ContractUnitView, CriterionView } from '@goodvibes-jev/engine/sdk/platform/contract';

const usage: ContractView['usage'] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 0, turnCount: 0, toolCallCount: 0, costUsd: null, costState: 'unpriced' };

export function contractCriterion(extra: Partial<CriterionView> = {}): CriterionView {
  return { id: 'c1', text: 'The tests pass', origin: 'stated', quote: 'The tests pass', serves: [], disposition: 'judged', status: 'met',
    readings: [{ checkId: 'u1.k1', at: 1500, probabilityUnmet: 0.01, verdict: 'met', outcome: 'act', decisionId: 'd1' }], ...extra };
}

export function contractUnit(extra: Partial<ContractUnitView> = {}): ContractUnitView {
  return { id: 'u1', groupId: 'g1', title: 'Repair retry cap', goal: 'Respect the cap', brief: 'Clamp after jitter', role: 'implement', dependsOn: [], files: ['src/retry.ts'], attempts: 1,
    criteria: [contractCriterion()], status: 'passed', agentIds: ['worker'], checks: [{ id: 'u1.k1', at: 1500, trigger: 'completion', goal: { probabilityUnmet: 0.01, verdict: 'met', outcome: 'act' }, quality: {}, result: 'pass', decisionIds: ['d1'], evidenceDigest: 'synthetic' }],
    nudges: [], fixRounds: 0, freshAgents: 0, transportRetries: 0, touchedPaths: ['src/retry.ts'], usage, ...extra };
}

export function contractFixture(extra: Partial<ContractView> = {}): ContractView {
  return { id: 'contract-1', schemaVersion: 1, sessionId: 'test-session', origin: 'agent-tool', ask: 'Repair the retry cap', ownerAgentId: 'owner', projectRoot: '/synthetic/project', isolation: 'shared',
    goal: 'Retry without exceeding the cap', criteria: [contractCriterion()],
    groups: [{ id: 'g1', title: 'Retry repair', goal: 'Repair cap', kind: 'work', dependsOn: [], criteria: [], unitIds: ['u1'], status: 'passed', checks: [], fixRounds: 0, usage }],
    units: [contractUnit()], status: 'passed', checks: [], fixRounds: 0, escalations: [], decisions: [], usage, judgmentUsage: { calls: 1, inputTokens: 1, outputTokens: 1 }, plannerAgentIds: [], createdAt: 1000, completedAt: 2000, ...extra };
}

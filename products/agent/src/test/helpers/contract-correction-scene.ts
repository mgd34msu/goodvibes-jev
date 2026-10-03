/** Canonical successor of the engineer → failing review → fixer → passing review scene. */
import type { ContractView, ContractUnitView } from '@goodvibes-jev/engine/sdk/platform/contract';
import { contractCriterion, contractFixture, contractUnit } from './contract-work-tree-fixtures.ts';

export function correctedContractScene(startedAt: number): ContractView {
  const usage = contractFixture().usage;
  const met = { probabilityUnmet: 0.01, verdict: 'met' as const, outcome: 'act' as const };
  const unmet = { probabilityUnmet: 0.99, verdict: 'unmet' as const, outcome: 'act' as const };
  const check = (id: string, at: number, trigger: 'completion' | 'fix-passed', result: 'pass' | 'stall'): ContractUnitView['checks'][number] => ({
    id, at, trigger, result, goal: result === 'pass' ? met : unmet, quality: {}, decisionIds: [`${id}.decision`], evidenceDigest: `synthetic:${id}`,
  });
  const unit = contractUnit({
    id: 'u1', groupId: 'g1', title: 'review the cap', goal: 'Delay never exceeds maxDelayMs', brief: 'Implement and verify the delay cap', role: 'implement',
    files: ['src/net/retry.ts'], touchedPaths: ['src/net/retry.ts'], agentIds: ['w1'],
    criteria: [contractCriterion({ id: 'u1.c1', text: 'Jitter does not exceed maxDelayMs', origin: 'derived', quote: undefined, serves: ['c1'],
      readings: [
        { checkId: 'u1.k1', at: startedAt + 75_000, ...unmet, decisionId: 'u1.k1.decision' },
        { checkId: 'u1.k2', at: startedAt + 77_900, ...met, decisionId: 'u1.k2.decision' },
      ],
    })],
    checks: [check('u1.k1', startedAt + 75_000, 'completion', 'stall'), check('u1.k2', startedAt + 77_900, 'fix-passed', 'pass')],
    nudges: [{ id: 'u1.n1', checkId: 'u1.k1', at: startedAt + 75_100, kinds: ['unmet'], criterionIds: ['u1.c1'],
      text: 'Jitter can push the delay past maxDelayMs; clamp after adding jitter', delivery: 'bus', agentId: 'w1', consumedAt: startedAt + 76_000 }],
    fixRounds: 1, answer: 'The correction clamps after jitter; the previously unmet criterion now passes',
  });
  const fix = contractUnit({
    id: 'u1.f1.u1', groupId: 'u1.f1', title: 'clamp after adding jitter', goal: 'Repair the cap', brief: 'Clamp after jitter', role: 'implement',
    files: ['src/net/retry.ts'], touchedPaths: ['src/net/retry.ts'], agentIds: ['w3'],
    criteria: [contractCriterion({ id: 'u1.f1.u1.c1', text: 'The cap holds after jitter', origin: 'fix', quote: undefined, serves: ['u1.c1'],
      readings: [{ checkId: 'u1.f1.u1.k1', at: startedAt + 76_400, ...met, decisionId: 'u1.f1.u1.k1.decision' }],
    })],
    checks: [check('u1.f1.u1.k1', startedAt + 76_400, 'completion', 'pass')], answer: 'Clamped delay after adding jitter',
  });
  return contractFixture({
    id: 'contract-cap', ownerAgentId: 'wrfc', ask: 'review the cap', goal: 'Retry without exceeding the cap', createdAt: startedAt, completedAt: startedAt + 78_000,
    criteria: [contractCriterion({ id: 'c1', text: 'Retry delay respects maxDelayMs', readings: [{ checkId: 'contract-cap.k1', at: startedAt + 78_000, ...met, decisionId: 'contract-cap.k1.decision' }] })],
    groups: [
      { id: 'g1', title: 'Cap review', goal: 'Respect the cap', kind: 'work', dependsOn: [], criteria: [], unitIds: ['u1'], status: 'passed', checks: [], fixRounds: 0, usage },
      { id: 'u1.f1', title: 'Cap correction', goal: 'Repair the unmet cap criterion', kind: 'fix', dependsOn: [], criteria: [], unitIds: ['u1.f1.u1'], status: 'passed', checks: [], fixRounds: 0, usage,
        repairs: { scope: 'unit', targetId: 'u1', criterionIds: ['u1.c1'] } },
    ],
    units: [unit, fix], checks: [check('contract-cap.k1', startedAt + 78_000, 'completion', 'pass')],
    decisions: [{ id: 'contract-cap.d1', at: startedAt + 75_200, action: 'fix-planned', targetId: 'u1', reason: 'Jitter can push the delay past maxDelayMs', decisionIds: ['u1.k1.decision'] }],
  });
}

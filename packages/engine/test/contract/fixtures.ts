/**
 * A well-formed contract tree for contract tests: one stated criterion, one
 * work group with one implementation unit, and the fields every contract
 * carries. Tests override what they exercise.
 */
import { emptyWorkItemUsage } from '../../sdk/src/platform/orchestration/types.js';
import {
  CURRENT_CONTRACT_SCHEMA_VERSION,
  newContractId,
  type Contract,
  type ContractGroup,
  type ContractUnit,
  type Criterion,
} from '../../sdk/src/platform/contract/index.js';

export function makeCriterion(overrides: Partial<Criterion> & Pick<Criterion, 'id'>): Criterion {
  return {
    text: 'The parser accepts every documented input form',
    origin: 'stated',
    quote: 'accept every documented input form',
    serves: [],
    disposition: 'judged',
    status: 'unread',
    readings: [],
    ...overrides,
  };
}

export function makeUnit(overrides: Partial<ContractUnit> = {}): ContractUnit {
  return {
    id: 'u1',
    groupId: 'g1',
    title: 'Parser',
    goal: 'Parse every documented input form',
    brief: 'Write src/parser.ts and its tests.',
    role: 'implement',
    dependsOn: [],
    files: ['src/parser.ts'],
    attempts: 1,
    criteria: [makeCriterion({ id: 'u1.c1', origin: 'derived', serves: ['c1'], quote: undefined })],
    status: 'pending',
    agentIds: [],
    checks: [],
    nudges: [],
    fixRounds: 0,
    freshAgents: 0,
    transportRetries: 0,
    touchedPaths: [],
    usage: emptyWorkItemUsage(),
    ...overrides,
  };
}

export function makeGroup(overrides: Partial<ContractGroup> = {}): ContractGroup {
  return {
    id: 'g1',
    title: 'Parsing',
    goal: 'The parser works',
    kind: 'work',
    dependsOn: [],
    criteria: [],
    unitIds: ['u1'],
    status: 'pending',
    checks: [],
    fixRounds: 0,
    usage: emptyWorkItemUsage(),
    ...overrides,
  };
}

export function makeContract(overrides: Partial<Contract> = {}): Contract {
  return {
    id: newContractId(),
    schemaVersion: CURRENT_CONTRACT_SCHEMA_VERSION,
    sessionId: 'session-1',
    origin: 'cli',
    ask: 'Add a parser that can accept every documented input form.',
    ownerAgentId: 'agent-owner',
    projectRoot: '/work/project',
    isolation: 'shared',
    goal: 'A parser for every documented input form',
    criteria: [makeCriterion({ id: 'c1' })],
    groups: [makeGroup()],
    units: [makeUnit()],
    status: 'running',
    checks: [],
    fixRounds: 0,
    escalations: [],
    decisions: [],
    usage: emptyWorkItemUsage(),
    judgmentUsage: { calls: 0, inputTokens: 0, outputTokens: 0 },
    plannerAgentIds: [],
    createdAt: 1_000,
    ...overrides,
  };
}

/**
 * Contract runner configuration (docs/design/contract-runner.md section 9.1).
 *
 * The `contract.*` settings replace the retired review loop's `wrfc.*` ones;
 * migrateWrfcSettings (migrations.ts) moves an existing file's values across
 * once. The runner reads them through platform/contract/config.ts, whose
 * CONTRACT_CONFIG_DEFAULTS holds the same defaults as below.
 *
 * A domain of its own rather than a block inside schema-domain-core.ts,
 * because that file is at its size ceiling.
 *
 * `gates` is an array, so, like conversationGate.gatedSurfaces, it is not a
 * scalar ConfigKey and is read through getCategory('contract').
 */
import { type ConfigSettingDefinition, intRange, numRange } from './schema-shared.js';

export interface ContractSettings {
  autoCommit: boolean;
  commitScope: 'off' | 'scoped' | 'all';
  gates: Array<{ name: string; command: string; enabled: boolean }>;
  gateTimeoutMs: number;
  acceptanceStakes: 'high' | 'critical';
  midRunChecks: boolean;
  evidenceNudgeLimit: number;
  stallLimit: number;
  maxNudgesPerUnit: number;
  maxFixRounds: number;
  planRepairLimit: number;
  maxUnits: number;
  defaultAttempts: number;
  maxActiveContracts: number;
  maxParallelUnits: number;
  isolation: 'auto' | 'worktree' | 'shared';
  heartbeatTimeoutMs: number;
  transportRetryLimit: number;
  transportRetryDelayMs: number;
  nudgeTtlMs: number;
}

declare module './schema-types.js' {
  interface GoodVibesConfig {
    contract: ContractSettings;
  }
}

/** Every scalar `contract.*` key and the type of its value. */
export interface ContractConfigValueMap {
  'contract.autoCommit': boolean;
  'contract.commitScope': ContractSettings['commitScope'];
  'contract.gateTimeoutMs': number;
  'contract.acceptanceStakes': ContractSettings['acceptanceStakes'];
  'contract.midRunChecks': boolean;
  'contract.evidenceNudgeLimit': number;
  'contract.stallLimit': number;
  'contract.maxNudgesPerUnit': number;
  'contract.maxFixRounds': number;
  'contract.planRepairLimit': number;
  'contract.maxUnits': number;
  'contract.defaultAttempts': number;
  'contract.maxActiveContracts': number;
  'contract.maxParallelUnits': number;
  'contract.isolation': ContractSettings['isolation'];
  'contract.heartbeatTimeoutMs': number;
  'contract.transportRetryLimit': number;
  'contract.transportRetryDelayMs': number;
  'contract.nudgeTtlMs': number;
}

export type ContractConfigKey = keyof ContractConfigValueMap;

export const contractConfigDefaults: { contract: ContractSettings } = {
  contract: {
    autoCommit: false,
    commitScope: 'scoped',
    gates: [],
    gateTimeoutMs: 120_000,
    acceptanceStakes: 'high',
    midRunChecks: true,
    evidenceNudgeLimit: 2,
    stallLimit: 3,
    maxNudgesPerUnit: 12,
    maxFixRounds: 5,
    planRepairLimit: 2,
    maxUnits: 64,
    defaultAttempts: 1,
    maxActiveContracts: 6,
    maxParallelUnits: 64,
    isolation: 'auto',
    heartbeatTimeoutMs: 0,
    transportRetryLimit: 1,
    transportRetryDelayMs: 5000,
    nudgeTtlMs: 300_000,
  },
};

/**
 * The keys that move from `wrfc.*` (autoCommit, commitScope, maxFixRounds,
 * heartbeatTimeoutMs, the transport retry pair) keep the old validators, so no
 * value migrated from an existing file is refused on its next load.
 */
export const contractConfigSettings: ConfigSettingDefinition[] = [
  {
    key: 'contract.autoCommit',
    type: 'boolean',
    default: false,
    description: 'Commit the deliverable when a contract passes: worktree mode merges the contract branch, shared mode commits the paths the contract touched',
  },
  {
    key: 'contract.commitScope',
    type: 'enum',
    default: 'scoped',
    description: 'What a passing contract commits: off (never commit; the work is left as uncommitted changes), scoped (only the contract\'s own changes, default), all (the whole working tree in shared mode)',
    enumValues: ['off', 'scoped', 'all'],
  },
  {
    key: 'contract.gateTimeoutMs',
    type: 'number',
    default: 120000,
    description: 'Timeout in ms for each quality gate command a contract check runs (contract.gates)',
    ...intRange(1000, 3_600_000),
  },
  {
    key: 'contract.acceptanceStakes',
    type: 'enum',
    default: 'high',
    description: 'How strong a reading must be before a criterion counts as met: high (default) or critical (the strictest declared pass band)',
    enumValues: ['high', 'critical'],
  },
  {
    key: 'contract.midRunChecks',
    type: 'boolean',
    default: true,
    description: 'Check a unit\'s work at the end of each turn that changed files, not only when the unit agent tries to finish',
  },
  {
    key: 'contract.evidenceNudgeLimit',
    type: 'number',
    default: 2,
    description: 'Consecutive checks where the work does not show a criterion is met before the owner is asked to confirm',
    ...intRange(1, 10),
  },
  {
    key: 'contract.stallLimit',
    type: 'number',
    default: 3,
    description: 'Consecutive checks without progress that mark a unit as stalled and hand it to correction',
    ...intRange(1, 20),
  },
  {
    key: 'contract.maxNudgesPerUnit',
    type: 'number',
    default: 12,
    description: 'The most corrections one unit receives before it is treated as stalled',
    ...intRange(1, 100),
  },
  {
    key: 'contract.maxFixRounds',
    type: 'number',
    default: 5,
    description: 'Planned-fix rounds plus fresh agents for one unit, group or deliverable before the owner decides',
    ...numRange(0, 20),
  },
  {
    key: 'contract.planRepairLimit',
    type: 'number',
    default: 2,
    description: 'Times the planner is asked to repair a plan that fails its checks before the owner decides',
    ...intRange(0, 10),
  },
  {
    key: 'contract.maxUnits',
    type: 'number',
    default: 64,
    description: 'The most units one contract plan may hold',
    ...intRange(1, 256),
  },
  {
    key: 'contract.defaultAttempts',
    type: 'number',
    default: 1,
    description: 'Independent attempts per unit when the request does not ask for several; above 1, the best passing attempt is selected',
    ...intRange(1, 5),
  },
  {
    key: 'contract.maxActiveContracts',
    type: 'number',
    default: 6,
    description: 'Contracts that may run at once; further contracts wait in a queue',
    ...intRange(1, 64),
  },
  {
    key: 'contract.maxParallelUnits',
    type: 'number',
    default: 64,
    description: 'Units of one group that may run at once in worktree mode (shared mode always runs one)',
    ...intRange(1, 256),
  },
  {
    key: 'contract.isolation',
    type: 'enum',
    default: 'auto',
    description: 'Where contract work runs: auto (a git worktree when the project is a git repository with a commit, otherwise the shared tree), worktree, or shared',
    enumValues: ['auto', 'worktree', 'shared'],
  },
  {
    key: 'contract.heartbeatTimeoutMs',
    type: 'number',
    default: 0,
    description: 'Silence in ms after which a running unit agent is restarted once, then failed. 0 = off.',
    validate: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0,
    validationHint: 'finite number >= 0',
  },
  {
    key: 'contract.transportRetryLimit',
    type: 'number',
    default: 1,
    description: 'How many times a unit whose agent failed on a transient network or transport error is restarted before the contract fails. 0 disables the retry.',
    ...numRange(0, 5),
  },
  {
    key: 'contract.transportRetryDelayMs',
    type: 'number',
    default: 5000,
    description: 'Delay in ms before restarting a unit after a transport failure',
    ...numRange(0, 60000),
  },
  {
    key: 'contract.nudgeTtlMs',
    type: 'number',
    default: 300000,
    description: 'How long in ms a correction sent to a running unit agent waits to be read before it expires',
    ...intRange(1000, 3_600_000),
  },
];

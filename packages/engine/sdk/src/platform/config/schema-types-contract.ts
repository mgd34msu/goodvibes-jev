/**
 * The contract runner's config types: the `contract` category shape, the
 * `contract.*` key union and the value of each key. Named rather than spelled
 * inline in schema-types.ts so that file stays under its line cap, the same
 * split schema-types-payments.ts uses. Defaults and setting definitions live in
 * schema-domain-contract.ts.
 */

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

/**
 * Every scalar `contract.*` key. `contract.gates` is an array and is read
 * through getCategory('contract'), so it is not a key.
 */
export type ContractConfigKey =
  | 'contract.autoCommit'
  | 'contract.commitScope'
  | 'contract.gateTimeoutMs'
  | 'contract.acceptanceStakes'
  | 'contract.midRunChecks'
  | 'contract.evidenceNudgeLimit'
  | 'contract.stallLimit'
  | 'contract.maxNudgesPerUnit'
  | 'contract.maxFixRounds'
  | 'contract.planRepairLimit'
  | 'contract.maxUnits'
  | 'contract.defaultAttempts'
  | 'contract.maxActiveContracts'
  | 'contract.maxParallelUnits'
  | 'contract.isolation'
  | 'contract.heartbeatTimeoutMs'
  | 'contract.transportRetryLimit'
  | 'contract.transportRetryDelayMs'
  | 'contract.nudgeTtlMs';

/** The value of every `contract.*` key, folded into ConfigValue with one arm. */
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

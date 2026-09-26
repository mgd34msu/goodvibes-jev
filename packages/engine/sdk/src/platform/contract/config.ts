/**
 * The `contract.*` settings (docs/design/contract-runner.md section 9.1), read
 * once per call from the config manager. Each value is taken from its dotted
 * key, then from the category object (the only path for `contract.gates`,
 * which is an array and so not a dotted key), then from the default below.
 *
 * Numbers pass a `Number.isFinite` guard: a NaN or Infinity limit would make a
 * bound like `nudges >= maxNudgesPerUnit` never true, so a loop it guards would
 * never end.
 */
import type { ConfigManager } from '../config/manager.js';
import type { QualityGate } from './gates.js';

export type ContractCommitScope = 'off' | 'scoped' | 'all';
export type ContractAcceptanceStakes = 'high' | 'critical';
export type ContractIsolationSetting = 'auto' | 'worktree' | 'shared';

export interface ContractConfig {
  /** Commit the deliverable when it passes. */
  readonly autoCommit: boolean;
  readonly commitScope: ContractCommitScope;
  readonly gates: readonly QualityGate[];
  /** Per gate. */
  readonly gateTimeoutMs: number;
  /** Which declared pass band the judges use. */
  readonly acceptanceStakes: ContractAcceptanceStakes;
  /** Turn-end checks while a unit agent works. */
  readonly midRunChecks: boolean;
  /** Unsettled checks before the owner is asked to confirm. */
  readonly evidenceNudgeLimit: number;
  /** Consecutive non-progress checks that make a stall. */
  readonly stallLimit: number;
  /** Absolute nudge ceiling per unit. */
  readonly maxNudgesPerUnit: number;
  /** Planned-fix rounds plus fresh agents before the owner decides. */
  readonly maxFixRounds: number;
  /** Planner repairs before the owner decides. */
  readonly planRepairLimit: number;
  /** Units per plan. */
  readonly maxUnits: number;
  /** Attempts per unit without an explicit ask. */
  readonly defaultAttempts: number;
  /** Contracts past `queued` at once. */
  readonly maxActiveContracts: number;
  /** Phase capacity per group in worktree mode. */
  readonly maxParallelUnits: number;
  readonly isolation: ContractIsolationSetting;
  /** Unit-agent silence watchdog; 0 turns it off. */
  readonly heartbeatTimeoutMs: number;
  readonly transportRetryLimit: number;
  readonly transportRetryDelayMs: number;
  /** Message-bus time to live for a mid-run nudge. */
  readonly nudgeTtlMs: number;
}

/** Defaults for every `contract.*` setting; the schema declares the same values. */
export const CONTRACT_CONFIG_DEFAULTS: ContractConfig = {
  autoCommit: true,
  commitScope: 'scoped',
  // The WRFC defaults, carried over: typecheck and lint gate every unit, build is opt-in.
  gates: [
    { name: 'typecheck', command: 'npx tsc --noEmit', enabled: true },
    { name: 'lint', command: 'npx eslint . --max-warnings 0', enabled: true },
    { name: 'build', command: 'npm run build', enabled: false },
  ],
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
  transportRetryDelayMs: 5_000,
  nudgeTtlMs: 300_000,
};

export type ContractConfigReader = Pick<ConfigManager, 'get' | 'getCategory'>;

type NumberSetting = {
  [K in keyof ContractConfig]: ContractConfig[K] extends number ? K : never;
}[keyof ContractConfig];

const COMMIT_SCOPES: readonly string[] = ['off', 'scoped', 'all'];
const ACCEPTANCE_STAKES: readonly string[] = ['high', 'critical'];
const ISOLATION_SETTINGS: readonly string[] = ['auto', 'worktree', 'shared'];

function isQualityGate(value: unknown): value is QualityGate {
  if (value === null || typeof value !== 'object') return false;
  const gate = value as Record<string, unknown>;
  return typeof gate['name'] === 'string' && typeof gate['command'] === 'string' && typeof gate['enabled'] === 'boolean';
}

/**
 * Reads every `contract.*` setting. The dotted key wins, then the category
 * object, then the default; a value of the wrong type or shape is skipped at
 * each step rather than used.
 */
export function readContractConfig(configManager: ContractConfigReader): ContractConfig {
  const category = (configManager.getCategory('contract') ?? {}) as Readonly<Record<string, unknown>>;
  // The dotted-key reader is typed per key; the contract keys are all declared,
  // so the name is safe to widen for this generic lookup.
  const dotted = (key: keyof ContractConfig): unknown => (configManager.get as (key: string) => unknown)(`contract.${key}`);
  const pick = <K extends keyof ContractConfig>(key: K, accept: (value: unknown) => boolean): ContractConfig[K] => {
    const direct = dotted(key);
    if (accept(direct)) return direct as ContractConfig[K];
    const fromCategory = category[key];
    if (accept(fromCategory)) return fromCategory as ContractConfig[K];
    return CONTRACT_CONFIG_DEFAULTS[key];
  };
  const finite = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value);
  const numberSetting = (key: NumberSetting): number => pick(key, finite);
  const boolean = (value: unknown): boolean => typeof value === 'boolean';
  const oneOf = (values: readonly string[]) => (value: unknown): boolean => typeof value === 'string' && values.includes(value);

  const rawGates = category['gates'];
  return {
    autoCommit: pick('autoCommit', boolean),
    commitScope: pick('commitScope', oneOf(COMMIT_SCOPES)),
    gates: Array.isArray(rawGates) ? rawGates.filter(isQualityGate) : CONTRACT_CONFIG_DEFAULTS.gates,
    gateTimeoutMs: numberSetting('gateTimeoutMs'),
    acceptanceStakes: pick('acceptanceStakes', oneOf(ACCEPTANCE_STAKES)),
    midRunChecks: pick('midRunChecks', boolean),
    evidenceNudgeLimit: numberSetting('evidenceNudgeLimit'),
    stallLimit: numberSetting('stallLimit'),
    maxNudgesPerUnit: numberSetting('maxNudgesPerUnit'),
    maxFixRounds: numberSetting('maxFixRounds'),
    planRepairLimit: numberSetting('planRepairLimit'),
    maxUnits: numberSetting('maxUnits'),
    defaultAttempts: numberSetting('defaultAttempts'),
    maxActiveContracts: numberSetting('maxActiveContracts'),
    maxParallelUnits: numberSetting('maxParallelUnits'),
    isolation: pick('isolation', oneOf(ISOLATION_SETTINGS)),
    heartbeatTimeoutMs: numberSetting('heartbeatTimeoutMs'),
    transportRetryLimit: numberSetting('transportRetryLimit'),
    transportRetryDelayMs: numberSetting('transportRetryDelayMs'),
    nudgeTtlMs: numberSetting('nudgeTtlMs'),
  };
}

export function getContractAutoCommit(configManager: ContractConfigReader): boolean {
  return readContractConfig(configManager).autoCommit;
}

export function getContractCommitScope(configManager: ContractConfigReader): ContractCommitScope {
  return readContractConfig(configManager).commitScope;
}

/** Every configured gate, enabled or not. */
export function getContractGates(configManager: ContractConfigReader): readonly QualityGate[] {
  return readContractConfig(configManager).gates;
}

/** The gates a check runs. */
export function getEnabledContractGates(configManager: ContractConfigReader): readonly QualityGate[] {
  return getContractGates(configManager).filter((gate) => gate.enabled);
}

export function getContractGateTimeoutMs(configManager: ContractConfigReader): number {
  return readContractConfig(configManager).gateTimeoutMs;
}

export function getContractAcceptanceStakes(configManager: ContractConfigReader): ContractAcceptanceStakes {
  return readContractConfig(configManager).acceptanceStakes;
}

export function getContractMidRunChecks(configManager: ContractConfigReader): boolean {
  return readContractConfig(configManager).midRunChecks;
}

export function getContractEvidenceNudgeLimit(configManager: ContractConfigReader): number {
  return readContractConfig(configManager).evidenceNudgeLimit;
}

export function getContractStallLimit(configManager: ContractConfigReader): number {
  return readContractConfig(configManager).stallLimit;
}

export function getContractMaxNudgesPerUnit(configManager: ContractConfigReader): number {
  return readContractConfig(configManager).maxNudgesPerUnit;
}

export function getContractMaxFixRounds(configManager: ContractConfigReader): number {
  return readContractConfig(configManager).maxFixRounds;
}

export function getContractPlanRepairLimit(configManager: ContractConfigReader): number {
  return readContractConfig(configManager).planRepairLimit;
}

export function getContractMaxUnits(configManager: ContractConfigReader): number {
  return readContractConfig(configManager).maxUnits;
}

export function getContractDefaultAttempts(configManager: ContractConfigReader): number {
  return readContractConfig(configManager).defaultAttempts;
}

export function getContractMaxActiveContracts(configManager: ContractConfigReader): number {
  return readContractConfig(configManager).maxActiveContracts;
}

export function getContractMaxParallelUnits(configManager: ContractConfigReader): number {
  return readContractConfig(configManager).maxParallelUnits;
}

export function getContractIsolation(configManager: ContractConfigReader): ContractIsolationSetting {
  return readContractConfig(configManager).isolation;
}

export function getContractHeartbeatTimeoutMs(configManager: ContractConfigReader): number {
  return readContractConfig(configManager).heartbeatTimeoutMs;
}

export function getContractTransportRetryLimit(configManager: ContractConfigReader): number {
  return readContractConfig(configManager).transportRetryLimit;
}

export function getContractTransportRetryDelayMs(configManager: ContractConfigReader): number {
  return readContractConfig(configManager).transportRetryDelayMs;
}

export function getContractNudgeTtlMs(configManager: ContractConfigReader): number {
  return readContractConfig(configManager).nudgeTtlMs;
}

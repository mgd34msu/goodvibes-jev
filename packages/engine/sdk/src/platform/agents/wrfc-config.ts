/**
 * The review loop's settings, read from the `contract.*` settings that
 * replaced them (config/schema-domain-contract.ts). This module and the
 * controller that reads it are deleted with the rest of the review loop in
 * ledger task R.10; until then the controller follows the migrated values.
 *
 * `wrfc.scoreThreshold` has no successor setting: the contract runner judges
 * each acceptance criterion instead of a review score, so the controller keeps
 * the old default pass mark as a constant.
 */
import {
  readContractConfig,
  type ContractCommitScope,
  type ContractConfigReader,
} from '../contract/config.js';
import type { QualityGate } from '../contract/gates.js';

export type { AgentManagerLike } from '../contract/types.js';
export type WrfcCommitScope = ContractCommitScope;
export type WrfcConfigReader = ContractConfigReader;

/** The old default pass mark, the value every installation ran with unless it set its own. */
export const WRFC_SCORE_THRESHOLD = 9.9;

export type WrfcConfigLike = {
  scoreThreshold: number;
  maxFixAttempts: number;
  autoCommit: boolean;
  commitScope: WrfcCommitScope;
  gates: QualityGate[];
  agentHeartbeatTimeoutMs: number;
  transportRetryLimit: number;
  transportRetryDelayMs: number;
};

export function readWrfcConfig(configManager: WrfcConfigReader): WrfcConfigLike {
  const config = readContractConfig(configManager);
  return {
    scoreThreshold: WRFC_SCORE_THRESHOLD,
    maxFixAttempts: config.maxFixRounds,
    autoCommit: config.autoCommit,
    commitScope: config.commitScope,
    gates: [...config.gates],
    agentHeartbeatTimeoutMs: config.heartbeatTimeoutMs,
    transportRetryLimit: config.transportRetryLimit,
    transportRetryDelayMs: config.transportRetryDelayMs,
  };
}

export function getWrfcAgentHeartbeatTimeoutMs(configManager: WrfcConfigReader): number {
  return readWrfcConfig(configManager).agentHeartbeatTimeoutMs;
}

export function getWrfcTransportRetryLimit(configManager: WrfcConfigReader): number {
  return readWrfcConfig(configManager).transportRetryLimit;
}

export function getWrfcTransportRetryDelayMs(configManager: WrfcConfigReader): number {
  return readWrfcConfig(configManager).transportRetryDelayMs;
}

export function getWrfcScoreThreshold(_configManager: WrfcConfigReader): number {
  return WRFC_SCORE_THRESHOLD;
}

export function getWrfcMaxFixAttempts(configManager: WrfcConfigReader): number {
  return readWrfcConfig(configManager).maxFixAttempts;
}

export function getWrfcAutoCommit(configManager: WrfcConfigReader): boolean {
  return readWrfcConfig(configManager).autoCommit;
}

export function getWrfcCommitScope(configManager: WrfcConfigReader): WrfcCommitScope {
  return readWrfcConfig(configManager).commitScope;
}

export function getEnabledWrfcGates(configManager: WrfcConfigReader): WrfcConfigLike['gates'] {
  return readWrfcConfig(configManager).gates.filter((gate) => gate.enabled);
}

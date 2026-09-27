/**
 * Contracts domain state: every contract the runtime has seen, folded from the
 * `contracts` event domain (docs/design/contract-runner.md section 8.2). Each
 * record holds the contract's status, its plan (criteria, groups, units), and
 * the latest verdict of every criterion from the checks reported so far, so a
 * surface can show where a contract stands without asking the runner.
 */

import type {
  CheckResult,
  CheckScope,
  ContractCommitStatus,
  ContractFailureKind,
  ContractGroupStatus,
  ContractOrigin,
  ContractStatus,
  ContractUnitStatus,
  CriterionDisposition,
  CriterionVerdict,
  EscalationReason,
  EscalationScope,
  GroupKind,
  UnitRole,
} from '../../../../events/contract.js';

/** A criterion as the plan states it, with its latest verdict once a check has read it. */
export interface ContractCriterionRecord {
  readonly id: string;
  readonly text: string;
  readonly disposition: CriterionDisposition;
  readonly verdict?: CriterionVerdict | undefined;
  readonly checkId?: string | undefined;
}

export interface ContractUnitRecord {
  readonly id: string;
  readonly groupId: string;
  readonly title?: string | undefined;
  readonly role?: UnitRole | undefined;
  readonly status: ContractUnitStatus;
  /** The agent working the unit now, when one is. */
  readonly agentId?: string | undefined;
  /** Latest verdict of each of the unit's criteria, by criterion id. */
  readonly verdicts: Readonly<Record<string, CriterionVerdict>>;
  readonly lastCheckId?: string | undefined;
  readonly lastCheckResult?: CheckResult | undefined;
  readonly nudges: number;
}

export interface ContractGroupRecord {
  readonly id: string;
  readonly title: string;
  readonly kind: GroupKind;
  readonly status: ContractGroupStatus;
  readonly unitIds: readonly string[];
  readonly verdicts: Readonly<Record<string, CriterionVerdict>>;
}

export interface ContractEscalationRecord {
  readonly escalationId: string;
  readonly scope: EscalationScope;
  readonly targetId: string;
  readonly reason: EscalationReason;
  readonly question: string;
}

export interface ContractRecord {
  readonly id: string;
  readonly sessionId?: string | undefined;
  readonly origin?: ContractOrigin | undefined;
  readonly ask: string;
  readonly ownerAgentId?: string | undefined;
  readonly goal?: string | undefined;
  readonly status: ContractStatus;
  readonly criteria: readonly ContractCriterionRecord[];
  readonly groups: ReadonlyMap<string, ContractGroupRecord>;
  readonly units: ReadonlyMap<string, ContractUnitRecord>;
  readonly lastCheck?: { readonly scope: CheckScope; readonly targetId: string; readonly checkId: string; readonly result: CheckResult } | undefined;
  readonly nudges: number;
  /** Escalations still waiting for the owner. */
  readonly openEscalations: readonly ContractEscalationRecord[];
  readonly commit?: { readonly status: ContractCommitStatus; readonly hash?: string | undefined; readonly note: string } | undefined;
  readonly failureKind?: ContractFailureKind | undefined;
  /** Why it failed or was cancelled. */
  readonly reason?: string | undefined;
  readonly createdAt: number;
  readonly endedAt?: number | undefined;
}

export interface ContractDomainState {
  revision: number;
  lastUpdatedAt: number;
  source: string;
  contracts: Map<string, ContractRecord>;
  /** Contracts not yet passed, failed or cancelled, oldest first. */
  activeContractIds: string[];
  totalContracts: number;
  totalPassed: number;
  totalFailed: number;
  totalCancelled: number;
  /** Spawns refused by the spawn guard (recursion limits, a unit trying to spawn). */
  spawnGuardTrips: number;
}

export function createInitialContractsState(): ContractDomainState {
  return {
    revision: 0,
    lastUpdatedAt: 0,
    source: 'init',
    contracts: new Map(),
    activeContractIds: [],
    totalContracts: 0,
    totalPassed: 0,
    totalFailed: 0,
    totalCancelled: 0,
    spawnGuardTrips: 0,
  };
}

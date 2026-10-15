/** Read the live runner/engine join only. No store, recovery, repair or Fleet controller is consulted. */
import type { WorkItem } from '../orchestration/types.js';
import type { ContractRun } from './run-context.js';
import { contractIntegrationInspectionSchema, type ContractIntegrationInspection, type ContractIntegrationItem } from './integration-inspection-wire.js';

function validated(value: ContractIntegrationInspection): ContractIntegrationInspection {
  const parsed = contractIntegrationInspectionSchema.safeParse(value);
  return parsed.success ? parsed.data : { state: 'unavailable', reason: 'invalid-data' };
}

export function inspectContractIntegration(run: ContractRun | undefined, disposed = false): ContractIntegrationInspection {
  if (disposed || !run || run.terminal) return { state: 'unavailable', reason: 'not-live' };
  const contract = run.contract;
  if (contract.sessionMode) return validated({ state: 'not-applicable', contractId: run.id, reason: 'session-mode' });
  if (contract.isolation === 'shared') return validated({ state: 'not-applicable', contractId: run.id, reason: 'shared-isolation' });
  if (!run.engine) return { state: 'unavailable', reason: 'no-engine' };
  const units = run.allUnits();
  const ids = new Set(units.map(unit => unit.id));
  if (ids.size !== units.length) return { state: 'unavailable', reason: 'invalid-data' };
  if (units.some(unit => unit.attemptOf === undefined && unit.attemptIndex !== undefined)) return { state: 'unavailable', reason: 'invalid-data' };
  if (units.some(unit => unit.attemptOf !== undefined && !contract.units.some(parent => parent.id === unit.attemptOf
    && parent.attemptOf === undefined && parent.groupId === unit.groupId && parent.attemptUnits?.includes(unit)))) return { state: 'unavailable', reason: 'invalid-data' };
  for (const parent of contract.units) {
    const siblings = parent.attemptUnits ?? [];
    const indexes = siblings.map(unit => unit.attemptIndex);
    if (indexes.some(index => index === undefined || !Number.isSafeInteger(index) || index < 0 || index >= siblings.length)
      || new Set(indexes).size !== indexes.length) return { state: 'unavailable', reason: 'invalid-data' };
  }
  const groups = new Set(contract.groups.map(group => group.id));
  if (groups.size !== contract.groups.length) return { state: 'unavailable', reason: 'invalid-data' };
  const matches = new Map<string, Array<{ item: WorkItem; workstreamId: string }>>();
  const engineIdentities = new Set<string>(); const duplicateEngineIdentities = new Set<string>();
  for (const workstream of run.engine.listWorkstreams()) {
    for (const item of workstream.items) {
      const identity = JSON.stringify([workstream.id, item.id]);
      if (engineIdentities.has(identity)) duplicateEngineIdentities.add(identity);
      engineIdentities.add(identity);
      // An absent binding never falls back to item.id, title or branch spelling.
      if (!item.contractUnitId || !ids.has(item.contractUnitId)) continue;
      const own = matches.get(item.contractUnitId) ?? [];
      own.push({ item, workstreamId: workstream.id }); matches.set(item.contractUnitId, own);
    }
  }
  const invalidAttemptParents = new Set<string>();
  const attemptGroupOwners = new Map<string, string>();
  for (const parent of contract.units) {
    const recordedGroups = new Set<string>();
    for (const sibling of parent.attemptUnits ?? []) {
      const found = matches.get(sibling.id);
      const groupId = found?.length === 1 ? found[0]!.item.attemptGroupId : undefined;
      if (groupId) recordedGroups.add(groupId);
    }
    if (recordedGroups.size > 1) invalidAttemptParents.add(parent.id);
    for (const groupId of recordedGroups) {
      const owner = attemptGroupOwners.get(groupId);
      if (owner !== undefined && owner !== parent.id) { invalidAttemptParents.add(parent.id); invalidAttemptParents.add(owner); }
      attemptGroupOwners.set(groupId, parent.id);
    }
  }
  const value: ContractIntegrationInspection = {
    state: 'live', contractId: run.id, isolation: 'worktree',
    units: units.map(unit => {
      const found = matches.get(unit.id) ?? [];
      const parent = unit.attemptOf === undefined ? undefined : contract.units.find(candidate => candidate.id === unit.attemptOf);
      const group = contract.groups.find(candidate => candidate.id === unit.groupId);
      let item: ContractIntegrationItem;
      if (!group?.unitIds.includes(parent?.id ?? unit.id)) item = { state: 'unavailable', reason: 'invalid-join' };
      else if (found.length === 0) item = unit.attemptUnits !== undefined && unit.attemptOf === undefined
        ? { state: 'not-applicable', reason: 'best-of-n-plan' } : { state: 'unavailable', reason: 'missing-item' };
      else if (found.length !== 1 || found[0]!.item.contractId !== run.id || found[0]!.workstreamId !== unit.groupId
        || duplicateEngineIdentities.has(JSON.stringify([found[0]!.workstreamId, found[0]!.item.id]))
        || found[0]!.item.attemptSourceId !== unit.attemptOf || found[0]!.item.attemptIndex !== unit.attemptIndex
        || (parent !== undefined && (invalidAttemptParents.has(parent.id) || !found[0]!.item.attemptGroupId
          || found[0]!.item.attemptTotal !== parent.attemptUnits?.length))
        || (parent === undefined && (found[0]!.item.attemptGroupId !== undefined || found[0]!.item.attemptTotal !== undefined))) {
        item = { state: 'unavailable', reason: 'invalid-join' };
      } else {
        const recorded = found[0]!.item;
        // 'n-a' belongs to shared engine items; it cannot establish a worktree join.
        if (recorded.mergeState === 'n-a') item = { state: 'unavailable', reason: 'invalid-join' };
        else item = { state: 'recorded', itemId: recorded.id, workstreamId: found[0]!.workstreamId,
          integration: recorded.mergeState ?? 'unrecorded',
          ...(recorded.mergeState === 'merged' && recorded.mergeHash !== undefined ? { mergeHash: recorded.mergeHash } : {}),
          ...(recorded.worktreePath === undefined ? {} : { worktreePath: recorded.worktreePath }),
          ...(recorded.worktreeBranch === undefined ? {} : { worktreeBranch: recorded.worktreeBranch }),
          ...(recorded.worktreeKept === undefined ? {} : { worktreeKept: recorded.worktreeKept }),
          ...(recorded.conflictFiles === undefined ? {} : { conflictFiles: [...recorded.conflictFiles] }),
        };
      }
      const check = unit.checks.at(-1);
      return { unitId: unit.id, groupId: unit.groupId, unitStatus: unit.status,
        ...(unit.attemptOf === undefined ? {} : { attemptOf: unit.attemptOf }),
        ...(unit.attemptIndex === undefined ? {} : { attemptIndex: unit.attemptIndex }),
        latestCheck: check ? { id: check.id, at: check.at, trigger: check.trigger, result: check.result } : null,
        item,
      };
    }),
  };
  // Refuse the entire observation rather than silently dropping units or cutting paths.
  return validated(value);
}

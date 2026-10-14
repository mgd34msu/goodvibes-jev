import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { resolveAndValidatePath } from '@goodvibes-jev/engine/sdk/platform/utils';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { assertCurrentToolExecution, ToolInputProjectionError, type ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { MemoryBundle, MemoryRecord, MemoryRegistry } from '@goodvibes-jev/engine/sdk/platform/state';
import type { ShellPathService } from '@/runtime/index.ts';
import { AgentPersonaRegistry } from '../agent/persona-registry.ts';
import { AgentRoutineRegistry } from '../agent/routine-registry.ts';
import { AgentSkillRegistry } from '../agent/skill-registry.ts';
import { MEMORY_CLASSES, MEMORY_REVIEW_STATES, MEMORY_SCOPES, MODES, WRITE_MODES, cloneRecord, deleteDuplicate, domainForCandidate, failure, getRecord, markDuplicateStale, nextGeneratedId, output, readLimit, readMode, readReceiptFile, readString, receiptId, receiptIdFromReceipt, receiptPath, requireConfirmedWrite, resolveCandidate, updateSurvivor, writeReceipt, type AgentLearningConsolidationDomain, type AgentLearningConsolidationToolArgs, type LearningConsolidationReceipt } from './agent-learning-consolidation-core.ts';
import type { LearningCandidate } from './agent-harness-learning-curator.ts';
import { agentResearchSourceOwner } from '../agent/protected-research-report.ts';
import { captureCatalogData, captureCatalogMethods } from './agent-harness-catalog-ranking.ts';
import { createHarnessCatalogInputProjector, protectHarnessCatalogTool } from './agent-harness-catalog-ingress.ts';
function arrayField(snapshot: Record<string, unknown>, key: string): string[] {
  const value = snapshot[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function stringField(snapshot: Record<string, unknown>, key: string): string | undefined {
  const value = snapshot[key];
  return typeof value === 'string' ? value : undefined;
}

function numberField(snapshot: Record<string, unknown>, key: string): number | undefined {
  const value = snapshot[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanField(snapshot: Record<string, unknown>, key: string): boolean | undefined {
  const value = snapshot[key];
  return typeof value === 'boolean' ? value : undefined;
}

function requirementsFromSnapshot(snapshot: Record<string, unknown>): readonly { readonly kind: 'env' | 'command'; readonly name: string; readonly description?: string }[] {
  const value = snapshot.requirements;
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null && !Array.isArray(entry))
    .map((entry) => {
      const kind = entry.kind === 'command' ? 'command' as const : 'env' as const;
      const name = readString(entry.name);
      const description = readString(entry.description);
      return {
        kind,
        name,
        ...(description ? { description } : {}),
      };
    })
    .filter((entry) => entry.name);
}

function requirementNames(snapshot: Record<string, unknown>, kind: 'env' | 'command'): readonly string[] {
  return requirementsFromSnapshot(snapshot)
    .filter((requirement) => requirement.kind === kind)
    .map((requirement) => requirement.name);
}

function localRecordSource(snapshot: Record<string, unknown>): 'user' | 'agent' | 'imported' | 'system' {
  const source = stringField(snapshot, 'source');
  return source === 'agent' || source === 'imported' || source === 'system' ? source : 'user';
}

function memoryScope(snapshot: Record<string, unknown>): 'session' | 'project' | 'team' {
  const scope = stringField(snapshot, 'scope');
  return scope && MEMORY_SCOPES.has(scope) ? scope as 'session' | 'project' | 'team' : 'project';
}

function memoryClass(snapshot: Record<string, unknown>): MemoryRecord['cls'] {
  const cls = stringField(snapshot, 'cls');
  return cls && MEMORY_CLASSES.has(cls) ? cls as MemoryRecord['cls'] : 'fact';
}

function memoryReviewState(snapshot: Record<string, unknown>): MemoryRecord['reviewState'] {
  const reviewState = stringField(snapshot, 'reviewState');
  return reviewState && MEMORY_REVIEW_STATES.has(reviewState) ? reviewState as MemoryRecord['reviewState'] : 'fresh';
}

function memoryRecordFromSnapshot(snapshot: Record<string, unknown>): MemoryRecord {
  const id = stringField(snapshot, 'id');
  const summary = stringField(snapshot, 'summary');
  if (!id || !summary) throw new Error('Delete receipt memory snapshot is missing id or summary.');
  return {
    id,
    scope: memoryScope(snapshot),
    cls: memoryClass(snapshot),
    summary,
    detail: stringField(snapshot, 'detail'),
    tags: arrayField(snapshot, 'tags'),
    provenance: Array.isArray(snapshot.provenance)
      ? snapshot.provenance.filter((entry): entry is MemoryRecord['provenance'][number] => (
        typeof entry === 'object'
        && entry !== null
        && !Array.isArray(entry)
        && ['session', 'turn', 'task', 'event', 'file'].includes(String((entry as Record<string, unknown>).kind))
        && typeof (entry as Record<string, unknown>).ref === 'string'
      ))
      : [],
    reviewState: memoryReviewState(snapshot),
    confidence: numberField(snapshot, 'confidence') ?? 60,
    reviewedAt: numberField(snapshot, 'reviewedAt'),
    reviewedBy: stringField(snapshot, 'reviewedBy'),
    staleReason: stringField(snapshot, 'staleReason'),
    createdAt: numberField(snapshot, 'createdAt') ?? Date.now(),
    updatedAt: numberField(snapshot, 'updatedAt') ?? Date.now(),
  };
}

function restoreReviewState(
  shellPaths: ShellPathService,
  memoryRegistry: MemoryRegistry,
  domain: AgentLearningConsolidationDomain,
  id: string,
  snapshot: Record<string, unknown>,
): void {
  const reviewState = stringField(snapshot, 'reviewState') ?? 'fresh';
  const staleReason = stringField(snapshot, 'staleReason') ?? 'Restored by learning curator rollback.';
  if (domain === 'memory') {
    const confidence = typeof snapshot.confidence === 'number' ? snapshot.confidence : undefined;
    memoryRegistry.review(id, { state: reviewState === 'stale' || reviewState === 'reviewed' || reviewState === 'contradicted' ? reviewState : 'fresh', confidence, staleReason, reviewedBy: 'agent' });
    return;
  }
  if (reviewState === 'reviewed') {
    if (domain === 'persona') AgentPersonaRegistry.fromShellPaths(shellPaths).markReviewed(id);
    else if (domain === 'skill') AgentSkillRegistry.fromShellPaths(shellPaths).markReviewed(id);
    else AgentRoutineRegistry.fromShellPaths(shellPaths).markReviewed(id);
    return;
  }
  if (reviewState === 'stale') {
    if (domain === 'persona') AgentPersonaRegistry.fromShellPaths(shellPaths).markStale(id, staleReason);
    else if (domain === 'skill') AgentSkillRegistry.fromShellPaths(shellPaths).markStale(id, staleReason);
    else AgentRoutineRegistry.fromShellPaths(shellPaths).markStale(id, staleReason);
    return;
  }
  if (domain === 'persona') {
    AgentPersonaRegistry.fromShellPaths(shellPaths).update(id, {
      description: stringField(snapshot, 'description'),
      body: stringField(snapshot, 'body'),
      tags: arrayField(snapshot, 'tags'),
      triggers: arrayField(snapshot, 'triggers'),
      provenance: 'rollback-learning-curator-consolidation',
    });
  } else if (domain === 'skill') {
    AgentSkillRegistry.fromShellPaths(shellPaths).update(id, {
      description: stringField(snapshot, 'description'),
      procedure: stringField(snapshot, 'procedure'),
      tags: arrayField(snapshot, 'tags'),
      triggers: arrayField(snapshot, 'triggers'),
      provenance: 'rollback-learning-curator-consolidation',
    });
  } else {
    AgentRoutineRegistry.fromShellPaths(shellPaths).update(id, {
      description: stringField(snapshot, 'description'),
      steps: stringField(snapshot, 'steps'),
      tags: arrayField(snapshot, 'tags'),
      triggers: arrayField(snapshot, 'triggers'),
      provenance: 'rollback-learning-curator-consolidation',
    });
  }
}

function restoreSurvivor(
  shellPaths: ShellPathService,
  memoryRegistry: MemoryRegistry,
  receipt: LearningConsolidationReceipt,
): Record<string, unknown> {
  const snapshot = receipt.beforeSurvivor;
  if (!snapshot) throw new Error(`Receipt ${receipt.id} has no survivor snapshot.`);
  if (receipt.domain === 'memory') {
    const record = memoryRegistry.update(receipt.survivorId, {
      detail: stringField(snapshot, 'detail') ?? '',
      tags: arrayField(snapshot, 'tags'),
    });
    if (!record) throw new Error(`Unknown Agent-local memory ${receipt.survivorId}`);
    restoreReviewState(shellPaths, memoryRegistry, receipt.domain, receipt.survivorId, snapshot);
    return cloneRecord(memoryRegistry.get(receipt.survivorId));
  }
  updateSurvivor(shellPaths, memoryRegistry, receipt.domain, receipt.survivorId, {
    description: stringField(snapshot, 'description') ?? '',
    tags: arrayField(snapshot, 'tags'),
    triggers: arrayField(snapshot, 'triggers'),
  });
  restoreReviewState(shellPaths, memoryRegistry, receipt.domain, receipt.survivorId, snapshot);
  return cloneRecord(getRecord(shellPaths, memoryRegistry, receipt.domain, receipt.survivorId));
}

function recreateArguments(receipt: LearningConsolidationReceipt, snapshot: Record<string, unknown>): Record<string, unknown> {
  if (receipt.domain === 'memory') {
    return {
      action: 'create',
      scope: memoryScope(snapshot),
      cls: memoryClass(snapshot),
      summary: stringField(snapshot, 'summary') ?? '',
      detail: stringField(snapshot, 'detail') ?? '',
      tags: arrayField(snapshot, 'tags'),
      confidence: numberField(snapshot, 'confidence') ?? 60,
      provenance: `recreated-from-learning-consolidation:${receipt.id}:${stringField(snapshot, 'id') ?? 'unknown'}`,
    };
  }
  if (receipt.domain === 'persona') {
    return {
      domain: 'persona',
      action: 'create',
      name: stringField(snapshot, 'name') ?? '',
      description: stringField(snapshot, 'description') ?? '',
      body: stringField(snapshot, 'body') ?? '',
      tags: arrayField(snapshot, 'tags'),
      triggers: arrayField(snapshot, 'triggers'),
      provenance: stringField(snapshot, 'provenance') ?? `recreated-from-learning-consolidation:${receipt.id}`,
    };
  }
  if (receipt.domain === 'skill') {
    return {
      domain: 'skill',
      action: 'create',
      name: stringField(snapshot, 'name') ?? '',
      description: stringField(snapshot, 'description') ?? '',
      procedure: stringField(snapshot, 'procedure') ?? '',
      tags: arrayField(snapshot, 'tags'),
      triggers: arrayField(snapshot, 'triggers'),
      requiresEnv: requirementNames(snapshot, 'env'),
      requiresCommands: requirementNames(snapshot, 'command'),
      enabled: booleanField(snapshot, 'enabled') === true,
      provenance: stringField(snapshot, 'provenance') ?? `recreated-from-learning-consolidation:${receipt.id}`,
    };
  }
  return {
    domain: 'routine',
    action: 'create',
    name: stringField(snapshot, 'name') ?? '',
    description: stringField(snapshot, 'description') ?? '',
    steps: stringField(snapshot, 'steps') ?? '',
    tags: arrayField(snapshot, 'tags'),
    triggers: arrayField(snapshot, 'triggers'),
    requiresEnv: requirementNames(snapshot, 'env'),
    requiresCommands: requirementNames(snapshot, 'command'),
    enabled: booleanField(snapshot, 'enabled') === true,
    provenance: stringField(snapshot, 'provenance') ?? `recreated-from-learning-consolidation:${receipt.id}`,
  };
}

function currentLocalIds(shellPaths: ShellPathService, memoryRegistry: MemoryRegistry, domain: AgentLearningConsolidationDomain): Set<string> {
  if (domain === 'memory') return new Set(memoryRegistry.getAll().map((record) => record.id));
  if (domain === 'persona') return new Set(AgentPersonaRegistry.fromShellPaths(shellPaths).list().map((record) => record.id));
  if (domain === 'skill') return new Set(AgentSkillRegistry.fromShellPaths(shellPaths).list().map((record) => record.id));
  return new Set(AgentRoutineRegistry.fromShellPaths(shellPaths).list().map((record) => record.id));
}

function currentLocalNames(shellPaths: ShellPathService, domain: AgentLearningConsolidationDomain): Set<string> {
  if (domain === 'memory') return new Set();
  if (domain === 'persona') return new Set(AgentPersonaRegistry.fromShellPaths(shellPaths).list().map((record) => record.name.toLowerCase()));
  if (domain === 'skill') return new Set(AgentSkillRegistry.fromShellPaths(shellPaths).list().map((record) => record.name.toLowerCase()));
  return new Set(AgentRoutineRegistry.fromShellPaths(shellPaths).list().map((record) => record.name.toLowerCase()));
}

function recreateGuidance(
  shellPaths: ShellPathService,
  memoryRegistry: MemoryRegistry,
  receipt: LearningConsolidationReceipt,
): Record<string, unknown> | null {
  if (receipt.phase !== 'delete') return null;
  const occupiedIds = currentLocalIds(shellPaths, memoryRegistry, receipt.domain);
  const occupiedNames = currentLocalNames(shellPaths, receipt.domain);
  const records = receipt.beforeDuplicates.map((snapshot) => {
    const previousId = stringField(snapshot, 'id') ?? '(unknown)';
    const name = stringField(snapshot, 'name') ?? stringField(snapshot, 'summary') ?? previousId;
    const expectedId = receipt.domain === 'memory'
      ? previousId
      : nextGeneratedId(name, occupiedIds, receipt.domain);
    const nameConflict = receipt.domain !== 'memory' && occupiedNames.has(name.toLowerCase());
    const idConflict = occupiedIds.has(previousId);
    const possible = receipt.domain === 'memory'
      ? !idConflict
      : expectedId === previousId && !nameConflict;
    occupiedIds.add(expectedId);
    if (receipt.domain !== 'memory') occupiedNames.add(name.toLowerCase());
    return {
      previousId,
      name,
      expectedId,
      exactId: {
        supported: true,
        possible,
        method: receipt.domain === 'memory'
          ? 'SDK memory bundle import preserves record ids.'
          : 'Agent-local registry ids are deterministic from name when the old generated id and name are still free.',
        reason: possible
          ? 'Exact-id recreation is currently available.'
          : idConflict
            ? `A current ${receipt.domain} record already uses ${previousId}.`
            : nameConflict
              ? `A current ${receipt.domain} record already uses the name ${name}.`
              : `The next generated id would be ${expectedId}, not ${previousId}.`,
      },
      fallbackCreateRoute: receipt.domain === 'memory'
        ? 'memory action:"create"'
        : `agent_local_registry domain:"${receipt.domain}" action:"create"`,
      createArguments: recreateArguments(receipt, snapshot),
    };
  });
  return {
    automaticRollback: false,
    recreateRoute: `agent_learning_consolidation mode:"recreate" receiptId:"${receipt.id}" `,
    policy: 'Delete remains the final phase. Recreate is a separate admitted recovery action and refuses when exact ids are not currently safe.',
    records,
  };
}

function receiptSummary(
  receipt: LearningConsolidationReceipt,
  context?: { readonly shellPaths: ShellPathService; readonly memoryRegistry: MemoryRegistry },
): Record<string, unknown> {
  const deleteRecovery = context ? recreateGuidance(context.shellPaths, context.memoryRegistry, receipt) : null;
  return {
    receiptId: receipt.id,
    createdAt: receipt.createdAt,
    domain: receipt.domain,
    candidateId: receipt.candidateId,
    phase: receipt.phase,
    survivorId: receipt.survivorId,
    duplicateIds: receipt.duplicateIds,
    rollbackRoute: receipt.phase === 'merge' || receipt.phase === 'stale'
      ? `agent_learning_consolidation mode:"rollback" receiptId:"${receipt.id}" `
      : null,
    recreateRoute: receipt.phase === 'delete'
      ? `agent_learning_consolidation mode:"recreate" receiptId:"${receipt.id}" `
      : null,
    ...(deleteRecovery ? { deleteRecovery } : {}),
  };
}

function previewCandidate(candidate: LearningCandidate): Record<string, unknown> {
  const plan = candidate.consolidation;
  if (!plan) throw new Error(`Candidate ${candidate.id} is not a duplicate consolidation candidate.`);
  return {
    status: 'preview',
    candidateId: candidate.id,
    judgmentDecisionIds: candidate.judgmentDecisionIds,
    label: candidate.label,
    domain: candidate.domain,
    survivorId: plan.survivorId,
    duplicateIds: plan.duplicateIds,
    diffFields: plan.diffs.map((diff) => diff.field),
    diffs: plan.diffs,
    updateFields: plan.updateFields ?? null,
    phases: [
      {
        id: 'merge',
        route: `agent_learning_consolidation mode:"merge" candidateId:"${candidate.id}" `,
        effect: 'Update the survivor with merged visible fields and write a rollback receipt.',
      },
      {
        id: 'stale',
        route: `agent_learning_consolidation mode:"stale" candidateId:"${candidate.id}" `,
        effect: 'Mark duplicates stale before deletion and write a rollback receipt.',
      },
      {
        id: 'delete',
        route: `agent_learning_consolidation mode:"delete" candidateId:"${candidate.id}" `,
        effect: 'Delete only duplicates that are already stale. Exact-id rollback is not automatic after delete.',
      },
    ],
    inspectRoute: `memory action:"candidate" candidateId:"${candidate.id}"`,
    policy: 'Preview is read-only. Every mutation requires current recorded effect admission.',
  };
}

function applyMerge(
  shellPaths: ShellPathService,
  memoryRegistry: MemoryRegistry,
  candidate: LearningCandidate,
  explicitUserRequest: string,
  beforeWrite: () => void,
): Record<string, unknown> {
  const domain = domainForCandidate(candidate);
  const plan = candidate.consolidation;
  if (!plan?.updateFields) throw new Error(`Candidate ${candidate.id} has no survivor merge fields.`);
  const beforeSurvivor = cloneRecord(getRecord(shellPaths, memoryRegistry, domain, plan.survivorId));
  beforeWrite();
  const afterSurvivor = updateSurvivor(shellPaths, memoryRegistry, domain, plan.survivorId, plan.updateFields);
  const receipt: LearningConsolidationReceipt = {
    id: receiptId(candidate, 'merge'),
    createdAt: new Date().toISOString(),
    domain,
    candidateId: candidate.id,
    phase: 'merge',
    explicitUserRequest,
    survivorId: plan.survivorId,
    duplicateIds: plan.duplicateIds,
    beforeSurvivor,
    beforeDuplicates: [],
  };
  beforeWrite();
  writeReceipt(shellPaths, receipt);
  return {
    status: 'applied',
    phase: 'merge',
    candidateId: candidate.id,
    judgmentDecisionIds: candidate.judgmentDecisionIds,
    survivorId: plan.survivorId,
    receipt: receiptSummary(receipt),
    afterSurvivor,
    next: 'Inspect the survivor, then run the stale phase only if the merged fields are correct.',
  };
}

function applyStale(
  shellPaths: ShellPathService,
  memoryRegistry: MemoryRegistry,
  candidate: LearningCandidate,
  explicitUserRequest: string,
  beforeWrite: () => void,
): Record<string, unknown> {
  const domain = domainForCandidate(candidate);
  const plan = candidate.consolidation;
  if (!plan) throw new Error(`Candidate ${candidate.id} is not a duplicate consolidation candidate.`);
  const beforeDuplicates = plan.duplicateIds.map((id) => cloneRecord(getRecord(shellPaths, memoryRegistry, domain, id)));
  const afterDuplicates = plan.duplicateIds.map((id) => { beforeWrite(); return markDuplicateStale(shellPaths, memoryRegistry, domain, id, plan.survivorId); });
  const receipt: LearningConsolidationReceipt = {
    id: receiptId(candidate, 'stale'),
    createdAt: new Date().toISOString(),
    domain,
    candidateId: candidate.id,
    phase: 'stale',
    explicitUserRequest,
    survivorId: plan.survivorId,
    duplicateIds: plan.duplicateIds,
    beforeDuplicates,
  };
  beforeWrite();
  writeReceipt(shellPaths, receipt);
  return {
    status: 'applied',
    phase: 'stale',
    candidateId: candidate.id,
    judgmentDecisionIds: candidate.judgmentDecisionIds,
    survivorId: plan.survivorId,
    duplicateIds: plan.duplicateIds,
    receipt: receiptSummary(receipt),
    afterDuplicates,
    next: 'Re-run the curator and delete only after current recorded effect admission approves deleting the stale duplicates.',
  };
}

function applyDelete(
  shellPaths: ShellPathService,
  memoryRegistry: MemoryRegistry,
  candidate: LearningCandidate,
  explicitUserRequest: string,
  beforeWrite: () => void,
): Record<string, unknown> {
  const domain = domainForCandidate(candidate);
  const plan = candidate.consolidation;
  if (!plan) throw new Error(`Candidate ${candidate.id} is not a duplicate consolidation candidate.`);
  const beforeDuplicates = plan.duplicateIds.map((id) => cloneRecord(getRecord(shellPaths, memoryRegistry, domain, id)));
  const unstaled = beforeDuplicates.filter((record) => record.reviewState !== 'stale').map((record) => String(record.id ?? '(unknown)'));
  if (unstaled.length > 0) {
    throw new Error(`Delete refused. Stage duplicates stale first: ${unstaled.join(', ')}.`);
  }
  if (domain === 'skill') {
    const bundles = AgentSkillRegistry.fromShellPaths(shellPaths).snapshot().bundles;
    const references = plan.duplicateIds.flatMap((duplicateId) => (
      bundles
        .filter((bundle) => bundle.skillIds.includes(duplicateId))
        .map((bundle) => `${duplicateId} in ${bundle.id}`)
    ));
    if (references.length > 0) {
      throw new Error(`Delete refused. Duplicate skill records are still referenced by bundles: ${references.join(', ')}. Inspect or update bundles before deleting.`);
    }
  }
  for (const id of plan.duplicateIds) { beforeWrite(); deleteDuplicate(shellPaths, memoryRegistry, domain, id); }
  const receipt: LearningConsolidationReceipt = {
    id: receiptId(candidate, 'delete'),
    createdAt: new Date().toISOString(),
    domain,
    candidateId: candidate.id,
    judgmentDecisionIds: candidate.judgmentDecisionIds,
    phase: 'delete',
    explicitUserRequest,
    survivorId: plan.survivorId,
    duplicateIds: plan.duplicateIds,
    beforeDuplicates,
  };
  beforeWrite();
  writeReceipt(shellPaths, receipt);
  return {
    status: 'applied',
    phase: 'delete',
    candidateId: candidate.id,
    judgmentDecisionIds: candidate.judgmentDecisionIds,
    survivorId: plan.survivorId,
    deletedDuplicateIds: plan.duplicateIds,
    receipt: receiptSummary(receipt, { shellPaths, memoryRegistry }),
    recreateGuidance: recreateGuidance(shellPaths, memoryRegistry, receipt),
    next: 'Deletion is intentionally last. The receipt stores deleted record snapshots and exposes a separate admitted recreate route when exact ids are still safe.',
  };
}

async function applyRecreate(
  shellPaths: ShellPathService,
  memoryRegistry: MemoryRegistry,
  args: AgentLearningConsolidationToolArgs,
  explicitUserRequest: string,
  beforeWrite: () => void,
): Promise<Record<string, unknown>> {
  const deleteReceipt = findDeleteReceipt(shellPaths, args);
  if (deleteReceipt.phase !== 'delete') {
    throw new Error(`Recreate requires a delete receipt. Receipt ${deleteReceipt.id} is phase ${deleteReceipt.phase}.`);
  }
  const guidance = recreateGuidance(shellPaths, memoryRegistry, deleteReceipt) as {
    readonly records?: readonly {
      readonly previousId?: string;
      readonly expectedId?: string;
      readonly exactId?: { readonly possible?: boolean; readonly reason?: string };
    }[];
  } | null;
  const records = guidance?.records ?? [];
  const unsafe = records.filter((record) => record.exactId?.possible !== true);
  if (unsafe.length > 0) {
    throw new Error(`Exact-id recreate refused. ${unsafe.map((record) => `${record.previousId ?? '(unknown)'}: ${record.exactId?.reason ?? 'not currently safe'}`).join('; ')}`);
  }

  if (deleteReceipt.domain === 'memory') {
    const memoryRecords = deleteReceipt.beforeDuplicates.map(memoryRecordFromSnapshot);
    const conflicts = memoryRecords.filter((record) => memoryRegistry.get(record.id)).map((record) => record.id);
    if (conflicts.length > 0) throw new Error(`Exact-id recreate refused. Current memory records already use: ${conflicts.join(', ')}.`);
    const bundle: MemoryBundle = {
      schemaVersion: 'v1',
      exportedAt: Date.now(),
      scope: 'all',
      recordCount: memoryRecords.length,
      linkCount: 0,
      records: memoryRecords,
      links: [],
    };
    beforeWrite();
    const importResult = await memoryRegistry.importBundle(bundle);
    beforeWrite();
    const receipt: LearningConsolidationReceipt = {
      id: receiptIdFromReceipt(deleteReceipt, 'recreate'),
      createdAt: new Date().toISOString(),
      domain: deleteReceipt.domain,
      candidateId: deleteReceipt.candidateId,
      judgmentDecisionIds: deleteReceipt.judgmentDecisionIds,
      phase: 'recreate',
      explicitUserRequest,
      survivorId: deleteReceipt.survivorId,
      duplicateIds: deleteReceipt.duplicateIds,
      beforeDuplicates: deleteReceipt.beforeDuplicates,
    };
    beforeWrite();
  writeReceipt(shellPaths, receipt);
    return {
      status: 'applied',
      phase: 'recreate',
      recreatedFromReceiptId: deleteReceipt.id,
      recreatedIds: memoryRecords.map((record) => record.id),
      exactIdsPreserved: importResult.importedRecords === memoryRecords.length,
      importResult,
      receipt: receiptSummary(receipt, { shellPaths, memoryRegistry }),
      next: 'Inspect recreated memory records, then re-run the learning curator before applying another consolidation phase.',
    };
  }

  const recreated: Record<string, unknown>[] = [];
  for (const snapshot of deleteReceipt.beforeDuplicates) {
    const previousId = stringField(snapshot, 'id');
    if (!previousId) throw new Error('Delete receipt snapshot is missing id.');
    if (deleteReceipt.domain === 'persona') {
      const registry = AgentPersonaRegistry.fromShellPaths(shellPaths);
      beforeWrite();
      const created = registry.create({
        name: stringField(snapshot, 'name') ?? '',
        description: stringField(snapshot, 'description') ?? '',
        body: stringField(snapshot, 'body') ?? '',
        tags: arrayField(snapshot, 'tags'),
        triggers: arrayField(snapshot, 'triggers'),
        source: localRecordSource(snapshot),
        provenance: stringField(snapshot, 'provenance') ?? `recreated-from-learning-consolidation:${deleteReceipt.id}`,
      });
      if (created.id !== previousId) throw new Error(`Exact-id recreate failed for ${previousId}; created ${created.id}.`);
      if (stringField(snapshot, 'reviewState') !== 'fresh') { beforeWrite(); restoreReviewState(shellPaths, memoryRegistry, deleteReceipt.domain, created.id, snapshot); }
      recreated.push(cloneRecord(getRecord(shellPaths, memoryRegistry, deleteReceipt.domain, created.id)));
    } else if (deleteReceipt.domain === 'skill') {
      const registry = AgentSkillRegistry.fromShellPaths(shellPaths);
      beforeWrite();
      const created = registry.create({
        name: stringField(snapshot, 'name') ?? '',
        description: stringField(snapshot, 'description') ?? '',
        procedure: stringField(snapshot, 'procedure') ?? '',
        tags: arrayField(snapshot, 'tags'),
        triggers: arrayField(snapshot, 'triggers'),
        requirements: requirementsFromSnapshot(snapshot),
        enabled: booleanField(snapshot, 'enabled') === true,
        source: localRecordSource(snapshot),
        provenance: stringField(snapshot, 'provenance') ?? `recreated-from-learning-consolidation:${deleteReceipt.id}`,
      });
      if (created.id !== previousId) throw new Error(`Exact-id recreate failed for ${previousId}; created ${created.id}.`);
      if (stringField(snapshot, 'reviewState') !== 'fresh') { beforeWrite(); restoreReviewState(shellPaths, memoryRegistry, deleteReceipt.domain, created.id, snapshot); }
      recreated.push(cloneRecord(getRecord(shellPaths, memoryRegistry, deleteReceipt.domain, created.id)));
    } else {
      const registry = AgentRoutineRegistry.fromShellPaths(shellPaths);
      beforeWrite();
      const created = registry.create({
        name: stringField(snapshot, 'name') ?? '',
        description: stringField(snapshot, 'description') ?? '',
        steps: stringField(snapshot, 'steps') ?? '',
        tags: arrayField(snapshot, 'tags'),
        triggers: arrayField(snapshot, 'triggers'),
        requirements: requirementsFromSnapshot(snapshot),
        enabled: booleanField(snapshot, 'enabled') === true,
        source: localRecordSource(snapshot),
        provenance: stringField(snapshot, 'provenance') ?? `recreated-from-learning-consolidation:${deleteReceipt.id}`,
      });
      if (created.id !== previousId) throw new Error(`Exact-id recreate failed for ${previousId}; created ${created.id}.`);
      if (stringField(snapshot, 'reviewState') !== 'fresh') { beforeWrite(); restoreReviewState(shellPaths, memoryRegistry, deleteReceipt.domain, created.id, snapshot); }
      recreated.push(cloneRecord(getRecord(shellPaths, memoryRegistry, deleteReceipt.domain, created.id)));
    }
  }

  const receipt: LearningConsolidationReceipt = {
    id: receiptIdFromReceipt(deleteReceipt, 'recreate'),
    createdAt: new Date().toISOString(),
    domain: deleteReceipt.domain,
    candidateId: deleteReceipt.candidateId,
      judgmentDecisionIds: deleteReceipt.judgmentDecisionIds,
    phase: 'recreate',
    explicitUserRequest,
    survivorId: deleteReceipt.survivorId,
    duplicateIds: deleteReceipt.duplicateIds,
    beforeDuplicates: deleteReceipt.beforeDuplicates,
  };
  beforeWrite();
  writeReceipt(shellPaths, receipt);
  return {
    status: 'applied',
    phase: 'recreate',
    recreatedFromReceiptId: deleteReceipt.id,
    recreatedIds: recreated.map((record) => stringField(record, 'id')).filter(Boolean),
    exactIdsPreserved: true,
    recreatedRecords: recreated,
    receipt: receiptSummary(receipt, { shellPaths, memoryRegistry }),
    next: 'Inspect recreated records, then re-run the learning curator before applying another consolidation phase.',
  };
}

function findReceipt(shellPaths: ShellPathService, args: AgentLearningConsolidationToolArgs): LearningConsolidationReceipt {
  const receiptIdArg = readString(args.receiptId);
  const candidateId = readString(args.candidateId);
  const receipts = readReceiptFile(shellPaths).receipts;
  const receipt = receiptIdArg
    ? receipts.find((entry) => entry.id === receiptIdArg)
    : receipts.find((entry) => entry.candidateId === candidateId && entry.phase !== 'delete' && entry.phase !== 'recreate');
  if (!receipt) throw new Error(receiptIdArg ? `Unknown learning consolidation receipt ${receiptIdArg}` : 'rollback requires receiptId or candidateId with a non-delete receipt.');
  return receipt;
}

function findDeleteReceipt(shellPaths: ShellPathService, args: AgentLearningConsolidationToolArgs): LearningConsolidationReceipt {
  const receiptIdArg = readString(args.receiptId);
  const candidateId = readString(args.candidateId);
  const receipts = readReceiptFile(shellPaths).receipts;
  const receipt = receiptIdArg
    ? receipts.find((entry) => entry.id === receiptIdArg)
    : receipts.find((entry) => entry.candidateId === candidateId && entry.phase === 'delete');
  if (!receipt) throw new Error(receiptIdArg ? `Unknown learning consolidation receipt ${receiptIdArg}` : 'recreate requires receiptId or candidateId with a delete receipt.');
  return receipt;
}

function applyRollback(
  shellPaths: ShellPathService,
  memoryRegistry: MemoryRegistry,
  args: AgentLearningConsolidationToolArgs,
  beforeWrite: () => void,
): Record<string, unknown> {
  const receipt = findReceipt(shellPaths, args);
  if (receipt.phase === 'delete') {
    throw new Error(`Receipt ${receipt.id} is from a delete phase. Automatic rollback is unavailable after delete; use agent_learning_consolidation mode:"recreate" receiptId:"${receipt.id}"  to recreate deleted records only when the user asks and exact ids are still safe.`);
  }
  if (receipt.phase === 'merge') {
    beforeWrite();
    return {
      status: 'applied',
      phase: 'rollback',
      rollbackOf: receiptSummary(receipt),
      restoredSurvivor: restoreSurvivor(shellPaths, memoryRegistry, receipt),
      next: 'Re-run the learning curator and inspect the candidate before applying another consolidation phase.',
    };
  }
  for (const snapshot of receipt.beforeDuplicates) {
    const id = stringField(snapshot, 'id');
    if (!id) continue;
    beforeWrite();
    restoreReviewState(shellPaths, memoryRegistry, receipt.domain, id, snapshot);
  }
  return {
    status: 'applied',
    phase: 'rollback',
    rollbackOf: receiptSummary(receipt),
    restoredDuplicateIds: receipt.beforeDuplicates.map((snapshot) => stringField(snapshot, 'id')).filter(Boolean),
    next: 'Re-run the learning curator and inspect the candidate before applying another consolidation phase.',
  };
}

function isConsolidationCandidateCall(args: Record<string, unknown>): boolean {
  const mode = readMode(captureCatalogData(args).mode);
  return mode === 'preview' || mode === 'merge' || mode === 'stale' || mode === 'delete';
}

export function createAgentLearningConsolidationTool(shellPaths: ShellPathService, memoryRegistry: MemoryRegistry, registry?: ToolRegistry): Tool {
  const tool: Tool = {
    definition: {
      name: 'agent_learning_consolidation',
      description: 'Manage admitted local duplicate learning phases.',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: [...MODES],
            description: 'preview, merge, stale, delete, rollback, recreate, or receipts.',
          },
          candidateId: {
            type: 'string',
            description: 'Learning curator duplicate-consolidation candidate id.',
          },
          query: {
            type: 'string',
            description: 'Candidate search text when candidateId is unknown.',
          },
          receiptId: {
            type: 'string',
            description: 'Receipt id for rollback.',
          },
          limit: {
            type: 'number',
            description: 'Receipt list limit.',
          },
          confirm: {
            type: 'boolean',
            description: 'Legacy caller annotation; it grants no effect authority.',
          },
          explicitUserRequest: {
            type: 'string',
            description: 'Optional audit text for the phase; current recorded effect admission supplies authority.',
          },
        },
        required: ['mode'],
        additionalProperties: false,
      },
      sideEffects: ['state'],
    },
    execute: async (rawArgs, options) => {
      const args = captureCatalogData(rawArgs);
      const originalJson = JSON.stringify(args);
      const signal = options?.signal;
      const sourceOwner = agentResearchSourceOwner(registry);
      const assertPathMethods = captureCatalogMethods(shellPaths, ['workingDirectory', 'homeDirectory', 'resolveUserPath']);
      const assertMemoryMethods = captureCatalogMethods(memoryRegistry, ['getStore', 'get', 'update', 'review', 'delete', 'importBundle']);
      const workingDirectory = shellPaths.workingDirectory;
      const homeDirectory = shellPaths.homeDirectory;
      const homeReal = realpathSync(homeDirectory);
      const resolveUserPath = shellPaths.resolveUserPath;
      const store = memoryRegistry.getStore();
      const databasePath = store.dbPath;
      const storagePaths = [receiptPath(shellPaths),
        shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'skills', 'skills.json'),
        shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'personas', 'personas.json'),
        shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'routines', 'routines.json'),
        ...(databasePath ? [databasePath] : [])];
      const assertStorageCurrent = () => {
        assertPathMethods(); assertMemoryMethods();
        if (shellPaths.homeDirectory !== homeDirectory || shellPaths.resolveUserPath !== resolveUserPath
          || realpathSync(homeDirectory) !== homeReal || memoryRegistry.getStore() !== store || store.dbPath !== databasePath) throw new ToolInputProjectionError('stale');
        for (const path of storagePaths) {
          const target = resolveAndValidatePath(path, homeDirectory);
          const parts = relative(homeReal, target).split(sep);
          let component = homeReal;
          for (const part of parts) {
            component = join(component, part);
            if (lstatSync(component, { throwIfNoEntry: false })?.isSymbolicLink()) throw new ToolInputProjectionError('held');
          }
        }
      };
      const assertAuthorityCurrent = () => {
        signal?.throwIfAborted(); assertCurrentToolExecution(rawArgs, options); assertStorageCurrent();
        if (options?.signal !== signal || agentResearchSourceOwner(registry) !== sourceOwner
          || shellPaths.workingDirectory !== workingDirectory || JSON.stringify(captureCatalogData(rawArgs)) !== originalJson) throw new ToolInputProjectionError('stale');
      };
      try {
        assertAuthorityCurrent();
        const mode = readMode(args.mode);
        const receiptSource = () => lstatSync(receiptPath(shellPaths), { throwIfNoEntry: false }) ? readFileSync(receiptPath(shellPaths), 'utf8') : null;
        const receiptsJson = receiptSource();
        const assertReceiptsCurrent = () => {
          if (receiptSource() !== receiptsJson) throw new ToolInputProjectionError('stale');
        };
        const beforeWrite = () => {
          assertAuthorityCurrent(); assertReceiptsCurrent();
          if (mode !== 'merge' && mode !== 'stale' && mode !== 'delete' && mode !== 'rollback' && mode !== 'recreate') throw new ToolInputProjectionError('held');
          requireConfirmedWrite(rawArgs, mode, options);
        };
        if (mode === 'receipts') {
          // `total` and the note exist because the default page is 20 and the
          // receipt file holds far more: without them, "here are the receipts"
          // reads as the whole rollback history when it is the newest slice.
          const stored = readReceiptFile(shellPaths).receipts;
          const page = stored.slice(0, readLimit(args.limit, 20));
          return output({
            status: 'receipts',
            path: receiptPath(shellPaths),
            receipts: page.map((receipt) => receiptSummary(receipt, { shellPaths, memoryRegistry })),
            returned: page.length,
            total: stored.length,
            ...(page.length < stored.length
              ? { note: `Showing the ${page.length} newest of ${stored.length} receipts; raise limit to see older ones.` }
              : {}),
          });
        }
        if (mode === 'rollback') {
          requireConfirmedWrite(rawArgs, mode, options);
          return output(applyRollback(shellPaths, memoryRegistry, args, beforeWrite));
        }
        if (mode === 'recreate') {
          const explicitUserRequest = requireConfirmedWrite(rawArgs, mode, options);
          return output(await applyRecreate(shellPaths, memoryRegistry, args, explicitUserRequest, beforeWrite));
        }
        const candidateGuards = new Map<string | (() => void), () => void>();
        const candidate = await resolveCandidate(shellPaths, memoryRegistry, args, {
          signal, sourceOwner, assertCurrent: () => { assertAuthorityCurrent(); assertReceiptsCurrent(); },
          retainCurrent(guard, key) { if (!candidateGuards.has(key ?? guard)) candidateGuards.set(key ?? guard, guard); },
        });
        assertAuthorityCurrent(); assertReceiptsCurrent();
        // Check the complete retained source immediately before the phase.
        // The authorized phase itself changes that collection, so publication
        // continues to check authority rather than the pre-write revision.
        for (const guard of candidateGuards.values()) guard();
        if (mode === 'preview') return output(previewCandidate(candidate));
        if (!WRITE_MODES.has(mode)) return failure(`Unknown mode. Valid values ${MODES.join(', ')}.`);
        if (mode !== 'merge' && mode !== 'stale' && mode !== 'delete') throw new ToolInputProjectionError('held');
        const explicitUserRequest = requireConfirmedWrite(rawArgs, mode, options);
        if (mode === 'merge') return output(applyMerge(shellPaths, memoryRegistry, candidate, explicitUserRequest, beforeWrite));
        if (mode === 'stale') return output(applyStale(shellPaths, memoryRegistry, candidate, explicitUserRequest, beforeWrite));
        return output(applyDelete(shellPaths, memoryRegistry, candidate, explicitUserRequest, beforeWrite));
      } catch (error) {
        assertAuthorityCurrent();
        if (error instanceof ToolInputProjectionError) throw error;
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
  };
  return registry ? protectHarnessCatalogTool(tool, registry, isConsolidationCandidateCall) : tool;
}

export function registerAgentLearningConsolidationTool(
  registry: ToolRegistry,
  shellPaths: ShellPathService,
  memoryRegistry: MemoryRegistry,
): void {
  registry.register(createAgentLearningConsolidationTool(shellPaths, memoryRegistry, registry), { inputProjection: createHarnessCatalogInputProjector(registry, undefined, isConsolidationCandidateCall) });
}

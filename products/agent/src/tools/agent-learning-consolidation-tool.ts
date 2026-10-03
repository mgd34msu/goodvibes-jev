import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { MemoryBundle, MemoryRecord, MemoryRegistry } from '@goodvibes-jev/engine/sdk/platform/state';
import type { ShellPathService } from '@/runtime/index.ts';
import { AgentPersonaRegistry } from '../agent/persona-registry.ts';
import { AgentRoutineRegistry } from '../agent/routine-registry.ts';
import { AgentSkillRegistry } from '../agent/skill-registry.ts';
import { MEMORY_CLASSES, MEMORY_REVIEW_STATES, MEMORY_SCOPES, MODES, WRITE_MODES, cloneRecord, deleteDuplicate, domainForCandidate, failure, getRecord, markDuplicateStale, nextGeneratedId, output, readLimit, readMode, readReceiptFile, readString, receiptId, receiptIdFromReceipt, receiptPath, requireConfirmedWrite, resolveCandidate, updateSurvivor, writeReceipt, type AgentLearningConsolidationDomain, type AgentLearningConsolidationToolArgs, type LearningConsolidationReceipt } from './agent-learning-consolidation-core.ts';
import type { LearningCandidate } from './agent-harness-learning-curator.ts';
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
    recreateRoute: `agent_learning_consolidation mode:"recreate" receiptId:"${receipt.id}" confirm:true explicitUserRequest:"..."`,
    policy: 'Delete remains the final phase. Recreate is a separate confirmed recovery action and refuses when exact ids are not currently safe.',
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
      ? `agent_learning_consolidation mode:"rollback" receiptId:"${receipt.id}" confirm:true explicitUserRequest:"..."`
      : null,
    recreateRoute: receipt.phase === 'delete'
      ? `agent_learning_consolidation mode:"recreate" receiptId:"${receipt.id}" confirm:true explicitUserRequest:"..."`
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
        route: `agent_learning_consolidation mode:"merge" candidateId:"${candidate.id}" confirm:true explicitUserRequest:"..."`,
        effect: 'Update the survivor with merged visible fields and write a rollback receipt.',
      },
      {
        id: 'stale',
        route: `agent_learning_consolidation mode:"stale" candidateId:"${candidate.id}" confirm:true explicitUserRequest:"..."`,
        effect: 'Mark duplicates stale before deletion and write a rollback receipt.',
      },
      {
        id: 'delete',
        route: `agent_learning_consolidation mode:"delete" candidateId:"${candidate.id}" confirm:true explicitUserRequest:"..."`,
        effect: 'Delete only duplicates that are already stale. Exact-id rollback is not automatic after delete.',
      },
    ],
    inspectRoute: `memory action:"candidate" candidateId:"${candidate.id}"`,
    policy: 'Preview is read-only. Merge, stale, delete, and rollback each require confirm:true plus explicitUserRequest.',
  };
}

function applyMerge(
  shellPaths: ShellPathService,
  memoryRegistry: MemoryRegistry,
  candidate: LearningCandidate,
  explicitUserRequest: string,
): Record<string, unknown> {
  const domain = domainForCandidate(candidate);
  const plan = candidate.consolidation;
  if (!plan?.updateFields) throw new Error(`Candidate ${candidate.id} has no survivor merge fields.`);
  const beforeSurvivor = cloneRecord(getRecord(shellPaths, memoryRegistry, domain, plan.survivorId));
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
  writeReceipt(shellPaths, receipt);
  return {
    status: 'applied',
    phase: 'merge',
    candidateId: candidate.id,
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
): Record<string, unknown> {
  const domain = domainForCandidate(candidate);
  const plan = candidate.consolidation;
  if (!plan) throw new Error(`Candidate ${candidate.id} is not a duplicate consolidation candidate.`);
  const beforeDuplicates = plan.duplicateIds.map((id) => cloneRecord(getRecord(shellPaths, memoryRegistry, domain, id)));
  const afterDuplicates = plan.duplicateIds.map((id) => markDuplicateStale(shellPaths, memoryRegistry, domain, id, plan.survivorId));
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
  writeReceipt(shellPaths, receipt);
  return {
    status: 'applied',
    phase: 'stale',
    candidateId: candidate.id,
    survivorId: plan.survivorId,
    duplicateIds: plan.duplicateIds,
    receipt: receiptSummary(receipt),
    afterDuplicates,
    next: 'Re-run the curator and delete only if the user confirms the stale duplicates are no longer needed.',
  };
}

function applyDelete(
  shellPaths: ShellPathService,
  memoryRegistry: MemoryRegistry,
  candidate: LearningCandidate,
  explicitUserRequest: string,
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
  for (const id of plan.duplicateIds) deleteDuplicate(shellPaths, memoryRegistry, domain, id);
  const receipt: LearningConsolidationReceipt = {
    id: receiptId(candidate, 'delete'),
    createdAt: new Date().toISOString(),
    domain,
    candidateId: candidate.id,
    phase: 'delete',
    explicitUserRequest,
    survivorId: plan.survivorId,
    duplicateIds: plan.duplicateIds,
    beforeDuplicates,
  };
  writeReceipt(shellPaths, receipt);
  return {
    status: 'applied',
    phase: 'delete',
    candidateId: candidate.id,
    survivorId: plan.survivorId,
    deletedDuplicateIds: plan.duplicateIds,
    receipt: receiptSummary(receipt, { shellPaths, memoryRegistry }),
    recreateGuidance: recreateGuidance(shellPaths, memoryRegistry, receipt),
    next: 'Deletion is intentionally last. The receipt stores deleted record snapshots and exposes a separate confirmed recreate route when exact ids are still safe.',
  };
}

async function applyRecreate(
  shellPaths: ShellPathService,
  memoryRegistry: MemoryRegistry,
  args: AgentLearningConsolidationToolArgs,
  explicitUserRequest: string,
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
    const importResult = await memoryRegistry.importBundle(bundle);
    const receipt: LearningConsolidationReceipt = {
      id: receiptIdFromReceipt(deleteReceipt, 'recreate'),
      createdAt: new Date().toISOString(),
      domain: deleteReceipt.domain,
      candidateId: deleteReceipt.candidateId,
      phase: 'recreate',
      explicitUserRequest,
      survivorId: deleteReceipt.survivorId,
      duplicateIds: deleteReceipt.duplicateIds,
      beforeDuplicates: deleteReceipt.beforeDuplicates,
    };
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
      if (stringField(snapshot, 'reviewState') !== 'fresh') restoreReviewState(shellPaths, memoryRegistry, deleteReceipt.domain, created.id, snapshot);
      recreated.push(cloneRecord(getRecord(shellPaths, memoryRegistry, deleteReceipt.domain, created.id)));
    } else if (deleteReceipt.domain === 'skill') {
      const registry = AgentSkillRegistry.fromShellPaths(shellPaths);
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
      if (stringField(snapshot, 'reviewState') !== 'fresh') restoreReviewState(shellPaths, memoryRegistry, deleteReceipt.domain, created.id, snapshot);
      recreated.push(cloneRecord(getRecord(shellPaths, memoryRegistry, deleteReceipt.domain, created.id)));
    } else {
      const registry = AgentRoutineRegistry.fromShellPaths(shellPaths);
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
      if (stringField(snapshot, 'reviewState') !== 'fresh') restoreReviewState(shellPaths, memoryRegistry, deleteReceipt.domain, created.id, snapshot);
      recreated.push(cloneRecord(getRecord(shellPaths, memoryRegistry, deleteReceipt.domain, created.id)));
    }
  }

  const receipt: LearningConsolidationReceipt = {
    id: receiptIdFromReceipt(deleteReceipt, 'recreate'),
    createdAt: new Date().toISOString(),
    domain: deleteReceipt.domain,
    candidateId: deleteReceipt.candidateId,
    phase: 'recreate',
    explicitUserRequest,
    survivorId: deleteReceipt.survivorId,
    duplicateIds: deleteReceipt.duplicateIds,
    beforeDuplicates: deleteReceipt.beforeDuplicates,
  };
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
): Record<string, unknown> {
  const receipt = findReceipt(shellPaths, args);
  if (receipt.phase === 'delete') {
    throw new Error(`Receipt ${receipt.id} is from a delete phase. Automatic rollback is unavailable after delete; use agent_learning_consolidation mode:"recreate" receiptId:"${receipt.id}" confirm:true explicitUserRequest:"..." to recreate deleted records only when the user asks and exact ids are still safe.`);
  }
  if (receipt.phase === 'merge') {
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

export function createAgentLearningConsolidationTool(shellPaths: ShellPathService, memoryRegistry: MemoryRegistry): Tool {
  return {
    definition: {
      name: 'agent_learning_consolidation',
      description: 'Manage confirmed local duplicate learning phases.',
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
            description: 'Required true for merge, stale, delete, and rollback.',
          },
          explicitUserRequest: {
            type: 'string',
            description: 'Exact user request or faithful short summary authorizing the phase.',
          },
        },
        required: ['mode'],
        additionalProperties: false,
      },
      sideEffects: ['state'],
    },
    execute: async (rawArgs: unknown) => {
      try {
        const args = rawArgs as AgentLearningConsolidationToolArgs;
        const mode = readMode(args.mode);
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
          requireConfirmedWrite(args, mode);
          return output(applyRollback(shellPaths, memoryRegistry, args));
        }
        if (mode === 'recreate') {
          const explicitUserRequest = requireConfirmedWrite(args, mode);
          return output(await applyRecreate(shellPaths, memoryRegistry, args, explicitUserRequest));
        }
        const candidate = resolveCandidate(shellPaths, memoryRegistry, args);
        if (mode === 'preview') return output(previewCandidate(candidate));
        if (!WRITE_MODES.has(mode)) return failure(`Unknown mode. Valid values ${MODES.join(', ')}.`);
        const explicitUserRequest = requireConfirmedWrite(args, mode);
        if (mode === 'merge') return output(applyMerge(shellPaths, memoryRegistry, candidate, explicitUserRequest));
        if (mode === 'stale') return output(applyStale(shellPaths, memoryRegistry, candidate, explicitUserRequest));
        return output(applyDelete(shellPaths, memoryRegistry, candidate, explicitUserRequest));
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export function registerAgentLearningConsolidationTool(
  registry: ToolRegistry,
  shellPaths: ShellPathService,
  memoryRegistry: MemoryRegistry,
): void {
  registry.register(createAgentLearningConsolidationTool(shellPaths, memoryRegistry));
}

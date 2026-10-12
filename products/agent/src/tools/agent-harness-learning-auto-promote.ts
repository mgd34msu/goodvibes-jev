import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { types as nodeTypes } from 'node:util';
import { prepareMemoryApiAdd } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import type { MemoryApi } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import type { ShellPathService } from '@/runtime/index.ts';
import { AgentPersonaRegistry } from '../agent/persona-registry.ts';
import { AgentRoutineRegistry } from '../agent/routine-registry.ts';
import { AgentSkillRegistry } from '../agent/skill-registry.ts';
import { runSkillDraftProposer, assertSkillDraftRunResultCurrent, type SkillDraftRunResult } from '../agent/skill-draft-runner.ts';
import { buildLearningCandidates, assertLearningCandidateCollection } from './agent-harness-learning-curator-proposals.ts';
import type { LearningCandidate } from './agent-harness-learning-curator-types.ts';
import { captureCatalogMethods, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { captureModelReadingSnapshotGuard, modelReadingServicePath } from './agent-harness-model-reading-source.ts';
import type { LearningCandidateCollection, LearningCuratorNativeContext } from './agent-harness-learning-curator-source.ts';

const AUTO_PROMOTE_PROVENANCE = 'learning-curator-auto-promote';

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface AutoPromoteResult {
  /** Total candidates seen as ready-to-promote or needs-consolidation. */
  readonly eligible: number;
  /** Records successfully promoted this pass. */
  readonly promoted: number;
  /** Candidates skipped due to errors, missing data, or secret-scan rejection. */
  readonly skipped: number;
  /** Duplicate records consolidated (staled + deleted). */
  readonly consolidated: number;
  /** Per-domain breakdown. */
  readonly domains: Record<string, number>;
  /** Brief log lines for each promoted or consolidated item. */
  readonly log: readonly string[];
}

const issuedResults = new WeakMap<AutoPromoteResult, {
  readonly context: LearningCuratorNativeContext;
  readonly options: CatalogRankingOptions;
  readonly assertOutput: (current: unknown) => void;
  readonly assertCurrent: () => void;
}>();

/** Check the exact issued result after rendering and before publication. */
export function assertAutoPromoteResultCurrent(
  result: AutoPromoteResult,
  context: LearningCuratorNativeContext,
  options: CatalogRankingOptions,
): void {
  const issued = issuedResults.get(result);
  if (!issued || issued.context !== context || issued.options !== options)
    throw new ToolInputProjectionError('held');
  issued.assertOutput(result);
  issued.assertCurrent();
  issued.assertOutput(result);
}

function issueResult(result: AutoPromoteResult, context: LearningCuratorNativeContext,
  options: CatalogRankingOptions, assertCurrent: () => void): AutoPromoteResult {
  issuedResults.set(result, { context, options, assertCurrent,
    assertOutput: captureModelReadingSnapshotGuard(result) });
  assertAutoPromoteResultCurrent(result, context, options);
  return result;
}

type LocalRecord = ReturnType<AgentPersonaRegistry['create']>
  | ReturnType<AgentSkillRegistry['create']> | ReturnType<AgentRoutineRegistry['create']>;
type TransitionIntent = Exclude<Parameters<LearningCandidateCollection['prepareTransition']>[0], { readonly domain: 'memory' }>;
class PromotionRestrictionFailure {
  constructor(readonly failure: unknown) {}
}

function splitList(value: string | undefined): string[] {
  return value ? value.split(/[,;]+/).map(entry => entry.trim()).filter(Boolean) : [];
}

function memoryClass(value: string): Parameters<MemoryApi['add']>[0]['cls'] {
  switch (value) {
    case 'decision': case 'constraint': case 'incident': case 'pattern': case 'fact':
    case 'risk': case 'runbook': case 'architecture': case 'ownership': return value;
    default: throw new ToolInputProjectionError('held');
  }
}
function memoryScope(value: string): Parameters<MemoryApi['add']>[0]['scope'] {
  switch (value) {
    case 'session': case 'project': case 'team': return value;
    default: throw new ToolInputProjectionError('held');
  }
}

function writeLocalRecord(
  collection: LearningCandidateCollection,
  intent: TransitionIntent,
  write: (effects: ReturnType<LearningCandidateCollection['prepareTransition']>['effects']) => LocalRecord,
  context: LearningCuratorNativeContext, options: CatalogRankingOptions, assertOwnership: () => void,
): LocalRecord {
  let transition: ReturnType<LearningCandidateCollection['prepareTransition']>;
  try { assertOwnership(); assertLearningCandidateCollection(collection, context, options); assertOwnership(); transition = collection.prepareTransition(intent); }
  catch (error) { throw new PromotionRestrictionFailure(error); }
  let restricted = false;
  let returned = false;
  try {
    const result = write({
      assertCurrent: () => {
        try { assertOwnership(); assertLearningCandidateCollection(collection, context, options); transition.effects.assertCurrent(); assertOwnership(); }
        catch (error) { restricted = true; throw error; }
      },
      onEffect: published => {
        try { assertOwnership(); transition.effects.onEffect(published); assertOwnership(); }
        catch (error) { restricted = true; throw error; }
      },
    });
    returned = true;
    transition.commit(result); assertOwnership(); assertLearningCandidateCollection(collection, context, options); assertOwnership();
    return result;
  } catch (error) {
    try { transition.abort(); } catch (failure) { throw new PromotionRestrictionFailure(failure); }
    if (returned || restricted || error instanceof ToolInputProjectionError || collection.options.signal?.aborted)
      throw new PromotionRestrictionFailure(error);
    try { assertOwnership(); assertLearningCandidateCollection(collection, context, options); assertOwnership(); } catch (failure) { throw new PromotionRestrictionFailure(failure); }
    throw error;
  }
}

async function promoteMemory(
  api: MemoryApi, candidate: LearningCandidate, collection: LearningCandidateCollection,
  options: CatalogRankingOptions, context: LearningCuratorNativeContext, assertOwnership: () => void,
): Promise<string> {
  const fields = candidate.proposalFields ?? {};
  const summary = (fields.summary ?? fields.detail ?? candidate.label).trim();
  const detail = (fields.detail ?? '').trim();
  const confidence = fields.confidence === undefined ? undefined : Number(fields.confidence);
  if (!summary || !detail || confidence === undefined || !Number.isFinite(confidence)
    || confidence < 0 || confidence > 100 || String(confidence) !== fields.confidence)
    throw new ToolInputProjectionError('held');
  const input = {
    scope: memoryScope((fields.scope ?? 'project').trim()),
    cls: memoryClass((fields.cls ?? 'fact').trim()), summary,
    detail, tags: splitList(fields.tags), review: { confidence },
    provenance: [{ kind: 'event', ref: AUTO_PROMOTE_PROVENANCE }],
  } satisfies Parameters<MemoryApi['add']>[0];
  let transition: ReturnType<LearningCandidateCollection['prepareTransition']> | undefined;
  try {
    assertOwnership(); assertLearningCandidateCollection(collection, context, options); assertOwnership();
    const plan = prepareMemoryApiAdd(api, input, { signal: options.signal, assertCurrent: options.assertCurrent });
    assertOwnership(); assertLearningCandidateCollection(collection, context, options); assertOwnership();
    const assertReturned = captureModelReadingSnapshotGuard(plan.record);
    const owned = collection.prepareTransition({ kind: 'create', domain: 'memory', input, preparedRecord: plan.record });
    transition = owned;
    let published = false;
    const record = await plan.commit({
      signal: options.signal,
      assertCurrent: () => {
        assertOwnership(); assertLearningCandidateCollection(collection, context, options); assertOwnership();
        if (!published) owned.effects.assertCurrent();
      },
      onPublished: receipt => {
        assertOwnership(); plan.assertPublication(receipt);
        owned.effects.onEffect(true);
        owned.commit(plan.record);
        published = true; assertOwnership();
      },
    });
    assertOwnership(); assertReturned(record); assertLearningCandidateCollection(collection, context, options); assertOwnership();
    return `memory:${record.id}  ${summary.slice(0, 60)}`;
  } catch (error) {
    try { transition?.abort(); } catch (failure) { throw new PromotionRestrictionFailure(failure); }
    throw new PromotionRestrictionFailure(error);
  }
}

function promotePersona(paths: ShellPathService, candidate: LearningCandidate, collection: LearningCandidateCollection, context: LearningCuratorNativeContext, options: CatalogRankingOptions, assertOwnership: () => void): string {
  const fields = candidate.proposalFields ?? {};
  const name = (fields.name ?? candidate.label).trim();
  const body = (fields.body ?? fields.detail ?? '').trim();
  if (!name || !body) throw new ToolInputProjectionError('held');
  const input = {
    name, description: (fields.description ?? name).trim(),
    body, triggers: splitList(fields.triggers),
    tags: splitList(fields.tags), source: 'agent', provenance: AUTO_PROMOTE_PROVENANCE,
  } satisfies Parameters<AgentPersonaRegistry['create']>[0];
  const record = writeLocalRecord(collection, { kind: 'create', domain: 'persona', input },
    effects => AgentPersonaRegistry.fromShellPaths(paths, effects).create(input), context, options, assertOwnership);
  return `persona:${record.id}  ${name.slice(0, 60)}`;
}

function promoteRoutine(paths: ShellPathService, candidate: LearningCandidate, collection: LearningCandidateCollection, context: LearningCuratorNativeContext, options: CatalogRankingOptions, assertOwnership: () => void): string {
  const fields = candidate.proposalFields ?? {};
  const name = (fields.name ?? candidate.label).trim();
  const steps = (fields.steps ?? fields.notes ?? fields.detail ?? '').trim();
  if (!name || !steps) throw new ToolInputProjectionError('held');
  const input = {
    name, description: (fields.description ?? name).trim(),
    steps,
    triggers: splitList(fields.triggers), tags: splitList(fields.tags), enabled: true,
    source: 'agent', provenance: AUTO_PROMOTE_PROVENANCE,
  } satisfies Parameters<AgentRoutineRegistry['create']>[0];
  const record = writeLocalRecord(collection, { kind: 'create', domain: 'routine', input },
    effects => AgentRoutineRegistry.fromShellPaths(paths, effects).create(input), context, options, assertOwnership);
  return `routine:${record.id}  ${name.slice(0, 60)}`;
}

function consolidate(
  paths: ShellPathService, candidate: LearningCandidate, collection: LearningCandidateCollection,
  context: LearningCuratorNativeContext, options: CatalogRankingOptions, assertOwnership: () => void,
): { readonly count: number; readonly lines: readonly string[] } {
  const plan = candidate.consolidation;
  const domain = candidate.domain;
  if (!plan || (domain !== 'persona' && domain !== 'skill' && domain !== 'routine'))
    throw new Error('Unsupported local consolidation.');
  const lines: string[] = [];
  const update = plan.updateFields;
  if (update) {
    const input = {
      ...(update.description === undefined ? {} : { description: update.description }),
      ...(update.tags === undefined ? {} : { tags: [...update.tags] }),
      ...(update.triggers === undefined ? {} : { triggers: [...update.triggers] }),
      provenance: 'learning-curator-consolidation',
    };
    writeLocalRecord(collection, { kind: 'update', domain, id: plan.survivorId, input }, effects => {
      if (domain === 'persona') return AgentPersonaRegistry.fromShellPaths(paths, effects).update(plan.survivorId, input);
      if (domain === 'skill') return AgentSkillRegistry.fromShellPaths(paths, effects).update(plan.survivorId, input);
      return AgentRoutineRegistry.fromShellPaths(paths, effects).update(plan.survivorId, input);
    }, context, options, assertOwnership);
    lines.push(`merged survivor ${domain}:${plan.survivorId}`);
  }
  let count = 0;
  for (const id of plan.duplicateIds) {
    const reason = `Duplicate of ${plan.survivorId}; staged by learning curator consolidation.`;
    writeLocalRecord(collection, { kind: 'stale', domain, id, reason }, effects => {
      if (domain === 'persona') return AgentPersonaRegistry.fromShellPaths(paths, effects).markStale(id, reason);
      if (domain === 'skill') return AgentSkillRegistry.fromShellPaths(paths, effects).markStale(id, reason);
      return AgentRoutineRegistry.fromShellPaths(paths, effects).markStale(id, reason);
    }, context, options, assertOwnership);
    writeLocalRecord(collection, { kind: 'delete', domain, id }, effects => {
      if (domain === 'persona') return AgentPersonaRegistry.fromShellPaths(paths, effects).deletePersona(id);
      if (domain === 'skill') return AgentSkillRegistry.fromShellPaths(paths, effects).deleteSkill(id);
      return AgentRoutineRegistry.fromShellPaths(paths, effects).deleteRoutine(id);
    }, context, options, assertOwnership);
    count++; lines.push(`consolidated duplicate ${domain}:${id} -> ${plan.survivorId}`);
  }
  return { count, lines };
}

/** Use the caller's recorded admission for all planned local promotions. */
export async function runAutoPromoter(
  context: LearningCuratorNativeContext, skillRegistry: AgentSkillRegistry, memoryApi: MemoryApi,
  options: CatalogRankingOptions,
): Promise<AutoPromoteResult> {
  const assertOptions = captureCatalogMethods(options, ['signal', 'sourceOwner', 'assertCurrent', 'retainCurrent', 'requirePreservedSource']);
  const signal = options.signal, caller = options.assertCurrent;
  const assertSignal = signal ? captureCatalogMethods(signal, ['throwIfAborted']) : () => {};
  if (typeof caller !== 'function') throw new ToolInputProjectionError('unavailable');
  const assertCaller = () => {
    assertOptions(); assertSignal(); signal?.throwIfAborted();
    const result: unknown = caller();
    if (result !== undefined) {
      if (nodeTypes.isPromise(result)) Promise.prototype.then.call(result, undefined, () => {});
      throw new ToolInputProjectionError('stale');
    }
    assertOptions(); assertSignal(); signal?.throwIfAborted();
  };
  assertCaller();
  const assertWorkspace = captureCatalogMethods(context, ['workspace']);
  const paths = context.workspace?.shellPaths;
  if (!paths) {
    const workspace = context.workspace;
    const assertPath = workspace ? captureCatalogMethods(workspace, ['shellPaths']) : () => {};
    const assertEmpty = () => {
      assertWorkspace(); assertPath(); assertCaller(); assertWorkspace(); assertPath();
      if (context.workspace !== workspace || modelReadingServicePath(context, ['workspace', 'shellPaths']) !== paths)
        throw new ToolInputProjectionError('stale');
    };
    return issueResult({ eligible: 0, promoted: 0, skipped: 0, consolidated: 0,
      domains: {}, log: ['No active workspace; promotion skipped.'] }, context, options, assertEmpty);
  }
  const assertApi = captureCatalogMethods(memoryApi, ['add', 'getAll']);
  const factories = [AgentPersonaRegistry, AgentSkillRegistry, AgentRoutineRegistry]
    .map(factory => captureCatalogMethods(factory, ['prototype', 'fromShellPaths']));
  const nativeMethods = [
    captureCatalogMethods(AgentPersonaRegistry.prototype, ['constructor', 'snapshot', 'readStore', 'writeStore', 'nextId', 'validateRequired', 'create', 'update', 'markStale', 'deletePersona']),
    captureCatalogMethods(AgentSkillRegistry.prototype, ['constructor', 'snapshot', 'readStore', 'writeStore', 'nextId', 'validateRequired', 'create', 'update', 'markStale', 'deleteSkill']),
    captureCatalogMethods(AgentRoutineRegistry.prototype, ['constructor', 'snapshot', 'readStore', 'writeStore', 'nextId', 'validateRequired', 'create', 'update', 'markStale', 'deleteRoutine']),
  ];
  const assertOwnership = () => {
    assertOptions(); assertSignal(); assertWorkspace(); assertApi(); for (const guard of [...factories, ...nativeMethods]) guard();
    signal?.throwIfAborted();
    if (context.workspace?.shellPaths !== paths || context.clients?.agentKnowledgeApi?.memory !== memoryApi)
      throw new ToolInputProjectionError('stale');
  };
  assertOwnership(); assertCaller(); assertOwnership();
  const collection = await buildLearningCandidates(context, options);
  assertLearningCandidateCollection(collection, context, options);
  let skillResult: SkillDraftRunResult | undefined;
  const assertCurrent = () => {
    assertOwnership(); assertLearningCandidateCollection(collection, context, options);
    if (skillResult) assertSkillDraftRunResultCurrent(skillResult, context, options);
    assertOwnership();
  };
  assertCurrent();
  const promotions = collection.candidates.filter(candidate => candidate.status === 'ready-to-promote'
    || candidate.status === 'proposal-ready');
  const consolidations = collection.candidates.filter(candidate => candidate.status === 'needs-consolidation'
    && candidate.consolidation !== undefined && candidate.domain !== 'memory');
  const eligible = promotions.length + consolidations.length;
  const log: string[] = [], domains: Record<string, number> = {};
  let promoted = 0, skipped = 0, consolidated = 0;
  const bump = (domain: string) => { domains[domain] = (domains[domain] ?? 0) + 1; };
  const skills = await runSkillDraftProposer(context, skillRegistry, options, collection);
  skillResult = skills;
  assertCurrent();
  for (const entry of skills.entries) { log.push(`promoted skill:${entry.skillId}  ${entry.name}`); bump('skill'); }
  promoted += skills.proposed; skipped += skills.skipped;
  for (const candidate of promotions) {
    if (candidate.proposalTarget === 'skill') continue;
    assertCurrent();
    collection.assertCandidateCurrent(candidate);
    assertCurrent();
    try {
      let line: string;
      if (candidate.proposalTarget === 'memory') line = await promoteMemory(memoryApi, candidate, collection, options, context, assertOwnership);
      else if (candidate.proposalTarget === 'persona') line = promotePersona(paths, candidate, collection, context, options, assertOwnership);
      else if (candidate.proposalTarget === 'routine') line = promoteRoutine(paths, candidate, collection, context, options, assertOwnership);
      else { skipped++; continue; }
      assertCurrent();
      promoted++; bump(candidate.proposalTarget); log.push(`promoted ${line}`);
    } catch (error) {
      if (error instanceof PromotionRestrictionFailure) throw error.failure;
      if (error instanceof ToolInputProjectionError || signal?.aborted) throw error;
      assertCurrent(); skipped++; log.push('Promotion did not complete.');
    }
  }
  for (const candidate of consolidations) {
    assertCurrent();
    collection.assertCandidateCurrent(candidate);
    assertCurrent();
    try {
      const result = consolidate(paths, candidate, collection, context, options, assertOwnership);
      assertCurrent(); consolidated += result.count; promoted += result.count; bump(candidate.domain); log.push(...result.lines);
    } catch (error) {
      if (error instanceof PromotionRestrictionFailure) throw error.failure;
      if (error instanceof ToolInputProjectionError || signal?.aborted) throw error;
      assertCurrent(); skipped++; log.push('Consolidation did not complete.');
    }
  }
  assertCurrent();
  return issueResult({ eligible, promoted, skipped, consolidated, domains, log }, context, options, assertCurrent);
}

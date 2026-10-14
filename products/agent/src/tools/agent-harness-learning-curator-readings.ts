import { learningProposalQuality } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import { captureJudgmentPort } from '@goodvibes-jev/engine/errors';
import { gateJudgmentRegistry, prepareJudgmentResult } from '@goodvibes-jev/engine/sdk/platform/gate';
import { learningCuratorScore, learningDuplicateAlignment, learningProposalTarget, learningSurvivorSelection, learningSurvivorEquivalence, memoryClass, ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { captureCatalogData, captureCatalogMethods, captureCatalogSnapshotGuard, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { STAKES_BANDS, type NamedDecision } from '@goodvibes-jev/judgment';
import { withModelReadingSource } from './agent-harness-model-reading-source.ts';
import { personalOpsEntry, personalOpsJson } from './agent-harness-personal-ops-source.ts';
import type { LearningProposalTarget, LearningScores } from './agent-harness-learning-curator-types.ts';

const assertBandFields = captureCatalogMethods(STAKES_BANDS, Object.keys(STAKES_BANDS));
const assertBandsData = captureCatalogSnapshotGuard(STAKES_BANDS);
const assertBands = () => { assertBandFields(); assertBandsData(STAKES_BANDS); assertBandFields(); };
const assertRegistry = captureCatalogMethods(gateJudgmentRegistry, ['get']);
const definitionMethods = new Set(['run', 'align', 'select', 'count', 'score', 'checkFixtures']);
function canonicalDefinitionData(decision: NamedDecision): unknown {
  // Descriptor reads cover hidden closed specifications and never invoke accessors.
  captureCatalogMethods(decision, []);
  const descriptors = Object.getOwnPropertyDescriptors(decision);
  if (Object.getOwnPropertySymbols(decision).length) throw new ToolInputProjectionError('held');
  const data = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!('value' in descriptor)) throw new ToolInputProjectionError('held');
    const value: unknown = descriptor.value;
    if (definitionMethods.has(key)) {
      if (typeof value !== 'function') throw new ToolInputProjectionError('held');
      continue;
    }
    Object.defineProperty(data, key, { value, enumerable: descriptor.enumerable });
  }
  return captureCatalogData(data);
}
const definitionGuards = new WeakMap<NamedDecision, () => void>();
for (const decision of [learningProposalQuality, learningCuratorScore, learningProposalTarget, learningDuplicateAlignment, learningSurvivorSelection, learningSurvivorEquivalence, memoryClass]) {
  const assertMethods = captureCatalogMethods(decision, Object.keys(Object.getOwnPropertyDescriptors(decision)));
  const assertData = captureCatalogSnapshotGuard(canonicalDefinitionData(decision));
  // Preserve the original published definition, never a weakened later baseline.
  const site = decision.name;
  definitionGuards.set(decision, () => {
    assertRegistry(); assertBands(); assertMethods(); assertData(canonicalDefinitionData(decision)); assertMethods();
    if (gateJudgmentRegistry.get(site) !== decision) throw new ToolInputProjectionError('held');
    assertRegistry(); assertMethods();
  });
}

export interface LearningGrade { readonly scores: LearningScores; readonly priority: number; readonly confidence: number }

async function reading<T>(source: unknown, options: CatalogRankingOptions, decision: NamedDecision, method: 'run' | 'align' | 'select' | 'count' | 'score',
  consume: (authority: ReturnType<typeof captureJudgmentPort>, captured: unknown) => Promise<T>): Promise<T> {
  return withModelReadingSource(source, options, async (captured, current) => {
    const assertCanonical = definitionGuards.get(decision);
    if (!assertCanonical) throw new ToolInputProjectionError('held');
    captureCatalogMethods(decision, [method])();
    const site = decision.name;
    assertCanonical(); current.retainCurrent?.(assertCanonical, `agent.learning.definition:${site}`);
    const assertCurrent = () => { current.assertCurrent?.(); assertCanonical(); };
    const authority = captureJudgmentPort(site, { signal: current.signal, assertCurrent, prepareResultCapture: prepareJudgmentResult });
    try {
      const result = await consume(authority, captured); authority.assertCurrent(); return result;
    } finally {
      const restriction = authority.consumeObservation(); current.retainCurrent?.(restriction.assertCurrent, site); restriction.assertCurrent();
    }
  });
}

export async function readLearningGrade(source: unknown, options: CatalogRankingOptions): Promise<LearningGrade> {
  const grade = await reading(source, options, learningCuratorScore, 'run', async (authority, captured) => {
    const run = await learningCuratorScore.run(authority.port, personalOpsEntry(captured), { site: learningCuratorScore.name, signal: authority.signal, beforeAttempt: authority.assertCurrent });
    authority.assertCurrent();
    if (Object.values(run.readings).some(value => value.outcome !== 'act')) throw new ToolInputProjectionError('held');
    const { usefulness, freshness, source_quality, risk, priority, confidence } = run.readings;
    run.recordAction('read-only learning candidate graded from complete evidence');
    return { proposal: Boolean(captured && typeof captured === 'object' && 'proposedUse' in captured && ['proposal-ready', 'ready-to-promote'].includes(String(captured.proposedUse))), scores: { usefulness: usefulness.level * 25, freshness: freshness.level * 25, sourceQuality: source_quality.level * 25, risk: risk.level * 25 }, priority: priority.level * 25, confidence: confidence.level * 25 };
  });
  if (!grade.proposal) return { scores: grade.scores, priority: grade.priority, confidence: grade.confidence };
  const quality = await reading(source, options, learningProposalQuality, 'score', async (authority, captured) => {
    const result = await learningProposalQuality.score(authority.port, personalOpsEntry(captured), {
      site: learningProposalQuality.name, signal: authority.signal, beforeAttempt: authority.assertCurrent,
    });
    authority.assertCurrent();
    if (Object.values(result.dimensions).some(value => value.outcome !== 'act')) throw new ToolInputProjectionError('held');
    result.recordAction('Order durable proposals using separately read usefulness, support and safety; no write authority.');
    return result;
  });
  return { scores: { ...grade.scores, usefulness: quality.dimensions.usefulness.normalized * 100,
    sourceQuality: quality.dimensions.sourceQuality.normalized * 100, risk: (1 - quality.dimensions.safety.normalized) * 100 },
    priority: quality.composites.priority * 100, confidence: grade.confidence };
}

export function readLearningProposalTarget(source: unknown, options: CatalogRankingOptions): Promise<LearningProposalTarget | null> {
  return reading(source, options, learningProposalTarget, 'run', async (authority, captured) => {
    const run = await learningProposalTarget.run(authority.port, personalOpsEntry(captured), { site: learningProposalTarget.name, signal: authority.signal, beforeAttempt: authority.assertCurrent });
    authority.assertCurrent(); const target = run.readings.target;
    if (target.outcome !== 'act') throw new ToolInputProjectionError('held');
    run.recordAction(target.choice === 'none' ? 'read-only learning source has no durable proposal' : 'read-only durable learning destination selected');
    return target.choice === 'none' ? null : target.choice;
  });
}

export function readLearningMemoryClass(source: unknown, options: CatalogRankingOptions) {
  return reading(source, options, memoryClass, 'run', async (authority, captured) => {
    // The entire screened source is supplied; the original state-tool preview helper is not used.
    const run = await memoryClass.run(authority.port, personalOpsEntry({ key: 'Agent-local durable learning proposal', value: captured }), { site: memoryClass.name, signal: authority.signal, beforeAttempt: authority.assertCurrent });
    authority.assertCurrent(); const cls = run.readings.memory_class;
    if (cls.outcome !== 'act') throw new ToolInputProjectionError('held');
    run.recordAction('read-only learning memory class selected'); return cls.choice;
  });
}

export function readLearningDuplicatePair(source: { readonly left: unknown; readonly right: unknown }, options: CatalogRankingOptions): Promise<boolean> {
  return reading(source, options, learningDuplicateAlignment, 'align', async (authority, captured) => {
    if (!captured || typeof captured !== 'object' || !('left' in captured) || !('right' in captured)) throw new ToolInputProjectionError('held');
    const run = await learningDuplicateAlignment.align(authority.port, personalOpsJson(captured.left), personalOpsJson(captured.right), { site: learningDuplicateAlignment.name, signal: authority.signal, beforeAttempt: authority.assertCurrent });
    authority.assertCurrent();
    if (run.reading.outcome !== 'act' || run.alignment === 'review') throw new ToolInputProjectionError('held');
    run.recordAction(run.alignment === 'same' ? 'read-only learning duplicate pair aligned' : 'read-only learning records are distinct');
    return run.alignment === 'same';
  });
}

export function readLearningSurvivor(source: { readonly domain: string; readonly records: readonly unknown[]; readonly context?: unknown }, options: CatalogRankingOptions): Promise<number> {
  return reading(source, options, learningSurvivorSelection, 'select', async (authority, captured) => {
    if (!captured || typeof captured !== 'object' || !('records' in captured) || !Array.isArray(captured.records)) throw new ToolInputProjectionError('held');
    const records: readonly unknown[] = captured.records;
    const run = await learningSurvivorSelection.select(authority.port, personalOpsJson(captured), records.map((record: unknown, index: number) => ({ id: String(index), content: personalOpsJson(record) })), { site: learningSurvivorSelection.name, signal: authority.signal, beforeAttempt: authority.assertCurrent });
    authority.assertCurrent();
    if (run.outcome !== 'act' || run.chosen === undefined) throw new ToolInputProjectionError('held');
    const index = Number(run.chosen);
    if (!Number.isSafeInteger(index) || index < 0 || index >= records.length || String(index) !== run.chosen) throw new ToolInputProjectionError('held');
    const ids = records.map((record: unknown) => {
      if (!record || typeof record !== 'object' || !('item' in record) || !record.item || typeof record.item !== 'object'
        || !('id' in record.item) || typeof record.item.id !== 'string') throw new ToolInputProjectionError('held');
      return record.item.id;
    });
    if (new Set(ids).size !== ids.length) throw new ToolInputProjectionError('held');
    const selectedId = ids[index]; if (selectedId === undefined) throw new ToolInputProjectionError('held');
    const alternatives = ids.flatMap((id, alternate) => id.localeCompare(selectedId) < 0 ? [{ id, alternate }] : [])
      .sort((left, right) => left.id.localeCompare(right.id));
    let stableIndex = index;
    if (alternatives.length) {
      const equivalent = await reading(alternatives.map(value => ({
        group: captured, selected: records[index], alternate: records[value.alternate],
      })), options, learningSurvivorEquivalence, 'count', async (tieAuthority, items) => {
        if (!Array.isArray(items)) throw new ToolInputProjectionError('held');
        const tie = await learningSurvivorEquivalence.count(tieAuthority.port, items.map(item => personalOpsJson(item)), {
          site: learningSurvivorEquivalence.name, signal: tieAuthority.signal, beforeAttempt: tieAuthority.assertCurrent,
        });
        tieAuthority.assertCurrent();
        if (tie.readings.length !== alternatives.length || tie.readings.some(value => value.outcome !== 'act' || value.verdict === 'uncertain'))
          throw new ToolInputProjectionError('held');
        return tie.readings.map(value => value.verdict === 'yes');
      });
      authority.assertCurrent();
      for (const [position, alternative] of alternatives.entries()) {
        const currentId = ids[stableIndex]; if (currentId === undefined) throw new ToolInputProjectionError('held');
        if (equivalent[position] === true && alternative.id.localeCompare(currentId) < 0) stableIndex = alternative.alternate;
      }
    }
    authority.assertCurrent();
    run.recordAction('read-only learning consolidation survivor selected with settled equivalence and stable native ID ordering'); return stableIndex;
  });
}

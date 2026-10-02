import { randomUUID } from 'node:crypto';
import type { AgentModelCompareArtifactStore, AgentModelCompareModelCatalog, AgentModelCompareRouteUpdateResult, AgentModelCompareToolArgs, CompareCandidateResult, LoadedComparisonJudgment, SavedComparisonArtifact, StoredComparison } from './agent-model-compare-types.ts';
import { SYNTHESIS_THEMES } from './agent-model-compare-types.ts';
import { isModelCompareJudgmentArtifact, listSelectableModels, toSavedComparisonArtifact } from './agent-model-compare-run.ts';
import { readBoolean, readComparisonTag, readRecord, readString, previewText } from './agent-model-compare-utils.ts';

export function normalizeBlindId(value: string): string {
  return value
    .replace(/^candidate\s+/i, '')
    .trim()
    .toUpperCase();
}

export function findCandidate(comparison: StoredComparison, blindId: string): CompareCandidateResult | null {
  const normalized = normalizeBlindId(blindId);
  return comparison.candidates.find((candidate) => candidate.blindId.toUpperCase() === normalized) ?? null;
}

export function modelRouteHandoff(candidate: CompareCandidateResult, reveal: boolean): Record<string, unknown> {
  return {
    ...(reveal ? {
      routeInspection: `agent_harness mode:"model_route" target:"${candidate.model.registryKey}"`,
      confirmedMainRouteUpdate: `settings action:"set" key:"provider.model" value:"${candidate.model.registryKey}" confirm:true explicitUserRequest:"..."`,
    } : {
      routeInspection: 'reveal the winning model before model-route inspection',
    }),
    policy: 'This judgment does not change the selected model. Route updates require a separate confirmed action.',
  };
}

export function judgmentArtifactText(input: {
  readonly judgmentId: string;
  readonly comparison: StoredComparison;
  readonly winner: CompareCandidateResult;
  readonly reasons: string;
  readonly notes: string;
  readonly reveal: boolean;
}): string {
  return `${JSON.stringify({
    schema: 'goodvibes.agent.model_compare_judgment.v1',
    judgmentId: input.judgmentId,
    comparisonId: input.comparison.comparisonId,
    sourceArtifactId: input.comparison.artifact?.artifactId ?? null,
    sourceDocumentId: input.comparison.documentId ?? null,
    documentId: input.comparison.documentId ?? null,
    benchmarkKind: input.comparison.benchmarkKind ?? null,
    taskType: input.comparison.taskType ?? null,
    createdAt: new Date().toISOString(),
    promptPreview: input.comparison.promptPreview,
    rubric: input.comparison.rubric,
    winnerBlindId: input.winner.blindId,
    ...(input.reveal ? {
      winnerModel: {
        registryKey: input.winner.model.registryKey,
        providerId: input.winner.model.providerId,
        modelId: input.winner.model.modelId,
        displayName: input.winner.model.displayName,
      },
    } : {}),
    reasons: input.reasons,
    notes: input.notes,
    revealIncludedInJudgment: input.reveal,
    routeHandoff: modelRouteHandoff(input.winner, input.reveal),
    candidates: input.comparison.candidates.map((candidate) => ({
      blindId: candidate.blindId,
      status: candidate.status,
      ...(input.reveal ? {
        model: {
          registryKey: candidate.model.registryKey,
          providerId: candidate.model.providerId,
          modelId: candidate.model.modelId,
          displayName: candidate.model.displayName,
        },
      } : {}),
    })),
  }, null, 2)}\n`;
}

export async function saveComparisonJudgmentArtifact(input: {
  readonly artifactStore?: AgentModelCompareArtifactStore;
  readonly comparison: StoredComparison;
  readonly winner: CompareCandidateResult;
  readonly reasons: string;
  readonly notes: string;
  readonly reveal: boolean;
}): Promise<SavedComparisonArtifact> {
  if (!input.artifactStore) throw new Error('Cannot save judgment because the artifact store is unavailable.');
  const judgmentId = `jdg_${randomUUID()}`;
  const descriptor = await input.artifactStore.create({
    kind: 'data',
    mimeType: 'application/json',
    filename: `blind-model-comparison-judgment-${judgmentId}.json`,
    text: judgmentArtifactText({
      judgmentId,
      comparison: input.comparison,
      winner: input.winner,
      reasons: input.reasons,
      notes: input.notes,
      reveal: input.reveal,
    }),
    metadata: {
      purpose: 'agent-model-compare-judgment',
      judgmentId,
      comparisonId: input.comparison.comparisonId,
      sourceArtifactId: input.comparison.artifact?.artifactId ?? null,
      sourceDocumentId: input.comparison.documentId ?? null,
      documentId: input.comparison.documentId ?? null,
      benchmarkKind: input.comparison.benchmarkKind ?? null,
      taskType: input.comparison.taskType ?? null,
      winnerBlindId: input.winner.blindId,
      promptPreview: input.comparison.promptPreview,
      revealIncludedInJudgment: input.reveal,
      ...(input.reveal ? { winnerModel: input.winner.model.registryKey } : {}),
    },
  });
  return toSavedComparisonArtifact(descriptor);
}

export function formatJudgePreview(args: AgentModelCompareToolArgs): string {
  return [
    'Agent blind model comparison judgment preview',
    `  comparison ${readString(args.comparisonId) || readString(args.artifactId) || '(missing)'}`,
    `  winner ${readString(args.winnerBlindId ?? args.winner) || '(missing)'}`,
    `  reasons ${previewText(readString(args.reasons) || '(missing)')}`,
    `  reveal ${readBoolean(args.reveal) ? 'include model identity in judgment' : 'keep judgment blind'}`,
    '  policy saves a local judgment artifact and never changes the selected model',
  ].join('\n');
}

export function formatJudgmentResult(input: {
  readonly comparison: StoredComparison;
  readonly winner: CompareCandidateResult;
  readonly artifact: SavedComparisonArtifact;
  readonly reasons: string;
  readonly reveal: boolean;
}): string {
  const routeHandoff = modelRouteHandoff(input.winner, input.reveal);
  const lines = [
    `Blind model comparison judgment saved for ${input.comparison.comparisonId}`,
    `winner Candidate ${input.winner.blindId}`,
    ...(input.reveal ? [`winner model ${input.winner.model.registryKey} (${input.winner.model.displayName})`] : []),
    `artifact ${input.artifact.artifactId}${input.artifact.filename ? ` ${input.artifact.filename}` : ''} (${input.artifact.mimeType}, ${input.artifact.sizeBytes} bytes)`,
    `reasons ${input.reasons || '(none)'}`,
    '',
    'Route handoff',
    `  inspect ${routeHandoff.routeInspection}`,
  ];
  if (input.reveal) {
    lines.push(`  update ${routeHandoff.confirmedMainRouteUpdate}`);
  } else {
    lines.push('  update reveal the winner first, then use a separate confirmed model-routing action');
  }
  lines.push('No selected model was changed.');
  return lines.join('\n');
}

export function parseJudgmentArtifactPayload(value: unknown, artifact: SavedComparisonArtifact, metadata: Record<string, unknown> = {}): LoadedComparisonJudgment | null {
  const payload = readRecord(value);
  if (!payload || readString(payload.schema) !== 'goodvibes.agent.model_compare_judgment.v1') return null;
  const winnerModel = readRecord(payload.winnerModel);
  const registryKey = readString(winnerModel?.registryKey);
  const sourceArtifactId = readString(payload.sourceArtifactId) || readString(metadata.sourceArtifactId);
  const benchmarkKind = readComparisonTag(payload.benchmarkKind) || readComparisonTag(metadata.benchmarkKind);
  const taskType = readComparisonTag(payload.taskType) || readComparisonTag(metadata.taskType);
  const documentId = readString(payload.documentId)
    || readString(payload.sourceDocumentId)
    || readString(metadata.documentId)
    || readString(metadata.sourceDocumentId);
  return {
    artifact,
    judgmentId: readString(payload.judgmentId) || `judgment_from_${artifact.artifactId}`,
    comparisonId: readString(payload.comparisonId) || 'unknown-comparison',
    winnerBlindId: readString(payload.winnerBlindId) || '?',
    reasons: readString(payload.reasons),
    notes: readString(payload.notes),
    revealIncludedInJudgment: payload.revealIncludedInJudgment === true,
    ...(sourceArtifactId ? { sourceArtifactId } : {}),
    ...(benchmarkKind ? { benchmarkKind } : {}),
    ...(taskType ? { taskType } : {}),
    ...(documentId ? { documentId } : {}),
    ...(registryKey ? {
      winnerModel: {
        registryKey,
        providerId: readString(winnerModel?.providerId),
        modelId: readString(winnerModel?.modelId),
        displayName: readString(winnerModel?.displayName) || registryKey,
      },
    } : {}),
  };
}

export async function loadJudgmentFromArtifact(
  artifactStore: AgentModelCompareArtifactStore | undefined,
  artifactId: string,
): Promise<LoadedComparisonJudgment | null> {
  if (!artifactStore?.readContent) return null;
  const { record, buffer } = await artifactStore.readContent(artifactId);
  let payload: unknown;
  try {
    payload = JSON.parse(buffer.toString('utf-8')) as unknown;
  } catch {
    return null;
  }
  return parseJudgmentArtifactPayload(payload, toSavedComparisonArtifact(record), record.metadata);
}

export async function loadSavedJudgments(
  artifactStore: AgentModelCompareArtifactStore | undefined,
  limit: number,
  filters: ComparisonAnalyticsFilters = {},
): Promise<readonly LoadedComparisonJudgment[]> {
  if (!artifactStore?.list || !artifactStore.readContent) return [];
  const listLimit = hasComparisonFilters(filters) ? Math.max(limit * 10, 100) : Math.max(limit * 3, limit);
  const artifacts = artifactStore.list(listLimit)
    .filter(isModelCompareJudgmentArtifact)
    .slice(0, listLimit);
  const loaded = await Promise.all(artifacts.map(async (artifact) => {
    try {
      return await loadJudgmentFromArtifact(artifactStore, artifact.id);
    } catch {
      return null;
    }
  }));
  return loaded
    .filter((judgment): judgment is LoadedComparisonJudgment => judgment !== null)
    .filter((judgment) => judgmentMatchesFilters(judgment, filters))
    .slice(0, limit);
}

export async function ensureSelectableWinnerModel(
  catalog: AgentModelCompareModelCatalog,
  registryKey: string,
): Promise<void> {
  const selectableModels = await listSelectableModels(catalog);
  if (!selectableModels.some((model) => model.registryKey === registryKey)) {
    throw new Error(`Winner model ${registryKey} is not currently selectable. Refresh model routing before applying this judgment.`);
  }
}

export function formatApplyPreview(judgment: LoadedComparisonJudgment): string {
  return [
    'Agent blind model comparison route update preview',
    `  judgment ${judgment.judgmentId}`,
    `  comparison ${judgment.comparisonId}`,
    `  winner Candidate ${judgment.winnerBlindId}`,
    `  model ${judgment.winnerModel?.registryKey ?? '(not revealed in judgment)'}`,
    `  reasons ${previewText(judgment.reasons || '(none)')}`,
    '  policy changes provider.model only after explicit confirmation',
  ].join('\n');
}

export function formatApplyResult(input: {
  readonly judgment: LoadedComparisonJudgment;
  readonly result: AgentModelCompareRouteUpdateResult;
  readonly receipt?: SavedComparisonArtifact | null;
  readonly receiptError?: string | null;
}): string {
  const lines = [
    `Applied blind model comparison winner ${input.judgment.judgmentId}`,
    `comparison ${input.judgment.comparisonId}`,
    `winner Candidate ${input.judgment.winnerBlindId}`,
    `selected model ${input.result.selectedModel}`,
  ];
  if (input.result.previousModel) lines.push(`previous model ${input.result.previousModel}`);
  if (input.receipt) lines.push(`route decision receipt ${input.receipt.artifactId}${input.receipt.filename ? ` ${input.receipt.filename}` : ''}`);
  if (input.receiptError) lines.push(`route decision receipt unavailable: ${input.receiptError}`);
  lines.push('Judgment and comparison artifacts were not changed.');
  return lines.join('\n');
}

export type ComparisonRouteDecision = 'applied-winner' | 'left-unchanged';

export function parseRouteDecision(value: unknown): ComparisonRouteDecision | null {
  const normalized = readString(value).toLowerCase().replace(/[\s_-]+/g, '');
  if (normalized === 'leftunchanged' || normalized === 'leaveunchanged' || normalized === 'keepcurrent' || normalized === 'nochange' || normalized === 'unchanged') {
    return 'left-unchanged';
  }
  if (normalized === 'appliedwinner' || normalized === 'applywinner' || normalized === 'apply') return 'applied-winner';
  return null;
}

export function routeDecisionArtifactText(input: {
  readonly decisionId: string;
  readonly decision: ComparisonRouteDecision;
  readonly judgment: LoadedComparisonJudgment;
  readonly route?: AgentModelCompareRouteUpdateResult | null;
  readonly currentModel?: string | null;
  readonly explicitUserRequest: string;
}): string {
  return `${JSON.stringify({
    schema: 'goodvibes.agent.model_compare.route_decision.v1',
    decisionId: input.decisionId,
    decision: input.decision,
    createdAt: new Date().toISOString(),
    comparisonId: input.judgment.comparisonId,
    judgmentId: input.judgment.judgmentId,
    judgmentArtifactId: input.judgment.artifact.artifactId,
    winnerBlindId: input.judgment.winnerBlindId,
    winnerModel: input.judgment.winnerModel?.registryKey ?? null,
    currentModel: input.currentModel ?? input.route?.selectedModel ?? null,
    previousModel: input.route?.previousModel ?? null,
    selectedModel: input.route?.selectedModel ?? input.currentModel ?? null,
    explicitUserRequest: input.explicitUserRequest,
    policy: {
      mutation: input.decision === 'applied-winner' ? 'provider.model updated through confirmed apply' : 'provider.model intentionally left unchanged',
      transcript: 'Route-decision evidence is saved as an artifact; comparison and judgment artifacts are not modified.',
    },
  }, null, 2)}\n`;
}

export async function saveRouteDecisionArtifact(input: {
  readonly artifactStore?: AgentModelCompareArtifactStore;
  readonly decision: ComparisonRouteDecision;
  readonly judgment: LoadedComparisonJudgment;
  readonly route?: AgentModelCompareRouteUpdateResult | null;
  readonly currentModel?: string | null;
  readonly explicitUserRequest: string;
}): Promise<SavedComparisonArtifact> {
  if (!input.artifactStore) throw new Error('Cannot save route decision because the artifact store is unavailable.');
  const decisionId = `rdec_${randomUUID()}`;
  const descriptor = await input.artifactStore.create({
    kind: 'data',
    mimeType: 'application/json',
    filename: `blind-model-comparison-route-decision-${decisionId}.json`,
    text: routeDecisionArtifactText({
      decisionId,
      decision: input.decision,
      judgment: input.judgment,
      route: input.route,
      currentModel: input.currentModel,
      explicitUserRequest: input.explicitUserRequest,
    }),
    metadata: {
      purpose: 'agent-model-compare-route-decision',
      decisionId,
      decision: input.decision,
      comparisonId: input.judgment.comparisonId,
      judgmentId: input.judgment.judgmentId,
      judgmentArtifactId: input.judgment.artifact.artifactId,
      winnerBlindId: input.judgment.winnerBlindId,
      ...(input.judgment.winnerModel?.registryKey ? { winnerModel: input.judgment.winnerModel.registryKey } : {}),
      ...(input.currentModel ? { currentModel: input.currentModel } : {}),
      ...(input.route?.previousModel ? { previousModel: input.route.previousModel } : {}),
      selectedModel: input.route?.selectedModel ?? input.currentModel ?? null,
    },
  });
  return toSavedComparisonArtifact(descriptor);
}

export function formatRouteDecisionPreview(input: {
  readonly judgment: LoadedComparisonJudgment;
  readonly decision: ComparisonRouteDecision;
  readonly currentModel?: string | null;
}): string {
  return [
    'Agent blind model comparison route-decision preview',
    `  decision ${input.decision}`,
    `  judgment ${input.judgment.judgmentId}`,
    `  comparison ${input.judgment.comparisonId}`,
    `  winner Candidate ${input.judgment.winnerBlindId}`,
    `  winner model ${input.judgment.winnerModel?.registryKey ?? '(not revealed in judgment)'}`,
    `  current model ${input.currentModel ?? '(unknown)'}`,
    '  policy creates one local route-decision receipt and does not change model routing',
  ].join('\n');
}

export function formatRouteDecisionResult(input: {
  readonly judgment: LoadedComparisonJudgment;
  readonly decision: ComparisonRouteDecision;
  readonly receipt: SavedComparisonArtifact;
  readonly currentModel?: string | null;
}): string {
  return [
    `Recorded blind model comparison route decision ${input.decision}`,
    `comparison ${input.judgment.comparisonId}`,
    `judgment ${input.judgment.judgmentId}`,
    `winner Candidate ${input.judgment.winnerBlindId}`,
    `current model ${input.currentModel ?? '(unknown)'}`,
    `route decision receipt ${input.receipt.artifactId}${input.receipt.filename ? ` ${input.receipt.filename}` : ''}`,
    'No selected model was changed.',
  ].join('\n');
}

export function incrementCount(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

export function sortedCounts(map: Map<string, number>): readonly [string, number][] {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export interface ComparisonAnalyticsFilters {
  readonly benchmarkKind?: string;
  readonly taskType?: string;
  readonly documentId?: string;
}

export function readComparisonAnalyticsFilters(args: AgentModelCompareToolArgs): ComparisonAnalyticsFilters {
  const benchmarkKind = readComparisonTag(args.benchmarkKind);
  const taskType = readComparisonTag(args.taskType);
  const documentId = readComparisonTag(args.documentId);
  return {
    ...(benchmarkKind ? { benchmarkKind } : {}),
    ...(taskType ? { taskType } : {}),
    ...(documentId ? { documentId } : {}),
  };
}

export function hasComparisonFilters(filters: ComparisonAnalyticsFilters): boolean {
  return Boolean(filters.benchmarkKind || filters.taskType || filters.documentId);
}

export function matchesFilter(actual: string | undefined, expected: string | undefined): boolean {
  if (!expected) return true;
  return (actual ?? '').toLowerCase() === expected.toLowerCase();
}

export function judgmentMatchesFilters(judgment: LoadedComparisonJudgment, filters: ComparisonAnalyticsFilters): boolean {
  return matchesFilter(judgment.benchmarkKind, filters.benchmarkKind)
    && matchesFilter(judgment.taskType, filters.taskType)
    && matchesFilter(judgment.documentId, filters.documentId);
}

export function formatComparisonFilters(filters: ComparisonAnalyticsFilters): string {
  if (!hasComparisonFilters(filters)) return 'filters none';
  const parts = [
    filters.benchmarkKind ? `benchmarkKind ${filters.benchmarkKind}` : null,
    filters.taskType ? `taskType ${filters.taskType}` : null,
    filters.documentId ? `documentId ${filters.documentId}` : null,
  ].filter((entry): entry is string => Boolean(entry));
  return `filters ${parts.join('; ')}`;
}

export function incrementOptionalDimension(map: Map<string, number>, value: string | undefined): void {
  incrementCount(map, value || '(untagged)');
}

export function formatComparisonAnalytics(input: {
  readonly judgments: readonly LoadedComparisonJudgment[];
  readonly limit: number;
  readonly includeReasons: boolean;
  readonly filters: ComparisonAnalyticsFilters;
  readonly storeAvailable: boolean;
}): string {
  if (!input.storeAvailable) {
    return 'Saved comparison analytics are unavailable because the artifact store does not expose listing and content reads in this runtime.';
  }
  if (input.judgments.length === 0) {
    return hasComparisonFilters(input.filters)
      ? `No saved comparison judgments matched ${formatComparisonFilters(input.filters)}. Clear a filter or save a matching judgment with agent_model_compare mode:"judge".`
      : 'No saved comparison judgments found. Save a judgment with agent_model_compare mode:"judge" first.';
  }
  const modelWinners = new Map<string, number>();
  const blindWinners = new Map<string, number>();
  const benchmarkCounts = new Map<string, number>();
  const taskCounts = new Map<string, number>();
  const documentCounts = new Map<string, number>();
  let revealed = 0;
  for (const judgment of input.judgments) {
    incrementCount(blindWinners, normalizeBlindId(judgment.winnerBlindId) || judgment.winnerBlindId || '?');
    incrementOptionalDimension(benchmarkCounts, judgment.benchmarkKind);
    incrementOptionalDimension(taskCounts, judgment.taskType);
    incrementOptionalDimension(documentCounts, judgment.documentId);
    if (judgment.winnerModel?.registryKey) {
      revealed += 1;
      incrementCount(modelWinners, `${judgment.winnerModel.registryKey} (${judgment.winnerModel.displayName})`);
    }
  }
  const hidden = input.judgments.length - revealed;
  const lines = [
    'Blind model comparison analytics',
    `judgments ${input.judgments.length}; revealed ${revealed}; hidden ${hidden}; limit ${input.limit}`,
    formatComparisonFilters(input.filters),
    '',
    'Winning models',
  ];
  if (modelWinners.size === 0) {
    lines.push('  No revealed winner models yet. Save a judgment with reveal:true before model-level analytics are available.');
  } else {
    lines.push(...sortedCounts(modelWinners).map(([model, count]) => `  ${model}: ${count}`));
  }
  lines.push('');
  lines.push('Winning blind slots');
  lines.push(...sortedCounts(blindWinners).map(([blindId, count]) => `  Candidate ${blindId}: ${count}`));
  lines.push('');
  lines.push('Trend dimensions');
  lines.push('  benchmark tags');
  lines.push(...sortedCounts(benchmarkCounts).map(([tag, count]) => `    ${tag}: ${count}`));
  lines.push('  task types');
  lines.push(...sortedCounts(taskCounts).map(([task, count]) => `    ${task}: ${count}`));
  lines.push('  documents');
  lines.push(...sortedCounts(documentCounts).map(([document, count]) => `    ${document}: ${count}`));
  lines.push('');
  lines.push('Recent judgments');
  for (const judgment of input.judgments.slice(0, 10)) {
    const model = judgment.winnerModel?.registryKey
      ? ` model ${judgment.winnerModel.registryKey}`
      : ' model hidden';
    lines.push(`  ${judgment.artifact.artifactId} ${judgment.comparisonId} winner Candidate ${judgment.winnerBlindId}${model}`);
    const dimensions = [
      judgment.benchmarkKind ? `benchmark ${judgment.benchmarkKind}` : null,
      judgment.taskType ? `task ${judgment.taskType}` : null,
      judgment.documentId ? `document ${judgment.documentId}` : null,
    ].filter(Boolean).join('; ');
    if (dimensions) lines.push(`    ${dimensions}`);
    if (input.includeReasons && judgment.reasons) {
      lines.push(`    reasons ${previewText(judgment.reasons, 120)}`);
    }
    if (input.includeReasons && judgment.notes) {
      lines.push(`    notes ${previewText(judgment.notes, 120)}`);
    }
  }
  lines.push('No selected model was changed.');
  return lines.join('\n');
}

export function countPhrase(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function pushSynthesisTheme(
  map: Map<string, LoadedComparisonJudgment[]>,
  label: string,
  judgment: LoadedComparisonJudgment,
): void {
  const judgments = map.get(label) ?? [];
  judgments.push(judgment);
  map.set(label, judgments);
}

export function formatComparisonSynthesis(input: {
  readonly judgments: readonly LoadedComparisonJudgment[];
  readonly limit: number;
  readonly includeReasons: boolean;
  readonly filters: ComparisonAnalyticsFilters;
  readonly storeAvailable: boolean;
}): string {
  if (!input.storeAvailable) {
    return 'Saved comparison synthesis is unavailable because the artifact store does not expose listing and content reads in this runtime.';
  }
  if (input.judgments.length === 0) {
    return hasComparisonFilters(input.filters)
      ? `No saved comparison judgments matched ${formatComparisonFilters(input.filters)}. Clear a filter or save a matching judgment with agent_model_compare mode:"judge".`
      : 'No saved comparison judgments found. Save a judgment with agent_model_compare mode:"judge" first.';
  }

  const modelWinners = new Map<string, number>();
  const comparisonIds = new Set<string>();
  const benchmarkCounts = new Map<string, number>();
  const taskCounts = new Map<string, number>();
  const documentCounts = new Map<string, number>();
  const themes = new Map<string, LoadedComparisonJudgment[]>();
  let revealed = 0;
  for (const judgment of input.judgments) {
    comparisonIds.add(judgment.comparisonId);
    incrementOptionalDimension(benchmarkCounts, judgment.benchmarkKind);
    incrementOptionalDimension(taskCounts, judgment.taskType);
    incrementOptionalDimension(documentCounts, judgment.documentId);
    if (judgment.winnerModel?.registryKey) {
      revealed += 1;
      incrementCount(modelWinners, `${judgment.winnerModel.registryKey} (${judgment.winnerModel.displayName})`);
    }
    const preferenceText = `${judgment.reasons}\n${judgment.notes}`.trim();
    const matched = SYNTHESIS_THEMES.filter((theme) => theme.pattern.test(preferenceText));
    if (matched.length === 0) {
      pushSynthesisTheme(themes, 'Uncategorized preference signal', judgment);
    } else {
      for (const theme of matched) pushSynthesisTheme(themes, theme.label, judgment);
    }
  }

  const hidden = input.judgments.length - revealed;
  const themeCounts = [...themes.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const lines = [
    'Blind model comparison synthesis',
    `judgments ${input.judgments.length}; revealed ${revealed}; hidden ${hidden}; compared comparisons ${comparisonIds.size}; limit ${input.limit}`,
    formatComparisonFilters(input.filters),
    '',
    'Winning model direction',
  ];
  if (modelWinners.size === 0) {
    lines.push('  No revealed winner models yet. Reveal judgment winners before model-level synthesis is available.');
  } else {
    lines.push(...sortedCounts(modelWinners).map(([model, count]) => `  ${model}: ${count}`));
  }
  if (hidden > 0) {
    lines.push(`  Hidden winners: ${countPhrase(hidden, 'judgment')} ${hidden === 1 ? 'needs' : 'need'} reveal before model-level synthesis.`);
  }

  lines.push('');
  lines.push('Cross-session reason themes');
  for (const [label, judgments] of themeCounts) {
    lines.push(`  ${label}: ${countPhrase(judgments.length, 'judgment')}`);
    if (!input.includeReasons) continue;
    const example = judgments.find((judgment) => judgment.reasons || judgment.notes);
    if (!example) continue;
    const source = example.reasons || example.notes;
    lines.push(`    example ${example.artifact.artifactId}: ${previewText(source, 120)}`);
  }

  lines.push('');
  lines.push('Trend dimensions');
  lines.push('  benchmark tags');
  lines.push(...sortedCounts(benchmarkCounts).map(([tag, count]) => `    ${tag}: ${count}`));
  lines.push('  task types');
  lines.push(...sortedCounts(taskCounts).map(([task, count]) => `    ${task}: ${count}`));
  lines.push('  documents');
  lines.push(...sortedCounts(documentCounts).map(([document, count]) => `    ${document}: ${count}`));

  lines.push('');
  lines.push('Recent synthesis inputs');
  for (const judgment of input.judgments.slice(0, 10)) {
    const model = judgment.winnerModel?.registryKey
      ? ` model ${judgment.winnerModel.registryKey}`
      : ' model hidden';
    lines.push(`  ${judgment.artifact.artifactId} ${judgment.comparisonId} winner Candidate ${judgment.winnerBlindId}${model}`);
    const dimensions = [
      judgment.benchmarkKind ? `benchmark ${judgment.benchmarkKind}` : null,
      judgment.taskType ? `task ${judgment.taskType}` : null,
      judgment.documentId ? `document ${judgment.documentId}` : null,
    ].filter(Boolean).join('; ');
    if (dimensions) lines.push(`    ${dimensions}`);
  }

  lines.push('');
  lines.push('Recommended next actions');
  if (hidden > 0) lines.push('  - Reveal hidden judgments before applying model-level route changes.');
  lines.push('  - Export comparison or judgment reports before sharing evidence externally.');
  lines.push('  - Apply a winner only through confirmed mode:"apply".');
  lines.push('No selected model was changed.');
  return lines.join('\n');
}

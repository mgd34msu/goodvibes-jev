import { randomUUID } from 'node:crypto';
import type { ArtifactDescriptor } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import type { ChatRequest, ChatResponse } from '@goodvibes-jev/engine/sdk/platform/providers';
import type { AgentModelCompareArtifactStore, AgentModelCompareCatalogModel, AgentModelCompareModelCatalog, AgentModelCompareToolArgs, AgentModelCompareToolDeps, CompareCandidateResult, ComparisonArtifactStatus, ResolvedCompareModel, SavedComparisonArtifact, StoredComparison } from './agent-model-compare-types.ts';
import { BLIND_LABELS, COMPARISON_STORE_LIMIT, DEFAULT_CANDIDATE_COUNT, DEFAULT_CANDIDATE_OUTPUT_CHARS, DEFAULT_MAX_TOKENS, DEFAULT_SIDE_BY_SIDE_PREVIEW_BYTES, MAX_CANDIDATES, MAX_COMPLETION_TOKENS, MAX_PROMPT_CHARS, MAX_SIDE_BY_SIDE_PREVIEW_BYTES, MAX_SOURCE_ARTIFACT_BYTES, MIN_CANDIDATES, MODE_ANALYTICS, MODE_APPLY, MODE_EXPORT, MODE_HANDOFF, MODE_HANDOFF_ARCHIVE, MODE_HANDOFF_DIFF, MODE_JUDGE, MODE_REVEAL, MODE_REVIEW, MODE_ROUTE_DECISION, MODE_RUN, MODE_SIDE_BY_SIDE, MODE_SYNTHESIS } from './agent-model-compare-types.ts';
import { clamp, isTextLike, readBenchmarkKind, readBoolean, readComparisonTag, readModelRefs, readNumber, readOptionalBoolean, readRecord, readString, readStringList, previewText } from './agent-model-compare-utils.ts';

export function normalizeCatalogModel(model: AgentModelCompareCatalogModel): ResolvedCompareModel | null {
  const modelId = readString(model.modelId ?? model.id);
  const providerId = readString(model.providerId ?? model.provider);
  if (!modelId || !providerId) return null;
  return {
    modelId,
    providerId,
    registryKey: readString(model.registryKey) || `${providerId}:${modelId}`,
    displayName: readString(model.displayName) || modelId,
    current: model.current === true,
  };
}

export function modelSearchText(model: ResolvedCompareModel): string {
  return [
    model.registryKey,
    model.modelId,
    model.providerId,
    model.displayName,
  ].join('\n').toLowerCase();
}

export function dedupeModels(models: readonly ResolvedCompareModel[]): readonly ResolvedCompareModel[] {
  const seen = new Set<string>();
  const result: ResolvedCompareModel[] = [];
  for (const model of models) {
    if (seen.has(model.registryKey)) continue;
    seen.add(model.registryKey);
    result.push(model);
  }
  return result;
}

export async function listSelectableModels(catalog: AgentModelCompareModelCatalog): Promise<readonly ResolvedCompareModel[]> {
  const rawModels = await catalog.listModels({ selectableOnly: true });
  return dedupeModels(rawModels
    .filter((model) => model.selectable !== false)
    .map(normalizeCatalogModel)
    .filter((model): model is ResolvedCompareModel => model !== null));
}

export async function resolveCurrentModel(catalog: AgentModelCompareModelCatalog): Promise<ResolvedCompareModel | null> {
  if (!catalog.getCurrentModel) return null;
  try {
    return normalizeCatalogModel(await catalog.getCurrentModel());
  } catch {
    return null;
  }
}

export function resolveRequestedModels(
  refs: readonly string[],
  selectableModels: readonly ResolvedCompareModel[],
): readonly ResolvedCompareModel[] {
  const resolved: ResolvedCompareModel[] = [];
  for (const ref of refs) {
    const normalizedRef = ref.toLowerCase();
    const exact = selectableModels.find((model) => model.registryKey.toLowerCase() === normalizedRef)
      ?? selectableModels.find((model) => `${model.providerId}:${model.modelId}`.toLowerCase() === normalizedRef);
    if (exact) {
      resolved.push(exact);
      continue;
    }
    const modelIdMatches = selectableModels.filter((model) => model.modelId.toLowerCase() === normalizedRef);
    if (modelIdMatches.length === 1) {
      resolved.push(modelIdMatches[0]!);
      continue;
    }
    const displayMatches = selectableModels.filter((model) => model.displayName.toLowerCase() === normalizedRef);
    if (displayMatches.length === 1) {
      resolved.push(displayMatches[0]!);
      continue;
    }
    const fuzzy = selectableModels.filter((model) => modelSearchText(model).includes(normalizedRef));
    if (fuzzy.length === 1) resolved.push(fuzzy[0]!);
  }
  return dedupeModels(resolved);
}

export async function selectComparisonModels(
  catalog: AgentModelCompareModelCatalog,
  refs: readonly string[],
  candidateCount: number,
): Promise<readonly ResolvedCompareModel[]> {
  const selectableModels = await listSelectableModels(catalog);
  if (selectableModels.length < MIN_CANDIDATES) {
    throw new Error(`At least ${MIN_CANDIDATES} selectable models are required for blind comparison.`);
  }

  if (refs.length > 0) {
    const requested = resolveRequestedModels(refs, selectableModels);
    const missing = refs.length - requested.length;
    if (missing > 0) {
      throw new Error(`Could not resolve ${missing} requested model reference(s). Use registry keys from models action:"status".`);
    }
    if (requested.length < MIN_CANDIDATES) throw new Error(`Select at least ${MIN_CANDIDATES} different models.`);
    if (requested.length > MAX_CANDIDATES) throw new Error(`Select at most ${MAX_CANDIDATES} models.`);
    return requested;
  }

  const current = await resolveCurrentModel(catalog);
  const count = clamp(candidateCount, MIN_CANDIDATES, MAX_CANDIDATES);
  const ordered = dedupeModels([
    ...(current ? [current] : []),
    ...selectableModels,
  ]).filter((model) => selectableModels.some((selectable) => selectable.registryKey === model.registryKey));
  return ordered.slice(0, count);
}

export function createPromptRequest(
  model: ResolvedCompareModel,
  prompt: string,
  systemPrompt: string,
  maxTokens: number,
): ChatRequest {
  return {
    model: model.modelId,
    messages: [{ role: 'user', content: prompt }],
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(maxTokens > 0 ? { maxTokens } : {}),
  };
}

export async function runCandidate(
  deps: AgentModelCompareToolDeps,
  model: ResolvedCompareModel,
  blindId: string,
  prompt: string,
  systemPrompt: string,
  maxTokens: number,
): Promise<CompareCandidateResult> {
  const startedAt = Date.now();
  try {
    const provider = deps.providerRegistry.getForModel(model.modelId, model.providerId);
    const response = await provider.chat(createPromptRequest(model, prompt, systemPrompt, maxTokens));
    return {
      blindId,
      model,
      status: 'completed',
      content: response.content,
      stopReason: response.stopReason,
      usage: response.usage,
      latencyMs: Date.now() - startedAt,
      toolCallCount: response.toolCalls.length,
    };
  } catch (error) {
    return {
      blindId,
      model,
      status: 'failed',
      content: '',
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function formatUsage(usage: ChatResponse['usage'] | undefined): string {
  if (!usage) return 'unknown';
  const cache = [
    usage.cacheReadTokens ? `cache read ${usage.cacheReadTokens}` : '',
    usage.cacheWriteTokens ? `cache write ${usage.cacheWriteTokens}` : '',
  ].filter(Boolean).join(', ');
  return `${usage.inputTokens} in / ${usage.outputTokens} out${cache ? `, ${cache}` : ''}`;
}

export function candidateContent(content: string): string {
  if (content.length <= DEFAULT_CANDIDATE_OUTPUT_CHARS) return content || '(empty)';
  return `${content.slice(0, DEFAULT_CANDIDATE_OUTPUT_CHARS).trimEnd()}\n\n[Candidate output truncated at ${DEFAULT_CANDIDATE_OUTPUT_CHARS} characters.]`;
}

export function formatCandidate(candidate: CompareCandidateResult, reveal: boolean): string {
  const lines = [
    `Candidate ${candidate.blindId}`,
    `  status ${candidate.status}`,
    `  latency ${candidate.latencyMs}ms`,
  ];
  if (reveal) {
    lines.push(`  model ${candidate.model.registryKey} (${candidate.model.displayName})`);
  }
  if (candidate.status === 'failed') {
    lines.push(`  error ${reveal ? candidate.error ?? 'unknown' : 'Provider-specific error hidden until reveal.'}`);
    return lines.join('\n');
  }
  lines.push(`  stop ${candidate.stopReason ?? 'unknown'}`);
  lines.push(`  usage ${formatUsage(candidate.usage)}`);
  if ((candidate.toolCallCount ?? 0) > 0) lines.push(`  tool calls ${candidate.toolCallCount}`);
  lines.push('');
  lines.push(candidateContent(candidate.content));
  return lines.join('\n');
}

export function formatReveal(comparison: StoredComparison): string {
  return [
    `Blind model comparison reveal ${comparison.comparisonId}`,
    `created ${comparison.createdAt}`,
    `prompt ${comparison.promptPreview}`,
    ...(comparison.sourceArtifact ? [`source artifact ${comparison.sourceArtifact.artifactId} (${comparison.sourceArtifact.mimeType}, ${comparison.sourceArtifact.sizeBytes} bytes)`] : []),
    ...formatComparisonDimensionLines(comparison),
    ...(comparison.artifact ? [`artifact ${comparison.artifact.artifactId} (${comparison.artifact.mimeType}, ${comparison.artifact.sizeBytes} bytes)`] : []),
    '',
    ...comparison.candidates.map((candidate) => `${candidate.blindId}: ${candidate.model.registryKey} (${candidate.model.displayName})`),
  ].join('\n');
}

export function formatSavedComparisonArtifacts(artifactStore?: AgentModelCompareArtifactStore): string {
  if (!artifactStore?.list) {
    return 'Saved blind comparison artifacts are unavailable because the artifact store does not expose listing in this runtime.';
  }
  const artifacts = artifactStore.list(50)
    .filter(isModelCompareArtifact)
    .slice(0, 10);
  if (artifacts.length === 0) {
    return 'No saved blind comparison artifacts found. Run agent_model_compare mode:"run" first.';
  }
  return [
    'Saved blind comparison artifacts',
    ...artifacts.map((artifact) => {
      const comparisonId = readString(artifact.metadata.comparisonId) || 'unknown-comparison';
      const promptPreview = readString(artifact.metadata.promptPreview) || '(prompt unavailable)';
      const completed = typeof artifact.metadata.completedCandidates === 'number' ? artifact.metadata.completedCandidates : '?';
      const count = typeof artifact.metadata.candidateCount === 'number' ? artifact.metadata.candidateCount : '?';
      const dimensions = [
        readComparisonTag(artifact.metadata.benchmarkKind) ? `benchmark ${readComparisonTag(artifact.metadata.benchmarkKind)}` : null,
        readComparisonTag(artifact.metadata.taskType) ? `task ${readComparisonTag(artifact.metadata.taskType)}` : null,
        readComparisonTag(artifact.metadata.documentId) ? `document ${readComparisonTag(artifact.metadata.documentId)}` : null,
      ].filter(Boolean).join('; ');
      return `  ${artifact.id} ${comparisonId} candidates ${completed}/${count}${dimensions ? ` ${dimensions}` : ''} prompt ${promptPreview}`;
    }),
    '',
    'Review one with mode:"review" and artifactId, render related evidence with mode:"sideBySide", or reveal with mode:"reveal" after judging.',
  ].join('\n');
}

export function isModelCompareJudgmentArtifact(artifact: ArtifactDescriptor): boolean {
  const purpose = readString(artifact.metadata.purpose);
  if (purpose === 'agent-model-compare-judgment') return true;
  if (purpose) return false;
  return readString(artifact.filename).startsWith('blind-model-comparison-judgment-');
}

export function isModelCompareHandoffArtifact(artifact: ArtifactDescriptor): boolean {
  const purpose = readString(artifact.metadata.purpose);
  if (purpose === 'agent-model-compare-handoff') return true;
  if (purpose) return false;
  return readString(artifact.filename).startsWith('blind-model-comparison-handoff-');
}

export function isModelCompareRouteDecisionArtifact(artifact: ArtifactDescriptor): boolean {
  const purpose = readString(artifact.metadata.purpose);
  if (purpose === 'agent-model-compare-route-decision') return true;
  if (purpose) return false;
  return readString(artifact.filename).startsWith('blind-model-comparison-route-decision-');
}

export function formatSavedHandoffArtifacts(artifactStore?: AgentModelCompareArtifactStore): string {
  if (!artifactStore?.list) {
    return 'Saved blind comparison reviewer handoffs are unavailable because the artifact store does not expose listing in this runtime.';
  }
  const artifacts = artifactStore.list(50)
    .filter(isModelCompareHandoffArtifact)
    .slice(0, 10);
  if (artifacts.length === 0) {
    return 'No saved blind comparison reviewer handoffs found. Create one with mode:"handoff" first.';
  }
  return [
    'Saved blind comparison reviewer handoffs',
    ...artifacts.map((artifact) => {
      const handoffId = readString(artifact.metadata.handoffId) || 'unknown-handoff';
      const comparisonId = readString(artifact.metadata.comparisonId) || 'unknown-comparison';
      const sourceArtifactId = readString(artifact.metadata.sourceArtifactId) || '(missing source)';
      const sourceKind = readString(artifact.metadata.sourceKind) || 'unknown';
      const relatedArtifactIds = readStringList(artifact.metadata.relatedArtifactIds);
      return `  ${artifact.id} ${handoffId} comparison ${comparisonId} source ${sourceArtifactId} (${sourceKind}) related ${relatedArtifactIds.length}`;
    }),
    '',
    'Archive one with mode:"handoffArchive" and artifactId, compare two with mode:"handoffDiff" plus leftArtifactId/rightArtifactId.',
  ].join('\n');
}

export function formatArtifactStatus(comparison: StoredComparison): string {
  if (comparison.artifact) {
    const filename = comparison.artifact.filename ? ` ${comparison.artifact.filename}` : '';
    return `artifact ${comparison.artifact.artifactId}${filename} (${comparison.artifact.mimeType}, ${comparison.artifact.sizeBytes} bytes; includes full prompt, blinded outputs, and reveal map)`;
  }
  if (comparison.artifactStatus) return `artifact ${comparison.artifactStatus.message}`;
  return 'artifact not saved';
}

export function formatComparisonDimensionLines(comparison: StoredComparison): readonly string[] {
  const lines: string[] = [];
  if (comparison.benchmarkKind) lines.push(`benchmark ${comparison.benchmarkKind}`);
  if (comparison.taskType) lines.push(`task type ${comparison.taskType}`);
  if (comparison.documentId) lines.push(`document ${comparison.documentId}`);
  return lines;
}

export function formatIndentedContent(content: string): string {
  return candidateContent(content)
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

export function formatReviewCandidate(candidate: CompareCandidateResult, reveal: boolean): string {
  const lines = [
    `Candidate ${candidate.blindId}`,
    `  status ${candidate.status}`,
    `  latency ${candidate.latencyMs}ms`,
  ];
  if (reveal) lines.push(`  model ${candidate.model.registryKey} (${candidate.model.displayName})`);
  if (candidate.status === 'failed') {
    lines.push(`  error ${reveal ? candidate.error ?? 'unknown' : 'Provider-specific error hidden until reveal.'}`);
    return lines.join('\n');
  }
  lines.push(`  stop ${candidate.stopReason ?? 'unknown'}`);
  lines.push(`  usage ${formatUsage(candidate.usage)}`);
  lines.push('  output');
  lines.push(formatIndentedContent(candidate.content));
  return lines.join('\n');
}

export function formatReview(comparison: StoredComparison, reveal: boolean): string {
  const lines = [
    `Blind model comparison review ${comparison.comparisonId}`,
    `created ${comparison.createdAt}`,
    `prompt ${comparison.promptPreview}`,
    `rubric ${comparison.rubric || '(none)'}`,
    ...(comparison.sourceArtifact ? [`source artifact ${comparison.sourceArtifact.artifactId} (${comparison.sourceArtifact.mimeType}, ${comparison.sourceArtifact.sizeBytes} bytes)`] : []),
    ...formatComparisonDimensionLines(comparison),
    formatArtifactStatus(comparison),
    '',
    'Review board',
    ...comparison.candidates.flatMap((candidate, index) => [
      formatReviewCandidate(candidate, reveal),
      ...(index < comparison.candidates.length - 1 ? [''] : []),
    ]),
    '',
    'Decision worksheet',
    '  winner: (user chooses after reading the blinded outputs)',
    '  reasons: capture strengths, weaknesses, factuality, tone, and fit to rubric',
    '  route update: separate confirmed model-routing action only',
  ];
  if (reveal) {
    lines.push('');
    lines.push('Reveal');
    lines.push(...comparison.candidates.map((candidate) => `  ${candidate.blindId}: ${candidate.model.registryKey} (${candidate.model.displayName})`));
  } else {
    lines.push('');
    lines.push(`Identities hidden. Reveal after judging with mode:"reveal" and comparisonId:"${comparison.comparisonId}".`);
  }
  lines.push('No selected model was changed.');
  return lines.join('\n');
}

export function formatRunResult(comparison: StoredComparison, reveal: boolean): string {
  const completed = comparison.candidates.filter((candidate) => candidate.status === 'completed').length;
  const lines = [
    `Blind model comparison ${comparison.comparisonId}`,
    `created ${comparison.createdAt}`,
    `prompt ${comparison.promptPreview}`,
    `rubric ${comparison.rubric || '(none)'}`,
    ...(comparison.sourceArtifact ? [`source artifact ${comparison.sourceArtifact.artifactId} (${comparison.sourceArtifact.mimeType}, ${comparison.sourceArtifact.sizeBytes} bytes)`] : []),
    ...formatComparisonDimensionLines(comparison),
    `candidates ${comparison.candidates.length}; completed ${completed}; reveal ${reveal ? 'included' : 'hidden'}`,
    formatArtifactStatus(comparison),
    '',
    ...comparison.candidates.flatMap((candidate, index) => [
      formatCandidate(candidate, reveal),
      ...(index < comparison.candidates.length - 1 ? [''] : []),
    ]),
    '',
  ];
  if (reveal) {
    lines.push('Reveal');
    lines.push(...comparison.candidates.map((candidate) => `  ${candidate.blindId}: ${candidate.model.registryKey} (${candidate.model.displayName})`));
  } else {
    lines.push(`Identities hidden. Judge the outputs first, then call agent_model_compare with mode:"reveal" and comparisonId:"${comparison.comparisonId}".`);
  }
  lines.push('No selected model was changed.');
  return lines.join('\n');
}

export function formatPreview(
  args: AgentModelCompareToolArgs,
  refs: readonly string[],
  candidateCount: number,
): string {
  const benchmarkKind = readBenchmarkKind(args.benchmarkKind);
  const taskType = readComparisonTag(args.taskType);
  const documentId = readComparisonTag(args.documentId);
  return [
    'Agent blind model comparison preview',
    `  prompt ${previewText(readString(args.prompt) || '(missing)')}`,
    ...(readString(args.artifactId) ? [`  source artifact ${readString(args.artifactId)}`] : []),
    `  candidates ${refs.length > 0 ? refs.length : candidateCount}`,
    `  selection ${refs.length > 0 ? 'user supplied model refs' : 'auto-select from selectable models'}`,
    `  rubric ${previewText(readString(args.rubric) || '(none)')}`,
    ...(benchmarkKind ? [`  benchmark ${benchmarkKind}`] : []),
    ...(taskType ? [`  task type ${taskType}`] : []),
    ...(documentId ? [`  document ${documentId}`] : []),
    `  reveal ${readBoolean(args.reveal) ? 'immediate' : 'delayed'}`,
    `  artifact ${readOptionalBoolean(args.saveArtifact, true) ? 'save local JSON review' : 'do not save'}`,
    '  policy model comparison sends the same prompt to each candidate and requires confirm:true plus explicitUserRequest',
  ].join('\n');
}

export function parseMode(value: unknown): 'run' | 'reveal' | 'review' | 'sideBySide' | 'judge' | 'apply' | 'routeDecision' | 'export' | 'handoff' | 'handoffArchive' | 'handoffDiff' | 'analytics' | 'synthesis' {
  const mode = readString(value) || MODE_RUN;
  if (
    mode === MODE_RUN
    || mode === MODE_REVEAL
    || mode === MODE_REVIEW
    || mode === MODE_SIDE_BY_SIDE
    || mode === MODE_JUDGE
    || mode === MODE_APPLY
    || mode === MODE_ROUTE_DECISION
    || mode === MODE_EXPORT
    || mode === MODE_HANDOFF
    || mode === MODE_HANDOFF_ARCHIVE
    || mode === MODE_HANDOFF_DIFF
    || mode === MODE_ANALYTICS
    || mode === MODE_SYNTHESIS
  ) return mode;
  throw new Error('mode must be run, reveal, review, sideBySide, judge, apply, routeDecision, export, handoff, handoffArchive, handoffDiff, analytics, or synthesis.');
}

export function rememberComparison(store: Map<string, StoredComparison>, comparison: StoredComparison): void {
  store.set(comparison.comparisonId, comparison);
  while (store.size > COMPARISON_STORE_LIMIT) {
    const oldest = store.keys().next().value as string | undefined;
    if (!oldest) break;
    store.delete(oldest);
  }
}

export function toArtifactCandidate(candidate: CompareCandidateResult): Record<string, unknown> {
  return {
    blindId: candidate.blindId,
    status: candidate.status,
    content: candidate.content,
    latencyMs: candidate.latencyMs,
    ...(candidate.stopReason ? { stopReason: candidate.stopReason } : {}),
    ...(candidate.usage ? { usage: candidate.usage } : {}),
    ...(typeof candidate.toolCallCount === 'number' ? { toolCallCount: candidate.toolCallCount } : {}),
    ...(candidate.error ? { error: candidate.error } : {}),
    model: {
      registryKey: candidate.model.registryKey,
      providerId: candidate.model.providerId,
      modelId: candidate.model.modelId,
      displayName: candidate.model.displayName,
      current: candidate.model.current,
    },
  };
}

export function toArtifactCandidateLatencyMetadata(candidate: CompareCandidateResult): Record<string, unknown> {
  return {
    blindId: candidate.blindId,
    status: candidate.status,
    latencyMs: candidate.latencyMs,
    registryKey: candidate.model.registryKey,
    providerId: candidate.model.providerId,
    modelId: candidate.model.modelId,
    displayName: candidate.model.displayName,
  };
}

export function comparisonArtifactText(input: {
  readonly comparison: StoredComparison;
  readonly prompt: string;
  readonly systemPrompt: string;
  readonly maxTokens: number;
  readonly revealIncludedInTranscript: boolean;
  readonly benchmarkKind?: string;
}): string {
  return `${JSON.stringify({
    schema: 'goodvibes.agent.model_compare.v1',
    comparisonId: input.comparison.comparisonId,
    createdAt: input.comparison.createdAt,
    prompt: input.prompt,
    promptPreview: input.comparison.promptPreview,
    ...(input.comparison.sourceArtifact ? { sourceArtifact: input.comparison.sourceArtifact } : {}),
    ...(input.comparison.documentId ? { documentId: input.comparison.documentId } : {}),
    ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
    maxTokens: input.maxTokens,
    rubric: input.comparison.rubric,
    ...(input.benchmarkKind ? { benchmarkKind: input.benchmarkKind } : {}),
    ...(input.comparison.taskType ? { taskType: input.comparison.taskType } : {}),
    revealIncludedInTranscript: input.revealIncludedInTranscript,
    reviewFlow: {
      blindFirst: true,
      revealInstruction: `Call agent_model_compare with mode:"reveal" and comparisonId:"${input.comparison.comparisonId}".`,
      routeMutation: 'none',
    },
    candidates: input.comparison.candidates.map(toArtifactCandidate),
  }, null, 2)}\n`;
}

export function toSavedComparisonArtifact(descriptor: ArtifactDescriptor): SavedComparisonArtifact {
  const documentId = readString(descriptor.metadata.documentId);
  return {
    artifactId: descriptor.id,
    ...(descriptor.filename ? { filename: descriptor.filename } : {}),
    mimeType: descriptor.mimeType,
    sizeBytes: descriptor.sizeBytes,
    ...(documentId ? { documentId } : {}),
  };
}

export async function loadRunSourceArtifact(
  artifactStore: AgentModelCompareArtifactStore | undefined,
  artifactId: string,
): Promise<{ readonly artifact: SavedComparisonArtifact; readonly promptBlock: string }> {
  if (!artifactStore?.readContent) {
    throw new Error('Saved artifact comparison requires an artifact store with readContent support.');
  }
  const { record, buffer } = await artifactStore.readContent(artifactId);
  if (!isTextLike(record.mimeType)) {
    throw new Error(`Saved artifact ${record.id} is ${record.mimeType}; blind comparison can only inline text-like artifacts.`);
  }
  const sliced = buffer.subarray(0, Math.min(buffer.byteLength, MAX_SOURCE_ARTIFACT_BYTES));
  const text = sliced.toString('utf-8').replace(/\0/g, '').trim();
  const lines = [
    'Saved artifact context',
    `Artifact ID: ${record.id}`,
    `Filename: ${record.filename ?? '(none)'}`,
    `MIME: ${record.mimeType}`,
    '',
    text || '(empty text artifact)',
  ];
  if (buffer.byteLength > sliced.byteLength) {
    lines.push('', `[Artifact content truncated at ${MAX_SOURCE_ARTIFACT_BYTES} bytes.]`);
  }
  return {
    artifact: toSavedComparisonArtifact(record),
    promptBlock: lines.join('\n'),
  };
}

export async function buildRunPromptFromArtifact(input: {
  readonly artifactStore?: AgentModelCompareArtifactStore;
  readonly prompt: string;
  readonly artifactId: string;
}): Promise<{ readonly prompt: string; readonly sourceArtifact?: SavedComparisonArtifact }> {
  if (!input.artifactId) return { prompt: input.prompt };
  const loaded = await loadRunSourceArtifact(input.artifactStore, input.artifactId);
  const instruction = input.prompt || 'Compare model responses using the saved artifact context below.';
  return {
    prompt: [instruction, '', loaded.promptBlock].join('\n'),
    sourceArtifact: loaded.artifact,
  };
}

export async function saveComparisonArtifact(input: {
  readonly artifactStore?: AgentModelCompareArtifactStore;
  readonly comparison: StoredComparison;
  readonly prompt: string;
  readonly systemPrompt: string;
  readonly maxTokens: number;
  readonly revealIncludedInTranscript: boolean;
  readonly enabled: boolean;
  readonly benchmarkKind?: string;
}): Promise<{
  readonly artifact?: SavedComparisonArtifact;
  readonly status: ComparisonArtifactStatus;
}> {
  if (!input.enabled) {
    return { status: { state: 'disabled', message: 'not saved (saveArtifact false)' } };
  }
  if (!input.artifactStore) {
    return { status: { state: 'unavailable', message: 'not saved (artifact store unavailable)' } };
  }
  try {
    const descriptor = await input.artifactStore.create({
      kind: 'data',
      mimeType: 'application/json',
      filename: `blind-model-comparison-${input.comparison.comparisonId}.json`,
      text: comparisonArtifactText(input),
      metadata: {
        purpose: 'agent-model-compare',
        comparisonId: input.comparison.comparisonId,
        promptPreview: input.comparison.promptPreview,
        ...(input.comparison.sourceArtifact ? { sourceArtifactId: input.comparison.sourceArtifact.artifactId } : {}),
        ...(input.comparison.documentId ? { documentId: input.comparison.documentId } : {}),
        candidateCount: input.comparison.candidates.length,
        completedCandidates: input.comparison.candidates.filter((candidate) => candidate.status === 'completed').length,
        candidateLatencyEvidence: input.comparison.candidates.map(toArtifactCandidateLatencyMetadata),
        ...(input.benchmarkKind ? { benchmarkKind: input.benchmarkKind } : {}),
        ...(input.comparison.taskType ? { taskType: input.comparison.taskType } : {}),
        revealStored: true,
        revealIncludedInTranscript: input.revealIncludedInTranscript,
      },
    });
    return {
      artifact: toSavedComparisonArtifact(descriptor),
      status: { state: 'saved', message: `saved as ${descriptor.id}` },
    };
  } catch (error) {
    return {
      status: {
        state: 'failed',
        message: `not saved (${error instanceof Error ? error.message : String(error)})`,
      },
    };
  }
}

export function isModelCompareArtifact(artifact: ArtifactDescriptor): boolean {
  const purpose = readString(artifact.metadata.purpose);
  if (purpose === 'agent-model-compare') return true;
  if (purpose) return false;
  return readString(artifact.filename).startsWith('blind-model-comparison-cmp_');
}

export function parseArtifactUsage(value: unknown): ChatResponse['usage'] | undefined {
  const record = readRecord(value);
  if (!record) return undefined;
  const inputTokens = readNumber(record.inputTokens, Number.NaN);
  const outputTokens = readNumber(record.outputTokens, Number.NaN);
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return undefined;
  return {
    inputTokens,
    outputTokens,
    ...(typeof record.cacheReadTokens === 'number' ? { cacheReadTokens: record.cacheReadTokens } : {}),
    ...(typeof record.cacheWriteTokens === 'number' ? { cacheWriteTokens: record.cacheWriteTokens } : {}),
  };
}

export function parseArtifactCandidate(value: unknown, index: number): CompareCandidateResult | null {
  const candidate = readRecord(value);
  if (!candidate) return null;
  const model = readRecord(candidate.model) ?? {};
  const blindId = readString(candidate.blindId) || BLIND_LABELS[index] || String(index + 1);
  const status = readString(candidate.status) === 'failed' ? 'failed' : 'completed';
  return {
    blindId,
    status,
    content: readString(candidate.content),
    latencyMs: Math.max(0, readNumber(candidate.latencyMs, 0)),
    ...(readString(candidate.stopReason) ? { stopReason: readString(candidate.stopReason) } : {}),
    ...(parseArtifactUsage(candidate.usage) ? { usage: parseArtifactUsage(candidate.usage) } : {}),
    ...(typeof candidate.toolCallCount === 'number' ? { toolCallCount: Math.max(0, Math.trunc(candidate.toolCallCount)) } : {}),
    ...(readString(candidate.error) ? { error: readString(candidate.error) } : {}),
    model: {
      registryKey: readString(model.registryKey) || `artifact:${blindId}`,
      providerId: readString(model.providerId) || 'artifact',
      modelId: readString(model.modelId) || blindId,
      displayName: readString(model.displayName) || readString(model.modelId) || blindId,
      current: model.current === true,
    },
  };
}

export function parseComparisonArtifactPayload(
  value: unknown,
  artifact: SavedComparisonArtifact,
): StoredComparison | null {
  const payload = readRecord(value);
  if (!payload || readString(payload.schema) !== 'goodvibes.agent.model_compare.v1') return null;
  const rawCandidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  const candidates = rawCandidates
    .map(parseArtifactCandidate)
    .filter((candidate): candidate is CompareCandidateResult => candidate !== null);
  if (candidates.length === 0) return null;
  const prompt = readString(payload.prompt);
  const sourceArtifact = readRecord(payload.sourceArtifact);
  const sourceArtifactId = readString(sourceArtifact?.artifactId);
  const sourceDocumentId = readString(sourceArtifact?.documentId);
  const documentId = readString(payload.documentId) || sourceDocumentId;
  const benchmarkKind = readComparisonTag(payload.benchmarkKind);
  const taskType = readComparisonTag(payload.taskType);
  return {
    comparisonId: readString(payload.comparisonId) || `cmp_from_${artifact.artifactId}`,
    createdAt: readString(payload.createdAt) || new Date().toISOString(),
    promptPreview: readString(payload.promptPreview) || previewText(prompt || '(prompt unavailable)', 160),
    rubric: readString(payload.rubric),
    ...(sourceArtifactId ? {
      sourceArtifact: {
        artifactId: sourceArtifactId,
        ...(readString(sourceArtifact?.filename) ? { filename: readString(sourceArtifact?.filename) } : {}),
        mimeType: readString(sourceArtifact?.mimeType) || 'application/octet-stream',
        sizeBytes: Math.max(0, readNumber(sourceArtifact?.sizeBytes, 0)),
        ...(sourceDocumentId ? { documentId: sourceDocumentId } : {}),
      },
    } : {}),
    ...(benchmarkKind ? { benchmarkKind } : {}),
    ...(taskType ? { taskType } : {}),
    ...(documentId ? { documentId } : {}),
    candidates,
    artifact,
    artifactStatus: { state: 'saved', message: `loaded from ${artifact.artifactId}` },
  };
}

export async function loadComparisonFromArtifact(
  artifactStore: AgentModelCompareArtifactStore | undefined,
  artifactId: string,
): Promise<StoredComparison | null> {
  if (!artifactStore?.readContent) return null;
  const { record, buffer } = await artifactStore.readContent(artifactId);
  const artifact = toSavedComparisonArtifact(record);
  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.toString('utf-8')) as unknown;
  } catch {
    return null;
  }
  return parseComparisonArtifactPayload(parsed, artifact);
}

export async function resolveComparisonForRead(input: {
  readonly artifactStore?: AgentModelCompareArtifactStore;
  readonly comparisons: Map<string, StoredComparison>;
  readonly comparisonId: string;
  readonly artifactId: string;
}): Promise<StoredComparison | null> {
  if (input.comparisonId) {
    const inMemory = input.comparisons.get(input.comparisonId);
    if (inMemory) return inMemory;
    const artifact = input.artifactStore?.list?.(100)
      .filter(isModelCompareArtifact)
      .find((entry) => readString(entry.metadata.comparisonId) === input.comparisonId);
    if (artifact) return loadComparisonFromArtifact(input.artifactStore, artifact.id);
  }
  if (input.artifactId) return loadComparisonFromArtifact(input.artifactStore, input.artifactId);
  return null;
}

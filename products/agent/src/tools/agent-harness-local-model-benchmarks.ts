import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { captureJudgmentPort } from '@goodvibes-jev/engine/errors';
import { prepareJudgmentResult } from '@goodvibes-jev/engine/sdk/platform/gate';
import { localBenchmarkPrompt, localBenchmarkPromptPolicy, routingRegistry } from '@goodvibes-jev/engine/sdk/platform/routing';
import { assertProjectionCurrent, ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import type { ArtifactDescriptor, ArtifactRecord } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import { previewHarnessText } from './agent-harness-text.ts';
import { localStackFor } from './agent-harness-local-model-endpoints.ts';
import type { LocalModelBenchmarkEvidence, LocalModelBenchmarkPlan, LocalModelBenchmarkRouteLatency, LocalModelBenchmarkWinner, LocalModelRecipe, ArtifactListLike } from './agent-harness-model-routing-types.ts';
import { captureCatalogMethods } from './agent-harness-catalog-ranking.ts';
import { assertModelReadingInputCurrent, captureModelArtifactClockSource, captureModelArtifactClockSources, captureModelReadingInput, modelReadingServicePath, withModelReadingSource, type ModelReadingOptions } from './agent-harness-model-reading-source.ts';
import { readRecord, readString } from './agent-harness-model-routing-utils.ts';
import { personalOpsEntry } from './agent-harness-personal-ops-source.ts';

export interface BenchmarkArtifactContext {
  readonly platform: { readonly artifactStore?: ArtifactListLike | null | undefined };
}

export function isLocalModelBenchmarkArtifact(artifact: ArtifactDescriptor): boolean {
  const purpose = readString(artifact.metadata.purpose);
  if (purpose !== 'agent-model-compare') return false;
  return readString(artifact.metadata.benchmarkKind) === 'local-model-route';
}

export function isModelCompareJudgmentArtifact(artifact: ArtifactDescriptor): boolean {
  return readString(artifact.metadata.purpose) === 'agent-model-compare-judgment';
}

export function benchmarkCreatedAt(artifact: ArtifactDescriptor): string | null {
  const timestamp = typeof artifact.createdAt === 'number' ? artifact.createdAt : null;
  return timestamp == null ? null : new Date(timestamp).toISOString();
}

export function describeLocalBenchmarkArtifact(artifact: ArtifactDescriptor): Record<string, unknown> {
  const routeLatencies = localBenchmarkRouteLatenciesForArtifact(artifact);
  return {
    artifactId: artifact.id,
    ...(artifact.filename ? { filename: artifact.filename } : {}),
    createdAt: benchmarkCreatedAt(artifact),
    comparisonId: readString(artifact.metadata.comparisonId) || null,
    promptPreview: previewHarnessText(readString(artifact.metadata.promptPreview) || 'local model benchmark', 120),
    candidateCount: artifact.metadata.candidateCount ?? null,
    completedCandidates: artifact.metadata.completedCandidates ?? null,
    ...(routeLatencies.length > 0 ? {
      routeLatencies: routeLatencies.map((entry) => ({
        registryKey: entry.registryKey,
        latencyMs: entry.latencyMs,
        status: entry.status,
        blindId: entry.blindId,
      })),
    } : {}),
    benchmarkKind: readString(artifact.metadata.benchmarkKind) || 'local-model-route',
    reviewRoute: `agent_model_compare review artifactId:"${artifact.id}"`,
    revealRoute: `agent_model_compare reveal artifactId:"${artifact.id}"`,
  };
}

export function describeLocalBenchmarkJudgment(artifact: ArtifactDescriptor, winnerStack: string | null = null): Record<string, unknown> {
  const winnerModel = readString(artifact.metadata.winnerModel);
  const sourceArtifactId = readString(artifact.metadata.sourceArtifactId);
  return {
    artifactId: artifact.id,
    ...(artifact.filename ? { filename: artifact.filename } : {}),
    createdAt: benchmarkCreatedAt(artifact),
    judgmentId: readString(artifact.metadata.judgmentId) || null,
    comparisonId: readString(artifact.metadata.comparisonId) || null,
    sourceArtifactId: sourceArtifactId || null,
    winnerBlindId: readString(artifact.metadata.winnerBlindId) || null,
    revealIncludedInJudgment: artifact.metadata.revealIncludedInJudgment === true,
    winnerModel: winnerModel || null,
    winnerStack,
    promptPreview: previewHarnessText(readString(artifact.metadata.promptPreview) || 'local model benchmark judgment', 120),
    analyticsRoute: 'agent_model_compare analytics benchmarkKind:"local-model-route" includeReasons:true',
    exportRoute: `agent_model_compare export artifactId:"${artifact.id}" confirm:true explicitUserRequest:"Export this local benchmark judgment."`,
    applyRoute: winnerModel
      ? `agent_model_compare apply artifactId:"${artifact.id}" confirm:true explicitUserRequest:"Apply this revealed local benchmark winner."`
      : null,
  };
}

function readLatencyMs(value: unknown): number | null {
  const numberValue = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(numberValue) && numberValue >= 0 ? Math.round(numberValue) : null;
}

export function localBenchmarkRouteLatenciesForArtifact(artifact: ArtifactDescriptor): readonly LocalModelBenchmarkRouteLatency[] {
  const evidence = artifact.metadata.candidateLatencyEvidence;
  if (!Array.isArray(evidence)) return [];
  const comparisonId = readString(artifact.metadata.comparisonId) || null;
  const createdAt = benchmarkCreatedAt(artifact);
  return evidence.map((entry, index) => {
    const record = readRecord(entry);
    const registryKey = readString(record.registryKey);
    const latencyMs = readLatencyMs(record.latencyMs);
    if (!registryKey || latencyMs == null) return null;
    const blindId = readString(record.blindId) || String.fromCharCode(65 + index);
    return {
      registryKey,
      providerId: readString(record.providerId),
      modelId: readString(record.modelId) || registryKey,
      displayName: readString(record.displayName) || registryKey,
      blindId,
      latencyMs,
      status: readString(record.status) || 'unknown',
      artifactId: artifact.id,
      comparisonId,
      createdAt,
      reviewRoute: `agent_model_compare review artifactId:"${artifact.id}"`,
    };
  }).filter((entry): entry is LocalModelBenchmarkRouteLatency => entry !== null);
}

export function localBenchmarkRouteLatencies(artifacts: readonly ArtifactDescriptor[]): readonly LocalModelBenchmarkRouteLatency[] {
  const byRoute = new Map<string, LocalModelBenchmarkRouteLatency>();
  for (const artifact of artifacts) {
    for (const latency of localBenchmarkRouteLatenciesForArtifact(artifact)) {
      const current = byRoute.get(latency.registryKey);
      if (!current) {
        byRoute.set(latency.registryKey, latency);
        continue;
      }
      const currentTime = current.createdAt ? Date.parse(current.createdAt) : 0;
      const candidateTime = latency.createdAt ? Date.parse(latency.createdAt) : 0;
      if (candidateTime > currentTime || (candidateTime === currentTime && latency.latencyMs < current.latencyMs)) {
        byRoute.set(latency.registryKey, latency);
      }
    }
  }
  return [...byRoute.values()].sort((left, right) => left.registryKey.localeCompare(right.registryKey));
}

export function localBenchmarkRouteLatencyMap(context: BenchmarkArtifactContext): ReadonlyMap<string, LocalModelBenchmarkRouteLatency> {
  const store = context.platform.artifactStore ?? null;
  if (!store?.list) return new Map();
  const artifacts = store.list(100).filter(isLocalModelBenchmarkArtifact);
  return new Map(localBenchmarkRouteLatencies(artifacts).map((entry) => [entry.registryKey, entry]));
}

export function localBenchmarkEvidence(
  comparisons: readonly ArtifactDescriptor[],
  judgments: readonly ArtifactDescriptor[],
  storeAvailable: boolean,
  stacks: ReadonlyMap<string, string | null> = new Map(),
): LocalModelBenchmarkEvidence {
  if (!storeAvailable) {
    return {
      status: 'unavailable',
      comparisonCount: 0,
      completedCandidateCount: 0,
      revealedJudgmentCount: 0,
      hiddenJudgmentCount: 0,
      winnerStacks: [],
      winnerModels: [],
      routeLatencies: [],
      summary: 'Artifact history is unavailable in this runtime.',
      confidence: 'estimated',
    };
  }
  const winnerModels: LocalModelBenchmarkWinner[] = [];
  let hiddenJudgmentCount = 0;
  for (const judgment of judgments) {
    const winnerModel = readString(judgment.metadata.winnerModel);
    if (!winnerModel) {
      hiddenJudgmentCount += 1;
      continue;
    }
    const sourceArtifactId = readString(judgment.metadata.sourceArtifactId);
    winnerModels.push({
      judgmentArtifactId: judgment.id,
      sourceArtifactId: sourceArtifactId || null,
      registryKey: winnerModel,
      stack: stacks.get(judgment.id) ?? null,
      promptPreview: previewHarnessText(readString(judgment.metadata.promptPreview) || 'local model benchmark judgment', 120),
      reviewRoute: sourceArtifactId
        ? `agent_model_compare review artifactId:"${sourceArtifactId}"`
        : 'agent_model_compare review',
      exportRoute: `agent_model_compare export artifactId:"${judgment.id}" confirm:true explicitUserRequest:"Export this local benchmark judgment."`,
      applyRoute: `agent_model_compare apply artifactId:"${judgment.id}" confirm:true explicitUserRequest:"Apply this revealed local benchmark winner."`,
    });
  }
  const winnerStacks = [...new Set(winnerModels.map((winner) => winner.stack).filter((stack): stack is string => Boolean(stack)))].sort((a, b) => a.localeCompare(b));
  const completedCandidateCount = comparisons.reduce((total, artifact) => {
    const value = artifact.metadata.completedCandidates;
    return total + (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  }, 0);
  const routeLatencies = localBenchmarkRouteLatencies(comparisons);
  const status: LocalModelBenchmarkEvidence['status'] = winnerModels.length > 0
    ? 'reviewed-winner'
    : comparisons.length > 0
      ? 'comparison-saved'
      : 'unmeasured';
  return {
    status,
    comparisonCount: comparisons.length,
    completedCandidateCount,
    revealedJudgmentCount: winnerModels.length,
    hiddenJudgmentCount,
    winnerStacks,
    winnerModels,
    routeLatencies,
    summary: winnerModels.length > 0
      ? `Reviewed benchmark winner(s): ${winnerModels.map((winner) => winner.registryKey).join(', ')}.`
      : comparisons.length > 0
        ? 'Saved local benchmark comparison exists; save a revealed judgment before route recommendations.'
        : 'No saved local benchmark comparison has been recorded yet.',
    confidence: winnerModels.length > 0 ? 'measured' : 'estimated',
  };
}

export interface LocalBenchmarkMembership {
  readonly artifactId: string;
  readonly outcome: 'act' | 'hold';
  readonly verdict: 'yes' | 'no' | 'unknown';
  readonly decisionId?: string | undefined;
  readonly reason?: string | undefined;
}
export interface LocalModelBenchmarkSnapshot {
  readonly storeAvailable: boolean;
  readonly comparisons: readonly ArtifactDescriptor[];
  readonly judgments: readonly ArtifactDescriptor[];
  readonly stacks: readonly { readonly artifactId: string; readonly stack: string | null }[];
  readonly membership: readonly LocalBenchmarkMembership[];
}
export interface LocalModelBenchmarkHistory extends Record<string, unknown> {
  readonly evidence: LocalModelBenchmarkEvidence;
}
interface CompleteBenchmarkArtifact {
  readonly descriptor: ArtifactDescriptor;
  readonly record: ArtifactRecord;
  readonly content: string;
}

/** Startup snapshots credit native typed declarations and exact links only. */
export function localModelBenchmarkSnapshot(context: BenchmarkArtifactContext): LocalModelBenchmarkSnapshot {
  const store = context.platform.artifactStore ?? null;
  if (!store?.list) return { storeAvailable: false, comparisons: [], judgments: [], stacks: [], membership: [] };
  const allArtifacts = store.list(100);
  const comparisons = allArtifacts.filter(isLocalModelBenchmarkArtifact);
  const ids = new Set(comparisons.map(artifact => artifact.id));
  const judgments = allArtifacts.filter(artifact => isModelCompareJudgmentArtifact(artifact)
    && ids.has(readString(artifact.metadata.sourceArtifactId)));
  return { storeAvailable: true, comparisons, judgments, stacks: [], membership: [] };
}

export function localBenchmarkRouteLatencyMapFor(snapshot: LocalModelBenchmarkSnapshot): ReadonlyMap<string, LocalModelBenchmarkRouteLatency> {
  return new Map(localBenchmarkRouteLatencies(snapshot.comparisons).map(entry => [entry.registryKey, entry]));
}

export function localModelBenchmarkHistoryFrom(snapshot: LocalModelBenchmarkSnapshot, includeParameters: boolean): LocalModelBenchmarkHistory {
  if (!snapshot.storeAvailable) return {
    status: 'unavailable', count: 0, reason: 'Artifact history is unavailable in this runtime.',
    saveRoute: 'agent_model_compare run benchmarkKind:"local-model-route" taskType:"local-model-route" confirm:true explicitUserRequest:"..."',
    evidence: localBenchmarkEvidence([], [], false),
  };
  const artifacts = snapshot.comparisons.slice(0, includeParameters ? 10 : 3);
  const judgments = snapshot.judgments.slice(0, includeParameters ? 10 : 3);
  const stacks = new Map(snapshot.stacks.map(entry => [entry.artifactId, entry.stack]));
  const evidence = localBenchmarkEvidence(artifacts, judgments, true, stacks);
  return {
    status: artifacts.length > 0 ? 'history-found' : 'no-history', count: artifacts.length,
    artifacts: artifacts.map(describeLocalBenchmarkArtifact),
    judgments: judgments.map(artifact => describeLocalBenchmarkJudgment(artifact, stacks.get(artifact.id) ?? null)),
    evidence, membership: snapshot.membership,
    nextAction: artifacts.length > 0
      ? evidence.status === 'reviewed-winner'
        ? 'Use the revealed saved judgment as evidence only; apply/update still needs a separate confirmed user request.'
        : `Review saved local benchmark ${artifacts[0]!.id}, then save a revealed judgment before recommending any default-model change.`
      : 'Run the setupPlan benchmark prompt and save the comparison artifact before recommending any default-model change.',
    analyticsRoute: 'agent_model_compare analytics benchmarkKind:"local-model-route" includeReasons:true',
    saveRoute: 'agent_model_compare run benchmarkKind:"local-model-route" taskType:"local-model-route" confirm:true explicitUserRequest:"..."',
    policy: 'Benchmark history is read-only evidence. Unmarked artifacts need a settled complete-source membership reading; held readings credit no evidence. Route changes still require a separate revealed judgment and confirmed apply/update action.',
  };
}

export function localModelBenchmarkHistory(context: BenchmarkArtifactContext, includeParameters: boolean): LocalModelBenchmarkHistory {
  return localModelBenchmarkHistoryFrom(localModelBenchmarkSnapshot(context), includeParameters);
}

function benchmarkReadingSource(source: CompleteBenchmarkArtifact) {
  return { descriptor: captureModelArtifactClockSource(source.descriptor).reading,
    record: captureModelArtifactClockSource(source.record).reading, content: source.content };
}

async function readBenchmarkMembership(source: { readonly artifact: ReturnType<typeof benchmarkReadingSource> }, options: ModelReadingOptions): Promise<LocalBenchmarkMembership> {
  localBenchmarkPromptPolicy.assertCurrent();
  return withModelReadingSource(source, options, async (state, scoped) => {
    assertProjectionCurrent(scoped.assertCurrent);
    const assertRegistry = captureCatalogMethods(routingRegistry, ['get']);
    const getDecision = routingRegistry.get; assertRegistry();
    if (getDecision.call(routingRegistry, localBenchmarkPrompt.name) !== localBenchmarkPrompt) throw new ToolInputProjectionError('unavailable');
    const assertDefinitionSlots = captureCatalogMethods(localBenchmarkPrompt,
      ['name', 'version', 'description', 'accuracyFloor', 'model', 'items', 'fixtures', 'fixtureCount', 'checkFixtures', 'run']);
    const definition = { name: localBenchmarkPrompt.name, version: localBenchmarkPrompt.version, description: localBenchmarkPrompt.description,
      accuracyFloor: localBenchmarkPrompt.accuracyFloor, model: localBenchmarkPrompt.model, items: localBenchmarkPrompt.items, fixtures: localBenchmarkPrompt.fixtures };
    const capturedDefinition = captureModelReadingInput(definition);
    const installation = captureJudgmentPort(localBenchmarkPrompt.name, { signal: scoped.signal, prepareResultCapture: prepareJudgmentResult });
    let assertInstallation = installation.assertCurrent;
    const assertBackendBindings = () => {
      localBenchmarkPromptPolicy.assertCurrent();
      assertRegistry(); assertDefinitionSlots(); assertModelReadingInputCurrent(definition, JSON.stringify(capturedDefinition)); assertInstallation();
    };
    const assertBackend = () => {
      assertBackendBindings();
      if (getDecision.call(routingRegistry, localBenchmarkPrompt.name) !== localBenchmarkPrompt) throw new ToolInputProjectionError('held');
      assertBackendBindings();
    };
    scoped.retainCurrent?.(assertBackend);
    const assertCurrent = () => { scoped.signal?.throwIfAborted(); assertProjectionCurrent(scoped.assertCurrent); assertBackend(); };
    const port = installation.port, recorder = port.recorder;
    const guardedPort: JudgmentPort = { model: port.model, ...(recorder ? { recorder: {
      recordReadings: (...args: Parameters<typeof recorder.recordReadings>) => { assertCurrent(); recorder.recordReadings(...args); assertCurrent(); },
      recordAction: (...args: Parameters<typeof recorder.recordAction>) => { assertCurrent(); recorder.recordAction(...args); assertCurrent(); },
    } } : {}), ask: async request => {
      assertCurrent();
      const result = await port.ask({ ...request,
        beforeAttempt: () => { assertProjectionCurrent(request.beforeAttempt); assertCurrent(); },
        assertLogCurrent: () => { assertProjectionCurrent(request.assertLogCurrent); assertCurrent(); },
      });
      assertCurrent(); return result;
    } };
    try {
      const result = await localBenchmarkPrompt.run(guardedPort, personalOpsEntry(state),
        { site: localBenchmarkPrompt.name, ...(scoped.signal ? { signal: scoped.signal } : {}) });
      assertCurrent();
      const reading = result.readings.member;
      const verdict = reading.outcome === 'act' && (reading.verdict === 'yes' || reading.verdict === 'no') ? reading.verdict : 'unknown';
      result.recordAction(verdict === 'yes' ? 'local benchmark history membership admitted'
        : verdict === 'no' ? 'local benchmark history membership rejected' : 'local benchmark history membership held');
      assertCurrent();
      return { artifactId: state.artifact.descriptor.id, outcome: verdict === 'unknown' ? 'hold' : 'act',
        verdict, decisionId: result.result.decisionId };
    } finally {
      const observation = installation.consumeObservation(); assertInstallation = observation.assertCurrent; assertBackend();
    }
  });
}

function benchmarkArtifactDescriptor(record: ArtifactDescriptor): ArtifactDescriptor {
  return { id: record.id, kind: record.kind, mimeType: record.mimeType, filename: record.filename,
    sizeBytes: record.sizeBytes, sha256: record.sha256, createdAt: record.createdAt,
    ...(typeof record.expiresAt === 'number' ? { expiresAt: record.expiresAt } : {}),
    ...(typeof record.sourceUri === 'string' ? { sourceUri: record.sourceUri } : {}),
    acquisitionMode: record.acquisitionMode, fetchMode: record.fetchMode, metadata: record.metadata };
}

/** Explicit readers preserve the whole native artifact and its source/store owner. */
export async function readLocalModelBenchmarkSnapshot(context: BenchmarkArtifactContext, options: ModelReadingOptions): Promise<LocalModelBenchmarkSnapshot> {
  const assertOptions = captureCatalogMethods(options, ['signal', 'sourceOwner', 'assertCurrent', 'retainCurrent']);
  const signal = options.signal, originalAssert = options.assertCurrent;
  const assertCaller = () => { assertOptions(); signal?.throwIfAborted(); assertProjectionCurrent(originalAssert); assertOptions(); signal?.throwIfAborted(); };
  assertCaller(); localBenchmarkPromptPolicy.assertCurrent();
  const nativeStore = modelReadingServicePath(context, ['platform', 'artifactStore']);
  const store = context.platform.artifactStore ?? null;
  const assertStoreSlots = store ? captureCatalogMethods(store, ['list', 'readContent']) : () => {};
  const list = store?.list, readContent = store?.readContent;
  const originalArtifacts = list?.call(store, 100) ?? [];
  const artifactSources = captureModelArtifactClockSources(originalArtifacts);
  captureModelReadingInput(artifactSources.reading);
  const allArtifacts = artifactSources.native, serialized = JSON.stringify(allArtifacts);
  const loaded = new Map<string, CompleteBenchmarkArtifact>();
  const contentGuards: (() => void)[] = [];
  const assertNativeBindings = () => {
    localBenchmarkPromptPolicy.assertCurrent();
    assertOptions(); signal?.throwIfAborted(); assertStoreSlots();
    if (modelReadingServicePath(context, ['platform', 'artifactStore']) !== nativeStore
      || options.signal !== signal || options.assertCurrent !== originalAssert) throw new ToolInputProjectionError('held');
    assertModelReadingInputCurrent(originalArtifacts, serialized);
  };
  const assertNativeCurrent = () => {
    assertNativeBindings();
    if (list) assertModelReadingInputCurrent(list.call(store, 100), serialized);
    for (const guard of contentGuards) guard();
    assertNativeBindings();
  };
  const assertCurrent = () => { assertCaller(); assertNativeCurrent(); };
  assertCurrent(); options.retainCurrent?.(assertNativeCurrent);
  if (!list) return { storeAvailable: false, comparisons: [], judgments: [], stacks: [], membership: [] };
  const load = async (artifact: ArtifactDescriptor): Promise<CompleteBenchmarkArtifact | undefined> => {
    assertCurrent(); const existing = loaded.get(artifact.id); if (existing) return existing;
    if (!readContent) return undefined;
    const result = await readContent.call(store, artifact.id); assertCurrent();
    const assertResultSlots = captureCatalogMethods(result, ['record', 'buffer']); assertResultSlots();
    const record = captureModelArtifactClockSource(result.record).native, bytes = result.buffer;
    if (nodeTypes.isProxy(bytes) || !Buffer.isBuffer(bytes) || record.id !== artifact.id
      || record.sizeBytes !== bytes.byteLength || record.sha256 !== createHash('sha256').update(bytes).digest('hex')) throw new ToolInputProjectionError('held');
    assertModelReadingInputCurrent(benchmarkArtifactDescriptor(record), JSON.stringify(benchmarkArtifactDescriptor(artifact)));
    const savedBytes = Buffer.from(bytes);
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(savedBytes);
    const source = Object.freeze({ descriptor: artifact, record, content });
    captureModelReadingInput(benchmarkReadingSource(source));
    const serializedRecord = JSON.stringify(record);
    contentGuards.push(() => {
      assertResultSlots();
      assertModelReadingInputCurrent(result.record, serializedRecord);
      if (!Buffer.prototype.equals.call(bytes, savedBytes)) throw new ToolInputProjectionError('held');
    });
    loaded.set(artifact.id, source); assertCurrent(); return source;
  };
  const comparisons: ArtifactDescriptor[] = [], judgments: ArtifactDescriptor[] = [], membership: LocalBenchmarkMembership[] = [];
  const readUnmarked = async (artifact: ArtifactDescriptor): Promise<boolean> => {
    const source = options.sourceOwner ? await load(artifact) : undefined; assertCurrent();
    if (!source) { membership.push({ artifactId: artifact.id, outcome: 'hold', verdict: 'unknown',
      reason: options.sourceOwner ? 'complete-artifact-source-unavailable' : 'protected-source-owner-unavailable' }); return false; }
    const result = await readBenchmarkMembership({ artifact: benchmarkReadingSource(source) }, { ...options, assertCurrent }); assertCurrent();
    membership.push(result); return result.outcome === 'act' && result.verdict === 'yes';
  };
  for (const artifact of allArtifacts) {
    if (readString(artifact.metadata.purpose) !== 'agent-model-compare') continue;
    if (isLocalModelBenchmarkArtifact(artifact) || await readUnmarked(artifact)) comparisons.push(artifact);
    assertCurrent();
  }
  const comparisonIds = new Set(comparisons.map(artifact => artifact.id));
  for (const artifact of allArtifacts) {
    if (!isModelCompareJudgmentArtifact(artifact)) continue;
    const sourceArtifactId = readString(artifact.metadata.sourceArtifactId);
    if ((sourceArtifactId && comparisonIds.has(sourceArtifactId)) || await readUnmarked(artifact)) judgments.push(artifact);
    assertCurrent();
  }
  const stacks: { artifactId: string; stack: string | null }[] = [];
  for (const artifact of judgments) {
    const winnerModel = readString(artifact.metadata.winnerModel);
    if (!winnerModel || !options.sourceOwner) continue;
    const source = await load(artifact); assertCurrent();
    if (!source) { stacks.push({ artifactId: artifact.id, stack: null }); continue; }
    const stack = await localStackFor(winnerModel, { ...options, assertCurrent }, benchmarkReadingSource(source)); assertCurrent();
    stacks.push({ artifactId: artifact.id, stack });
  }
  // Every descriptor is the detached native snapshot already screened through
  // its typed clock projection. Keep raw epochs for native consumers without
  // reclassifying those producer clocks as borrowed payment material.
  const result: LocalModelBenchmarkSnapshot = Object.freeze({ storeAvailable: true,
    comparisons: Object.freeze(comparisons), judgments: Object.freeze(judgments),
    stacks: captureModelReadingInput(stacks), membership: captureModelReadingInput(membership) });
  assertCurrent(); return result;
}

export async function readLocalModelBenchmarkHistory(context: BenchmarkArtifactContext, includeParameters: boolean, options: ModelReadingOptions): Promise<LocalModelBenchmarkHistory> {
  const snapshot = await readLocalModelBenchmarkSnapshot(context, options);
  options.signal?.throwIfAborted(); assertProjectionCurrent(options.assertCurrent); localBenchmarkPromptPolicy.assertCurrent();
  const result = localModelBenchmarkHistoryFrom(snapshot, includeParameters);
  localBenchmarkPromptPolicy.assertCurrent(); return result;
}

export function localModelBenchmarkPlan(recipe: LocalModelRecipe): LocalModelBenchmarkPlan {
  return {
    status: 'plan-ready',
    prompt: [
      'Benchmark this local route on one practical task:',
      '1. summarize the current project goal in five bullets,',
      '2. identify one likely setup risk,',
      '3. propose one next action with a command or route.',
    ].join(' '),
    measurements: [
      'time to first useful token',
      'total response latency',
      'whether the answer followed the requested structure',
      'whether the model handled project-specific nouns without hallucinating',
      'whether the route supports the needed context window and tool workflow',
    ],
    workspaceActionRoute: 'agent_harness mode:"run_workspace_action" actionId:"account-run-local-model-benchmark" confirm:true fields.confirm:"yes" fields.modelRefs:"<local-route>,<baseline-route>" explicitUserRequest:"Compare this local model route before making it default."',
    compareRoute: `agent_model_compare run prompt:"local model benchmark: ${recipe.label}" benchmarkKind:"local-model-route" taskType:"local-model-route" confirm:true explicitUserRequest:"Compare this local model route before making it default."`,
    refreshRoute: 'agent_harness mode:"run_command" command:"/refresh-models" confirm:true explicitUserRequest:"Refresh model catalog, benchmarks, and token limits after local model setup."',
    notes: [
      'Use the workspace action when the user wants a form with benchmark defaults; use compareRoute when the model already has exact modelRefs.',
      'Run the same prompt against the local route and a baseline route before selecting a winner.',
      'Keep benchmark notes in the saved comparison artifact before changing the default model.',
      'Do not treat cached public benchmark scores as a substitute for this local latency and fit check.',
    ],
  };
}

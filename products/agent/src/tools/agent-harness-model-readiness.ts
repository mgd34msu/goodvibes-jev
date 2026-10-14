import { captureCatalogMethods } from './agent-harness-catalog-ranking.ts';
import { arch, cpus, freemem, platform, totalmem } from 'node:os';
import { captureJudgmentPort } from '@goodvibes-jev/engine/errors';
import { prepareJudgmentResult } from '@goodvibes-jev/engine/sdk/platform/gate';
import { routingRegistry, routeReadiness, localRecipeFit, routeReadinessFrom, localRecipeFitFrom } from '@goodvibes-jev/engine/sdk/platform/routing';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { CommandContext } from '../input/command-registry.ts';
import { readProviderHealthSignal } from './agent-harness-model-provider-health.ts';
import { listProviderRegistryProviders } from './agent-harness-model-catalog.ts';
import { captureModelReadingInput, captureModelReadingSnapshotGuard, modelReadingServicePath, withModelReadingSource, type ModelReadingOptions } from './agent-harness-model-reading-source.ts';
import type { LocalModelBenchmarkEvidence, LocalModelDetection, LocalModelHardwareProfile, LocalModelRecipe, LocalModelRecipeFit, ModelCandidate, ModelReadinessDimension, ModelReadinessScore, ModelRouteReadinessScore } from './agent-harness-model-routing-types.ts';
import { readRecord } from './agent-harness-model-routing-utils.ts';

export function localRecipeStackId(recipe: LocalModelRecipe): string {
  return recipe.id === 'openai-compatible-local' ? 'openai-compatible' : recipe.id === 'llama-cpp' ? 'llama.cpp' : recipe.id;
}
export function roundGb(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.max(0, Math.round((bytes / 1024 / 1024 / 1024) * 10) / 10);
}
/** Raw local facts. Adequacy belongs to the recipe-specific reading. */
export function localHardwareProfile(): LocalModelHardwareProfile {
  const cpuList = cpus(), runtimePlatform = platform(), runtimeArch = arch();
  return {
    platform: runtimePlatform, arch: runtimeArch, cpuModel: cpuList[0]?.model ?? 'unknown CPU', cpuThreads: cpuList.length,
    ramGb: roundGb(totalmem()), freeRamGb: roundGb(freemem()),
    acceleratorHint: runtimePlatform === 'darwin' && runtimeArch === 'arm64' ? 'apple-silicon'
      : (process.env.CUDA_VISIBLE_DEVICES || process.env.NVIDIA_VISIBLE_DEVICES) ? 'cuda-env' : 'none-detected',
    privacy: 'local-only',
    caveat: 'Hardware scan uses local OS memory/CPU data and safe accelerator hints only; it does not probe drivers, download models, or benchmark live inference.',
  };
}
export function capabilityEnabled(capabilities: unknown, key: 'toolCalling' | 'multimodal'): boolean | null {
  const value = readRecord(capabilities)[key];
  return typeof value === 'boolean' ? value : null;
}
const RUBRIC = 'General Agent work: sustained interactive assistance with project context, reliable tool use, occasional image input, tolerable observed response latency and cost, and accurately disclosed prompt-data transfer. Readiness is advisory only and cannot override route availability, model limits, private-address checks, permissions, or confirmed apply actions.';
const NEXT_STEP = 'Inspect missing evidence and run a separately confirmed task-specific benchmark before changing any model route.';

export function deferredModelReadiness(reason = 'Readiness enrichment has not run.'): ModelReadinessScore {
  return { score: null, level: null, outcome: 'deferred', confidence: null, decisionId: null, provenance: null,
    cloudTransfer: null, dimensions: [], missingSignals: [reason], nextStep: NEXT_STEP };
}
export function deferredRecipeFit(): LocalModelRecipeFit {
  return { score: null, level: null, outcome: 'deferred', confidence: null, decisionId: null, memoryTier: null,
    provenance: null, reasons: ['Recipe-fit enrichment has not run.'] };
}

const batteryDefinitions = new WeakMap<object, () => void>();
const getBatteryDefinition = batteryDefinitions.get.bind(batteryDefinitions);
const setBatteryDefinition = batteryDefinitions.set.bind(batteryDefinitions);

/** Retain the exact native definition once; every reuse still validates it. */
function batteryDefinitionGuard(battery: typeof routeReadiness | typeof localRecipeFit): () => void {
  const existing = getBatteryDefinition(battery);
  if (existing) { existing(); return existing; }
  const assertRegistry = captureCatalogMethods(routingRegistry, ['get']);
  const get = routingRegistry.get;
  const assertSlots = captureCatalogMethods(battery, ['name', 'version', 'items', 'composite', 'run']);
  assertSlots();
  const values = { name: battery.name, version: battery.version, items: battery.items, composite: battery.composite };
  captureModelReadingInput(values);
  const assertValues = captureModelReadingSnapshotGuard(values, true);
  const assertCurrent = () => {
    assertRegistry(); assertSlots(); assertValues(values);
    if (Reflect.apply(get, routingRegistry, [values.name]) !== battery) throw new ToolInputProjectionError('held');
    assertRegistry(); assertSlots(); assertValues(values);
  };
  assertCurrent(); setBatteryDefinition(battery, assertCurrent);
  return assertCurrent;
}

function readinessAuthority(battery: typeof routeReadiness | typeof localRecipeFit, scoped: ModelReadingOptions) {
  const assertDefinition = batteryDefinitionGuard(battery);
  scoped.retainCurrent?.(assertDefinition, battery.name);
  return captureJudgmentPort(battery.name, {
    signal: scoped.signal, prepareResultCapture: prepareJudgmentResult,
    assertCurrent: () => { scoped.assertCurrent?.(); assertDefinition(); },
  });
}
function retainReadinessAuthority(authority: ReturnType<typeof captureJudgmentPort>, scoped: ModelReadingOptions) {
  const restriction = authority.consumeObservation();
  scoped.retainCurrent?.(restriction.assertCurrent);
  restriction.assertCurrent();
}

/** Acquire neither a battery nor a port until full-source screening settles. */
async function readRoute(source: unknown, options: ModelReadingOptions) {
  return withModelReadingSource(source, options, async (state, scoped) => {
    scoped.assertCurrent?.();
    const decision = routingRegistry.get('agent.models.route-readiness');
    if (!decision || typeof modelReadingServicePath(decision, ['run']) !== 'function') return routeReadinessFrom(null);
    const battery = decision as typeof routeReadiness;
    const authority = readinessAuthority(battery, scoped);
    try {
      const run = await battery.run(authority.port, state as unknown as Parameters<typeof battery.run>[1], {
        site: battery.name, signal: authority.signal, beforeAttempt: authority.assertCurrent,
        only: ['latency', 'contextWindow', 'toolSupport', 'vision', 'cost', 'privacy', 'cloudTransfer'],
      });
      authority.assertCurrent();
      const result = routeReadinessFrom(run);
      authority.assertCurrent(); return result;
    } finally { retainReadinessAuthority(authority, scoped); }
  });
}

function described(reading: ReturnType<typeof routeReadinessFrom>, missing: ReadonlyMap<ModelReadinessDimension['id'], string>): ModelReadinessScore {
  const dimensions: ModelReadinessDimension[] = reading.dimensions.map(dimension => ({
    ...dimension, ...(missing.has(dimension.id) ? { score: null, normalized: null, outcome: 'deferred' as const, confidence: null } : {}),
    summary: missing.get(dimension.id) ?? dimension.reason ?? 'Settled rubric reading.',
  }));
  const settled = reading.outcome === 'ready' && missing.size === 0;
  return { ...reading, confidence: settled ? reading.confidence : null, score: settled ? reading.score : null, normalized: settled ? reading.normalized : null, level: settled ? reading.level : null,
    cloudTransfer: missing.has('privacy') ? { ...reading.cloudTransfer, value: null, probability: null, confidence: null, outcome: 'deferred' } : reading.cloudTransfer,
    outcome: reading.outcome === 'ready' && !settled ? 'deferred' : reading.outcome,
    dimensions, missingSignals: [...missing.values()], nextStep: NEXT_STEP };
}

export async function modelReadinessScore(context: CommandContext, model: ModelCandidate, options: ModelReadingOptions = {}): Promise<ModelRouteReadinessScore> {
  const rawHealth = readProviderHealthSignal(context, model.providerId, model.registryKey);
  // Freeform error previews are not semantic evidence. Complete originals are
  // screened by the invocation owner; these fields are omitted from the rubric.
  const { lastErrorMessage: _lastErrorMessage, ...providerHealth } = rawHealth;
  const provider = listProviderRegistryProviders(context).find(value => {
    const facts = readRecord(value); return facts.id === model.providerId || facts.providerId === model.providerId || facts.name === model.providerId;
  }) ?? null;
  const healthLatency = providerHealth.status === 'record-found' && ['healthy', 'degraded'].includes(providerHealth.healthStatus ?? '') && providerHealth.measuredRouteId === model.registryKey && providerHealth.measuredProviderId === model.providerId
    && typeof providerHealth.avgLatencyMs === 'number' && providerHealth.avgLatencyMs >= 0 && providerHealth.measurementRecordedAt && Number.isFinite(Date.parse(providerHealth.measurementRecordedAt))
    ? { milliseconds: providerHealth.avgLatencyMs, routeId: providerHealth.measuredRouteId, recordedAt: providerHealth.measurementRecordedAt, sourceRecordId: providerHealth.sourceRecordId, source: 'provider-health' } : null;
  const benchmark = model.localBenchmarkLatency;
  const benchmarkLatency = benchmark && benchmark.registryKey === model.registryKey && benchmark.providerId === model.providerId
    && benchmark.status === 'completed' && Number.isFinite(benchmark.latencyMs) && benchmark.latencyMs >= 0
    && benchmark.createdAt && Number.isFinite(Date.parse(benchmark.createdAt)) ? benchmark : null;
  const latency = healthLatency ?? benchmarkLatency;
  const missing = new Map<ModelReadinessDimension['id'], string>();
  if (!latency) missing.set('latency', 'No successful route-specific latency measurement with a timestamp is available.');
  if (model.contextWindow == null || model.contextWindow <= 0) missing.set('context-window', 'Context-window metadata is missing.');
  if (capabilityEnabled(model.capabilities, 'toolCalling') == null) missing.set('tool-support', 'Tool-calling capability is unknown.');
  if (capabilityEnabled(model.capabilities, 'multimodal') == null) missing.set('vision', 'Vision capability is unknown.');
  if (!model.tier) missing.set('cost', 'Cost evidence is missing.');
  const providerFacts = readRecord(provider);
  const providerConfig = readRecord(providerFacts.config);
  const hasEndpointFacts = [providerFacts.baseUrl, providerFacts.baseURL, providerFacts.api, providerFacts.endpoint, providerConfig.baseUrl, providerConfig.baseURL].some(value => {
    if (typeof value !== 'string' || !value.trim()) return false;
    try { const url = new URL(value); return url.protocol === 'http:' || url.protocol === 'https:'; } catch { return false; }
  });
  const hasHostingFacts = hasEndpointFacts || [providerFacts.hosting, providerFacts.documentation, providerFacts.setupDescription, providerFacts.anonymousDetail].some(value => typeof value === 'string' && value.trim().length > 0);
  if (!hasHostingFacts) missing.set('privacy', 'Provider and endpoint facts are missing; a route name is not hosting evidence.');
  if (!options.sourceOwner) return { ...deferredModelReadiness('Readiness source screening is unavailable.'), outcome: 'unavailable', providerHealth };
  const reading = await readRoute({ subject: model, rubric: RUBRIC, capabilities: model.capabilities, contextWindow: model.contextWindow,
    cost: { tier: model.tier ?? null }, provider, measuredLatency: latency, benchmarkQuality: model.benchmarkCompositeScore ?? null,
    providerHealth, missingSignals: [...missing.values()] }, options);
  const result = described(reading, missing);
  if (model.available === false || model.configured === false || providerHealth.isConfigured === false || providerFacts.available === false || providerFacts.isAvailable === false || providerFacts.configured === false || providerFacts.isConfigured === false) {
    return { ...result, score: null, normalized: null, level: null, confidence: null, outcome: 'unavailable',
      missingSignals: [...result.missingSignals, 'This provider or model is unavailable or unconfigured.'], providerHealth };
  }
  return { ...result, providerHealth };
}

export async function localRecipeReadinessScore(recipe: LocalModelRecipe, fit: LocalModelRecipeFit, detected: boolean,
  evidence: LocalModelBenchmarkEvidence, options: ModelReadingOptions = {}): Promise<ModelReadinessScore> {
  if (!options.sourceOwner) return deferredModelReadiness();
  // These are names only: no capability evidence exists to send to a reader.
  // Keep the missing evidence explicit in the compound readiness input.
  const exampleVision = recipe.modelExamples.map(example => ({
    example, value: null, probability: null, confidence: null, decisionId: null, provenance: null, outcome: 'deferred',
    reason: 'No advertised capability or documentation is supplied for this example.',
  }));
  const reading = await readRoute({ subject: recipe, rubric: RUBRIC, detected, benchmarkEvidence: evidence,
    localFit: fit.outcome === 'ready' ? fit : null, exampleVision, provider: null,
    capabilities: null, contextWindow: null, measuredLatency: null, cost: null }, options);
  const missing = new Map<ModelReadinessDimension['id'], string>([
    ['latency', 'Recipe examples have no measured latency for an exact configured route.'],
    ['context-window', 'Verify the context window of the exact model served.'],
    ['tool-support', 'Verify tool calling on the exact model and server.'],
    ['vision', 'Example names do not establish advertised vision capability.'],
    ['cost', 'Recipe identity does not establish the cost of a configured route.'],
    ['privacy', 'Recipe identity does not establish the endpoint or prompt-data transfer policy.'],
  ]);
  return { ...described(reading, missing), exampleVision };
}

export async function scoreLocalModelRecipe(recipe: LocalModelRecipe, hardware: LocalModelHardwareProfile, detection: LocalModelDetection,
  options: ModelReadingOptions = {}): Promise<LocalModelRecipeFit> {
  if (!options.sourceOwner) return deferredRecipeFit();
  return withModelReadingSource({ recipe, hardware, detection, rubric: RUBRIC }, options, async (state, scoped) => {
    const decision = routingRegistry.get('agent.models.local-recipe-fit');
    if (!decision || typeof modelReadingServicePath(decision, ['run']) !== 'function') return { ...deferredRecipeFit(), outcome: 'unavailable' };
    const battery = decision as typeof localRecipeFit;
    const authority = readinessAuthority(battery, scoped);
    try {
      const run = await battery.run(authority.port, state as unknown as Parameters<typeof battery.run>[1], {
        site: battery.name, signal: authority.signal, beforeAttempt: authority.assertCurrent,
      });
      authority.assertCurrent(); const reading = localRecipeFitFrom(run);
      return { ...reading, reasons: reading.outcome === 'ready' ? ['Settled hardware and recipe-requirements reading.'] : ['Hardware fit is unsettled.'] };
    } finally { retainReadinessAuthority(authority, scoped); }
  });
}

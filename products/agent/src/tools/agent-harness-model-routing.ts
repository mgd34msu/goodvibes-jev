import { arch, cpus, freemem, platform, totalmem } from 'node:os';
import type { ArtifactDescriptor } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import type { CommandContext } from '../input/command-registry.ts';
import { requireProviderApi } from '../input/commands/runtime-services.ts';
import { previewHarnessText } from './agent-harness-text.ts';
import { readLocalModelCookbook, localModelCookbook } from './agent-harness-local-model-cookbook.ts';
import { localBenchmarkRouteLatencyMap } from './agent-harness-local-model-benchmarks.ts';
import { localModelDetection, localModelServerEndpoints, localModelServerHealthMap } from './agent-harness-local-model-endpoints.ts';
import { runLocalModelServerSmoke } from './agent-harness-local-model-smoke.ts';
import { localHardwareProfile, modelReadinessScore } from './agent-harness-model-readiness.ts';
import { contextWindowFor, loadModels, listProviderIds, modelBenchmarkCompositeScore, modelBenchmarkQualityTier, modelAvailable, modelConfigured, modelCapabilities, modelCurrent, modelDisplayName, modelModelId, modelProviderId, modelReasoning, modelRegistryKey, modelTier, readConfig, readProviderApi } from './agent-harness-model-catalog.ts';
import type { AgentHarnessModelRoutingArgs, LocalModelServerEndpoint, ModelCandidate, ModelProviderHealthSignal, ModelRouteLookupSource, ModelRouteResolution, RouteCandidate } from './agent-harness-model-routing-types.ts';
import type { ModelReadingOptions } from './agent-harness-model-reading-source.ts';
import { readLimit, readString } from './agent-harness-model-routing-utils.ts';
export type { AgentHarnessModelRoutingArgs } from './agent-harness-model-routing-types.ts';
export { localModelCookbook } from './agent-harness-local-model-cookbook.ts';
export { runLocalModelServerSmoke } from './agent-harness-local-model-smoke.ts';

async function readCurrentModel(context: CommandContext): Promise<unknown> {
  try {
    return await readProviderApi(context)?.getCurrentModel() ?? null;
  } catch {
    return null;
  }
}

function attachLocalBenchmarkLatencies(context: CommandContext, models: readonly ModelCandidate[]): readonly ModelCandidate[] {
  const latencies = localBenchmarkRouteLatencyMap(context);
  if (latencies.size === 0) return models;
  return models.map((model) => ({
    ...model,
    localBenchmarkLatency: latencies.get(model.registryKey) ?? null,
  }));
}

function routeCandidates(context: CommandContext): readonly RouteCandidate[] {
  return [
    {
      kind: 'route',
      id: 'main',
      label: 'Main conversation model',
      detail: 'Provider/model route for normal Agent chat turns.',
      currentValue: {
        provider: context.session.runtime.provider,
        model: context.session.runtime.model,
        reasoningEffort: context.session.runtime.reasoningEffort || readConfig(context, 'provider.reasoningEffort') || null,
      },
      settingKeys: ['provider.model', 'provider.reasoningEffort'],
      commands: ['/model', '/provider', '/effort'],
      uiSurfaces: ['model-picker', 'provider-picker', 'reasoning-effort-picker'],
    },
    {
      kind: 'route',
      id: 'embedding-provider',
      label: 'Embedding provider',
      detail: 'Provider used for embedding-backed Agent features.',
      currentValue: readConfig(context, 'provider.embeddingProvider') ?? null,
      settingKeys: ['provider.embeddingProvider'],
      commands: ['/settings provider.embeddingProvider'],
      uiSurfaces: ['settings'],
    },
    {
      kind: 'route',
      id: 'system-prompt',
      label: 'System prompt file',
      detail: 'Agent-owned system prompt file route for the serial conversation.',
      currentValue: readConfig(context, 'provider.systemPromptFile') || null,
      settingKeys: ['provider.systemPromptFile'],
      commands: ['/settings provider.systemPromptFile'],
      uiSurfaces: ['settings'],
    },
    {
      kind: 'route',
      id: 'helper-model',
      label: 'Helper model route',
      detail: 'Optional helper-model route for Agent-owned helper operations.',
      currentValue: {
        enabled: readConfig(context, 'helper.enabled') ?? null,
        provider: readConfig(context, 'helper.globalProvider') ?? null,
        model: readConfig(context, 'helper.globalModel') ?? null,
      },
      settingKeys: ['helper.enabled', 'helper.globalProvider', 'helper.globalModel'],
      commands: ['/settings helper.enabled', '/settings helper.globalProvider', '/settings helper.globalModel'],
      uiSurfaces: ['settings'],
    },
    {
      kind: 'route',
      id: 'tool-llm',
      label: 'Tool LLM route',
      detail: 'Optional provider/model route for tool-assist operations.',
      currentValue: {
        enabled: readConfig(context, 'tools.llmEnabled') ?? null,
        provider: readConfig(context, 'tools.llmProvider') ?? null,
        model: readConfig(context, 'tools.llmModel') ?? null,
      },
      settingKeys: ['tools.llmEnabled', 'tools.llmProvider', 'tools.llmModel'],
      commands: ['/settings tools.llmEnabled', '/settings tools.llmProvider', '/settings tools.llmModel'],
      uiSurfaces: ['settings'],
    },
    {
      kind: 'route',
      id: 'catalog-refresh',
      label: 'Model catalog refresh',
      detail: 'Provider catalog, benchmark, and token-limit refresh route.',
      currentValue: 'available',
      settingKeys: [],
      commands: ['/refresh-models'],
      uiSurfaces: ['model-picker'],
    },
    {
      kind: 'route',
      id: 'local-model-cookbook',
      label: 'Local model cookbook',
      detail: 'Hardware-aware recommendations for Ollama, llama.cpp, vLLM, and local OpenAI-compatible servers.',
      currentValue: {
        detected: localModelDetection(context),
        hardwareProfile: localHardwareProfile(),
        localServerHealth: localModelServerHealthMap(context, false),
      },
      settingKeys: [],
      commands: ['/provider add <name> <baseURL> [apiKey] --yes', '/refresh-models', '/model'],
      uiSurfaces: ['provider-picker', 'model-picker', 'settings'],
    },
    {
      kind: 'route',
      id: 'pinned-models',
      label: 'Pinned model favorites',
      detail: 'Local model favorites used by the model picker.',
      currentValue: 'see model entries where pinned is true',
      settingKeys: [],
      commands: ['/pin', '/unpin'],
      uiSurfaces: ['model-picker'],
    },
    {
      kind: 'route',
      id: 'custom-providers',
      label: 'Custom provider files',
      detail: 'Agent-local OpenAI-compatible provider add/remove route.',
      currentValue: 'workspace controlled',
      settingKeys: [],
      commands: ['/provider add <name> <baseURL> [apiKey] --yes', '/provider remove <name> --yes'],
      uiSurfaces: ['settings', 'provider-picker'],
    },
  ];
}

function lookupFromArgs(args: AgentHarnessModelRoutingArgs): { readonly source: ModelRouteLookupSource; readonly input: string } | null {
  const modelRouteId = readString(args.modelRouteId);
  if (modelRouteId) return { source: 'modelRouteId', input: modelRouteId };
  const target = readString(args.target);
  if (target) return { source: 'target', input: target };
  const query = readString(args.query);
  return query ? { source: 'query', input: query } : null;
}

function routeSearchText(route: RouteCandidate): string {
  return [
    route.id,
    route.label,
    route.detail,
    ...route.settingKeys,
    ...route.commands,
    ...route.uiSurfaces,
    JSON.stringify(route.currentValue),
  ].join('\n').toLowerCase();
}

function modelSearchText(model: ModelCandidate): string {
  return [
    model.registryKey,
    model.modelId,
    model.providerId,
    model.displayName,
    model.current ? 'current selected active' : '',
    model.pinned ? 'pinned favorite' : '',
    ...model.reasoningEffort,
    JSON.stringify(model.capabilities),
  ].join('\n').toLowerCase();
}

function localEndpointSearchText(endpoint: LocalModelServerEndpoint): string {
  return [
    endpoint.id,
    endpoint.providerId ?? '',
    endpoint.stack ?? '',
    endpoint.baseUrl,
    endpoint.modelsUrl,
    endpoint.diagnosticStatus,
    ...endpoint.sources,
    ...endpoint.sourceDetails,
    ...endpoint.modelRoutes,
    ...endpoint.notes,
  ].join('\n').toLowerCase();
}

function describeLocalServerEndpointRoute(endpoint: LocalModelServerEndpoint, lookup?: Record<string, unknown>): Record<string, unknown> {
  return {
    ...endpoint,
    ...(lookup ? { lookup } : {}),
    modelRouteId: endpoint.id,
    label: `Local model server ${endpoint.baseUrl}`,
    modelRoute: endpoint.inspectRoute,
    modelAccess: {
      smoke: endpoint.smokeRoute,
      refresh: endpoint.refreshRoute,
      addProvider: endpoint.addProviderRoute,
      cookbook: 'models action:"local" includeParameters:true',
    },
    policy: endpoint.diagnostics?.policy ?? 'Read-only local model endpoint inspection. The smoke test, refresh, provider add, benchmark, and route changes remain separate visible confirmed actions.',
  };
}

async function describeRoute(route: RouteCandidate, options: { readonly context: CommandContext; readonly includeParameters?: boolean; readonly lookup?: Record<string, unknown>; readonly reading?: ModelReadingOptions; readonly cookbook?: Record<string, unknown> }): Promise<Record<string, unknown>> {
  return {
    kind: 'route',
    modelRouteId: route.id,
    label: route.label,
    ...(options.includeParameters ? { detail: route.detail } : { summary: previewHarnessText(route.detail) }),
    currentValue: route.currentValue,
    settingKeys: route.settingKeys,
    modelRoute: modelRoutingModelRoute(),
    ...(options.includeParameters ? {
      commands: route.commands,
      uiSurfaces: route.uiSurfaces,
    } : {}),
    ...(options.lookup ? { lookup: options.lookup } : {}),
    ...(route.id === 'local-model-cookbook' && options.includeParameters === true ? { localCookbook: options.cookbook ?? (options.reading?.sourceOwner ? await readLocalModelCookbook(options.context, true, options.reading) : localModelCookbook(options.context, true)) } : {}),
    ...(options.includeParameters ? {
      policy: {
        effect: 'read-only',
        values: 'Model routing posture returns model ids, provider ids, route state, capabilities, and safe setting keys only; provider credentials are never returned.',
        mutation: 'Model/provider selection, catalog refresh, favorites, custom provider edits, and route setting changes stay explicit user-facing picker, settings, workspace, or slash-command flows.',
      },
      modelAccess: {
        inspectRouting: 'models action:"status"',
        inspectRoute: 'agent_harness mode:"model_route"',
        settingRead: 'settings action:"get"',
        settingMutation: 'settings action:"set" confirm:true explicitUserRequest:"..."',
        openModelPicker: 'agent_harness mode:"open_ui_surface" surfaceId:"model-picker" confirm:true explicitUserRequest:"..."',
        openProviderPicker: 'agent_harness mode:"open_ui_surface" surfaceId:"provider-picker" confirm:true explicitUserRequest:"..."',
      },
    } : {}),
  };
}

function compactProviderHealthSignal(signal: ModelProviderHealthSignal): Record<string, unknown> {
  return {
    status: signal.status,
    sdkContract: signal.sdkContract,
    daemonPublication: signal.daemonPublication,
    agentConsumption: signal.agentConsumption,
    ...(signal.healthStatus ? { healthStatus: signal.healthStatus } : {}),
    ...(signal.modelRouteId ? { modelRouteId: signal.modelRouteId } : {}),
    ...(signal.sourceRecordId ? { sourceRecordId: signal.sourceRecordId } : {}),
    ...(signal.avgLatencyMs !== undefined ? { avgLatencyMs: signal.avgLatencyMs } : {}),
    ...(signal.rateLimitRemaining !== undefined ? { rateLimitRemaining: signal.rateLimitRemaining } : {}),
    ...(signal.rateLimitResetAt ? { rateLimitResetAt: signal.rateLimitResetAt } : {}),
    missingSignals: signal.missingSignals,
    policy: signal.policy,
  };
}

async function describeModel(model: ModelCandidate, options: { readonly context: CommandContext; readonly includeParameters?: boolean; readonly lookup?: Record<string, unknown>; readonly reading?: ModelReadingOptions }): Promise<Record<string, unknown>> {
  const readiness = await modelReadinessScore(options.context, model, options.reading);
  options.reading?.assertCurrent?.();
  return {
    kind: 'model',
    modelRouteId: model.registryKey,
    registryKey: model.registryKey,
    modelId: model.modelId,
    providerId: model.providerId,
    displayName: model.displayName,
    current: model.current,
    pinned: model.pinned,
    available: model.available ?? null,
    configured: model.configured ?? null,
    contextWindow: model.contextWindow,
    reasoningEffort: model.reasoningEffort,
    tier: model.tier ?? null,
    benchmarkCompositeScore: model.benchmarkCompositeScore ?? null,
    benchmarkQualityTier: model.benchmarkQualityTier ?? null,
    localBenchmarkLatency: model.localBenchmarkLatency ?? null,
    readinessScore: readiness.score,
    readinessLevel: readiness.level,
    readiness: options.includeParameters
      ? readiness
      : {
        score: readiness.score,
        level: readiness.level,
        confidence: readiness.confidence,
        outcome: readiness.outcome,
        decisionId: readiness.decisionId,
        providerHealth: compactProviderHealthSignal(readiness.providerHealth),
        nextStep: readiness.nextStep,
      },
    modelRoute: modelCandidateModelRoute(),
    ...(options.lookup ? { lookup: options.lookup } : {}),
    ...(options.includeParameters ? {
      capabilities: model.capabilities,
      policy: {
        effect: 'read-only',
        mutation: 'Selecting this model stays a visible picker, settings, workspace, or slash-command flow with explicit user request.',
      },
      modelAccess: {
        selectModelCommand: `/model ${model.registryKey}`,
        selectProviderCommand: `/provider ${model.providerId}`,
        pinCommand: `/pin ${model.registryKey}`,
        unpinCommand: `/unpin ${model.registryKey}`,
        setMainModel: `settings action:"set" key:"provider.model" value:"${model.registryKey}" confirm:true explicitUserRequest:"..."`,
      },
    } : {}),
  };
}

function describeCandidate(entry: RouteCandidate | ModelCandidate): Record<string, unknown> {
  if (entry.kind === 'route') {
    return {
      kind: 'route',
      modelRouteId: entry.id,
      label: entry.label,
      modelRoute: modelRoutingModelRoute(),
    };
  }
  return {
    kind: 'model',
    modelRouteId: entry.registryKey,
    providerId: entry.providerId,
    displayName: entry.displayName,
    current: entry.current,
    pinned: entry.pinned,
    modelRoute: modelCandidateModelRoute(),
  };
}

function describeEndpointCandidate(endpoint: LocalModelServerEndpoint): Record<string, unknown> {
  return {
    kind: endpoint.kind,
    modelRouteId: endpoint.id,
    baseUrl: endpoint.baseUrl,
    stack: endpoint.stack,
    diagnosticStatus: endpoint.diagnosticStatus,
    modelRoute: endpoint.inspectRoute,
  };
}

function modelRoutingModelRoute(): string {
  return 'models action:"route" or action:"smoke"';
}

function modelCandidateModelRoute(): string {
  return 'agent_harness mode:"run_command" command:"/model"';
}

export async function modelRoutingCatalogStatus(context: CommandContext): Promise<Record<string, unknown>> {
  const [rawModels, providerIds] = await Promise.all([
    loadModels(context),
    Promise.resolve(listProviderIds(context)),
  ]);
  const models = attachLocalBenchmarkLatencies(context, rawModels);
  return {
    modes: ['model_routing', 'model_route'],
    status: readProviderApi(context) ? 'available' : 'degraded',
    routes: routeCandidates(context).length,
    providers: providerIds.length,
    models: models.length,
    currentModel: context.session.runtime.model,
    currentProvider: context.session.runtime.provider,
    readOnly: true,
  };
}

export async function modelRoutingSummary(context: CommandContext, args: AgentHarnessModelRoutingArgs, reading: ModelReadingOptions = {}): Promise<Record<string, unknown>> {
  const query = readString(args.query).toLowerCase();
  const includeParameters = args.includeParameters === true;
  const [rawModels, providerIds, currentModel] = await Promise.all([
    loadModels(context),
    Promise.resolve(listProviderIds(context)),
    readCurrentModel(context),
  ]);
  reading.assertCurrent?.();
  const models = attachLocalBenchmarkLatencies(context, rawModels);
  const routes = routeCandidates(context);
  const filteredRoutes = routes.filter((route) => !query || routeSearchText(route).includes(query));
  const filteredModels = models.filter((model) => !query || modelSearchText(model).includes(query));
  const limit = readLimit(args.limit, 100);
  const currentRegistryKey = currentModel ? modelRegistryKey(currentModel) : '';
  const listedCurrentModel = currentRegistryKey
    ? models.find(model => model.registryKey === currentRegistryKey)
      ?? models.find(model => model.modelId === modelModelId(currentModel) && model.providerId === modelProviderId(currentModel) && model.providerId !== '')
    : null;
  const currentUnavailable = currentModel && (modelAvailable(currentModel) === false || modelConfigured(currentModel) === false);
  const loadedCurrentModel = listedCurrentModel && currentUnavailable ? { ...listedCurrentModel,
    available: modelAvailable(currentModel) === false ? false : listedCurrentModel.available,
    configured: modelConfigured(currentModel) === false ? false : listedCurrentModel.configured } : listedCurrentModel;
  reading.assertCurrent?.();
  const cookbook = reading.sourceOwner ? await readLocalModelCookbook(context, includeParameters, reading) : localModelCookbook(context, includeParameters);
  reading.assertCurrent?.();
  const descriptions = new Map<ModelCandidate, Promise<Record<string, unknown>>>();
  const describe = (model: ModelCandidate) => {
    const existing = descriptions.get(model);
    if (existing) return existing;
    const result = describeModel(model, { context, includeParameters, reading }); descriptions.set(model, result); return result;
  };
  return {
    status: readProviderApi(context) ? 'available' : 'degraded',
    current: {
      provider: context.session.runtime.provider,
      model: context.session.runtime.model,
      reasoningEffort: context.session.runtime.reasoningEffort || readConfig(context, 'provider.reasoningEffort') || null,
      currentModel: loadedCurrentModel ? await describe(loadedCurrentModel) : currentModel ? await describeModel({
        kind: 'model',
        id: modelRegistryKey(currentModel),
        registryKey: modelRegistryKey(currentModel),
        modelId: modelModelId(currentModel),
        providerId: modelProviderId(currentModel),
        displayName: modelDisplayName(currentModel),
        current: true,
        contextWindow: contextWindowFor(context, currentModel),
        reasoningEffort: modelReasoning(currentModel),
        capabilities: modelCapabilities(currentModel),
        tier: modelTier(currentModel),
        benchmarkCompositeScore: modelBenchmarkCompositeScore(currentModel),
        benchmarkQualityTier: modelBenchmarkQualityTier(currentModel),
        localBenchmarkLatency: null,
        pinned: false,
        available: modelAvailable(currentModel),
        configured: modelConfigured(currentModel),
      }, { context, includeParameters, reading }) : null,
    },
    providers: providerIds,
    localCookbook: cookbook,
    routes: await Promise.all(filteredRoutes.slice(0, limit).map((route) => describeRoute(route, { context, includeParameters, reading, cookbook }))),
    models: await Promise.all(filteredModels.slice(0, limit).map((model) => describe(model))),
    returned: {
      routes: Math.min(filteredRoutes.length, limit),
      models: Math.min(filteredModels.length, limit),
    },
    total: {
      routes: routes.length,
      providers: providerIds.length,
      models: models.length,
    },
    issues: readProviderApi(context) ? [] : [{
      severity: 'warning',
      message: 'Provider API is unavailable in this runtime; static model route posture is still inspectable.',
    }],
    policy: 'Read-only provider/model routing posture. Route changes, model selection, provider add/remove, refresh, pin, and unpin remain visible picker, settings, workspace, or slash-command flows.',
  };
}

export async function describeHarnessModelRoute(context: CommandContext, args: AgentHarnessModelRoutingArgs, reading: ModelReadingOptions = {}): Promise<ModelRouteResolution> {
  const lookup = lookupFromArgs(args);
  if (!lookup) {
    return {
      status: 'missing_lookup',
      usage: 'model_route requires modelRouteId, target, or query. Prefer models action:"status" to inspect route, model, and local endpoint ids.',
    };
  }
  const [rawModels] = await Promise.all([loadModels(context)]);
  reading.assertCurrent?.();
  const models = attachLocalBenchmarkLatencies(context, rawModels);
  const routes = routeCandidates(context);
  const endpoints = localModelServerEndpoints(context, true);
  const normalized = lookup.input.toLowerCase();
  const exactRoute = routes.find((route) => route.id === lookup.input);
  if (exactRoute) return { status: 'found', route: await describeRoute(exactRoute, { context, includeParameters: true, reading, lookup: { ...lookup, resolvedBy: 'route-id' } }) };
  const exactModel = models.find((model) => model.registryKey === lookup.input || model.modelId === lookup.input);
  if (exactModel) return { status: 'found', route: await describeModel(exactModel, { context, includeParameters: true, reading, lookup: { ...lookup, resolvedBy: 'model-id' } }) };
  const exactEndpoint = endpoints.find((endpoint) => endpoint.id === lookup.input || endpoint.baseUrl === lookup.input || endpoint.modelsUrl === lookup.input);
  if (exactEndpoint) return { status: 'found', route: describeLocalServerEndpointRoute(exactEndpoint, { ...lookup, resolvedBy: 'local-endpoint-id' }) };
  const insensitiveRoute = routes.find((route) => route.id.toLowerCase() === normalized);
  if (insensitiveRoute) return { status: 'found', route: await describeRoute(insensitiveRoute, { context, includeParameters: true, reading, lookup: { ...lookup, resolvedBy: 'case-insensitive-route-id' } }) };
  const insensitiveModel = models.find((model) => model.registryKey.toLowerCase() === normalized || model.modelId.toLowerCase() === normalized);
  if (insensitiveModel) return { status: 'found', route: await describeModel(insensitiveModel, { context, includeParameters: true, reading, lookup: { ...lookup, resolvedBy: 'case-insensitive-model-id' } }) };
  const insensitiveEndpoint = endpoints.find((endpoint) => endpoint.id.toLowerCase() === normalized || endpoint.baseUrl.toLowerCase() === normalized || endpoint.modelsUrl.toLowerCase() === normalized);
  if (insensitiveEndpoint) return { status: 'found', route: describeLocalServerEndpointRoute(insensitiveEndpoint, { ...lookup, resolvedBy: 'case-insensitive-local-endpoint-id' }) };
  const searched = [
    ...routes.filter((route) => routeSearchText(route).includes(normalized)),
    ...models.filter((model) => modelSearchText(model).includes(normalized)),
  ];
  const searchedEndpoints = endpoints.filter((endpoint) => localEndpointSearchText(endpoint).includes(normalized));
  if (searched.length === 0 && searchedEndpoints.length === 1) {
    return {
      status: 'found',
      route: describeLocalServerEndpointRoute(searchedEndpoints[0]!, { ...lookup, resolvedBy: 'local-endpoint-search' }),
    };
  }
  if (searched.length === 1 && searchedEndpoints.length === 0) {
    const found = searched[0]!;
    return {
      status: 'found',
      route: found.kind === 'route'
        ? await describeRoute(found, { context, includeParameters: true, reading, lookup: { ...lookup, resolvedBy: 'search' } })
        : await describeModel(found, { context, includeParameters: true, reading, lookup: { ...lookup, resolvedBy: 'search' } }),
    };
  }
  if (searched.length + searchedEndpoints.length > 1) {
    return {
      status: 'ambiguous',
      input: lookup.input,
      candidates: [
        ...searched.slice(0, 8).map(describeCandidate),
        ...searchedEndpoints.slice(0, Math.max(0, 8 - searched.length)).map(describeEndpointCandidate),
      ],
    };
  }
  return {
    status: 'missing_lookup',
    usage: `Unknown model route ${lookup.input}. Prefer models action:"status" to inspect route, model, and local endpoint ids.`,
  };
}

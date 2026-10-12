import { captureJudgmentPort } from '@goodvibes-jev/engine/errors';
import { gateJudgmentRegistry, prepareJudgmentResult } from '@goodvibes-jev/engine/sdk/platform/gate';
import { localServerIdentity, localServerIdentityPolicy, localServingStatus, localServingStatusPolicy, localResourcePressure, localResourcePressurePolicy, localServingSchemaStatus, localServingSchemaStatusPolicy, routingRegistry } from '@goodvibes-jev/engine/sdk/platform/routing';
import { assertProjectionCurrent, booleanValue, booleanValuePolicy, ToolInputProjectionError, type NativeDecisionPolicy } from '@goodvibes-jev/engine/sdk/platform/tools';
import { captureCatalogMethods } from './agent-harness-catalog-ranking.ts';
import { captureModelReadingInput, assertModelReadingInputCurrent, withModelReadingSource, type ModelReadingOptions } from './agent-harness-model-reading-source.ts';
import { personalOpsEntry } from './agent-harness-personal-ops-source.ts';
import type { LocalModelServerServingDiagnostics } from './agent-harness-model-routing-types.ts';

export type LocalModelStack = 'ollama' | 'llama.cpp' | 'vllm' | 'openai-compatible';

function localReadingOptions(options: ModelReadingOptions): ModelReadingOptions {
  const optionsCurrent = captureCatalogMethods(options, ['signal', 'sourceOwner', 'assertCurrent', 'retainCurrent']);
  const signal = options.signal, callerCurrent = options.assertCurrent;
  const assertOptions = () => { optionsCurrent(); signal?.throwIfAborted(); };
  const assertCurrent = () => {
    assertOptions();
    assertProjectionCurrent(callerCurrent);
    assertOptions();
  };
  assertCurrent();
  // Retained checks survive source receipt release, so only native options are retained.
  options.retainCurrent?.(assertOptions);
  return { ...options, assertCurrent };
}

function localDecisionReadingOptions(options: ModelReadingOptions, decision: object & { readonly name: string },
  registry: { get(name: string): unknown }, policy: NativeDecisionPolicy): ModelReadingOptions {
  policy.assertCurrent();
  const definition = policy.definition;
  const reading = localReadingOptions(options);
  const assertRegistry = captureCatalogMethods(registry, ['get']);
  const get = registry.get;
  const decisionKeys = Object.getOwnPropertyNames(decision);
  const decisionSlots = captureCatalogMethods(decision, decisionKeys);
  const assertDecision = () => {
    decisionSlots();
    if (JSON.stringify(Object.getOwnPropertyNames(decision)) !== JSON.stringify(decisionKeys)) throw new ToolInputProjectionError('held');
  };
  const published = Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(decision))
    .filter(([, descriptor]) => typeof descriptor.value !== 'function').map(([key, descriptor]) => [key, descriptor.value]));
  const nativePolicy = { definition, published };
  const captured = captureModelReadingInput(nativePolicy), serialized = JSON.stringify(captured);
  const retained: Array<() => void> = [], seen = new Set<object>();
  const retainNativePolicy = (value: unknown): void => {
    if (value === null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    retained.push(captureCatalogMethods(value, Object.getOwnPropertyNames(value)));
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) retainNativePolicy(descriptor.value);
  };
  retainNativePolicy(nativePolicy);
  const assertPolicy = () => {
    policy.assertCurrent(); assertRegistry(); assertDecision(); for (const guard of retained) guard();
    assertModelReadingInputCurrent(nativePolicy, serialized);
    if (Reflect.apply(get, registry, [decision.name]) !== decision) throw new ToolInputProjectionError('held');
    policy.assertCurrent(); assertRegistry(); assertDecision(); for (const guard of retained) guard();
  };
  assertPolicy(); reading.retainCurrent?.(assertPolicy);
  return { ...reading, assertCurrent() { assertProjectionCurrent(reading.assertCurrent); assertPolicy(); } };
}

function retain(authority: ReturnType<typeof captureJudgmentPort>, current: ModelReadingOptions, site: string): void {
  const restriction = authority.consumeObservation();
  current.retainCurrent?.(restriction.assertCurrent, site);
  restriction.assertCurrent();
}

export async function readLocalModelStack(value: string, evidence: unknown, options: ModelReadingOptions): Promise<LocalModelStack | null> {
  const reading = localDecisionReadingOptions(options, localServerIdentity, routingRegistry, localServerIdentityPolicy);
  return withModelReadingSource({ evidence_kind: 'registry', registry_text: value, record: evidence }, reading, async (captured, current) => {
    const site = 'agent.local-model.registry-identity';
    const authority = captureJudgmentPort(site, { signal: current.signal, assertCurrent: current.assertCurrent, prepareResultCapture: prepareJudgmentResult });
    try {
      const run = await localServerIdentity.route(authority.port, personalOpsEntry(captured), { site, signal: authority.signal, beforeAttempt: authority.assertCurrent });
      authority.assertCurrent(); run.recordAction('read-only local registry server identity');
      if (run.reading.outcome !== 'act') return null;
      switch (run.route) {
        case 'ollama': case 'llama.cpp': case 'vllm': case 'openai-compatible': return run.route;
        default: return null;
      }
    } finally { retain(authority, current, site); }
  });
}

export async function readLocalServingBoolean(value: unknown, parameter: string, record: unknown, options: ModelReadingOptions): Promise<boolean | null> {
  const readingOptions = localReadingOptions(options);
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 'false') return value === 'true';
  if (typeof value !== 'string') return null;
  const policyReading = localDecisionReadingOptions(readingOptions, booleanValue, gateJudgmentRegistry, booleanValuePolicy);
  return withModelReadingSource({ value, parameter, record, tool: 'host-published local model serving diagnostics',
    description: 'Whether the named capability is currently supported or enabled, according to the complete publisher record.' }, policyReading, async (captured, current) => {
    const site = 'agent.local-model.capability-boolean';
    const authority = captureJudgmentPort(site, { signal: current.signal, assertCurrent: current.assertCurrent, prepareResultCapture: prepareJudgmentResult });
    try {
      const run = await booleanValue.run(authority.port, personalOpsEntry(captured), { site, signal: authority.signal, beforeAttempt: authority.assertCurrent });
      authority.assertCurrent(); run.recordAction('read-only local serving capability');
      const reading = run.readings.boolean_value;
      return reading.outcome === 'act' && reading.choice !== 'neither' ? reading.choice === 'true' : null;
    } finally { retain(authority, current, site); }
  });
}

export async function readLocalServingStatus(value: string, record: unknown, options: ModelReadingOptions): Promise<LocalModelServerServingDiagnostics['status']> {
  const reading = localDecisionReadingOptions(options, localServingStatus, routingRegistry, localServingStatusPolicy);
  return withModelReadingSource({ value, record }, reading, async (captured, current) => {
    const site = 'agent.local-model.serving-status';
    const authority = captureJudgmentPort(site, { signal: current.signal, assertCurrent: current.assertCurrent, prepareResultCapture: prepareJudgmentResult });
    try {
      const run = await localServingStatus.run(authority.port, personalOpsEntry(captured), { site, signal: authority.signal, beforeAttempt: authority.assertCurrent });
      authority.assertCurrent(); run.recordAction('read-only local serving posture');
      return run.readings.status.outcome === 'act' ? run.readings.status.choice : 'unknown';
    } finally { retain(authority, current, site); }
  });
}

export async function readLocalResourcePressure(value: string, record: unknown, options: ModelReadingOptions): Promise<LocalModelServerServingDiagnostics['resourcePressure']> {
  const reading = localDecisionReadingOptions(options, localResourcePressure, routingRegistry, localResourcePressurePolicy);
  return withModelReadingSource({ value, record }, reading, async (captured, current) => {
    const site = 'agent.local-model.resource-pressure';
    const authority = captureJudgmentPort(site, { signal: current.signal, assertCurrent: current.assertCurrent, prepareResultCapture: prepareJudgmentResult });
    try {
      const run = await localResourcePressure.run(authority.port, personalOpsEntry(captured), { site, signal: authority.signal, beforeAttempt: authority.assertCurrent });
      authority.assertCurrent(); run.recordAction('read-only local resource pressure');
      return run.readings.pressure.outcome === 'act' ? run.readings.pressure.choice : 'unknown';
    } finally { retain(authority, current, site); }
  });
}

export async function readLocalServingSchemaStatus(value: string, record: unknown, options: ModelReadingOptions): Promise<boolean> {
  const reading = localDecisionReadingOptions(options, localServingSchemaStatus, routingRegistry, localServingSchemaStatusPolicy);
  return withModelReadingSource({ value, record }, reading, async (captured, current) => {
    const site = 'agent.local-model.schema-status';
    const authority = captureJudgmentPort(site, { signal: current.signal, assertCurrent: current.assertCurrent, prepareResultCapture: prepareJudgmentResult });
    try {
      const run = await localServingSchemaStatus.run(authority.port, personalOpsEntry(captured), { site, signal: authority.signal, beforeAttempt: authority.assertCurrent });
      authority.assertCurrent(); run.recordAction('read-only publisher schema claim');
      return run.readings.certified.outcome === 'act' && run.readings.certified.verdict === 'yes';
    } finally { retain(authority, current, site); }
  });
}

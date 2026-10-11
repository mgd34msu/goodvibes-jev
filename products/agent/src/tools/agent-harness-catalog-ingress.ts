import { agentDaemonConfigClientRevision } from '../config/daemon-config-routing.ts';
import type { CommandContext } from '../input/command-registry.ts';
import { agentResearchSourceOwner } from '../agent/protected-research-report.ts';
import { types as nodeTypes } from 'node:util';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { assertCurrentToolExecution, assertCurrentToolInvocation, assertCurrentToolEffect, ToolInputProjectionError, type ToolInputProjector, type ToolRegistry, type ToolExecutionEffect } from '@goodvibes-jev/engine/sdk/platform/tools';
import { captureModelReadingInput, assertModelReadingInputCurrent, modelReadingServicePath } from './agent-harness-model-reading-source.ts';
import { captureCatalogData } from './agent-harness-catalog-ranking.ts';
import { createPersonalOpsInputProjector } from './agent-personal-ops-ingress.ts';
import { createChannelDraftReferenceCapture } from './agent-channel-draft-reference.ts';

type ToolExecuteOptions = NonNullable<Parameters<Tool['execute']>[1]>;

const PRESERVED_CATALOG_MODES = new Set(['route_decision', 'browser_control_route', 'run_local_model_smoke', 'autonomy_intake', 'autonomy_queue', 'autonomy_queue_item', 'learning_curator', 'learning_candidate', 'background_processes', 'background_process', 'cli_commands', 'cli_command', 'shortcuts', 'keybindings', 'keybinding', 'set_keybinding', 'reset_keybinding', 'run_keybinding', 'agent_orchestration', 'agent_orchestration_agent', 'execution_posture', 'execution_route', 'execution_history', 'execution_history_item', 'document_ops_lane', 'delegation_posture', 'delegation_route']);
const CATALOG_MODES = new Set(['modes', 'mode', 'commands', 'command', 'run_command', 'tools', 'tool', 'operator_methods', 'operator_method', ...PRESERVED_CATALOG_MODES]);
const PERSONAL_OPS_MODES = new Set(['personal_ops_briefing', 'personal_ops', 'personal_ops_queue', 'personal_ops_intake', 'personal_ops_lane', 'run_personal_ops_read']);
const PROTECTED_COMMS_EFFECT_MODES = new Set(['channel_draft_save', 'channel_draft_send', 'channel_routing_assign', 'channel_routing_remove']);
const projectionGuards = new WeakMap<object, () => void>();
const forwardedGuards = new WeakMap<object, { readonly options: ToolExecuteOptions | undefined; readonly assertCurrent: () => void; readonly assertInvocation: () => boolean; readonly assertEffect: (effect: ToolExecutionEffect) => boolean }>();
const publicationGuards = new WeakMap<object, Map<string | (() => void), () => void>>();
function retainedGuards(args: object): Map<string | (() => void), () => void> {
  let guards = publicationGuards.get(args);
  if (!guards) { guards = new Map(); publicationGuards.set(args, guards); }
  return guards;
}
/** Register only already-acquired backend guards; never acquire a backend here. */
export function retainHarnessCatalogCurrent(args: object): (guard: () => void, key?: string) => void {
  const guards = retainedGuards(args);
  return (guard, key) => { if (!guards.has(key ?? guard)) guards.set(key ?? guard, guard); };
}

/** Only read data routing descriptors, before screening the complete original. */
export function catalogRoutingInput(input: Record<string, unknown>): Record<string, unknown> {
  if (!input || typeof input !== 'object' || nodeTypes.isProxy(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new ToolInputProjectionError('invalid');
  const result: Record<string, unknown> = {};
  for (const key of ['mode', 'action', 'query', 'target', 'command', 'commandName', 'methodId', 'toolName', 'key', 'setting']) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor && Object.getPrototypeOf(input) !== null && Object.hasOwn(Object.prototype, key)) throw new ToolInputProjectionError('invalid');
    if (descriptor && !('value' in descriptor)) throw new ToolInputProjectionError('invalid');
    if (descriptor) result[key] = descriptor.value;
  }
  return result;
}

export function isHarnessCatalogQuery(input: Record<string, unknown>): boolean {
  const routing = catalogRoutingInput(input);
  if (typeof routing.mode === 'string' && (PERSONAL_OPS_MODES.has(routing.mode) || PROTECTED_COMMS_EFFECT_MODES.has(routing.mode))) { captureCatalogData(input); return true; }
  if (routing.mode === 'model_routing' || routing.mode === 'model_route') { captureCatalogData(input); return true; }
  if (typeof routing.mode === 'string' && PRESERVED_CATALOG_MODES.has(routing.mode)) captureCatalogData(input);
  return typeof routing.mode === 'string' && CATALOG_MODES.has(routing.mode)
    && [routing.query, routing.target].some((value) => typeof value === 'string' && value.trim().length > 0);
}

/** Avoid invoking any registration's replaced definition/name accessor. */
function registeredTool(registry: ToolRegistry, name: string): Tool | undefined {
  for (const tool of registry.list()) {
    if (nodeTypes.isProxy(tool)) throw new ToolInputProjectionError('invalid');
    let owner: object | null = tool;
    let definition: unknown;
    for (let depth = 0; owner && depth < 64; depth++) {
      if (nodeTypes.isProxy(owner)) throw new ToolInputProjectionError('invalid');
      const descriptor = Object.getOwnPropertyDescriptor(owner, 'definition');
      if (descriptor) {
        if (!('value' in descriptor)) throw new ToolInputProjectionError('invalid');
        definition = descriptor.value; break;
      }
      owner = Object.getPrototypeOf(owner) as object | null;
    }
    if (!definition || typeof definition !== 'object' || nodeTypes.isProxy(definition)) throw new ToolInputProjectionError('invalid');
    const descriptor = Object.getOwnPropertyDescriptor(definition, 'name');
    if (!descriptor || !('value' in descriptor)) throw new ToolInputProjectionError('invalid');
    if (descriptor.value === name) return tool;
  }
  return undefined;
}

function catalogContextGuard(registry: ToolRegistry, context?: CommandContext, settings = false): () => void {
  const config = settings ? context?.platform.configManager : undefined;
  const incarnation = config?.getConfigurationIncarnation();
  const clientRevision = settings ? agentDaemonConfigClientRevision() : undefined;
  const session = modelReadingServicePath(context, ['session', 'runtime']);
  const sessionId = modelReadingServicePath(session, ['sessionId']);
  const owner = agentResearchSourceOwner(registry);
  const api = modelReadingServicePath(context, ['clients', 'mcpApi']) ?? modelReadingServicePath(context, ['extensions', 'mcpRegistry']);
  return () => {
    if ((settings && (context?.platform.configManager !== config || config?.getConfigurationIncarnation() !== incarnation || agentDaemonConfigClientRevision() !== clientRevision))
      || modelReadingServicePath(context, ['session', 'runtime']) !== session || modelReadingServicePath(session, ['sessionId']) !== sessionId
      || agentResearchSourceOwner(registry) !== owner
      || (modelReadingServicePath(context, ['clients', 'mcpApi']) ?? modelReadingServicePath(context, ['extensions', 'mcpRegistry'])) !== api) throw new ToolInputProjectionError('stale');
  };
}

/** Reuse the protected-source owner and full original invocation projector. */
export function createHarnessCatalogInputProjector(registry: ToolRegistry, fallback?: ToolInputProjector,
  selected = isHarnessCatalogQuery, context?: CommandContext): ToolInputProjector {
  const projector = createPersonalOpsInputProjector(registry, fallback, selected);
  return { captureNativeReferences: createChannelDraftReferenceCapture(context), async project(request) {
    const protectedQuery = selected(request.args);
    const retained = retainedGuards(request.args);
    const routing = catalogRoutingInput(request.args);
    const settingsInspection = request.name === 'settings' || routing.mode === 'settings' || routing.mode === 'get_setting';
    const assertContext = protectedQuery ? catalogContextGuard(registry, context, settingsInspection) : () => {};
    const modelInspection = routing.mode === 'model_routing' || routing.mode === 'model_route' || request.name === 'models';
    const original = protectedQuery && (modelInspection || settingsInspection) ? captureModelReadingInput(request.args) : undefined;
    const originalJson = original && JSON.stringify(original);
    const guarded = protectedQuery ? { ...request, ...(original ? { args: original } : {}), assertCurrent: () => {
      request.assertCurrent(); assertContext();
      for (const guard of retained.values()) guard();
      if (original) assertModelReadingInputCurrent(request.args, originalJson);
    } } : request;
    const result = await projector.project(guarded);
    if (!protectedQuery || result.status !== 'projected') return result;
    publicationGuards.set(result.args, retained);
    let released = false;
    const assertCurrent = () => {
      if (released) throw new ToolInputProjectionError('stale');
      // The trusted selected projector already checks guarded.assertCurrent
      // before and after owner.project. Do not repeat that complete registry
      // proof a third time in this same synchronous boundary.
      if (result.assertCurrent) result.assertCurrent(); else guarded.assertCurrent();
    };
    return { ...result, ...((modelInspection || settingsInspection) ? { resultPublication: 'read-only' as const } : {}),
      assertRepairedArgs(candidate) {
        result.assertRepairedArgs?.(candidate); assertCurrent();
        // The registry supplies this exact final argument object to execute.
        // A structural copy cannot inherit a protected invocation's lifetime.
        projectionGuards.set(candidate, assertCurrent); publicationGuards.set(candidate, retained);
      },
      async release() {
        // Engine cleanup retires the one-use execution before releasing its
        // projection. Only retained source/backend facts survive that lease.
        released = true;
        await result.release?.();
        assertContext();
        if (original) assertModelReadingInputCurrent(request.args, originalJson);
        for (const guard of retained.values()) guard();
      },
    };
  } };
}

/** Verify the original invocation, including admission, after every catalog await. */
export function harnessCatalogExecutionGuard(args: Record<string, unknown>, options?: ToolExecuteOptions): () => void {
  const inherited = forwardedGuards.get(args);
  if (inherited) {
    if (inherited.options !== options) throw new ToolInputProjectionError('stale');
    return inherited.assertCurrent;
  }
  const projected = projectionGuards.get(args);
  const retained = retainedGuards(args);
  const signal = modelReadingServicePath(options, ['signal']) as AbortSignal | undefined;
  return () => {
    if (modelReadingServicePath(options, ['signal']) !== signal) throw new ToolInputProjectionError('stale');
    signal?.throwIfAborted();
    assertCurrentToolExecution(args, options);
    if (projected) projected();
    for (const guard of retained.values()) guard();
  };
}

/** Trusted translations retain the original engine proof; arguments never mint it. */
export function harnessCatalogInvocationAuthority(args: Record<string, unknown>, options?: ToolExecuteOptions, effect?: ToolExecutionEffect): boolean {
  const inherited = forwardedGuards.get(args);
  if (inherited) {
    if (inherited.options !== options) throw new ToolInputProjectionError('stale');
    inherited.assertCurrent();
    return effect ? inherited.assertEffect(effect) : inherited.assertInvocation();
  }
  harnessCatalogExecutionGuard(args, options)();
  return effect ? assertCurrentToolEffect(args, options, effect) : assertCurrentToolInvocation(args, options);
}

/** Argument translation retains the exact options capability and original guard. */
export async function forwardHarnessCatalogCall(tool: Tool, original: Record<string, unknown>, forwarded: Record<string, unknown>, options?: ToolExecuteOptions,
  additionalGuard?: () => void) {
  const originalGuard = harnessCatalogExecutionGuard(original, options);
  const inherited = forwardedGuards.get(original);
  const previousForwarded = forwardedGuards.get(forwarded);
  const originalInvocation = inherited ? inherited.assertInvocation : () => assertCurrentToolInvocation(original, options);
  const originalEffect = inherited ? inherited.assertEffect : (effect: ToolExecutionEffect) => assertCurrentToolEffect(original, options, effect);
  const assertCurrent = () => { originalGuard(); additionalGuard?.(); };
  assertCurrent(); publicationGuards.set(forwarded, retainedGuards(original));
  forwardedGuards.set(forwarded, { options, assertCurrent, assertInvocation: () => { assertCurrent(); return originalInvocation(); }, assertEffect: effect => { assertCurrent(); return originalEffect(effect); } });
  try { const result = await tool.execute(forwarded, options); assertCurrent(); return result; }
  finally {
    if (previousForwarded) forwardedGuards.set(forwarded, previousForwarded);
    else forwardedGuards.delete(forwarded);
  }
}

/** Raw factory callers use the same full-source boundary as registered callers. */
export function protectHarnessCatalogTool(tool: Tool, registry: ToolRegistry, selected = isHarnessCatalogQuery, context?: CommandContext): Tool {
  const projector = createHarnessCatalogInputProjector(registry, undefined, selected, context);
  return { ...tool, async execute(input, options) {
    if (!selected(input)) return tool.execute(input, options);
    if (!forwardedGuards.has(input) && !projectionGuards.has(input)) { publicationGuards.set(input, new Map()); }
    const guard = harnessCatalogExecutionGuard(input, options);
    const registration = registeredTool(registry, tool.definition.name);
    const routing = catalogRoutingInput(input);
    const assertContext = catalogContextGuard(registry, context, tool.definition.name === 'settings' || routing.mode === 'settings' || routing.mode === 'get_setting');
    const assertRegistrationCurrent = () => {
      assertContext();
      if (registeredTool(registry, tool.definition.name) !== registration) throw new ToolInputProjectionError('stale');
    };
    const assertCurrent = () => { guard(); assertRegistrationCurrent(); };
    assertCurrent();
    if (projectionGuards.has(input)) {
      // Forwarding already invokes this exact input's execution/projection
      // guard. The additional check owns only context and registration.
      return forwardHarnessCatalogCall(tool, input, input, options, assertRegistrationCurrent);
    }
    const projected = await projector.project({ callId: 'catalog-direct', name: tool.definition.name, args: input,
      signal: options?.signal, assertCurrent });
    try {
      if (projected.status !== 'projected') throw new ToolInputProjectionError('held');
      return await forwardHarnessCatalogCall(tool, input, projected.args, options, projected.assertCurrent);
    } finally { await projected.release?.(); assertCurrent(); }
  } };
}

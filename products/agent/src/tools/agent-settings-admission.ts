import { agentResearchSourceOwner } from '../agent/protected-research-report.ts';
import { withModelReadingSource, captureModelReadingInput, assertModelReadingInputCurrent } from './agent-harness-model-reading-source.ts';
/** Preferred settings and compatibility harness share one exact effect-owner plan. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { snapshotJudgmentInput } from '@goodvibes-jev/engine/sdk/platform/gate';
import { assertCurrentToolInvocation, assertProjectionExecution, claimCurrentToolSettingsDispatch,
  commitCurrentToolSettingsPlan, currentToolSettingsPresentation, ToolInputProjectionError,
  type ToolInputProjector, type ToolRegistry, type ToolPreparedSettingsMutation } from '@goodvibes-jev/engine/sdk/platform/tools';
import { assertPreparedConfigWriteRoute, resolvePreparedConfigWriteRoute, captureRemoteSettingsPrecondition,
  assertRemoteSettingsPrecondition, inspectRemoteSettingsPrecondition, applyRemoteSettingsPrecondition, isSecretBearingConfigKey,
  type ConfigKey, type ConfigWriteRoute, type PreparedConfigMutationFacts,
  type PreparedConfigMutationReceipt, type RemoteSettingsPrecondition } from '@goodvibes-jev/engine/sdk/platform/config';
import type { CommandContext } from '../input/command-registry.ts';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
type ToolExecuteOptions = NonNullable<Parameters<Tool['execute']>[1]>;
import { resolveWakeEnablementCompanion } from '@goodvibes-jev/engine/sdk/platform/voice';
import { AGENT_WAKE_SURFACE } from '../audio/wake-surface.ts';
import { coerceHarnessSettingValue, bindSettingSchemaDescriptors, resolveHarnessSettingAsync, type HarnessSettingLookup } from '../agent/harness-control.ts';
import { getAgentSettingsSchema } from '../config/settings-catalog.ts';
import { agentDaemonConfigClient, agentDaemonConfigClientRevision, buildAgentConfigRouting, configKeyScope } from '../config/daemon-config-routing.ts';
import { buildGoodVibesSecretKey, defaultSecretBackedScope, isSecretConfigKey, isSecretReferenceValue } from '../config/secret-config.ts';

const setActions = new Set(['set', 'update', 'change', 'configure', 'set_setting']);
const resetActions = new Set(['reset', 'clear', 'default', 'restore', 'reset_setting']);
const normalize = (value: unknown) => typeof value === 'string' ? value.trim().toLowerCase().replace(/-/g, '_') : '';
export function preferredSettingsMutation(name: string, args: Record<string, unknown>): 'set' | 'reset' | undefined {
  if (name === 'agent_harness') return args.mode === 'set_setting' ? 'set' : args.mode === 'reset_setting' ? 'reset' : undefined;
  const first = normalize(args.action);
  const reads = new Set(['list', 'status', 'settings', 'catalog', 'search', 'find', 'browse', 'get', 'show', 'inspect', 'read', 'setting', 'get_setting', 'import', 'import_settings', 'settings_import', 'import_goodvibes', 'goodvibes_import', 'preview_import', 'apply_import']);
  const action = setActions.has(first) || resetActions.has(first) || reads.has(first) ? first : normalize(args.mode);
  return setActions.has(action) ? 'set' : resetActions.has(action) ? 'reset' : undefined;
}
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const posture = (value: unknown) => Object.freeze({ redacted: true, configured: value !== undefined && value !== null && value !== '' });
interface Capture {
  readonly argsJson: string;
  readonly operation: 'set' | 'reset';
  readonly key: string;
  readonly lookup: HarnessSettingLookup;
  readonly local?: ToolPreparedSettingsMutation | undefined;
  readonly localFacts?: PreparedConfigMutationFacts | undefined;
  readonly remote?: RemoteSettingsPrecondition | undefined;
  readonly applyRemote?: (() => Promise<PreparedConfigMutationReceipt & { verifiedInOwningStore?: boolean }>) | undefined;
  readonly assertOwner: () => void;
  readonly persistedTo: string;
  readonly companion?: Readonly<{ key: string; value: unknown; message: string }> | undefined;
  released: boolean;
  spent: boolean;
}
const captures = new WeakMap<object, Capture>();
function assertCapture(capture: Capture): void {
  if (capture.released || capture.spent) throw new ToolInputProjectionError('stale');
  capture.assertOwner();
  if (capture.local) {
    capture.local.owner.assertPreparedMutation(capture.local.mutation);
    const secret = capture.local.secretDeletion; if (secret) secret.owner.assertPreparedScopedDeletion(secret.mutation);
  }
}

export function createPreferredSettingsProjector(platform: Pick<CommandContext['platform'], 'configManager' | 'secretsManager'>,
  fallback?: ToolInputProjector, readingContext?: { readonly registry: ToolRegistry; readonly context: CommandContext }): ToolInputProjector {
  const config = platform.configManager; const secrets = platform.secretsManager;
  return { async project(request) {
    const operation = preferredSettingsMutation(request.name, request.args);
    if (!operation) {
      const result = fallback ? await fallback.project(request) : { status: 'projected' as const, args: request.args };
      if (result.status !== 'projected') return result;
      return { ...result, assertRepairedArgs(next) {
        if (preferredSettingsMutation(request.name, next)) throw new ToolInputProjectionError('binding-changed');
        result.assertRepairedArgs?.(next);
      } };
    }
    request.assertCurrent(); request.signal?.throwIfAborted();
    const original = request.args;
    const signal = request.signal, assertRequestCurrent = request.assertCurrent;
    const originalJson = JSON.stringify(captureModelReadingInput(original));
    const schemaMethods = [config.getSchema, config.getHostSettingsSchema];
    const builtinSchema = config.getSchema(), hostSchema = config.getHostSettingsSchema();
    const assertSchemaDescriptors = bindSettingSchemaDescriptors([builtinSchema, hostSchema]);
    const schema = getAgentSettingsSchema(config);
    const client = agentDaemonConfigClient(); const installRevision = agentDaemonConfigClientRevision();
    const incarnation = config.getConfigurationIncarnation();
    const owner = agentResearchSourceOwner(readingContext?.registry);
    const runtime = readingContext?.context.session?.runtime;
    const sessionId = runtime?.sessionId;
    const retained = new Map<string | (() => void), () => void>();
    const assertRoutingOwner = () => {
      assertSchemaDescriptors();
      if (platform.configManager !== config || platform.secretsManager !== secrets || agentDaemonConfigClient() !== client || agentDaemonConfigClientRevision() !== installRevision
        || config.getSchema !== schemaMethods[0] || config.getHostSettingsSchema !== schemaMethods[1]
        || config.getSchema() !== builtinSchema || config.getHostSettingsSchema() !== hostSchema) throw new ToolInputProjectionError('stale');
    };
    const assertSelectionSource = () => {
      if (request.args !== original || request.signal !== signal || request.assertCurrent !== assertRequestCurrent) throw new ToolInputProjectionError('stale');
      signal?.throwIfAborted(); assertRoutingOwner();
      assertModelReadingInputCurrent(original, originalJson);
      if (config.getConfigurationIncarnation() !== incarnation
        || agentResearchSourceOwner(readingContext?.registry) !== owner || readingContext?.context.session?.runtime !== runtime
        || runtime?.sessionId !== sessionId) throw new ToolInputProjectionError('stale');
    };
    // Preparation authority is consume-only. The admitted body must not re-enter it.
    const assertSelection = () => { assertRequestCurrent(); assertSelectionSource(); };
    const reading = { signal, sourceOwner: owner, assertCurrent: assertSelection,
      retainCurrent: (guard: () => void, key?: string) => { if (!retained.has(key ?? guard)) retained.set(key ?? guard, guard); } };

    const lookupArgs = {
      key: text(original.key) || text(original.setting), target: text(original.target), query: text(original.query),
      category: text(original.category), prefix: text(original.prefix), includeHidden: original.includeHidden === true,
    };
    // Resolve/coerce before admission, never reinterpret an alias or a value in the body.
    const input = lookupArgs.key || lookupArgs.target || lookupArgs.query;
    const exactIdentifier = schema.some(setting => setting.key.toLowerCase() === input.toLowerCase());
    const found = exactIdentifier ? await resolveHarnessSettingAsync(config, lookupArgs, undefined, reading)
      : await withModelReadingSource(original, reading, async (_captured, scoped) => resolveHarnessSettingAsync(config, lookupArgs, undefined, scoped));
    assertSelection(); for (const guard of retained.values()) guard();
    if (found?.status !== 'found' || !found.setting.writable) throw new ToolInputProjectionError('unavailable');
    const key = found.setting.key;
    const setting = schema.find(item => item.key === key)!;
    const secretKey = isSecretConfigKey(key) || isSecretBearingConfigKey(key);
    const coerced = operation === 'set' ? coerceHarnessSettingValue(setting, original.value) : setting.default;
    const value = secretKey && typeof coerced === 'string' ? coerced.trim() : coerced;
    if (operation === 'set' && original.value === undefined) throw new ToolInputProjectionError('invalid');
    // An alias must not hide declared credential material from the privacy floor.
    snapshotJudgmentInput({ key, value }, 'goodvibes_settings');
    const credentialClear = secretKey && (operation === 'reset' || (typeof value === 'string' && value.trim() === ''));
    if (secretKey && operation === 'set' && typeof value === 'string' && value.trim() && !isSecretReferenceValue(value)) throw new ToolInputProjectionError('held');
    const capability = client?.preparedSettings;
    let route: ConfigWriteRoute | undefined;
    let remote: RemoteSettingsPrecondition | undefined;
    let applyRemote: Capture['applyRemote'];
    let remoteAssert: (() => void) | undefined;
    let local: ToolPreparedSettingsMutation | undefined;
    let localFacts: PreparedConfigMutationFacts | undefined;
    let persistedTo: string;
    let effect: Record<string, unknown>;
    const companion = operation === 'set' ? resolveWakeEnablementCompanion(key, value, next => config.get(next as ConfigKey), AGENT_WAKE_SURFACE) : null;
    const remoteRequest = { operation: operation === 'reset' ? 'reset-default' as const : 'set' as const, key,
      ...(operation === 'set' ? { value } : {}), ...(credentialClear ? { credentialClear: true as const } : {}) };
    if (configKeyScope(key) === 'daemon' && client) {
      if (!client.ownsKey(key) || !capability) throw new ToolInputProjectionError('unconfigured');
      remote = await capability.capture(remoteRequest);
      remoteAssert = () => { if (client.preparedSettings !== capability) throw new ToolInputProjectionError('stale'); capability.assertCurrent(remote!); };
      const facts = capability.inspect(remote);
      applyRemote = () => capability.apply(remote!);
      persistedTo = facts.endpoint;
      effect = { operation: facts.operation, key: facts.key, value: facts.value, destinations: facts.destinations,
        ...('credential' in facts ? { credential: facts.credential } : {}), previous: { unavailable: true }, appliedBy: 'daemon', endpoint: facts.endpoint };
    } else {
      route = await resolvePreparedConfigWriteRoute(key, buildAgentConfigRouting({ homeDir: config.getHomeDirectory() ?? undefined }), assertRoutingOwner);
      if (route.mode === 'daemon') {
        remote = await captureRemoteSettingsPrecondition(route.endpoint, remoteRequest);
        remoteAssert = () => assertRemoteSettingsPrecondition(remote!);
        const facts = inspectRemoteSettingsPrecondition(remote);
        applyRemote = () => applyRemoteSettingsPrecondition(remote!);
        persistedTo = facts.endpoint;
        effect = { operation: facts.operation, key: facts.key, value: facts.value, destinations: facts.destinations,
        ...('credential' in facts ? { credential: facts.credential } : {}), previous: { unavailable: true }, appliedBy: 'daemon', endpoint: facts.endpoint };
      } else {
        const mutation = config.prepareSettingMutationPlan([
          operation === 'set' ? { operation, key: key as ConfigKey, value } : { operation, key: key as ConfigKey },
          ...(companion ? [{ operation: 'set' as const, key: companion.key as ConfigKey, value: companion.value }] : []),
        ]);
        localFacts = config.inspectPreparedMutation(mutation);
        const secretDeletion = credentialClear ? (() => {
          if (!secrets) throw new ToolInputProjectionError('unconfigured');
          return Object.freeze({ owner: secrets, mutation: secrets.prepareScopedDeletion(buildGoodVibesSecretKey(key), defaultSecretBackedScope(key as ConfigKey)) });
        })() : undefined;
        local = Object.freeze({ owner: config, mutation, route, ...(secretDeletion ? { secretDeletion } : {}) });
        persistedTo = localFacts.destinations[0]!.path;
        const previous = setting.kind === 'host' ? config.getHostBooleanSetting(key).get() : config.get(key as ConfigKey);
        effect = { operation, key, value: localFacts.value, previous: isSecretBearingConfigKey(key) ? posture(previous) : previous,
          appliedBy: 'local', destinations: localFacts.destinations,
          ...(localFacts.effects ? { effects: localFacts.effects.map(({ operation, key, value, destinations }) => ({ operation, key, value, destinations })) } : {}),
          ...(secretDeletion ? { credential: secretDeletion.owner.inspectPreparedScopedDeletion(secretDeletion.mutation) } : {}) };
      }
    }
    request.assertCurrent(); request.signal?.throwIfAborted();
    // Protect all backend facts, including defaults and every companion, before hashing/judgment.
    effect = snapshotJudgmentInput(effect, 'goodvibes_settings') as Record<string, unknown>;
    const context = Object.freeze({});
    const assertOwner = () => {
      assertSelectionSource(); for (const guard of retained.values()) guard();
      assertRoutingOwner();
      if (config.getConfigurationIncarnation() !== incarnation) throw new ToolInputProjectionError('stale');
      if (route) assertPreparedConfigWriteRoute(route);
      remoteAssert?.();
    };
    const capture: Capture = { argsJson: originalJson, operation, key, lookup: found.lookup, local, localFacts, remote, applyRemote,
      assertOwner, persistedTo, ...(companion ? { companion } : {}), released: false, spent: false };
    assertCapture(capture); captures.set(context, capture);
    return { status: 'projected', args: original, executionContext: context, settingsMutation: local,
      settingsAdmissionEvidence: Object.freeze({ kind: 'agent-settings', operation, key, effect,
        revision: createHash('sha256').update(JSON.stringify(effect)).digest('hex') }),
      assertCurrent: () => { assertSelection(); assertCapture(capture); },
      assertRepairedArgs(next) { assertSelection(); assertModelReadingInputCurrent(next, capture.argsJson); assertCapture(capture); },
      async release() { capture.released = true; captures.delete(context); },
    };
  } };
}

export async function executeAdmittedPreferredSettings(args: Record<string, unknown>, options?: ToolExecuteOptions): Promise<Awaited<ReturnType<Tool['execute']>>> {
  const context = options?.inputProjectionContext; const capture = context && captures.get(context);
  if (!context || !capture || !assertCurrentToolInvocation(args, options)) throw new ToolInputProjectionError('held');
  assertProjectionExecution(context, args);
  assertModelReadingInputCurrent(args, capture.argsJson);
  assertCapture(capture);
  const presentation = currentToolSettingsPresentation(args, options);
  capture.spent = true;
  let receipt: PreparedConfigMutationReceipt & { verifiedInOwningStore?: boolean };
  if (capture.local) receipt = await commitCurrentToolSettingsPlan(args, options);
  else { claimCurrentToolSettingsDispatch(args, options); receipt = await capture.applyRemote!(); }
  let verified = receipt.status === 'committed' && receipt.verifiedInOwningStore === true;
  if (receipt.status === 'committed' && capture.localFacts) {
    try {
      verified = (capture.localFacts.effects ?? [capture.localFacts]).every(effect => effect.destinations.every(destination => {
        let value: unknown = JSON.parse(readFileSync(destination.path, 'utf8'));
        for (const segment of effect.key.split('.')) value = value && typeof value === 'object' ? (value as Record<string, unknown>)[segment] : undefined;
        return destination.operation === 'remove' ? value === undefined : JSON.stringify(value) === JSON.stringify(effect.value);
      }));
      const deletion = capture.local?.secretDeletion;
      if (verified && deletion) {
        try { deletion.owner.assertCompletedScopedDeletion(deletion.mutation); }
        catch { verified = false; }
      }
    } catch { /* Reporting cannot undo an already committed effect. */ }
  }
  return { success: receipt.status === 'committed', output: JSON.stringify({ key: capture.key, action: capture.operation,
    status: receipt.status, previous: presentation.previous,
    ...(verified && (capture.operation === 'set' || capture.remote) ? { current: presentation.current } : {}),
    lookup: capture.lookup, scope: configKeyScope(capture.key), appliedBy: capture.local ? 'local' : 'daemon',
    persistedTo: capture.persistedTo, verifiedInOwningStore: verified, completedPaths: receipt.completedPaths,
    ...(capture.companion && receipt.status === 'committed' ? { alsoSet: capture.companion } : {}),
    ...(receipt.uncertainPath ? { uncertainPath: receipt.uncertainPath } : {}) }),
    ...(receipt.status !== 'committed' ? { error: 'Settings outcome is partial or unknown; no mutation was retried.' } : {}) };
}

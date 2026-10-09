/** Backend-owned SETTINGS preparation. All semantic observations precede common admission. */
import { createHash } from 'node:crypto';
import type { ConfigWriteRoute } from '../../config/daemon-config-route.js';
import type { ConfigManager, PreparedConfigMutationFacts } from '../../config/manager.js';
import { isValidConfigKey } from '../../config/schema.js';
import { isSecretBearingConfigKey } from '../../config/secret-bearing-config-keys.js';
import { configKeyScope, describeConfigOwnership } from '../../config/config-ownership.js';
import { readHostSettingsFile } from '../../config/manager-host-settings.js';
import { snapshotJudgmentInput } from '../../gate/judgment-input.js';
import { applyRemoteSettingsPrecondition, assertRemoteSettingsPrecondition, captureRemoteSettingsPrecondition,
  inspectRemoteSettingsPrecondition, resolvePreparedConfigWriteRoute, assertPreparedConfigWriteRoute, type RemoteSettingsPrecondition } from '../../config/settings-precondition-client.js';
import type { ToolExecuteOptions } from '../../types/tools.js';
import { assertProjectionExecution, ToolInputProjectionError, type ToolInputProjector, type ToolPreparedSettingsMutation } from '../input-projection.js';
import { assertCurrentToolExecution, claimCurrentToolSettingsDispatch, commitCurrentToolSettings, currentToolSettingsPresentation } from '../registry.js';
import { resolveRouterDeps, type ConfigRoutingOptions } from './config-routing.js';

interface Capture {
  readonly argsJson: string;
  readonly key: string;
  readonly operation: 'set' | 'reset';
  readonly local?: ToolPreparedSettingsMutation | undefined;
  readonly localFacts?: PreparedConfigMutationFacts | undefined;
  readonly remote?: RemoteSettingsPrecondition | undefined;
  readonly source: string;
  readonly route: ConfigWriteRoute;
  released: boolean;
  spent: boolean;
}
const captures = new WeakMap<object, Capture>();

function assertCapture(capture: Capture): void {
  if (capture.released || capture.spent) throw new ToolInputProjectionError('stale');
  assertPreparedConfigWriteRoute(capture.route);
  if (capture.local) capture.local.owner.assertPreparedMutation(capture.local.mutation);
  if (capture.remote) assertRemoteSettingsPrecondition(capture.remote);
}
function posture(value: unknown): Readonly<Record<string, unknown>> {
  return Object.freeze({ redacted: true, configured: value !== undefined && value !== null && value !== '' });
}

export function createAgentSettingsInputProjector(configManager: ConfigManager, routing: ConfigRoutingOptions = {}): ToolInputProjector {
  return {
    async project(request) {
      request.assertCurrent(); request.signal?.throwIfAborted();
      const args = request.args;
      if (args.confirm !== true || (args.mode !== 'set' && args.mode !== 'reset') || typeof args.key !== 'string') throw new ToolInputProjectionError('invalid');
      const key = args.key.trim();
      if (!isValidConfigKey(key)) throw new ToolInputProjectionError('invalid');
      // Hosted originating-surface files have a separate owner contract. The
      // main Agent composition never supplies this override; never borrow the
      // hosting manager's authority for a distinct file.
      if (routing.clientOwnedStore && configKeyScope(key) === 'client') throw new ToolInputProjectionError('unconfigured');
      const route = await resolvePreparedConfigWriteRoute(key, resolveRouterDeps(configManager, routing));
      request.assertCurrent(); request.signal?.throwIfAborted();
      let local: ToolPreparedSettingsMutation | undefined;
      let localFacts: PreparedConfigMutationFacts | undefined;
      let remote: RemoteSettingsPrecondition | undefined;
      let effect: Record<string, unknown>;
      let source: string;
      if (route.mode === 'daemon') {
        remote = await captureRemoteSettingsPrecondition(route.endpoint,
          args.mode === 'reset' ? { operation: 'reset-default', key } : { operation: 'set', key, value: args.value }, routing);
        request.assertCurrent(); request.signal?.throwIfAborted();
        const facts = inspectRemoteSettingsPrecondition(remote);
        source = facts.endpoint;
        effect = { operation: facts.operation, key, value: facts.value, destinations: facts.destinations,
          appliedBy: 'daemon', endpoint: facts.endpoint, previous: { unavailable: true } };
      } else {
        const mutation = configManager.prepareSettingMutation(args.mode === 'set'
          ? { operation: 'set', key, value: args.value } : { operation: 'reset', key });
        local = Object.freeze({ owner: configManager, mutation, route });
        localFacts = configManager.inspectPreparedMutation(mutation);
        // Known credential old values never enter the hosted inspection path.
        const previous = configManager.get(key);
        source = localFacts.destinations[0]?.path ?? configManager.getConfigPath();
        effect = { operation: localFacts.operation, key, value: localFacts.value, destinations: localFacts.destinations,
          appliedBy: 'local', previous: isSecretBearingConfigKey(key) ? posture(previous) : previous };
      }
      // Protect complete raw backend facts before hashing, recording or judgment.
      effect = snapshotJudgmentInput(effect, 'goodvibes_settings') as Record<string, unknown>;
      request.assertCurrent(); request.signal?.throwIfAborted();
      const context = Object.freeze({});
      const capture: Capture = { argsJson: JSON.stringify(args), key, operation: args.mode, local, localFacts, remote, source, route,
        released: false, spent: false };
      assertCapture(capture); captures.set(context, capture);
      const revision = createHash('sha256').update(JSON.stringify(effect)).digest('hex');
      return { status: 'projected', args, executionContext: context, settingsMutation: local,
        settingsAdmissionEvidence: Object.freeze({ kind: 'agent-settings', operation: args.mode, key, effect, revision }),
        assertCurrent: () => assertCapture(capture),
        assertRepairedArgs: next => {
          if (JSON.stringify(next) !== capture.argsJson) throw new ToolInputProjectionError('binding-changed');
          assertCapture(capture);
        },
        release: async () => { capture.released = true; captures.delete(context); },
      };
    },
  };
}

export function assertAdmittedAgentSettings(args: Record<string, unknown>, options?: ToolExecuteOptions): void {
  const context = options?.inputProjectionContext;
  const capture = context && captures.get(context);
  if (!context || !capture || !assertCurrentToolExecution(args, options)) throw new ToolInputProjectionError('held');
  assertProjectionExecution(context, args);
  if (JSON.stringify(args) !== capture.argsJson) throw new ToolInputProjectionError('binding-changed');
  assertCapture(capture);
}

function leaf(raw: Record<string, unknown>, key: string): { present: boolean; value?: unknown } {
  let value: unknown = raw;
  for (const segment of key.split('.')) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, segment)) return { present: false };
    value = (value as Record<string, unknown>)[segment];
  }
  return { present: true, value };
}

/** Actual adopted backend. No semantic read, route resolution or refreshed retry after claim. */
export async function executeAdmittedAgentSettings(args: Record<string, unknown>, options?: ToolExecuteOptions): Promise<{ success: boolean; output?: string; error?: string }> {
  assertAdmittedAgentSettings(args, options);
  const capture = captures.get(options!.inputProjectionContext!)!;
  const presentation = currentToolSettingsPresentation(args, options);
  capture.spent = true;
  let receipt;
  if (capture.local) receipt = commitCurrentToolSettings(args, options);
  else {
    claimCurrentToolSettingsDispatch(args, options);
    receipt = await applyRemoteSettingsPrecondition(capture.remote!);
  }
  let verified = !capture.localFacts && receipt.status === 'committed'
    && 'verifiedInOwningStore' in receipt && receipt.verifiedInOwningStore === true;
  if (receipt.status === 'committed' && capture.localFacts) {
    try {
      verified = capture.localFacts.destinations.every(destination => {
        const found = leaf(readHostSettingsFile(destination.path), capture.key);
        return destination.operation === 'remove' ? !found.present
          : found.present && JSON.stringify(found.value) === JSON.stringify(capture.localFacts!.value);
      });
    } catch { /* A committed effect cannot be relabeled no-effect because readback failed. */ }
  }
  return { success: receipt.status === 'committed', output: JSON.stringify({ key: capture.key, action: capture.operation,
    status: receipt.status, previous: presentation.previous,
    ...(receipt.status === 'committed' && verified && (capture.operation === 'set' || capture.remote) ? { current: presentation.current } : {}),
    persistedTo: capture.source, appliedBy: capture.local ? 'local' : 'daemon', owner: configKeyScope(capture.key),
    ownership: describeConfigOwnership(capture.key), verifiedInOwningStore: verified,
    completedPaths: receipt.completedPaths, ...(receipt.uncertainPath ? { uncertainPath: receipt.uncertainPath } : {}) }),
    ...(receipt.status !== 'committed' ? { error: 'Settings mutation outcome is partial or unknown; it was not retried.' } : {}) };
}

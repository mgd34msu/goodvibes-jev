/** Explicit serving composition. There is deliberately no substitute inbox. */
import { writeSync } from 'node:fs';
import {
  applyRuntimeConfigOverrides, applyRuntimeConfigValue, applyRuntimeEndpointFlagOverrides,
  applyRuntimeFeatureFlagOverrides, resolveRuntimeEndpointBinding,
} from '@goodvibes-jev/engine/terminal-shell';
import { getModelIdFromProviderModel, getProviderIdFromModel } from '@goodvibes-jev/engine/sdk/platform/providers';
import { createRuntimeStore } from '@goodvibes-jev/engine/sdk/platform/runtime/store';
import { getOrCreateCompanionToken } from '@goodvibes-jev/engine/sdk/platform/pairing';
import { RuntimeEventBus, runtimeEventBusOptionsFrom } from '@goodvibes-jev/engine/sdk/platform/runtime/state';
import { createDaemonHost } from '../runtime/daemon-host.js';
import type { RuntimeServicesOptions } from '../runtime/services.js';
import { runDaemonProcess, type DaemonProcessOptions } from '../daemon/process-lifecycle.js';
import type { DaemonCliConfiguration } from './configuration.js';
import type { DaemonCliFlags } from './types.js';

/** The launcher supplies real inbox composition and explicitly chooses host-only capabilities. */
export type DaemonCliRuntime = Pick<RuntimeServicesOptions,
  'inboxFactory' | 'localUserAuthManager' | 'observeExternalAgents' | 'powerSeam' | 'provisionWakeModelsAtBoot' | 'capturedBunRuntimeExecutable'>;

export function prepareDaemonCliServe(config: DaemonCliConfiguration['config'], flags: DaemonCliFlags): readonly string[] {
  const errors = [...applyRuntimeConfigOverrides(config, flags.configOverrides)];
  if (errors.length) return errors;
  errors.push(...applyRuntimeFeatureFlagOverrides(config, flags));
  if (errors.length) return errors;
  if (flags.provider !== undefined || flags.model !== undefined) {
    const current = config.get('provider.model');
    const provider = (flags.provider ?? getProviderIdFromModel(current)).trim();
    const supplied = flags.model?.trim();
    // The daemon catalog accepts provider:model and provider/model. Strip only
    // that first provider qualifier, retaining nested model namespaces/colons.
    const qualified = supplied !== undefined && !supplied.includes(':') ? supplied.replace('/', ':') : supplied;
    const model = qualified === undefined ? getModelIdFromProviderModel(current) : getModelIdFromProviderModel(qualified);
    if (!provider || supplied === '' || !model) return ['Provider and model identifiers must be nonempty'];
    // formatProviderModel intentionally preserves qualified input, which would
    // override the CLI's explicit-provider-wins rule when a model contains ':'.
    applyRuntimeConfigValue(config, 'provider.model', `${provider}:${model}`);
  }
  errors.push(...applyRuntimeEndpointFlagOverrides(config, 'controlPlane', flags));
  if (!resolveRuntimeEndpointBinding(config, 'controlPlane').recognized) errors.push('Unrecognized control-plane host mode');
  return errors;
}

export function runConfiguredDaemonCli(
  configuration: DaemonCliConfiguration,
  runtime: DaemonCliRuntime,
  env: NodeJS.ProcessEnv,
  processOptions?: DaemonProcessOptions,
  reportTokenReset: (message: string) => void = (message) => { writeSync(2, `${message}\n`); },
) {
  const { config, homeDirectory, daemonHomeDirectory, workingDirectory } = configuration;
  // runDaemonProcess constructs its owner even when shutdown won admission.
  // Keep token and graph acquisition inside start, after that admission fence.
  return runDaemonProcess(() => {
    let host: ReturnType<typeof createDaemonHost> | undefined;
    let closed = false;
    return {
      async start() {
        if (closed) return undefined;
        const companion = getOrCreateCompanionToken('tui', { daemonHomeDir: daemonHomeDirectory });
        if (companion.quarantined) {
          reportTokenReset('The selected daemon operator token store was unreadable. A new shared token was created; paired clients must pair again. '
            + (companion.quarantined.to ? 'The previous file was preserved beside the token store.' : 'The previous file could not be preserved.'));
        }
        // An injected reporting port can synchronously request shutdown.
        if (closed) return undefined;
        const token = env.GOODVIBES_DAEMON_TOKEN ?? companion.token;
        host = createDaemonHost({
          runtime: {
            ...runtime, configManager: config, homeDirectory, daemonHomeDirectory, workingDir: workingDirectory,
            runtimeBus: new RuntimeEventBus(runtimeEventBusOptionsFrom((key) => config.get(key))),
            runtimeStore: createRuntimeStore(),
          },
          daemon: { token },
          ...(config.get('danger.httpListener') ? { httpListener: { token: env.GOODVIBES_HTTP_TOKEN ?? token } } : {}),
        });
        return host.start();
      },
      close() {
        closed = true;
        return host?.close() ?? Promise.resolve();
      },
    };
  }, processOptions);
}

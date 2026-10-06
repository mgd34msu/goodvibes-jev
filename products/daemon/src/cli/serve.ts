/** Explicit serving composition. There is deliberately no substitute inbox. */
import {
  applyRuntimeConfigOverrides, applyRuntimeConfigValue, applyRuntimeEndpointFlagOverrides,
  applyRuntimeFeatureFlagOverrides, resolveRuntimeEndpointBinding,
} from '@goodvibes-jev/engine/terminal-shell';
import { formatProviderModel, getModelIdFromProviderModel, getProviderIdFromModel } from '@goodvibes-jev/engine/sdk/platform/providers';
import { createRuntimeStore } from '@goodvibes-jev/engine/sdk/platform/runtime/store';
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
    applyRuntimeConfigValue(config, 'provider.model', formatProviderModel(
      flags.provider ?? getProviderIdFromModel(current), getModelIdFromProviderModel(flags.model ?? current),
    ));
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
) {
  const { config, homeDirectory, daemonHomeDirectory, workingDirectory } = configuration;
  // The process installs signal ownership before constructing the host or graph.
  return runDaemonProcess(() => createDaemonHost({
    runtime: {
      ...runtime, configManager: config, homeDirectory, daemonHomeDirectory, workingDir: workingDirectory,
      runtimeBus: new RuntimeEventBus(runtimeEventBusOptionsFrom((key) => config.get(key))),
      runtimeStore: createRuntimeStore(),
    },
    daemon: { token: env.GOODVIBES_DAEMON_TOKEN },
    ...(config.get('danger.httpListener') ? { httpListener: { token: env.GOODVIBES_HTTP_TOKEN ?? env.GOODVIBES_DAEMON_TOKEN } } : {}),
  }), processOptions);
}

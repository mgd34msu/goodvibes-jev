import type { ConfigKey } from '@goodvibes-jev/engine/sdk/platform/config';
import type { CliServiceRuntime } from '../cli/service-posture.ts';

export const AGENT_EXTERNAL_HOST_SERVICE_MESSAGE = 'GoodVibes Agent uses a connected GoodVibes host and does not install, start, stop, restart, or uninstall it. Manage host lifecycle outside Agent.';

export interface ServiceSettingsSyncChange {
  readonly key: ConfigKey;
  readonly previousValue: unknown;
  readonly value: unknown;
}

export interface ServiceSettingsSyncResult {
  readonly handled: boolean;
  readonly action?: 'connected-host-blocked' | 'unchanged';
  readonly message?: string;
  readonly error?: string;
}

export interface ServiceSettingsSyncOptions {
  readonly allowExternalHostMutation?: false;
}

export function syncServiceSettingToPlatform(
  runtime: CliServiceRuntime,
  change: ServiceSettingsSyncChange,
  _options: ServiceSettingsSyncOptions = {},
): ServiceSettingsSyncResult {
  if (!String(change.key).startsWith('service.')) return { handled: false };
  if (change.previousValue === change.value) {
    return {
      handled: true,
      action: 'unchanged',
      message: 'Connected-host setting unchanged',
    };
  }

  runtime.configManager.setDynamic(change.key, change.previousValue);
  return {
    handled: true,
    action: 'connected-host-blocked',
    message: AGENT_EXTERNAL_HOST_SERVICE_MESSAGE,
    error: 'connected_host_lifecycle_external',
  };
}

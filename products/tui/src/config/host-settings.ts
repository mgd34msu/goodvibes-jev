import { ConfigManager, type ConfigKey, type HostBooleanSetting } from '@goodvibes-jev/engine/sdk/platform/config';
import { NOTIFICATIONS_METADATA_ONLY_KEY } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';

export const TUI_NOTIFICATIONS_METADATA_ONLY_KEY = NOTIFICATIONS_METADATA_ONLY_KEY;

const NOTIFICATION_PRIVACY_SETTING: HostBooleanSetting = Object.freeze({
  key: NOTIFICATIONS_METADATA_ONLY_KEY,
  type: 'boolean',
  default: true,
  description: 'Keep notifications metadata-only. Only explicit false permits details on supported notification paths.',
});

// This switch is consumed by the TUI terminal notifier and exposed in its
// settings workspace. Register it before ingestion so an enabled OSC 9 feature
// is not sent to the unknown-setting classifier as a possible renamed SDK key.
const TERMINAL_TURN_END_SETTING: HostBooleanSetting = Object.freeze({
  key: 'behavior.terminalNotifyTurnEnd',
  type: 'boolean',
  default: false,
  description: 'Send an in-terminal (OSC 9) desktop notification when a turn finishes. Off by default. Fires only when the terminal window is unfocused.',
});

/** Register TUI-owned settings without changing the shared SDK schema or defaults. */
export class TuiConfigManager extends ConfigManager {
  constructor(options: ConstructorParameters<typeof ConfigManager>[0]) {
    super({ ...options, hostSettings: [...(options.hostSettings ?? []), NOTIFICATION_PRIVACY_SETTING, TERMINAL_TURN_END_SETTING] });
  }
}

/** Live host consent; an unregistered or unavailable owner remains restrictive. */
export function readTuiNotificationsMetadataOnly(config: Pick<ConfigManager, 'getHostBooleanSetting'>): boolean {
  try { return config.getHostBooleanSetting(TUI_NOTIFICATIONS_METADATA_ONLY_KEY).get() !== false; }
  catch { return true; }
}

/** Product composition facade for legacy string-key notification consumers. */
export function readTuiConfigValue(config: Pick<ConfigManager, 'get' | 'getHostBooleanSetting'>, key: string): unknown {
  if (key === TUI_NOTIFICATIONS_METADATA_ONLY_KEY) return readTuiNotificationsMetadataOnly(config);
  return config.get(key as ConfigKey);
}

export function subscribeTuiConfigValue(
  config: Pick<ConfigManager, 'subscribe' | 'getHostBooleanSetting'>,
  key: string,
  callback: (...args: unknown[]) => void,
): () => void {
  if (key === TUI_NOTIFICATIONS_METADATA_ONLY_KEY) return config.getHostBooleanSetting(key).subscribe(callback);
  return config.subscribe(key as ConfigKey, callback);
}

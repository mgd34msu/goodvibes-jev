import { ConfigManager, type ConfigKey, type HostBooleanSetting } from '@goodvibes-jev/engine/sdk/platform/config';
import { NOTIFICATIONS_METADATA_ONLY_KEY } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';

export const TUI_NOTIFICATIONS_METADATA_ONLY_KEY = NOTIFICATIONS_METADATA_ONLY_KEY as ConfigKey;

const NOTIFICATION_PRIVACY_SETTING: HostBooleanSetting = Object.freeze({
  key: NOTIFICATIONS_METADATA_ONLY_KEY,
  type: 'boolean',
  default: true,
  description: 'Keep notifications metadata-only. Only explicit false permits details on supported notification paths.',
});

/** Register TUI-owned settings without changing the shared SDK schema or defaults. */
export class TuiConfigManager extends ConfigManager {
  constructor(options: ConstructorParameters<typeof ConfigManager>[0]) {
    super({ ...options, hostSettings: [...(options.hostSettings ?? []), NOTIFICATION_PRIVACY_SETTING] });
  }
}

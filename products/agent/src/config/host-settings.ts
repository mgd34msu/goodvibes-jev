import { ConfigManager, type ConfigKey, type HostBooleanSetting } from '@goodvibes-jev/engine/sdk/platform/config';
import { NOTIFICATIONS_METADATA_ONLY_KEY } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';

// The host key is validated and registered on each Agent instance before load.
// SDK ConfigKey remains the builtin-key union; schema-driven consumers use this
// checked boundary without augmenting the SDK's global key/default declarations.
export const AGENT_NOTIFICATIONS_METADATA_ONLY_KEY = NOTIFICATIONS_METADATA_ONLY_KEY as ConfigKey;

const NOTIFICATION_PRIVACY_SETTING: HostBooleanSetting = Object.freeze({
  key: NOTIFICATIONS_METADATA_ONLY_KEY,
  type: 'boolean',
  default: true,
  description: 'Keep notifications metadata-only. Only explicit false permits details on supported notification paths.',
});

/** Agent construction opts into the public instance-owned SDK host schema. */
export class AgentConfigManager extends ConfigManager {
  constructor(options: ConstructorParameters<typeof ConfigManager>[0]) {
    super({ ...options, hostSettings: [...(options.hostSettings ?? []), NOTIFICATION_PRIVACY_SETTING] });
  }
}

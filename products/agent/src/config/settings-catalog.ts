import type { ConfigKey, ConfigManager, ConfigSetting } from '@goodvibes-jev/engine/sdk/platform/config';
import { AGENT_NOTIFICATIONS_METADATA_ONLY_KEY } from './host-settings.ts';

export type AgentHostSetting = Omit<ConfigSetting, 'key' | 'type' | 'default'> & {
  readonly kind: 'host';
  readonly key: typeof AGENT_NOTIFICATIONS_METADATA_ONLY_KEY;
  readonly type: 'boolean';
  readonly default: boolean;
};
export type AgentConfigSetting = (ConfigSetting & { readonly kind?: 'builtin' }) | AgentHostSetting;
export type AgentSettingKey = ConfigKey | AgentHostSetting['key'];
export type AgentHostReader = Partial<Pick<ConfigManager, 'getHostSettingsSchema' | 'getHostBooleanSetting'>>;
export type AgentSettingsCatalog = Pick<ConfigManager, 'getSchema'> & AgentHostReader;

/** Keep SDK builtin rows and the Agent's registered host row honestly typed. */
export function getAgentSettingsSchema(config: AgentSettingsCatalog): AgentConfigSetting[] {
  const builtin = config.getSchema();
  const host = config.getHostSettingsSchema?.().find(setting => setting.key === AGENT_NOTIFICATIONS_METADATA_ONLY_KEY);
  return host ? [...builtin, { ...host, kind: 'host', key: AGENT_NOTIFICATIONS_METADATA_ONLY_KEY }] : builtin;
}

export function readAgentSettingValue(config: Pick<ConfigManager, 'get' | 'getHostBooleanSetting'>, setting: AgentConfigSetting): unknown {
  return setting.kind === 'host' ? config.getHostBooleanSetting(setting.key).get() : config.get(setting.key);
}

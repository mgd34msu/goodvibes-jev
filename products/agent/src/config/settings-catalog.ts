import type { ConfigKey, ConfigManager, ConfigSetting } from '@goodvibes-jev/engine/sdk/platform/config';
import { isAgentHostSettingKey, type AgentHostSettingKey } from './host-settings.ts';

export type AgentHostSetting = Omit<ConfigSetting, 'key' | 'type' | 'default'> & {
  readonly kind: 'host';
  readonly key: AgentHostSettingKey;
  readonly type: 'boolean';
  readonly default: boolean;
};
export type AgentConfigSetting = (ConfigSetting & { readonly kind?: 'builtin' }) | AgentHostSetting;
export type AgentSettingKey = ConfigKey | AgentHostSetting['key'];
export type AgentHostReader = Partial<Pick<ConfigManager, 'getHostSettingsSchema' | 'getHostBooleanSetting'>>;
export type AgentSettingsCatalog = Pick<ConfigManager, 'getSchema'> & AgentHostReader;

/** Keep SDK builtin rows and the Agent's registered host rows honestly typed. */
export function getAgentSettingsSchema(config: AgentSettingsCatalog): AgentConfigSetting[] {
  const builtin = config.getSchema();
  const hosts: AgentHostSetting[] = [];
  for (const setting of config.getHostSettingsSchema?.() ?? []) {
    const key = setting.key;
    if (isAgentHostSettingKey(key)) hosts.push({ ...setting, kind: 'host', key });
  }
  return [...builtin, ...hosts];
}

export function readAgentSettingValue(config: Pick<ConfigManager, 'get' | 'getHostBooleanSetting'>, setting: AgentConfigSetting): unknown {
  return setting.kind === 'host' ? config.getHostBooleanSetting(setting.key).get() : config.get(setting.key);
}

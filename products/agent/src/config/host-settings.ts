import { ConfigManager, type HostBooleanSetting } from '@goodvibes-jev/engine/sdk/platform/config';
import { NOTIFICATIONS_METADATA_ONLY_KEY } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';

// The host key is validated and registered on each Agent instance before load.
// SDK ConfigKey remains the builtin-key union; Agent uses a validated host handle.
export const AGENT_NOTIFICATIONS_METADATA_ONLY_KEY = NOTIFICATIONS_METADATA_ONLY_KEY;
export const AGENT_HOSTED_RESEARCH_SCREENING_KEY = 'tools.hostedResearchScreening';
export type AgentHostSettingKey = typeof AGENT_NOTIFICATIONS_METADATA_ONLY_KEY | typeof AGENT_HOSTED_RESEARCH_SCREENING_KEY;
export function isAgentHostSettingKey(key: string): key is AgentHostSettingKey {
  return key === AGENT_NOTIFICATIONS_METADATA_ONLY_KEY || key === AGENT_HOSTED_RESEARCH_SCREENING_KEY;
}

/** Narrow reader for the SDK's notification privacy callback. */
export function readAgentHostSetting(config: Pick<ConfigManager, 'getHostBooleanSetting'>, key: string): boolean | undefined {
  return key === AGENT_NOTIFICATIONS_METADATA_ONLY_KEY ? config.getHostBooleanSetting(key).get() : undefined;
}

const NOTIFICATION_PRIVACY_SETTING: HostBooleanSetting = Object.freeze({
  key: NOTIFICATIONS_METADATA_ONLY_KEY,
  type: 'boolean',
  default: true,
  description: 'Keep notifications metadata-only. Only explicit false permits details on supported notification paths.',
});

const HOSTED_RESEARCH_SCREENING_SETTING: HostBooleanSetting = Object.freeze({
  key: AGENT_HOSTED_RESEARCH_SCREENING_KEY,
  type: 'boolean',
  default: false,
  description: 'Explicitly allow raw research report text and source URLs to be screened by Abacus route-llm and TypeSafe Jev. Providers manage retention; zero retention is unverified. Requires native ABACUSAI_API_KEY and TYPESAFE_API_KEY credentials. Covers research report preview, save, and the research editor only.',
});

/** Agent construction opts into the public instance-owned SDK host schema. */
export class AgentConfigManager extends ConfigManager {
  constructor(options: ConstructorParameters<typeof ConfigManager>[0]) {
    super({ ...options, hostSettings: [...(options.hostSettings ?? []), NOTIFICATION_PRIVACY_SETTING, HOSTED_RESEARCH_SCREENING_SETTING] });
  }
}

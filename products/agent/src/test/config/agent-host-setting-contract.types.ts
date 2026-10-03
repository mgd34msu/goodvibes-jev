import type { ConfigKey, HostBooleanSettingResolved } from '@goodvibes-jev/engine/sdk/platform/config';
import { AgentConfigManager, AGENT_NOTIFICATIONS_METADATA_ONLY_KEY as KEY } from '../../config/host-settings.ts';
import { getAgentSettingsSchema } from '../../config/settings-catalog.ts';

// Compiled by the full Agent test project; never executed by runtime discovery.
function assertAgentHostContract(config: AgentConfigManager): void {
  const handle = config.getHostBooleanSetting(KEY);
  const value: boolean = handle.get();
  const resolved: HostBooleanSettingResolved = handle.getResolved();
  const defaultValue: boolean = resolved.defaultValue;
  handle.set(false); handle.setProjectValue(true); handle.reset();
  const stop: () => void = handle.subscribe((next, previous) => {
    const values: boolean[] = [next, previous]; void values;
  });
  stop();
  const builtinKey: ConfigKey = config.getSchema()[0]!.key;
  config.get(builtinKey);
  for (const setting of getAgentSettingsSchema(config)) {
    if (setting.kind === 'host') {
      const hostKey: typeof KEY = setting.key;
      const hostDefault: boolean = setting.default;
      config.getHostBooleanSetting(hostKey).set(hostDefault);
      // @ts-expect-error A truthful host row cannot enter the builtin getter.
      config.get(setting.key);
    } else {
      const key: ConfigKey = setting.key;
      config.get(key);
    }
  }
  // @ts-expect-error Host writes accept boolean scalars only.
  handle.set('false');
  // @ts-expect-error Project writes have the same boolean contract.
  handle.setProjectValue(0);
  // @ts-expect-error The typed callback cannot claim string values.
  handle.subscribe((_next: string, _previous: string) => {});
  // @ts-expect-error The validated handle's identity is readonly.
  handle.key = 'behavior.other';
  // @ts-expect-error Bound methods are readonly.
  handle.get = () => true;
  // @ts-expect-error Resolved metadata is a readonly snapshot.
  resolved.value = false;
  // @ts-expect-error Agent registration never widens builtin keys.
  config.set(KEY, false);
  // @ts-expect-error Agent registration never widens builtin subscriptions.
  config.subscribe(KEY, () => {});
  // @ts-expect-error Agent registration never widens builtin reset.
  config.reset(KEY);
  void [value, defaultValue];
}
void assertAgentHostContract;

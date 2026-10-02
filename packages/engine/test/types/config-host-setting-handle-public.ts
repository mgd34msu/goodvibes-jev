import { ConfigManager, type ConfigKey, type HostBooleanSetting, type HostBooleanSettingHandle, type HostBooleanSettingResolved } from '@goodvibes-jev/engine/sdk/platform/config';
import { getSettingsControlPlaneSnapshot } from '@goodvibes-jev/engine/sdk/platform/runtime/settings';

const config = new ConfigManager({
  configDir: '/tmp/compile-only-host-setting',
  hostSettings: [{ key: 'behavior.consumerPrivacy', type: 'boolean', default: true, description: 'Synthetic host preference' }],
});
const handle: HostBooleanSettingHandle = config.getHostBooleanSetting('behavior.consumerPrivacy');
const value: boolean = handle.get();
const key: string = handle.key;
const hostSchema: readonly HostBooleanSetting[] = config.getHostSettingsSchema();
const builtinKey: ConfigKey = config.getSchema()[0]!.key;
const snapshotKey: ConfigKey = getSettingsControlPlaneSnapshot(config).resolvedEntries[0]!.key;
const builtinLockKey: ConfigKey = getSettingsControlPlaneSnapshot(config).managedLocks[0]!.key;
const resolved: HostBooleanSettingResolved = handle.getResolved();
const source: 'default' | 'local' = resolved.source;
const values: boolean[] = [resolved.value, resolved.defaultValue];
if (resolved.managedLock) {
  const lock: readonly [string, string, number] = [resolved.managedLock.source, resolved.managedLock.reason, resolved.managedLock.updatedAt];
  void lock;
  // @ts-expect-error Policy metadata cannot be mutated through a host read.
  resolved.managedLock.reason = 'changed';
}
handle.set(false);
handle.setProjectValue(true, { bypassManagedLock: true });
const off: () => void = handle.subscribe((next, previous) => {
  const values: boolean[] = [next, previous];
  void values;
  // @ts-expect-error A host callback value is boolean.
  next.toUpperCase();
});
const { get, getResolved, set, setProjectValue, subscribe, reset } = handle;
const detached: boolean = get();
set(false); setProjectValue(true); subscribe((_next: boolean, _previous: boolean) => {}); reset(); off();
void [value, key, detached, hostSchema, builtinKey, snapshotKey, builtinLockKey, source, values, getResolved()];

// @ts-expect-error Host scalar writes accept literal booleans only.
handle.set('false');
// @ts-expect-error Project writes have the same boolean boundary.
handle.setProjectValue(0);
// @ts-expect-error Host reads are boolean, not arbitrary schema value unions.
const incorrect: string = handle.get();
// @ts-expect-error Callback parameters must be boolean.
handle.subscribe((_next: string, _previous: string) => {});
// @ts-expect-error The bound identity cannot change.
handle.key = 'behavior.other';
// @ts-expect-error Bound handle methods are immutable.
handle.get = () => true;
// @ts-expect-error Resolved value snapshots are readonly.
resolved.value = false;
// @ts-expect-error Host output keys remain strings rather than masquerading as builtin keys.
const hostAsBuiltin: ConfigKey = resolved.key;
// @ts-expect-error Host schema keys are also separate from builtin keys.
const schemaAsBuiltin: ConfigKey = hostSchema[0]!.key;
// @ts-expect-error Registered descriptor arrays cannot be changed by consumers.
hostSchema.push({ key: 'behavior.other', type: 'boolean', default: true, description: 'Other' });
// @ts-expect-error Registered descriptor defaults are readonly.
hostSchema[0]!.default = false;
// @ts-expect-error Existing set options remain exact.
handle.set(false, { unknownOption: true });
// @ts-expect-error Registration does not widen the ordinary ConfigKey API.
config.get('behavior.consumerPrivacy');
// @ts-expect-error Existing unknown-key dynamic API typing stays unchanged.
config.setDynamic('behavior.consumerPrivacy', false);
void [incorrect, hostAsBuiltin, schemaAsBuiltin];

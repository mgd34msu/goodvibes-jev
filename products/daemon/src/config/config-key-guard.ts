/**
 * config-key-guard.ts
 *
 * ConfigManager.get/set/reset are typed `<K extends ConfigKey>`, a
 * compile-time constraint that says nothing about a key that only exists as a
 * plain string at runtime: a `config get <key>` CLI argument, or the
 * `key: string` the SDK's readControlPlaneBinding hands back through its own
 * read callback. Every one of those call sites used to write `key as
 * ConfigKey` and trust the string was really a known key without the compiler
 * ever seeing why that trust was justified.
 *
 * This guard makes the check honest: it is the schema lookup those call sites
 * already ran (or could run) to decide the same thing, exposed as a real
 * `key is ConfigKey` predicate so `key` narrows at the call site instead of
 * being asserted. Same shape as isSecretConfigKey in ./secret-config.ts.
 */
import type { ConfigKey, ConfigSetting } from '@goodvibes-jev/engine/sdk/platform/config';

/** True when `key` names a setting in `schema`; narrows `key` to ConfigKey. */
export function isKnownConfigKey(key: string, schema: readonly ConfigSetting[]): key is ConfigKey {
  return schema.some((setting) => setting.key === key);
}

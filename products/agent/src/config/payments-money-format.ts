/**
 * payments-money-format.ts, detects which config settings hold a plain
 * currency amount.
 *
 * SDK 2.0.5 renamed every `payments.budget.*` amount key (the `Cents` suffix
 * is gone) and changed what the stored number means: it is now the amount a
 * person would say out loud, written exactly as typed, `100` is a hundred,
 * `19.99` is nineteen ninety-nine, rather than an integer count of the
 * currency's smallest division. There is no longer a major/minor conversion
 * for this repo to perform: a money setting's edit buffer and display are
 * identical to a plain number setting's, since the stored value already IS
 * the display value.
 *
 * The SDK's own config-set path (`coerceSchemaValue` / `coerceMoneyAmount` in
 * the SDK's platform/config/money-value.ts) is what tolerates a leading
 * currency symbol or thousands grouping on write and refuses anything else;
 * nothing here re-implements that parsing.
 *
 * What is kept here is detection: a setting is a money field when the
 * SCHEMA says so (`ConfigSetting.unit === 'money'`), never by pattern-
 * matching the key's NAME, the name-suffix scheme this replaces is exactly
 * what tied every consumer of these keys to one spelling.
 */
import type { ConfigSetting } from '@goodvibes-jev/engine/sdk/platform/config';

/** True when the schema marks `setting` as holding an amount of `payments.currency`. */
export function isMoneyConfigKey(setting: ConfigSetting): boolean {
  return setting.unit === 'money';
}

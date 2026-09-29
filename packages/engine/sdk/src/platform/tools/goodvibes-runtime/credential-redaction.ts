/**
 * credential-redaction.ts, what the goodvibes runtime tools may show of a
 * config value.
 *
 * A value is redacted when its KEY holds a credential or the VALUE itself is
 * credential material:
 *   - A schema key holds a credential when the declared list names it
 *     (config/secret-bearing-config-keys.ts). Every schema key the list does
 *     not name was read through `config.credential-key` at commit time, and
 *     the pre-commit credential-scope check refuses one that reads as a
 *     credential undeclared, so for a schema key the list already carries the
 *     reading. Any other key (a path inside a status object) is read now
 *     through `holdsCredential`, the same battery.
 *   - A string value under a key that is not a credential is read by Jev
 *     (`engine.tools.credential-value`) and shown only on a no that acts. Not
 *     read: an empty value, a `goodvibes://` reference (it names a stored
 *     secret rather than holding one), and the schema's own default (fixed
 *     text in config/schema.ts, the same on every install).
 * A failed reading throws, and the tool reports it as its error.
 */
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { isValidConfigKey } from '../../config/schema.js';
import { configKeyDescription, holdsCredential } from '../../config/credential-key-reading.js';
import { isSecretBearingConfigKey } from '../../config/secret-bearing-config-keys.js';
import { credentialValue, credentialValueState } from '../batteries/credential-value.js';

const KEY_SITE = 'tools.goodvibes-runtime.credential-key';
const VALUE_SITE = 'tools.goodvibes-runtime.credential-value';

const SECRET_REFERENCE_SCHEME = 'goodvibes://';

/** Whether a config key holds credential material. */
export async function isCredentialConfigKey(key: string): Promise<boolean> {
  if (isValidConfigKey(key)) return isSecretBearingConfigKey(key);
  return holdsCredential(key, configKeyDescription(key), KEY_SITE);
}

/** Whether a stored value is shown as it is: only a no that acts clears it. */
async function valueMayShow(key: string, value: string): Promise<boolean> {
  const state = credentialValueState(key, configKeyDescription(key), value);
  const run = await credentialValue.run(judgmentPort(VALUE_SITE), state, { site: VALUE_SITE });
  const { verdict, outcome } = run.readings.credential_material;
  const shown = verdict === 'no' && outcome === 'act';
  run.recordAction(shown ? 'shown' : 'redacted');
  return shown;
}

function redacted(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined || value === '') return { redacted: true, configured: false };
  return {
    redacted: true,
    configured: true,
    source: typeof value === 'string' && value.startsWith(SECRET_REFERENCE_SCHEME) ? 'goodvibes-secret-ref' : 'credential-like-value',
  };
}

/**
 * The value as the tools may show it.
 *
 * @param key - The dotted config key the value is stored under.
 * @param value - The stored value.
 * @param schemaDefault - The key's schema default when it has one; a value equal to it is not read.
 */
export async function redactConfigValue(key: string, value: unknown, schemaDefault?: unknown): Promise<unknown> {
  if (await isCredentialConfigKey(key)) return redacted(value);
  if (typeof value !== 'string' || value.trim() === '' || value.trim().startsWith(SECRET_REFERENCE_SCHEME)) return value;
  if (schemaDefault !== undefined && value === schemaDefault) return value;
  return (await valueMayShow(key, value)) ? value : redacted(value);
}

/** Every leaf of a nested object, each redacted under its dotted path below `prefix`. */
export async function redactObjectByPath(prefix: string, value: unknown): Promise<unknown> {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Promise.all(value.map((entry, index) => redactObjectByPath(`${prefix}.${index}`, entry)));
  const entries = await Promise.all(
    Object.entries(value as Record<string, unknown>).map(async ([key, entry]) => [key, await redactConfigValue(`${prefix}.${key}`, entry)] as const),
  );
  return Object.fromEntries(entries);
}

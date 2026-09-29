/**
 * Reads whether an undeclared config key holds credential material, through
 * the `config.credential-key` battery. The declared list in
 * secret-bearing-config-keys.ts is checked first and exactly; only a key it
 * does not name is read.
 */
import type { YesNoReading } from '@goodvibes-jev/judgment';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { credentialKey, type CredentialKeyState } from './batteries/credential-key.js';
import { isSecretBearingConfigKey } from './secret-bearing-config-keys.js';
import { CONFIG_SCHEMA } from './schema.js';

/** Jev's reading of whether `state.key` holds a credential. Throws when no reading can be made. */
export async function readCredentialKey(state: CredentialKeyState, site: string): Promise<YesNoReading> {
  const run = await credentialKey.run(judgmentPort(site), state, { site });
  return run.readings.credential;
}

/**
 * True when the key is declared secret-bearing, or reads as a credential with
 * a yes strong enough to act on. `description` is the key's schema
 * description, or empty when it has none.
 */
export async function holdsCredential(key: string, description: string, site: string): Promise<boolean> {
  if (isSecretBearingConfigKey(key)) return true;
  const reading = await readCredentialKey({ key, description }, site);
  return reading.verdict === 'yes' && reading.outcome === 'act';
}

/** The schema description of a config key, or empty when the schema has no entry for it. */
export function configKeyDescription(key: string): string {
  return CONFIG_SCHEMA.find((setting) => setting.key === key)?.description ?? '';
}

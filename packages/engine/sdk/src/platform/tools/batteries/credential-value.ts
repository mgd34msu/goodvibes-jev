/**
 * `engine.tools.credential-value`: is a stored config value itself credential
 * material? Read by Jev in place of the four token shapes the goodvibes
 * runtime tools matched (`Bearer ` plus twelve characters, `ghp_`, `sk-`,
 * `xox?-`), which printed a database URL carrying a password, an AWS secret
 * or any other provider's key in the clear, and caught nothing but those four
 * spellings.
 *
 * Asked by goodvibes_context and goodvibes_settings about a string value they
 * are about to show, under a key not already known to hold a credential. The
 * key and its schema description ride beside the value as context.
 *
 * Band: asymmetric. A wrong no prints a credential into a model's context; a
 * wrong yes hides one harmless value behind `redacted`, which the owner can
 * read from the config file. Showing a value needs a strong no (the high
 * band's no side); redacting acts on a medium yes. Code redacts every value
 * the reading does not clear with an acting no.
 */
import { defineBattery, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';

/** Most characters of a value the reading carries. */
export const MAX_JUDGED_VALUE_CHARS = 400;

/** A type alias rather than an interface, so it is assignable to the port's JSON state type. */
export type CredentialValueState = {
  readonly key: string;
  readonly description: string;
  readonly value: string;
};

/** The reading's state for one stored value, clipped to what the reading carries. */
export function credentialValueState(key: string, description: string, value: string): CredentialValueState {
  const clipped = value.length <= MAX_JUDGED_VALUE_CHARS ? value : `${value.slice(0, MAX_JUDGED_VALUE_CHARS)} [${value.length - MAX_JUDGED_VALUE_CHARS} more characters]`;
  return { key, description, value: clipped };
}

// Fixture credentials are assembled from parts so the committed text does not
// match a live-key scanner; Jev reads the joined value.
const join = (...parts: string[]) => parts.join('');

export const credentialValue = defineBattery({
  name: 'engine.tools.credential-value',
  version: 1,
  description: 'Whether a stored config value is itself credential material that would grant access if copied.',
  accuracyFloor: 0.85,
  items: {
    credential_material: yesNo(
      '`value` is the value stored in the config setting `key`, described by `description` (empty when the setting has no description). Is `value` itself credential material, something that grants access to anyone who copies it: an API key, an access, bot or bearer token, a password or passphrase, a private key or signing secret, or a connection string or URL that carries a password or access key? Model names, ids, user names, channel or topic names, host names, file paths, plain URLs, dates, versions and on/off words are not.',
      { yes: STAKES_BANDS.medium.confidence, no: STAKES_BANDS.high.confidence },
    ),
  },
  fixtures: [
    { name: 'bearer header value', state: credentialValueState('provider.extraHeader', 'Extra header sent with every provider request', join('Bearer ', 'eyJhbGciOiJIUzI1NiJ9', '.eyJzdWIiOiIxMjM0In0', '.c2lnbmF0dXJlLWJ5dGVz')), expect: { credential_material: 'yes' } },
    { name: 'chat bot token in a notes field', state: credentialValueState('surfaces.slack.notes', 'Free-form notes about this workspace', join('xo', 'xb-', '2213874', '-5518842093', '-kQ8vT2mLp9RzX4cW7nB1dFy')), expect: { credential_material: 'yes' } },
    { name: 'personal access token', state: credentialValueState('integrations.github.owner', 'GitHub user or organisation the integration acts for', join('gh', 'p_', 'R7tK2mQ9vX4pL8zW3nB6cY1dF5gH0jS2aE7u')), expect: { credential_material: 'yes' } },
    { name: 'database url with a password', state: credentialValueState('storage.databaseUrl', 'Database the daemon stores sessions in', 'postgres://app:Qx7pLm2vR9zT4w@db.internal:5432/app'), expect: { credential_material: 'yes' } },
    { name: 'provider key under a model field', state: credentialValueState('provider.model', 'Model id for the default provider', join('s', 'k-', 'proj-', 'Tq8Vn3Lx5Rz2Wc7Pb4Kd9Mf6Hs1Jg0Ya')), expect: { credential_material: 'yes' } },
    { name: 'model id', state: credentialValueState('provider.model', 'Model id for the default provider', 'claude-sonnet-4-5'), expect: { credential_material: 'no' } },
    { name: 'bot username', state: credentialValueState('surfaces.telegram.botUsername', 'The bot\'s public username', 'goodvibes_agent_bot'), expect: { credential_material: 'no' } },
    { name: 'data path', state: credentialValueState('storage.dataDir', 'Directory the daemon keeps its data in', '/home/mike/.goodvibes/data'), expect: { credential_material: 'no' } },
    { name: 'plain base url', state: credentialValueState('provider.baseUrl', 'Base URL of the provider API', 'https://api.example.com/v1'), expect: { credential_material: 'no' } },
    { name: 'topic name', state: credentialValueState('surfaces.ntfy.topic', 'Topic the daemon publishes alerts to', 'goodvibes-alerts'), expect: { credential_material: 'no' } },
    { name: 'numeric guild id', state: credentialValueState('surfaces.discord.guildId', 'Discord server id', '112233445566778899'), expect: { credential_material: 'no' } },
    { name: 'api version date', state: credentialValueState('provider.apiVersion', 'API version header value', '2024-06-01'), expect: { credential_material: 'no' } },
  ],
});

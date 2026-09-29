/**
 * `engine.runtime.config-event-credential-key`: may a config change notice
 * carry the new value of a setting the declared list does not name, or does
 * the setting hold credential material? Read by runtime/config/emit-bridge.ts
 * in place of the name pattern that treated an undeclared key as a credential
 * when its name ended in password, passphrase, secret, token, apikey, api_key
 * or credential (CREDENTIAL_NAME_PATTERN, config/secret-bearing-config-keys.ts).
 * The suffix masked `surfaces.telegram.discoveredBotTokenId`, an id, and would
 * have sent `mesh.phrase`, a shared signing phrase, to every subscriber.
 *
 * Declared keys (the SECRET_BEARING list) and CONFIG_SCHEMA keys stay code; this
 * reading is asked only about a watched path that is neither, from its dotted
 * key and schema description (empty when it has none), once per key.
 *
 * Band: critical stakes. A change notice goes to every client subscribed to
 * the daemon's `config` event stream; a credential read as an ordinary setting
 * is broadcast in the clear, while an ordinary setting read as a credential
 * only costs the subscriber a re-read. The value is carried only on a no
 * verdict, which the critical band gives at 0.9 confidence or more.
 *
 * The question matches `config.credential-key` (config/batteries/credential-key.ts)
 * in substance; that battery reads at high stakes for sites that store or dump
 * a value, and this one at critical stakes for a broadcast.
 */
import { defineBattery, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';

/** A type alias rather than an interface, so it is assignable to the port's JSON state type. */
export type EventCredentialKeyState = {
  readonly key: string;
  readonly description: string;
};

export const eventCredentialKey = defineBattery({
  name: 'engine.runtime.config-event-credential-key',
  version: 1,
  description: 'Whether a config setting the declared list does not name holds credential material, so its value must be left out of change notices.',
  accuracyFloor: 0.9,
  items: {
    credential: yesNo(
      'Does the config setting `key`, described by `description` (empty when the setting has no description), hold a credential: a password, passphrase, API key, access, refresh or bot token, signing, webhook or client secret, shared secret phrase, private key or key material, or a URL that grants access on its own, or a reference naming such a secret in a secret store? A setting that holds an id, a username, a public key, a file path, a list of names or addresses, a count or budget, a duration, a theme, or an on/off switch about credentials is not a credential.',
      STAKES_BANDS.critical.yesNo,
    ),
  },
  fixtures: [
    { name: 'deploy phrase with no credential word', state: { key: 'acme.deployPhrase', description: 'Passphrase the deploy hook signs its requests with' }, expect: { credential: 'yes' } },
    { name: 'shared mesh phrase', state: { key: 'mesh.phrase', description: 'Shared phrase every node signs its coordination messages with; a node without it cannot join.' }, expect: { credential: 'yes' } },
    { name: 'partner API key', state: { key: 'acme.partnerApiKey', description: '' }, expect: { credential: 'yes' } },
    { name: 'group key material', state: { key: 'mesh.groupMaterial', description: 'Symmetric key material the node group encrypts its gossip with' }, expect: { credential: 'yes' } },
    { name: 'private feed address', state: { key: 'acme.calendarFeedUrl', description: 'Private calendar feed address; the URL carries the access key, so anyone holding it can read the calendar' }, expect: { credential: 'yes' } },
    { name: 'reference to a stored token', state: { key: 'acme.hostingTokenRef', description: 'Reference into the secret store naming the hosting API token' }, expect: { credential: 'yes' } },
    { name: 'gated surfaces list', state: { key: 'conversationGate.gatedSurfaces', description: '' }, expect: { credential: 'no' } },
    { name: 'cluster peer list', state: { key: 'cluster.peers', description: 'Static list of peer node addresses to coordinate with' }, expect: { credential: 'no' } },
    { name: 'id of a token', state: { key: 'surfaces.chatapp.discoveredBotTokenId', description: 'Bot id the cached bot username was discovered for' }, expect: { credential: 'no' } },
    { name: 'theme name', state: { key: 'acme.theme', description: 'Color theme for the dashboard' }, expect: { credential: 'no' } },
    { name: 'token budget', state: { key: 'acme.maxTokensPerRun', description: 'Most model tokens one run may use' }, expect: { credential: 'no' } },
    { name: 'rotation switch', state: { key: 'acme.rotateSecrets', description: 'Whether to rotate stored secrets every 90 days' }, expect: { credential: 'no' } },
  ],
});

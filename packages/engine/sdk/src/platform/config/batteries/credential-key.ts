/**
 * `config.credential-key`: whether a config setting holds credential material,
 * read from the setting's key and its schema description. It replaces the
 * trailing-word name pattern (`…password`, `…token`, `…secret`) that
 * secret-bearing-config-keys.ts kept beside the declared list: that pattern
 * masked `surfaces.telegram.discoveredBotTokenId`, an id, and missed
 * `cloudflare.apiTokenRef`, which names a token.
 *
 * The declared list (`SECRET_BEARING_CONFIG_PATHS`) stays the rule and is
 * checked first, exactly; this reading is asked only about a key the list does
 * not name:
 *   - a key a client asks to store as a secret (credentials-write.ts);
 *   - every schema key the list does not name, by `credential-keys:read`,
 *     whose stored readings the pre-commit credential-scope check compares
 *     against the list, so a credential nobody declared blocks the commit.
 *
 * State: `{ key, description }`, the dotted key and its schema description
 * (empty when the key has none).
 *
 * Band: high stakes. A credential read as an ordinary setting is printed in
 * dumps and written in the clear; an ordinary setting read as a credential is
 * stored as a secret reference its readers cannot parse. Only an acted yes
 * counts as a credential at a runtime site.
 */
import { defineBattery, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';

/** A type alias rather than an interface, so it is assignable to the port's JSON state type. */
export type CredentialKeyState = {
  readonly key: string;
  readonly description: string;
};

export const credentialKey = defineBattery({
  name: 'config.credential-key',
  version: 1,
  description: 'Whether a config setting holds credential material, from its key and schema description.',
  accuracyFloor: 0.9,
  items: {
    credential: yesNo(
      'Does the config setting `key`, described by `description`, hold a credential: a password, passphrase, API key, access, refresh or bot token, signing, webhook or client secret, shared secret phrase, private key, or a URL that grants access on its own, or a reference naming such a secret in a secret store? A setting that holds an id, a username, a public key, a file path, a count or budget, a duration, or an on/off switch about credentials is not a credential.',
      STAKES_BANDS.high.yesNo,
    ),
  },
  fixtures: [
    { name: 'bot token', state: { key: 'surfaces.chatapp.botToken', description: 'Bot token the ChatApp adapter authenticates with' }, expect: { credential: 'yes' } },
    { name: 'signing secret', state: { key: 'surfaces.chatapp.signingSecret', description: 'Secret used to verify the signature on inbound ChatApp requests' }, expect: { credential: 'yes' } },
    { name: 'mail password', state: { key: 'mail.imap.password', description: 'Password for the IMAP account' }, expect: { credential: 'yes' } },
    { name: 'shared phrase with no credential word in the key', state: { key: 'mesh.phrase', description: 'Shared phrase every node signs its coordination messages with; a node without it cannot join.' }, expect: { credential: 'yes' } },
    { name: 'reference to a stored token', state: { key: 'hosting.apiTokenRef', description: 'Reference into the secret store naming the hosting API token' }, expect: { credential: 'yes' } },
    { name: 'feed URL with an embedded key', state: { key: 'calendar.feedUrl', description: 'Private calendar feed address; the URL carries the access key, so anyone holding it can read the calendar' }, expect: { credential: 'yes' } },
    { name: 'id of a token', state: { key: 'surfaces.chatapp.discoveredBotTokenId', description: 'Bot id the cached bot username was discovered for; managed automatically so a rotated bot token re-resolves its identity' }, expect: { credential: 'no' } },
    { name: 'token budget', state: { key: 'tools.defaultTokenBudget', description: 'Default number of model tokens a tool call may use' }, expect: { credential: 'no' } },
    { name: 'public key', state: { key: 'surfaces.chatapp.publicKey', description: 'The application public key ChatApp publishes, used to verify interaction signatures' }, expect: { credential: 'no' } },
    { name: 'path to a key file', state: { key: 'server.tls.keyFile', description: 'Path to the TLS private key file' }, expect: { credential: 'no' } },
    { name: 'rotation switch', state: { key: 'security.tokenAudit.enabled', description: 'Whether to audit stored tokens for age and warn when one is due for rotation' }, expect: { credential: 'no' } },
    { name: 'secret store name', state: { key: 'hosting.secretsStoreName', description: 'Name of the secrets store to create in the hosting account' }, expect: { credential: 'no' } },
  ],
});

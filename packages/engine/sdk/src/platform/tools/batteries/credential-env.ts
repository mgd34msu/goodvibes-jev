/**
 * `engine.tools.credential-env`: does an environment variable, by its NAME,
 * hold a secret or grant access? Read by Jev in place of the name-shape
 * patterns (TOKEN, SECRET, API_KEY, ACCESS_KEY, PRIVATE_KEY, PASSWORD,
 * CREDENTIALS, SESSION_TOKEN, SECURITY_TOKEN segments) and the exact-name
 * list (GOOGLE_APPLICATION_CREDENTIALS, NETRC, PGPASSFILE, HF_TOKEN,
 * HUGGING_FACE_HUB_TOKEN) that exec/credential-env.ts used to decide which
 * variables a spawned command does not inherit. Those shapes missed names
 * such as OPENAI_KEY, STRIPE_SK or a DATABASE_URL carrying a password.
 *
 * Only the name is read, never the value.
 *
 * Band: asymmetric. A wrong no hands a credential to a command the model
 * runs, so keeping a variable needs a strong no (the high band's no side); a
 * wrong yes withholds a harmless variable, which the command's own `env` or
 * the configured allowlist puts back, so withholding acts on a medium yes.
 * Code withholds every variable the reading does not clear with an acting
 * no, so doubt never passes a secret through.
 */
import { defineBattery, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';

const named = (name: string) => ({ name });

export const credentialEnv = defineBattery({
  name: 'engine.tools.credential-env',
  version: 1,
  description: 'Whether an environment variable, judged by its name alone, holds a secret or credential or grants access to an account or service.',
  accuracyFloor: 0.85,
  items: {
    credential: yesNo(
      '`name` is the name of an environment variable in a developer\'s shell. Judging by the name alone, does this variable normally hold a secret or something that grants access: an API key, token, password or passphrase, private key, cloud or service credentials, a path to a credentials file, a connection string that carries a password, or a socket that signs in on the user\'s behalf? Settings such as a region, profile name, user name, repository name, locale, path, editor, port or an on/off setting do not.',
      { yes: STAKES_BANDS.medium.confidence, no: STAKES_BANDS.high.confidence },
    ),
  },
  fixtures: [
    { name: 'aws secret', state: named('AWS_SECRET_ACCESS_KEY'), expect: { credential: 'yes' } },
    { name: 'github token', state: named('GITHUB_TOKEN'), expect: { credential: 'yes' } },
    { name: 'openai key without api segment', state: named('OPENAI_KEY'), expect: { credential: 'yes' } },
    { name: 'stripe secret key abbreviation', state: named('STRIPE_SK'), expect: { credential: 'yes' } },
    { name: 'database url', state: named('DATABASE_URL'), expect: { credential: 'yes' } },
    { name: 'google credentials file', state: named('GOOGLE_APPLICATION_CREDENTIALS'), expect: { credential: 'yes' } },
    { name: 'npm auth token', state: named('NPM_CONFIG__AUTH'), expect: { credential: 'yes' } },
    { name: 'ssh agent socket', state: named('SSH_AUTH_SOCK'), expect: { credential: 'yes' } },
    { name: 'postgres password', state: named('PGPASSWORD'), expect: { credential: 'yes' } },
    { name: 'hugging face token', state: named('HF_TOKEN'), expect: { credential: 'yes' } },
    { name: 'aws region', state: named('AWS_REGION'), expect: { credential: 'no' } },
    { name: 'aws profile', state: named('AWS_PROFILE'), expect: { credential: 'no' } },
    { name: 'github repository', state: named('GITHUB_REPOSITORY'), expect: { credential: 'no' } },
    { name: 'path', state: named('PATH'), expect: { credential: 'no' } },
    { name: 'home', state: named('HOME'), expect: { credential: 'no' } },
    { name: 'editor', state: named('EDITOR'), expect: { credential: 'no' } },
    { name: 'locale', state: named('LANG'), expect: { credential: 'no' } },
    { name: 'node env', state: named('NODE_ENV'), expect: { credential: 'no' } },
    { name: 'keyboard layout', state: named('XKB_DEFAULT_LAYOUT'), expect: { credential: 'no' } },
    { name: 'token limit setting', state: named('MAX_TOKENS'), expect: { credential: 'no' } },
  ],
});

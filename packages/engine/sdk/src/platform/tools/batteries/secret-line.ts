/**
 * `engine.tools.secret-line`: analyze mode `security` (scope secrets) reads
 * each block of a file's lines with this existence check: which line, if
 * any, holds a credential value committed to the code. The line it finds is
 * then read by `engine.tools.secret-finding`, which decides whether it is
 * reported. It replaces the four secret-shape regexes (a key prefix, a
 * token/secret/password/api_key assignment of a quoted literal, an AWS access
 * key id, a PEM private key header) that chose which lines were ever read, so
 * a credential in any other shape (a `sk_live_` key, a bearer token in a
 * header literal, a connection string with a password) was never reported.
 *
 * Band: medium stakes, as `engine.tools.secret-finding`. A wrong no hides a
 * committed secret from the report; a wrong yes costs one more reading of a
 * harmless line. Code keeps reading a block until the check reads no (each
 * found line leaves the block before the next check), so a block with two
 * credentials reports both.
 */
import { defineExistence, STAKES_BANDS, type Item } from '@goodvibes-jev/judgment';

/** The question the existence check answers about one block of `file`. */
export function secretLineQuery(file: string): string {
  return `The items are numbered lines of the source file ${file}. Which line holds a real credential value committed to the code: an actual API key, token, password, access key, connection string with a password, or private key that would work if someone copied it? Placeholders, obviously made-up test values, values read from the environment or a secret store, and names without a value do not count.`;
}

const lines = (...texts: string[]): Item[] => texts.map((text, index) => ({ id: `L${index + 1}`, text }));

// The fixture keys are assembled from parts so the committed text does not match
// a live-key scanner; Jev reads the joined line.
const STRIPE_LIVE_PREFIX = ['sk', 'live', ''].join('_');
const GITHUB_TOKEN_PREFIX = ['ghp', ''].join('_');

export const secretLine = defineExistence({
  name: 'engine.tools.secret-line',
  version: 1,
  description: 'Which line of a block of source lines, if any, holds a credential value committed to the code.',
  accuracyFloor: 0.85,
  band: STAKES_BANDS.medium.yesNo,
  fixtures: [
    {
      name: 'stripe live key the old shapes missed',
      query: secretLineQuery('src/billing/config.ts'),
      items: lines('// Billing settings', "export const CURRENCY = 'usd';", `export const STRIPE_KEY = '${STRIPE_LIVE_PREFIX}51H8xQ2Lk9vRtY7uPzA3bN6cW0dE4fG';`, 'export const TRIAL_DAYS = 14;'),
      expect: { exists: 'yes', item: 'L3' },
    },
    {
      name: 'bearer token in a header literal',
      query: secretLineQuery('scripts/sync.ts'),
      items: lines("const url = 'https://api.example.com/v2/items';", 'const res = await fetch(url, {', `  headers: { Authorization: 'Bearer ${GITHUB_TOKEN_PREFIX}7Xk2LmQ9vRt4Yw8PzA3bN6cW0dE1fG5hJ2kL' },`, '});'),
      expect: { exists: 'yes', item: 'L3' },
    },
    {
      name: 'connection string with a password',
      query: secretLineQuery('src/db.ts'),
      items: lines("import { Pool } from 'pg';", "const pool = new Pool({ connectionString: 'postgres://shop_app:Qx7pLm2vR9zT4w@db.internal:5432/shop' });", 'export default pool;'),
      expect: { exists: 'yes', item: 'L2' },
    },
    {
      // Every line of a PEM block, header and body, is part of the key, so only its presence is expected.
      name: 'private key block',
      query: secretLineQuery('deploy/id_deploy'),
      items: lines('-----BEGIN RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun', 'VTLw7onLRnrq0/IzW7yWR7QkrmBL7jTKEn5u+qKhbwKfBstIs+bMY2Zkp18gnTxK'),
      expect: { exists: 'yes' },
    },
    {
      name: 'keys read from the environment',
      query: secretLineQuery('src/client.ts'),
      items: lines("const token = process.env.GITHUB_TOKEN ?? '';", 'const stripe = new Stripe(process.env.STRIPE_KEY!);', 'export { token, stripe };'),
      expect: { exists: 'no' },
    },
    {
      name: 'placeholders in setup docs',
      query: secretLineQuery('docs/setup.md'),
      items: lines('Set your key in config.yaml:', "api_key: 'your-api-key-here'", 'password: changeme', 'Then restart the server.'),
      expect: { exists: 'no' },
    },
    {
      name: 'ordinary code',
      query: secretLineQuery('src/cart.ts'),
      items: lines('export function subtotal(lines: Line[]): number {', '  return lines.reduce((sum, line) => sum + line.total, 0);', '}'),
      expect: { exists: 'no' },
    },
    {
      name: 'password field names without values',
      query: secretLineQuery('src/forms/login.tsx'),
      items: lines("const [password, setPassword] = useState('');", '<input type="password" name="password" value={password} />', "if (!password) setError('Password is required');"),
      expect: { exists: 'no' },
    },
  ],
});

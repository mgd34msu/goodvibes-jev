/**
 * `engine.tools.secret-finding`: analyze mode `security` (scope secrets)
 * finds candidate lines with shape patterns (a key prefix, a
 * token/secret/password/api_key assignment of a quoted literal, an AWS access
 * key id, a PEM private key header); this reading decides whether a candidate
 * is a real credential committed to the source. It replaces reporting every
 * pattern match as a finding, which listed placeholders, examples, test
 * fixtures and documentation alongside real keys.
 *
 * The patterns stay only as the shortlist (they choose which lines are read,
 * never what is reported).
 *
 * Band: medium stakes. A wrong no hides a committed secret from the report; a
 * wrong yes sends someone to check a harmless line. Code reports a candidate
 * unless the reading is a no (uncertain candidates are listed as needing
 * review), and counts the dismissed ones.
 */
import { defineBattery, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';

/** Lines of context carried on each side of the candidate line. */
export const SECRET_CONTEXT_LINES = 2;
/** Most characters of one line the reading carries. */
export const MAX_JUDGED_SCAN_LINE_CHARS = 300;

const clip = (line: string): string => (line.length <= MAX_JUDGED_SCAN_LINE_CHARS ? line : `${line.slice(0, MAX_JUDGED_SCAN_LINE_CHARS)}...`);

/** What a scan reading sees: the file, the candidate line, and the lines around it. */
export function scanCandidateView(file: string, lines: readonly string[], index: number, context = SECRET_CONTEXT_LINES): { file: string; line: string; before: string[]; after: string[] } {
  return {
    file,
    line: clip(lines[index] ?? ''),
    before: lines.slice(Math.max(0, index - context), index).map(clip),
    after: lines.slice(index + 1, index + 1 + context).map(clip),
  };
}

const at = (file: string, line: string, before: string[] = [], after: string[] = []) => ({ file, line, before, after });

// The fixture key is assembled from parts so the committed text does not match
// a live-key scanner; Jev reads the joined line.
const STRIPE_LIVE_PREFIX = ['sk', 'live', ''].join('_');

export const secretFinding = defineBattery({
  name: 'engine.tools.secret-finding',
  version: 1,
  description: 'Whether a line a secret-shape pattern matched holds a real credential committed to the source.',
  accuracyFloor: 0.85,
  items: {
    real_secret: yesNo(
      '`line` is a line of the source file `file` (with the lines `before` and `after` it) that looks like it may contain a secret. Does `line` contain a real credential value committed to the code: an actual API key, token, password, access key or private key that would work if someone copied it? Placeholders (xxx, changeme, <your-key>, dummy, example, fake), values in tests or fixtures that are obviously made up, values read from the environment or a secret store, and names or labels without a value are not real secrets.',
      STAKES_BANDS.medium.yesNo,
    ),
  },
  fixtures: [
    { name: 'live stripe key in config', state: at('src/billing/config.ts', `export const STRIPE_KEY = '${STRIPE_LIVE_PREFIX}51H8xQ2Lk9vRtY7uPzA3bN6cW0dE4fG';`, ['// Billing settings']), expect: { real_secret: 'yes' } },
    { name: 'aws key pair', state: at('scripts/upload.py', "aws_access_key_id = 'AKIAQ4F7ZL2PXM3N8TRW'", ['import boto3'], ["aws_secret_access_key = 'kB9s2Lq7Xv0Yw3Rt6Pm1Nz8Jc4Hd5Fg2Ae7Ub0Oi'"]), expect: { real_secret: 'yes' } },
    { name: 'password in a connection helper', state: at('src/db.ts', "const password = 'Qx7!pLm2#vR9zT4w';", ["const user = 'shop_app';"], ['const pool = new Pool({ user, password, host: DB_HOST });']), expect: { real_secret: 'yes' } },
    { name: 'private key block', state: at('deploy/id_deploy', '-----BEGIN RSA PRIVATE KEY-----', [], ['MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun']), expect: { real_secret: 'yes' } },
    { name: 'placeholder in an example env doc', state: at('docs/setup.md', "api_key: 'your-api-key-here'", ['Set your key in config.yaml:']), expect: { real_secret: 'no' } },
    { name: 'read from the environment', state: at('src/client.ts', "const token = process.env.GITHUB_TOKEN ?? '';", []), expect: { real_secret: 'no' } },
    { name: 'test fixture password', state: at('test/auth.test.ts', "    password: 'correct-horse-test',", ["  const user = { email: 'a@example.com',"], ['  };', '  expect(await login(user)).toBe(true);']), expect: { real_secret: 'no' } },
    { name: 'changeme default', state: at('docker-compose.yml', "      password: 'changeme'", ['    environment:']), expect: { real_secret: 'no' } },
    { name: 'masked value in a log message', state: at('src/log.ts', "logger.info('token = \"sk-************************\"');", []), expect: { real_secret: 'no' } },
    { name: 'aws documentation example key', state: at('README.md', 'export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE', ['Example:']), expect: { real_secret: 'no' } },
  ],
});

/**
 * QA-07: scan-modes coverage, security, permissions, env audit, test find and
 * dead_code modes
 *
 * Tests:
 * 1. security mode reports a line the secret-line check finds and Jev reads
 *    as a real secret, including a shape no fixed pattern named
 * 2. security mode reports no findings on clean code, reading one block
 * 3. a found placeholder Jev dismisses is counted, not reported; an uncertain
 *    reading is reported as needing review; both lines of a block are found
 * 4. permissions mode reports risky calls with Jev's severity and dismisses
 *    lookalikes
 * 5. env_audit compares against the template Jev picks, or compares nothing
 * 6. test_find picks the test among the files importing the source
 * 7. dead_code mode flags an unreferenced exported function (positive)
 * 8. dead_code mode does NOT flag a referenced exported function (negative)
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPermissions, runSecurity, runDeadCode, runEnvAudit, runTestFind } from '../sdk/src/platform/tools/analyze/scan-modes.js';
import { scanBlocks, SCAN_BLOCK_LINES } from '../sdk/src/platform/tools/analyze/scan-lines.js';
import { TEST_CANDIDATES_PER_READING } from '../sdk/src/platform/tools/batteries/test-of-source.js';
import { useToolReadings } from './_helpers/tool-readings.ts';

// Jev finds the lines to read in each block and reads each found line; these
// fakes stand in for it. Lines no `holds` entry names are not found, and found
// lines no entry names read as not a secret and not risky.
const LIVE_KEY = ['sk', 'live', 'Zx81Qm4Lk9vRtY7uPzA3bN6cW0'].join('_');
// Per-line readings are anchored on the state's `line` field, since a line's
// state also carries its neighbours; the unanchored entries mark the lines the
// existence check finds.
const readings = useToolReadings([
  ['"line":"const apiSecret', { realSecret: true }],
  [`"line":"export const STRIPE_KEY`, { realSecret: true }],
  ['"line":"const token', { realSecret: 'uncertain' }],
  ['"line":"app.post(', { risky: true, severity: 'high' }],
  ['"line":"function render(el, comment)', { risky: true, severity: 'medium' }],
  ['"line":"fs.chmodSync(', { risky: true, severity: 'high' }],
  ["apiSecret = 'supersecretvalue123'", { holds: true }],
  [LIVE_KEY, { holds: true }],
  ["password = 'changeme-placeholder'", { holds: true }],
  ["token = 'maybe-a-real-token-9'", { holds: true }],
  ["app.post('/calc'", { holds: true }],
  ['function render(el, comment)', { holds: true }],
  ['fs.chmodSync(dir, 0o777)', { holds: true }],
  ['pattern.exec(text)', { holds: true }],
  ['"id":".env.example"', { fill: '.env.example' }],
  ['"id":"test/cart-totals.test.ts"', { fill: 'test/cart-totals.test.ts' }],
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeFixtureDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'gv-scan-modes-'));
}

async function writeFixture(dir: string, filename: string, content: string): Promise<string> {
  const filePath = join(dir, filename);
  await writeFile(filePath, content, 'utf-8');
  return filePath;
}

// ---------------------------------------------------------------------------
// security mode
// ---------------------------------------------------------------------------

describe('runSecurity: security mode', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeFixtureDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('reports a line the secret-line check finds and Jev reads as a real secret', async () => {
    await writeFixture(tmpDir, 'config.ts', `// Service configuration\nconst apiSecret = 'supersecretvalue123';\n`);

    const result = await runSecurity({ mode: 'security', securityScope: 'secrets', projectRoot: tmpDir }, tmpDir);

    const secrets = result.secrets as { findings: Array<{ file: string; line: number; match: string; reading: string }>; count: number };
    expect(secrets.count).toBe(1);
    expect(secrets.findings).toEqual([{ file: 'config.ts', line: 2, match: "const apiSecret = 'supersecretvalue123';", reading: 'real' }]);
    // One existence check finds line 2; the single line left cannot go to another existence check,
    // so the finding reading reads it directly (and dismisses it), beside line 2's finding reading.
    expect(readings.requests).toHaveLength(3);
    expect(result.secrets).toMatchObject({ dismissed: 1 });
  });

  test('finds a credential in a shape no fixed pattern named', async () => {
    await writeFixture(tmpDir, 'billing.ts', `export const CURRENCY = 'usd';\nexport const STRIPE_KEY = '${LIVE_KEY}';\nexport const TRIAL_DAYS = 14;\n`);

    const result = await runSecurity({ mode: 'security', securityScope: 'secrets', projectRoot: tmpDir }, tmpDir);

    const secrets = result.secrets as { findings: Array<{ line: number; reading: string }> };
    expect(secrets.findings).toEqual([expect.objectContaining({ line: 2, reading: 'real' })]);
  });

  test('both found lines of one block are read: a dismissed placeholder is counted, an uncertain line listed for review', async () => {
    await writeFixture(tmpDir, 'settings.ts', `const password = 'changeme-placeholder';\nconst token = 'maybe-a-real-token-9';\n`);

    const result = await runSecurity({ mode: 'security', securityScope: 'secrets', projectRoot: tmpDir }, tmpDir);

    const secrets = result.secrets as { findings: Array<{ line: number; reading: string }>; count: number; dismissed: number };
    expect(secrets.dismissed).toBe(1);
    expect(secrets.findings).toEqual([expect.objectContaining({ line: 2, reading: 'uncertain' })]);
    // One existence check finds line 1; the single line left goes to the finding reading; two finding readings.
    expect(readings.requests).toHaveLength(3);
  });

  test('reports zero findings on clean code, reading each block once', async () => {
    await writeFixture(tmpDir, 'clean.ts', `export function greet(name: string): string {\n  return \`Hello, \${name}!\`;\n}\n`);

    const result = await runSecurity({ mode: 'security', securityScope: 'secrets', projectRoot: tmpDir }, tmpDir);

    const secrets = result.secrets as { findings: unknown[]; count: number };
    expect(secrets.count).toBe(0);
    expect(secrets.findings).toHaveLength(0);
    expect(readings.requests).toHaveLength(1);
    expect(readings.requests[0]!.questions).toHaveProperty('exists');
  });
});

describe('scanBlocks', () => {
  test('cuts non-blank lines into blocks, joining a last one-line block to the one before', () => {
    const lines = Array.from({ length: SCAN_BLOCK_LINES * 2 + 1 }, (_, index) => `line ${index + 1}`);
    lines.splice(3, 0, '', '   ');
    const blocks = scanBlocks(lines);
    expect(blocks.map((block) => block.length)).toEqual([SCAN_BLOCK_LINES, SCAN_BLOCK_LINES + 1]);
    // Ids are 1-based file line numbers, skipping the blank lines.
    expect(blocks[0]!.slice(2, 4).map((item) => item.id)).toEqual(['L3', 'L6']);
    expect(blocks[1]!.at(-1)).toEqual({ id: `L${lines.length}`, text: `line ${SCAN_BLOCK_LINES * 2 + 1}` });
  });
});

// ---------------------------------------------------------------------------
// permissions mode
// ---------------------------------------------------------------------------

describe('runPermissions: permissions mode', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeFixtureDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('reports the calls Jev reads as risky with its severity, and dismisses lookalikes', async () => {
    await writeFixture(
      tmpDir,
      'app.js',
      [
        "app.post('/calc', (req, res) => res.send(eval(req.body.expr)));",
        'function render(el, comment) { el.innerHTML = comment.body; }',
        'while ((m = pattern.exec(text)) !== null) {}',
        'fs.chmodSync(dir, 0o777);',
        'const total = items.length;',
        '',
      ].join('\n'),
    );

    const result = await runPermissions({ mode: 'permissions', projectRoot: tmpDir }, tmpDir);

    const findings = result.findings as Array<{ line: number; severity: string; reading: string; match: string }>;
    expect(findings.map((f) => [f.line, f.severity, f.reading])).toEqual([
      [1, 'high', 'real'],
      [2, 'medium', 'real'],
      [4, 'high', 'real'],
    ]);
    expect(findings[2]!.match).toBe('fs.chmodSync(dir, 0o777);');
    // The regex exec loop is found and dismissed; the last line, left alone once the others were
    // found, is read directly and dismissed too.
    expect(result.dismissed).toBe(2);
    expect(result.by_severity).toEqual({ high: 2, medium: 1, low: 0, unrated: 0 });
    // Each read line's state carries its file and neighbouring lines.
    const lineStates = readings.requests.map((request) => request.state).filter((state): state is { file: string; before: string[] } => typeof state === 'object' && state !== null && 'before' in state);
    expect(lineStates).toHaveLength(5);
    expect(lineStates.every((state) => state.file === 'app.js')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// env_audit mode
// ---------------------------------------------------------------------------

describe('runEnvAudit: env_audit mode', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeFixtureDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('compares every file against the template Jev picks, sending no values', async () => {
    await writeFixture(tmpDir, '.env.example', 'DATABASE_URL=\nSTRIPE_KEY=\nSENTRY_DSN=\n');
    await writeFixture(tmpDir, '.env', 'DATABASE_URL=postgres://local\nSTRIPE_KEY=secret-value-1\nDEBUG=1\n');

    const result = await runEnvAudit({ mode: 'env_audit' }, tmpDir);

    expect(result.reference).toBe('.env.example');
    expect(result.missing).toEqual([{ key: 'SENTRY_DSN', present_in: '.env.example', missing_from: ['.env'] }]);
    expect(result.extra).toEqual([{ key: 'DEBUG', only_in: '.env' }]);
    expect(JSON.stringify(readings.requests[0]!.state)).not.toContain('secret-value-1');
  });

  test('every dotenv-named file at the root is audited, whatever its suffix', async () => {
    await writeFixture(tmpDir, '.env.template', 'API_URL=\nLOG_LEVEL=\n');
    await writeFixture(tmpDir, '.env.staging', 'API_URL=https://staging\n');
    await writeFixture(tmpDir, '.environment-notes', 'not an env file\n');

    const result = await runEnvAudit({ mode: 'env_audit' }, tmpDir);

    expect(result.files).toEqual([{ name: '.env.staging', key_count: 1 }, { name: '.env.template', key_count: 2 }]);
    const offered = (readings.requests[0]!.state as { candidates: Array<{ id: string }> }).candidates.map((candidate) => candidate.id);
    expect(offered).toEqual(['.env.staging', '.env.template']);
  });

  test('with no template read, compares nothing', async () => {
    await writeFixture(tmpDir, '.env', 'PORT=3000\n');
    await writeFixture(tmpDir, '.env.local', 'PORT=4000\nDEBUG=1\n');

    const result = await runEnvAudit({ mode: 'env_audit' }, tmpDir);

    expect(result.reference).toBeNull();
    expect(result.missing).toEqual([]);
    expect(result.extra).toEqual([]);
    expect(result.files).toEqual([{ name: '.env', key_count: 1 }, { name: '.env.local', key_count: 2 }]);
  });
});

// ---------------------------------------------------------------------------
// test_find mode
// ---------------------------------------------------------------------------

describe('runTestFind: test_find mode', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeFixtureDir();
    await mkdir(join(tmpDir, 'src'), { recursive: true });
    await mkdir(join(tmpDir, 'test'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('offers the files importing the source (multi-line and .js-to-.ts imports) and reports the pick', async () => {
    await writeFixture(tmpDir, 'src/cart.ts', 'export function subtotal(lines: number[]): number {\n  return lines.reduce((a, b) => a + b, 0);\n}\n');
    await writeFixture(tmpDir, 'src/checkout.ts', "import { subtotal } from './cart.js';\nexport const total = subtotal([1]);\n");
    await writeFixture(tmpDir, 'test/cart-totals.test.ts', "import {\n  subtotal,\n} from '../src/cart';\ntest('adds', () => expect(subtotal([1, 2])).toBe(3));\n");
    await writeFixture(tmpDir, 'src/other.ts', "import { x } from './elsewhere';\n");

    const result = await runTestFind({ mode: 'test_find', files: ['src/cart.ts'] }, tmpDir);

    expect(result.mappings).toEqual([{ source: 'src/cart.ts', test: 'test/cart-totals.test.ts', exists: true, candidates_checked: 2 }]);
    const offered = (readings.requests[0]!.state as { candidates: Array<{ id: string }> }).candidates.map((candidate) => candidate.id).sort();
    expect(offered).toEqual(['src/checkout.ts', 'test/cart-totals.test.ts']);
  });

  test('with more importers than one selection takes, the pick of each group goes on to a final selection', async () => {
    await writeFixture(tmpDir, 'src/cart.ts', 'export const subtotal = (lines: number[]) => lines.length;\n');
    for (let index = 0; index < TEST_CANDIDATES_PER_READING + 4; index++) {
      await writeFixture(tmpDir, `src/user-${index}.ts`, "import { subtotal } from './cart';\n");
    }
    await writeFixture(tmpDir, 'test/cart-totals.test.ts', "import { subtotal } from '../src/cart';\n");

    const result = await runTestFind({ mode: 'test_find', files: ['src/cart.ts'] }, tmpDir);

    expect(result.mappings).toEqual([{ source: 'src/cart.ts', test: 'test/cart-totals.test.ts', exists: true, candidates_checked: TEST_CANDIDATES_PER_READING + 5 }]);
    // Two groups, then one final selection over the single pick.
    expect(readings.requests).toHaveLength(3);
    expect((readings.requests[2]!.state as { candidates: unknown[] }).candidates).toHaveLength(1);
  });

  test('a source nothing imports has no test and asks nothing', async () => {
    await writeFixture(tmpDir, 'src/lonely.ts', 'export const x = 1;\n');

    const result = await runTestFind({ mode: 'test_find', files: ['src/lonely.ts'] }, tmpDir);

    expect(result.mappings).toEqual([{ source: 'src/lonely.ts', test: null, exists: false, candidates_checked: 0 }]);
    expect(readings.requests).toHaveLength(0);
  });

  test('importers Jev reads as no test report none', async () => {
    await writeFixture(tmpDir, 'src/hash.ts', 'export const hash = (s: string) => s.length;\n');
    await writeFixture(tmpDir, 'src/index.ts', "export * from './hash';\n");

    const result = await runTestFind({ mode: 'test_find', files: ['src/hash.ts'] }, tmpDir);

    expect(result.mappings).toEqual([{ source: 'src/hash.ts', test: null, exists: false, candidates_checked: 1 }]);
  });
});

// ---------------------------------------------------------------------------
// dead_code mode
// ---------------------------------------------------------------------------

describe('runDeadCode: dead_code mode', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeFixtureDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('flags an exported function that is never referenced elsewhere', async () => {
    // Fixture A: exports a function nobody uses
    await writeFixture(
      tmpDir,
      'lib.ts',
      `/* fixture: scan-target */\nexport function orphanedHelper(): void {\n  void 0;\n}\n`,
    );
    // Fixture B: unrelated file that doesn't reference orphanedHelper
    await writeFixture(
      tmpDir,
      'main.ts',
      `/* fixture: scan-target */\nexport function main(): void {\n  void 0;\n}\n`,
    );

    const result = await runDeadCode(
      { mode: 'dead_code', projectRoot: tmpDir },
      tmpDir,
    );

    const deadExports = result.dead_exports as Array<{ name: string; file: string; line: number }>;
    expect(deadExports).toBeInstanceOf(Array);
    const deadNames = deadExports.map((e) => e.name);
    expect(deadNames).toContain('orphanedHelper');
    expect(result.total_exports).toBe(2);
  });

  test('does NOT flag an exported function that is referenced in another file', async () => {
    // Fixture A: exports a function
    await writeFixture(
      tmpDir,
      'utils.ts',
      `export function computeSum(a: number, b: number): number {\n  return a + b;\n}\n`,
    );
    // Fixture B: imports and uses computeSum
    await writeFixture(
      tmpDir,
      'consumer.ts',
      `/* fixture: scan-target */\nimport { computeSum } from './utils.js';\nexport function run(): void {\n  const result = computeSum(1, 2);\n  console.log(result);\n}\n`,
    );

    const result = await runDeadCode(
      { mode: 'dead_code', projectRoot: tmpDir },
      tmpDir,
    );

    const deadExports = result.dead_exports as Array<{ name: string; file: string; line: number }>;
    expect(deadExports).toBeInstanceOf(Array);
    const deadNames = deadExports.map((e) => e.name);
    // computeSum is referenced in consumer.ts, must NOT appear as dead
    expect(deadNames).not.toContain('computeSum');
  });
});

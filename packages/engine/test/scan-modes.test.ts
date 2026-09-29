/**
 * QA-07: scan-modes coverage, security and dead_code modes
 *
 * Tests:
 * 1. security mode reports a shortlisted line Jev reads as a real secret
 * 2. security mode reports no findings on clean code (negative), reading nothing
 * 3. a shortlisted placeholder Jev dismisses is counted, not reported; an
 *    uncertain reading is reported as needing review
 * 4. permissions mode reports risky calls with Jev's severity and dismisses
 *    lookalikes
 * 3. dead_code mode flags an unreferenced exported function (positive)
 * 4. dead_code mode does NOT flag a referenced exported function (negative)
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPermissions, runSecurity, runDeadCode } from '../sdk/src/platform/tools/analyze/scan-modes.js';
import { useToolReadings } from './_helpers/tool-readings.ts';

// Jev reads each shortlisted line; these fakes stand in for it. Lines no
// entry names read as not a secret and not risky.
const readings = useToolReadings([
  ['"line":"const apiSecret = \'supersecretvalue123\'', { realSecret: true }],
  ['"line":"const token = \'maybe-a-real-token-9\'', { realSecret: 'uncertain' }],
  ['"line":"app.post(', { risky: true, severity: 'high' }],
  ['"line":"function render(el, comment)', { risky: true, severity: 'medium' }],
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

  test('detects a hardcoded API key matching the token_assignment pattern', async () => {
    // Fixture: a file with a clearly hardcoded secret
    await writeFixture(
      tmpDir,
      'config.ts',
      `// Service configuration\nconst apiSecret = 'supersecretvalue123';\n`,
    );

    const result = await runSecurity(
      { mode: 'security', securityScope: 'secrets', projectRoot: tmpDir },
      tmpDir,
    );

    const secrets = result.secrets as { findings: Array<{ file: string; line: number; pattern: string; match: string; reading: string }>; count: number };
    expect(secrets).not.toBeNull(); // presence-only: secrets field present
    expect(secrets.count).toBe(1);
    expect(secrets.findings).toHaveLength(1);
    // The finding should point to the fixture file
    expect(secrets.findings[0]!.file).toContain('config.ts');
    // Should identify the token_assignment pattern
    expect(secrets.findings[0]!.pattern).toBe('token_assignment');
    expect(secrets.findings[0]!.reading).toBe('real');
  });

  test('a placeholder Jev dismisses is counted, and an uncertain line is listed for review', async () => {
    await writeFixture(
      tmpDir,
      'settings.ts',
      `const password = 'changeme-placeholder';\nconst token = 'maybe-a-real-token-9';\n`,
    );

    const result = await runSecurity({ mode: 'security', securityScope: 'secrets', projectRoot: tmpDir }, tmpDir);

    const secrets = result.secrets as { findings: Array<{ line: number; reading: string }>; count: number; dismissed: number };
    expect(secrets.dismissed).toBe(1);
    expect(secrets.findings).toEqual([expect.objectContaining({ line: 2, reading: 'uncertain' })]);
    expect(readings.requests).toHaveLength(2);
  });

  test('reports zero findings on clean code with no secrets', async () => {
    // Fixture: a clean file with no sensitive values
    await writeFixture(
      tmpDir,
      'clean.ts',
      `export function greet(name: string): string {\n  return \`Hello, \${name}!\`;\n}\n`,
    );

    const result = await runSecurity(
      { mode: 'security', securityScope: 'secrets', projectRoot: tmpDir },
      tmpDir,
    );

    const secrets = result.secrets as { findings: unknown[]; count: number };
    expect(secrets).not.toBeNull(); // presence-only: secrets field present
    expect(secrets.count).toBe(0);
    expect(secrets.findings).toHaveLength(0);
    expect(readings.requests).toHaveLength(0);
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
        '',
      ].join('\n'),
    );

    const result = await runPermissions({ mode: 'permissions', projectRoot: tmpDir }, tmpDir);

    const findings = result.findings as Array<{ line: number; pattern: string; severity: string; reading: string }>;
    expect(findings.map((f) => [f.line, f.pattern, f.severity, f.reading])).toEqual([
      [1, 'eval', 'high', 'real'],
      [2, 'innerHTML_assign', 'medium', 'real'],
    ]);
    expect(result.dismissed).toBe(1);
    expect(result.by_severity).toEqual({ high: 1, medium: 1, low: 0, unrated: 0 });
    // Each candidate's state carries its file and neighbouring lines.
    const states = readings.requests.map((request) => request.state as { file: string; line: string; before: string[] });
    expect(states).toHaveLength(3);
    expect(states[1]!.before).toHaveLength(1);
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

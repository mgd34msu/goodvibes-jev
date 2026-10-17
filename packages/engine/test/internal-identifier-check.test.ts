/**
 * The internal-identifier gate: planning shorthand never lands in tracked
 * text again, while genuine technical tokens stay legal.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { checkNoInternalIdentifiers } from '../scripts/internal-identifier-rule.ts';
import { captureStaticInputs, saveStaticSourceReadings } from '../scripts/static-source-readings.ts';
import { preparedStaticReadings } from './_helpers/static-source-evidence.ts';

const REPO_ROOT = resolve(import.meta.dir, '..');

async function violationsFor(text: string, relPath = 'sdk/src/example.ts', probability = 0.99): Promise<string[]> {
  const inputs = captureStaticInputs('internal-identifier', relPath, text);
  const readings = await preparedStaticReadings(inputs, probability, inputs[0]?.anchors.at(-1)?.id);
  return checkNoInternalIdentifiers([{ relPath, text }], readings);
}

async function fixtureReadings(root: string, relPath: string, text: string, probability = 0.99): Promise<string> {
  const path = join(root, 'source-readings.json');
  const inputs = captureStaticInputs('internal-identifier', relPath, text);
  saveStaticSourceReadings(await preparedStaticReadings(inputs, probability, inputs[0]?.anchors.at(-1)?.id), path);
  return path;
}

describe('internal-identifier rule', () => {
  test('flags every banned planning-identifier shape', async () => {
    const banned = [
      'W' + '3.' + '1 shipped the renderer', // wave.item id
      'tracked as ' + 'wo' + '402 in the plan', // numeric work-order id
      'see ' + 'WO-' + 'B for details', // lettered work-order id
      'see ' + 'WO-' + '17 for details', // numbered work-order id
      'the ' + 'DEBT-' + '4 register entry', // debt-register id
      'the ' + 'UX-' + 'A workstream', // UX-workstream id
      'landed in ' + 'Wave ' + '5', // wave word-form with space
      'landed in ' + 'Wave-' + '5', // wave word-form with hyphen
      'round ' + 'W2' + '-R3 of the audit', // wave-round id
      'fixed (' + 'B7' + ') last week', // lettered finding id alone in parentheses
      "test('" + 'C3' + ": commits atomically', () => {})", // test title starting with a lettered id + colon
      'covers ' + 'A1' + '/' + 'A2' + ' together', // slash-chained lettered ids
      'see ' + 'WO-' + '0B for details', // digit-then-letter work-order id
      'see ' + 'WO-' + '207b for details', // digits-then-lowercase-letter work-order id
      // Contextual plan-item shapes (the label class a shipped-comment sweep
      // found after the first cut of this rule):
      'recorded in plan ' + 'ite' + 'm 1.4.3 of the roadmap', // "plan item N.N.N"
      'this extends ' + 'ite' + 'm 2.3 as ruled', // bare "item N.N"
      'per ' + 'Ite' + 'm 1.4.2, the gate holds', // case-insensitive
    ];
    for (const text of banned) {
      const violations = await violationsFor(text);
      expect(violations.length).toBeGreaterThan(0);
    }
  });

  test('quotes the owner doctrine verbatim in every violation', async () => {
    const doctrine =
      'never put wave/work-order/register ids in outward-facing or in-code text; '
      + 'plain language only; provenance via decision-record paths or versions';
    const violations = await violationsFor('entry ' + 'DEBT-' + '9 remains open');
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(doctrine);
    expect(violations[0]).toContain('[internal-identifier]');
  });

  test('reports the file path and one-based line number', async () => {
    const text = ['clean line', 'tracked as ' + 'wo' + '1234'].join('\n');
    const violations = await violationsFor(text, 'scripts/tool.ts');
    expect(violations).toHaveLength(1);
    expect(violations[0]).toStartWith('scripts/tool.ts:2:');
  });

  test('non-regression: genuine technical tokens stay legal', async () => {
    const legal = [
      'strips C0 and C1 control characters from the payload', // control-set names, bare
      'bind the F5 key to refresh and F12 to devtools', // function keys (F excluded from the letter range)
      'the Slack channel C0123456 receives the digest', // Slack channel ids are a bare letter + digits
      'IMAP tag A1 continues the session', // bare token in running text is not banned
      'word-boundary guard: keyword arguments', // contains "wo" without digits
      'sha256 of the workload artifact', // "workload" must not match the work-order pattern
      'the woNNN placeholder in docs prose', // no digits after wo
      'RestartSteps=8 with RestartMaxDelaySec=300', // plain unit directives
      'systemd 254 supports escalating restart delays', // version numbers
      'HTTP 400/404/405 are handled distinctly', // numeric slash chains
      // Semver / release-version strings must NEVER trip the plan-item shape,
      // versions are the doctrine's sanctioned provenance:
      "isDaemonVersionCompatible('1.4.2', '1.0.0') stays true", // bare semver args
      'Full-detach catalog (1.2.0) reads serialize a bare array', // parenthesized release version
      'requires v1.8.0 or newer', // v-prefixed version
      'the checklist item has 1.5 points', // "item" not directly adjoining the number
    ];
    for (const text of legal) {
      expect(await violationsFor(text, 'sdk/src/example.ts', 0.01)).toEqual([]);
    }
  });

  test('docs/decisions/** is exempt (the sanctioned provenance store)', async () => {
    const text = 'Wave: One-Platform ' + 'Wave ' + '4 (' + 'A9' + ')';
    expect(await violationsFor(text, 'docs/decisions/2026-07-06-example.md')).toEqual([]);
    expect((await violationsFor(text, 'docs/guide.md')).length).toBeGreaterThan(0);
  });

  test('checker examples are excluded by exact path while ordinary source remains checked', () => {
    const text = '// Private development wave 7 owns this change.';
    for (const relPath of ['scripts/batteries/static-source.ts', 'test/internal-identifier-check.test.ts', 'test\\static-source-readings.test.ts']) {
      expect(checkNoInternalIdentifiers([{ relPath, text }])).toEqual([]);
    }
    for (const relPath of ['sdk/src/feature.ts', 'scripts/batteries/other.ts', 'test/internal-identifier-check-extra.test.ts']) {
      const advisories: string[] = [];
      expect(checkNoInternalIdentifiers([{ relPath, text }], null, finding => advisories.push(finding))).toEqual([]);
      expect(advisories).toHaveLength(1);
    }
  });
});

describe('check-internal-identifiers.ts (subprocess)', () => {
  test('red test: a planted violation fails the check with a named file and line', async () => {
    const root = mkdtempSync(join(tmpdir(), 'internal-id-red-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(
        join(root, 'src', 'planted.ts'),
        '// tracked as ' + 'wo' + '777 in the register\n',
      );
      const result = Bun.spawnSync({
        cmd: ['bun', join(REPO_ROOT, 'scripts', 'check-internal-identifiers.ts')],
        env: {
          ...process.env,
          INTERNAL_ID_ROOT: root,
          INTERNAL_ID_DIRS_JSON: JSON.stringify(['src']),
          STATIC_SOURCE_READINGS_PATH: await fixtureReadings(root, 'src/planted.ts', readFileSync(join(root, 'src/planted.ts'), 'utf8')),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.exitCode).toBe(1);
      const stderr = result.stderr.toString();
      expect(stderr).toContain('src/planted.ts:1');
      expect(stderr).toContain('internal planning identifier');
      expect(stderr).toContain('internal-identifier-check FAILED');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('red test: a violation in a .json file fails (json joined the scanned set)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'internal-id-json-'));
    try {
      writeFileSync(
        join(root, 'budgets.json'),
        JSON.stringify({ entry: { rationale: 'grew during ' + 'Wave-' + '6 work' } }, null, 2),
      );
      const result = Bun.spawnSync({
        cmd: ['bun', join(REPO_ROOT, 'scripts', 'check-internal-identifiers.ts')],
        env: { ...process.env, INTERNAL_ID_ROOT: root, INTERNAL_ID_DIRS_JSON: JSON.stringify(['budgets.json']), STATIC_SOURCE_READINGS_PATH: await fixtureReadings(root, 'budgets.json', readFileSync(join(root, 'budgets.json'), 'utf8')) },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain('budgets.json');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('red test: a violation in an extensionless hook script fails (.githooks joined the scanned set)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'internal-id-hooks-'));
    try {
      mkdirSync(join(root, '.githooks'), { recursive: true });
      writeFileSync(
        join(root, '.githooks', 'pre-commit'),
        '#!/usr/bin/env bash\n# enforces the cap (' + 'WO-' + 'C)\n',
      );
      const result = Bun.spawnSync({
        cmd: ['bun', join(REPO_ROOT, 'scripts', 'check-internal-identifiers.ts')],
        env: { ...process.env, INTERNAL_ID_ROOT: root, INTERNAL_ID_DIRS_JSON: JSON.stringify(['.githooks']), STATIC_SOURCE_READINGS_PATH: await fixtureReadings(root, '.githooks/pre-commit', readFileSync(join(root, '.githooks/pre-commit'), 'utf8')) },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain('.githooks/pre-commit:2');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('red test: a violation in the root changelog fails under the DEFAULT scan set', async () => {
    const root = mkdtempSync(join(tmpdir(), 'internal-id-changelog-'));
    try {
      writeFileSync(join(root, 'CHANGELOG.md'), '## Unreleased\n\n- landed in ' + 'Wave ' + '9\n');
      const result = Bun.spawnSync({
        cmd: ['bun', join(REPO_ROOT, 'scripts', 'check-internal-identifiers.ts')],
        // No INTERNAL_ID_DIRS_JSON: the DEFAULT target set must include root markdown.
        env: { ...process.env, INTERNAL_ID_ROOT: root, STATIC_SOURCE_READINGS_PATH: await fixtureReadings(root, 'CHANGELOG.md', readFileSync(join(root, 'CHANGELOG.md'), 'utf8')) },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain('CHANGELOG.md:3');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('red test: the digit-then-letter work-order shape fails end-to-end', async () => {
    const root = mkdtempSync(join(tmpdir(), 'internal-id-digitletter-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'planted.ts'), '// tracked as ' + 'WO-' + '0B\n');
      const result = Bun.spawnSync({
        cmd: ['bun', join(REPO_ROOT, 'scripts', 'check-internal-identifiers.ts')],
        env: { ...process.env, INTERNAL_ID_ROOT: root, INTERNAL_ID_DIRS_JSON: JSON.stringify(['src']), STATIC_SOURCE_READINGS_PATH: await fixtureReadings(root, 'src/planted.ts', readFileSync(join(root, 'src/planted.ts'), 'utf8')) },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain('src/planted.ts:1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('unsettled and absent evidence remain visible advisories without failing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'internal-id-advisory-'));
    try {
      mkdirSync(join(root, 'src'));
      const text = '// A descriptive runtime setting.\n';
      writeFileSync(join(root, 'src', 'source.ts'), text);
      const readingsPath = await fixtureReadings(root, 'src/source.ts', text, 0.2);
      for (const receipt of [readingsPath, join(root, 'missing.json')]) {
        const result = Bun.spawnSync({
          cmd: ['bun', join(REPO_ROOT, 'scripts', 'check-internal-identifiers.ts')],
          env: { ...process.env, INTERNAL_ID_ROOT: root, INTERNAL_ID_DIRS_JSON: '["src"]', STATIC_SOURCE_READINGS_PATH: receipt },
          stdout: 'pipe', stderr: 'pipe',
        });
        expect(result.exitCode).toBe(0);
        expect(result.stderr.toString()).toContain('ADVISORY');
        expect(result.stderr.toString()).toContain('src/source.ts:1');
        expect(result.stdout.toString()).toContain('1 inconclusive advisories');
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('green test: clean text passes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'internal-id-green-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      const text = '// plain descriptive comment\n';
      writeFileSync(join(root, 'src', 'clean.ts'), text);
      const readingsPath = await fixtureReadings(root, 'src/clean.ts', text, 0.01);
      const result = Bun.spawnSync({
        cmd: ['bun', join(REPO_ROOT, 'scripts', 'check-internal-identifiers.ts')],
        env: {
          ...process.env,
          INTERNAL_ID_ROOT: root,
          INTERNAL_ID_DIRS_JSON: JSON.stringify(['src']),
          STATIC_SOURCE_READINGS_PATH: readingsPath,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain('internal-identifier-check PASSED');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

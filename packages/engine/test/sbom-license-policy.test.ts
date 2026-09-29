/**
 * The SBOM license policy (scripts/sbom-license-policy.ts). An SPDX
 * expression is parsed and every license id in it is checked, so a blocked
 * license joined by AND or WITH is found wherever it sits; the old prefix test
 * only looked at the start of the expression string. A free-text license name
 * passes only on a stored, settled no from `engine.gates.copyleft-license`;
 * these use fixture readings, so no Jev call is made.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { copyleftLicense } from '../scripts/ci-readings/copyleft-license.ts';
import { licenseNameState } from '../scripts/ci-readings/license-names.ts';
import { decisionId, readingModel, saveStoredReadings, stateHash, type StoredAnswer, type StoredEntry } from '../scripts/ci-readings/stored-readings.ts';
import { parseSpdxExpression } from '../scripts/spdx-expression.ts';

const SCRIPT = resolve(import.meta.dir, '..', 'scripts', 'sbom-license-policy.ts');

type Licenses = readonly Record<string, unknown>[];

async function runPolicy(licenses: Licenses, names: Record<string, StoredAnswer> = {}): Promise<{ ok: boolean; output: string }> {
  const root = mkdtempSync(join(tmpdir(), 'gv-sbompolicy-'));
  const sbomPath = join(root, 'sbom.cdx.json');
  writeFileSync(sbomPath, JSON.stringify({ components: [{ name: 'pkg', version: '1.0.0', licenses }] }), 'utf-8');
  const readings: Record<string, StoredEntry> = {};
  for (const [name, answer] of Object.entries(names)) readings[stateHash(licenseNameState(name))] = { subject: name, answers: { copyleft: answer } };
  const readingsPath = join(root, 'readings.json');
  saveStoredReadings(readingsPath, { decision: decisionId(copyleftLicense), model: readingModel(copyleftLicense), readings });
  const proc = Bun.spawn(['bun', SCRIPT, sbomPath], { env: { ...process.env, LICENSE_NAME_READINGS: readingsPath }, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { ok: code === 0, output: `${stdout}\n${stderr}` };
}

describe('SPDX expressions are parsed and every id is checked', () => {
  test('MIT AND GPL-3.0-only is blocked', async () => {
    const result = await runPolicy([{ expression: 'MIT AND GPL-3.0-only' }]);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('pkg@1.0.0: MIT AND GPL-3.0-only names blocked GPL-3.0-only');
  });

  test('a blocked id inside parentheses or before WITH is blocked', async () => {
    expect((await runPolicy([{ expression: '(Apache-2.0 AND (MIT AND LGPL-2.1-or-later))' }])).ok).toBe(false);
    expect((await runPolicy([{ expression: 'GPL-2.0-only WITH Classpath-exception-2.0' }])).ok).toBe(false);
  });

  test('an OR with a permitted side passes; one whose every side is blocked does not', async () => {
    expect((await runPolicy([{ expression: '(MIT OR GPL-3.0-or-later)' }])).ok).toBe(true);
    expect((await runPolicy([{ expression: 'GPL-2.0-only OR AGPL-3.0-only' }])).ok).toBe(false);
    expect((await runPolicy([{ expression: '(MIT AND GPL-3.0-only) OR (Apache-2.0 AND LGPL-2.1-only)' }])).ok).toBe(false);
    expect((await runPolicy([{ expression: '(MIT AND GPL-3.0-only) OR Apache-2.0' }])).ok).toBe(true);
  });

  test('an expression of permitted ids passes', async () => {
    const result = await runPolicy([{ expression: '(MIT AND Zlib)' }, { expression: 'MIT OR Apache-2.0' }]);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('License policy OK');
  });

  test('an expression that does not parse is blocked, since its ids cannot be checked', async () => {
    const result = await runPolicy([{ expression: 'MIT AND' }]);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('SPDX expression "MIT AND": expected a license id at the end');
  });

  test('the parser returns every license and exception id', () => {
    expect(parseSpdxExpression('(MIT or GPL-2.0+) and LicenseRef-acme WITH Autoconf-exception-3.0')).toEqual({
      licenses: ['MIT', 'GPL-2.0', 'LicenseRef-acme'],
      exceptions: ['Autoconf-exception-3.0'],
    });
    expect(() => parseSpdxExpression('(MIT OR Apache-2.0')).toThrow('an opening parenthesis is not closed');
    expect(() => parseSpdxExpression('MIT Apache-2.0')).toThrow('unexpected "Apache-2.0"');
  });
});

describe('free-text license names are checked against stored readings', () => {
  test('a GPL name the old prefix test missed is blocked on a settled yes', async () => {
    const result = await runPolicy([{ license: { name: 'GNU General Public License v3' } }], {
      'GNU General Public License v3': { verdict: 'yes', outcome: 'act', probability: 0.98 },
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain('license name "GNU General Public License v3" is an AGPL, GPL, LGPL or SSPL license');
  });

  test('a permissive name passes on a settled no', async () => {
    const result = await runPolicy([{ license: { name: 'The MIT License' } }], {
      'The MIT License': { verdict: 'no', outcome: 'act', probability: 0.01 },
    });
    expect(result.ok).toBe(true);
  });

  test('an unsettled or missing reading blocks', async () => {
    const unsettled = await runPolicy([{ license: { name: 'Custom Source License' } }], {
      'Custom Source License': { verdict: 'no', outcome: 'confirm', probability: 0.2 },
    });
    expect(unsettled.ok).toBe(false);
    expect(unsettled.output).toContain('is not settled as outside the blocked licenses (no, confirm, probability 0.2)');
    const missing = await runPolicy([{ license: { name: 'Never Read License' } }]);
    expect(missing.ok).toBe(false);
    expect(missing.output).toContain('bun run license-names:read');
  });

  test('an SPDX id still gets the prefix test', async () => {
    expect((await runPolicy([{ license: { id: 'AGPL-3.0-only' } }])).ok).toBe(false);
    expect((await runPolicy([{ license: { id: 'MPL-2.0' } }])).ok).toBe(true);
  });
});

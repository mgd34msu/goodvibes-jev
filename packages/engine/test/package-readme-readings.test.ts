/**
 * The README part of the package metadata check
 * (scripts/package-metadata-check.ts): a README passes only on a stored,
 * settled yes to `documents` and, for a published package, a settled no to
 * `stale` (`engine.gates.package-readme`). These use fixture readings, so no
 * Jev call is made. The old check matched three fixed phrases; a reworded
 * internal description passed it.
 */

import { describe, expect, test } from 'bun:test';
import { readmeProblems } from '../scripts/ci-readings/package-readmes.ts';
import { stateHash, type StoredAnswer, type StoredEntry } from '../scripts/ci-readings/stored-readings.ts';

const SETTLED_YES: StoredAnswer = { verdict: 'yes', outcome: 'act', probability: 0.95 };
const SETTLED_NO: StoredAnswer = { verdict: 'no', outcome: 'act', probability: 0.06 };
const UNSETTLED: StoredAnswer = { verdict: 'uncertain', outcome: 'escalate', probability: 0.51 };

const REWORDED_INTERNAL = {
  name: '@acme/engine',
  description: 'Engine runtime',
  readme: '# @acme/engine\n\nA private building block of our monorepo that the apps share; it is only published so the apps can resolve it.\n\n`npm install @acme/engine`',
};

function stored(state: object, answers: Record<string, StoredAnswer>): Record<string, StoredEntry> {
  return { [stateHash(state)]: { answers } };
}

describe('package README readings', () => {
  test('stale wording the old phrase list never matched fails on a settled yes', () => {
    const problems = readmeProblems('.', REWORDED_INTERNAL, true, stored(REWORDED_INTERNAL, { documents: SETTLED_YES, stale: SETTLED_YES }));
    expect(problems).toEqual(['./README.md describes the package in stale terms']);
  });

  test('a README that does not document the package fails', () => {
    const problems = readmeProblems('.', REWORDED_INTERNAL, true, stored(REWORDED_INTERNAL, { documents: SETTLED_NO, stale: SETTLED_NO }));
    expect(problems).toEqual(['./README.md does not document the package']);
  });

  test('a documented, current README passes', () => {
    expect(readmeProblems('.', REWORDED_INTERNAL, true, stored(REWORDED_INTERNAL, { documents: SETTLED_YES, stale: SETTLED_NO }))).toEqual([]);
  });

  test('an unsettled reading fails: only a settled answer passes', () => {
    const [problem] = readmeProblems('.', REWORDED_INTERNAL, true, stored(REWORDED_INTERNAL, { documents: SETTLED_YES, stale: UNSETTLED }));
    expect(problem).toContain('is not settled as free of stale internal or umbrella wording (uncertain, escalate, probability 0.51)');
  });

  test('a package the release does not publish is not asked about stale wording', () => {
    expect(readmeProblems('.', REWORDED_INTERNAL, false, stored(REWORDED_INTERNAL, { documents: SETTLED_YES }))).toEqual([]);
  });

  test('a changed README has no stored reading and fails until it is read', () => {
    const edited = { ...REWORDED_INTERNAL, readme: `${REWORDED_INTERNAL.readme}\n\nOne more line.` };
    const [problem] = readmeProblems('.', edited, true, stored(REWORDED_INTERNAL, { documents: SETTLED_YES, stale: SETTLED_NO }));
    expect(problem).toContain('has no stored engine.gates.package-readme reading');
    expect(problem).toContain('bun run package-readmes:read');
  });
});

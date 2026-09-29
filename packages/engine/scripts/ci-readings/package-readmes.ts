// package-readmes.ts
//
// The README readings of the package metadata check, shared by the check
// (scripts/package-metadata-check.ts) and its live reader
// (scripts/read-package-readmes.ts, `bun run package-readmes:read`).
//
// Whether a package README documents the package, and whether it describes a
// published package in stale internal or umbrella terms, is read through Jev
// (`engine.gates.package-readme`) and stored by the content hash of the
// README, package name and description in etc/package-readme-readings.json.
// The check is offline: a README passes only on a stored, settled yes to
// `documents` and, for a public package, a settled no to `stale`.
//
// Test-harness override:
//   PACKAGE_README_READINGS, the stored readings file in place of etc/package-readme-readings.json

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { packageReadme, type PackageReadmeState } from './package-readme.ts';
import { describeAnswer, isSettled, stateHash, type StoredEntry } from './stored-readings.ts';

export const READINGS_PATH = process.env['PACKAGE_README_READINGS']
  ?? resolve(import.meta.dir, '..', '..', 'etc', 'package-readme-readings.json');

/** What a README reading is asked about: the package name and description from package.json, and the README text. */
export function readmeState(packageDir: string): PackageReadmeState {
  const pkg = JSON.parse(readFileSync(resolve(packageDir, 'package.json'), 'utf8')) as { name?: unknown; description?: unknown };
  return {
    name: typeof pkg.name === 'string' ? pkg.name : '',
    description: typeof pkg.description === 'string' ? pkg.description : '',
    readme: readFileSync(resolve(packageDir, 'README.md'), 'utf8').trim(),
  };
}

/** The questions a README is asked: `stale` only for a package the release publishes. */
export function readmeQuestions(isPublic: boolean): ('documents' | 'stale')[] {
  return isPublic ? ['documents', 'stale'] : ['documents'];
}

/** Why a README fails the check, from its stored readings; empty when it passes. */
export function readmeProblems(
  dir: string,
  state: PackageReadmeState,
  isPublic: boolean,
  readings: Readonly<Record<string, StoredEntry>>,
): string[] {
  const entry = readings[stateHash(state)];
  const problems: string[] = [];
  for (const question of readmeQuestions(isPublic)) {
    const answer = entry?.answers[question];
    if (answer === undefined) {
      problems.push(`${dir}/README.md has no stored ${packageReadme.name} reading for its current text; run \`bun run package-readmes:read\` and commit etc/package-readme-readings.json`);
      break;
    }
    if (question === 'documents' && !isSettled(answer, 'yes')) {
      problems.push(answer.verdict === 'no' && answer.outcome === 'act'
        ? `${dir}/README.md does not document the package`
        : `${dir}/README.md is not settled as documenting the package (${describeAnswer(answer)}); say plainly what the package is and how to install and use it`);
    }
    if (question === 'stale' && !isSettled(answer, 'no')) {
      problems.push(answer.verdict === 'yes' && answer.outcome === 'act'
        ? `${dir}/README.md describes the package in stale terms`
        : `${dir}/README.md is not settled as free of stale internal or umbrella wording (${describeAnswer(answer)}); describe it as the published package`);
    }
  }
  return problems;
}

// license-names.ts
//
// The license policy of the SBOM check, shared by the policy script
// (scripts/sbom-license-policy.ts) and the live reader of license names
// (scripts/read-license-names.ts, `bun run license-names:read`).
//
// AGPL, GPL, LGPL and SSPL are blocked because they impose copyleft
// obligations incompatible with closed-source SDK consumers. CDDL, EPL and
// MPL-2.0 are accepted: they apply file-level copyleft only and do not affect
// the proprietary SDK wrapper.
//
// Each SBOM license entry is checked by what it is:
//   - `license.id` is an SPDX id, a fixed format: the anchored prefix test.
//   - `expression` is an SPDX expression: parsed, and blocked when every way
//     of satisfying it uses a blocked id (AND needs both sides, OR lets the
//     licensee take either; see blockedExpressionIds). `MIT AND GPL-3.0-only`
//     is blocked; `MIT OR GPL-3.0-or-later` is satisfied by MIT alone.
//     An expression that does not parse is an offender: its ids cannot be checked.
//   - `license.name` is free text: whether it denotes one of the blocked
//     licenses is read through Jev (`engine.gates.copyleft-license`) and stored
//     by content hash in etc/copyleft-license-readings.json. The policy is
//     offline and passes a name only on a stored, settled no.
//
// Test-harness override:
//   LICENSE_NAME_READINGS, the stored readings file in place of etc/copyleft-license-readings.json

import { resolve } from 'node:path';
import { unavoidableIds } from '../spdx-expression.ts';
import type { CopyleftLicenseState } from './copyleft-license.ts';
import { describeAnswer, isSettled, stateHash, type StoredEntry } from './stored-readings.ts';

export const READINGS_PATH = process.env['LICENSE_NAME_READINGS']
  ?? resolve(import.meta.dir, '..', '..', 'etc', 'copyleft-license-readings.json');

/** An SPDX id of a blocked license family, any version or variant. */
const BLOCKED_ID = /^(?:AGPL|GPL|LGPL|SSPL)(?:-|$)/i;

type SbomLicenseEntry = {
  readonly license?: {
    readonly id?: unknown;
    readonly name?: unknown;
  };
  readonly expression?: unknown;
};

export type SbomComponent = {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly licenses?: readonly SbomLicenseEntry[];
  readonly components?: readonly SbomComponent[];
};

export type Sbom = {
  readonly components?: readonly SbomComponent[];
};

/** Every component in the SBOM, nested components included. */
export function sbomComponents(sbom: Sbom): SbomComponent[] {
  const all: SbomComponent[] = [];
  const walk = (components: readonly SbomComponent[] | undefined): void => {
    for (const component of components ?? []) {
      all.push(component);
      walk(component.components);
    }
  };
  walk(sbom.components);
  return all;
}

/** The state a license name is read as. */
export function licenseNameState(name: string): CopyleftLicenseState {
  return { license: name };
}

/** Every distinct free-text license name in the SBOM, sorted. */
export function licenseNames(sbom: Sbom): string[] {
  const names = new Set<string>();
  for (const component of sbomComponents(sbom)) {
    for (const entry of component.licenses ?? []) {
      if (typeof entry.license?.id !== 'string' && typeof entry.license?.name === 'string') names.add(entry.license.name);
    }
  }
  return [...names].sort();
}

/**
 * The blocked ids an expression names. Every license id is tested, whichever
 * operator joins it: `MIT AND GPL-3.0-only` and `MIT OR GPL-3.0-or-later`
 * both name a blocked license. Whether an OR with a permissive alternative
 * should pass is the owner's license policy, not settled here.
 */
export function blockedExpressionIds(expression: string): string[] {
  return unavoidableIds(expression, (id) => BLOCKED_ID.test(id));
}

/** Why one license entry is blocked, or null when it passes. */
function entryProblem(entry: SbomLicenseEntry, readings: Readonly<Record<string, StoredEntry>>): string | null {
  if (typeof entry.license?.id === 'string') {
    return BLOCKED_ID.test(entry.license.id) ? `${entry.license.id} is blocked` : null;
  }
  if (typeof entry.license?.name === 'string') {
    const name = entry.license.name;
    const answer = readings[stateHash(licenseNameState(name))]?.answers['copyleft'];
    if (answer === undefined) return `license name "${name}" has no stored reading; run \`bun run license-names:read\` and commit etc/copyleft-license-readings.json`;
    if (isSettled(answer, 'no')) return null;
    return answer.verdict === 'yes' && answer.outcome === 'act'
      ? `license name "${name}" is an AGPL, GPL, LGPL or SSPL license`
      : `license name "${name}" is not settled as outside the blocked licenses (${describeAnswer(answer)}); a person reviews it`;
  }
  if (typeof entry.expression === 'string') {
    try {
      const blocked = blockedExpressionIds(entry.expression);
      return blocked.length > 0 ? `${entry.expression} names blocked ${blocked.join(', ')}` : null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  return null;
}

/** Every blocked component, one line each: `name@version: reason; reason`. */
export function licenseOffenders(sbom: Sbom, readings: Readonly<Record<string, StoredEntry>>): string[] {
  const offenders: string[] = [];
  for (const component of sbomComponents(sbom)) {
    const problems = (component.licenses ?? [])
      .map((entry) => entryProblem(entry, readings))
      .filter((problem): problem is string => problem !== null);
    if (problems.length > 0) offenders.push(`${String(component.name)}@${String(component.version)}: ${problems.join('; ')}`);
  }
  return offenders;
}

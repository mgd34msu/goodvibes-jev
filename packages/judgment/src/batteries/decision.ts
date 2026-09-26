import type { JudgmentPort } from '../port/types.ts';
import type { Outcome } from '../readings/bands.ts';

/**
 * One expectation checked against a live reading: what the fixture said,
 * what the decision concluded, and how strong the reading behind it was.
 */
export interface FixtureCheck {
  readonly fixture: string;
  /** Which part of the decision was checked (a question name, "route", "top"...). */
  readonly aspect: string;
  readonly expected: string;
  readonly got: string;
  readonly correct: boolean;
  /**
   * The strength of the reading behind `got`: the winning probability for a
   * yes/no, the confidence for a choice or score. Calibration plots accuracy
   * against it and re-bands on it without new calls.
   */
  readonly signal: number;
  readonly outcome: Outcome;
}

/** A check whose correctness is whether the decision's answer equals the fixture's. */
export function fixtureCheck(
  fixture: string,
  aspect: string,
  expected: string,
  got: string,
  signal: number,
  outcome: Outcome,
): FixtureCheck {
  return { fixture, aspect, expected, got, correct: got === expected, signal, outcome };
}

/**
 * A named decision: anything that asks System One on behalf of one decision
 * site and can prove itself against labelled fixtures. Fixed-question
 * batteries and every pattern instance are named decisions; the registry and
 * calibration treat them alike.
 */
export interface NamedDecision {
  readonly name: string;
  readonly version: number;
  readonly description: string;
  /** Share of fixture checks calibration must get right, in (0, 1]. */
  readonly accuracyFloor: number;
  /** Versioned model the bands were tuned on; omitted uses the port's pinned model. */
  readonly model?: string;
  readonly fixtureCount: number;
  /** Runs every fixture live and returns one check per expectation. */
  checkFixtures(port: JudgmentPort, options?: { readonly signal?: AbortSignal }): Promise<readonly FixtureCheck[]>;
}

/** What every named decision declares about itself before it can run. */
export type PatternHeader = Pick<NamedDecision, 'name' | 'version' | 'description' | 'accuracyFloor' | 'model'>;

const NAME = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

/** Validates the fields every named decision shares. */
export function assertDecisionHeader(header: {
  readonly name: string;
  readonly version: number;
  readonly accuracyFloor: number;
  readonly fixtureCount: number;
}): void {
  const { name, version, accuracyFloor, fixtureCount } = header;
  if (!NAME.test(name)) throw new RangeError(`decision name "${name}" must be lowercase dotted or dashed words`);
  if (!Number.isInteger(version) || version < 1) throw new RangeError(`decision ${name}: version must be a positive integer`);
  if (!(accuracyFloor > 0 && accuracyFloor <= 1)) throw new RangeError(`decision ${name}: accuracyFloor must be in (0, 1]`);
  if (fixtureCount < 1) throw new RangeError(`decision ${name}: needs at least one labelled fixture`);
}

/** Rejects fixture lists with repeated names. */
export function assertUniqueFixtures(decision: string, fixtures: readonly { readonly name: string }[]): void {
  const seen = new Set<string>();
  for (const { name } of fixtures) {
    if (seen.has(name)) throw new RangeError(`decision ${decision}: duplicate fixture "${name}"`);
    seen.add(name);
  }
}

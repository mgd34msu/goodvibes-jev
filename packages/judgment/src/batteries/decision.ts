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
  /**
   * Every answer the checked question could conclude, when that set is closed
   * (yes or no, a fixed set of options, the levels of a rubric). Absent when
   * the answers depend on the fixture's own data, such as candidate ids.
   */
  readonly answers?: readonly string[];
  /**
   * The question this check reads, when several aspects read the same one
   * (one check per listed item, say); absent when the aspect is the question.
   */
  readonly question?: string;
}

/** The answer set and question identity a check can declare. */
export interface CheckVocabulary {
  readonly answers?: readonly string[];
  readonly question?: string;
}

/** What a fixture expects, and a check reports, when a decision finds nothing to pick. */
export const NONE = 'none';

/** A check whose correctness is whether the decision's answer equals the fixture's. */
export function fixtureCheck(
  fixture: string,
  aspect: string,
  expected: string,
  got: string,
  signal: number,
  outcome: Outcome,
  vocabulary: CheckVocabulary = {},
): FixtureCheck {
  const { answers, question } = vocabulary;
  return {
    fixture,
    aspect,
    expected,
    got,
    correct: got === expected,
    signal,
    outcome,
    ...(answers === undefined ? {} : { answers: [...answers].sort() }),
    ...(question === undefined ? {} : { question }),
  };
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
function assertDecisionHeader(header: {
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
function assertUniqueFixtures(decision: string, fixtures: readonly { readonly name: string }[]): void {
  const seen = new Set<string>();
  for (const { name } of fixtures) {
    if (seen.has(name)) throw new RangeError(`decision ${decision}: duplicate fixture "${name}"`);
    seen.add(name);
  }
}

/** What a named decision carries besides its fixture check. */
export type DecisionIdentity = Omit<NamedDecision, 'checkFixtures'>;

/** Validates a pattern's header and fixture names, and returns the header its named decision carries. */
export function decisionHeader(spec: PatternHeader & { readonly fixtures: readonly { readonly name: string }[] }): DecisionIdentity {
  const { name, version, description, accuracyFloor, model, fixtures } = spec;
  const header = { name, version, description, accuracyFloor, ...(model === undefined ? {} : { model }), fixtureCount: fixtures.length };
  assertDecisionHeader(header);
  assertUniqueFixtures(name, fixtures);
  return header;
}

/** The decision log site every calibration call is recorded under. */
export const CALIBRATION_SITE = 'calibration';

/**
 * How a fixture runs live: with the caller's signal, its calls marked as
 * calibration in the decision log and named for the fixture, so the log can
 * take the fixture's expectations as ground truth for them.
 */
export interface CalibrationRun {
  readonly signal?: AbortSignal;
  readonly site: typeof CALIBRATION_SITE;
  readonly fixture: string;
}

/** Runs every fixture live, one at a time, and gathers the checks each one produces. */
export async function checkEachFixture<F extends { readonly name: string }>(
  fixtures: readonly F[],
  options: { readonly signal?: AbortSignal },
  check: (fixture: F, run: CalibrationRun) => Promise<FixtureCheck | readonly FixtureCheck[]>,
): Promise<FixtureCheck[]> {
  const checks: FixtureCheck[] = [];
  for (const fixture of fixtures) {
    const run: CalibrationRun = { ...options, site: CALIBRATION_SITE, fixture: fixture.name };
    checks.push(...[await check(fixture, run)].flat());
  }
  return checks;
}

import { assertDecisionHeader, assertUniqueFixtures, type FixtureCheck, type NamedDecision } from '../batteries/decision.ts';
import { choice, type EntryType, type JudgmentPort } from '../port/types.ts';
import { assertConfidenceBand, type ConfidenceBand } from '../readings/bands.ts';
import { readChoice, type ChoiceReading } from '../readings/readings.ts';
import { askAs, recordReadings, type CallOptions, type PatternHeader } from '../batteries/asking.ts';

/**
 * Classification that answers coarsely when unsure (the classification
 * using confidence cookbook): one Choice over the fine labels; a confident
 * answer is reported as the fine label, an unsure one as the broader label
 * above it. The broad label follows from the fine one in code, so there is
 * no second call and every item still gets a usable label.
 */
export interface CoarseningSpec<F extends string> extends PatternHeader {
  readonly instructions: EntryType;
  /** Each fine label with its description and the broader label it rolls up into. */
  readonly labels: Readonly<Record<F, { readonly description: EntryType; readonly parent: string }>>;
  /** Confidence at or above `actAt` keeps the fine label; below it the parent is reported. */
  readonly band: ConfidenceBand;
  readonly fixtures: readonly { readonly name: string; readonly state: EntryType; readonly expect: string }[];
}

export interface Coarsened<F extends string> {
  readonly level: 'fine' | 'coarse';
  readonly label: string;
  readonly fine: F;
  readonly reading: ChoiceReading<F>;
}

export interface CoarseningClassifier<F extends string> extends NamedDecision {
  classify(port: JudgmentPort, state: EntryType, options?: CallOptions): Promise<Coarsened<F>>;
}

export function defineCoarseningClassifier<const F extends string>(spec: CoarseningSpec<F>): CoarseningClassifier<F> {
  assertDecisionHeader({ ...spec, fixtureCount: spec.fixtures.length });
  assertUniqueFixtures(spec.name, spec.fixtures);
  assertConfidenceBand(spec.band);
  const fines = Object.keys(spec.labels) as F[];
  const known = new Set<string>([...fines, ...fines.map((fine) => spec.labels[fine].parent)]);
  for (const fixture of spec.fixtures) {
    if (!known.has(fixture.expect)) throw new RangeError(`coarsening ${spec.name}: fixture ${fixture.name} expects an unknown label`);
  }
  const question = choice(spec.instructions, Object.fromEntries(fines.map((fine) => [fine, spec.labels[fine].description])));

  const classifier: CoarseningClassifier<F> = {
    name: spec.name,
    version: spec.version,
    description: spec.description,
    accuracyFloor: spec.accuracyFloor,
    ...(spec.model === undefined ? {} : { model: spec.model }),
    fixtureCount: spec.fixtures.length,
    async classify(port, state, options = {}) {
      const result = await askAs(port, spec, 'coarsen', state, { label: question }, options);
      const reading = readChoice(result.answers.label, spec.band) as ChoiceReading<F>;
      const fine = reading.choice;
      const confident = reading.outcome === 'act';
      const coarsened: Coarsened<F> = {
        level: confident ? 'fine' : 'coarse',
        label: confident ? fine : spec.labels[fine].parent,
        fine,
        reading,
      };
      recordReadings(port, result, { level: coarsened.level, label: coarsened.label, reading });
      return coarsened;
    },
    async checkFixtures(port, options = {}) {
      const checks: FixtureCheck[] = [];
      for (const fixture of spec.fixtures) {
        const got = await classifier.classify(port, fixture.state, { site: 'calibration', ...options });
        checks.push({
          fixture: fixture.name,
          aspect: 'label',
          expected: fixture.expect,
          got: got.label,
          correct: got.label === fixture.expect,
          signal: got.reading.confidence,
          outcome: got.reading.outcome,
        });
      }
      return checks;
    },
  };
  return classifier;
}

import { assertDecisionHeader, assertUniqueFixtures, type FixtureCheck, type NamedDecision } from '../batteries/decision.ts';
import { noul, type JsonValue, type JudgmentPort, type NoulQuestion } from '../port/types.ts';
import { assertYesNoBand, type Outcome, type YesNoBand } from '../readings/bands.ts';
import { readYesNo, type YesNoReading } from '../readings/readings.ts';
import { askAs, recordAction, recordReadings, type CallOptions, type PatternHeader } from './common.ts';

/**
 * Judging output against a goal: one yes/no per acceptance criterion, framed
 * so that yes means the criterion is NOT met (the escalate case is the true
 * case, as the SDE cascade recommends), plus one yes/no on the goal itself.
 * All of them ride one request. Aggregation is max-style: one confident
 * unmet criterion fails the output instead of being averaged away.
 */
export interface JudgeSpec extends PatternHeader {
  /** Band on the probability that a criterion is unmet. */
  readonly band: YesNoBand;
  readonly fixtures: readonly JudgeFixture[];
}

export interface JudgeInput {
  readonly goal: string;
  readonly criteria: readonly string[];
  /** The work product being judged: text, a diff, a record, a transcript excerpt. */
  readonly output: JsonValue;
  /** What else the judge may look at: test results, command output, file listings. */
  readonly evidence?: JsonValue;
}

export interface JudgeFixture extends JudgeInput {
  readonly name: string;
  readonly expect: {
    readonly verdict: 'pass' | 'fail';
    /** Indexes of criteria that should read as unmet; the rest should read as met. */
    readonly unmet?: readonly number[];
  };
}

export type Verdict = 'pass' | 'fail' | 'uncertain';

export interface Judgment {
  readonly verdict: Verdict;
  readonly outcome: Outcome;
  /** One reading per criterion, in order; `verdict: 'yes'` means unmet. */
  readonly criteria: readonly YesNoReading[];
  /** Reading on whether the output fails the goal as a whole. */
  readonly goal: YesNoReading;
  /** Criteria read as unmet, by index. */
  readonly unmet: readonly number[];
  readonly decisionId: string | undefined;
  recordAction(action: string): void;
}

export interface Judge extends NamedDecision {
  judge(port: JudgmentPort, input: JudgeInput, options?: CallOptions): Promise<Judgment>;
}

const CRITERION_QUESTION = (criterion: string): NoulQuestion =>
  noul(
    {
      question: 'Does `output` fail to meet `criterion`, or does `evidence` fail to show that it meets it?',
      criterion,
    },
    {
      true: 'The output does not meet the criterion, or nothing in the output or evidence shows that it does.',
      false: 'The output meets the criterion, and the output or evidence shows it.',
    },
  );

const GOAL_QUESTION: NoulQuestion = noul('Does `output` fail to achieve `goal`?', {
  true: 'The output falls short of the goal or does something other than the goal asks.',
  false: 'The output achieves what the goal asks.',
});

/** Folds per-criterion and goal readings into one verdict, max-style. */
export function aggregateJudgment(readings: readonly YesNoReading[]): { verdict: Verdict; outcome: Outcome } {
  const unmet = readings.filter((reading) => reading.verdict === 'yes');
  if (unmet.length > 0) {
    return { verdict: 'fail', outcome: unmet.some((reading) => reading.outcome === 'act') ? 'act' : 'confirm' };
  }
  if (readings.some((reading) => reading.verdict === 'uncertain')) return { verdict: 'uncertain', outcome: 'escalate' };
  return { verdict: 'pass', outcome: readings.every((reading) => reading.outcome === 'act') ? 'act' : 'confirm' };
}

export function defineJudge(spec: JudgeSpec): Judge {
  assertDecisionHeader({ ...spec, fixtureCount: spec.fixtures.length });
  assertUniqueFixtures(spec.name, spec.fixtures);
  assertYesNoBand(spec.band);
  for (const fixture of spec.fixtures) {
    if (fixture.criteria.length === 0) throw new RangeError(`judge ${spec.name}: fixture ${fixture.name} has no criteria`);
    for (const index of fixture.expect.unmet ?? []) {
      if (!(index >= 0 && index < fixture.criteria.length)) {
        throw new RangeError(`judge ${spec.name}: fixture ${fixture.name} names criterion ${index}, which does not exist`);
      }
    }
    if (fixture.expect.verdict === 'pass' && (fixture.expect.unmet?.length ?? 0) > 0) {
      throw new RangeError(`judge ${spec.name}: fixture ${fixture.name} passes with unmet criteria`);
    }
  }

  const judge: Judge = {
    name: spec.name,
    version: spec.version,
    description: spec.description,
    accuracyFloor: spec.accuracyFloor,
    ...(spec.model === undefined ? {} : { model: spec.model }),
    fixtureCount: spec.fixtures.length,
    async judge(port, input, options = {}) {
      if (input.criteria.length === 0) throw new RangeError(`judge ${spec.name}: nothing to judge without criteria`);
      const questions: Record<string, NoulQuestion> = { goal: GOAL_QUESTION };
      input.criteria.forEach((criterion, index) => {
        questions[`criterion_${index}`] = CRITERION_QUESTION(criterion);
      });
      const state = {
        goal: input.goal,
        output: input.output,
        ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
      };
      const result = await askAs(port, spec, 'judge', state, questions, options);
      const answers = result.answers as Record<string, { type: 'noul'; noul: number }>;
      const criteria = input.criteria.map((_, index) => readYesNo(answers[`criterion_${index}`]!, spec.band));
      const goal = readYesNo(answers['goal']!, spec.band);
      const { verdict, outcome } = aggregateJudgment([...criteria, goal]);
      const unmet = criteria.flatMap((reading, index) => (reading.verdict === 'yes' ? [index] : []));
      recordReadings(port, result, { verdict, outcome, goal, criteria });
      return {
        verdict,
        outcome,
        criteria,
        goal,
        unmet,
        decisionId: result.decisionId,
        recordAction: (action) => recordAction(port, result.decisionId, action),
      };
    },
    async checkFixtures(port, options = {}) {
      const checks: FixtureCheck[] = [];
      for (const fixture of spec.fixtures) {
        const judgment = await judge.judge(port, fixture, { site: 'calibration', ...options });
        const all = [...judgment.criteria, judgment.goal];
        const signal =
          judgment.verdict === 'fail'
            ? Math.max(...all.map((reading) => reading.probability))
            : Math.min(...all.map((reading) => 1 - reading.probability));
        checks.push({
          fixture: fixture.name,
          aspect: 'verdict',
          expected: fixture.expect.verdict,
          got: judgment.verdict,
          correct: judgment.verdict === fixture.expect.verdict,
          signal,
          outcome: judgment.outcome,
        });
        if (fixture.expect.unmet !== undefined) {
          const expectedUnmet = new Set(fixture.expect.unmet);
          judgment.criteria.forEach((reading, index) => {
            const expected = expectedUnmet.has(index) ? 'unmet' : 'met';
            const got = reading.probability >= 0.5 ? 'unmet' : 'met';
            checks.push({
              fixture: fixture.name,
              aspect: `criterion_${index}`,
              expected,
              got,
              correct: got === expected,
              signal: Math.max(reading.probability, 1 - reading.probability),
              outcome: reading.outcome,
            });
          });
        }
      }
      return checks;
    },
  };
  return judge;
}

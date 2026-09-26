import { concludedAnswer, readingSignal } from '../batteries/battery.ts';
import { checkEachFixture, decisionHeader, fixtureCheck, type FixtureCheck, type NamedDecision } from '../batteries/decision.ts';
import { noul, type JsonValue, type JudgmentPort, type NoulQuestion } from '../port/types.ts';
import { assertYesNoBand, type Outcome, type YesNoBand } from '../readings/bands.ts';
import { readYesNo, type YesNoReading } from '../readings/readings.ts';
import { askAs, recordAction, recordReadings, type CallOptions, type PatternHeader } from '../batteries/asking.ts';

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

/** Criterion and goal questions ask whether something falls short, so a yes reads as unmet. */
const isUnmet = (reading: YesNoReading): boolean => reading.verdict === 'yes';

/** Folds per-criterion and goal readings into one verdict, max-style. */
export function aggregateJudgment(readings: readonly YesNoReading[]): { verdict: Verdict; outcome: Outcome } {
  const unmet = readings.filter(isUnmet);
  const someUnmet = unmet.length > 0;
  const someUnsettled = readings.some((reading) => reading.verdict === 'uncertain');
  if (someUnmet) {
    const confidentlyUnmet = unmet.some((reading) => reading.outcome === 'act');
    return { verdict: 'fail', outcome: confidentlyUnmet ? 'act' : 'confirm' };
  }
  if (someUnsettled) return { verdict: 'uncertain', outcome: 'escalate' };
  const everyMetConfidently = readings.every((reading) => reading.outcome === 'act');
  return { verdict: 'pass', outcome: everyMetConfidently ? 'act' : 'confirm' };
}

/** How strongly the readings back the verdict: the strongest unmet reading for a fail, the weakest met one otherwise. */
function verdictSignal(judgment: Judgment): number {
  const readings = [...judgment.criteria, judgment.goal];
  if (judgment.verdict === 'fail') return Math.max(...readings.map((reading) => reading.probability));
  return Math.min(...readings.map((reading) => 1 - reading.probability));
}

const asCriterionAnswer = (answer: string): 'met' | 'unmet' => (answer === 'yes' ? 'unmet' : 'met');

function fixtureChecks(fixture: JudgeFixture, judgment: Judgment): FixtureCheck[] {
  const checks = [fixtureCheck(fixture.name, 'verdict', fixture.expect.verdict, judgment.verdict, verdictSignal(judgment), judgment.outcome)];
  if (fixture.expect.unmet === undefined) return checks;
  const expectedUnmet = new Set(fixture.expect.unmet);
  judgment.criteria.forEach((reading, index) => {
    const expected = expectedUnmet.has(index) ? 'unmet' : 'met';
    checks.push(fixtureCheck(fixture.name, `criterion_${index}`, expected, asCriterionAnswer(concludedAnswer(reading)), readingSignal(reading), reading.outcome));
  });
  return checks;
}

function assertJudgeFixture(judge: string, fixture: JudgeFixture): void {
  if (fixture.criteria.length === 0) throw new RangeError(`judge ${judge}: fixture ${fixture.name} has no criteria`);
  const unmet = fixture.expect.unmet ?? [];
  const missing = unmet.find((index) => !(index >= 0 && index < fixture.criteria.length));
  if (missing !== undefined) throw new RangeError(`judge ${judge}: fixture ${fixture.name} names criterion ${missing}, which does not exist`);
  if (fixture.expect.verdict === 'pass' && unmet.length > 0) throw new RangeError(`judge ${judge}: fixture ${fixture.name} passes with unmet criteria`);
}

function judgeQuestions(criteria: readonly string[]): Record<string, NoulQuestion> {
  return Object.fromEntries([['goal', GOAL_QUESTION], ...criteria.map((criterion, index) => [`criterion_${index}`, CRITERION_QUESTION(criterion)])]);
}

export function defineJudge(spec: JudgeSpec): Judge {
  const header = decisionHeader(spec);
  assertYesNoBand(spec.band);
  for (const fixture of spec.fixtures) assertJudgeFixture(spec.name, fixture);

  const judge: Judge = {
    ...header,
    async judge(port, input, options = {}) {
      if (input.criteria.length === 0) throw new RangeError(`judge ${spec.name}: nothing to judge without criteria`);
      const state = { goal: input.goal, output: input.output, ...(input.evidence === undefined ? {} : { evidence: input.evidence }) };
      const result = await askAs(port, spec, 'judge', state, judgeQuestions(input.criteria), options);
      const answers = result.answers as Record<string, { type: 'noul'; noul: number }>;
      const criteria = input.criteria.map((_, index) => readYesNo(answers[`criterion_${index}`]!, spec.band));
      const goal = readYesNo(answers['goal']!, spec.band);
      const { verdict, outcome } = aggregateJudgment([...criteria, goal]);
      const unmet = criteria.flatMap((reading, index) => (isUnmet(reading) ? [index] : []));
      recordReadings(port, result, { verdict, outcome, goal, criteria });
      return { verdict, outcome, criteria, goal, unmet, decisionId: result.decisionId, recordAction: (action) => recordAction(port, result.decisionId, action) };
    },
    checkFixtures: (port, options = {}) =>
      checkEachFixture(spec.fixtures, options, async (fixture, run) => fixtureChecks(fixture, await judge.judge(port, fixture, run))),
  };
  return judge;
}

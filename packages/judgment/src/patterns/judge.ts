import { concludedAnswer, readingSignal } from '../batteries/battery.ts';
import { checkEachFixture, decisionHeader, fixtureCheck, type FixtureCheck, type NamedDecision } from '../batteries/decision.ts';
import { noul, type JsonValue, type JudgmentPort, type NoulQuestion, type NoulResponse } from '../port/types.ts';
import { assertBand, type Outcome, type YesNoBand } from '../readings/bands.ts';
import { readYesNo, type YesNoReading } from '../readings/readings.ts';
import { askAs, recordAction, recordReadings, type CallOptions, type PatternHeader } from '../batteries/asking.ts';

/** Judging output against a goal: one yes/no per acceptance criterion and one on the goal itself, all in one request. */
export interface JudgeSpec extends PatternHeader {
  /** Band on each criterion and goal reading. */
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
    readonly verdict: Exclude<Verdict, 'uncertain'>;
    /** Indexes of criteria that should read as unmet; the rest should read as met. */
    readonly unmet?: readonly number[];
  };
}

export type Verdict = 'pass' | 'fail' | 'uncertain';

export interface Judgment {
  readonly verdict: Verdict;
  readonly outcome: Outcome;
  /** One reading per criterion, in order. */
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

/**
 * The verdict a yes/no answer gives one criterion or the goal. The questions
 * ask whether the output falls short, so yes fails: the escalate case is the
 * true case, as the SDE cascade recommends.
 */
const VERDICT_OF_ANSWER: Readonly<Record<string, Verdict>> = { yes: 'fail', no: 'pass' };
const verdictOf = (answer: string): Verdict => VERDICT_OF_ANSWER[answer] ?? 'uncertain';
/** The question name a criterion is asked under. */
const criterionKey = (index: number): string => `criterion_${index}`;

/** Verdicts from worst to best. */
const WORST_FIRST: readonly Verdict[] = ['fail', 'uncertain', 'pass'];

const isActing = (reading: YesNoReading): boolean => reading.outcome === 'act';

/**
 * How a settled verdict reads the readings behind it: a fail acts when one
 * failing reading acts and is backed by the strongest unmet probability; a
 * pass acts only when every reading acts and is backed by the weakest met one.
 */
const SETTLED: Readonly<Record<'fail' | 'pass', { acts(deciding: readonly YesNoReading[]): boolean; signal(strongestUnmet: number): number }>> = {
  fail: { acts: (deciding) => deciding.some(isActing), signal: (p) => p },
  pass: { acts: (deciding) => deciding.every(isActing), signal: (p) => 1 - p },
};

/** The criterion readings and the goal reading a judgment rests on. */
type JudgedReadings = Pick<Judgment, 'criteria' | 'goal'>;
const readingsOf = ({ criteria, goal }: JudgedReadings): YesNoReading[] => [...criteria, goal];

/** Folds criterion and goal readings into one verdict, max-style: the worst reading decides. Also names the unmet criteria. */
export function aggregateJudgment(judged: JudgedReadings): Pick<Judgment, 'verdict' | 'outcome' | 'unmet'> {
  const readings = readingsOf(judged);
  const verdicts = readings.map((reading) => verdictOf(reading.verdict));
  const unmet = judged.criteria.flatMap((_, index) => (verdicts[index] === 'fail' ? [index] : []));
  const verdict = WORST_FIRST.find((candidate) => verdicts.includes(candidate)) ?? 'pass';
  if (verdict === 'uncertain') return { verdict, outcome: 'escalate', unmet };
  const deciding = readings.filter((_, index) => verdicts[index] === verdict);
  return { verdict, outcome: SETTLED[verdict].acts(deciding) ? 'act' : 'confirm', unmet };
}

/** How strongly the readings back the verdict; an uncertain verdict is scored as a pass that did not settle. */
function verdictSignal(judgment: Judgment): number {
  const strongestUnmet = Math.max(...readingsOf(judgment).map((reading) => reading.probability));
  return SETTLED[judgment.verdict === 'fail' ? 'fail' : 'pass'].signal(strongestUnmet);
}

/** The verdicts a settled judgment concludes; uncertain is the absence of one. */
const SETTLED_VERDICTS = { answers: ['pass', 'fail'] } as const;

function fixtureChecks(fixture: JudgeFixture, judgment: Judgment): FixtureCheck[] {
  const checks = [fixtureCheck(fixture.name, 'verdict', fixture.expect.verdict, judgment.verdict, verdictSignal(judgment), judgment.outcome, SETTLED_VERDICTS)];
  if (fixture.expect.unmet === undefined) return checks;
  const expectedUnmet = new Set(fixture.expect.unmet);
  judgment.criteria.forEach((reading, index) => {
    const expected: Verdict = expectedUnmet.has(index) ? 'fail' : 'pass';
    checks.push(
      fixtureCheck(fixture.name, criterionKey(index), expected, verdictOf(concludedAnswer(reading)), readingSignal(reading), reading.outcome, {
        ...SETTLED_VERDICTS,
        question: 'criterion',
      }),
    );
  });
  return checks;
}

/** Throws unless there is at least one criterion to judge against. */
function assertHasCriteria(judge: string, input: JudgeInput): void {
  if (input.criteria.length === 0) throw new RangeError(`judge ${judge}: nothing to judge without criteria`);
}

function assertJudgeFixture(judge: string, fixture: JudgeFixture): void {
  assertHasCriteria(judge, fixture);
  const unmet = fixture.expect.unmet ?? [];
  const missing = unmet.find((index) => fixture.criteria[index] === undefined);
  if (missing !== undefined) throw new RangeError(`judge ${judge}: fixture ${fixture.name} names criterion ${missing}, which does not exist`);
  const passesWithUnmet = fixture.expect.verdict === 'pass' && unmet.length > 0;
  if (passesWithUnmet) throw new RangeError(`judge ${judge}: fixture ${fixture.name} passes with unmet criteria`);
}

function judgeQuestions(criteria: readonly string[]): Record<string, NoulQuestion> {
  return Object.fromEntries([['goal', GOAL_QUESTION], ...criteria.map((criterion, index) => [criterionKey(index), CRITERION_QUESTION(criterion)])]);
}

export function defineJudge(spec: JudgeSpec): Judge {
  const header = decisionHeader(spec);
  assertBand(spec.band);
  for (const fixture of spec.fixtures) assertJudgeFixture(spec.name, fixture);

  const judge: Judge = {
    ...header,
    async judge(port, input, options = {}) {
      assertHasCriteria(spec.name, input);
      const state = { goal: input.goal, output: input.output, ...(input.evidence === undefined ? {} : { evidence: input.evidence }) };
      const result = await askAs(port, spec, 'judge', state, judgeQuestions(input.criteria), options);
      const answers = result.answers as Readonly<Record<string, NoulResponse>>;
      const criteria = input.criteria.map((_, index) => readYesNo(answers[criterionKey(index)]!, spec.band));
      const goal = readYesNo(answers['goal']!, spec.band);
      const { verdict, outcome, unmet } = aggregateJudgment({ criteria, goal });
      recordReadings(port, result, { verdict, outcome, goal, criteria });
      return { verdict, outcome, criteria, goal, unmet, decisionId: result.decisionId, recordAction: (action) => recordAction(port, result.decisionId, action) };
    },
    checkFixtures: (port, options = {}) =>
      checkEachFixture(spec.fixtures, options, async (fixture, run) => fixtureChecks(fixture, await judge.judge(port, fixture, run))),
  };
  return judge;
}

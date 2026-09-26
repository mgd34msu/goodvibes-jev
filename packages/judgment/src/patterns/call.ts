import { assertDecisionHeader, assertUniqueFixtures, type FixtureCheck, type NamedDecision } from '../batteries/decision.ts';
import { choice, noul, type EntryType, type JudgmentPort, type Question } from '../port/types.ts';
import { assertConfidenceBand, outcomeForConfidence, type ConfidenceBand, type Outcome } from '../readings/bands.ts';
import { askAs, recordReadings, type CallOptions, type PatternHeader } from '../batteries/asking.ts';

/** An argument that takes one value from a fixed list. */
export interface ChoiceArg {
  readonly kind: 'choice';
  readonly question: EntryType;
  readonly options: Readonly<Record<string, EntryType>>;
  /** When set, the argument is optional: a yes/no on whether the request says anything about it. */
  readonly stated?: EntryType;
}
/** An argument that takes any number of values from a fixed list; `question` contains `{}` for the member. */
export interface SetArg {
  readonly kind: 'set';
  readonly question: string;
  readonly members: readonly string[];
  readonly stated?: EntryType;
}
/** An on/off argument. */
export interface FlagArg {
  readonly kind: 'flag';
  readonly question: EntryType;
  readonly stated?: EntryType;
}
export type ArgSpec = ChoiceArg | SetArg | FlagArg;

export interface FunctionSpec {
  readonly description: EntryType;
  readonly args: Readonly<Record<string, ArgSpec>>;
}

/**
 * Function calling over closed sets (the function calling cookbook): one
 * Choice picks the function, and every function's arguments ride the same
 * request as questions over their fixed values, so the call is filled in
 * one round trip and only the chosen function's answers are read. An
 * optional argument the request does not mention is left out and the
 * function's own default stands. Confidence is the weakest judgement in the
 * call, since one wrong argument spoils it.
 */
export interface CallerSpec extends PatternHeader {
  readonly instructions: EntryType;
  readonly functions: Readonly<Record<string, FunctionSpec>>;
  readonly band: ConfidenceBand;
  readonly fixtures: readonly {
    readonly name: string;
    readonly state: EntryType;
    readonly expect: { readonly fn: string; readonly args?: Readonly<Record<string, string | boolean | readonly string[]>> };
  }[];
}

export type ArgValue = string | boolean | readonly string[];

export interface FilledCall {
  readonly fn: string;
  readonly args: Readonly<Record<string, ArgValue>>;
  readonly omitted: readonly string[];
  /** The weakest probability behind the function or any argument. */
  readonly confidence: number;
  readonly weakest: string;
  readonly outcome: Outcome;
}

export interface FunctionCaller extends NamedDecision {
  fill(port: JudgmentPort, state: EntryType, options?: CallOptions): Promise<FilledCall>;
}

const ROUTE = '__function__';
const key = (fn: string, arg: string, part: string) => `${fn}.${arg}${part}`;
type Answers = Record<string, { noul?: number; choice?: string; probabilities?: Record<string, number> }>;

function argQuestions(fn: string, arg: string, spec: ArgSpec): [string, Question][] {
  const entries: [string, Question][] = [];
  if (spec.stated !== undefined) entries.push([key(fn, arg, '?'), noul(spec.stated)]);
  if (spec.kind === 'choice') entries.push([key(fn, arg, ''), choice(spec.question, spec.options)]);
  if (spec.kind === 'flag') entries.push([key(fn, arg, ''), noul(spec.question)]);
  if (spec.kind === 'set') {
    spec.members.forEach((member, index) => entries.push([key(fn, arg, `[${index}]`), noul(spec.question.replaceAll('{}', member))]));
  }
  return entries;
}

function readArg(fn: string, arg: string, spec: ArgSpec, answers: Answers): { value: ArgValue | undefined; p: number } {
  const stated = spec.stated === undefined ? undefined : answers[key(fn, arg, '?')]!.noul!;
  if (stated !== undefined && stated < 0.5) return { value: undefined, p: 1 - stated };
  const floor = stated ?? 1;
  if (spec.kind === 'choice') {
    const answer = answers[key(fn, arg, '')]!;
    return { value: answer.choice!, p: Math.min(floor, answer.probabilities![answer.choice!]!) };
  }
  if (spec.kind === 'flag') {
    const p = answers[key(fn, arg, '')]!.noul!;
    return { value: p >= 0.5, p: Math.min(floor, Math.max(p, 1 - p)) };
  }
  const readings = spec.members.map((member, index) => ({ member, p: answers[key(fn, arg, `[${index}]`)]!.noul! }));
  const weakest = Math.min(floor, ...readings.map(({ p }) => Math.max(p, 1 - p)));
  return { value: readings.filter(({ p }) => p >= 0.5).map(({ member }) => member), p: weakest };
}

function fill(spec: CallerSpec, answers: Answers): FilledCall {
  const route = answers[ROUTE]!;
  const fn = route.choice!;
  let confidence = route.probabilities![fn]!;
  let weakest = 'function';
  const args: Record<string, ArgValue> = {};
  const omitted: string[] = [];
  for (const [arg, argSpec] of Object.entries(spec.functions[fn]!.args)) {
    const { value, p } = readArg(fn, arg, argSpec, answers);
    if (value === undefined) omitted.push(arg);
    else args[arg] = value;
    if (p < confidence) {
      confidence = p;
      weakest = arg;
    }
  }
  return { fn, args, omitted, confidence, weakest, outcome: outcomeForConfidence(confidence, spec.band) };
}

const describeCall = (fn: string, args: Readonly<Record<string, ArgValue>>): string =>
  `${fn}(${Object.entries(args)
    .map(([arg, value]) => `${arg}=${Array.isArray(value) ? `[${[...value].sort().join(',')}]` : String(value)}`)
    .join(', ')})`;

const same = (expected: ArgValue, got: ArgValue | undefined): boolean =>
  Array.isArray(expected) && Array.isArray(got)
    ? [...expected].sort().join('|') === [...got].sort().join('|')
    : expected === got;

export function defineFunctionCaller(spec: CallerSpec): FunctionCaller {
  assertDecisionHeader({ ...spec, fixtureCount: spec.fixtures.length });
  assertUniqueFixtures(spec.name, spec.fixtures);
  assertConfidenceBand(spec.band);
  for (const fixture of spec.fixtures) {
    if (!(fixture.expect.fn in spec.functions)) throw new RangeError(`caller ${spec.name}: fixture ${fixture.name} expects an unknown function`);
  }
  const questions: Record<string, Question> = {
    [ROUTE]: choice(spec.instructions, Object.fromEntries(Object.entries(spec.functions).map(([fn, f]) => [fn, f.description]))),
  };
  for (const [fn, f] of Object.entries(spec.functions)) {
    for (const [arg, argSpec] of Object.entries(f.args)) for (const [name, question] of argQuestions(fn, arg, argSpec)) questions[name] = question;
  }

  const caller: FunctionCaller = {
    name: spec.name,
    version: spec.version,
    description: spec.description,
    accuracyFloor: spec.accuracyFloor,
    ...(spec.model === undefined ? {} : { model: spec.model }),
    fixtureCount: spec.fixtures.length,
    async fill(port, state, options = {}) {
      const result = await askAs(port, spec, 'call', state, questions, options);
      const call = fill(spec, result.answers as Answers);
      recordReadings(port, result, call);
      return call;
    },
    async checkFixtures(port, options = {}) {
      const checks: FixtureCheck[] = [];
      for (const fixture of spec.fixtures) {
        const got = await caller.fill(port, fixture.state, { site: 'calibration', ...options });
        const expectedArgs = fixture.expect.args ?? {};
        const argsOk = Object.entries(expectedArgs).every(([arg, value]) => same(value, got.args[arg]));
        const shown = Object.fromEntries(Object.keys(expectedArgs).flatMap((arg) => (got.args[arg] === undefined ? [] : [[arg, got.args[arg]!]])));
        checks.push({
          fixture: fixture.name,
          aspect: 'call',
          expected: describeCall(fixture.expect.fn, expectedArgs),
          got: describeCall(got.fn, shown),
          correct: got.fn === fixture.expect.fn && argsOk,
          signal: got.confidence,
          outcome: got.outcome,
        });
      }
      return checks;
    },
  };
  return caller;
}

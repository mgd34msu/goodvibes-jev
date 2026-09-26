import { checkEachFixture, decisionHeader, fixtureCheck, type NamedDecision } from '../batteries/decision.ts';
import { choice, noul, type ChoiceResponse, type EntryType, type JudgmentPort, type JudgmentResult, type NoulResponse, type Question, type Questions } from '../port/types.ts';
import { assertConfidenceBand, outcomeForConfidence, type ConfidenceBand, type Outcome } from '../readings/bands.ts';
import { leansYes, likelierSide } from '../readings/readings.ts';
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

/** Question names inside the one request: the argument, its members, and its was-it-stated check. */
const argKey = (fn: string, arg: string) => `${fn}.${arg}`;
const memberKey = (fn: string, arg: string, index: number) => `${argKey(fn, arg)}[${index}]`;
const statedKey = (fn: string, arg: string) => `${argKey(fn, arg)}?`;

/** The call's answers, read by question name through typed accessors. */
interface CallAnswers {
  /** The yes probability of a yes/no question. */
  yes(question: string): number;
  /** The chosen option of a choice and the probability behind it. */
  picked(question: string): { readonly option: string; readonly p: number };
}

function callAnswers(answers: JudgmentResult<Questions>['answers']): CallAnswers {
  return {
    yes: (question) => (answers[question] as NoulResponse).noul,
    picked: (question) => {
      const { choice: option, probabilities } = answers[question] as ChoiceResponse;
      return { option, p: probabilities[option]! };
    },
  };
}

/** An argument's value and how strongly its reading backs it; undefined when the request did not state it. */
interface ArgReading {
  readonly value: ArgValue | undefined;
  readonly p: number;
}

function argQuestions(fn: string, arg: string, spec: ArgSpec): [string, Question][] {
  const stated: [string, Question][] = spec.stated === undefined ? [] : [[statedKey(fn, arg), noul(spec.stated)]];
  if (spec.kind === 'choice') return [...stated, [argKey(fn, arg), choice(spec.question, spec.options)]];
  if (spec.kind === 'flag') return [...stated, [argKey(fn, arg), noul(spec.question)]];
  return [...stated, ...spec.members.map((member, index): [string, Question] => [memberKey(fn, arg, index), noul(spec.question.replaceAll('{}', member))])];
}

type ArgReader<K extends ArgSpec['kind']> = (fn: string, arg: string, spec: Extract<ArgSpec, { kind: K }>, answers: CallAnswers) => ArgReading;

const READERS: Readonly<{ [K in ArgSpec['kind']]: ArgReader<K> }> = {
  choice: (fn, arg, _spec, answers) => {
    const { option, p } = answers.picked(argKey(fn, arg));
    return { value: option, p };
  },
  flag: (fn, arg, _spec, answers) => {
    const p = answers.yes(argKey(fn, arg));
    return { value: leansYes(p), p: likelierSide(p) };
  },
  set: (fn, arg, spec, answers) => {
    const members = spec.members.map((member, index) => ({ member, p: answers.yes(memberKey(fn, arg, index)) }));
    return { value: members.filter(({ p }) => leansYes(p)).map(({ member }) => member), p: Math.min(...members.map(({ p }) => likelierSide(p))) };
  },
};

function readArg(fn: string, arg: string, spec: ArgSpec, answers: CallAnswers): ArgReading {
  const stated = spec.stated === undefined ? 1 : answers.yes(statedKey(fn, arg));
  if (!leansYes(stated)) return { value: undefined, p: 1 - stated };
  const reading = (READERS[spec.kind] as ArgReader<ArgSpec['kind']>)(fn, arg, spec as never, answers);
  return { value: reading.value, p: Math.min(stated, reading.p) };
}

interface NamedReading extends ArgReading {
  readonly arg: string;
}

function fill(spec: CallerSpec, answers: CallAnswers): FilledCall {
  const { option: fn, p: fnP } = answers.picked(ROUTE);
  const readings = Object.entries(spec.functions[fn]!.args).map(([arg, argSpec]): NamedReading => ({ arg, ...readArg(fn, arg, argSpec, answers) }));
  const weakest = readings.reduce((low, reading) => (reading.p < low.p ? reading : low), { arg: 'function', value: undefined, p: fnP } as NamedReading);
  const args = Object.fromEntries(readings.flatMap(({ arg, value }) => (value === undefined ? [] : [[arg, value]])));
  const omitted = readings.filter(({ value }) => value === undefined).map(({ arg }) => arg);
  return { fn, args, omitted, confidence: weakest.p, weakest: weakest.arg, outcome: outcomeForConfidence(weakest.p, spec.band) };
}

const describeValue = (value: ArgValue): string => (Array.isArray(value) ? `[${[...value].sort().join(',')}]` : String(value));
const describeCall = (fn: string, args: Readonly<Record<string, ArgValue>>): string =>
  `${fn}(${Object.entries(args).map(([arg, value]) => `${arg}=${describeValue(value)}`).join(', ')})`;

export function defineFunctionCaller(spec: CallerSpec): FunctionCaller {
  const header = decisionHeader(spec);
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
    ...header,
    async fill(port, state, options = {}) {
      const result = await askAs(port, spec, 'call', state, questions, options);
      const call = fill(spec, callAnswers(result.answers));
      recordReadings(port, result, call);
      return call;
    },
    checkFixtures: (port, options = {}) =>
      checkEachFixture(spec.fixtures, options, async (fixture, run) => {
        const got = await caller.fill(port, fixture.state, run);
        const expectedArgs = fixture.expect.args ?? {};
        const shown = Object.fromEntries(Object.keys(expectedArgs).flatMap((arg) => (got.args[arg] === undefined ? [] : [[arg, got.args[arg]!]])));
        return fixtureCheck(fixture.name, 'call', describeCall(fixture.expect.fn, expectedArgs), describeCall(got.fn, shown), got.confidence, got.outcome);
      }),
  };
  return caller;
}

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

export type ArgValue = string | boolean | readonly string[];

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
    readonly expect: { readonly fn: string; readonly args?: Readonly<Record<string, ArgValue>> };
  }[];
}

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

/** How one kind of argument is asked about and read back. */
interface ArgKind<S extends ArgSpec> {
  ask(fn: string, arg: string, spec: S): [string, Question][];
  read(fn: string, arg: string, spec: S, answers: CallAnswers): ArgReading;
}

const KINDS: { readonly [K in ArgSpec['kind']]: ArgKind<Extract<ArgSpec, { kind: K }>> } = {
  choice: {
    ask: (fn, arg, spec) => [[argKey(fn, arg), choice(spec.question, spec.options)]],
    read: (fn, arg, _spec, answers) => {
      const { option, p } = answers.picked(argKey(fn, arg));
      return { value: option, p };
    },
  },
  flag: {
    ask: (fn, arg, spec) => [[argKey(fn, arg), noul(spec.question)]],
    read: (fn, arg, _spec, answers) => {
      const p = answers.yes(argKey(fn, arg));
      return { value: leansYes(p), p: likelierSide(p) };
    },
  },
  set: {
    ask: (fn, arg, spec) => spec.members.map((member, index) => [memberKey(fn, arg, index), noul(spec.question.replaceAll('{}', member))]),
    read: (fn, arg, spec, answers) => {
      const members = spec.members.map((member, index) => ({ member, p: answers.yes(memberKey(fn, arg, index)) }));
      return { value: members.filter(({ p }) => leansYes(p)).map(({ member }) => member), p: Math.min(...members.map(({ p }) => likelierSide(p))) };
    },
  },
};

const kindOf = (spec: ArgSpec): ArgKind<ArgSpec> => KINDS[spec.kind] as ArgKind<ArgSpec>;

function argQuestions(fn: string, arg: string, spec: ArgSpec): [string, Question][] {
  const stated: [string, Question][] = spec.stated === undefined ? [] : [[statedKey(fn, arg), noul(spec.stated)]];
  return [...stated, ...kindOf(spec).ask(fn, arg, spec)];
}

function readArg(fn: string, arg: string, spec: ArgSpec, answers: CallAnswers): ArgReading {
  const stated = spec.stated === undefined ? 1 : answers.yes(statedKey(fn, arg));
  if (!leansYes(stated)) return { value: undefined, p: 1 - stated };
  const reading = kindOf(spec).read(fn, arg, spec, answers);
  return { value: reading.value, p: Math.min(stated, reading.p) };
}

interface NamedReading extends ArgReading {
  readonly arg: string;
}

/** The arguments that have a value, by name. */
function statedArgs(readings: readonly { readonly arg: string; readonly value: ArgValue | undefined }[]): Record<string, ArgValue> {
  return Object.fromEntries(readings.flatMap(({ arg, value }) => (value === undefined ? [] : [[arg, value]])));
}

function fill(spec: CallerSpec, answers: CallAnswers): FilledCall {
  const { option: fn, p: fnP } = answers.picked(ROUTE);
  const readings = Object.entries(spec.functions[fn]!.args).map(([arg, argSpec]): NamedReading => ({ arg, ...readArg(fn, arg, argSpec, answers) }));
  const weakest = readings.reduce((low, reading) => (reading.p < low.p ? reading : low), { arg: 'function', value: undefined, p: fnP } as NamedReading);
  const args = statedArgs(readings);
  const omitted = readings.map(({ arg }) => arg).filter((arg) => !(arg in args));
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
        const shown = statedArgs(Object.keys(expectedArgs).map((arg) => ({ arg, value: got.args[arg] })));
        return fixtureCheck(fixture.name, 'call', describeCall(fixture.expect.fn, expectedArgs), describeCall(got.fn, shown), got.confidence, got.outcome);
      }),
  };
  return caller;
}

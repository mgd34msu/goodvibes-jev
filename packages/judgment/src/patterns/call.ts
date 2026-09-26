import { checkEachFixture, decisionHeader, fixtureCheck, type FixtureCheck, type NamedDecision } from '../batteries/decision.ts';
import { choice, noul, type ChoiceResponse, type EntryType, type JudgmentPort, type JudgmentResult, type NoulResponse, type Question, type Questions } from '../port/types.ts';
import { assertBand, outcomeForConfidence, type ConfidenceBand, type Outcome } from '../readings/bands.ts';
import { leansYes, likelierSide } from '../readings/readings.ts';
import { askAs, recordReadings, type CallOptions, type PatternHeader } from '../batteries/asking.ts';

/** What every argument may declare. */
interface ArgBase {
  /** When set, the argument is optional: a yes/no on whether the request says anything about it. */
  readonly stated?: EntryType;
}

/** An argument that takes one value from a fixed list. */
export interface ChoiceArg extends ArgBase {
  readonly kind: 'choice';
  readonly question: EntryType;
  readonly options: Readonly<Record<string, EntryType>>;
}
/** An argument that takes any number of values from a fixed list; `question` contains `{}` for the member. */
export interface SetArg extends ArgBase {
  readonly kind: 'set';
  readonly question: string;
  readonly members: readonly string[];
}
/** An on/off argument. */
export interface FlagArg extends ArgBase {
  readonly kind: 'flag';
  readonly question: EntryType;
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

/** The question names one argument is asked under: its value, each set member, and its was-it-stated check. */
interface ArgKeys {
  readonly value: string;
  member(index: number): string;
  readonly stated: string;
}

function keysFor(fn: string, arg: string): ArgKeys {
  const value = `${fn}.${arg}`;
  return { value, member: (index) => `${value}[${index}]`, stated: `${value}?` };
}

/** The call's answers, by question name. */
type CallAnswers = JudgmentResult<Questions>['answers'];

/** The yes probability of a yes/no question. */
const yesOf = (answers: CallAnswers, question: string): number => (answers[question] as NoulResponse).noul;

/** The chosen option of a choice and the probability behind it. */
function pickedOf(answers: CallAnswers, question: string): { readonly option: string; readonly p: number } {
  const { choice: option, probabilities } = answers[question] as ChoiceResponse;
  return { option, p: probabilities[option]! };
}

/** An argument's value and how strongly its reading backs it; undefined when the request did not state it. */
interface ArgReading {
  readonly value: ArgValue | undefined;
  readonly p: number;
}

/** How one kind of argument is asked about and read back. */
interface ArgKind<S extends ArgSpec> {
  ask(keys: ArgKeys, spec: S): [string, Question][];
  read(keys: ArgKeys, spec: S, answers: CallAnswers): ArgReading;
}

/** A yes/no answer as an argument reading: the likelier side, and how strongly the answer backs it. */
const yesNoReading = (p: number): { readonly value: boolean; readonly p: number } => ({ value: leansYes(p), p: likelierSide(p) });

const KINDS: { readonly [K in ArgSpec['kind']]: ArgKind<Extract<ArgSpec, { kind: K }>> } = {
  choice: {
    ask: (keys, spec) => [[keys.value, choice(spec.question, spec.options)]],
    read: (keys, _spec, answers) => {
      const { option, p } = pickedOf(answers, keys.value);
      return { value: option, p };
    },
  },
  flag: {
    ask: (keys, spec) => [[keys.value, noul(spec.question)]],
    read: (keys, _spec, answers) => yesNoReading(yesOf(answers, keys.value)),
  },
  set: {
    ask: (keys, spec) => spec.members.map((member, index) => [keys.member(index), noul(spec.question.replaceAll('{}', member))]),
    read: (keys, spec, answers) => {
      const members = spec.members.map((member, index) => ({ member, ...yesNoReading(yesOf(answers, keys.member(index))) }));
      return { value: members.filter(({ value }) => value).map(({ member }) => member), p: Math.min(...members.map(({ p }) => p)) };
    },
  },
};

const kindOf = (spec: ArgSpec): ArgKind<ArgSpec> => KINDS[spec.kind] as ArgKind<ArgSpec>;

/** An optional argument's was-it-stated question, asked and read in one place; a required argument has none and is always stated. */
const STATED: ArgKind<ArgSpec> & { read(keys: ArgKeys, spec: ArgSpec, answers: CallAnswers): { readonly value: boolean; readonly p: number } } = {
  ask: (keys, spec) => (spec.stated === undefined ? [] : [[keys.stated, noul(spec.stated)]]),
  read: (keys, spec, answers) => (spec.stated === undefined ? { value: true, p: 1 } : yesNoReading(yesOf(answers, keys.stated))),
};

function argQuestions(fn: string, arg: string, spec: ArgSpec): [string, Question][] {
  const keys = keysFor(fn, arg);
  return [STATED, kindOf(spec)].flatMap((kind) => kind.ask(keys, spec));
}

function readArg(fn: string, arg: string, spec: ArgSpec, answers: CallAnswers): ArgReading {
  const keys = keysFor(fn, arg);
  const stated = STATED.read(keys, spec, answers);
  if (!stated.value) return { value: undefined, p: stated.p };
  const reading = kindOf(spec).read(keys, spec, answers);
  return { value: reading.value, p: Math.min(stated.p, reading.p) };
}

interface NamedReading extends ArgReading {
  readonly arg: string;
}

/** The arguments that have a value, by name. */
function statedArgs(readings: readonly { readonly arg: string; readonly value: ArgValue | undefined }[]): Record<string, ArgValue> {
  return Object.fromEntries(readings.flatMap(({ arg, value }) => (value === undefined ? [] : [[arg, value]])));
}

function fill(spec: CallerSpec, answers: CallAnswers): FilledCall {
  const { option: fn, p: fnP } = pickedOf(answers, ROUTE);
  const readings = Object.entries(spec.functions[fn]!.args).map(([arg, argSpec]): NamedReading => ({ arg, ...readArg(fn, arg, argSpec, answers) }));
  const weakest = readings.reduce((low, reading) => (reading.p < low.p ? reading : low), { arg: 'function', value: undefined, p: fnP } as NamedReading);
  const args = statedArgs(readings);
  const omitted = readings.map(({ arg }) => arg).filter((arg) => !(arg in args));
  return { fn, args, omitted, confidence: weakest.p, weakest: weakest.arg, outcome: outcomeForConfidence(weakest.p, spec.band) };
}

const describeValue = (value: ArgValue): string => (Array.isArray(value) ? `[${[...value].sort().join(',')}]` : String(value));
const describeCall = (fn: string, args: Readonly<Record<string, ArgValue>>): string =>
  `${fn}(${Object.entries(args).map(([arg, value]) => `${arg}=${describeValue(value)}`).join(', ')})`;

/** Every question the one request asks: the function choice, then every function's argument questions. */
function callQuestions(spec: CallerSpec): Record<string, Question> {
  const functions = Object.entries(spec.functions);
  const route = choice(spec.instructions, Object.fromEntries(functions.map(([fn, { description }]) => [fn, description])));
  const args = functions.flatMap(([fn, { args }]) => Object.entries(args).flatMap(([arg, argSpec]) => argQuestions(fn, arg, argSpec)));
  return Object.fromEntries([[ROUTE, route], ...args]);
}

/** Compares the filled call with the fixture's, showing only the arguments the fixture names. */
function callCheck(fixture: CallerSpec['fixtures'][number], got: FilledCall): FixtureCheck {
  const { fn, args = {} } = fixture.expect;
  const shown = statedArgs(Object.keys(args).map((arg) => ({ arg, value: got.args[arg] })));
  return fixtureCheck(fixture.name, 'call', describeCall(fn, args), describeCall(got.fn, shown), got.confidence, got.outcome);
}

export function defineFunctionCaller(spec: CallerSpec): FunctionCaller {
  const header = decisionHeader(spec);
  assertBand(spec.band);
  for (const fixture of spec.fixtures) {
    if (!(fixture.expect.fn in spec.functions)) throw new RangeError(`caller ${spec.name}: fixture ${fixture.name} expects an unknown function`);
  }
  const questions = callQuestions(spec);

  const caller: FunctionCaller = {
    ...header,
    async fill(port, state, options = {}) {
      const result = await askAs(port, spec, 'call', state, questions, options);
      const call = fill(spec, result.answers);
      recordReadings(port, result, call);
      return call;
    },
    checkFixtures: (port, options = {}) =>
      checkEachFixture(spec.fixtures, options, async (fixture, run) => callCheck(fixture, await caller.fill(port, fixture.state, run))),
  };
  return caller;
}

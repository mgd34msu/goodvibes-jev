import { checkEachFixture, decisionHeader, type NamedDecision } from '../batteries/decision.ts';
import { checkReading } from '../batteries/battery.ts';
import { choice, type EntryType, type JsonValue, type JudgmentPort } from '../port/types.ts';
import { assertBand, type ChoiceBand } from '../readings/bands.ts';
import { readChoice, type ChoiceReading } from '../readings/readings.ts';
import { askAs, recordAction, recordReadings, type CallOptions, type PatternHeader } from '../batteries/asking.ts';

/** The readings a reply to a proposal can have, unless a site defines its own. */
export const REPLY_READINGS = {
  approve: 'Agrees to the proposal as stated, without conditions.',
  reject: 'Declines, refuses or vetoes the proposal.',
  amend: 'Agrees only with changes, or asks for something different from what was proposed.',
  unclear: 'Does not say whether they agree: a question, an unrelated message, or an ambiguous answer.',
} as const;

export type ReplyReadingName = keyof typeof REPLY_READINGS;

/**
 * Reply reading: what a person's free-text reply says about a proposal put to
 * them (an approval request, a proposed action, a veto window). The reply is
 * read against the proposal it answers; who may answer, and whether the
 * answer is in time, stay deterministic checks in the caller.
 */
export interface ReplySpec<R extends string> extends PatternHeader {
  /** The possible readings; defaults to approve, reject, amend, unclear. */
  readonly readings?: Readonly<Record<R, EntryType>>;
  /** Stricter bands on readings that trigger effects, typically approve. */
  readonly band: ChoiceBand<NoInfer<R>>;
  readonly fixtures: readonly {
    readonly name: string;
    readonly proposal: JsonValue;
    readonly reply: string;
    readonly expect: NoInfer<R>;
  }[];
}

export interface ReadReply<R extends string> {
  readonly reading: ChoiceReading<R>;
  readonly decisionId: string | undefined;
  recordAction(action: string): void;
}

export interface ReplyReader<R extends string> extends NamedDecision {
  read(port: JudgmentPort, proposal: JsonValue, reply: string, options?: CallOptions): Promise<ReadReply<R>>;
}

export function defineReplyReader<const R extends string = ReplyReadingName>(spec: ReplySpec<R>): ReplyReader<R> {
  const header = decisionHeader(spec);
  assertBand(spec.band);
  const readings = (spec.readings ?? REPLY_READINGS) as Readonly<Record<string, EntryType>>;
  for (const fixture of spec.fixtures) {
    if (!(fixture.expect in readings)) {
      throw new RangeError(`reply ${spec.name}: fixture ${fixture.name} expects unknown reading "${fixture.expect}"`);
    }
  }
  const question = choice('What does `reply` say about `proposal`?', readings);

  const reader: ReplyReader<R> = {
    ...header,
    async read(port, proposal, reply, options = {}) {
      const result = await askAs(port, spec, 'reply', { proposal, reply }, { reading: question }, options);
      const reading = readChoice(result.answers.reading, spec.band as ChoiceBand) as ChoiceReading<R>;
      recordReadings(port, result, { reading });
      return { reading, decisionId: result.decisionId, recordAction: (action) => recordAction(port, result.decisionId, action) };
    },
    checkFixtures: (port, options = {}) =>
      checkEachFixture(spec.fixtures, options, async (fixture, run) => {
        const { reading } = await reader.read(port, fixture.proposal, fixture.reply, run);
        return checkReading(fixture.name, 'reading', fixture.expect, reading);
      }),
  };
  return reader;
}

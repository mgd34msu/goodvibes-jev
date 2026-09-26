import { checkEachFixture, decisionHeader, fixtureCheck, NONE, type DecisionIdentity, type FixtureCheck, type NamedDecision } from '../batteries/decision.ts';
import { choice, noul, type EntryType, type JsonValue, type JudgmentPort, type Question } from '../port/types.ts';
import { LIMITS } from '../port/limits.ts';
import { assertBand, type ConfidenceBand, type Outcome, type YesNoBand } from '../readings/bands.ts';
import { askAs, recordReadings, type CallOptions, type PatternHeader } from '../batteries/asking.ts';
import { runSelection, type Selection } from '../patterns/select.ts';

/**
 * Rank-then-recheck (the skill suggestion cookbook): a cheap wide pass ranks
 * every option on a one-line description and, in the same request, asks
 * whether the case needs any option at all; a second request rechecks only
 * the top few with their full detail and may reject all of them. Either pass
 * can come back empty-handed.
 */
export interface RankRecheckSpec extends PatternHeader {
  /** The wide question over all options. */
  readonly instructions: EntryType;
  /** Yes/no questions on whether the case needs an option at all; their mean gates the recheck. */
  readonly gates: Readonly<Record<string, { readonly instructions: EntryType; readonly inverted?: boolean }>>;
  /** Mean oriented gate probability below which nothing is suggested. */
  readonly gateThreshold: number;
  /** How many top options the recheck reads in detail. */
  readonly shortlist: number;
  /** The recheck question over the shortlist. */
  readonly recheckInstructions: EntryType;
  /** Whether one shortlisted option does what the case needs. */
  readonly fitInstructions: EntryType;
  readonly recheckBand: ConfidenceBand;
  readonly fitBand: YesNoBand;
  readonly fixtures: readonly {
    readonly name: string;
    readonly state: EntryType;
    readonly options: readonly RankOption[];
    readonly expect: string;
  }[];
}

export interface RankOption {
  readonly id: string;
  /** One line, as an index shows it. */
  readonly summary: EntryType;
  /** The full description the recheck reads. */
  readonly detail: JsonValue;
}

export interface RankRecheckResult {
  readonly chosen: string | undefined;
  readonly outcome: Outcome;
  /** Mean oriented gate probability. */
  readonly gate: number;
  readonly shortlist: readonly { readonly id: string; readonly probability: number }[];
  /** Absent when the gate stopped the case before the recheck. */
  readonly recheck: Selection | undefined;
}

export interface RankRecheck extends NamedDecision {
  suggest(port: JudgmentPort, state: EntryType, options: readonly RankOption[], call?: CallOptions): Promise<RankRecheckResult>;
}

type WideAnswers = Readonly<Record<string, { readonly noul?: number; readonly probabilities?: Readonly<Record<string, number>> }>>;

function validateRankRecheckSpec(spec: RankRecheckSpec): DecisionIdentity {
  const header = decisionHeader(spec);
  if (Object.keys(spec.gates).length === 0) throw new RangeError(`rank-recheck ${spec.name}: needs at least one gate question`);
  const thresholdInUnit = spec.gateThreshold >= 0 && spec.gateThreshold <= 1;
  if (!thresholdInUnit) throw new RangeError(`rank-recheck ${spec.name}: gateThreshold must be in [0, 1]`);
  const positiveShortlist = Number.isInteger(spec.shortlist) && spec.shortlist >= 1;
  if (!positiveShortlist) throw new RangeError(`rank-recheck ${spec.name}: shortlist must be a positive integer`);
  assertBand(spec.recheckBand);
  assertBand(spec.fitBand);
  return header;
}

function wideQuestions(spec: RankRecheckSpec, options: readonly RankOption[]): Record<string, Question> {
  const questions: Record<string, Question> = { which: choice(spec.instructions, Object.fromEntries(options.map((option) => [option.id, option.summary]))) };
  for (const [gate, { instructions }] of Object.entries(spec.gates)) questions[`gate_${gate}`] = noul(instructions);
  return questions;
}

/** The mean gate probability, each gate turned so that higher means an option is needed. */
function gateMean(spec: RankRecheckSpec, answers: WideAnswers): number {
  const oriented = Object.entries(spec.gates).map(([gate, { inverted }]) => {
    const p = answers[`gate_${gate}`]!.noul!;
    return inverted === true ? 1 - p : p;
  });
  return oriented.reduce((sum, p) => sum + p, 0) / oriented.length;
}

function shortlistOf(spec: RankRecheckSpec, options: readonly RankOption[], answers: WideAnswers): { id: string; probability: number }[] {
  const probabilities = answers['which']!.probabilities!;
  return options
    .map((option) => ({ id: option.id, probability: probabilities[option.id] ?? 0 }))
    .sort((a, b) => b.probability - a.probability)
    .slice(0, spec.shortlist);
}

function chosenCheck(fixture: RankRecheckSpec['fixtures'][number], got: RankRecheckResult): FixtureCheck {
  const signal = got.recheck === undefined ? 1 - got.gate : got.recheck.pick.confidence;
  return fixtureCheck(fixture.name, 'chosen', fixture.expect, got.chosen ?? NONE, signal, got.outcome);
}

export function defineRankRecheck(spec: RankRecheckSpec): RankRecheck {
  const header = validateRankRecheckSpec(spec);
  const recheck = { instructions: spec.recheckInstructions, fitInstructions: spec.fitInstructions, band: spec.recheckBand, fitBand: spec.fitBand };

  const compound: RankRecheck = {
    ...header,
    async suggest(port, state, options, call = {}) {
      const optionCountOk = options.length >= 2 && options.length <= LIMITS.maxChoiceOptions;
      if (!optionCountOk) throw new RangeError(`rank-recheck ${spec.name}: needs 2 to ${LIMITS.maxChoiceOptions} options; split larger sets into chunks`);
      const wide = await askAs(port, spec, 'rank-recheck.wide', state, wideQuestions(spec, options), call);
      const answers = wide.answers as WideAnswers;
      const gate = gateMean(spec, answers);
      const shortlist = shortlistOf(spec, options, answers);
      recordReadings(port, wide, { gate, shortlist });
      if (gate < spec.gateThreshold) return { chosen: undefined, outcome: 'act', gate, shortlist, recheck: undefined };
      const byId = new Map(options.map((option) => [option.id, option]));
      const candidates = shortlist.map(({ id }) => ({ id, content: byId.get(id)!.detail }));
      const selection = await runSelection(port, { header: spec, pattern: 'rank-recheck.recheck', config: recheck, context: state, candidates, options: call });
      return { chosen: selection.chosen, outcome: selection.outcome, gate, shortlist, recheck: selection };
    },
    checkFixtures: (port, options = {}) =>
      checkEachFixture(spec.fixtures, options, async (fixture, run) => chosenCheck(fixture, await compound.suggest(port, fixture.state, fixture.options, run))),
  };
  return compound;
}

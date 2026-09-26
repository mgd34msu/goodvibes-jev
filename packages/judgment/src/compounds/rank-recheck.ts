import { assertDecisionHeader, assertUniqueFixtures, type FixtureCheck, type NamedDecision } from '../batteries/decision.ts';
import { choice, noul, type EntryType, type JsonValue, type JudgmentPort, type NoulQuestion } from '../port/types.ts';
import { LIMITS } from '../port/limits.ts';
import { assertConfidenceBand, assertYesNoBand, type ConfidenceBand, type Outcome, type YesNoBand } from '../readings/bands.ts';
import { askAs, recordReadings, type CallOptions, type PatternHeader } from '../patterns/common.ts';
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

export function defineRankRecheck(spec: RankRecheckSpec): RankRecheck {
  assertDecisionHeader({ ...spec, fixtureCount: spec.fixtures.length });
  assertUniqueFixtures(spec.name, spec.fixtures);
  if (Object.keys(spec.gates).length === 0) throw new RangeError(`rank-recheck ${spec.name}: needs at least one gate question`);
  if (!(spec.gateThreshold >= 0 && spec.gateThreshold <= 1)) throw new RangeError(`rank-recheck ${spec.name}: gateThreshold must be in [0, 1]`);
  if (!(Number.isInteger(spec.shortlist) && spec.shortlist >= 1)) throw new RangeError(`rank-recheck ${spec.name}: shortlist must be a positive integer`);
  assertConfidenceBand(spec.recheckBand);
  assertYesNoBand(spec.fitBand);

  const recheck = {
    instructions: spec.recheckInstructions,
    fitInstructions: spec.fitInstructions,
    band: spec.recheckBand,
    fitBand: spec.fitBand,
  };

  const compound: RankRecheck = {
    name: spec.name,
    version: spec.version,
    description: spec.description,
    accuracyFloor: spec.accuracyFloor,
    ...(spec.model === undefined ? {} : { model: spec.model }),
    fixtureCount: spec.fixtures.length,
    async suggest(port, state, options, call = {}) {
      if (options.length < 2 || options.length > LIMITS.maxChoiceOptions) {
        throw new RangeError(`rank-recheck ${spec.name}: needs 2 to ${LIMITS.maxChoiceOptions} options; split larger sets into chunks`);
      }
      const questions: Record<string, NoulQuestion | ReturnType<typeof choice>> = {
        which: choice(spec.instructions, Object.fromEntries(options.map((option) => [option.id, option.summary]))),
      };
      for (const [gate, { instructions }] of Object.entries(spec.gates)) questions[`gate_${gate}`] = noul(instructions);
      const wide = await askAs(port, spec, 'rank-recheck.wide', state, questions, call);
      const answers = wide.answers as Record<string, unknown>;
      const oriented = Object.entries(spec.gates).map(([gate, { inverted }]) => {
        const p = (answers[`gate_${gate}`] as { noul: number }).noul;
        return inverted === true ? 1 - p : p;
      });
      const gate = oriented.reduce((sum, p) => sum + p, 0) / oriented.length;
      const probabilities = (answers['which'] as { probabilities: Record<string, number> }).probabilities;
      const shortlist = options
        .map((option) => ({ id: option.id, probability: probabilities[option.id] ?? 0 }))
        .sort((a, b) => b.probability - a.probability)
        .slice(0, spec.shortlist);
      recordReadings(port, wide, { gate, shortlist });
      if (gate < spec.gateThreshold) {
        return { chosen: undefined, outcome: 'act', gate, shortlist, recheck: undefined };
      }
      const byId = new Map(options.map((option) => [option.id, option]));
      const selection = await runSelection(
        port,
        spec,
        'rank-recheck.recheck',
        recheck,
        state,
        shortlist.map(({ id }) => ({ id, content: byId.get(id)!.detail })),
        call,
      );
      return { chosen: selection.chosen, outcome: selection.outcome, gate, shortlist, recheck: selection };
    },
    async checkFixtures(port, options = {}) {
      const checks: FixtureCheck[] = [];
      for (const fixture of spec.fixtures) {
        const got = await compound.suggest(port, fixture.state, fixture.options, { site: 'calibration', ...options });
        const gotId = got.chosen ?? 'none';
        checks.push({
          fixture: fixture.name,
          aspect: 'chosen',
          expected: fixture.expect,
          got: gotId,
          correct: gotId === fixture.expect,
          signal: got.recheck?.pick.confidence ?? 1 - got.gate,
          outcome: got.outcome,
        });
      }
      return checks;
    },
  };
  return compound;
}

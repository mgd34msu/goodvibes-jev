import { assertDecisionHeader, assertUniqueFixtures, type FixtureCheck, type NamedDecision } from '../batteries/decision.ts';
import { choice, noul, type EntryType, type JsonValue, type JudgmentPort, type NoulQuestion } from '../port/types.ts';
import { LIMITS } from '../port/limits.ts';
import { assertConfidenceBand, assertYesNoBand, type ConfidenceBand, type Outcome, type YesNoBand } from '../readings/bands.ts';
import { readChoice, readYesNo, type ChoiceReading, type YesNoReading } from '../readings/readings.ts';
import type { Candidate } from './rerank.ts';
import { askAs, recordAction, recordReadings, type CallOptions, type PatternHeader } from './common.ts';

export const NONE = 'none';

/**
 * Candidate selection: pick one of candidates code supplied, or none. One
 * Choice over the candidate ids plus a "none" option settles which; one Noul
 * per candidate settles whether it actually does what is needed. A Choice is
 * relative and always has a winner, so the winner stands only when its own
 * Noul is a yes (the skill-suggestion cookbook's two-question shape). Used
 * for best-of-N answers, picking a span a regex found, and similar picks.
 */
export interface SelectSpec extends PatternHeader {
  /** What the pick is for; refer to `context` and `candidates` (each has an `id`). */
  readonly instructions: EntryType;
  /** What makes one candidate acceptable on its own; the candidate it asks about is named beside it. */
  readonly fitInstructions: EntryType;
  readonly band: ConfidenceBand;
  readonly fitBand: YesNoBand;
  readonly fixtures: readonly {
    readonly name: string;
    readonly context: JsonValue;
    readonly candidates: readonly Candidate[];
    readonly expect: string;
  }[];
}

export interface Selection {
  /** The chosen candidate id, or undefined when none fits. */
  readonly chosen: string | undefined;
  readonly outcome: Outcome;
  readonly pick: ChoiceReading;
  readonly fits: Readonly<Record<string, YesNoReading>>;
  readonly decisionId: string | undefined;
  recordAction(action: string): void;
}

export interface Selector extends NamedDecision {
  select(port: JudgmentPort, context: JsonValue, candidates: readonly Candidate[], options?: CallOptions): Promise<Selection>;
}

const MAX_CANDIDATES = LIMITS.maxChoiceOptions - 1;

export function defineSelector(spec: SelectSpec): Selector {
  assertDecisionHeader({ ...spec, fixtureCount: spec.fixtures.length });
  assertUniqueFixtures(spec.name, spec.fixtures);
  assertConfidenceBand(spec.band);
  assertYesNoBand(spec.fitBand);
  for (const fixture of spec.fixtures) {
    if (fixture.expect !== NONE && !fixture.candidates.some((candidate) => candidate.id === fixture.expect)) {
      throw new RangeError(`selector ${spec.name}: fixture ${fixture.name} expects unknown candidate "${fixture.expect}"`);
    }
  }

  const selector: Selector = {
    name: spec.name,
    version: spec.version,
    description: spec.description,
    accuracyFloor: spec.accuracyFloor,
    ...(spec.model === undefined ? {} : { model: spec.model }),
    fixtureCount: spec.fixtures.length,
    async select(port, context, candidates, options = {}) {
      if (candidates.length < 1 || candidates.length > MAX_CANDIDATES) {
        throw new RangeError(`selector ${spec.name}: needs 1 to ${MAX_CANDIDATES} candidates, got ${candidates.length}`);
      }
      const ids = candidates.map((candidate) => candidate.id);
      if (new Set(ids).size !== ids.length || ids.includes(NONE)) {
        throw new RangeError(`selector ${spec.name}: candidate ids must be unique and not "${NONE}"`);
      }
      const options_: Record<string, EntryType> = Object.fromEntries(ids.map((id) => [id, null]));
      options_[NONE] = 'None of the candidates does what is needed.';
      const questions: Record<string, NoulQuestion | ReturnType<typeof choice>> = {
        pick: choice(spec.instructions, options_),
      };
      ids.forEach((id, index) => {
        questions[`fits_${index}`] = noul({
          question: spec.fitInstructions,
          candidate: `\`candidates[${index}]\` (id ${JSON.stringify(id)})`,
        });
      });
      const state = { context, candidates: candidates.map((candidate) => ({ id: candidate.id, content: candidate.content })) };
      const result = await askAs(port, spec, 'select', state, questions, options);
      const answers = result.answers as Record<string, unknown>;
      const pick = readChoice(answers['pick'] as Parameters<typeof readChoice>[0], spec.band);
      const fits = Object.fromEntries(
        ids.map((id, index) => [id, readYesNo(answers[`fits_${index}`] as Parameters<typeof readYesNo>[0], spec.fitBand)]),
      );
      const winnerFits = pick.choice !== NONE && fits[pick.choice]?.verdict === 'yes';
      const chosen = winnerFits ? pick.choice : undefined;
      const outcome: Outcome = winnerFits
        ? pick.outcome === 'act' && fits[pick.choice]!.outcome === 'act'
          ? 'act'
          : pick.outcome === 'escalate'
            ? 'escalate'
            : 'confirm'
        : pick.choice === NONE
          ? pick.outcome
          : 'escalate';
      recordReadings(port, result, { chosen: chosen ?? null, pick, fits });
      return { chosen, outcome, pick, fits, decisionId: result.decisionId, recordAction: (a) => recordAction(port, result.decisionId, a) };
    },
    async checkFixtures(port, options = {}) {
      const checks: FixtureCheck[] = [];
      for (const fixture of spec.fixtures) {
        const got = await selector.select(port, fixture.context, fixture.candidates, { site: 'calibration', ...options });
        const gotId = got.chosen ?? NONE;
        checks.push({
          fixture: fixture.name,
          aspect: 'chosen',
          expected: fixture.expect,
          got: gotId,
          correct: gotId === fixture.expect,
          signal: got.pick.confidence,
          outcome: got.outcome,
        });
      }
      return checks;
    },
  };
  return selector;
}

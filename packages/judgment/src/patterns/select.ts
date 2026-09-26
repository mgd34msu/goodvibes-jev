import { checkEachFixture, decisionHeader, fixtureCheck, NONE, type NamedDecision } from '../batteries/decision.ts';
import { askAs, recordAction, recordReadings, type CallOptions, type PatternHeader, type PatternName } from '../batteries/asking.ts';
import { choice, noul, type EntryType, type JsonValue, type JudgmentPort, type Question } from '../port/types.ts';
import { LIMITS } from '../port/limits.ts';
import { assertConfidenceBand, assertYesNoBand, type ConfidenceBand, type Outcome, type YesNoBand } from '../readings/bands.ts';
import { readChoice, readYesNo, type ChoiceReading, type YesNoReading } from '../readings/readings.ts';
import type { Candidate } from './rerank.ts';

export { NONE };

const MAX_CANDIDATES = LIMITS.maxChoiceOptions - 1;

/** The selection settings a selector or a compound's recheck pass needs. */
export interface SelectionConfig {
  /** What the pick is for; refer to `context` and `candidates` (each has an `id`). */
  readonly instructions: EntryType;
  /** What makes one candidate acceptable on its own; the candidate it asks about is named beside it. */
  readonly fitInstructions: EntryType;
  readonly band: ConfidenceBand;
  readonly fitBand: YesNoBand;
}

/**
 * Candidate selection: pick one of candidates code supplied, or none. One
 * Choice over the candidate ids plus a "none" option settles which; one Noul
 * per candidate settles whether it actually does what is needed. A Choice is
 * relative and always has a winner, so the winner stands only when its own
 * Noul is a yes (the skill-suggestion cookbook's two-question shape). Used
 * for best-of-N answers, picking a span a regex found, and similar picks.
 */
export interface SelectSpec extends PatternHeader, SelectionConfig {
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

/** One selection request: who asks, with what settings, over which candidates. */
export interface SelectionRequest {
  readonly header: PatternHeader;
  readonly pattern: PatternName;
  readonly config: SelectionConfig;
  readonly context: JsonValue;
  readonly candidates: readonly Candidate[];
  readonly options?: CallOptions;
}

const withinCandidateLimit = (count: number): boolean => count >= 1 && count <= MAX_CANDIDATES;
const allDistinct = (ids: readonly string[]): boolean => new Set(ids).size === ids.length;
const avoidsNone = (ids: readonly string[]): boolean => !ids.includes(NONE);
/** Candidate ids a selection can offer as options: distinct, and never the "none" option's name. */
const usableIds = (ids: readonly string[]): boolean => allDistinct(ids) && avoidsNone(ids);

function assertCandidates(decision: string, ids: readonly string[]): void {
  if (!withinCandidateLimit(ids.length)) throw new RangeError(`selector ${decision}: needs 1 to ${MAX_CANDIDATES} candidates, got ${ids.length}`);
  if (!usableIds(ids)) throw new RangeError(`selector ${decision}: candidate ids must be unique and not "${NONE}"`);
}

function selectionQuestions(config: SelectionConfig, ids: readonly string[]): Record<string, Question> {
  const options: Record<string, EntryType> = { ...Object.fromEntries(ids.map((id) => [id, null])), [NONE]: 'None of the candidates does what is needed.' };
  const questions: Record<string, Question> = { pick: choice(config.instructions, options) };
  ids.forEach((id, index) => {
    questions[`fits_${index}`] = noul({ question: config.fitInstructions, candidate: `\`candidates[${index}]\` (id ${JSON.stringify(id)})` });
  });
  return questions;
}

/**
 * What code may do with a selection. A winner that also reads as fitting acts
 * only when both readings act; a winner that does not fit escalates; a
 * confident "none" is itself an answer to act on.
 */
export function selectionOutcome(pick: ChoiceReading, winnerFit: YesNoReading | undefined): Outcome {
  if (pick.choice === NONE) return pick.outcome;
  if (winnerFit?.verdict !== 'yes') return 'escalate';
  if (pick.outcome === 'escalate') return 'escalate';
  const bothAct = pick.outcome === 'act' && winnerFit.outcome === 'act';
  return bothAct ? 'act' : 'confirm';
}

/** One selection request, shared by selectors and by compounds that recheck a shortlist. */
export async function runSelection(port: JudgmentPort, request: SelectionRequest): Promise<Selection> {
  const { header, config, candidates } = request;
  const ids = candidates.map((candidate) => candidate.id);
  assertCandidates(header.name, ids);
  const state = { context: request.context, candidates: candidates.map(({ id, content }) => ({ id, content })) };
  const result = await askAs(port, header, request.pattern, state, selectionQuestions(config, ids), request.options);
  const answers = result.answers as Record<string, unknown>;
  const pick = readChoice(answers['pick'] as Parameters<typeof readChoice>[0], config.band);
  const fits = Object.fromEntries(ids.map((id, index) => [id, readYesNo(answers[`fits_${index}`] as Parameters<typeof readYesNo>[0], config.fitBand)]));
  const winnerFit = fits[pick.choice];
  const outcome = selectionOutcome(pick, winnerFit);
  // A fitting winner is reported even when escalated, so a reviewer sees what was picked.
  const chosen = winnerFit?.verdict === 'yes' ? pick.choice : undefined;
  recordReadings(port, result, { chosen: chosen ?? null, pick, fits });
  return { chosen, outcome, pick, fits, decisionId: result.decisionId, recordAction: (action) => recordAction(port, result.decisionId, action) };
}

/** Whether a fixture expects "none" or one of the candidates it offers. */
const expectsOffered = (fixture: SelectSpec['fixtures'][number]): boolean =>
  fixture.expect === NONE || fixture.candidates.some((candidate) => candidate.id === fixture.expect);

export function defineSelector(spec: SelectSpec): Selector {
  const header = decisionHeader(spec);
  assertConfidenceBand(spec.band);
  assertYesNoBand(spec.fitBand);
  for (const fixture of spec.fixtures) {
    if (!expectsOffered(fixture)) throw new RangeError(`selector ${spec.name}: fixture ${fixture.name} expects unknown candidate "${fixture.expect}"`);
  }

  const selector: Selector = {
    ...header,
    select: (port, context, candidates, options = {}) =>
      runSelection(port, { header: spec, pattern: 'select', config: spec, context, candidates, options }),
    checkFixtures: (port, options = {}) =>
      checkEachFixture(spec.fixtures, options, async (fixture, run) => {
        const got = await selector.select(port, fixture.context, fixture.candidates, run);
        return fixtureCheck(fixture.name, 'chosen', fixture.expect, got.chosen ?? NONE, got.pick.confidence, got.outcome);
      }),
  };
  return selector;
}

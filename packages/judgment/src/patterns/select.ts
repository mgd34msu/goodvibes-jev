import { checkEachFixture, decisionHeader, fixtureCheck, NONE, type NamedDecision } from '../batteries/decision.ts';
import { askAs, recordAction, recordReadings, type CallOptions, type PatternHeader, type PatternName } from '../batteries/asking.ts';
import { choice, noul, type EntryType, type JsonValue, type JudgmentPort, type JudgmentResult, type Question } from '../port/types.ts';
import { estimateTokens, LIMITS } from '../port/limits.ts';
import { JudgmentContextLimitError } from '../port/errors.ts';
import { assertBand, type ConfidenceBand, type Outcome, type YesNoBand } from '../readings/bands.ts';
import { readChoice, readYesNo, type ChoiceReading, type YesNoReading } from '../readings/readings.ts';
import type { Candidate } from './rerank.ts';
import { mapLimit } from './common.ts';

export { NONE };

const MAX_CANDIDATES = LIMITS.maxChoiceOptions - 1;
const FIT_REFERENCE = 'Apply the complete selectionFitInstructions in state to this exact candidate.';

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

const withinCandidateLimit = (count: number): boolean => count >= 1;
const allDistinct = (ids: readonly string[]): boolean => new Set(ids).size === ids.length;
const avoidsNone = (ids: readonly string[]): boolean => !ids.includes(NONE);
/** Candidate ids a selection can offer as options: distinct, and never the "none" option's name. */
const usableIds = (ids: readonly string[]): boolean => allDistinct(ids) && avoidsNone(ids);

function assertCandidates(decision: string, ids: readonly string[]): void {
  if (!withinCandidateLimit(ids.length)) throw new RangeError(`selector ${decision}: needs at least one candidate, got ${ids.length}`);
  if (!usableIds(ids)) throw new RangeError(`selector ${decision}: candidate ids must be unique and not "${NONE}"`);
}

function selectionQuestions(config: SelectionConfig, ids: readonly string[]): Record<string, Question> {
  const options: Record<string, EntryType> = { ...Object.fromEntries(ids.map((id) => [id, null])), [NONE]: 'None of the candidates does what is needed.' };
  const questions: Record<string, Question> = { pick: choice(config.instructions, options) };
  ids.forEach((id, index) => {
    questions[`fits_${index}`] = noul({ question: FIT_REFERENCE, candidate: `\`candidates[${index}]\` (id ${JSON.stringify(id)})` });
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
  return selectCandidates(port, request, true);
}

async function selectCandidates(port: JudgmentPort, request: SelectionRequest, parallel: boolean): Promise<Selection> {
  const { header, config, candidates } = request;
  const ids = candidates.map((candidate) => candidate.id);
  assertCandidates(header.name, ids);
  // Candidate fit questions also consume context. Keep all evidence and all
  // candidates, partitioning by both provider limits rather than choice count alone.
  const groups: Candidate[][] = [];
  const baseTokens = estimateTokens({ context: request.context, candidates: [], selectionFitInstructions: config.fitInstructions }) + estimateTokens(selectionQuestions(config, []));
  let group: Candidate[] = [], tokens = baseTokens;
  for (const candidate of candidates) {
    const added = estimateTokens(candidate) + estimateTokens({ [candidate.id]: null })
      + estimateTokens(noul({ question: FIT_REFERENCE, candidate: `\`candidates[${MAX_CANDIDATES}]\` (id ${JSON.stringify(candidate.id)})` })) + 4;
    if (group.length && (group.length >= MAX_CANDIDATES || tokens + added > LIMITS.maxLongContextTokens)) {
      groups.push(group); group = []; tokens = baseTokens;
    }
    group.push(candidate); tokens += added;
  }
  if (group.length) groups.push(group);
  if (groups.length > 1) return selectGroups(port, request, groups, parallel);
  return askSelection(port, request, true, parallel);
}

async function selectGroups(port: JudgmentPort, request: SelectionRequest, groups: readonly (readonly Candidate[])[], parallel: boolean): Promise<Selection> {
  const { candidates } = request;
  const abort = new AbortController();
  const signal = request.options?.signal ? AbortSignal.any([request.options.signal, abort.signal]) : abort.signal;
  let failed = false, failure: unknown;
  // Only the outer partition runs in parallel. Recursive overflow splits stay
  // serial within each worker, so nested tournaments cannot multiply concurrency.
  const completed = await mapLimit(groups, parallel ? 4 : 1, async group => {
    try {
      signal.throwIfAborted();
      return await selectCandidates(port, { ...request, candidates: group, options: { ...request.options, signal } }, false);
    } catch (error) {
      if (!failed) { failed = true; failure = error; abort.abort(error); }
      return undefined;
    }
  });
  // Drain every borrowed call before reporting failure. No partial tournament
  // result can become a selection while sibling requests are still running.
  if (failed) throw failure;
  const rounds = completed as Selection[];
  const winners = groups.flatMap((group, index) => {
    const winner = group.find(candidate => candidate.id === rounds[index]!.pick.choice);
    return winner ? [winner] : [];
  });
  // When the shared evidence leaves room for only one candidate, estimates
  // cannot reduce this further. Let the endpoint tokenize the final comparison
  // once, rather than recursively repeating an unchanged tournament forever.
  const final = winners.length ? await (winners.length < candidates.length
    ? selectCandidates(port, { ...request, candidates: winners }, parallel)
    : askSelection(port, { ...request, candidates: winners }, false, parallel)) : rounds.at(-1)!;
  // Every group participates in elimination; unresolved evidence cannot be
  // upgraded by the final comparison between its surviving candidates.
  const unresolved = rounds.filter(round => round.outcome !== 'act');
  const outcome = [final, ...unresolved].some(round => round.outcome === 'escalate') ? 'escalate'
    : [final, ...unresolved].some(round => round.outcome === 'confirm') ? 'confirm' : 'act';
  return { ...final, outcome, fits: Object.assign({}, ...rounds.map(round => round.fits), final.fits),
    recordAction(action) { for (const round of rounds) round.recordAction(action); if (winners.length) final.recordAction(action); } };
}

async function askSelection(port: JudgmentPort, request: SelectionRequest, partitionOnOverflow = true, parallel = true): Promise<Selection> {
  const { header, config, candidates } = request;
  const ids = candidates.map(candidate => candidate.id);
  const state = { context: request.context, candidates: candidates.map(({ id, content }) => ({ id, content })), selectionFitInstructions: config.fitInstructions };
  let result: JudgmentResult<Record<string, Question>>;
  try { result = await askAs(port, header, request.pattern, state, selectionQuestions(config, ids), request.options); }
  catch (error) {
    // Endpoint tokenization can exceed estimates for dense source and JSON.
    // Retry only this explicit refusal, preserving the full shared evidence and
    // every candidate. A comparison that cannot shrink must fail, not recurse.
    if (!(error instanceof JudgmentContextLimitError) || !partitionOnOverflow || candidates.length < 2) throw error;
    const middle = Math.ceil(candidates.length / 2);
    return selectGroups(port, request, [candidates.slice(0, middle), candidates.slice(middle)], parallel);
  }
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
  assertBand(spec.band);
  assertBand(spec.fitBand);
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

import { knowledgeRawRepresentation, sameKnowledgeRecord } from '../store-record-representation.js';
import { captureJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { toJson, type JsonValue } from '@goodvibes-jev/judgment';
import { assertJudgmentInput, captureOwnedJson, JudgmentInputError } from '../../gate/judgment-input.js';
import { homeGraphPagePriority } from './batteries/page-priority.js';

export class HomeGraphPagePriorityHeldError extends Error {
  constructor(readonly reason: 'unavailable' | 'uncertain' | 'stale' | 'aborted' | 'budget') {
    super(`Home Graph page priority held: ${reason}.`);
  }
}

/** One complete local candidate set. Ranking never filters or changes authority. */
export async function rankHomeGraphPageCandidates<T>(input: {
  readonly candidates: readonly T[];
  readonly content: (candidate: T) => object;
  readonly purpose: string;
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent?: (() => void) | undefined;
}): Promise<readonly T[]> {
  const signal = input.signal, callerCurrent = input.assertCurrent;
  const purpose = input.purpose, offered = input.candidates, project = input.content;
  const rawCandidates = () => captureOwnedJson(knowledgeRawRepresentation(input.candidates));
  const originalCandidates = rawCandidates();
  assertJudgmentInput({ purpose: input.purpose, candidates: rawCandidates() });
  const content = input.candidates.map(candidate => captureOwnedJson(input.content(candidate)));
  assertJudgmentInput(content);
  if (content.length > 500 || JSON.stringify(content).length > 1_000_000) throw new HomeGraphPagePriorityHeldError('budget');
  const original = captureOwnedJson(content);
  const timeout = new AbortController();
  let timedOut = false;
  const check = () => {
    if (signal?.aborted) throw new HomeGraphPagePriorityHeldError('aborted');
    if (timedOut) throw new HomeGraphPagePriorityHeldError('budget');
    callerCurrent?.();
    if (input.signal !== signal || input.assertCurrent !== callerCurrent || input.purpose !== purpose || input.candidates !== offered || input.content !== project
      || !sameKnowledgeRecord(rawCandidates(), originalCandidates)
      || !sameKnowledgeRecord(input.candidates.map(candidate => captureOwnedJson(input.content(candidate))), original)) throw new HomeGraphPagePriorityHeldError('stale');
  };
  check();
  if (!content.length) return [];
  const candidates = content.map((value, index) => {
    if (!value || typeof value !== 'object') throw new JudgmentInputError('unsupported-input');
    return { id: `page-${index + 1}`, content: toJson(value) };
  });
  let authority: ReturnType<typeof captureJudgmentPort>;
  const timer = setTimeout(() => { timedOut = true; timeout.abort(); }, 15_000);
  const boundedSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  try { authority = captureJudgmentPort(homeGraphPagePriority.name, { signal: boundedSignal, assertCurrent: check }); }
  catch (error) {
    clearTimeout(timer); check();
    if (error instanceof JudgmentPortMissingError) throw new HomeGraphPagePriorityHeldError('unavailable');
    throw new HomeGraphPagePriorityHeldError('stale');
  }
  const query: JsonValue = input.purpose;
  try {
    const result = await homeGraphPagePriority.rerank(authority.port, query, candidates, {
      site: homeGraphPagePriority.name, signal: authority.signal, beforeAttempt: authority.assertCurrent,
    });
    check(); authority.assertCurrent();
    if (result.ranked.some(row => row.reading.outcome !== 'act' || row.reading.verdict === 'uncertain')) throw new HomeGraphPagePriorityHeldError('uncertain');
    const byId = new Map(input.candidates.map((candidate, index) => [`page-${index + 1}`, { candidate, index }]));
    return result.ranked.map(row => {
      const original = byId.get(row.id);
      if (!original) throw new HomeGraphPagePriorityHeldError('stale');
      return { ...original, probability: row.probability };
    }).sort((left, right) => right.probability - left.probability || left.index - right.index).map(row => row.candidate);
  } catch (error) {
    check();
    try { authority.assertCurrent(); } catch { throw new HomeGraphPagePriorityHeldError(signal?.aborted ? 'aborted' : 'stale'); }
    if (error instanceof HomeGraphPagePriorityHeldError || error instanceof JudgmentInputError) throw error;
    throw new HomeGraphPagePriorityHeldError('unavailable');
  } finally { clearTimeout(timer); }
}

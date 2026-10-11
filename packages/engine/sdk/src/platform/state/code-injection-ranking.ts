/** Vector recall is a shortlist only. This operation owns fresh canonical relevance readings. */
import { captureJudgmentPort, type JudgmentPortCapture } from '@goodvibes-jev/engine/errors';
import type { ReadAccessFilter } from '../tools/shared/read-access.js';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { captureOwnedJson, assertJudgmentInput } from '../gate/judgment-input.js';
import { codeChunkView, codeSearchRerank } from './batteries/code-search-rerank.js';
import type { CodeContextResult } from './code-index-types.js';

const SITE = 'state.code-injection-relevance';
export interface CodeInjectionAuthorityOptions {
  readonly readAccessFilter?: ReadAccessFilter | undefined;
  readonly signal?: AbortSignal | undefined;
}
export interface CodeInjectionSnapshot { readonly hit: CodeContextResult; readonly code: string }
export interface CodeInjectionRanking {
  readonly ranked: readonly { readonly hit: CodeContextResult; readonly probability: number }[];
  /** Authority must still be current at consumption; readings are never cached across turns. */
  readonly assertCurrent: () => Promise<void>;
}
const held = (reason: string): Error => new Error(`Code injection relevance ${reason}`);
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }

export async function rankCodeInjectionSnapshots(query: string, inputs: readonly CodeInjectionSnapshot[], options: {
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent: () => Promise<void>;
}): Promise<CodeInjectionRanking> {
  // Screen the complete owned source batch, including material beyond clipping limits,
  // before projection, budget checks, port lookup, or any hosted transmission.
  const snapshot = captureOwnedJson({ query, inputs }) as { query: string; inputs: readonly CodeInjectionSnapshot[] };
  // Retrieval hashes, vector distances, and filesystem timestamps are local
  // provenance, never semantic input. Screen every source field that is read,
  // with the complete file text, before chunk extraction or clipping.
  assertJudgmentInput({ query: snapshot.query, sources: snapshot.inputs.map(({ hit, code }) => ({
    path: hit.chunk.path, symbol: hit.chunk.symbol, kind: hit.chunk.kind, lang: hit.chunk.lang,
    startLine: hit.chunk.startLine, endLine: hit.chunk.endLine, code,
  })) });
  if (snapshot.inputs.length > 50 || JSON.stringify(snapshot).length > 750_000) throw held('budget exceeded');
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  let authority: JudgmentPortCapture | undefined;
  let model: string | undefined, resultModel: string | undefined;
  const check = async () => {
    signal.throwIfAborted();
    await options.assertCurrent();
    signal.throwIfAborted();
    authority?.assertCurrent();
  };
  let rejectStopped: (error: unknown) => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
  const abort = () => rejectStopped(held('canceled'));
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(), 15_000);
  const work = async () => {
    await check();
    authority = captureJudgmentPort(SITE, { signal });
    const captured = authority.port; model = captured.model;
    if (typeof model !== 'string' || !model.trim()) throw held('malformed');
    const port: JudgmentPort = { model, ...(captured.recorder ? { recorder: captured.recorder } : {}), async ask(request) {
      await check();
      const result = await captured.ask({ ...request, model: model!, beforeAsyncAttempt: async () => {
        await check(); await request.beforeAsyncAttempt?.(); await check();
      } });
      await check();
      if (!record(result) || !record(result.answers)) throw held('malformed');
      const answer: unknown = result.answers.match;
      if (!record(answer) || answer.type !== 'noul' || typeof answer.noul !== 'number' || !Number.isFinite(answer.noul)
        || answer.noul < 0 || answer.noul > 1 || typeof result.model !== 'string' || !result.model.trim()
        || result.requestedModel !== model || (result.decisionId !== undefined && (typeof result.decisionId !== 'string' || !result.decisionId.trim()))) throw held('malformed');
      if (resultModel !== undefined && resultModel !== result.model) throw held('stale');
      resultModel = result.model;
      return { ...result, answers: { ...result.answers, match: Object.freeze({ type: 'noul' as const, noul: answer.noul }) } };
    } };
    const candidates = snapshot.inputs.map(({ hit, code }, i) => ({ id: String(i), content: codeChunkView(hit.chunk, code.split('\n').slice(hit.chunk.startLine - 1, hit.chunk.endLine).join('\n')) }));
    const result = await codeSearchRerank.rerank(port, snapshot.query, candidates, { site: SITE, signal });
    await check();
    if (result.ranked.some(entry => entry.reading.outcome !== 'act' || entry.reading.verdict === 'uncertain')) throw held('unsettled');
    return { ranked: Object.freeze(result.ranked.filter(entry => entry.reading.verdict === 'yes')
      .map(entry => Object.freeze({ hit: snapshot.inputs[Number(entry.id)]!.hit, probability: entry.probability }))), assertCurrent: check };
  };
  try { return await Promise.race([work(), stopped]); }
  catch (error) { controller.abort(); throw error; }
  finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}

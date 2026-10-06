import { judgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { toJson, type JsonValue, type JudgmentPort } from '@goodvibes-jev/judgment';
import { snapshotJudgmentInput } from '../../../gate/judgment-input.js';
import { freezeSupport } from '../verification/projection.js';
import { answerExcerptSelection } from './battery.js';
import { answerExcerptSpans } from './spans.js';
import { ANSWER_EXCERPT_LIMITS as LIMITS, KnowledgeAnswerExcerptHeldError as Held,
  type AnswerExcerptInput, type AnswerExcerptSelection, type AnswerExcerptCandidate } from './types.js';
export * from './types.js';
export { answerExcerptSpans } from './spans.js';
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function snapshotInputs(inputs: readonly AnswerExcerptInput[]): readonly AnswerExcerptInput[] {
  // Capture once and preflight the complete selected pass before bounds or ports.
  const snapshot = snapshotJudgmentInput(inputs);
  if (!Array.isArray(snapshot)) throw new Held('malformed');
  if (snapshot.length > LIMITS.inputs) throw new Held('budget');
  const references = new Set<string>();
  for (const input of snapshot) {
    if (!record(input) || Object.keys(input).some((key) => !['reference', 'query', 'source', 'context', 'documents'].includes(key))
      || typeof input.reference !== 'string' || !/^source-[1-9]\d*$/.test(input.reference) || references.has(input.reference)
      || typeof input.query !== 'string' || !input.query.trim() || typeof input.context !== 'string'
      || !record(input.source) || Object.keys(input.source).some((key) => !['title', 'sourceType', 'uri'].includes(key))
      || typeof input.source.title !== 'string' || typeof input.source.sourceType !== 'string' || typeof input.source.uri !== 'string'
      || !Array.isArray(input.documents)) throw new Held('malformed');
    references.add(input.reference);
    if (input.documents.length > LIMITS.documents) throw new Held('budget');
    const documents = new Set<string>();
    for (const document of input.documents) {
      if (!record(document) || Object.keys(document).some((key) => !['reference', 'kind', 'text'].includes(key))
        || typeof document.reference !== 'string' || !/^document-[1-9]\d*$/.test(document.reference) || documents.has(document.reference)
        || !['source-summary', 'source-description', 'extraction'].includes(String(document.kind)) || typeof document.text !== 'string') throw new Held('malformed');
      documents.add(document.reference);
    }
  }
  if (JSON.stringify(snapshot).length > LIMITS.characters) throw new Held('budget');
  return snapshot as unknown as readonly AnswerExcerptInput[];
}
function checkedPort(port: JudgmentPort, beforeAsk: () => void): JudgmentPort {
  return { ...port, model: port.model, async ask(request) {
    beforeAsk();
    const result = { ...await port.ask(request) };
    if (!result?.answers || typeof result.model !== 'string' || !result.model.trim()
      || typeof result.requestedModel !== 'string' || !result.requestedModel.trim()
      || (result.decisionId !== undefined && (typeof result.decisionId !== 'string' || !result.decisionId.trim()))) throw new Held('malformed');
    const answers = Object.fromEntries(Object.keys(request.questions).map((name) => {
      const answer: unknown = result.answers[name];
      if (!record(answer) || answer.type !== 'noul' || typeof answer.noul !== 'number' || !Number.isFinite(answer.noul)
        || answer.noul < 0 || answer.noul > 1) throw new Held('malformed');
      return [name, { type: 'noul' as const, noul: answer.noul }];
    })) as typeof result.answers;
    return { ...result, answers };
  } };
}

/** Synchronous complete-pass preparation lets callers protect even later sources
 * before earlier relevance/fact readings. No provider is acquired until read().
 */
export function prepareAnswerExcerptReadings(inputs: readonly AnswerExcerptInput[], options: {
  readonly signal?: AbortSignal | undefined; readonly timeoutMs?: number | undefined;
  readonly assertCurrent?: (() => void) | undefined;
  readonly observeModel?: ((model: string, requestedModel: string) => void) | undefined;
} = {}) {
  if (options.signal?.aborted) throw new Held('aborted');
  const snapshots = snapshotInputs(inputs);
  const timeoutMs = options.timeoutMs ?? LIMITS.defaultTimeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > LIMITS.timeoutMs) throw new Held('budget');
  const jobs: { inputIndex: number; candidate: AnswerExcerptCandidate; state: Record<string, JsonValue> }[] = [];
  let bytes = 0;
  for (const [inputIndex, input] of snapshots.entries()) {
    let reference = 0;
    const add = (candidate: AnswerExcerptCandidate) => {
      if (jobs.length >= LIMITS.requests) throw new Held('budget');
      const json = toJson({ ...input, candidate });
      if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Held('malformed');
      bytes += new TextEncoder().encode(JSON.stringify({ state: json, questions: answerExcerptSelection.items })).byteLength + 1_024;
      if (bytes > LIMITS.bytes) throw new Held('budget');
      jobs.push({ inputIndex, candidate, state: freezeSupport(json) as Record<string, JsonValue> });
    };
    for (const document of input.documents) for (const span of answerExcerptSpans(document)) {
      add({ reference: `candidate-${++reference}`, text: span.text, spans: [span] });
    }
    // Some extractors store a table heading, rows and footnotes in different
    // fields. A full-field bundle retains their original associations and exact
    // local provenance, rather than forcing a misleading isolated row.
    const whole = input.documents.filter((document) => document.text.trim()).map((document, index) => ({
      reference: `span-${index + 1}`, document: document.reference, start: 0, end: document.text.length, text: document.text,
    }));
    if (whole.length > 1) add({ reference: `candidate-${++reference}`, text: whole.map((span) => span.text).join('\n\n'), spans: whole });
  }
  let configured: JudgmentPort | undefined, configuredModel: string | undefined;
  const assertCurrent = () => {
    if (options.signal?.aborted) throw new Held('aborted');
    options.assertCurrent?.();
    if (configured) {
      let current: JudgmentPort;
      try { current = judgmentPort('engine.knowledge.answer-excerpt-selection'); } catch { throw new Held('stale'); }
      if (current !== configured || configured.model !== configuredModel) throw new Held('stale');
    }
  };
  const read = async (references?: ReadonlySet<string>): Promise<readonly AnswerExcerptSelection[]> => {
    if (references && [...references].some((reference) => !snapshots.some((input) => input.reference === reference))) throw new Held('malformed');
    const selectedJobs = jobs.filter((job) => !references || references.has(snapshots[job.inputIndex]!.reference));
    assertCurrent();
    if (!selectedJobs.length) return freezeSupport(snapshots.map((input) => ({ reference: input.reference, spans: [] })));
    const controller = new AbortController();
    let stoppedError: Held | undefined, rejectStopped: (error: Held) => void = () => {};
    const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
    const stop = (error: Held) => { stoppedError ??= error; controller.abort(); rejectStopped(stoppedError); };
    const abort = () => stop(new Held('aborted'));
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop(new Held('budget')), timeoutMs);
    const check = () => { if (stoppedError) throw stoppedError; assertCurrent(); };
    const run = async () => {
      check(); configured = judgmentPort('engine.knowledge.answer-excerpt-selection'); configuredModel = configured.model;
      const port = checkedPort(configured, check);
      let model: string | undefined, requestedModel: string | undefined, next = 0;
      const selected: boolean[] = [];
      await Promise.all(Array.from({ length: Math.min(LIMITS.concurrency, selectedJobs.length) }, async () => {
        while (next < selectedJobs.length) {
          check(); const index = next++, job = selectedJobs[index]!;
          try {
            const result = await answerExcerptSelection.run(port, job.state, { signal: controller.signal, site: answerExcerptSelection.name });
            check();
            if ((model !== undefined && result.result.model !== model) || (requestedModel !== undefined && result.result.requestedModel !== requestedModel)) throw new Held('stale');
            model = result.result.model; requestedModel = result.result.requestedModel;
            const reading = result.readings.excerptUseful;
            if (reading.outcome !== 'act' || reading.verdict === 'uncertain') throw new Held('unsettled');
            options.observeModel?.(model, requestedModel);
            selected[index] = reading.verdict === 'yes';
            result.recordAction(`settled exact excerpt ${reading.verdict}; source ranking and write authority are separate`);
          } catch (error) { const failure = error instanceof Held ? error : new Held('unavailable'); stop(failure); throw failure; }
        }
      }));
      check();
      return freezeSupport(snapshots.map((input, inputIndex) => ({ reference: input.reference,
        spans: selectedJobs.filter((job, index) => job.inputIndex === inputIndex && selected[index]).flatMap((job) => job.candidate.spans) })));
    };
    try { return await Promise.race([run(), stopped]); }
    catch (error) { controller.abort(); throw error instanceof Held ? error : new Held(error instanceof JudgmentPortMissingError ? 'unconfigured' : 'unavailable'); }
    finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
  };
  return { read, assertCurrent };
}

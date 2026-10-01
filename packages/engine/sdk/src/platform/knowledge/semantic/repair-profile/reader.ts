import { judgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { toJson, type JsonValue, type JudgmentPort } from '@goodvibes-jev/judgment';
import { assertJudgmentInput } from '../../../gate/judgment-input.js';
import { freezeSupport } from '../verification/projection.js';
import { repairProfileCategory, repairProfileValue, repairProfileSupport } from './battery.js';
import { REPAIR_PROFILE_CATEGORIES as CATEGORIES, REPAIR_PROFILE_LIMITS as LIMITS, KnowledgeRepairProfileHeldError as Held,
  type RepairProfileReadingInput, type RepairProfileValueCandidate, type RepairProfileSelection } from './types.js';
export * from './types.js';
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
/** Mechanical paragraph/sentence spans only. Single newlines keep table labels with their values. */
export function repairProfileValueCandidates(text: string): readonly RepairProfileValueCandidate[] {
  const candidates: RepairProfileValueCandidate[] = [];
  const append = (from: number, to: number) => {
    while (from < to && /\s/.test(text[from]!)) from++;
    while (to > from && /\s/.test(text[to - 1]!)) to--;
    if (from === to) return;
    if (candidates.length >= LIMITS.candidates) throw new Held('budget');
    candidates.push({ reference: `value-${candidates.length + 1}`, text: text.slice(from, to), start: from, end: to });
  };
  let from = 0;
  for (const match of text.matchAll(/\r?\n[ \t]*\r?\n|(?<=[.!?])(?=\s+[A-Z])/g)) {
    append(from, match.index); from = match.index + match[0].length;
  }
  append(from, text.length);
  return freezeSupport(candidates);
}
function snapshotInputs(inputs: readonly RepairProfileReadingInput[]) {
  // Complete selected semantic inputs, including late sources, precede serialization, bounds and port acquisition.
  assertJudgmentInput(inputs);
  if (!Array.isArray(inputs)) throw new Held('malformed');
  if (inputs.length > LIMITS.inputs) throw new Held('budget');
  return inputs.map((input) => {
    const typed: RepairProfileReadingInput = input;
    if (!record(input) || Object.keys(input).some((key) => !['query', 'subjects', 'source', 'extraction', 'text'].includes(key))
      || typeof input.query !== 'string' || typeof input.text !== 'string' || !Array.isArray(input.subjects)
      || !input.subjects.every((subject) => record(subject) && typeof subject.title === 'string'
        && Object.keys(subject).every((key) => ['title', 'kind', 'aliases', 'identity'].includes(key))
        && (subject.kind === undefined || typeof subject.kind === 'string')
        && (subject.aliases === undefined || (Array.isArray(subject.aliases) && subject.aliases.every((alias) => typeof alias === 'string')))
        && (subject.identity === undefined || (record(subject.identity) && Object.keys(subject.identity).every((key) => ['manufacturer', 'brand', 'model', 'modelNumber', 'variant', 'entityKind'].includes(key))
          && Object.values(subject.identity).every((value) => typeof value === 'string')))) || !record(input.source)
      || typeof input.source.sourceType !== 'string'
      || Object.keys(input.source).some((key) => !['title', 'sourceType', 'url', 'sourceUri', 'canonicalUri'].includes(key))
      || !Object.values(input.source).every((value) => value === undefined || typeof value === 'string')
      || (input.extraction !== undefined && (!record(input.extraction) || typeof input.extraction.format !== 'string'
        || Object.keys(input.extraction).some((key) => !['title', 'format'].includes(key))
        || !Object.values(input.extraction).every((value) => value === undefined || typeof value === 'string')))) throw new Held('malformed');
    if (JSON.stringify(input).length > LIMITS.characters) throw new Held('budget');
    const snapshot = freezeSupport(structuredClone(typed));
    return { input: snapshot, candidates: repairProfileValueCandidates(snapshot.text) };
  });
}
function checkedPort(port: JudgmentPort): JudgmentPort {
  return { ...port, model: port.model, async ask(request) {
    const result = { ...await port.ask(request) };
    if (!result?.answers || typeof result.model !== 'string' || !result.model.trim()
      || typeof result.requestedModel !== 'string' || !result.requestedModel.trim()
      || (result.decisionId !== undefined && (typeof result.decisionId !== 'string' || !result.decisionId.trim()))) throw new Held('malformed');
    const answers = Object.fromEntries(Object.keys(request.questions).map((name) => {
      const answer: unknown = result.answers[name];
      if (!record(answer)) throw new Held('malformed');
      const type = answer.type, probability = answer.noul;
      if (type !== 'noul' || typeof probability !== 'number' || !Number.isFinite(probability)
        || probability < 0 || probability > 1) throw new Held('malformed');
      return [name, { type: 'noul' as const, noul: probability }];
    })) as typeof result.answers;
    return { ...result, answers };
  } };
}
/** Read-only, complete-pass barrier. Selection negatives omit options; support negatives hold selected output. */
export async function prepareRepairProfileSelections(inputs: readonly RepairProfileReadingInput[], options: {
  readonly signal?: AbortSignal | undefined; readonly timeoutMs?: number | undefined;
} = {}): Promise<readonly (readonly RepairProfileSelection[])[]> {
  if (options.signal?.aborted) throw new Held('aborted');
  const snapshots = snapshotInputs(inputs);
  if (!snapshots.length) return [];
  const timeoutMs = options.timeoutMs ?? LIMITS.defaultTimeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > LIMITS.timeoutMs) throw new Held('budget');
  const controller = new AbortController();
  let stoppedError: Held | undefined, rejectStopped: (error: Held) => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
  const stop = (error: Held) => { stoppedError ??= error; controller.abort(); rejectStopped(stoppedError); };
  const abort = () => stop(new Held('aborted'));
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => stop(new Held('budget')), timeoutMs);
  const check = () => { if (stoppedError) throw stoppedError; if (options.signal?.aborted) throw new Held('aborted'); };
  let requests = 0, bytes = 0;
  const run = async () => {
    check(); const configured = judgmentPort('engine.knowledge.repair-profile'), configuredModel = configured.model;
    const port = checkedPort(configured);
    let model: string | undefined, requestedModel: string | undefined;
    const current = () => {
      check();
      if (judgmentPort('engine.knowledge.repair-profile') !== configured || configured.model !== configuredModel) throw new Held('stale');
    };
    async function read(kind: 'category' | 'value' | 'support', state: object): Promise<boolean> {
      current();
      const battery = kind === 'category' ? repairProfileCategory : kind === 'value' ? repairProfileValue : repairProfileSupport;
      const json = toJson(state);
      if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Held('malformed');
      requests++; bytes += new TextEncoder().encode(JSON.stringify({ state: json, questions: battery.items })).byteLength + 1_024;
      if (requests > LIMITS.requests || bytes > LIMITS.bytes) throw new Held('budget');
      const result = await battery.run(port, freezeSupport(json) as Record<string, JsonValue>, { signal: controller.signal, site: battery.name });
      current();
      if ((model !== undefined && result.result.model !== model) || (requestedModel !== undefined && result.result.requestedModel !== requestedModel)) throw new Held('stale');
      model = result.result.model; requestedModel = result.result.requestedModel;
      const reading = Object.values(result.readings)[0]!;
      if (reading.outcome !== 'act' || reading.verdict === 'uncertain') throw new Held('unsettled');
      if (kind === 'support' && reading.verdict !== 'yes') {
        result.recordAction('held: a selected exact profile value lacks complete support'); throw new Held('no-support');
      }
      result.recordAction(`settled profile ${kind} ${reading.verdict}; persistence requires separate support and live read-set validation`);
      return reading.verdict === 'yes';
    }
    async function all<T>(jobs: readonly (() => Promise<T>)[]): Promise<T[]> {
      const results: T[] = []; let next = 0;
      await Promise.all(Array.from({ length: Math.min(LIMITS.concurrency, jobs.length) }, async () => {
        while (next < jobs.length) {
          current(); const index = next++;
          try { results[index] = await jobs[index]!(); }
          catch (error) { const failure = error instanceof Held ? error : new Held('unavailable'); stop(failure); throw failure; }
        }
      }));
      return results;
    }
    const groups = snapshots.flatMap(({ input, candidates }, inputIndex) => CATEGORIES.map((category) => ({ input, inputIndex, candidates, category })));
    const wanted = await all(groups.map((group) => () => read('category', { ...group.input, category: group.category })));
    const optionsToRead = groups.flatMap((group, index) => wanted[index] ? group.candidates.map((candidate) => ({ ...group, candidate })) : []);
    const selected = await all(optionsToRead.map((option) => () => read('value', { ...option.input, category: option.category, candidate: option.candidate })));
    const values = optionsToRead.filter((_option, index) => selected[index]);
    await all(values.map((option) => () => read('support', { ...option.input, category: option.category, candidate: option.candidate })));
    current();
    return freezeSupport(snapshots.map((_snapshot, inputIndex) => CATEGORIES.flatMap((category) => {
      const selectedValues = values.filter((option) => option.inputIndex === inputIndex && option.category === category).map(({ input, candidate }) => {
        if (input.text.slice(candidate.start, candidate.end) !== candidate.text) throw new Held('stale');
        return candidate;
      });
      return selectedValues.length ? [{ category, values: selectedValues }] : [];
    })));
  };
  try { return await Promise.race([run(), stopped]); }
  catch (error) { controller.abort(); throw error instanceof Held ? error : new Held(error instanceof JudgmentPortMissingError ? 'unconfigured' : 'unavailable'); }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
}

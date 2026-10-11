import { judgmentPort, captureJudgmentPort, JudgmentAuthorityRetiredError, JudgmentPortMissingError, type JudgmentPortCapture } from '@goodvibes-jev/engine/errors';
import type { JsonValue, JudgmentPort } from '@goodvibes-jev/judgment';
import { assertJudgmentInput, JudgmentInputError } from '../../../gate/judgment-input.js';
import { freezeSupport } from '../verification/projection.js';
import { repairSourceAuthority } from './battery.js';
import { KnowledgeRepairSourceAuthorityHeldError as Held, REPAIR_SOURCE_AUTHORITY_LIMITS as LIMITS,
  type RepairSourceAuthorityInput, type RepairSourceAuthorityOptions, type RepairSourceAuthorityReading } from './types.js';
export * from './types.js';

const SITE = repairSourceAuthority.name;
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)); }
function strings(value: unknown): value is readonly string[] { return Array.isArray(value) && Array.from(value).every((item) => typeof item === 'string'); }
function optionalText(value: unknown): boolean { return value === undefined || typeof value === 'string'; }
/** Privacy has rejected accessors/cycles/prototypes; also refuse hidden or lossy JSON data. */
function jsonTree(value: unknown): void {
  if (value === undefined || value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (typeof value !== 'object' || Object.getOwnPropertySymbols(value).length) throw new Held('malformed');
  if (Array.isArray(value) && Object.keys(value).length !== value.length) throw new Held('malformed');
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (Array.isArray(value) && key === 'length') continue;
    if (!descriptor.enumerable || descriptor.get || descriptor.set) throw new Held('malformed');
    jsonTree(descriptor.value);
  }
}
function snapshotInputs(inputs: readonly RepairSourceAuthorityInput[]) {
  // Full selected batch, including late fields, precedes serialization, caps,
  // cache lookup and acquiring a model/port. No truncation chooses the evidence.
  try { assertJudgmentInput(inputs); }
  catch (error) { if (error instanceof JudgmentInputError && error.problem === 'unsupported-input') throw new Held('malformed'); throw error; }
  jsonTree(inputs);
  if (!Array.isArray(inputs)) throw new Held('malformed');
  const references = new Set<string>();
  for (const input of inputs) {
    if (!record(input) || !keys(input, ['reference', 'query', 'subjects', 'source', 'extraction', 'text', 'claimedProvenance'])
      || typeof input.reference !== 'string' || !/^source-[1-9]\d*$/.test(input.reference) || references.has(input.reference)
      || typeof input.query !== 'string' || typeof input.text !== 'string' || !Array.isArray(input.subjects)
      || !record(input.source) || !keys(input.source, ['sourceType', 'title', 'summary', 'description', 'url', 'sourceUri', 'canonicalUri'])
      || typeof input.source.sourceType !== 'string' || !Object.values(input.source).every(optionalText)
      || !record(input.extraction) || !keys(input.extraction, ['format', 'title', 'links']) || typeof input.extraction.format !== 'string'
      || !optionalText(input.extraction.title) || !strings(input.extraction.links)
      || !record(input.claimedProvenance) || !keys(input.claimedProvenance, ['trustReason', 'sourceDomain'])
      || !Object.values(input.claimedProvenance).every(optionalText)) throw new Held('malformed');
    references.add(input.reference);
    for (const subject of input.subjects) {
      if (!record(subject) || !keys(subject, ['title', 'kind', 'aliases', 'identity']) || typeof subject.title !== 'string'
        || !optionalText(subject.kind) || (subject.aliases !== undefined && !strings(subject.aliases))
        || (subject.identity !== undefined && (!record(subject.identity)
          || !keys(subject.identity, ['manufacturer', 'brand', 'model', 'modelNumber', 'variant', 'entityKind'])
          || !Object.values(subject.identity).every((value) => typeof value === 'string')))) throw new Held('malformed');
    }
  }
  if (inputs.length > LIMITS.inputs) throw new Held('budget');
  return inputs.map((input) => {
    const serialized = JSON.stringify(input);
    if (serialized.length > LIMITS.characters) throw new Held('budget');
    const { reference, ...content } = input;
    return { reference, key: JSON.stringify(content), state: freezeSupport(JSON.parse(serialized) as Record<string, JsonValue>) };
  });
}
/** One operation owns configuration, cancellation and the complete-pass cache. */
export function createRepairSourceAuthorityReader(options: RepairSourceAuthorityOptions = {}) {
  const { signal, assertCurrent: ownerCurrent } = options, configuredTimeout = options.timeoutMs;
  const timeoutMs = configuredTimeout ?? LIMITS.defaultTimeoutMs;
  const cache = new Map<string, Omit<RepairSourceAuthorityReading, 'reference'>>();
  let configured: JudgmentPort | undefined, configuredModel: string | undefined, resultModel: string | undefined;
  let authority: JudgmentPortCapture | undefined, failed: Error | undefined;
  let requests = 0, bytes = 0, queue: Promise<unknown> = Promise.resolve();
  const failure = (error: unknown): Error => error instanceof Held || error instanceof JudgmentInputError ? error
    : new Held(error instanceof JudgmentPortMissingError ? 'unconfigured' : error instanceof JudgmentAuthorityRetiredError ? 'stale' : 'unavailable');
  const assertCurrent = () => {
    if (failed) throw failed;
    try {
      if (signal?.aborted) throw new Held('aborted');
      if (options.signal !== signal || options.assertCurrent !== ownerCurrent || options.timeoutMs !== configuredTimeout) throw new Held('stale');
      ownerCurrent?.();
      if (configured) {
        try { authority!.assertCurrent(); } catch { throw new Held('stale'); }
        let current: JudgmentPort; try { current = judgmentPort(SITE); } catch { throw new Held('stale'); }
        if (current !== configured || current.model !== configuredModel) throw new Held('stale');
      }
    } catch (error) { failed ??= failure(error); throw failed; }
  };
  async function run(snapshots: ReturnType<typeof snapshotInputs>): Promise<readonly RepairSourceAuthorityReading[]> {
    assertCurrent();
    if (!snapshots.length) return Object.freeze([]);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > LIMITS.timeoutMs) throw new Held('budget');
    const pending = [...new Map(snapshots.filter(({ key }) => !cache.has(key)).map((snapshot) => [snapshot.key, snapshot])).values()];
    const rebound = () => freezeSupport(snapshots.map(({ reference, key }) => ({ reference, ...cache.get(key)! })));
    const questions = { authority: repairSourceAuthority.items.authority.question };
    const pendingBytes = pending.reduce((sum, { state }) => sum + new TextEncoder().encode(JSON.stringify({ state, questions })).byteLength + 1_024, 0);
    if (requests + pending.length > LIMITS.requests || bytes + pendingBytes > LIMITS.bytes) throw new Held('budget');
    if (!pending.length) { assertCurrent(); return rebound(); }
    requests += pending.length; bytes += pendingBytes;
    const controller = new AbortController();
    let stoppedError: Error | undefined, rejectStopped: (error: Error) => void = () => {};
    const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
    const stop = (error: Error) => { stoppedError ??= error; controller.abort(); rejectStopped(stoppedError); };
    const abort = () => stop(new Held('aborted'));
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop(new Held('budget')), timeoutMs);
    const check = () => { if (stoppedError) throw stoppedError; assertCurrent(); };
    const captured = authority!.port;
    const port: JudgmentPort = {
      model: configuredModel!, ...(captured.recorder === undefined ? {} : { recorder: captured.recorder }),
      async ask(request) {
        check(); const result = await captured.ask({ ...request, model: configuredModel! }); check();
        if (!record(result) || !record(result.answers)) throw new Held('malformed');
        const { model, requestedModel, decisionId } = result;
        if (typeof model !== 'string' || !model.trim() || typeof requestedModel !== 'string' || !requestedModel.trim()
          || (decisionId !== undefined && (typeof decisionId !== 'string' || !decisionId.trim()))) throw new Held('malformed');
        const answer: unknown = result.answers.authority;
        if (!record(answer) || answer.type !== 'choice') throw new Held('malformed');
        const { choice, confidence, probabilities } = answer;
        const choices = ['official-vendor', 'vendor', 'secondary'] as const;
        if (typeof choice !== 'string' || !choices.some((item) => item === choice) || typeof confidence !== 'number'
          || !Number.isFinite(confidence) || confidence < 0 || confidence > 1 || !record(probabilities)
          || Object.keys(probabilities).length !== choices.length || !keys(probabilities, choices)) throw new Held('malformed');
        const copied = Object.fromEntries(choices.map((key) => [key, probabilities[key]]));
        const scores = Object.values(copied);
        if (scores.some((score) => typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1)
          || Math.abs((scores as number[]).reduce((sum, score) => sum + score, 0) - 1) > 0.00001
          || Math.abs(Number(copied[choice]) - confidence) > 0.00001 || (scores as number[]).some((score) => score > confidence)) throw new Held('malformed');
        if (requestedModel !== configuredModel || (resultModel !== undefined && model !== resultModel)) throw new Held('stale');
        resultModel = model;
        return { ...result, model, requestedModel, answers: { ...result.answers,
          authority: freezeSupport({ type: 'choice' as const, choice, confidence, probabilities: copied as Record<string, number> }) },
          ...(decisionId === undefined ? {} : { decisionId }) } as typeof result;
      },
    };
    const settled = new Map<string, Omit<RepairSourceAuthorityReading, 'reference'>>(); let next = 0;
    const work = async () => {
      await Promise.all(Array.from({ length: Math.min(LIMITS.concurrency, pending.length) }, async () => {
        while (next < pending.length) {
          try {
            check(); const snapshot = pending[next++]!;
            const result = await repairSourceAuthority.run(port, snapshot.state, { signal: controller.signal, site: SITE });
            check(); const reading = result.readings.authority;
            if (reading.outcome !== 'act') throw new Held('uncertain');
            result.recordAction(`settled publisher role ${reading.choice}; not fact support or permission; publication requires live original read set`);
            check(); settled.set(snapshot.key, freezeSupport({ authority: reading.choice, probability: reading.confidence }));
          } catch (error) { const held = failure(error); stop(held); throw held; }
        }
      }));
      check(); for (const [key, reading] of settled) cache.set(key, reading);
      return rebound();
    };
    try { return await Promise.race([work(), stopped]); }
    finally { controller.abort(); clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  return Object.freeze({
    assertCurrent,
    preflight(inputs: readonly RepairSourceAuthorityInput[]): void { snapshotInputs(inputs); },
    async read(inputs: readonly RepairSourceAuthorityInput[]): Promise<readonly RepairSourceAuthorityReading[]> {
      let snapshots: ReturnType<typeof snapshotInputs>;
      try {
        snapshots = snapshotInputs(inputs); assertCurrent();
        if (snapshots.length && !configured) {
          configured = judgmentPort(SITE); configuredModel = configured.model;
          authority = captureJudgmentPort(SITE, { signal, assertCurrent: ownerCurrent });
          if (typeof configuredModel !== 'string' || !configuredModel.trim()) throw new Held('malformed');
        }
      } catch (error) { failed ??= failure(error); throw failed; }
      const reading = queue.then(() => run(snapshots)).catch((error: unknown) => { failed ??= failure(error); throw failed; });
      queue = reading.catch(() => {}); return reading;
    },
  });
}

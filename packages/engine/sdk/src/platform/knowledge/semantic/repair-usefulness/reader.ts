import { judgmentPort, captureJudgmentPort, JudgmentAuthorityRetiredError, JudgmentPortMissingError, type JudgmentPortCapture } from '@goodvibes-jev/engine/errors';
import type { JsonValue, JudgmentPort } from '@goodvibes-jev/judgment';
import { assertJudgmentInput, JudgmentInputError } from '../../../gate/judgment-input.js';
import { freezeSupport } from '../verification/projection.js';
import { repairFactUsefulness } from './battery.js';
import { knowledgePageFactUsefulness } from './page-battery.js';
import { KnowledgeRepairFactUsefulnessHeldError as Held, REPAIR_FACT_USEFULNESS_LIMITS as LIMITS,
  type RepairFactUsefulnessInput, type RepairFactUsefulnessOptions, type RepairFactUsefulnessReading } from './types.js';
export * from './types.js';


function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)); }
function strings(value: unknown): value is readonly string[] {
  if (!Array.isArray(value)) return false;
  for (const item of value) if (typeof item !== 'string') return false;
  return true;
}
function optionalText(value: unknown): boolean { return value === undefined || typeof value === 'string'; }

/** The privacy guard has already rejected accessors, cycles and exotic prototypes. */
function assertJsonTree(value: unknown, optional = false): void {
  if (value === undefined && optional) return;
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (typeof value !== 'object' || value === null || Object.getOwnPropertySymbols(value).length) throw new Held('malformed');
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new Held('malformed');
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (key !== 'length' && (!descriptor.enumerable || descriptor.get || descriptor.set)) throw new Held('malformed');
    }
    for (const child of value) assertJsonTree(child, optional);
  } else {
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable || descriptor.get || descriptor.set) throw new Held('malformed');
      assertJsonTree(descriptor.value, optional);
    }
  }
}

function snapshotInputs(inputs: readonly RepairFactUsefulnessInput[], page = false): readonly { reference: string; key: string; state: Record<string, JsonValue> }[] {
  // The ENTIRE selected batch, including late fields, precedes serialization,
  // every local cap, cache lookup and even acquisition of the judgment port.
  try { assertJudgmentInput(inputs); }
  catch (error) {
    if (error instanceof JudgmentInputError && error.problem === 'unsupported-input') throw new Held('malformed');
    throw error;
  }
  assertJsonTree(inputs, true);
  if (!Array.isArray(inputs)) throw new Held('malformed');
  const references = new Set<string>();
  for (const input of inputs) {
    if (!record(input) || !keys(input, ['reference', 'query', 'subjects', 'fact', 'evidence', ...(page ? ['pagePolicy'] : [])])
      || typeof input.reference !== 'string' || !/^fact-[1-9]\d*$/.test(input.reference) || references.has(input.reference)
      || typeof input.query !== 'string' || !Array.isArray(input.subjects) || !record(input.fact) || !Array.isArray(input.evidence)) throw new Held('malformed');
    references.add(input.reference);
    if (page && (!record(input.pagePolicy) || !keys(input.pagePolicy, ['rejectRemoteAccessoryDetails'])
      || typeof input.pagePolicy.rejectRemoteAccessoryDetails !== 'boolean')) throw new Held('malformed');
    for (const subject of input.subjects) {
      if (!record(subject) || !keys(subject, ['title', 'kind', 'aliases', 'identity']) || typeof subject.title !== 'string'
        || !optionalText(subject.kind) || (subject.aliases !== undefined && !strings(subject.aliases))
        || (subject.identity !== undefined && (!record(subject.identity)
          || !keys(subject.identity, ['manufacturer', 'brand', 'model', 'modelNumber', 'variant', 'entityKind'])
          || !Object.values(subject.identity).every((value) => typeof value === 'string')))) throw new Held('malformed');
    }
    const fact = input.fact;
    if (!keys(fact, ['title', 'kind', 'summary', 'value', 'evidence', 'subject', 'labels', 'aliases'])
      || typeof fact.title !== 'string' || typeof fact.kind !== 'string' || !optionalText(fact.summary) || !strings(fact.aliases)
      || (fact.labels !== undefined && !strings(fact.labels))) throw new Held('malformed');
    // Unknown fact values must be real JSON, never serialization hooks or data
    // silently lost by JSON.stringify (such as nested undefined or sparse arrays).
    if (fact.value !== undefined) assertJsonTree(fact.value);
    if (fact.evidence !== undefined) assertJsonTree(fact.evidence);
    if (fact.subject !== undefined) assertJsonTree(fact.subject);
    for (const evidence of input.evidence) {
      if (!record(evidence) || !keys(evidence, ['source', 'extraction', 'text']) || typeof evidence.text !== 'string'
        || !record(evidence.source) || !keys(evidence.source, ['title', 'sourceType', 'url', 'sourceUri', 'canonicalUri'])
        || typeof evidence.source.sourceType !== 'string' || !Object.values(evidence.source).every(optionalText)
        || (evidence.extraction !== undefined && (!record(evidence.extraction) || !keys(evidence.extraction, ['format', 'title'])
          || typeof evidence.extraction.format !== 'string' || !optionalText(evidence.extraction.title)))) throw new Held('malformed');
    }
  }
  if (inputs.length > LIMITS.inputs) throw new Held('budget');
  return inputs.map((input) => {
    const serialized = JSON.stringify(input);
    if (serialized.length > LIMITS.characters) throw new Held('budget');
    // Labels belong to the caller's current mapping, not semantic identity.
    const { reference, ...semanticInput } = input;
    return { reference, key: JSON.stringify(semanticInput), state: freezeSupport(JSON.parse(serialized) as Record<string, JsonValue>) };
  });
}

/** One caller operation owns this reader. Nothing is cached across operations. */
export function createRepairFactUsefulnessReader(options: RepairFactUsefulnessOptions = {}) {
  return createFactUsefulnessReader(options, false);
}
export function createKnowledgePageFactUsefulnessReader(options: RepairFactUsefulnessOptions = {}) {
  return createFactUsefulnessReader(options, true);
}
function createFactUsefulnessReader(options: RepairFactUsefulnessOptions, page: boolean) {
  const battery = page ? knowledgePageFactUsefulness : repairFactUsefulness;
  const SITE = battery.name;
  const signal = options.signal, timeoutMs = options.timeoutMs ?? LIMITS.defaultTimeoutMs;
  const cache = new Map<string, Omit<RepairFactUsefulnessReading, 'reference'>>();
  let configured: JudgmentPort | undefined, configuredModel: string | undefined, resultModel: string | undefined;
  let authority: JudgmentPortCapture | undefined;
  let requests = 0, bytes = 0;
  let failed: Error | undefined;
  // Serial batches share a single four-request concurrency limit and one budget.
  let queue: Promise<unknown> = Promise.resolve();
  const assertCurrent = () => {
    if (failed) throw failed;
    if (signal?.aborted) throw new Held('aborted');
    if (configured) {
      try { authority?.assertCurrent(); } catch { throw new Held('stale'); }
      let current: JudgmentPort;
      try { current = judgmentPort(SITE); } catch { throw new Held('stale'); }
      if (current !== configured || current.model !== configuredModel) throw new Held('stale');
    }
  };
  const failure = (error: unknown): Error => error instanceof Held || error instanceof JudgmentInputError ? error
    : new Held(error instanceof JudgmentPortMissingError ? 'unconfigured' : error instanceof JudgmentAuthorityRetiredError ? 'stale' : 'unavailable');

  async function run(snapshots: ReturnType<typeof snapshotInputs>): Promise<readonly RepairFactUsefulnessReading[]> {
    assertCurrent();
    if (!snapshots.length) return Object.freeze([]);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > LIMITS.timeoutMs) throw new Held('budget');
    const pending = [...new Map(snapshots.filter(({ key }) => !cache.has(key)).map((snapshot) => [snapshot.key, snapshot])).values()];
    const rebound = () => freezeSupport(snapshots.map(({ reference, key }) => ({ reference, ...cache.get(key)! })));
    const questions = { repairUseful: battery.items.repairUseful.question };
    const pendingBytes = pending.reduce((sum, { state }) => sum + new TextEncoder().encode(JSON.stringify({ state, questions })).byteLength + 1_024, 0);
    if (requests + pending.length > LIMITS.requests || bytes + pendingBytes > LIMITS.bytes) throw new Held('budget');
    assertCurrent();
    if (!pending.length) return rebound();
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
        check();
        const result = await captured.ask({ ...request, model: configuredModel! });
        check();
        if (!record(result) || !record(result.answers)) throw new Held('malformed');
        const model = result.model, requestedModel = result.requestedModel, decisionId = result.decisionId;
        if (typeof model !== 'string' || !model.trim() || typeof requestedModel !== 'string' || !requestedModel.trim()
          || (decisionId !== undefined && (typeof decisionId !== 'string' || !decisionId.trim()))) throw new Held('malformed');
        const answer: unknown = result.answers.repairUseful;
        if (!record(answer) || answer.type !== 'noul') throw new Held('malformed');
        const probability = answer.noul;
        if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) throw new Held('malformed');
        if (requestedModel !== configuredModel || (resultModel !== undefined && model !== resultModel)) throw new Held('stale');
        resultModel = model;
        // A custom port cannot mutate its answer after validation and before
        // the battery reads the probability or logs the model attribution.
        return { ...result, model, requestedModel,
          answers: { ...result.answers, repairUseful: Object.freeze({ type: 'noul' as const, noul: probability }) },
          ...(decisionId === undefined ? {} : { decisionId }) };
      },
    };
    const settled = new Map<string, Omit<RepairFactUsefulnessReading, 'reference'>>();
    let next = 0;
    const work = async () => {
      await Promise.all(Array.from({ length: Math.min(LIMITS.concurrency, pending.length) }, async () => {
        while (next < pending.length) {
          try {
            check(); const snapshot = pending[next++]!;
            const result = await battery.run(port, snapshot.state, { signal: controller.signal, site: SITE });
            check(); const reading = result.readings.repairUseful;
            if (reading.outcome !== 'act' || reading.verdict === 'uncertain') throw new Held('uncertain');
            result.recordAction(`settled repair fact usefulness ${reading.verdict}; persistence requires separate live read-set validation`);
            settled.set(snapshot.key, freezeSupport({ useful: reading.verdict === 'yes', probability: reading.probability }));
          } catch (error) { const held = failure(error); stop(held); throw held; }
        }
      }));
      check();
      // Commit only after every selected fact settles under the same live port.
      for (const [key, reading] of settled) cache.set(key, reading);
      return rebound();
    };
    try { return await Promise.race([work(), stopped]); }
    finally { controller.abort(); clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  return Object.freeze({
    assertCurrent,
    preflight(inputs: readonly RepairFactUsefulnessInput[]): void { snapshotInputs(inputs, page); },
    async read(inputs: readonly RepairFactUsefulnessInput[]): Promise<readonly RepairFactUsefulnessReading[]> {
      // Snapshot immediately, even when another batch is still in flight.
      let snapshots: ReturnType<typeof snapshotInputs>;
      try {
        snapshots = snapshotInputs(inputs, page);
        assertCurrent();
        // Privacy/schema preflight covers the complete batch before acquiring
        // authority, synchronously before a queued microtask can change owners.
        if (snapshots.length && !configured) {
          configured = judgmentPort(SITE); configuredModel = configured.model;
          authority = captureJudgmentPort(SITE, { signal });
          if (typeof configuredModel !== 'string' || !configuredModel.trim()) throw new Held('malformed');
        }
      }
      catch (error) { failed ??= failure(error); throw failed; }
      const reading = queue.then(() => run(snapshots)).catch((error: unknown) => { failed ??= failure(error); throw failed; });
      queue = reading.catch(() => {});
      return reading;
    },
  });
}

export async function prepareRepairFactUsefulness(inputs: readonly RepairFactUsefulnessInput[], options: RepairFactUsefulnessOptions = {}): Promise<readonly RepairFactUsefulnessReading[]> {
  return createRepairFactUsefulnessReader(options).read(inputs);
}

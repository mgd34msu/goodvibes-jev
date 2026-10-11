import { judgmentPort, captureJudgmentPort, JudgmentAuthorityRetiredError, JudgmentPortMissingError, type JudgmentPortCapture } from '@goodvibes-jev/engine/errors';
import type { JsonValue, JudgmentPort } from '@goodvibes-jev/judgment';
import { assertJudgmentInput, JudgmentInputError } from '../../../gate/judgment-input.js';
import { freezeSupport } from '../verification/projection.js';
import { repairSubjectSelection } from './battery.js';
import { KnowledgeRepairSubjectSelectionHeldError as Held, REPAIR_SUBJECT_SELECTION_LIMITS as LIMITS,
  type RepairSubjectSelectionInput, type RepairSubjectSelectionOptions, type RepairSubjectSelectionReading } from './types.js';
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

function snapshotInputs(inputs: readonly RepairSubjectSelectionInput[]) {
  assertJudgmentInput(inputs);
  assertJsonTree(inputs, true);
  if (!Array.isArray(inputs)) throw new Held('malformed');
  const references = new Set<string>();
  for (const input of inputs) {
    if (!record(input) || !keys(input, ['reference', 'query', 'candidate', 'candidates', 'objectProfiles'])
      || typeof input.reference !== 'string' || !/^subject-[1-9]\d*$/.test(input.reference)
      || references.has(input.reference) || typeof input.query !== 'string'
      || typeof input.candidate !== 'string' || !Array.isArray(input.candidates)
      || !Array.isArray(input.objectProfiles)) throw new Held('malformed');
    references.add(input.reference);
    const candidateReferences = new Set<string>();
    for (const candidate of input.candidates) {
      if (!record(candidate) || !keys(candidate, ['reference', 'title', 'kind', 'summary', 'aliases', 'identity'])
        || typeof candidate.reference !== 'string' || !/^subject-[1-9]\d*$/.test(candidate.reference) || candidateReferences.has(candidate.reference) || typeof candidate.title !== 'string' || typeof candidate.kind !== 'string'
        || !optionalText(candidate.summary) || !strings(candidate.aliases) || !record(candidate.identity)
        || !keys(candidate.identity, ['manufacturer', 'brand', 'model', 'modelNumber', 'variant', 'entityKind'])
        || !Object.values(candidate.identity).every(value => typeof value === 'string')) throw new Held('malformed');
      candidateReferences.add(candidate.reference);
    }
    for (const profile of input.objectProfiles) if (!record(profile) || !keys(profile, ['subjectKinds']) || !strings(profile.subjectKinds)) throw new Held('malformed');
    if (input.candidates.filter(candidate => candidate.reference === input.candidate).length !== 1) throw new Held('malformed');
  }
  if (inputs.length > LIMITS.inputs) throw new Held('budget');
  return inputs.map(input => {
    const serialized = JSON.stringify(input);
    if (serialized.length > LIMITS.characters) throw new Held('budget');
    const { reference, ...semanticInput } = input;
    return { reference, key: JSON.stringify(semanticInput), state: freezeSupport(JSON.parse(serialized) as Record<string, JsonValue>) };
  });
}

/** One caller operation owns this reader. Nothing is cached across operations. */
export function createRepairSubjectSelectionReader(options: RepairSubjectSelectionOptions = {}) {
  const battery = repairSubjectSelection;
  const SITE = battery.name;
  const ownerCurrent = options.assertCurrent;
  const configuredTimeout = options.timeoutMs;
  const signal = options.signal, timeoutMs = configuredTimeout ?? LIMITS.defaultTimeoutMs;
  const cache = new Map<string, Omit<RepairSubjectSelectionReading, 'reference'>>();
  let configured: JudgmentPort | undefined, configuredModel: string | undefined, resultModel: string | undefined;
  let authority: JudgmentPortCapture | undefined;
  let requests = 0, bytes = 0;
  let failed: Error | undefined;
  // Serial batches share a single four-request concurrency limit and one budget.
  let queue: Promise<unknown> = Promise.resolve();
  const assertCurrent = () => {
    if (failed) throw failed;
    try {
      if (signal?.aborted) throw new Held('aborted');
      if (options.signal !== signal || options.assertCurrent !== ownerCurrent || options.timeoutMs !== configuredTimeout) throw new Held('stale');
      ownerCurrent?.();
      if (configured) {
        try { authority?.assertCurrent(); } catch { throw new Held('stale'); }
        let current: JudgmentPort;
        try { current = judgmentPort(SITE); } catch { throw new Held('stale'); }
        if (current !== configured || current.model !== configuredModel) throw new Held('stale');
      }
    } catch (error) { failed ??= failure(error); throw failed; }
  };
  const failure = (error: unknown): Error => error instanceof Held || error instanceof JudgmentInputError ? error
    : new Held(error instanceof JudgmentPortMissingError ? 'unconfigured' : error instanceof JudgmentAuthorityRetiredError ? 'stale' : 'unavailable');

  async function run(snapshots: ReturnType<typeof snapshotInputs>): Promise<readonly RepairSubjectSelectionReading[]> {
    assertCurrent();
    if (!snapshots.length) return Object.freeze([]);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > LIMITS.timeoutMs) throw new Held('budget');
    const pending = [...new Map(snapshots.filter(({ key }) => !cache.has(key)).map((snapshot) => [snapshot.key, snapshot])).values()];
    const rebound = () => freezeSupport(snapshots.map(({ reference, key }) => ({ reference, ...cache.get(key)! })));
    const questions = { repairSubjectSelected: battery.items.repairSubjectSelected.question };
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
        const answer: unknown = result.answers.repairSubjectSelected;
        if (!record(answer) || answer.type !== 'noul') throw new Held('malformed');
        const probability = answer.noul;
        if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) throw new Held('malformed');
        if (requestedModel !== configuredModel || (resultModel !== undefined && model !== resultModel)) throw new Held('stale');
        resultModel = model;
        // A custom port cannot mutate its answer after validation and before
        // the battery reads the probability or logs the model attribution.
        return { ...result, model, requestedModel,
          answers: { ...result.answers, repairSubjectSelected: Object.freeze({ type: 'noul' as const, noul: probability }) },
          ...(decisionId === undefined ? {} : { decisionId }) };
      },
    };
    const settled = new Map<string, Omit<RepairSubjectSelectionReading, 'reference'>>();
    let next = 0;
    const work = async () => {
      await Promise.all(Array.from({ length: Math.min(LIMITS.concurrency, pending.length) }, async () => {
        while (next < pending.length) {
          try {
            check(); const snapshot = pending[next++]!;
            const result = await battery.run(port, snapshot.state, { signal: controller.signal, site: SITE });
            check(); const reading = result.readings.repairSubjectSelected;
            if (reading.outcome !== 'act' || reading.verdict === 'uncertain') throw new Held('uncertain');
            result.recordAction(`settled repair subject membership ${reading.verdict}; persistence requires separate live read-set validation`);
            settled.set(snapshot.key, freezeSupport({ selected: reading.verdict === 'yes', probability: reading.probability }));
          } catch (error) { const held = failure(error); stop(held); throw held; }
        }
      }));
      check();
      // Commit only after every candidate settles under the same live port.
      for (const [key, reading] of settled) cache.set(key, reading);
      return rebound();
    };
    try { return await Promise.race([work(), stopped]); }
    finally { controller.abort(); clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  return Object.freeze({
    assertCurrent,
    preflight(inputs: readonly RepairSubjectSelectionInput[]): void { snapshotInputs(inputs); },
    async read(inputs: readonly RepairSubjectSelectionInput[]): Promise<readonly RepairSubjectSelectionReading[]> {
      // Snapshot immediately, even when another batch is still in flight.
      let snapshots: ReturnType<typeof snapshotInputs>;
      try {
        snapshots = snapshotInputs(inputs);
        assertCurrent();
        // Privacy/schema preflight covers the complete batch before acquiring
        // authority, synchronously before a queued microtask can change owners.
        if (snapshots.length && !configured) {
          configured = judgmentPort(SITE); configuredModel = configured.model;
          authority = captureJudgmentPort(SITE, { signal, assertCurrent: ownerCurrent });
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

export async function prepareRepairSubjectSelection(inputs: readonly RepairSubjectSelectionInput[], options: RepairSubjectSelectionOptions = {}): Promise<readonly RepairSubjectSelectionReading[]> {
  return createRepairSubjectSelectionReader(options).read(inputs);
}

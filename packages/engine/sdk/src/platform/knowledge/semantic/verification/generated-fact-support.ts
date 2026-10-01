import { createSupportReferenceLabels } from './structural-references.js';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import type { JsonValue, JudgmentPort } from '@goodvibes-jev/judgment';
import { generatedFactFieldSupport, generatedFactSubjectAttachment } from './batteries.js';
import { freezeSupport, projectSupportInput, supportHash, type ProjectedSupportInput } from './projection.js';
import { GENERATED_FACT_SUPPORT_LIMITS as LIMITS, KnowledgeGeneratedFactSupportHeldError as Held,
  type GeneratedFactSupportInput, type GeneratedFactSupportOptions, type GeneratedFactSupportPlan, type GeneratedFactSupportReceipt } from './types.js';
export * from './types.js';

type RequestPlan = {
  readonly projection: ProjectedSupportInput;
  readonly field: string;
  readonly fieldHash: string;
  readonly subjectId?: string;
  readonly subjectHash?: string;
  readonly state: Record<string, JsonValue>;
  readonly attachment: boolean;
};
function bounded(value: number | undefined, maximum: number): number {
  const result = value ?? maximum;
  if (!Number.isInteger(result) || result <= 0 || result > maximum) throw new Held('budget');
  return result;
}
function versionsAgree(inputs: readonly ProjectedSupportInput[]): void {
  const versions = new Map<string, string>();
  const compare = (key: string, hash: string) => {
    const previous = versions.get(key);
    if (previous !== undefined && previous !== hash) throw new Held('stale');
    versions.set(key, hash);
  };
  for (const input of inputs) {
    compare(`source:${input.sourceId}`, input.sourceHash);
    compare(`extraction:${input.extractionId}`, input.extractionHash);
    compare(`source-extraction:${input.sourceId}`, input.extractionHash);
    for (const subject of input.subjects) compare(`subject:${subject.originalId}`, subject.hash);
  }
}
function requestPlans(input: ProjectedSupportInput): RequestPlan[] {
  const state = input.state as { readonly [key: string]: JsonValue };
  return [
    ...input.fields.map((field) => ({ projection: input, field: field.name, fieldHash: field.originalHash, state: { ...state, field: { name: field.name, value: field.value } }, attachment: false })),
    ...input.subjects.map((subject) => ({ projection: input, field: 'subjectAttachment', fieldHash: subject.originalFieldHash,
      subjectId: subject.originalId, subjectHash: subject.hash, state: { ...state, subject: subject.state }, attachment: true })),
  ];
}
/** Validate custom ports too: a malformed noul may otherwise accidentally reach an act band. */
function checkedPort(port: JudgmentPort): JudgmentPort {
  return { ...port, model: port.model, async ask(request) {
    const result = await port.ask(request);
    if (!result || !result.answers || (result.decisionId !== undefined && (typeof result.decisionId !== 'string' || !result.decisionId.trim()))) throw new Held('malformed');
    for (const key of Object.keys(request.questions)) {
      const answer: unknown = result.answers[key];
      if (!answer || typeof answer !== 'object' || !('type' in answer) || answer.type !== 'noul'
        || !('noul' in answer) || typeof answer.noul !== 'number' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) throw new Held('malformed');
    }
    return result;
  } };
}
function receipt(request: RequestPlan, probability: number, decisionId?: string): GeneratedFactSupportReceipt {
  const input = request.projection;
  const battery = request.attachment ? generatedFactSubjectAttachment : generatedFactFieldSupport;
  const body = {
    ...(decisionId === undefined ? {} : { decisionId }), battery: battery.name, batteryVersion: battery.version,
    spaceId: input.spaceId, claimId: input.claimId, claimHash: input.claimHash,
    field: request.field, fieldHash: request.fieldHash, stateHash: supportHash(request.state),
    sourceId: input.sourceId, sourceHash: input.sourceHash, extractionId: input.extractionId,
    extractionHash: input.extractionHash, extractionUpdatedAt: input.extractionUpdatedAt,
    ...(request.subjectId === undefined ? {} : { subjectId: request.subjectId, subjectHash: request.subjectHash }),
    evidenceReference: { extractionId: input.extractionId, evidenceHash: input.evidenceHash },
    verdict: 'yes' as const, outcome: 'act' as const, probability,
  };
  return freezeSupport({ receiptId: `fact-support-${supportHash(body)}`, ...body });
}

/**
 * Read-only, whole-pass barrier. Every supplied claim×source and every proposed
 * attachment must settle act/yes before ANY plans are returned. It performs no
 * storage writes; the caller must revalidate its exact read-set at write time.
 */
export async function prepareGeneratedFactSupport(inputs: readonly GeneratedFactSupportInput[], options: GeneratedFactSupportOptions = {}): Promise<readonly GeneratedFactSupportPlan[]> {
  if (options.signal?.aborted) throw new Held('aborted');
  if (!Array.isArray(inputs) || inputs.length > LIMITS.inputs) throw new Held('budget');
  if (Object.getPrototypeOf(inputs) !== Array.prototype || Object.values(Object.getOwnPropertyDescriptors(inputs)).some((item) => item.get || item.set)) throw new Held('malformed');
  for (let index = 0; index < inputs.length; index++) if (!Object.hasOwn(inputs, index)) throw new Held('malformed');
  const maxRequests = bounded(options.maxRequests, LIMITS.requests), maxBytes = bounded(options.maxBytes, LIMITS.bytes);
  const concurrency = bounded(options.concurrency, LIMITS.concurrency), timeoutMs = bounded(options.timeoutMs, LIMITS.timeoutMs);
  // No port is even acquired until every selected input has passed privacy and
  // identity checks. In particular, a protected late field cannot leak early ones.
  let projectionBytes = 0;
  const referenceLabels = createSupportReferenceLabels();
  const projections = inputs.map((input) => {
    const projection = projectSupportInput(input, referenceLabels);
    projectionBytes += new TextEncoder().encode(JSON.stringify(projection)).byteLength;
    if (projectionBytes > maxBytes) throw new Held('budget');
    return projection;
  });
  versionsAgree(projections);
  const jobs: RequestPlan[] = [], requestsByKey = new Map<string, number>();
  let bytes = 0;
  const planRequests = projections.map((input) => freezeSupport(requestPlans(input)).map((request) => {
    const key = JSON.stringify({ state: request.state, claimHash: input.claimHash, sourceHash: input.sourceHash, extractionHash: input.extractionHash, subjectHash: request.subjectHash });
    const previous = requestsByKey.get(key);
    if (previous !== undefined) return previous;
    if (jobs.length >= maxRequests) throw new Held('budget');
    const battery = request.attachment ? generatedFactSubjectAttachment : generatedFactFieldSupport;
    const questions = Object.fromEntries(Object.entries(battery.items).map(([name, item]) => [name, item.question]));
    // Include question text plus bounded protocol/context overhead, not just evidence.
    bytes += new TextEncoder().encode(JSON.stringify({ state: request.state, questions })).byteLength + 1_024;
    if (bytes > maxBytes) throw new Held('budget');
    const index = jobs.length;
    requestsByKey.set(key, index); jobs.push(request);
    return index;
  }));
  if (options.signal?.aborted) throw new Held('aborted');
  if (jobs.length === 0) return Object.freeze([]);

  const controller = new AbortController();
  let cancellation: Held | undefined;
  const cancel = (reason: Held) => { cancellation ??= reason; controller.abort(); };
  const onAbort = () => cancel(new Held('aborted'));
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => cancel(new Held('budget')), timeoutMs);
  const assertCurrent = () => { if (cancellation) throw cancellation; if (options.signal?.aborted) throw new Held('aborted'); };
  const settled: GeneratedFactSupportReceipt[] = [];
  let next = 0;
  async function read(job: RequestPlan, port: JudgmentPort) {
    assertCurrent();
    let removeAbort = () => {};
    // Even a custom port ignoring AbortSignal cannot keep a pass alive forever.
    const aborted = new Promise<never>((_resolve, reject) => {
      const listener = () => reject(cancellation ?? new Held('aborted'));
      controller.signal.addEventListener('abort', listener, { once: true });
      removeAbort = () => controller.signal.removeEventListener('abort', listener);
      if (controller.signal.aborted) listener();
    });
    try {
      const settings = { signal: controller.signal, site: job.attachment ? generatedFactSubjectAttachment.name : generatedFactFieldSupport.name };
      const pending = job.attachment
        ? generatedFactSubjectAttachment.run(port, job.state, settings).then((run) => ({ run, reading: run.readings.attached }))
        : generatedFactFieldSupport.run(port, job.state, settings).then((run) => ({ run, reading: run.readings.supported }));
      const { run, reading } = await Promise.race([pending, aborted]);
      assertCurrent();
      if (reading.outcome !== 'act' || reading.verdict !== 'yes') {
        run.recordAction('held: exact generated field or subject attachment is unsupported or unsettled');
        throw new Held(reading.outcome === 'act' && reading.verdict === 'no' ? 'no-support' : 'unsettled');
      }
      run.recordAction('verified: exact generated field or subject attachment; persistence remains subject to read-set validation');
      return receipt(job, reading.probability, run.result.decisionId);
    } finally { removeAbort(); }
  }
  try {
    assertCurrent();
    const port = checkedPort(judgmentPort('engine.knowledge.generated-fact-support'));
    await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
      while (next < jobs.length) {
        assertCurrent();
        const index = next++;
        try { settled[index] = await read(jobs[index]!, port); }
        catch (error) { const held = error instanceof Held ? error : new Held('unavailable'); cancel(held); throw held; }
      }
    }));
    assertCurrent();
    return freezeSupport(projections.map((input, index) => ({ claim: input.claim, claimId: input.claimId,
      claimHash: input.claimHash, sourceId: input.sourceId, sourceHash: input.sourceHash,
      extractionId: input.extractionId, extractionHash: input.extractionHash,
      receipts: planRequests[index]!.map((request) => settled[request]!),
    })));
  } catch (error) { throw error instanceof Held ? error : new Held('unavailable'); }
  finally { clearTimeout(timeout); options.signal?.removeEventListener('abort', onAbort); }
}

import { retainStrictJudgmentJson, prepareJudgmentResult } from '../../../gate/judgment-result.js';
import { captureJudgmentPort, JudgmentAuthorityRetiredError, JudgmentPortMissingError, type JudgmentPortCapture } from '@goodvibes-jev/engine/errors';
import { fanOut, toJson, type JudgmentPort, type JsonValue, type YesNoReading } from '@goodvibes-jev/judgment';
import { assertJudgmentInput, JudgmentInputError } from '../../../gate/judgment-input.js';
import { freezeSupport } from '../../semantic/verification/projection.js';
import { homeGraphQualityBatteries } from './batteries.js';
import { HomeGraphQualityHeldError as Held, HOME_GRAPH_QUALITY_LIMITS as LIMITS, type HomeGraphQualityInput, type HomeGraphQualityReading } from './types.js';
export * from './types.js';

const SUBJECT_FIELDS = new Set(['kind', 'title', 'summary', 'aliases', 'manufacturer', 'model', 'entryType', 'entry_type', 'homeAssistant', 'attributes']);
const IDENTITY_FIELDS = new Set(['objectKind', 'objectId', 'entityId', 'deviceId', 'integrationId', 'domain']);
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function checkSubject(value: unknown, entity = false): void {
  if (!record(value)) throw new Held('malformed');
  for (const [key, item] of Object.entries(value)) {
    if (entity && key === 'reference') { if (typeof item !== 'string' || !/^entity-[1-9]\d*$/.test(item)) throw new Held('malformed'); continue; }
    if (!SUBJECT_FIELDS.has(key)) throw new Held('malformed');
    if (key === 'aliases') {
      if (!Array.isArray(item) || item.some((alias) => typeof alias !== 'string')) throw new Held('malformed');
    } else if (key === 'homeAssistant' || key === 'attributes') {
      if (!record(item) || Object.entries(item).some(([field, text]) => typeof text !== 'string'
        || !(key === 'homeAssistant' ? IDENTITY_FIELDS.has(field) : ['device_class', 'friendly_name'].includes(field)))) throw new Held('malformed');
    } else if (typeof item !== 'string') throw new Held('malformed');
  }
  if (typeof value.kind !== 'string' || typeof value.title !== 'string') throw new Held('malformed');
}
function checkedInputs(inputs: readonly HomeGraphQualityInput[]): readonly HomeGraphQualityInput[] {
  assertJudgmentInput(inputs);
  if (!Array.isArray(inputs) || inputs.length > LIMITS.devices) throw new Held('budget');
  const refs = new Set<string>();
  for (const input of inputs) {
    if (!record(input) || Object.keys(input).some((key) => !['reference', 'subject', 'entities', 'facts', 'questions'].includes(key))
      || typeof input.reference !== 'string' || !/^device-[1-9]\d*$/.test(input.reference) || refs.has(input.reference)
      || !Array.isArray(input.entities) || !Array.isArray(input.facts) || !Array.isArray(input.questions)
      || new Set(input.questions).size !== input.questions.length || input.questions.some((key) => !Object.hasOwn(homeGraphQualityBatteries, key))) throw new Held('malformed');
    refs.add(input.reference);
    if (input.entities.length > LIMITS.entities || input.facts.length > LIMITS.facts) throw new Held('budget');
    checkSubject(input.subject);
    input.entities.forEach((entity) => checkSubject(entity, true));
    for (const fact of input.facts) {
      if (!record(fact) || Object.keys(fact).some((key) => !['reference', 'title', 'summary', 'value', 'evidence', 'labels'].includes(key))
        || typeof fact.reference !== 'string' || !/^fact-[1-9]\d*$/.test(fact.reference)) throw new Held('malformed');
      for (const [key, value] of Object.entries(fact)) {
        if (key === 'value' || key === 'evidence') {
          if (value !== null && typeof value !== 'string' && typeof value !== 'boolean'
            && !(typeof value === 'number' && Number.isFinite(value))) throw new Held('malformed');
        } else if (key === 'labels' ? !Array.isArray(value) || value.some((label) => typeof label !== 'string') : typeof value !== 'string') throw new Held('malformed');
      }
    }
  }
  return freezeSupport(structuredClone(inputs));
}
function validatedPort(port: JudgmentPort): JudgmentPort {
  return { ...port, model: port.model, async ask(request) {
    const result = await port.ask(request);
    if (!result?.answers || typeof result.model !== 'string' || !result.model.trim()
      || typeof result.requestedModel !== 'string' || !result.requestedModel.trim()
      || (result.decisionId !== undefined && (typeof result.decisionId !== 'string' || !result.decisionId.trim()))) throw new Held('malformed');
    for (const name of Object.keys(request.questions)) {
      const answer: unknown = result.answers[name];
      if (!record(answer) || answer.type !== 'noul' || typeof answer.noul !== 'number'
        || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) throw new Held('malformed');
    }
    return result;
  } };
}
/** Complete protected-input preflight precedes every request; no partial reading pass is returned. */
export async function readHomeGraphQuality(inputs: readonly HomeGraphQualityInput[], options: {
  readonly signal?: AbortSignal | undefined; readonly timeoutMs?: number | undefined; readonly assertCurrent?: (() => void) | undefined;
} = {}): Promise<readonly HomeGraphQualityReading[]> {
  if (options.signal?.aborted) throw new Held('aborted');
  const original = retainStrictJudgmentJson(inputs, () => new JudgmentInputError('unsupported-input'));
  const snapshots = checkedInputs(inputs);
  const callerSignal = options.signal, callerCurrent = options.assertCurrent;
  let owner: JudgmentPortCapture | undefined;
  if (!snapshots.length) return [];
  const timeoutMs = options.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > LIMITS.timeoutMs)) throw new Held('budget');
  const controller = new AbortController();
  let held: Held | undefined;
  let rejectStopped: (error: Held) => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
  const stop = (error: Held) => { held ??= error; controller.abort(); rejectStopped(held); };
  const abort = () => stop(new Held('aborted'));
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => stop(new Held('budget')), timeoutMs);
  const checkSource = () => {
    if (held) throw held; if (callerSignal?.aborted) throw new Held('aborted');
    try { original.assertCurrent(); } catch { throw new Held('stale'); }
    // Preserve the caller's typed stale-fact signal so its bounded recovery
    // can re-read changed evidence; never turn it into a generic page failure.
    callerCurrent?.();
  };
  const check = () => { checkSource(); try { owner?.assertCurrent(); } catch { throw new Held('stale'); } };
  const run = async () => {
    check();
    // Fully structural passes need no semantic port.
    if (snapshots.some(input => input.questions.length)) owner = captureJudgmentPort('engine.knowledge.homegraph-quality', { signal: controller.signal, assertCurrent: checkSource,
      prepareResultCapture: questions => prepareJudgmentResult(questions, reason => new Held(reason)) });
    const port = owner ? validatedPort(owner.port) : undefined;
    const readings: HomeGraphQualityReading[] = []; let next = 0;
    await Promise.all(Array.from({ length: Math.min(LIMITS.concurrency, snapshots.length) }, async () => {
      while (next < snapshots.length) {
        check(); const index = next++; const input = snapshots[index]!;
        const { questions, ...projected } = input;
        const state = freezeSupport(toJson(projected) as Record<string, JsonValue>);
        const answers: Partial<Record<typeof questions[number], boolean>> = {};
        const provenance: Partial<Record<typeof questions[number], NonNullable<HomeGraphQualityReading['provenance'][typeof questions[number]]>>> = {};
        const decisionIds: string[] = [], batteries: { name: string; version: number }[] = [];
        let model: string | undefined, requestedModel: string | undefined;
        if (questions.length) {
          check();
          try {
            const parts = Object.fromEntries(questions.map(question => [question, homeGraphQualityBatteries[question]]));
            const read = await fanOut(port!, state, parts, { signal: controller.signal, site: 'engine.knowledge.homegraph-quality', beforeAttempt: check });
            check();
            model = read.result.model; requestedModel = read.result.requestedModel;
            for (const question of questions) {
              const battery = homeGraphQualityBatteries[question];
              const reading = Object.values(read.readings[question]!)[0] as YesNoReading;
              if (reading.outcome !== 'act' || reading.verdict === 'uncertain') throw new Held('unsettled');
              answers[question] = reading.verdict === 'yes';
              provenance[question] = { battery: battery.name, version: battery.version, probability: reading.probability,
                decisionId: read.result.decisionId, model, requestedModel };
              batteries.push({ name: battery.name, version: battery.version });
            }
            if (read.result.decisionId) decisionIds.push(read.result.decisionId);
            read.recordAction('settled derived-quality readings; no write or operator authority granted');
          } catch (error) { checkSource(); const failure = error instanceof Held ? error : new Held('unavailable'); stop(failure); throw failure; }
        }
        readings[index] = { assertCurrent: check, reference: input.reference, answers, provenance, decisionIds, batteries, model, requestedModel };
      }
    }));
    check(); return freezeSupport(readings);
  };
  try { return await Promise.race([run(), stopped]); }
  catch (error) { controller.abort(); throw error instanceof Held || error instanceof JudgmentInputError ? error
    : new Held(error instanceof JudgmentPortMissingError ? 'unconfigured' : error instanceof JudgmentAuthorityRetiredError ? 'stale' : 'unavailable'); }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
}

import { judgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { toJson, type JudgmentPort, type YesNoReading, type JsonValue } from '@goodvibes-jev/judgment';
import { assertJudgmentInput } from '../../../gate/judgment-input.js';
import { freezeSupport } from '../../semantic/verification/projection.js';
import { homeGraphTriageApplicability, homeGraphBatteryFacts, homeGraphManualFact } from './batteries.js';
import { HomeGraphTriageHeldError as Held, TRIAGE_READING_LIMITS as LIMITS, type TriageReadInput, type TriageReadingPlan } from './types.js';
export * from './types.js';

const SUBJECT_FIELDS = new Set(['kind', 'title', 'summary', 'aliases', 'manufacturer', 'model', 'homeAssistant', 'batteryPowered', 'batteryType', 'manualRequired']);
const IDENTITY_FIELDS = new Set(['objectKind', 'objectId', 'entityId', 'deviceId', 'integrationId']);
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function checkedInput(inputs: readonly TriageReadInput[]): readonly TriageReadInput[] {
  assertJudgmentInput(inputs);
  if (!Array.isArray(inputs) || inputs.length > LIMITS.inputs) throw new Held('budget');
  const refs = new Set<string>();
  for (const input of inputs) {
    if (!record(input) || Object.keys(input).some((key) => !['reference', 'issue', 'subject', 'ruleGuidance'].includes(key))
      || typeof input.reference !== 'string' || !/^issue-[1-9]\d*$/.test(input.reference) || refs.has(input.reference)
      || !record(input.issue) || Object.keys(input.issue).some((key) => !['code', 'message', 'severity'].includes(key))
      || ![input.issue.code, input.issue.message, input.issue.severity].every((value) => typeof value === 'string')
      || (input.ruleGuidance !== undefined && typeof input.ruleGuidance !== 'string')) throw new Held('malformed');
    refs.add(input.reference);
    if (input.subject !== undefined) {
      if (!record(input.subject) || Object.keys(input.subject).some((key) => !SUBJECT_FIELDS.has(key))) throw new Held('malformed');
      for (const [key, value] of Object.entries(input.subject)) {
        if (key === 'aliases') {
          if (!Array.isArray(value)) throw new Held('malformed');
          for (const alias of value) if (typeof alias !== 'string') throw new Held('malformed');
        } else if (key === 'homeAssistant') {
          if (!record(value) || Object.entries(value).some(([name, item]) => !IDENTITY_FIELDS.has(name) || typeof item !== 'string')) throw new Held('malformed');
        } else if (['batteryPowered', 'manualRequired'].includes(key)) {
          if (typeof value !== 'boolean') throw new Held('malformed');
        } else if (typeof value !== 'string') throw new Held('malformed');
      }
    }
  }
  return freezeSupport(structuredClone(inputs));
}
function jsonState(value: object): Record<string, JsonValue> {
  const state = toJson(value);
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Held('malformed');
  return freezeSupport(state);
}
function validatedPort(port: JudgmentPort): JudgmentPort {
  return { ...port, model: port.model, async ask(request) {
    const result = await port.ask(request);
    if (!result?.answers || typeof result.model !== 'string' || !result.model
      || typeof result.requestedModel !== 'string' || !result.requestedModel
      || (result.decisionId !== undefined && (typeof result.decisionId !== 'string' || !result.decisionId.trim()))) throw new Held('malformed');
    for (const [name, question] of Object.entries(request.questions)) {
      const answer: unknown = result.answers[name];
      if (!record(answer) || answer.type !== question.type) throw new Held('malformed');
      if (question.type === 'noul') {
        if (typeof answer.noul !== 'number' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) throw new Held('malformed');
      } else if (question.type === 'choice') {
        if (typeof answer.choice !== 'string' || !Object.hasOwn(question.criteria, answer.choice)
          || typeof answer.confidence !== 'number' || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1
          || !record(answer.probabilities)) throw new Held('malformed');
        const probabilityMap = answer.probabilities;
        const probabilities = Object.keys(question.criteria).map((key) => probabilityMap[key]);
        if (probabilities.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
          || Math.abs((probabilities as number[]).reduce((sum, value) => sum + value, 0) - 1) > 0.00001
          || Math.abs(Number(probabilityMap[answer.choice]) - answer.confidence) > 0.00001) throw new Held('malformed');
      }
    }
    return result;
  } };
}
function requireFact(reading: YesNoReading): void {
  if (reading.outcome !== 'act' || reading.verdict === 'uncertain') throw new Held('unsettled');
  if (reading.verdict !== 'yes') throw new Held('unsupported-fact');
}

/** Whole selected pass is read-only. No plan returns until every reading settles. */
export async function prepareHomeGraphTriageReadings(inputs: readonly TriageReadInput[], options: {
  readonly signal?: AbortSignal | undefined; readonly timeoutMs?: number | undefined;
  /** Owner policy may be stricter; it can never weaken the registered high-stakes band. */
  readonly minConfidence?: number | undefined;
} = {}): Promise<readonly TriageReadingPlan[]> {
  if (options.signal?.aborted) throw new Held('aborted');
  const snapshots = checkedInput(inputs);
  if (!snapshots.length) return Object.freeze([]);
  const timeoutMs = options.timeoutMs ?? LIMITS.defaultTimeoutMs;
  const minimum = options.minConfidence ?? 85;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > LIMITS.timeoutMs || !Number.isFinite(minimum)) throw new Held('budget');
  const minProbability = Math.max(85, Math.min(100, Math.max(0, minimum))) / 100;
  const controller = new AbortController();
  let held: Held | undefined;
  let rejectStopped: (error: Held) => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
  const stop = (error: Held) => { held ??= error; controller.abort(); rejectStopped(held); };
  const abort = () => stop(new Held('aborted'));
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => stop(new Held('budget')), timeoutMs);
  const check = () => { if (held) throw held; if (options.signal?.aborted) throw new Held('aborted'); };
  const run = async () => {
    check(); const port = validatedPort(judgmentPort('engine.knowledge.homegraph-triage'));
    const settings = { signal: controller.signal, site: 'engine.knowledge.homegraph-triage' };
    const plans: TriageReadingPlan[] = []; let next = 0;
    await Promise.all(Array.from({ length: Math.min(LIMITS.concurrency, snapshots.length) }, async () => {
      while (next < snapshots.length) {
        check(); const index = next++; const input = snapshots[index]!;
        try {
          const applicable = await homeGraphTriageApplicability.run(port, jsonState(input), settings); check();
          const action = applicable.readings.action;
          if (action.outcome !== 'act') throw new Held('unsettled');
          if (action.choice === 'reject' && action.confidence < minProbability) throw new Held('owner-threshold');
          const facts: Record<string, boolean | string> = {};
          const decisionIds = applicable.result.decisionId ? [applicable.result.decisionId] : [];
          const batteries = [{ name: homeGraphTriageApplicability.name, version: homeGraphTriageApplicability.version }];
          if (action.choice === 'reject' && input.issue.code === 'homegraph.device.unknown_battery') {
            const run = await homeGraphBatteryFacts.run(port, jsonState(input), settings); check();
            requireFact(run.readings.notBatteryPowered); requireFact(run.readings.noBatteryType);
            facts.batteryPowered = false; facts.batteryType = 'none';
            if (run.result.decisionId) decisionIds.push(run.result.decisionId);
            if (run.result.model !== applicable.result.model) throw new Held('stale');
            batteries.push({ name: homeGraphBatteryFacts.name, version: homeGraphBatteryFacts.version });
            run.recordAction('verified automatic battery facts; no operator authority or write granted');
          } else if (action.choice === 'reject' && input.issue.code === 'homegraph.device.missing_manual') {
            const run = await homeGraphManualFact.run(port, jsonState(input), settings); check(); requireFact(run.readings.manualNotRequired);
            facts.manualRequired = false;
            if (run.result.decisionId) decisionIds.push(run.result.decisionId);
            if (run.result.model !== applicable.result.model) throw new Held('stale');
            batteries.push({ name: homeGraphManualFact.name, version: homeGraphManualFact.version });
            run.recordAction('verified automatic manual fact; no operator authority or write granted');
          }
          applicable.recordAction(`settled automatic triage ${action.choice}; persistence still requires fresh state and ordinary write authority`);
          plans[index] = { reference: input.reference, action: action.choice, probability: action.confidence,
            facts, decisionIds, model: applicable.result.model, requestedModel: applicable.result.requestedModel,
            origin: 'automatic-judgment', batteries };
        } catch (error) { const failure = error instanceof Held ? error : new Held('unavailable'); stop(failure); throw failure; }
      }
    }));
    check(); return freezeSupport(plans);
  };
  try { return await Promise.race([run(), stopped]); }
  catch (error) { controller.abort(); throw error instanceof Held ? error : new Held(error instanceof JudgmentPortMissingError ? 'unconfigured' : 'unavailable'); }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
}

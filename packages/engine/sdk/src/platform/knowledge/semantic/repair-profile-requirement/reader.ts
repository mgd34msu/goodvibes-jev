import { types as nodeTypes } from 'node:util';
import { captureJudgmentPort, judgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { toJson, type JudgmentPort } from '@goodvibes-jev/judgment';
import { assertJudgmentInput, retainOwnedJson, JudgmentInputError } from '../../../gate/judgment-input.js';
import { prepareJudgmentResult } from '../../../gate/judgment-result.js';
import type { RepairProfileSubject } from '../repair-profile/types.js';
import { REPAIR_FACT_USEFULNESS_LIMITS as LIMITS } from '../repair-usefulness/types.js';
import { KnowledgeRepairFactScoringHeldError as Held, type RepairFactScoringOptions } from '../repair-fact-scoring/types.js';
import { freezeSupport } from '../verification/projection.js';
import { repairProfileRequirement } from './battery.js';

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export async function prepareRepairProfileRequirement(input: { readonly query: string; readonly subjects: readonly RepairProfileSubject[] }, options: RepairFactScoringOptions = {}) {
  const { signal, assertCurrent: ownerCurrent, timeoutMs: configuredTimeout } = options;
  assertJudgmentInput(input);
  const originals = retainOwnedJson(input, nodeTypes.isProxy), state = toJson(input);
  if (!state || typeof state !== 'object' || Array.isArray(state) || typeof input.query !== 'string' || !Array.isArray(input.subjects)) throw new Held('malformed');
  if (Object.keys(input).some(key => key !== 'query' && key !== 'subjects')) throw new Held('malformed');
  for (const subject of input.subjects) {
    if (!record(subject) || typeof subject.title !== 'string' || Object.keys(subject).some(key => !['title', 'kind', 'aliases', 'identity'].includes(key))
      || subject.kind !== undefined && typeof subject.kind !== 'string'
      || subject.aliases !== undefined && (!Array.isArray(subject.aliases) || subject.aliases.some(alias => typeof alias !== 'string'))
      || subject.identity !== undefined && (!record(subject.identity) || Object.keys(subject.identity).some(key => !['manufacturer', 'brand', 'model', 'modelNumber', 'variant', 'entityKind'].includes(key))
        || Object.values(subject.identity).some(value => typeof value !== 'string'))) throw new Held('malformed');
  }
  if (JSON.stringify(state).length > LIMITS.characters || input.subjects.length > LIMITS.inputs) throw new Held('budget');
  const timeoutMs = configuredTimeout ?? LIMITS.defaultTimeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > LIMITS.timeoutMs) throw new Held('budget');
  let failed: Error | undefined;
  const assertOwnerCurrent = () => {
    if (failed) throw failed;
    if (signal?.aborted) throw new Held('aborted');
    if (options.signal !== signal || options.assertCurrent !== ownerCurrent || options.timeoutMs !== configuredTimeout) throw new Held('stale');
    try { originals.assertCurrent(); } catch { throw new Held('stale'); }
    const result: unknown = ownerCurrent?.();
    if (result !== undefined) { try { void Promise.resolve(result).catch(() => {}); } catch { /* Restriction only. */ } throw new Held('stale'); }
    if (options.signal !== signal || options.assertCurrent !== ownerCurrent || options.timeoutMs !== configuredTimeout || signal?.aborted) throw new Held('stale');
    try { originals.assertCurrent(); } catch { throw new Held('stale'); }
  };
  assertOwnerCurrent();
  const admission = prepareJudgmentResult({ fullProfileRequired: repairProfileRequirement.items.fullProfileRequired.question }, problem => new Held(problem));
  const controller = new AbortController();
  let rejectStopped: (error: Error) => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
  const stop = (error: Error) => { failed ??= error; controller.abort(); rejectStopped(failed); };
  const abort = () => stop(new Held('aborted'));
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => stop(new Held('budget')), timeoutMs);
  try {
    const authority = captureJudgmentPort(repairProfileRequirement.name, { signal: controller.signal, assertCurrent: assertOwnerCurrent });
    const configured = judgmentPort(repairProfileRequirement.name), configuredModel = configured.model;
    if (typeof configuredModel !== 'string' || !configuredModel.trim()) throw new Held('malformed');
    const assertCurrent = () => {
      assertOwnerCurrent(); admission.assertCurrent();
      try { authority.assertCurrent(); if (judgmentPort(repairProfileRequirement.name) !== configured || configured.model !== configuredModel) throw new Held('stale'); }
      catch (error) { throw error instanceof Held ? error : new Held('stale'); }
    };
    const port: JudgmentPort = { model: configuredModel, ...(authority.port.recorder === undefined ? {} : { recorder: authority.port.recorder }), async ask(request) {
      assertCurrent(); const original = await authority.port.ask({ ...request, model: configuredModel }); assertCurrent();
      const result = admission.capture(original);
      const answer = result.answers.fullProfileRequired;
      if (!answer || answer.type !== 'noul' || typeof answer.noul !== 'number' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1
        || typeof result.model !== 'string' || !result.model.trim() || result.requestedModel !== configuredModel
        || result.decisionId !== undefined && (typeof result.decisionId !== 'string' || !result.decisionId.trim())) throw new Held('malformed');
      return { ...result, answers: { ...result.answers, fullProfileRequired: Object.freeze({ type: 'noul' as const, noul: answer.noul }) } };
    } };
    const work = async () => {
      const result = await repairProfileRequirement.run(port, freezeSupport(state), { signal: controller.signal, site: repairProfileRequirement.name });
      assertCurrent(); const reading = result.readings.fullProfileRequired;
      if (reading.outcome !== 'act' || reading.verdict === 'uncertain') throw new Held('uncertain');
      result.recordAction(`settled full-profile requirement ${reading.verdict}; the exact accepted fact set still requires a separate complete-gap reading`);
      assertCurrent(); return Object.freeze({ fullProfileRequired: reading.verdict === 'yes', assertCurrent });
    };
    return await Promise.race([work(), stopped]);
  } catch (error) { failed ??= error instanceof Held || error instanceof JudgmentInputError ? error : new Held(error instanceof JudgmentPortMissingError ? 'unconfigured' : 'unavailable'); throw failed; }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

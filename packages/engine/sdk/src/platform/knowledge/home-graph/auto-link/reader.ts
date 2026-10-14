import { prepareJudgmentResult, retainStrictJudgmentJson, JudgmentResultAdmissionError } from '../../../gate/judgment-result.js';
import { captureJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { checkAnswers, toJson, type JsonValue, type JudgmentPort } from '@goodvibes-jev/judgment';
import { assertJudgmentInput, JudgmentInputError } from '../../../gate/judgment-input.js';
import { withSupportBudget } from '../../semantic/support-budget.js';
import { KnowledgeGeneratedFactSupportHeldError } from '../../semantic/verification/types.js';
import { freezeSupport } from '../../semantic/verification/projection.js';
import { homeGraphDocumentKind, homeGraphDocumentSubject } from './battery.js';
export class HomeGraphAutoLinkHeldError extends Error {
  constructor(readonly reason: 'stale' | 'aborted' | 'budget' | 'malformed' | 'uncertain' | 'unavailable' | 'ambiguous') {
    super(`Home Graph automatic link held: ${reason}`); this.name = 'HomeGraphAutoLinkHeldError';
  }
}
const Held = HomeGraphAutoLinkHeldError;
export interface AutoLinkReadingInput {
  readonly source: unknown;
  readonly candidates: readonly { readonly reference: string; readonly subject: unknown; readonly entities: readonly unknown[] }[];
}
export type AutoLinkRelation = 'has_receipt' | 'has_warranty' | 'has_manual' | 'source_for';
function validatedPort(port: JudgmentPort): JudgmentPort {
  return { ...port, model: port.model, async ask(request) {
    const result = await port.ask(request);
    if (!result?.answers || typeof result.model !== 'string' || !result.model
      || typeof result.requestedModel !== 'string' || !result.requestedModel
      || (result.decisionId !== undefined && (typeof result.decisionId !== 'string' || !result.decisionId.trim()))) throw new Held('malformed');
    try { checkAnswers(request.questions, result.answers); }
    catch { throw new Held('malformed'); }
    return result;
  } };
}

/** Capture once, before the first await. The installation lifetime detects port ABA. */
export function createHomeGraphAutoLinkReader() {
  let installation: ReturnType<typeof captureJudgmentPort> | undefined;
  try { installation = captureJudgmentPort('engine.knowledge.homegraph-document-subject', { prepareResultCapture: prepareJudgmentResult }); } catch (error) {
    if (!(error instanceof JudgmentPortMissingError)) throw error;
  }
  const model = installation?.port.model;
  const assertCurrent = () => {
    if (!installation) throw new Held('unavailable');
    try { installation.assertCurrent();
      if (installation.signal.aborted || installation.port.model !== model) throw new Held('stale');
    } catch { throw new Held('stale'); }
  };
  const provenance = new WeakMap<object, { readonly judgmentDecisionIds: readonly string[]; readonly requestedModel: string; readonly model: string }>();
  return { assertCurrent, provenance(selection: object) { assertCurrent(); return provenance.get(selection); }, async read(input: AutoLinkReadingInput, options: {
    readonly signal?: AbortSignal | undefined; readonly assertCurrent: () => void;
  }): Promise<{ readonly reference: string; readonly relation: AutoLinkRelation } | undefined> {
    // This is deliberately before caps, candidate generation and model acquisition.
    assertJudgmentInput(input);
    if (input.candidates.length > 128 || JSON.stringify(input).length > 256_000) throw new Held('budget');
    const original = retainStrictJudgmentJson(input);
    const snapshot = freezeSupport(structuredClone(input));
    const callerCurrent = options.assertCurrent, callerSignal = options.signal;
    if (!snapshot.candidates.length) return undefined;
    const check = () => {
      if (options.assertCurrent !== callerCurrent || options.signal !== callerSignal) throw new Held('stale');
      if (callerSignal?.aborted) throw new Held('aborted');
      const checked: unknown = callerCurrent();
      if (checked !== undefined) { void Promise.resolve(checked).catch(() => {}); throw new Held('stale'); }
      assertCurrent(); original.assertCurrent();
    };
    try { return await withSupportBudget(async (signal) => {
      const current = () => { check(); if (signal.aborted) throw new Held('aborted'); };
      current(); const port = validatedPort(installation!.port);
      const state = (value: object) => freezeSupport(toJson(value) as Record<string, JsonValue>);
      const kind = await homeGraphDocumentKind.run(port, state({ source: snapshot.source }), { signal, beforeAttempt: current, site: homeGraphDocumentKind.name });
      current();
      for (const reading of [kind.readings.manual, kind.readings.integrationDocumentation])
        if (reading.outcome !== 'act' || reading.verdict === 'uncertain') throw new Held('uncertain');
      const relation = kind.readings.relation;
      if (relation.outcome !== 'act' || !relation.choice) throw new Held('uncertain');
      if ((relation.choice === 'has_manual') !== (kind.readings.manual.verdict === 'yes')) throw new Held('uncertain');
      kind.recordAction('settled document purpose; no permission or provenance authority');
      const decisionIds: string[] = kind.result.decisionId ? [kind.result.decisionId] : [];
      const selected: string[] = [];
      for (const candidate of snapshot.candidates) {
        current();
        const result = await homeGraphDocumentSubject.run(port, state({ ...snapshot, candidate,
          documentKind: { manual: kind.readings.manual.verdict, integrationDocumentation: kind.readings.integrationDocumentation.verdict } }),
          { signal, beforeAttempt: current, site: homeGraphDocumentSubject.name });
        current();
        if (result.result.model !== kind.result.model || result.result.requestedModel !== kind.result.requestedModel) throw new Held('stale');
        if (result.result.decisionId) decisionIds.push(result.result.decisionId);
        const reading = result.readings.selected;
        if (reading.outcome !== 'act' || reading.verdict === 'uncertain') throw new Held('uncertain');
        if (reading.verdict === 'yes') selected.push(candidate.reference);
        result.recordAction(`settled subject ${reading.verdict}; exact IDs and write policy remain local`);
      }
      current();
      if (selected.length > 1) throw new Held('ambiguous');
      if (!selected[0]) return undefined;
      const selection = Object.freeze({ reference: selected[0], relation: relation.choice as AutoLinkRelation });
      provenance.set(selection, Object.freeze({ judgmentDecisionIds: Object.freeze(decisionIds), requestedModel: kind.result.requestedModel, model: kind.result.model }));
      return selection;
    }, 30_000, AbortSignal.any([installation!.signal, ...(options.signal ? [options.signal] : [])])); }
    catch (error) { if (error instanceof Held || error instanceof JudgmentInputError) throw error;
      if (error instanceof JudgmentResultAdmissionError) throw new Held(error.problem);
      if (options.signal?.aborted) throw new Held('aborted');
      assertCurrent();
      if (error instanceof KnowledgeGeneratedFactSupportHeldError && (error.reason === 'budget' || error.reason === 'aborted')) throw new Held(error.reason);
      throw new Held('unavailable'); }
  } };
}

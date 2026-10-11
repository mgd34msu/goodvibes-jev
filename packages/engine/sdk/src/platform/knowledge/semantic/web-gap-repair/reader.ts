import { admitRepairJson, prepareRepairJudgmentResult } from './admission.js';
import { captureJudgmentPort, JudgmentAuthorityRetiredError, JudgmentPortMissingError, type JudgmentPortCapture } from '@goodvibes-jev/engine/errors';
import { toJson, type Candidate, type JsonValue, type JudgmentPort } from '@goodvibes-jev/judgment';
import { JudgmentInputError } from '../../../gate/judgment-input.js';
import { webGapQuery, webGapRelevance } from './battery.js';
import { repairSourceAuthority } from '../repair-source-authority/battery.js';
import { freezeSupport } from '../verification/projection.js';
import { KnowledgeWebGapRepairHeldError as Held, WEB_GAP_REPAIR_LIMITS as LIMITS } from './types.js';
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
export function createWebGapReadings(options: { readonly signal: AbortSignal; readonly assertCurrent: () => void }) {
  const captures = new Map<string, JudgmentPortCapture>();
  const models = new Map<string, string>();
  let failure: Error | undefined, requests = 0, bytes = 0;
  const failed = (error: unknown): Error => error instanceof Held || error instanceof JudgmentInputError ? error
    : new Held(error instanceof JudgmentPortMissingError ? 'unconfigured' : error instanceof JudgmentAuthorityRetiredError ? 'stale' : 'unavailable');
  const assertCurrent = () => {
    if (failure) throw failure;
    if (options.signal.aborted) throw new Held('aborted');
    options.assertCurrent();
    for (const capture of captures.values()) { try { capture.assertCurrent(); } catch { throw new Held('stale'); } }
  };
  const state = (value: object): Record<string, JsonValue> => {
    const snapshot = admitRepairJson(value);
    const json = freezeSupport(toJson(snapshot));
    if (!record(json)) throw new Held('malformed');
    if (JSON.stringify(json).length > LIMITS.characters) throw new Held('budget');
    return json as Record<string, JsonValue>;
  };
  const port = (site: string): JudgmentPort => {
    assertCurrent();
    let captured = captures.get(site);
    if (!captured) { captured = captureJudgmentPort(site, { ...options, prepareResultCapture: prepareRepairJudgmentResult }); captures.set(site, captured); }
    const owned = captured.port, model = owned.model;
    if (!model.trim()) throw new Held('malformed');
    return { model, ...(owned.recorder ? { recorder: owned.recorder } : {}), async ask(request) {
      assertCurrent();
      bytes += new TextEncoder().encode(JSON.stringify({ state: request.state, questions: request.questions })).byteLength + 1024;
      if (++requests > LIMITS.requests || bytes > LIMITS.bytes) throw new Held('budget');
      const result = await owned.ask({ ...request, model, signal: options.signal });
      assertCurrent();
      // The captured port already admitted every original field against its frozen schema.
      const copied = result;
      if (!record(copied) || !record(copied.answers) || typeof copied.model !== 'string' || !copied.model.trim()
        || copied.requestedModel !== model || (copied.decisionId !== undefined && (typeof copied.decisionId !== 'string' || !copied.decisionId.trim()))) throw new Held('malformed');
      const previous = models.get(site);
      if (previous !== undefined && previous !== copied.model) throw new Held('stale');
      models.set(site, copied.model);

      return { ...copied, answers: copied.answers as typeof result.answers, model: copied.model, requestedModel: model };
    } };
  };
  async function run<T>(work: () => Promise<T>): Promise<T> {
    try { assertCurrent(); const value = await work(); assertCurrent(); return value; }
    catch (error) { failure ??= failed(error); throw failure; }
  }
  return {
    assertCurrent,
    preflight: state,
    query(context: object, candidates: readonly Candidate[]) { return run(async () => {
      const complete = state({ context, candidates });
      if (candidates.length > LIMITS.candidates) throw new Held('budget');
      if (!candidates.length) return undefined;
      const selection = await webGapQuery.select(port(webGapQuery.name), complete.context!, candidates, { signal: options.signal, site: webGapQuery.name });
      assertCurrent();
      if (selection.outcome !== 'act') throw new Held('uncertain');
      selection.recordAction(selection.chosen ? 'selected complete original web query; caller retains effect authority' : 'no grounded offered web query');
      return selection.chosen;
    }); },
    source(context: object, source: object) { return run(async () => {
      const input = state({ context, source });
      const relevant = await webGapRelevance.run(port(webGapRelevance.name), input, { signal: options.signal, site: webGapRelevance.name });
      assertCurrent(); const relevance = relevant.readings.relevant;
      if (relevance.outcome !== 'act') throw new Held('uncertain');
      relevant.recordAction(relevance.verdict === 'yes' ? 'relevant discovery candidate; no fact support or permission conferred' : 'irrelevant discovery candidate');
      if (relevance.verdict !== 'yes') return { relevant: false as const, confidence: 100 * relevance.probability, authority: 'secondary' as const };
      // Reuse the existing registered authority question, preserving complete context.
      const authority = await repairSourceAuthority.run(port(repairSourceAuthority.name), input, { signal: options.signal, site: repairSourceAuthority.name });
      assertCurrent(); const role = authority.readings.authority;
      if (role.outcome !== 'act') throw new Held('uncertain');
      authority.recordAction(`discovery publisher role ${role.choice}; not fact support or effect permission`);
      return { relevant: true as const, confidence: 100 * relevance.probability, authority: role.choice };
    }); },
  };
}

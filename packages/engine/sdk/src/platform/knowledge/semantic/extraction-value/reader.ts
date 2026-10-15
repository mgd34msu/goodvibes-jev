import { types as nodeTypes } from 'node:util';
import { captureJudgmentPort, JudgmentAuthorityRetiredError, JudgmentPortMissingError, type JudgmentPortCapture } from '@goodvibes-jev/engine/errors';
import { readYesNo, toJson } from '@goodvibes-jev/judgment';
import { assertJudgmentInput, JudgmentInputError } from '../../../gate/judgment-input.js';
import { prepareJudgmentResult, retainStrictJudgmentJson } from '../../../gate/judgment-result.js';
import { freezeSupport } from '../verification/projection.js';
import { knowledgeExtractionValue } from './battery.js';
import { EXTRACTION_VALUE_LIMITS as LIMITS, KnowledgeExtractionValueHeldError as Held,
  type KnowledgeExtractionValueInput, type KnowledgeExtractionValueOptions } from './types.js';

export * from './types.js';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}
function optionalText(value: unknown): boolean { return value === undefined || typeof value === 'string'; }

/** One original source and one reading, retained through the caller's publication. */
export function prepareKnowledgeExtractionValueReading(input: KnowledgeExtractionValueInput, options: KnowledgeExtractionValueOptions) {
  if (!record(options) || nodeTypes.isProxy(options)) throw new Held('malformed');
  const optionPrototype: unknown = Object.getPrototypeOf(options);
  if (optionPrototype !== Object.prototype && optionPrototype !== null) throw new Held('malformed');
  const optionDescriptors = Object.getOwnPropertyDescriptors(options);
  if (Object.getOwnPropertySymbols(options).length || Object.keys(optionDescriptors).some(key => !['signal', 'assertCurrent', 'timeoutMs'].includes(key))
    || Object.values(optionDescriptors).some(descriptor => !descriptor.enumerable || !('value' in descriptor))
    || !Object.hasOwn(optionDescriptors, 'assertCurrent') || typeof options.assertCurrent !== 'function'
    || ['signal', 'timeoutMs'].some(key => key in options && !Object.hasOwn(optionDescriptors, key))) throw new Held('malformed');
  const signal = Object.hasOwn(optionDescriptors, 'signal') ? options.signal : undefined;
  const callerCurrent = options.assertCurrent;
  const configuredTimeout = Object.hasOwn(optionDescriptors, 'timeoutMs') ? options.timeoutMs : undefined;
  const timeoutMs = configuredTimeout ?? 0;
  const retained = retainStrictJudgmentJson(input, problem => new Held(problem));
  // Full source content is screened before bounds, projection or port acquisition.
  assertJudgmentInput(retained.snapshot);
  const snapshot: unknown = retained.snapshot;
  if (!record(snapshot) || !keys(snapshot, ['source', 'extraction', 'text']) || typeof snapshot.text !== 'string') throw new Held('malformed');
  const source = snapshot.source, extraction = snapshot.extraction;
  if (!record(source) || !keys(source, ['title', 'summary', 'description', 'uri', 'sourceType', 'status', 'trust', 'claimedProvenance'])
    || !['title', 'summary', 'description', 'uri', 'sourceType', 'status', 'trust'].every(key => typeof source[key] === 'string')
    || !record(source.claimedProvenance) || !keys(source.claimedProvenance, ['reason', 'domain'])
    || typeof source.claimedProvenance.reason !== 'string' || typeof source.claimedProvenance.domain !== 'string'
    || !record(extraction) || !keys(extraction, ['format', 'title', 'summary', 'excerpt', 'sections'])
    || typeof extraction.format !== 'string' || ![extraction.title, extraction.summary, extraction.excerpt].every(optionalText)
    || !Array.isArray(extraction.sections) || !extraction.sections.every(section => typeof section === 'string')) throw new Held('malformed');
  const json = toJson(snapshot);
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Held('malformed');
  const state = freezeSupport(json);
  const items = knowledgeExtractionValue.items;
  const item = retainStrictJudgmentJson(items, problem => new Held(problem));
  const band = freezeSupport(item.snapshot.extractionValue.band);
  const question = freezeSupport(item.snapshot.extractionValue.question);
  const body = JSON.stringify({ state, questions: { extractionValue: question } });
  if (JSON.stringify(state).length > LIMITS.characters || new TextEncoder().encode(body).byteLength + 1_024 > LIMITS.bytes
    || !Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > LIMITS.timeoutMs) throw new Held('budget');

  let authority: JudgmentPortCapture | undefined;
  let failure: Error | undefined;
  let reading: Promise<boolean> | undefined;
  const held = (error: unknown): Error => error instanceof Held || error instanceof JudgmentInputError ? error
    : new Held(error instanceof JudgmentPortMissingError ? 'unconfigured' : error instanceof JudgmentAuthorityRetiredError ? 'stale' : 'unavailable');
  const checkOriginal = () => {
    if (signal?.aborted) throw new Held('aborted');
    if (Object.getPrototypeOf(options) !== optionPrototype) throw new Held('stale');
    for (const key of ['signal', 'assertCurrent', 'timeoutMs']) {
      const original = optionDescriptors[key], current = Object.getOwnPropertyDescriptor(options, key);
      if ((original === undefined) !== (current === undefined) || original?.value !== current?.value || original?.get !== current?.get
        || original?.set !== current?.set || original?.enumerable !== current?.enumerable || original?.configurable !== current?.configurable
        || original?.writable !== current?.writable || (!current && key in options)) throw new Held('stale');
    }
    if (knowledgeExtractionValue.items !== items) throw new Held('stale');
    retained.assertCurrent(); item.assertCurrent();
  };
  const assertOwnerCurrent = () => {
    checkOriginal();
    const result: unknown = callerCurrent();
    if (result !== undefined) {
      try { void Promise.resolve(result).catch(() => {}); } catch { /* A callback result cannot authorize a reading. */ }
      throw new Held('stale');
    }
    checkOriginal();
  };
  const assertCurrent = () => {
    if (failure) throw failure;
    try { if (authority) authority.assertCurrent(); else assertOwnerCurrent(); }
    catch (error) { failure = held(error); throw failure; }
  };
  const read = (): Promise<boolean> => reading ??= (async () => {
    assertCurrent();
    const controller = new AbortController();
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    try {
      authority = captureJudgmentPort(knowledgeExtractionValue.name, {
        signal: AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]), assertCurrent: assertOwnerCurrent,
        prepareResultCapture: questions => {
          const frame = prepareJudgmentResult(questions, problem => new Held(problem));
          return { ...frame, capture(original) {
            const result = frame.capture(original);
            if (typeof result.model !== 'string' || !result.model.trim() || typeof result.requestedModel !== 'string'
              || result.requestedModel !== authority?.port.model
              || (result.decisionId !== undefined && (typeof result.decisionId !== 'string' || !result.decisionId.trim()))) throw new Held('malformed');
            return result;
          } };
        },
      });
      assertCurrent();
      const run = await knowledgeExtractionValue.run(authority.port, state, {
        site: knowledgeExtractionValue.name, signal: authority.signal, beforeAttempt: assertCurrent,
      });
      assertCurrent();
      // Use the original copied calibration, never a borrowed band changed while awaiting.
      const value = readYesNo({ type: 'noul', noul: run.readings.extractionValue.probability }, band);
      if (value.outcome !== 'act' || value.verdict === 'uncertain') {
        run.recordAction('hold extraction-value reading; no extraction or publication');
        throw new Held('uncertain');
      }
      run.recordAction(`extraction value ${value.verdict}; attempt eligibility only, no fact or permission authority`);
      assertCurrent();
      return value.verdict === 'yes';
    } catch (error) {
      failure = signal?.aborted ? new Held('aborted') : controller.signal.aborted ? new Held('budget') : held(error);
      throw failure;
    } finally { clearTimeout(timer); }
  })();
  return Object.freeze({ read, assertCurrent });
}

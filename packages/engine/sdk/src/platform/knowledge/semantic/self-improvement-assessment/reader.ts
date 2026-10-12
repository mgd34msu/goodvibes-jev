import { captureJudgmentPort, judgmentPort, JudgmentAuthorityRetiredError, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { toJson } from '@goodvibes-jev/judgment';
import { assertJudgmentInput, JudgmentInputError } from '../../../gate/judgment-input.js';
import { prepareJudgmentResult, retainStrictJudgmentJson } from '../../../gate/judgment-result.js';
import { freezeSupport } from '../verification/projection.js';
import { selfImprovementGapContext, selfImprovementEvidenceCoverage } from './battery.js';
import { KnowledgeSelfImprovementAssessmentHeldError as Held, SELF_IMPROVEMENT_ASSESSMENT_LIMITS as LIMITS,
  type SelfImprovementAssessmentInput, type SelfImprovementAssessmentOptions, type SelfImprovementAssessment } from './types.js';
export * from './types.js';

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function strings(value: unknown): value is readonly string[] { return Array.isArray(value) && value.every(item => typeof item === 'string'); }
function optionalText(value: unknown): boolean { return value === undefined || typeof value === 'string'; }
function snapshotInput(input: SelfImprovementAssessmentInput) {
  const retained = retainStrictJudgmentJson(input, reason => new Held(reason));
  const value = retained.snapshot;
  assertJudgmentInput(value);
  if (!record(value) || Object.keys(value).some(key => !['query', 'subjects', 'facts', 'evidence', 'objectProfiles', 'requestedScope'].includes(key))
    || typeof value.query !== 'string' || !value.query.trim() || !Array.isArray(value.subjects)
    || !Array.isArray(value.facts) || !Array.isArray(value.evidence) || !Array.isArray(value.objectProfiles)) throw new Held('malformed');
  if (value.requestedScope !== undefined && (!record(value.requestedScope)
    || Object.keys(value.requestedScope).length !== 1 || typeof value.requestedScope.fullProfileRequired !== 'boolean')) throw new Held('malformed');
  for (const candidate of [...value.subjects, ...value.facts]) {
    if (!record(candidate) || Object.keys(candidate).some(key => !['title', 'kind', 'aliases', 'summary', 'identity', 'content'].includes(key))
      || typeof candidate.title !== 'string' || typeof candidate.kind !== 'string' || !strings(candidate.aliases)
      || !optionalText(candidate.summary) || !record(candidate.content)) throw new Held('malformed');
  }
  for (const subject of value.subjects) if (!record(subject.identity) || !Object.values(subject.identity).every(item => typeof item === 'string')) throw new Held('malformed');
  for (const evidence of value.evidence) if (!record(evidence) || Object.keys(evidence).some(key => !['source', 'extraction', 'text'].includes(key))
    || !record(evidence.source) || (evidence.extraction !== undefined && !record(evidence.extraction)) || typeof evidence.text !== 'string') throw new Held('malformed');
  for (const profile of value.objectProfiles) if (!record(profile)
    || Object.keys(profile).some(key => !['id', 'subjectKinds', 'intrinsicFactKinds', 'suppressedGapKinds', 'searchHints'].includes(key))
    || typeof profile.id !== 'string' || !strings(profile.subjectKinds)
    || [profile.intrinsicFactKinds, profile.suppressedGapKinds, profile.searchHints].some(item => item !== undefined && !strings(item))) throw new Held('malformed');
  const state = toJson(value);
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Held('malformed');
  const serialized = JSON.stringify(state);
  if (value.subjects.length > LIMITS.subjects || value.facts.length > LIMITS.facts || value.evidence.length > LIMITS.sources
    || value.objectProfiles.length > LIMITS.profiles || serialized.length > LIMITS.characters) throw new Held('budget');
  return { value, state: freezeSupport(state), assertCurrent: retained.assertCurrent };
}

/** A single operation owns the native source frame, installation and exact requested schema. */
export async function readSelfImprovementAssessment(kind: 'context' | 'coverage', input: SelfImprovementAssessmentInput,
  options: SelfImprovementAssessmentOptions = {}): Promise<SelfImprovementAssessment> {
  if (kind !== 'context' && kind !== 'coverage') throw new Held('malformed');
  const { signal, assertCurrent: ownerCurrent, timeoutMs: configuredTimeout } = options;
  const snapshot = snapshotInput(input);
  const timeoutMs = configuredTimeout ?? LIMITS.defaultTimeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > LIMITS.timeoutMs) throw new Held('budget');
  const battery = kind === 'context' ? selfImprovementGapContext : selfImprovementEvidenceCoverage;
  const questions = Object.fromEntries(Object.entries(battery.items).map(([name, item]) => [name, item.question]));
  if (new TextEncoder().encode(JSON.stringify({ state: snapshot.state, questions })).byteLength + 1_024 > LIMITS.bytes) throw new Held('budget');
  let failed: Error | undefined;
  const failure = (error: unknown): Error => error instanceof Held || error instanceof JudgmentInputError ? error
    : new Held(error instanceof JudgmentPortMissingError ? 'unconfigured' : error instanceof JudgmentAuthorityRetiredError ? 'stale' : 'unavailable');
  const assertOriginal = () => {
    if (signal?.aborted) throw new Held('aborted');
    if (options.signal !== signal || options.assertCurrent !== ownerCurrent || options.timeoutMs !== configuredTimeout) throw new Held('stale');
    snapshot.assertCurrent();
    const result: unknown = ownerCurrent?.();
    if (result !== undefined) { try { void Promise.resolve(result).catch(() => {}); } catch { /* Async callbacks cannot authorize a reading. */ } throw new Held('stale'); }
    snapshot.assertCurrent();
    if (signal?.aborted || options.signal !== signal || options.assertCurrent !== ownerCurrent || options.timeoutMs !== configuredTimeout) throw new Held(signal?.aborted ? 'aborted' : 'stale');
  };
  const controller = new AbortController();
  const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let authority: ReturnType<typeof captureJudgmentPort>;
  let configuredModel: string;
  try {
    assertOriginal(); configuredModel = judgmentPort(battery.name).model;
    if (typeof configuredModel !== 'string' || !configuredModel.trim()) throw new Held('malformed');
    authority = captureJudgmentPort(battery.name, { signal: combinedSignal, assertCurrent: assertOriginal,
      prepareResultCapture: questions => prepareJudgmentResult(questions, reason => new Held(reason)) });
  } catch (error) { controller.abort(); throw failure(error); }
  const assertCurrent = () => {
    if (failed) throw failed;
    try { assertOriginal(); authority.assertCurrent(); }
    catch (error) { failed ??= failure(error); throw failed; }
  };
  let rejectStopped: (error: Error) => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
  const stop = (error: Error) => { failed ??= error; controller.abort(); rejectStopped(failed); };
  const abort = () => stop(new Held('aborted'));
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => stop(new Held('budget')), timeoutMs);
  const run = async (): Promise<SelfImprovementAssessment> => {
    assertCurrent();
    const result = kind === 'context'
      ? await selfImprovementGapContext.run(authority.port, snapshot.state, { signal: combinedSignal, site: battery.name, beforeAttempt: assertCurrent })
      : await selfImprovementEvidenceCoverage.run(authority.port, snapshot.state, { signal: combinedSignal, site: battery.name, beforeAttempt: assertCurrent });
    assertCurrent();
    if (typeof result.result.model !== 'string' || !result.result.model.trim() || result.result.requestedModel !== configuredModel
      || (result.result.decisionId !== undefined && (typeof result.result.decisionId !== 'string' || !result.result.decisionId.trim()))) throw new Held('malformed');
    const values = new Map<string, boolean>();
    for (const [name, reading] of Object.entries(result.readings)) {
      if (reading.outcome !== 'act' || (reading.verdict !== 'yes' && reading.verdict !== 'no')) throw new Held('uncertain');
      values.set(name, reading.verdict === 'yes');
    }
    const value = (name: string): boolean => { const selected = values.get(name); if (selected === undefined) throw new Held('malformed'); return selected; };
    const observation = kind === 'context'
      ? { kind: 'context' as const, applicable: value('gapApplicable'), concrete: value('repairContextConcrete') }
      : { kind: 'coverage' as const, sufficient: value('repairEvidenceSufficient') };
    if (observation.kind === 'coverage' && observation.sufficient && snapshot.value.facts.length === 0) throw new Held('malformed');
    assertCurrent();
    result.recordAction('settled self-improvement observation; persistence still requires the original native read-set');
    assertCurrent();
    return Object.freeze({ ...observation, assertCurrent });
  };
  try { return await Promise.race([run(), stopped]); }
  catch (error) { failed ??= failure(error); controller.abort(); throw failed; }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { toJson, type JsonValue, type JudgmentPort } from '@goodvibes-jev/judgment';
import { snapshotJudgmentInput } from '../../../gate/judgment-input.js';
import { freezeSupport, supportHash } from '../verification/projection.js';
import { answerGapAdmission, answerGapEquivalence } from './battery.js';
import { ANSWER_GAP_LIMITS as LIMITS, KnowledgeAnswerGapHeldError as Held, type AnswerGapInput } from './types.js';
export * from './types.js';
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function snapshotAnswerGapInput(input: AnswerGapInput): AnswerGapInput {
  const snapshot = snapshotJudgmentInput(input);
  if (!record(snapshot) || Object.keys(snapshot).some((key) => !['question', 'candidates', 'needsSubject'].includes(key)) || typeof snapshot.needsSubject !== 'boolean' || !record(snapshot.question)
    || typeof snapshot.question.query !== 'string' || !snapshot.question.query.trim() || !Array.isArray(snapshot.candidates)) throw new Held('malformed');
  const references = new Set<string>();
  for (const candidate of snapshot.candidates) {
    if (!record(candidate) || typeof candidate.reference !== 'string' || !/^gap-[1-9]\d*$/.test(candidate.reference)
      || (candidate.issues !== undefined && !Array.isArray(candidate.issues))
      || references.has(candidate.reference) || typeof candidate.query !== 'string' || !candidate.query.trim()
      || typeof candidate.title !== 'string' || (candidate.summary !== undefined && typeof candidate.summary !== 'string') || (candidate.reason !== undefined && typeof candidate.reason !== 'string')) throw new Held('malformed');
    references.add(candidate.reference);
  }
  const issueMeanings = snapshot.candidates.flatMap((candidate) => candidate.issues as unknown[] ?? []);
  for (const issue of issueMeanings) if (!record(issue) || typeof issue.reference !== 'string' || !/^issue-[1-9]\d*$/.test(issue.reference)
    || typeof issue.message !== 'string' || typeof issue.query !== 'string' || (issue.reason !== undefined && typeof issue.reason !== 'string')) throw new Held('malformed');
  for (const meaning of [snapshot.question, ...snapshot.candidates, ...issueMeanings]) {
    if (!record(meaning) || Object.keys(meaning).some((key) => !['query', 'subject', 'subjects', 'sources', 'reference', 'title', 'summary', 'reason', 'issues', 'message'].includes(key)) || (meaning.subject !== undefined && typeof meaning.subject !== 'string')
      || !Array.isArray(meaning.subjects) || !Array.isArray(meaning.sources)) throw new Held('malformed');
    for (const context of [...meaning.subjects, ...meaning.sources]) if (!record(context) || typeof context.reference !== 'string'
      || !/^(subject|source)-[1-9]\d*$/.test(context.reference) || !record(context.content)) throw new Held('malformed');
  }
  if (snapshot.candidates.length > LIMITS.candidates || JSON.stringify(snapshot).length > LIMITS.characters) throw new Held('budget');
  return snapshot as unknown as AnswerGapInput;
}
function checkedPort(port: JudgmentPort): JudgmentPort {
  return { ...port, model: port.model, async ask(request) {
    const result = { ...await port.ask(request) };
    if (!result.answers || typeof result.model !== 'string' || !result.model.trim() || typeof result.requestedModel !== 'string'
      || !result.requestedModel.trim() || (result.decisionId !== undefined && (typeof result.decisionId !== 'string' || !result.decisionId.trim()))) throw new Held('malformed');
    const answers = Object.fromEntries(Object.keys(request.questions).map((name) => {
      const answer: unknown = result.answers[name];
      if (!record(answer) || answer.type !== 'noul' || typeof answer.noul !== 'number' || !Number.isFinite(answer.noul)
        || answer.noul < 0 || answer.noul > 1) throw new Held('malformed');
      return [name, { type: 'noul' as const, noul: answer.noul }];
    })) as typeof result.answers;
    return { ...result, answers };
  } };
}
/** Complete projection and request budgeting precede the first port acquisition. */
export function prepareAnswerGapReadings(input: AnswerGapInput, options: {
  readonly signal?: AbortSignal | undefined; readonly deadlineAt: number; readonly assertCurrent: () => void;
}) {
  const { signal, deadlineAt, assertCurrent: callerCurrent } = options;
  const snapshot = snapshotAnswerGapInput(input), inputHash = supportHash(snapshot);
  const json = (value: object) => {
    const result = toJson(value);
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Held('malformed');
    return freezeSupport(result) as Record<string, JsonValue>;
  };
  const admission = json({ question: snapshot.question });
  const jobs = snapshot.candidates.map((candidate) => ({ reference: candidate.reference, state: json({ question: snapshot.question, candidate }) }));
  const requests = [...(snapshot.needsSubject ? [{ state: admission, questions: answerGapAdmission.items }] : []),
    ...jobs.map((job) => ({ state: job.state, questions: answerGapEquivalence.items }))];
  const bytes = requests.reduce((total, request) => total + new TextEncoder().encode(JSON.stringify(request)).byteLength + 1_024, 0);
  if (bytes > LIMITS.bytes) throw new Held('budget');
  const ports = new Map<string, { port: JudgmentPort | undefined; model: string | undefined }>();
  const assertCurrent = () => {
    if (signal?.aborted) throw new Held('aborted');
    if (Date.now() >= deadlineAt) throw new Held('budget');
    try { callerCurrent(); } catch (error) {
      if (error instanceof Held) throw error;
      const reason = record(error) ? error.reason : undefined;
      throw new Held(reason === 'budget' || reason === 'aborted' ? reason : 'stale');
    }
    for (const [site, configured] of ports) {
      let current: JudgmentPort | undefined; try { current = judgmentPort(site); } catch { current = undefined; }
      if (current !== configured.port || current?.model !== configured.model) throw new Held('stale');
    }
  };
  let promise: Promise<{ readonly admitted: boolean; readonly reference?: string | undefined; readonly inputHash: string; readonly decisionIds: readonly string[] }> | undefined;
  const read = (): NonNullable<typeof promise> => promise ??= (async () => {
    assertCurrent();
    const controller = new AbortController();
    let stoppedError: Held | undefined;
    const stopped = Promise.withResolvers<never>();
    const stop = (reason: Held) => { stoppedError ??= reason; controller.abort(); stopped.reject(stoppedError); };
    const abort = () => stop(new Held('aborted'));
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop(new Held('budget')), Math.max(1, deadlineAt - Date.now()));
    const check = () => { if (stoppedError) throw stoppedError; assertCurrent(); };
    const run = async () => {
      check();
      for (const site of [...(snapshot.needsSubject ? [answerGapAdmission.name] : []), ...(jobs.length ? [answerGapEquivalence.name] : [])]) {
        let port: JudgmentPort | undefined; try { port = judgmentPort(site); } catch { port = undefined; }
        ports.set(site, { port, model: port?.model });
      }
      const decisionIds: string[] = []; const selected: string[] = [];
      const modelReadings = new Map<string, { model: string; requestedModel: string }>();
      const ask = async (battery: typeof answerGapAdmission | typeof answerGapEquivalence, state: Record<string, JsonValue>) => {
        check();
        const configured = ports.get(battery.name);
        if (!configured?.port) throw new Held('unavailable');
        const result = await battery.run(checkedPort(configured.port), state, { signal: controller.signal, site: battery.name });
        check();
        const previous = modelReadings.get(battery.name);
        if (previous && (previous.model !== result.result.model || previous.requestedModel !== result.result.requestedModel)) throw new Held('stale');
        modelReadings.set(battery.name, { model: result.result.model, requestedModel: result.result.requestedModel });
        const reading = Object.values(result.readings)[0]!;
        if (reading.outcome !== 'act' || (reading.verdict !== 'yes' && reading.verdict !== 'no')) throw new Held('uncertain');
        if (result.result.decisionId) decisionIds.push(result.result.decisionId);
        result.recordAction(`prepared answer-gap ${reading.verdict}; observation only, no repair or operator authority`);
        return reading.verdict === 'yes';
      };
      if (snapshot.needsSubject && !await ask(answerGapAdmission, admission)) return freezeSupport({ admitted: false, inputHash, decisionIds });
      for (const job of jobs) if (await ask(answerGapEquivalence, job.state)) selected.push(job.reference);
      check();
      if (selected.length > 1) throw new Held('uncertain');
      return freezeSupport({ admitted: true, reference: selected[0], inputHash, decisionIds });
    };
    try { return await Promise.race([run(), stopped.promise]); }
    catch (error) { controller.abort(); throw error instanceof Held ? error : new Held('unavailable'); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  })();
  return { read, assertCurrent };
}

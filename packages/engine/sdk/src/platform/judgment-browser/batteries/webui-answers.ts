import {
  JudgmentError,
  type JudgmentErrorKind, type JudgmentLineage, type JudgmentPort,
  type JudgmentResult, type Questions,
} from '@goodvibes-jev/judgment';

const INVALID = (): never => { throw new JudgmentError('invalid-response', 'Invalid WebUI judgment response.'); };
const ERROR_KINDS: readonly JudgmentErrorKind[] = ['invalid-request', 'rejected', 'unavailable', 'aborted', 'invalid-response', 'unrecorded'];

/** Descriptor inspection avoids executing provider-supplied getters or hooks. */
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return INVALID();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return INVALID();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string')) return INVALID();
  if (Object.values(descriptors).some((entry) => !('value' in entry) || !entry.enumerable)) return INVALID();
  return Object.fromEntries(Object.entries(descriptors).map(([key, entry]) => [key, entry.value as unknown]));
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) INVALID();
}
function probability(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return INVALID();
  return value;
}
function nonnegative(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return INVALID();
  return value;
}

/** Capture array slots without consulting map, an iterator, accessors or species. */
function array(value: unknown, max: number): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return INVALID();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(descriptors).length > 0) return INVALID();
  const lengthDescriptor = Object.getOwnPropertyDescriptor(descriptors, 'length')?.value as PropertyDescriptor | undefined;
  const length: unknown = lengthDescriptor?.value;
  if (typeof length !== 'number' || !Number.isInteger(length) || length < 0 || length > max) return INVALID();
  if (Object.keys(descriptors).length !== length + 1) return INVALID();
  const captured: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(descriptors, String(index))?.value as PropertyDescriptor | undefined;
    if (descriptor === undefined || !('value' in descriptor)) return INVALID();
    captured.push(descriptor.value as unknown);
  }
  return captured;
}

/**
 * Strict pre-log answer projection for the first three WebUI batteries.
 * Unlike the foundation wire check this rejects extensions, omitted/extra
 * options, non-maximal choices, and non-normalized distributions.
 */
export function validateWebuiAnswers<Q extends Questions>(questions: Q, raw: unknown): JudgmentResult<Q>['answers'] {
  try {
    const answers = record(raw);
    exactKeys(answers, Object.keys(questions));
    const entries = Object.entries(questions).map(([name, question]) => {
      const answer = record(answers[name]);
      if (answer['type'] !== question.type) return INVALID();
      if (question.type === 'noul') {
        exactKeys(answer, ['type', 'noul']);
        return [name, { type: 'noul', noul: probability(answer['noul']) }];
      }
      if (question.type !== 'choice') return INVALID();
      exactKeys(answer, ['type', 'choice', 'confidence', 'probabilities']);
      const options = Object.keys(question.criteria);
      const selected = answer['choice'];
      if (typeof selected !== 'string' || !options.includes(selected)) return INVALID();
      const distribution = record(answer['probabilities']);
      exactKeys(distribution, options);
      const probabilities = Object.fromEntries(options.map((option) => [option, probability(distribution[option])]));
      const confidence = probability(answer['confidence']);
      const values = Object.values(probabilities);
      // Numerical representation tolerance, not a semantic confidence threshold.
      // TypeSafe confidence summarizes distribution shape; it is not the
      // selected option's probability (https://docs.typesafe.ai/confidence).
      if (Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > 1e-6
        || values.some((value) => value > probabilities[selected]! + 1e-6)) return INVALID();
      return [name, { type: 'choice', choice: selected, confidence, probabilities }];
    });
    return Object.fromEntries(entries) as JudgmentResult<Q>['answers'];
  } catch { return INVALID(); }
}

/** Keep numeric operational evidence; provider identifiers are not retained. */
function safeLineage(raw: unknown, model: string): JudgmentLineage | undefined {
  if (raw === undefined) return undefined;
  const lineage = record(raw);
  const id = lineage['logicalRequestId'];
  if (typeof id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) return INVALID();
  const attempts = array(lineage['attempts'], 64);
  return {
    logicalRequestId: id,
    attempts: attempts.map((rawAttempt: unknown) => {
      const attempt = record(rawAttempt);
      const number = nonnegative(attempt['attempt']);
      const endpointIndex = nonnegative(attempt['endpointIndex']);
      const endpointKind = attempt['endpointKind'];
      const outcome = attempt['outcome'];
      const status = attempt['status'];
      if (!Number.isInteger(number) || number < 1 || !Number.isInteger(endpointIndex)
        || (endpointKind !== 'hosted' && endpointKind !== 'local')
        || attempt['requestedModel'] !== model
        || (outcome !== 'answered' && !ERROR_KINDS.includes(outcome as JudgmentErrorKind))
        || (status !== undefined && (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599))) return INVALID();
      return { attempt: number, endpointIndex, endpointKind, requestedModel: model,
        latencyMs: nonnegative(attempt['latencyMs']), outcome: outcome as 'answered' | JudgmentErrorKind,
        ...(status === undefined ? {} : { status: status as number }) };
    }),
  };
}

export interface WebuiAnswerBoundaryOptions {
  /**
   * Server-owned calibration-compatible response model IDs, keyed by requested
   * model/alias. Omitted entries permit only the exact requested model.
   * These declarations must never come from the browser request.
   */
  readonly returnedModels?: Readonly<Record<string, readonly string[]>>;
}

/**
 * Place INSIDE withDecisionLog, around a non-recording server-configured port.
 * Never use this around an already recording port: answers and failures would
 * already have been retained. This does not authorize source/route/retention.
 */
export function withWebuiAnswerBoundary(inner: JudgmentPort, options: WebuiAnswerBoundaryOptions = {}): JudgmentPort {
  if (inner.recorder !== undefined) throw new Error('WebUI answer boundary must precede decision logging.');
  const returnedModels = new Map(Object.entries(options.returnedModels ?? {}).map(([requested, allowed]) => [requested, new Set(allowed)]));
  return {
    get model() { return inner.model; },
    async ask(request) {
      const model = request.model ?? inner.model;
      try {
        const raw = record(await inner.ask(request));
        const answers = validateWebuiAnswers(request.questions, raw['answers']);
        const actualModel = raw['model'];
        if (raw['requestedModel'] !== model || typeof actualModel !== 'string'
          || !(returnedModels.get(model)?.has(actualModel) ?? actualModel === model)) return INVALID();
        const usage = record(raw['usage']);
        const inputTokens = nonnegative(usage['inputTokens']);
        const outputTokens = nonnegative(usage['outputTokens']);
        if (!Number.isInteger(inputTokens) || !Number.isInteger(outputTokens)) return INVALID();
        const lineage = safeLineage(raw['lineage'], model);
        return { answers, requestedModel: model, model: actualModel, usage: { inputTokens, outputTokens },
          latencyMs: nonnegative(raw['latencyMs']), requestId: undefined,
          ...(lineage === undefined ? {} : { lineage }) };
      } catch (error) {
        const descriptors: Record<string, PropertyDescriptor> = error instanceof JudgmentError ? Object.getOwnPropertyDescriptors(error) : {};
        const rawKind: unknown = descriptors['kind']?.value;
        const kind = ERROR_KINDS.includes(rawKind as JudgmentErrorKind) ? rawKind as JudgmentErrorKind : 'unavailable';
        // Do not keep cause, original message, response body or provider request ID.
        let lineage: JudgmentLineage | undefined;
        try { lineage = safeLineage(descriptors['lineage']?.value, model); } catch { /* discard invalid metadata */ }
        throw new JudgmentError(kind, 'WebUI judgment could not be completed.', lineage === undefined ? {} : { lineage });
      }
    },
  };
}

import { APIError, APITimeoutError, type Questions } from '@typesafe-ai/sdk';
import { checkAnswers, projectAnswers } from './answers.ts';
import { clientFor, systemOneWithoutDeadline, toJudgmentError } from './client.ts';
import { validateJudgmentConfig, type JudgmentConfig } from './config.ts';
import { matchesJudgmentModel } from './endpoint-validation.ts';
import { JudgmentContextLimitError, JudgmentError } from './errors.ts';
import { requiresLongContext, validateContextBudget, validateQuestions } from './limits.ts';
import { withRequestId } from './request-id.ts';
import { delay, interruptible, retryable, retryDelay, retryPolicy } from './retry.ts';
import type { JudgmentAttempt, JudgmentEndpointHealth, JudgmentPort, JudgmentRequest, JudgmentResult } from './types.ts';

function needsContextUpgrade(error: unknown): boolean {
  if (!(error instanceof APIError) || error.status !== 400) return false;
  const body = error.body;
  if (!body || typeof body !== 'object' || !('detail' in body)) return false;
  const detail = body.detail;
  return !!detail && typeof detail === 'object' && 'error_type' in detail && detail.error_type === 'max_tokens_exceeded';
}

/** One attempt owner: configured failover exhausts once; a primary-only outage retries until cancelled. */
export function createSystemOnePort(config: JudgmentConfig): JudgmentPort {
  validateJudgmentConfig(config);
  const targets = [{ endpoint: { ...config.endpoint }, model: config.model }, ...(config.fallbacks ?? []).map((t) => ({ ...t, endpoint: { ...t.endpoint } }))];
  const fetch = config.fetch;
  const clients = targets.map(({ endpoint, model }) => config.timeoutMs > 0 ? clientFor({ ...config, endpoint, model }, true) : undefined);
  const policy = retryPolicy(config.retry);
  const timeoutMs = config.timeoutMs;
  const defaultModel = config.model;
  const health: JudgmentEndpointHealth[] = targets.map(({ endpoint, model }, endpointIndex) => ({ endpointIndex, endpointKind: endpoint.kind, model, attempts: 0, consecutiveFailures: 0 }));
  const keys = targets.map((target) => target.endpoint.apiKey);
  const safeId = (value: string | undefined): string | undefined => {
    if (!value || value.length > 256 || !/^[A-Za-z0-9._:-]+$/.test(value) || keys.some((key) => value.includes(key))) return undefined;
    // Provider request IDs are optional diagnostics. A valid opaque ID can
    // accidentally contain a card-shaped numeric run; omit that metadata at
    // the native transport instead of rejecting an otherwise valid judgment.
    // Borrowed results and all unknown response fields remain strictly screened.
    if (/\d{13,}/.test(value.replace(/-/g, ''))) return undefined;
    return value;
  };

  return {
    model: defaultModel,
    health: () => health.map((item) => ({ ...item })),
    async ask<const Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
      const started = performance.now();
      // These locally generated opaque keys need no decimal spelling. Retain
      // every UUID bit without accidental card-shaped runs across hyphens.
      const logicalRequestId = crypto.randomUUID().replace(/[0-9a-f]/g,
        nibble => String.fromCharCode(97 + Number.parseInt(nibble, 16)));
      const attempts: JudgmentAttempt[] = [];
      let attemptCount = 0;
      const lineage = () => ({ logicalRequestId, attempts: [...attempts],
        ...(attemptCount > attempts.length ? { omittedAttempts: attemptCount - attempts.length } : {}) });
      const remember = (attempt: JudgmentAttempt) => {
        attempts.push(attempt);
        if (attempts.length > 128) attempts.shift();
      };
      const { signal, beforeAttempt, beforeAsyncAttempt, onRetry } = request;
      const requestedModel = request.model ?? defaultModel;
      const controller = new AbortController();
      const cancelled = () => controller.abort(new JudgmentError('aborted', 'the judgment call was cancelled'));
      if (signal?.aborted) cancelled();
      signal?.addEventListener('abort', cancelled, { once: true });
      const checkCancellation = () => {
        if (signal?.aborted) cancelled();
        if (controller.signal.aborted) throw controller.signal.reason;
      };
      try {
        if ('totalTimeoutMs' in request) throw new JudgmentError('invalid-request', 'judgment total-time limits are not supported; cancel through the owning signal');
        checkCancellation();
        let input: Pick<JudgmentRequest<Q>, 'state' | 'questions'>;
        try { input = JSON.parse(JSON.stringify({ state: request.state, questions: request.questions })) as typeof input; }
        catch { throw new JudgmentError('invalid-request', 'judgment input must be JSON-serializable'); }
        const { state, questions } = input;
        validateQuestions(questions);
        validateContextBudget(state, questions);
        let headers = requiresLongContext(state, questions) ? { 'TypeSafe-Danger-Zone-Long-Context': 'true' } : undefined;
        // Exhaust a configured failover chain once; a primary-only outage retries until cancellation.
        const eligible = targets.map((target, endpointIndex) => ({ target, endpointIndex }))
          .filter(({ target, endpointIndex }) => endpointIndex === 0 || target.model === requestedModel);
        let retry = 0;
        for (;;) {
          for (let eligibleIndex = 0; eligibleIndex < eligible.length; eligibleIndex++) {
            const { target, endpointIndex } = eligible[eligibleIndex]!;
            checkCancellation();
            try {
              if (beforeAsyncAttempt) {
                let checked: unknown;
                try {
                  checked = await interruptible(Promise.resolve().then(() => {
                    checkCancellation();
                    return beforeAsyncAttempt();
                  }), controller.signal);
                } catch {
                  checkCancellation();
                  throw new JudgmentError('rejected', 'the judgment attempt is no longer authorized');
                }
                checkCancellation();
                if (checked !== undefined) throw new JudgmentError('invalid-request', 'the asynchronous judgment attempt guard must complete without a return value');
              }
              const checked: unknown = beforeAttempt?.();
              if (checked !== undefined) {
                if (checked !== null && (typeof checked === 'object' || typeof checked === 'function')) {
                  try { void Promise.prototype.then.call(checked, undefined, () => {}); } catch { /* Only genuine promises need rejection draining. */ }
                }
                throw new JudgmentError('invalid-request', 'the judgment attempt guard must be synchronous and complete without a return value');
              }
            } catch (error) {
              checkCancellation();
              throw error instanceof JudgmentError ? error : new JudgmentError('rejected', 'the judgment attempt is no longer authorized');
            }
            checkCancellation();
            attemptCount += 1;
            const attemptStarted = performance.now();
            let requestId: string | undefined;
            const attemptController = new AbortController();
            const abortAttempt = () => attemptController.abort(controller.signal.reason);
            controller.signal.addEventListener('abort', abortAttempt, { once: true });
            const attemptTimer = timeoutMs > 0 ? setTimeout(() => attemptController.abort(new APITimeoutError(timeoutMs)), timeoutMs) : undefined;
            let failure: unknown;
            try {
              const response = await interruptible(withRequestId(
                () => timeoutMs === 0
                  ? systemOneWithoutDeadline({ ...target, timeoutMs: 0, retry: {}, ...(fetch ? { fetch } : {}) }, { state, questions, model: requestedModel }, attemptController.signal, headers)
                  : clients[endpointIndex]!.systemOne({ state, questions, model: requestedModel }, { signal: attemptController.signal, ...(headers === undefined ? {} : { headers }) }),
                (id) => { requestId = safeId(id); },
              ), attemptController.signal);
              checkCancellation();
              const result = response.result;
              if (!result || typeof result.model !== 'string' || keys.some((key) => result.model.includes(key)) || !result.answers || !result.usage
                || ![result.usage.input_tokens, result.usage.output_tokens].every((n) => Number.isFinite(n) && n >= 0)) {
                throw new JudgmentError('invalid-response', 'System One returned an invalid result envelope');
              }
              try { checkAnswers(questions, result.answers, requestId); }
              catch { throw new JudgmentError('invalid-response', 'System One returned answers that do not match the requested questions'); }
              if (!matchesJudgmentModel(requestedModel, result.model)) throw new JudgmentError('invalid-response', 'System One returned a model that does not match the requested model or Jev alias');
              const attempt: JudgmentAttempt = {
                attempt: attemptCount, endpointIndex, endpointKind: target.endpoint.kind, requestedModel,
                latencyMs: performance.now() - attemptStarted, outcome: 'answered', ...(requestId ? { requestId } : {}),
              };
              remember(attempt);
              health[endpointIndex] = { ...health[endpointIndex]!, attempts: health[endpointIndex]!.attempts + 1, consecutiveFailures: 0, lastOutcome: 'answered' };
              return {
                answers: projectAnswers(questions, result.answers), requestedModel, model: result.model,
                usage: { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens },
                latencyMs: performance.now() - started, requestId, lineage: lineage(),
              };
            } catch (error) {
              failure = controller.signal.aborted ? controller.signal.reason : attemptController.signal.aborted ? attemptController.signal.reason : error;
              const last = toJudgmentError(failure);
              requestId = safeId(last.requestId) ?? requestId;
              remember({
                attempt: attemptCount, endpointIndex, endpointKind: target.endpoint.kind, requestedModel,
                latencyMs: performance.now() - attemptStarted, outcome: last.kind,
                ...(last.status === undefined ? {} : { status: last.status }), ...(requestId ? { requestId } : {}),
              });
              health[endpointIndex] = { ...health[endpointIndex]!, attempts: health[endpointIndex]!.attempts + 1, consecutiveFailures: health[endpointIndex]!.consecutiveFailures + 1, lastOutcome: last.kind };
              // Exact server tokenization can exceed the character estimate.
              // Retry the complete input on the same endpoint in long-context
              // mode, retaining this refusal and rechecking owner authority.
              if (headers === undefined && needsContextUpgrade(failure)) {
                headers = { 'TypeSafe-Danger-Zone-Long-Context': 'true' };
                eligibleIndex--;
                continue;
              }
              if (last.kind !== 'unavailable' || !retryable(failure)) throw last;
            } finally {
              clearTimeout(attemptTimer);
              controller.signal.removeEventListener('abort', abortAttempt);
            }
            checkCancellation();
            if (targets.length > 1 && endpointIndex === eligible.at(-1)?.endpointIndex) {
              const last = toJudgmentError(failure);
              throw new JudgmentError('unavailable', 'all compatible configured judgment endpoints are unavailable', {
                ...(last.status === undefined ? {} : { status: last.status }), ...(requestId ? { requestId } : {}),
              });
            }
            const nextDelayMs = retryDelay(failure, retry, policy);
            retry = Math.min(retry + 1, 30);
            // Observers cannot change evidence or turn an outage into a terminal failure.
            try {
              const observed = onRetry?.(Object.freeze({ logicalRequestId,
                attempt: Object.freeze({ ...attempts[attempts.length - 1]! }),
                elapsedMs: performance.now() - started, nextDelayMs }));
              void Promise.resolve(observed).catch(() => {});
            } catch { /* Progress reporting never decides the reading. */ }
            await delay(nextDelayMs, controller.signal);
          }
        }
      } catch (error) {
        const failure = toJudgmentError(error);
        // Do not retain upstream causes, bodies, headers, URLs or API keys in a public error/log.
        const requestId = safeId(failure.requestId) ?? attempts.at(-1)?.requestId;
        if (failure instanceof JudgmentContextLimitError) throw new JudgmentContextLimitError({
          ...(requestId ? { requestId } : {}), lineage: lineage(),
        });
        throw new JudgmentError(failure.kind, keys.reduce((message, key) => message.replaceAll(key, '[redacted]'), failure.message), {
          ...(failure.status === undefined ? {} : { status: failure.status }), ...(requestId ? { requestId } : {}),
          lineage: lineage(),
        });
      } finally {
        signal?.removeEventListener('abort', cancelled);
      }
    },
  };
}

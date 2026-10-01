import { APITimeoutError, type Questions } from '@typesafe-ai/sdk';
import { checkAnswers, projectAnswers } from './answers.ts';
import { clientFor, toJudgmentError } from './client.ts';
import { isPinnedJudgmentModel, validateJudgmentConfig, type JudgmentConfig } from './config.ts';
import { JudgmentError } from './errors.ts';
import { validateContextBudget, validateQuestions } from './limits.ts';
import { withRequestId } from './request-id.ts';
import { delay, interruptible, retryable, retryDelay, retryPolicy } from './retry.ts';
import type { JudgmentAttempt, JudgmentEndpointHealth, JudgmentPort, JudgmentRequest, JudgmentResult } from './types.ts';

/** An ordered, bounded System One chain. Only configured, calibration-compatible targets can answer. */
export function createSystemOnePort(config: JudgmentConfig): JudgmentPort {
  validateJudgmentConfig(config);
  const targets = [{ endpoint: { ...config.endpoint }, model: config.model }, ...(config.fallbacks ?? []).map((t) => ({ ...t, endpoint: { ...t.endpoint } }))];
  const clients = targets.map(({ endpoint, model }) => clientFor({ ...config, endpoint, model, retry: { maxRetries: 0 } }));
  const policy = retryPolicy(config.retry);
  const timeoutMs = config.timeoutMs;
  const configuredTotalTimeoutMs = config.totalTimeoutMs ?? 120_000;
  const strictModel = targets.length > 1;
  const defaultModel = config.model;
  const health: JudgmentEndpointHealth[] = targets.map(({ endpoint, model }, endpointIndex) => ({ endpointIndex, endpointKind: endpoint.kind, model, attempts: 0, consecutiveFailures: 0 }));
  const keys = targets.map((target) => target.endpoint.apiKey);
  const safeId = (value: string | undefined): string | undefined => {
    if (!value || value.length > 256 || !/^[A-Za-z0-9._:-]+$/.test(value) || keys.some((key) => value.includes(key))) return undefined;
    return value;
  };

  return {
    model: defaultModel,
    health: () => health.map((item) => ({ ...item })),
    async ask<const Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
      const started = performance.now();
      const logicalRequestId = crypto.randomUUID();
      const attempts: JudgmentAttempt[] = [];
      const { signal } = request;
      const totalTimeoutMs = Math.min(configuredTotalTimeoutMs, request.totalTimeoutMs ?? configuredTotalTimeoutMs);
      const requestedModel = request.model ?? defaultModel;
      const controller = new AbortController();
      const cancelled = () => controller.abort(new JudgmentError('aborted', 'the judgment call was cancelled'));
      if (signal?.aborted) cancelled();
      signal?.addEventListener('abort', cancelled, { once: true });
      const timer = setTimeout(() => controller.abort(new JudgmentError('unavailable', 'the judgment total deadline expired')), Math.max(1, Number.isFinite(totalTimeoutMs) ? totalTimeoutMs : configuredTotalTimeoutMs));
      const checkDeadline = () => {
        if (signal?.aborted) cancelled();
        if (!controller.signal.aborted && performance.now() - started >= totalTimeoutMs) controller.abort(new JudgmentError('unavailable', 'the judgment total deadline expired'));
        if (controller.signal.aborted) throw controller.signal.reason;
      };
      try {
        if (request.totalTimeoutMs !== undefined && (!Number.isInteger(request.totalTimeoutMs) || request.totalTimeoutMs < 1)) {
          throw new JudgmentError('invalid-request', 'the requested judgment deadline must be positive integer milliseconds');
        }
        checkDeadline();
        let input: Pick<JudgmentRequest<Q>, 'state' | 'questions'>;
        try { input = JSON.parse(JSON.stringify({ state: request.state, questions: request.questions })) as typeof input; }
        catch { throw new JudgmentError('invalid-request', 'judgment input must be JSON-serializable'); }
        const { state, questions } = input;
        validateQuestions(questions);
        validateContextBudget(state, questions);
        if (strictModel && !isPinnedJudgmentModel(requestedModel)) throw new JudgmentError('invalid-request', 'judgment failover requires a pinned requested model, not an alias');
        let last: JudgmentError | undefined;
        for (const [endpointIndex, target] of targets.entries()) {
          // A different calibrated model is not an eligible substitute for this logical reading.
          if (endpointIndex > 0 && target.model !== requestedModel) continue;
          for (let retry = 0; retry <= policy.maxRetries; retry += 1) {
            checkDeadline();
            const attemptStarted = performance.now();
            let requestId: string | undefined;
            const attemptController = new AbortController();
            const abortAttempt = () => attemptController.abort(controller.signal.reason);
            controller.signal.addEventListener('abort', abortAttempt, { once: true });
            const attemptTimer = setTimeout(() => attemptController.abort(new APITimeoutError(timeoutMs)), Math.min(timeoutMs, Math.max(1, totalTimeoutMs - (performance.now() - started))));
            let failure: unknown;
            try {
              const response = await interruptible(withRequestId(
                () => clients[endpointIndex]!.systemOne({ state, questions, model: requestedModel }, { signal: attemptController.signal }),
                (id) => { requestId = safeId(id); },
              ), attemptController.signal);
              checkDeadline();
              const result = response.result;
              if (!result || typeof result.model !== 'string' || keys.some((key) => result.model.includes(key)) || !result.answers || !result.usage
                || ![result.usage.input_tokens, result.usage.output_tokens].every((n) => Number.isFinite(n) && n >= 0)) {
                throw new JudgmentError('invalid-response', 'System One returned an invalid result envelope');
              }
              try { checkAnswers(questions, result.answers, requestId); }
              catch { throw new JudgmentError('invalid-response', 'System One returned answers that do not match the requested questions'); }
              if (strictModel && result.model !== requestedModel) throw new JudgmentError('invalid-response', 'System One returned a different model version; calibration compatibility is not established');
              const attempt: JudgmentAttempt = {
                attempt: attempts.length + 1, endpointIndex, endpointKind: target.endpoint.kind, requestedModel,
                latencyMs: performance.now() - attemptStarted, outcome: 'answered', ...(requestId ? { requestId } : {}),
              };
              attempts.push(attempt);
              health[endpointIndex] = { ...health[endpointIndex]!, attempts: health[endpointIndex]!.attempts + 1, consecutiveFailures: 0, lastOutcome: 'answered' };
              return {
                answers: projectAnswers(questions, result.answers), requestedModel, model: result.model,
                usage: { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens },
                latencyMs: performance.now() - started, requestId, lineage: { logicalRequestId, attempts },
              };
            } catch (error) {
              failure = controller.signal.aborted ? controller.signal.reason : attemptController.signal.aborted ? attemptController.signal.reason : error;
              last = toJudgmentError(failure);
              requestId = safeId(last.requestId) ?? requestId;
              attempts.push({
                attempt: attempts.length + 1, endpointIndex, endpointKind: target.endpoint.kind, requestedModel,
                latencyMs: performance.now() - attemptStarted, outcome: last.kind,
                ...(last.status === undefined ? {} : { status: last.status }), ...(requestId ? { requestId } : {}),
              });
              health[endpointIndex] = { ...health[endpointIndex]!, attempts: health[endpointIndex]!.attempts + 1, consecutiveFailures: health[endpointIndex]!.consecutiveFailures + 1, lastOutcome: last.kind };
              if (last.kind !== 'unavailable' || !retryable(failure, policy)) throw last;
            } finally {
              clearTimeout(attemptTimer);
              controller.signal.removeEventListener('abort', abortAttempt);
            }
            checkDeadline();
            if (retry < policy.maxRetries) await delay(retryDelay(failure, retry, policy), controller.signal);
          }
        }
        throw last ?? new JudgmentError('unavailable', 'no compatible judgment target could answer');
      } catch (error) {
        const failure = toJudgmentError(error);
        // Do not retain upstream causes, bodies, headers, URLs or API keys in a public error/log.
        const requestId = safeId(failure.requestId) ?? attempts.at(-1)?.requestId;
        throw new JudgmentError(failure.kind, keys.reduce((message, key) => message.replaceAll(key, '[redacted]'), failure.message), {
          ...(failure.status === undefined ? {} : { status: failure.status }), ...(requestId ? { requestId } : {}),
          lineage: { logicalRequestId, attempts },
        });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancelled);
      }
    },
  };
}

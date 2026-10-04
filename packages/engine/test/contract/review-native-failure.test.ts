import { expect, test } from 'bun:test';
import { createSystemOnePort, PINNED_MODEL, SqliteDecisionLog, withDecisionLog, type EntryType, type Questions } from '@goodvibes-jev/judgment';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { makeHarness, oneUnitPlan, runnerPort, startContract, waitFor } from './runner-support.js';
import type { NativeContractSource } from '../../sdk/src/platform/contract/types.js';
const source: NativeContractSource = { sourceId: 'review-failure', sourceRevision: '1', inputRevision: 'input-1', criteriaId: 'criteria', criteriaRevision: '1', goal: 'Deliver the parser', criteria: ['Preserve parser behavior'] };

test('review: native unit failure reading stops shared Jev retries when contract is cancelled', async () => {
  using log = new SqliteDecisionLog(':memory:');
  let attempts = 0; let afterCancel = 0; let cancelled = false; let failureInput: unknown;
  const p = { ...oneUnitPlan(1), goal: source.goal, criteria: [{ id: 'c1', text: source.criteria[0]!, quote: source.criteria[0]! }] };
  const h = makeHarness({ recordNative: true, decisionLog: log, plan: p, scripts: { u1: () => [{ text: 'starting', stop: { kind: 'error', message: 'ECONNRESET review native lifecycle isolated' } }] } });
  const scripted = runnerPort();
  const real = createSystemOnePort({ endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:1', apiKey: 'synthetic-key' }, model: PINNED_MODEL,
    timeoutMs: 1000, retry: { backoffInitialMs: 20, backoffMaxMs: 20, backoffJitter: 0 },
    fetch: async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { state: EntryType; questions: Questions };
      if ('category' in request.questions) {
        attempts++; failureInput = request.state; if (cancelled) afterCancel++;
        if (attempts < 4) return Response.json({}, { status: 503 });
      }
      const result = await scripted.port.ask(request);
      return Response.json({ model: PINNED_MODEL, answers: result.answers, usage: { input_tokens: 1, output_tokens: 1 } });
    },
  });
  installJudgmentPort(withDecisionLog(real, log));
  try {
    const id = startContract(h, { nativeSource: source }).contract.id;
    await waitFor(() => attempts >= 1, 'native failure judgment request');
    const showedWaiting = h.store.get(id)?.nativeWaiting !== undefined;
    cancelled = true; h.runner.cancel(id, 'test cancellation');
    await h.runner.join(id);
    console.log('REVIEW_FAILURE_RESULT', JSON.stringify({ status: h.store.get(id)?.status, attempts, afterCancel, showedWaiting, failureInput }));
    expect(afterCancel).toBe(0);
    expect(showedWaiting).toBe(true);
  } finally { h.dispose(); }
}, 20000);

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { e2eJudgmentAnswers, startE2EJudgments } from './judgment-fixture.ts';
import timings from '../fixtures/e2e-judgments/cancelled-turn-timings.json';
import pending from '../fixtures/e2e-judgments/cancelled-turn-pending.json';
import privacyNegative from '../fixtures/e2e-judgments/privacy-negative.json';

describe('recorded cancellation diagnostic fixtures', () => {
  test('accepts only recorded phases and complete questions with bounded measured durations', () => {
    for (const recorded of timings) {
      for (const durationMs of [0, recorded.state.durationMs, 100, 30_000]) {
        expect(e2eJudgmentAnswers({ ...recorded, state: { ...recorded.state, durationMs } })?.kind).toBe('cancelled-turn-timing');
      }
      for (const durationMs of [-1, 0.5, 30_001, Infinity, NaN, '6', null]) {
        expect(e2eJudgmentAnswers({ ...recorded, state: { ...recorded.state, durationMs } })).toBeUndefined();
      }
      for (const state of [
        { ...recorded.state, domain: 'task' }, { ...recorded.state, phase: 'RUNNING' },
        { ...recorded.state, succeeded: !recorded.state.succeeded }, { ...recorded.state, extra: true },
      ]) expect(e2eJudgmentAnswers({ ...recorded, state })).toBeUndefined();
      expect(e2eJudgmentAnswers({ ...recorded, model: 'different-model' })).toBeUndefined();
      expect(e2eJudgmentAnswers({ ...recorded, extra: true })).toBeUndefined();
      expect(e2eJudgmentAnswers({ ...recorded, questions: { slow: { ...recorded.questions.slow, instructions: 'Changed question' } } })).toBeUndefined();
      expect(e2eJudgmentAnswers({ ...recorded, questions: { slow: { ...recorded.questions.slow, criteria: { true: 'Changed', false: 'Changed' } } } })).toBeUndefined();
    }
  });
  test('the response-cancelled notice must match its entire recorded request', () => {
    expect(e2eJudgmentAnswers(pending)).toEqual({ kind: 'cancelled-turn-pending', answers: { pending: { type: 'noul', noul: 0 } } });
    expect(e2eJudgmentAnswers({ ...pending, state: 'Waiting for approval' })).toBeUndefined();
    expect(e2eJudgmentAnswers({ ...pending, model: 'different-model' })).toBeUndefined();
    expect(e2eJudgmentAnswers({ ...pending, extra: true })).toBeUndefined();
    expect(e2eJudgmentAnswers({ ...pending, questions: { pending: { ...pending.questions.pending, instructions: 'Different' } } })).toBeUndefined();
  });
  test('controlled diagnostic unavailability never admits an unknown request', async () => {
    const server = startE2EJudgments();
    try {
      server.rejectRecordedCancellationTimings();
      const send = (body: unknown) => fetch(`${server.baseURL}/v1/systemone`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      for (const recorded of timings) expect((await send(recorded)).status).toBe(422);
      expect(server.unavailableDiagnostics).toHaveLength(4);
      expect(server.unexpected).toHaveLength(0);
      expect((await send(pending)).status).toBe(200);
      expect((await send({ ...timings[0], model: 'unrecognized-model' })).status).toBe(422);
      expect(server.unexpected).toHaveLength(1);
      expect(() => server.assertNoUnexpected()).toThrow('unknown judgment request');
    } finally { server.stop(); }
  });

});

test('recorded synthetic privacy failures remain unavailable and unknown projections remain visible', async () => {
  const ownedRoot = mkdtempSync(join(tmpdir(), 'agent-privacy-peer-'));
  const server = startE2EJudgments({ ownedRoot });
  const send = (body: unknown) => fetch(`${server.baseURL}/v1/systemone`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    let recordedCount = 0;
    for (const contract of privacyNegative.contracts) for (const state of contract.states) {
      const body: unknown = JSON.parse(JSON.stringify({ model: contract.model, questions: contract.questions, state }).split('<owned-fixture-root>').join(ownedRoot));
      const response = await send(body);
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: { message: 'Unknown deterministic E2E judgment; rejected' } });
      recordedCount++;
    }
    expect(server.unavailablePrivacy).toHaveLength(recordedCount);
    expect(server.accepted).toHaveLength(0);
    expect(server.unexpected).toHaveLength(0);
    const fields = privacyNegative.contracts.find(contract => 'kind' in contract.questions);
    const residual = privacyNegative.contracts.find(contract => 'credentialRemains' in contract.questions);
    if (!fields || !residual) throw new Error('Missing captured privacy contracts.');
    const fieldBody = { model: fields.model, questions: fields.questions, state: { field: 'cachePath' } };
    const residualState = residual.states.find(state => JSON.stringify(state).includes('<owned-fixture-root>'));
    if (!residualState) throw new Error('Missing captured owned-path projection.');
    const residualBody = { model: residual.model, questions: residual.questions, state: residualState };
    const unknown = [
      { ...fieldBody, model: 'different-model' },
      { ...fieldBody, extra: true },
      { ...fieldBody, state: { field: 'a new unknown field role' } },
      { ...fieldBody, state: { field: 'cachePath', secret: 'synthetic-added-value' } },
      { ...fieldBody, questions: { kind: { type: 'choice', instructions: 'Different contract', criteria: { other: 'Ordinary' } } } },
      residualBody,
      JSON.parse(JSON.stringify(residualBody).split('<owned-fixture-root>').join(`${ownedRoot}-outside`)),
      { ...residualBody, state: { parts: [{ kind: 'text', text: 'synthetic unrecorded residual text' }] } },
    ];
    for (const body of unknown) expect((await send(body)).status).toBe(422);
    expect(server.unavailablePrivacy).toHaveLength(recordedCount);
    expect(server.unexpected).toHaveLength(unknown.length);
    expect(() => server.assertNoUnexpected()).toThrow('unknown judgment request');
  } finally { server.stop(); rmSync(ownedRoot, { recursive: true, force: true }); }
});

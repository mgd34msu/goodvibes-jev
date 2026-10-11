import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { e2eJudgmentAnswers, startE2EJudgments } from './judgment-fixture.ts';
import timings from '../fixtures/e2e-judgments/cancelled-turn-timings.json';
import pending from '../fixtures/e2e-judgments/cancelled-turn-pending.json';
import privacyNegative from '../fixtures/e2e-judgments/privacy-negative.json';
import diagnostics from '../fixtures/e2e-judgments/ci-diagnostics.json';
import { checkAnswers, type Questions } from '@goodvibes-jev/judgment';
import { fieldKind, redactionCredential, residualCredential } from '@goodvibes-jev/engine/sdk/platform/utils';
import { noticeSeverity } from '@goodvibes-jev/engine/terminal-shell';

const diagnosticQuestions: Readonly<Record<string, Questions>> = {
  'diagnostic-field-kind': { kind: fieldKind.items.kind.question },
  'diagnostic-residual': { credentialRemains: residualCredential.items.credentialRemains.question },
  'diagnostic-credential': {
    lineHasCredential: redactionCredential.items.lineHasCredential.question,
    spanIsCredential: redactionCredential.items.spanIsCredential.question,
  },
  'diagnostic-severity': { severity: noticeSeverity.items.severity.question },
};

function diagnosticBody(contract: typeof diagnostics.contracts[number], state: unknown, ownedRoot: string): unknown {
  return JSON.parse(JSON.stringify({ model: contract.model, questions: contract.questions, state })
    .split('<owned-fixture-root>').join(ownedRoot));
}

test('167 exact safe CI and native diagnostics retain canonical questions and original answer distributions', async () => {
  const ownedRoot = mkdtempSync(join(tmpdir(), 'agent-diagnostics-peer-'));
  const server = startE2EJudgments({ ownedRoot });
  try {
    let count = 0;
    for (const contract of diagnostics.contracts) {
      const questions = diagnosticQuestions[contract.kind];
      if (!questions) throw new Error(`Unregistered diagnostic fixture ${contract.kind}`);
      expect<unknown>(contract.questions).toEqual(questions);
      for (const reading of contract.readings) {
        // Preserve every original answer field and probability through the
        // strict public answer validator; the fixture never rounds uncertainty.
        const answers = Object.fromEntries(Object.entries(reading.answers).map(([name, answer]) => {
          if (answer.type === 'noul' && 'noul' in answer) return [name, { ...answer, type: 'noul' as const }];
          if (answer.type === 'choice' && 'probabilities' in answer && 'choice' in answer && 'confidence' in answer) {
            const probabilities = Object.fromEntries(Object.entries(answer.probabilities).map(([key, probability]) => {
              if (typeof probability !== 'number') throw new Error('Invalid recorded probability');
              return [key, probability];
            }));
            return [name, { ...answer, type: 'choice' as const, probabilities }];
          }
          throw new Error('Invalid recorded diagnostic answer');
        }));
        expect(() => checkAnswers(questions, answers)).not.toThrow();
        const body = diagnosticBody(contract, reading.state, ownedRoot);
        const response = await fetch(`${server.baseURL}/v1/systemone`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ model: contract.model, answers: reading.answers, usage: { input_tokens: 10, output_tokens: 3 } });
        expect(server.acceptedDiagnostics[count]).toEqual({ kind: contract.kind, body });
        expect(server.allRequests[count]).toEqual(body);
        count++;
      }
    }
    expect(count).toBe(167);
    expect(server.acceptedDiagnostics).toHaveLength(167);
    expect(server.allRequests).toHaveLength(167);
    expect(server.accepted).toHaveLength(0);
    expect(server.rejected).toHaveLength(0);
    expect(server.unexpected).toHaveLength(0);
    server.assertNoUnexpected();
    const uncertainFields = ['refs', 'userMessages', 'assistantMessages', 'toolMessages', 'imageParts', 'reasoningSummary', 'dispatch'];
    let uncertainCount = 0;
    for (const contract of diagnostics.contracts) for (const reading of contract.readings) {
      if ('field' in reading.state && uncertainFields.includes(reading.state.field)) {
        if (!('kind' in reading.answers) || !reading.answers.kind || !('confidence' in reading.answers.kind)) throw new Error('Missing uncertain field answer');
        expect(reading.answers.kind.confidence).toBe(0.4);
        uncertainCount++;
      }
    }
    expect(uncertainCount).toBe(7);
    const fields = diagnostics.contracts.find(contract => contract.kind === 'diagnostic-field-kind');
    const credential = diagnostics.contracts.find(contract => contract.kind === 'diagnostic-credential');
    if (!fields || !credential) throw new Error('Missing recorded diagnostic contracts');
    const token = fields.readings.find(reading => 'field' in reading.state && reading.state.field === 'token');
    expect(token?.answers).toEqual({ kind: {
      type: 'choice', choice: 'secret', confidence: 0.99,
      probabilities: { secret: 0.99, owner_profile: 0.003, content: 0.004, other: 0.003 },
    } });
    let tokenLines = 0;
    let memoryLines = 0;
    let setupLines = 0;
    let scalarSetupLines = 0;
    for (const reading of credential.readings) {
      if (!('parts' in reading.state) || !('lineHasCredential' in reading.answers) || !('spanIsCredential' in reading.answers)) continue;
      const parts = reading.state.parts;
      if (parts.some(part => 'field' in part && part.field === 'token')) {
        // A separate method/error span cannot make the declared token ordinary.
        expect(reading.answers.lineHasCredential.noul).toBe(0.99);
        expect(reading.answers.spanIsCredential.noul).toBe(0.5);
        tokenLines++;
      }
      if (parts.some(part => 'field' in part && part.field === 'spine')) {
        expect(reading.answers.lineHasCredential.noul).toBe(0.5);
        expect(reading.answers.spanIsCredential.noul).toBe(0.5);
        memoryLines++;
      }
      if (parts.some(part => 'field' in part && part.field === 'explicitUserRequest')) {
        expect(reading.answers.lineHasCredential.noul).toBe(0.5);
        expect(reading.answers.spanIsCredential.noul).toBe(0.01);
        setupLines++;
      }
      if (parts.some(part => 'field' in part && part.field === 'setupItemId')
        && !parts.some(part => 'field' in part && part.field === 'explicitUserRequest')) {
        expect(reading.answers.lineHasCredential.noul).toBe(0.01);
        expect(reading.answers.spanIsCredential.noul).toBe(0.01);
        scalarSetupLines++;
      }
    }
    expect({ tokenLines, memoryLines, setupLines, scalarSetupLines }).toEqual({ tokenLines: 2, memoryLines: 1, setupLines: 3, scalarSetupLines: 3 });
  } finally { server.stop(); rmSync(ownedRoot, { recursive: true, force: true }); }
});

test('unknown diagnostic models, complete schemas, subjects and path owners remain 422 failures', async () => {
  const ownedRoot = mkdtempSync(join(tmpdir(), 'agent-diagnostics-negative-'));
  const server = startE2EJudgments({ ownedRoot });
  try {
    const fields = diagnostics.contracts.find(contract => contract.kind === 'diagnostic-field-kind');
    const residual = diagnostics.contracts.find(contract => contract.kind === 'diagnostic-residual');
    const credential = diagnostics.contracts.find(contract => contract.kind === 'diagnostic-credential');
    if (!fields || !residual || !credential) throw new Error('Missing recorded diagnostic contracts');
    const pathReading = residual.readings.find(reading => JSON.stringify(reading.state).includes('<owned-fixture-root>'));
    if (!pathReading) throw new Error('Missing captured diagnostic source path');
    const fieldBody = { model: fields.model, questions: fields.questions, state: { field: 'exists' } };
    const pathBody = { model: residual.model, questions: residual.questions, state: pathReading.state };
    const credentialBody = { model: credential.model, questions: credential.questions, state: {
      phase: 'source', target: 'whole-line', parts: [{ kind: 'text', text: 'The operation was aborted.' }],
    } };
    const unknown = [
      { ...fieldBody, model: 'another-model' },
      { ...fieldBody, extra: true },
      { ...fieldBody, state: { field: 'exists', value: 'synthetic-private-value' } },
      { ...fieldBody, state: { field: 'new source role' } },
      { ...fieldBody, questions: { kind: { type: 'choice', instructions: 'Changed complete question', criteria: { other: 'Ordinary' } } } },
      pathBody,
      diagnosticBody(residual, pathReading.state, `${ownedRoot}-outside`),
      { ...pathBody, state: { parts: [{ kind: 'text', text: 'new unrecorded credential-free diagnostic' }] } },
      { ...pathBody, state: { parts: [{ kind: 'withheld', reference: 'forged-reference' }] } },
      { ...credentialBody, state: { ...credentialBody.state, phase: 'residual' } },
      { ...credentialBody, state: { ...credentialBody.state, target: 'span-1' } },
      { ...credentialBody, state: { ...credentialBody.state, parts: [{ kind: 'text', text: 'The operation was aborted. synthetic-private-value' }] } },
    ];
    for (const body of unknown) {
      const response = await fetch(`${server.baseURL}/v1/systemone`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(response.status).toBe(422);
    }
    expect(server.allRequests).toEqual(unknown);
    expect(server.unexpected).toEqual(unknown);
    expect(server.rejected).toEqual(unknown);
    expect(server.accepted).toHaveLength(0);
    expect(server.acceptedDiagnostics).toHaveLength(0);
    expect(() => server.assertNoUnexpected()).toThrow('unknown judgment request');
  } finally { server.stop(); rmSync(ownedRoot, { recursive: true, force: true }); }
});

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

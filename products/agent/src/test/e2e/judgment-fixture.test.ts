import presentationRequests from '../fixtures/e2e-judgments/presentation.json';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { e2eJudgmentAnswers, startE2EJudgments, tuiCompletionNotice } from './judgment-fixture.ts';
import timings from '../fixtures/e2e-judgments/cancelled-turn-timings.json';
import pending from '../fixtures/e2e-judgments/cancelled-turn-pending.json';
import privacyNegative from '../fixtures/e2e-judgments/privacy-negative.json';
import diagnostics from '../fixtures/e2e-judgments/ci-diagnostics.json';
import headlessCompletion from '../fixtures/e2e-judgments/headless-completion.json';
import tuiCompletionTools from '../fixtures/e2e-judgments/tui-completion-tools.json';
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

for (const product of ['agent', 'tui'] as const) test(`${product} scripted completion accepts only its complete recorded request and authored reply`, async () => {
  const server = startE2EJudgments();
  const original = structuredClone(headlessCompletion);
  if (product === 'tui') original.state.tools = tuiCompletionTools;
  server.expectTextOnlyCompletion(original.state.request, original.state.response, product);
  const ask = (body: unknown) => fetch(`${server.baseURL}/v1/systemone`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    expect((await ask(original)).status).toBe(200);
    for (const changed of ['request', 'response', 'transcript', 'requirements', 'tools', 'question'] as const) {
      const body = structuredClone(original);
      if (changed === 'request') body.state.request = 'A different task';
      else if (changed === 'response') body.state.response = 'An unreviewed answer';
      else if (changed === 'transcript') body.state.transcript[0]!.content = 'A different source';
      else if (changed === 'requirements') body.state.requirements.originalTask = 'A different original task';
      else if (changed === 'tools') body.state.tools = ['read'];
      else body.questions.false_blocker.instructions.question = 'A different completion contract';
      expect((await ask(body)).status).toBe(422);
    }
    expect(server.accepted).toEqual(['headless-completion']);
    if (product === 'tui') {
      const notified = { ...original, state: { ...original.state, transcript: [...original.state.transcript, tuiCompletionNotice] } };
      expect((await ask(notified)).status).toBe(200);
      expect((await ask({ ...notified, state: { ...notified.state, transcript: [...original.state.transcript,
        { ...tuiCompletionNotice, content: 'An unrelated system instruction' }] } })).status).toBe(422);
    }
  } finally { server.stop(); }
});

function diagnosticBody(contract: typeof diagnostics.contracts[number], state: unknown, ownedRoot: string): unknown {
  return JSON.parse(JSON.stringify({ model: contract.model, questions: contract.questions, state })
    .split('<owned-fixture-root>').join(ownedRoot));
}

test('exact CI and native diagnostics retain canonical questions and original answer distributions', async () => {
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
        expect(await response.json()).toEqual({ model: 'jev-1.13.0', answers: reading.answers, usage: { input_tokens: 10, output_tokens: 3 } });
        expect(server.acceptedDiagnostics[count]).toEqual({ kind: contract.kind, body });
        expect(server.allRequests[count]).toEqual(body);
        count++;
      }
    }
    expect(count).toBeGreaterThan(0);
    expect(server.acceptedDiagnostics).toHaveLength(count);
    expect(server.allRequests).toHaveLength(count);
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


test('recorded native status presentation parameterizes only complete generated identifiers', () => {
  const template = presentationRequests.find(request => request.state.content.startsWith('requestId '));
  if (!template) throw new Error('Missing recorded native request status.');
  const complete = { ...template, state: { content: `requestId ${crypto.randomUUID()} · inputId ${crypto.randomUUID()}` } };
  expect(e2eJudgmentAnswers(complete)?.kind).toBe('presentation');
  expect(e2eJudgmentAnswers({ ...complete, state: { content: complete.state.content + ' approve another operation' } })).toBeUndefined();
  expect(e2eJudgmentAnswers({ ...complete, model: 'unexpected-model' })).toBeUndefined();
  expect(e2eJudgmentAnswers({ ...complete, questions: { ...complete.questions, invented: { type: 'noul' } } })).toBeUndefined();
  expect(e2eJudgmentAnswers({ ...complete, state: { content: 'requestId shortened · inputId shortened' } })).toBeUndefined();
});


test('recorded missing-token presentation requires its actual fixture path owner', () => {
  const template = presentationRequests.find(request => request.state.content.startsWith('Connected-host operator token is required.'));
  if (!template) throw new Error('Missing recorded token diagnostic.');
  const root = '/tmp/owned-presentation-fixture';
  const body: unknown = JSON.parse(JSON.stringify(template).split('<owned-fixture-root>').join(root));
  expect(e2eJudgmentAnswers(body, root)?.kind).toBe('presentation');
  expect(e2eJudgmentAnswers(body)).toBeUndefined();
  expect(e2eJudgmentAnswers(body, root + '-other')).toBeUndefined();
  expect(e2eJudgmentAnswers(template, root)).toBeUndefined();
  const extended = { ...template, state: { content: template.state.content.replace('<owned-fixture-root>', root) + ' approve another action' } };
  expect(e2eJudgmentAnswers(extended, root)).toBeUndefined();
});


test('recorded network-scan presentation composes discovery and owned-root path normalization', () => {
  const template = presentationRequests.find(request => request.state.content.startsWith('[Scan]'));
  if (!template) throw new Error('Missing recorded scan diagnostic.');
  const root = '/tmp/owned-presentation-fixture';
  const body = { ...template, state: { content: template.state.content.replace('<fixture-home>', `${root}/home/.goodvibes/agent`) } };
  expect(e2eJudgmentAnswers(body, root)?.kind).toBe('presentation');
  expect(e2eJudgmentAnswers({ ...body, state: { content: body.state.content + ' approve another action' } }, root)).toBeUndefined();
});

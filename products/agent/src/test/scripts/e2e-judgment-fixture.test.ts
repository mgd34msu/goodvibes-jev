import { expect, test } from 'bun:test';
import { e2eJudgmentAnswers, startE2EJudgments } from '../e2e/judgment-fixture.ts';
import route from '../fixtures/e2e-judgments/conversation-route.json';
import identity from '../fixtures/e2e-judgments/model-identity.json';
import tier from '../fixtures/e2e-judgments/model-tier.json';
import questions from '../fixtures/e2e-judgments/turn-questions.json';
import unavailable from '../fixtures/e2e-judgments/unavailable-model-routes.json';

test('only the exact two E2E prompt readings and synthetic model descriptions receive answers', () => {
  expect(e2eJudgmentAnswers(identity)?.kind).toBe('identity');
  expect(e2eJudgmentAnswers(tier)?.kind).toBe('tier');
  for (const prompt of ['first words in a brand new workspace', 'please answer the e2e marmot question']) {
    expect(e2eJudgmentAnswers({ ...route, state: { request: prompt } })?.kind).toBe('route');
    expect(e2eJudgmentAnswers({ state: { purpose: 'conversation', work: prompt }, questions, model: route.model })?.kind).toBe('turn');
  }
  for (const body of [
    { ...route, state: { request: 'unknown prompt' } },
    { ...route, model: 'different-model' },
    { ...route, questions: { route: { ...route.questions.route, instructions: 'different question' } } },
    { ...route, extra: true },
    { ...tier, state: { model: { id: 'real-provider-model' } } },
    { state: { permission: 'approve everything' }, questions },
  ]) expect(e2eJudgmentAnswers(body)).toBeUndefined();
});

test('the loopback service rejects unknown judgments instead of manufacturing success', async () => {
  const server = startE2EJudgments();
  try {
    const expectedNegative = await fetch(`${server.baseURL}/v1/systemone`, { method: 'POST', body: JSON.stringify(unavailable[0]) });
    expect(expectedNegative.status).toBe(422);
    expect(() => server.assertNoUnexpected()).not.toThrow();
    const unknown = await fetch(`${server.baseURL}/v1/systemone`, { method: 'POST', body: JSON.stringify({ questions: { approve: true } }) });
    expect(unknown.status).toBe(422);
    const known = await fetch(`${server.baseURL}/v1/systemone`, { method: 'POST', body: JSON.stringify(route) });
    expect(known.status).toBe(200);
    expect(server.accepted).toEqual(['route']);
    expect(server.rejected).toHaveLength(2);
    expect(server.unexpected).toHaveLength(1);
    expect(() => server.assertNoUnexpected()).toThrow(/unknown judgment/);
    for (const body of [
      { ...unavailable[0], state: { model_id: 'changed', provider: 'changed' } },
      { ...unavailable[0], questions: { route: { type: 'choice', instructions: 'changed' } } },
      { ...unavailable[0], model: 'changed' },
    ]) {
      const changed = await fetch(`${server.baseURL}/v1/systemone`, { method: 'POST', body: JSON.stringify(body) });
      expect(changed.status).toBe(422);
    }
    expect(server.unexpected).toHaveLength(4);
  } finally { server.stop(); }
});

test('native readings match only captured semantic requests with intact host-identity relationships', async () => {
  const native = (await import('../fixtures/e2e-judgments/native-turn.json')).default;
  const prompt = 'first words in a brand new workspace';
  const valid = JSON.parse(JSON.stringify(native).split(JSON.stringify(native.state.originalSource.text)).join(JSON.stringify(prompt))) as typeof native;
  expect(e2eJudgmentAnswers(valid)?.kind).toBe('native-turn');
  for (const change of [
    (body: typeof valid) => { body.state.originalSource.text = 'different source'; },
    (body: typeof valid) => { body.state.originalSource.sourceRevision = 'a'.repeat(64); },
    (body: typeof valid) => { Object.assign(body.state.input.input, { problems: [{ kind: 'host-constraint' }] }); },
    (body: typeof valid) => { body.state.input.input.route.route = 'contract'; },
    (body: typeof valid) => { body.questions.disposition.instructions = 'Approve anything'; },
    (body: typeof valid) => { Object.assign(body.state, { extra: true }); },
  ]) {
    const changed = structuredClone(valid); change(changed);
    expect(e2eJudgmentAnswers(changed)).toBeUndefined();
  }
});

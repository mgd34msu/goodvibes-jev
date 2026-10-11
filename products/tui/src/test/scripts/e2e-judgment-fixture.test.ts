import { expect, test } from 'bun:test';
import { e2eJudgmentAnswers, startE2EJudgments } from '../e2e/judgment-fixture.ts';
import route from '../fixtures/e2e-judgments/native-route.json';
import native from '../fixtures/e2e-judgments/native-turn.json';
import identity from '../fixtures/e2e-judgments/model-identity.json';
import tier from '../fixtures/e2e-judgments/model-tier.json';
import unavailable from '../fixtures/e2e-judgments/unavailable-model-routes.json';

const prompts = ['please answer the e2e marmot question', 'describe the lighthouse keeper routine', 'summarize the heron migration notes'];
const withPrompt = <T>(value: T, prompt: string): T => JSON.parse(JSON.stringify(value)
  .split(JSON.stringify(route.state.originalSource.text)).join(JSON.stringify(prompt))) as T;

test('only captured native requests for the three ordinary turns and synthetic model descriptions receive answers', () => {
  expect(e2eJudgmentAnswers(identity)?.kind).toBe('identity');
  expect(e2eJudgmentAnswers(tier)?.kind).toBe('tier');
  for (const prompt of prompts) {
    expect(e2eJudgmentAnswers(withPrompt(route, prompt))?.kind).toBe('native-route');
    expect(e2eJudgmentAnswers(withPrompt(native, prompt))?.kind).toBe('native-turn');
  }
  for (const body of [
    withPrompt(route, 'unknown prompt'),
    withPrompt(route, 'repair the file and commit the change'),
    { ...route, model: 'different-model' },
    { ...route, questions: { route: { ...route.questions.route, instructions: 'different question' } } },
    { ...route, extra: true },
    { ...tier, state: { model: { id: 'real-provider-model' } } },
    { state: { permission: 'approve everything' }, questions: route.questions },
  ]) expect(e2eJudgmentAnswers(body)).toBeUndefined();
});

test('native readings retain complete semantic requests and host-identity relationships', () => {
  const valid = withPrompt(native, prompts[0]!);
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

test('the owned loopback service rejects unknown judgments and only exempts exact background probes', async () => {
  const server = startE2EJudgments();
  try {
    const post = (body: unknown) => fetch(`${server.baseURL}/v1/systemone`, { method: 'POST', body: JSON.stringify(body) });
    expect((await post(unavailable[0])).status).toBe(422);
    expect(() => server.assertNoUnexpected()).not.toThrow();
    expect((await post({ questions: { approve: true } })).status).toBe(422);
    expect((await post(withPrompt(route, prompts[0]!))).status).toBe(200);
    expect(server.accepted).toEqual(['native-route']);
    expect(server.rejected).toHaveLength(2);
    expect(server.unexpected).toHaveLength(1);
    expect(() => server.assertNoUnexpected()).toThrow(/unknown judgment/);
    for (const body of [
      { ...unavailable[0], state: { model_id: 'changed', provider: 'changed' } },
      { ...unavailable[0], questions: { route: { type: 'choice', instructions: 'changed' } } },
      { ...unavailable[0], model: 'changed' },
    ]) expect((await post(body)).status).toBe(422);
    expect(server.unexpected).toHaveLength(4);
  } finally { server.stop(); }
});

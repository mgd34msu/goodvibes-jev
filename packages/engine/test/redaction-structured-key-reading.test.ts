import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { redactSensitiveDataAsync, redactStructuredData, redactStructuredDataAsync } from '../sdk/src/platform/utils/redaction.ts';
import { snapshotJudgmentEvidence, snapshotJudgmentInput } from '../sdk/src/platform/gate/judgment-input.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
function fixture() {
  const fake = fakePort((name, question, state) => {
    expect(JSON.stringify(state)).not.toContain('synthetic-private');
    if (name === 'kind' && question.type === 'choice') {
      if (!state || typeof state !== 'object' || Array.isArray(state) || typeof state.field !== 'string') throw new Error('Missing authored field');
      return choiceAnswer(question, ['token', 'password'].includes(state.field) ? 'secret' : 'other', 0.999);
    }
    if (['lineHasCredential', 'spanIsCredential', 'credentialRemains', 'identifying'].includes(name)) return noulAnswer(0.001);
    throw new Error(`Unexpected structured key reading ${name}`);
  });
  installJudgmentPort(fake.port); return fake;
}
test.each(['token', 'password'])('protects %s assignment keys before hosted field reading and publication', async field => {
  const fake = fixture(), source = { stable: true, [`${field}=synthetic-private-key`]: 'Associated private field value' };
  const result = await redactStructuredDataAsync(source);
  expect(result).toEqual({ stable: true, [`${field}=[REDACTED]`]: '[REDACTED]' });
  expect(snapshotJudgmentEvidence(result)).toEqual(result);
  expect(JSON.stringify(fake.requests)).not.toContain('synthetic-private');
  expect(Object.keys(source)).toContain(`${field}=synthetic-private-key`);
});
test('ordinary assignment-shaped names retain their complete values after canonical negative readings', async () => {
  fixture(); const source = { 'documentId=public-shape': 'Published field value' };
  expect(await redactStructuredDataAsync(source)).toEqual(source);
});
test('an ordinary quoted value can retain an exact public redaction token through another egress pass', async () => {
  fixture(); const text = 'description:"The receipt is retained; password=[REDACTED]"';
  expect(await redactSensitiveDataAsync(text)).toBe(text);
  expect(await redactSensitiveDataAsync('description:"The receipt is retained; password=synthetic-private-nested"')).not.toContain('synthetic-private');
});
test('synchronous egress withholds credential-bearing names immediately and preserves colliding fields', async () => {
  const fake = fixture(), source = { 'token=synthetic-private-sync-first': 'First', 'token=synthetic-private-sync-second': 'Second' };
  const result = redactStructuredData(source);
  expect(Object.keys(result as object)).toHaveLength(2);
  expect(JSON.stringify(result)).not.toContain('synthetic-private');
  await redactStructuredDataAsync(source);
  expect(JSON.stringify(fake.requests)).not.toContain('synthetic-private');
});
test('redacted key collisions preserve every field without creating a new credential value', async () => {
  fixture();
  const result = await redactStructuredDataAsync({ 'password=synthetic-private-first': 1, 'password=synthetic-private-second': 2 });
  expect(result).toEqual({ 'password=[REDACTED]': '[REDACTED]', 'password=[REDACTED] [1]': '[REDACTED]' });
  expect(snapshotJudgmentEvidence(result)).toEqual(result); expect(() => snapshotJudgmentInput(result)).toThrow();
});
test('an original source edit while a field-name reply is pending withholds the structured result', async () => {
  const ordinary = fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const source = { 'token=synthetic-private-key': 'Public text', stable: true };
  installJudgmentPort({ model: ordinary.port.model, async ask(request) {
    if (request.state && typeof request.state === 'object' && !Array.isArray(request.state) && request.state.field === 'token') { entered.resolve(); await release.promise; }
    return ordinary.port.ask(request);
  } });
  const work = redactStructuredDataAsync(source); await entered.promise; source.stable = false; release.resolve();
  expect(await work).toBe('[REDACTED]');
});

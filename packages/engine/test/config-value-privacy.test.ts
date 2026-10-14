import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { redactConfigValue, redactObjectByPath } from '../sdk/src/platform/tools/goodvibes-runtime/credential-redaction.js';
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
test.each(['Authorization: Bearer synthetic-fixture', { nested: { password: 'synthetic-fixture' } }, `${'Ordinary text. '.repeat(80)}password=synthetic-fixture`])('private configuration values are masked before any reading %#', async value => {
  const fake = fakePort(() => noulAnswer(0)); installJudgmentPort(fake.port);
  expect(await redactConfigValue('custom.description', value)).toMatchObject({ redacted: true });
  expect(fake.requests).toHaveLength(0);
});
test('the complete value reaches a qualified semantic credential reading', async () => {
  const value = `${'Ordinary setting. '.repeat(60)}Late fixture correction.`;
  const fake = fakePort(name => noulAnswer(name === 'credential_material' ? 1 : 0)); installJudgmentPort(fake.port);
  expect(await redactConfigValue('custom.description', value)).toMatchObject({ redacted: true });
  const read = fake.requests.find(request => 'credential_material' in request.questions)!;
  expect((read.state as { value: string }).value).toBe(value);
});
test('object accessors never execute during configuration presentation', async () => {
  let reads = 0;
  expect(await redactObjectByPath('custom', { get description() { reads++; return 'private'; } })).toMatchObject({ redacted: true });
  expect(reads).toBe(0);
});
test('late source mutation cannot inject new private bytes into an approved object', async () => {
  const value = { description: 'Ordinary synthetic setting.' };
  const fake = fakePort(() => { value.description = 'Authorization: Bearer synthetic-fixture'; return noulAnswer(0); });
  installJudgmentPort(fake.port);
  expect(await redactConfigValue('custom', value)).toEqual({ description: 'Ordinary synthetic setting.' });
});

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { readCommandDiscovery } from '../sdk/src/platform/routing/command-discovery.ts';
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
const command = (id: string) => ({ id, title: id, description: `Registered command ${id}`, aliases: [], keywords: [] });

test('all 150 commands participate in one batched reading and only fitting registered ids are suggested', async () => {
  const fake = fakePort((name, question) => name === 'pick' ? choiceAnswer(question, 'command_149', 0.99) : noulAnswer(name === 'fits_149' ? 0.99 : 0.01)); installJudgmentPort(fake.port);
  const result = await readCommandDiscovery({ query: 'help with a purpose', commands: Array.from({ length: 150 }, (_, i) => command(`c${i}`)) });
  expect(result.ids).toEqual(['c149']);
  expect(fake.requests).toHaveLength(1);
  expect(Object.keys(fake.requests[0]!.questions)).toHaveLength(151);
});

test('a confident none or weak result supplies no executable suggestion', async () => {
  for (const probability of [0.99, 0.55]) {
    installJudgmentPort(fakePort((name, question) => name === 'pick' ? choiceAnswer(question, 'none', probability) : noulAnswer(0.01)).port);
    expect((await readCommandDiscovery({ query: 'unavailable action', commands: [command('clear')] })).ids).toEqual([]);
  }
});

test('changed source and retired installation invalidate a settled suggestion', async () => {
  const fake = fakePort((name, question) => name === 'pick' ? choiceAnswer(question, 'command_0', 0.99) : noulAnswer(0.99)); installJudgmentPort(fake.port);
  const input = { query: 'purpose', commands: [command('clear')] };
  const result = await readCommandDiscovery(input);
  input.commands[0]!.description = 'Different meaning';
  expect(result.assertCurrent).toThrow();
  const settled = await readCommandDiscovery({ query: 'purpose', commands: [command('clear')] });
  installJudgmentPort(undefined); installJudgmentPort(fake.port);
  expect(settled.assertCurrent).toThrow();
});

test('complete command metadata is screened before any projection or model call', async () => {
  const fake = fakePort(() => noulAnswer(0.99)); installJudgmentPort(fake.port);
  await expect(readCommandDiscovery({ query: 'purpose', commands: [{ ...command('clear'), description: 'Authorization: Bearer synthetic-private-token' }] })).rejects.toThrow();
  expect(fake.requests).toHaveLength(0);
});

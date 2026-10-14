/**
 * ops-playbook-search.test.ts
 *
 * findPlaybooksBySymptom ranks the registered playbooks against a free-text
 * symptom with the `engine.ops.playbook-search` rerank: one request per
 * playbook, only playbooks read as a match are returned, best first.
 */
import { JudgmentHeldError } from '../sdk/src/platform/types/judgment-held.ts';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Question } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { findPlaybooksBySymptom, getPlaybookRegistry } from '../sdk/src/platform/runtime/ops/index.ts';

/** A port that reads each playbook's match from `probabilities` by playbook name (default no). */
function playbookPort(probabilities: Readonly<Record<string, number>>) {
  return fakePort((_name: string, _question: Question, state: unknown) => {
    const candidate = (state as { candidate: { name: string } }).candidate;
    return noulAnswer(probabilities[candidate.name] ?? 0.02);
  });
}

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => {
  previous = installJudgmentPort(undefined);
});
afterEach(() => {
  installJudgmentPort(previous);
});

describe('findPlaybooksBySymptom', () => {
  test('asks once per playbook and returns the matches best first', async () => {
    const { port, requests } = playbookPort({ 'Reconnect Failure': 0.81, 'Plugin Degradation': 0.93 });
    installJudgmentPort(port);
    const found = await findPlaybooksBySymptom('the jira MCP plugin keeps dropping its connection');
    expect(requests).toHaveLength(getPlaybookRegistry().size);
    expect(requests[0]!.state).toMatchObject({ query: 'the jira MCP plugin keeps dropping its connection' });
    expect(found.map((p) => p.id)).toEqual(['plugin-degradation', 'reconnect-failure']);
  });

  test('a symptom no playbook addresses finds nothing', async () => {
    installJudgmentPort(playbookPort({}).port);
    expect(await findPlaybooksBySymptom('how do I change the colour theme?')).toEqual([]);
  });

  test('an unsure reading holds the search instead of claiming no matches', async () => {
    installJudgmentPort(playbookPort({ [getPlaybookRegistry().get('stuck-turn')!.playbook.name]: 0.5 }).port);
    await expect(findPlaybooksBySymptom('things feel slow')).rejects.toBeInstanceOf(JudgmentHeldError);
  });

  test('searching with no judgment port installed throws', async () => {
    await expect(findPlaybooksBySymptom('spinner frozen')).rejects.toBeInstanceOf(JudgmentPortMissingError);
  });
});


test('protected query tails refuse the whole playbook search before dispatch', async () => {
  const fixture = playbookPort({}); installJudgmentPort(fixture.port);
  await expect(findPlaybooksBySymptom('slow response '.repeat(200) + ' password=synthetic-private-value')).rejects.toThrow();
  expect(fixture.requests).toHaveLength(0);
});

test('retiring the Jev installation prevents a pending playbook search from returning matches', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const fixture = playbookPort({ [getPlaybookRegistry().get('stuck-turn')!.playbook.name]: 0.99 });
  installJudgmentPort({ model: fixture.port.model, async ask(request) { entered.resolve(); await release.promise; return fixture.port.ask(request); } });
  const pending = findPlaybooksBySymptom('stuck turn');
  await entered.promise; installJudgmentPort(playbookPort({}).port); release.resolve();
  await expect(pending).rejects.toThrow();
});

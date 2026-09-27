/**
 * ops-playbook-search.test.ts
 *
 * findPlaybooksBySymptom ranks the registered playbooks against a free-text
 * symptom with the `engine.ops.playbook-search` rerank: one request per
 * playbook, only playbooks read as a match are returned, best first.
 */
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

  test('an unsure reading is not a match', async () => {
    installJudgmentPort(playbookPort({ 'Stuck Turn': 0.5 }).port);
    expect(await findPlaybooksBySymptom('things feel slow')).toEqual([]);
  });

  test('searching with no judgment port installed throws', async () => {
    await expect(findPlaybooksBySymptom('spinner frozen')).rejects.toBeInstanceOf(JudgmentPortMissingError);
  });
});

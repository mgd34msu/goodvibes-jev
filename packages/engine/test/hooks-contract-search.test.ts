/**
 * hooks-contract-search.test.ts
 *
 * HookApi.contracts(filter) reads each hook point against the operator's
 * filter with the `engine.hooks.contract-search` rerank (one request per hook
 * point) and returns the ones read as a match, in catalog order. A blank
 * filter lists everything without asking.
 */
import { JudgmentHeldError } from '../sdk/src/platform/types/judgment-held.ts';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Question } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { createHookApi } from '../sdk/src/platform/hooks/hook-api.ts';
import { listHookPointContracts } from '../sdk/src/platform/hooks/contracts.ts';

/** A port that reads each hook point's match from `probabilities` by pattern (default no). */
function contractPort(probabilities: Readonly<Record<string, number>>) {
  return fakePort((_name: string, _question: Question, state: unknown) => {
    const candidate = (state as { candidate: { pattern: string } }).candidate;
    return noulAnswer(probabilities[candidate.pattern] ?? 0.02);
  });
}

function api() {
  return createHookApi({
    listContracts: listHookPointContracts,
    dispatcher: { listHooks: () => [], listChains: () => [] },
    workbench: {} as Parameters<typeof createHookApi>[0]['workbench'],
  } as Parameters<typeof createHookApi>[0]);
}

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

describe('hook contract search', () => {
  test('a blank filter lists every contract without a reading', async () => {
    const { port, requests } = contractPort({});
    installJudgmentPort(port);
    expect(await api().contracts('  ')).toHaveLength(listHookPointContracts().length);
    expect(requests).toHaveLength(0);
  });

  test('words that match no field literally still find the hook points they describe, in catalog order', async () => {
    const { port, requests } = contractPort({ 'Fail:mcp:call': 0.95, 'Pre:mcp:call': 0.9 });
    installJudgmentPort(port);
    const found = await api().contracts('intercept mcp');
    expect(requests).toHaveLength(listHookPointContracts().length);
    expect(requests[0]!.state).toMatchObject({ query: 'intercept mcp' });
    expect(found.map((contract) => contract.pattern)).toEqual(['Pre:mcp:call', 'Fail:mcp:call']);
  });

  test('an unsure reading holds the search instead of claiming no matches', async () => {
    installJudgmentPort(contractPort({ 'Pre:tool:*': 0.5 }).port);
    await expect(api().contracts('tool stuff')).rejects.toBeInstanceOf(JudgmentHeldError);
  });

  test('a filtered search with no judgment port installed throws', async () => {
    await expect(api().contracts('tool')).rejects.toBeInstanceOf(JudgmentPortMissingError);
  });
});

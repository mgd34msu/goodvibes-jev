/**
 * Turn intake (docs/design/contract-runner.md 10.3): a reply to a session's
 * open escalation goes to the contract before any route is read;
 * `contract.request-route` at act on `contract` starts a contract with origin
 * `turn` and the turn's text as the ask; every other route, and a contract
 * route below act, leaves the turn to the conversation. The agent tool's
 * `contractStarted` field is read as a fixed format.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import {
  createContractIntake,
  describeIntake,
  openEscalation,
  toolResultStartedContract,
  type ContractIntakeDeps,
  type ContractView,
  type OwnerReplyOutcome,
  type StartContractInput,
} from '../../sdk/src/platform/contract/index.js';
import { makeContract } from './fixtures.js';

let restore: JudgmentPort | undefined;
afterEach(() => {
  if (restore !== undefined) installJudgmentPort(restore);
  restore = undefined;
});

/** The route read as `route` with `confidence`; records every question asked. */
function routePort(route: string, confidence: number, asked: string[]): void {
  const fake = fakePort((name, question) => {
    asked.push(name);
    return name === 'route' ? choiceAnswer(question, route, confidence) : undefined;
  });
  restore = installJudgmentPort(fake.port);
}

function fakeRunner(contracts: ContractView[] = []) {
  const started: StartContractInput[] = [];
  const replies: { contractId: string; escalationId: string; text: string }[] = [];
  const runner: ContractIntakeDeps['runner'] = {
    list: (filter) => contracts.filter((contract) => filter?.sessionId === undefined || contract.sessionId === filter.sessionId),
    start: (input) => {
      started.push(input);
      return { contract: { ...makeContract(), id: 'ctr-0000abcd' }, owner: { id: 'agent-owner' } } as never;
    },
    reply: async (contractId, escalationId, text): Promise<OwnerReplyOutcome> => {
      replies.push({ contractId, escalationId, text });
      return { escalationId, reading: 'approve', outcome: 'act', action: 'approved' };
    },
  };
  return { runner, started, replies };
}

describe('turn intake', () => {
  test('work at act starts a contract with origin turn and the text as the ask', async () => {
    const asked: string[] = [];
    routePort('contract', 0.97, asked);
    const { runner, started } = fakeRunner();
    const outcome = await createContractIntake({ runner, projectRoot: '/repo' }).intake({ text: 'Add a --json flag to export.', sessionId: 's1' });
    expect(outcome).toEqual({ kind: 'started', contractId: 'ctr-0000abcd', ownerAgentId: 'agent-owner' });
    expect(started).toEqual([{ ask: 'Add a --json flag to export.', sessionId: 's1', origin: 'turn', projectRoot: '/repo' }]);
    expect(asked).toEqual(['route']);
  });

  test('conversation and answers stay with the conversation model', async () => {
    for (const route of ['converse', 'answer']) {
      routePort(route, 0.99, []);
      const { runner, started } = fakeRunner();
      expect(await createContractIntake({ runner, projectRoot: '/repo' }).intake({ text: 'hello', sessionId: 's1' })).toEqual({ kind: 'turn' });
      expect(started).toEqual([]);
    }
  });

  test('a contract route below act leaves the turn to the conversation', async () => {
    routePort('contract', 0.8, []);
    const { runner, started } = fakeRunner();
    expect(await createContractIntake({ runner, projectRoot: '/repo' }).intake({ text: 'maybe tidy this up?', sessionId: 's1' })).toEqual({ kind: 'turn' });
    expect(started).toEqual([]);
  });

  test('with an open escalation in the session the text is the reply, and no route is read', async () => {
    const asked: string[] = [];
    routePort('contract', 0.99, asked);
    const waiting: ContractView = {
      ...makeContract(),
      id: 'ctr-00001111',
      sessionId: 's1',
      escalations: [
        { id: 'ctr-00001111.e1', at: 1, scope: 'unit', targetId: 'u1', reason: 'unsettled', question: 'q1', unmetCriterionIds: [], resolvedAt: 2 },
        { id: 'ctr-00001111.e2', at: 3, scope: 'unit', targetId: 'u1', reason: 'unsettled', question: 'q2', unmetCriterionIds: [] },
      ],
    };
    const elsewhere: ContractView = { ...waiting, id: 'ctr-00002222', sessionId: 's2' };
    const { runner, replies, started } = fakeRunner([waiting, elsewhere]);
    const outcome = await createContractIntake({ runner, projectRoot: '/repo' }).intake({ text: 'yes, accept it', sessionId: 's1' });
    expect(outcome.kind).toBe('replied');
    expect(replies).toEqual([{ contractId: 'ctr-00001111', escalationId: 'ctr-00001111.e2', text: 'yes, accept it' }]);
    expect(started).toEqual([]);
    expect(asked).toEqual([]);
    if (outcome.kind === 'replied') expect(describeIntake(outcome)).toContain('read as approve: approved');
  });

  test('the newest open escalation across the session\'s contracts is the one answered', () => {
    const base = makeContract();
    const older: ContractView = { ...base, id: 'ctr-a', escalations: [{ id: 'a.e1', at: 5, scope: 'plan', targetId: 'ctr-a', reason: 'plan-unresolved', question: 'q', unmetCriterionIds: [] }] };
    const newer: ContractView = { ...base, id: 'ctr-b', escalations: [{ id: 'b.e1', at: 9, scope: 'plan', targetId: 'ctr-b', reason: 'plan-unresolved', question: 'q', unmetCriterionIds: [] }] };
    expect(openEscalation([older, newer])?.escalation.id).toBe('b.e1');
    expect(openEscalation([{ ...base, escalations: [] }])).toBeNull();
  });
});

describe('toolResultStartedContract', () => {
  test('reads the agent tool\'s contractStarted field and nothing else', () => {
    expect(toolResultStartedContract({ callId: 'c', success: true, output: JSON.stringify({ contractStarted: true, contractId: 'ctr-1' }) })).toBe(true);
    expect(toolResultStartedContract({ callId: 'c', success: true, output: JSON.stringify({ agentId: 'a', status: 'spawned' }) })).toBe(false);
    expect(toolResultStartedContract({ callId: 'c', success: false, output: JSON.stringify({ contractStarted: true }) })).toBe(false);
    expect(toolResultStartedContract({ callId: 'c', success: true, output: 'not json' })).toBe(false);
  });
});

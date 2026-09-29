/**
 * Turn intake (docs/design/contract-runner.md 10.3): with an open escalation
 * in the session, `contract.escalation-turn` reads whether the turn responds
 * to its question; unless it reads no at act the turn is the owner's reply and
 * goes to the contract before any route is read, and a no at act routes it
 * like any other turn;
 * `contract.request-route` at act on `contract` starts a contract with origin
 * `turn` and the turn's text as the ask; every other route, and a contract
 * route below act, leaves the turn to the conversation. The agent tool's
 * `contractStarted` field is read as a fixed format.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
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

/**
 * The route read as `route` with `confidence`, and whether a turn responds to
 * an open escalation read at probability `responds` (yes); records every
 * question asked and the state it was asked about.
 */
function routePort(route: string, confidence: number, asked: string[], responds = 0.97, states: unknown[] = []): void {
  const fake = fakePort((name, question, state) => {
    asked.push(name);
    states.push(state);
    if (name === 'responds') return noulAnswer(responds);
    return name === 'route' ? choiceAnswer(question, route, confidence) : undefined;
  });
  restore = installJudgmentPort(fake.port);
}

/** A session s1 contract with one open escalation, and a contract in session s2. */
function waitingContracts(): ContractView[] {
  const waiting: ContractView = {
    ...makeContract(),
    id: 'ctr-00001111',
    sessionId: 's1',
    escalations: [
      { id: 'ctr-00001111.e1', at: 1, scope: 'unit', targetId: 'u1', reason: 'unsettled', question: 'q1', unmetCriterionIds: [], resolvedAt: 2 },
      { id: 'ctr-00001111.e2', at: 3, scope: 'unit', targetId: 'u1', reason: 'unsettled', question: 'q2', unmetCriterionIds: [] },
    ],
  };
  return [waiting, { ...waiting, id: 'ctr-00002222', sessionId: 's2' }];
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

  test('with an open escalation, a turn read as responding to it is the reply, and no route is read', async () => {
    const asked: string[] = [];
    const states: unknown[] = [];
    routePort('contract', 0.99, asked, 0.97, states);
    const { runner, replies, started } = fakeRunner(waitingContracts());
    const outcome = await createContractIntake({ runner, projectRoot: '/repo' }).intake({ text: 'yes, accept it', sessionId: 's1' });
    expect(outcome.kind).toBe('replied');
    expect(replies).toEqual([{ contractId: 'ctr-00001111', escalationId: 'ctr-00001111.e2', text: 'yes, accept it' }]);
    expect(started).toEqual([]);
    expect(asked).toEqual(['responds']);
    expect(states).toEqual([{ question: 'q2', turn: 'yes, accept it' }]);
    if (outcome.kind === 'replied') expect(describeIntake(outcome)).toContain('read as approve: approved');
  });

  test('a turn read at act as unrelated to the open escalation goes to the request route and can start work', async () => {
    const asked: string[] = [];
    routePort('contract', 0.97, asked, 0.03);
    const { runner, replies, started } = fakeRunner(waitingContracts());
    const outcome = await createContractIntake({ runner, projectRoot: '/repo' }).intake({ text: 'Rename the user service everywhere.', sessionId: 's1' });
    expect(outcome).toEqual({ kind: 'started', contractId: 'ctr-0000abcd', ownerAgentId: 'agent-owner' });
    expect(asked).toEqual(['responds', 'route']);
    expect(replies).toEqual([]);
    expect(started).toEqual([{ ask: 'Rename the user service everywhere.', sessionId: 's1', origin: 'turn', projectRoot: '/repo' }]);
  });

  test('an unrelated turn the route leaves to the conversation stays a normal turn; the escalation is not answered', async () => {
    routePort('answer', 0.97, [], 0.05);
    const { runner, replies, started } = fakeRunner(waitingContracts());
    expect(await createContractIntake({ runner, projectRoot: '/repo' }).intake({ text: 'What is a mutex?', sessionId: 's1' })).toEqual({ kind: 'turn' });
    expect(replies).toEqual([]);
    expect(started).toEqual([]);
  });

  test('a turn read below act on either side goes to the escalation, whose reply reading asks again when it is unclear', async () => {
    // 0.2: no at confirm (below the high act threshold); 0.5: a tie that settles on neither side; 0.65: yes at confirm.
    for (const responds of [0.2, 0.5, 0.65]) {
      const asked: string[] = [];
      routePort('contract', 0.99, asked, responds);
      const { runner, replies, started } = fakeRunner(waitingContracts());
      const outcome = await createContractIntake({ runner, projectRoot: '/repo' }).intake({ text: 'hmm, maybe', sessionId: 's1' });
      expect(outcome.kind).toBe('replied');
      expect(replies).toEqual([{ contractId: 'ctr-00001111', escalationId: 'ctr-00001111.e2', text: 'hmm, maybe' }]);
      expect(started).toEqual([]);
      expect(asked).toEqual(['responds']);
    }
  });

  test('no escalation-turn question is asked when the session has no open escalation', async () => {
    const asked: string[] = [];
    routePort('converse', 0.99, asked);
    const { runner } = fakeRunner(waitingContracts());
    expect(await createContractIntake({ runner, projectRoot: '/repo' }).intake({ text: 'hello', sessionId: 's3' })).toEqual({ kind: 'turn' });
    expect(asked).toEqual(['route']);
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

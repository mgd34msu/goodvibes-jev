/**
 * The owner pasted a flight itinerary into Telegram and got an engineering
 * workflow.
 *
 * Separate defects produced that; the two that live in the agent layer each
 * have a describe block below:
 *
 * 1. The conversation gate correctly decided "this is conversation" and spawned
 *    with `outsideContract: true` + `replyStyle: 'conversational'`, and a
 *    rewrite of root spawns read the CONTINUATION PROMPT, which embeds the chat
 *    transcript, found an earlier assistant sentence ("I'll review the route,
 *    timing, stops"), and forced a checked workflow back on. No spawn is
 *    rewritten from its wording now: the caller's outsideContract decision is
 *    the whole decision, and a spawn without it becomes a contract's owner with
 *    its task untouched.
 * 2. Every assistant message appeared TWICE in the continuation prompt, because
 *    two different reporters each wrote the same agent's completion into the
 *    shared session.
 *
 * (The third defect, the person receiving workflow bookkeeping instead of an
 * answer, is the contract owner's answer and operator-only status line,
 * covered in test/contract/runner.test.ts.)
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SharedSessionBroker } from '../sdk/src/platform/control-plane/session-broker.js';
import { trackDisposables } from './_helpers/disposables.ts';
import { AgentMessageBus } from '../sdk/src/platform/agents/message-bus.js';
import { AgentManager, type AgentRecord } from '../sdk/src/platform/tools/agent/manager.js';
import {
  appendSharedSessionMessage,
  buildSharedSessionContinuationTask,
  findAgentCompletionMessage,
  type SharedSessionMessageStore,
} from '../sdk/src/platform/control-plane/session-broker-messages.js';
import type { SharedSessionMessage, SharedSessionRecord } from '../sdk/src/platform/control-plane/session-types.js';
import type { ConfigManager } from '../sdk/src/platform/config/index.js';
import { makeContract } from './contract/fixtures.js';

const disposables = trackDisposables();

/** The exact prompt shape that hijacked the live conversation. */
const ITINERARY_CONTINUATION_TASK = [
  'Continue the shared control-plane session "8546431428".',
  '',
  'Preserve continuity with the recent transcript and answer the newest user message directly.',
  '',
  'Recent transcript:',
  'Avery: I\'m traveling from Dallas to Picayune MS on Thursday to see my parents.',
  '',
  'Assistant: I don\'t see the itinerary screenshots attached here. Please upload or resend '
    + 'them, and I\'ll review the route, timing, stops, and any potential travel issues for Thursday.',
  '',
  'Avery: Confirmation #: B79YKY. Departing Thu, Aug 06 2026, 07:55 AM DAL, arrives 09:20 AM MSY.',
].join('\n');

function createConfigManager(): Pick<ConfigManager, 'get'> {
  return { get: ((key: string): unknown => (key === 'agents.maxActive' ? 20 : undefined)) as ConfigManager['get'] };
}

interface Harness {
  readonly manager: AgentManager;
  /** Every record AgentManager handed to the contract runner's startForOwner. */
  readonly owned: AgentRecord[];
  readonly runRecords: AgentRecord[];
}

function createHarness(): Harness {
  const runRecords: AgentRecord[] = [];
  const owned: AgentRecord[] = [];
  const manager = new AgentManager({
    archetypeLoader: { loadArchetype: () => null },
    messageBus: new AgentMessageBus(),
    configManager: createConfigManager(),
    executor: {
      async runAgent(record) {
        record.status = 'running';
        runRecords.push(record);
      },
    },
    contractRunner: {
      startForOwner(record) {
        owned.push(record);
        record.contractId = `ctr-${String(owned.length).padStart(8, '0')}`;
        record.contractRole = 'owner';
        record.status = 'running';
        return { contract: makeContract({ id: record.contractId, ask: record.task, ownerAgentId: record.id }), owner: record };
      },
    },
  });
  return { manager, owned, runRecords };
}

describe('the caller\'s outsideContract decision outranks what the task text says', () => {
  test('a conversational continuation whose transcript says "review the route" starts no contract', () => {
    const { manager, owned, runRecords } = createHarness();

    const record = manager.spawn({
      mode: 'spawn',
      task: ITINERARY_CONTINUATION_TASK,
      outsideContract: true,
      replyStyle: 'conversational',
    });

    expect(owned).toHaveLength(0);
    expect(runRecords).toEqual([record]);
    expect(record.contractId).toBeUndefined();
    expect(record.contractRole).toBeUndefined();
    expect(record.routeReason).toBeUndefined();
    // The whole decision survives, not just half of it: the reply must still
    // read as a reply to a person, and the task must not be rewritten into an
    // engineering ask.
    expect(record.replyStyle).toBe('conversational');
    expect(record.outsideContract).toBe(true);
    expect(record.reviewMode).toBe('none');
    expect(record.template).toBe('general');
    expect(record.task).toBe(ITINERARY_CONTINUATION_TASK);
    expect(record.context).toBeUndefined();
  });

  test('the same text without the decision becomes a contract owner, its task untouched', () => {
    const { manager, owned, runRecords } = createHarness();

    const record = manager.spawn({ mode: 'spawn', task: ITINERARY_CONTINUATION_TASK });

    expect(owned).toEqual([record]);
    expect(runRecords).toHaveLength(0);
    expect(record.contractRole).toBe('owner');
    expect(record.task).toBe(ITINERARY_CONTINUATION_TASK);
    expect(record.template).toBe('general');
    expect(record.routeReason).toBeUndefined();
  });

  test('a declared reviewer template keeps the caller\'s outsideContract decision', () => {
    const { manager, owned, runRecords } = createHarness();

    const record = manager.spawn({
      mode: 'spawn',
      task: 'Review the implementation for correctness.',
      template: 'reviewer',
      outsideContract: true,
    });

    expect(owned).toHaveLength(0);
    expect(runRecords).toEqual([record]);
    expect(record.template).toBe('reviewer');
    expect(record.contractRole).toBeUndefined();
    expect(record.reviewMode).toBe('none');
  });
});

describe('an agent contributes one message to the transcript, not two', () => {
  function createStore(sessionId: string): SharedSessionMessageStore {
    const now = Date.now();
    const session: SharedSessionRecord = {
      id: sessionId,
      title: 'Telegram 8546431428',
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      messageCount: 0,
      participants: [],
      routeIds: [],
    } as unknown as SharedSessionRecord;
    return {
      sessions: new Map([[sessionId, session]]),
      messages: new Map<string, SharedSessionMessage[]>(),
    };
  }

  test('findAgentCompletionMessage recognizes an agent that already reported', () => {
    const store = createStore('session-1');
    expect(findAgentCompletionMessage(store, 'session-1', 'agent-a')).toBeUndefined();

    appendSharedSessionMessage(store, {
      sessionId: 'session-1',
      role: 'assistant',
      body: 'sunny and 74 degrees',
      agentId: 'agent-a',
      metadata: { status: 'completed' },
    }, 100);

    expect(findAgentCompletionMessage(store, 'session-1', 'agent-a')?.body).toBe('sunny and 74 degrees');
    // A message from the same agent WITHOUT a terminal status (a progress note)
    // is not a completion and must not suppress the real one.
    expect(findAgentCompletionMessage(store, 'session-1', 'agent-b')).toBeUndefined();
  });

  test('the continuation prompt carries each assistant answer once', () => {
    const store = createStore('session-2');
    const append = (input: Parameters<typeof appendSharedSessionMessage>[1]): void => {
      // Exactly what the broker does now: the second reporter for an agent that
      // already reported is not stored again.
      if (input.agentId && findAgentCompletionMessage(store, input.sessionId, input.agentId)) return;
      appendSharedSessionMessage(store, input, 100);
    };

    append({ sessionId: 'session-2', role: 'user', body: 'How\'s the weather', displayName: 'Avery' });
    // The runtime event bus reports the finished agent...
    append({ sessionId: 'session-2', role: 'assistant', body: 'Sunny and 74.', agentId: 'agent-w', metadata: { status: 'completed' } });
    // ...and the pending-surface-reply poller reports the same one.
    append({ sessionId: 'session-2', role: 'assistant', body: 'Sunny and 74.', agentId: 'agent-w', metadata: { status: 'completed' } });

    const messages = store.messages.get('session-2') ?? [];
    expect(messages.filter((message) => message.role === 'assistant')).toHaveLength(1);

    const prompt = buildSharedSessionContinuationTask({
      session: store.sessions.get('session-2') ?? null,
      messages,
      fallbackSessionId: 'session-2',
    });
    expect(prompt.split('Assistant: Sunny and 74.').length - 1).toBe(1);
  });

  test('the real broker stores one message when both reporters call completeAgent', async () => {
    const storePath = join(mkdtempSync(join(tmpdir(), 'gv-chain-authority-')), 'sessions.json');
    const broker = disposables.add(new SharedSessionBroker({
      storePath,
      routeBindings: {
        start: async () => {},
        stop: async () => {},
        list: () => [],
        getBinding: () => null,
        resolve: () => null,
        patchBinding: async () => null,
      },
      agentStatusProvider: { getStatus: () => null },
      messageSender: { send: () => false },
    } as unknown as ConstructorParameters<typeof SharedSessionBroker>[0]));

    await broker.createSession({ id: 'session-both' });

    // The runtime event bus fires first with the agent's own output...
    await broker.completeAgent('session-both', 'agent-both', 'Your flight leaves DAL at 07:55.', { status: 'completed', durationMs: 12 });
    // ...then the daemon's pending-surface-reply poller reports the same agent.
    await broker.completeAgent('session-both', 'agent-both', 'Your flight leaves DAL at 07:55.', { status: 'completed', routeId: 'route-telegram-1' });

    const stored = broker.getMessages('session-both', 100)
      .filter((message) => message.agentId === 'agent-both');
    expect(stored).toHaveLength(1);
    expect(stored[0]?.body).toBe('Your flight leaves DAL at 07:55.');
    expect(stored[0]?.role).toBe('assistant');
  });
});

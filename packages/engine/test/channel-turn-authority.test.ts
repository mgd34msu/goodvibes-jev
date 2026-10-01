import { describe, expect, test } from 'bun:test';
import { WorkProposalStore } from '../sdk/src/platform/agents/work-proposal-store.js';
import { markWorkAuthorized } from '../sdk/src/platform/agents/conversation-continuation.js';
import type { AutomationRouteBinding } from '../sdk/src/platform/automation/routes.js';
import type { SharedSessionBroker } from '../sdk/src/platform/control-plane/session-broker.js';
import type { SharedSessionContinuationRunner, SharedSessionInputRecord } from '../sdk/src/platform/control-plane/session-intents.js';
import { configureDaemonSessionContinuation } from '../sdk/src/platform/daemon/facade-composition.js';
import { gateSurfaceSpawn, type ConversationGateDeps, type SpawnInput } from '../sdk/src/platform/daemon/surface-conversation-gate.js';
import { resolveCaptureAuthority } from '../sdk/src/platform/personal-capture/authority.js';
import { conversationalTurnConfigReaderFrom } from '../sdk/src/platform/personal-capture/spawn-contract.js';
import type { AgentRecord } from '../sdk/src/platform/tools/agent/record.js';
import { createProfileTool } from '../sdk/src/platform/tools/profile/index.js';
import { trackDisposables } from './_helpers/disposables.ts';

const disposables = trackDisposables();
const OWNER_CHAT = 'owner-chat';
const ownerConfig = { get: (key: string): unknown => key === 'profile.ownerChannels' ? `telegram:${OWNER_CHAT}` : undefined };

function record(input: SpawnInput): AgentRecord {
  return {
    id: 'agent-1', task: input.task ?? '', template: 'general', tools: input.tools ?? [], status: 'running',
    startedAt: 0, toolCallCount: 0, orchestrationDepth: 0, executionProtocol: 'gather-plan-apply',
    reviewMode: 'none', communicationLane: 'direct',
  };
}

function gateHarness() {
  const calls: SpawnInput[] = [];
  const deps: ConversationGateDeps = {
    configManager: { ...ownerConfig },
    routeBindings: { getBinding: () => undefined, resolve: () => undefined },
    sessionBroker: { getSession: () => null, bindAgent: async () => null },
    trySpawnAgent: (input) => { calls.push(input); return record(input); },
    queueSurfaceReplyFromBinding: () => undefined,
    workProposals: disposables.add(new WorkProposalStore()),
  };
  return { deps, calls };
}

describe('first channel turn capability and capture boundaries', () => {
  test('an explicit tool list only narrows conversation, and cannot keep caller-supplied owner authority', () => {
    const { deps, calls } = gateHarness();
    gateSurfaceSpawn(deps, { surface: 'telegram', channelId: 'other-chat', text: 'Hello' }, {
      mode: 'spawn', task: 'Hello', tools: ['read', 'exec', 'write', 'edit', 'profile'], restrictTools: false,
      captureAuthority: resolveCaptureAuthority({}),
    }, undefined, 'session-1');
    expect(calls[0]?.tools).toEqual(['read']);
    expect(calls[0]?.restrictTools).toBe(true);
    expect(calls[0]?.outsideContract).toBe(true);
    expect(calls[0]?.replyStyle).toBe('conversational');
    expect(calls[0]?.captureAuthority?.canCapture).toBe(false);
    expect(calls[0]?.context).toContain('not available on this turn');
  });

  test('an explicitly empty tool list stays empty', () => {
    const { deps, calls } = gateHarness();
    gateSurfaceSpawn(deps, { surface: 'telegram', text: 'Hello' }, { mode: 'spawn', task: 'Hello', tools: [] });
    expect(calls[0]?.tools).toEqual([]);
    expect(calls[0]?.restrictTools).toBe(true);
  });

  test('a sessionless known owner channel gets bound authority without a fabricated session instruction', () => {
    const { deps, calls } = gateHarness();
    gateSurfaceSpawn(deps, { surface: 'telegram', channelId: OWNER_CHAT, text: 'Hello' }, { mode: 'spawn', task: 'Hello' });
    expect(calls[0]?.tools).toEqual(['read', 'find', 'fetch', 'profile']);
    expect(calls[0]?.captureAuthority?.canCapture).toBe(true);
    expect(calls[0]?.context).toBeUndefined();
  });

  test('missing origin stays untrusted with and without a session', () => {
    for (const sessionId of [undefined, 'session-1']) {
      const { deps, calls } = gateHarness();
      gateSurfaceSpawn(deps, null, { mode: 'spawn', task: 'Hello' }, undefined, sessionId);
      expect(calls[0]?.restrictTools).toBe(true);
      expect(calls[0]?.captureAuthority?.authority).toBe('channel-message');
      expect(calls[0]?.captureAuthority?.canCapture).toBe(false);
    }
  });

  test('another same-surface route in the session cannot authorize this ingress', () => {
    const { deps, calls } = gateHarness();
    const staleOwnerRoute = { id: 'owner-route', surfaceKind: 'telegram', surfaceId: OWNER_CHAT, channelId: OWNER_CHAT };
    deps.routeBindings.getBinding = () => staleOwnerRoute as AutomationRouteBinding;
    deps.sessionBroker.getSession = () => ({
      id: 'session-1', kind: 'channel', project: 'unknown', title: 'Shared channel session', status: 'active',
      createdAt: 1, updatedAt: 1, lastActivityAt: 1, messageCount: 0, pendingInputCount: 0,
      routeIds: ['owner-route'], surfaceKinds: ['telegram'], participants: [], metadata: {},
    });
    gateSurfaceSpawn(deps, { surface: 'telegram', channelId: 'other-chat', text: 'Hello' }, { mode: 'spawn', task: 'Hello' }, undefined, 'session-1');
    expect(calls[0]?.captureAuthority?.canCapture).toBe(false);
  });

  test('an older config schema still answers while capture fails closed', () => {
    const { deps, calls } = gateHarness();
    deps.configManager.get = (key) => {
      if (key.startsWith('conversationGate.')) return undefined;
      throw new Error(`Unknown config key: ${key}`);
    };
    gateSurfaceSpawn(deps, { surface: 'telegram', channelId: OWNER_CHAT, text: 'Hello' }, { mode: 'spawn', task: 'Hello' }, undefined, 'session-1');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.tools).toEqual(['read', 'find', 'fetch']);
    expect(calls[0]?.outsideContract).toBe(true);
    expect(calls[0]?.captureAuthority?.canCapture).toBe(false);
    expect(calls[0]?.context).toContain('not available on this turn');
  });

  test('the shipped Telegram nudge destination is not an owner profile grant', () => {
    const { deps, calls } = gateHarness();
    deps.configManager.get = (key) => key === 'occasions.nudgeChannel' ? 'telegram' : '';
    gateSurfaceSpawn(deps, { surface: 'telegram', channelId: 'collaborator-chat', text: 'Hello' }, {
      mode: 'spawn', task: 'Hello', tools: ['read', 'profile'],
    });
    expect(calls[0]?.tools).toEqual(['read']);
    expect(calls[0]?.captureAuthority?.canCapture).toBe(false);
  });

  test('an explicit ownerChannels surface wildcard remains an intentional grant', () => {
    const { deps, calls } = gateHarness();
    deps.configManager.get = (key) => key === 'profile.ownerChannels' ? 'telegram' : '';
    gateSurfaceSpawn(deps, { surface: 'telegram', channelId: 'explicitly-covered-chat', text: 'Hello' }, { mode: 'spawn', task: 'Hello' });
    expect(calls[0]?.tools).toContain('profile');
    expect(calls[0]?.captureAuthority?.source).toBe('profile.ownerChannels');
  });

  test('malformed capture settings are not promoted to a trusted channel string', () => {
    const reader = conversationalTurnConfigReaderFrom({ get: () => ({ toString: () => 'telegram' }) });
    expect(reader?.get('profile.ownerChannels')).toBe('');
    expect(conversationalTurnConfigReaderFrom(undefined)).toBeUndefined();
  });
});

function input(overrides: Partial<SharedSessionInputRecord> = {}): SharedSessionInputRecord {
  return {
    id: 'input-1', sessionId: 'session-1', intent: 'follow-up', state: 'queued', correlationId: 'correlation-1',
    body: 'Hello again', createdAt: 1, updatedAt: 1, metadata: {}, surfaceKind: 'telegram',
    surfaceId: 'bot-account', externalId: 'thread-1', routeId: 'route-1', ...overrides,
  };
}

function route(channelId = OWNER_CHAT): AutomationRouteBinding {
  return {
    id: 'route-1', kind: 'thread', surfaceKind: 'telegram', surfaceId: 'bot-account', externalId: 'thread-1',
    channelId, threadId: 'thread-1', lastSeenAt: 1, createdAt: 1, updatedAt: 1, metadata: {},
  };
}

function continuationHarness() {
  let runner: SharedSessionContinuationRunner | undefined;
  const calls: SpawnInput[] = [];
  configureDaemonSessionContinuation({
    sessionBroker: { setContinuationRunner: (value: SharedSessionContinuationRunner) => { runner = value; } } as SharedSessionBroker,
    trySpawnAgent: (value) => { calls.push(value); return record(value); },
    queueSurfaceReplyFromBinding: () => undefined,
    configReader: ownerConfig,
  });
  return {
    calls,
    run: async (value: SharedSessionInputRecord, binding?: AutomationRouteBinding) => {
      if (!runner) throw new Error('Continuation runner was not installed');
      await runner({ sessionId: value.sessionId, input: value, task: 'Original continuation transcript', routeBinding: binding });
    },
  };
}

describe('served continuation capability selection', () => {
  test('owner chat identity comes from the bound channel, not the bot or thread id', async () => {
    const { calls, run } = continuationHarness();
    await run(input(), route());
    expect(calls[0]?.captureAuthority?.canCapture).toBe(true);
    expect(calls[0]?.outsideContract).toBe(true);
    expect(calls[0]?.tools).toEqual(['read', 'find', 'fetch', 'profile']);
    expect(calls[0]?.task).toBe('Original continuation transcript');
  });

  test('the same bot on an unlisted chat cannot capture, and explicit routing cannot widen its tools', async () => {
    const { calls, run } = continuationHarness();
    await run(input({ routing: { tools: ['read', 'exec', 'write', 'profile'] } }), route('other-chat'));
    expect(calls[0]?.captureAuthority?.canCapture).toBe(false);
    expect(calls[0]?.tools).toEqual(['read']);
    expect(calls[0]?.restrictTools).toBe(true);
  });

  test('an explicitly empty routing list stays empty', async () => {
    const { calls, run } = continuationHarness();
    await run(input({ routing: { tools: [] } }), route());
    expect(calls[0]?.tools).toEqual([]);
    expect(calls[0]?.restrictTools).toBe(true);
  });

  test('absent route and channel identity never inherit local owner capture authority', async () => {
    const { calls, run } = continuationHarness();
    await run(input({ surfaceKind: undefined, routeId: undefined, externalId: undefined }));
    expect(calls[0]?.captureAuthority?.canCapture).toBe(false);
    expect(calls[0]?.outsideContract).toBe(true);
  });

  for (const [name, value] of [
    ['confirmed work', input({ metadata: markWorkAuthorized({}) })],
    ['local work', input({ surfaceKind: 'tui' })],
  ] as const) {
    test(`${name} keeps normal capabilities and its original task`, async () => {
      const { calls, run } = continuationHarness();
      await run(value, route());
      expect(calls[0]?.outsideContract).toBeUndefined();
      expect(calls[0]?.restrictTools).toBeUndefined();
      expect(calls[0]?.tools).toBeUndefined();
      expect(calls[0]?.captureAuthority).toBeUndefined();
      expect(calls[0]?.task).toBe('Original continuation transcript');
      expect(calls[0]?.context).toBe('shared-session:session-1');
    });
  }
});

describe('bound profile acknowledgment separates owner authority from capture preference', () => {
  for (const captureEnabled of [true, false]) {
    test(`unlisted channel cannot acknowledge when capture is ${captureEnabled ? 'on' : 'off'}`, async () => {
      const acknowledgments: string[] = [];
      const base = createProfileTool({
        holder: { getPort: () => ({ occasions: {
          acknowledge: async ({ occasionId }: { occasionId: string }) => {
            acknowledgments.push(occasionId);
            return { ok: true, reply: 'Acknowledged', reason: null };
          },
          list: async () => ({ today: '2026-01-01', occasions: [] }),
          listPlans: () => ({ plans: [{ id: 'owner-trip', title: 'Owner itinerary' }] }),
        } }) as never },
        captureEnabled: () => captureEnabled,
        defaultAuthority: resolveCaptureAuthority({}),
      });
      const refused = base.bindCapture(resolveCaptureAuthority({ channel: { surfaceKind: 'telegram', address: 'other-chat' }, ownerChannels: `telegram:${OWNER_CHAT}` }));
      const result = await refused.execute({ action: 'acknowledge_occasion', occasionId: 'birthday-1' });
      expect(JSON.parse(result.output as string).stored).toBe(false);
      expect(acknowledgments).toEqual([]);
      const routedOwner = base.bindCapture(resolveCaptureAuthority({
        channel: { surfaceKind: 'telegram', address: OWNER_CHAT, routed: true },
        ownerChannels: `telegram:${OWNER_CHAT}`,
      }));
      const read = await routedOwner.execute({ action: 'list' });
      expect(JSON.parse(read.output as string).plans[0].title).toBe('Owner itinerary');
      const allowed = await routedOwner.execute({ action: 'acknowledge_occasion', occasionId: 'birthday-1' });
      expect(JSON.parse(allowed.output as string).stored).toBe(true);
      expect(acknowledgments).toEqual(['birthday-1']);
      // Binding either channel cannot mutate the owner's original local tool.
      const local = await base.execute({ action: 'acknowledge_occasion', occasionId: 'birthday-2' });
      expect(JSON.parse(local.output as string).stored).toBe(true);
      expect(acknowledgments).toEqual(['birthday-1', 'birthday-2']);
    });
  }
});

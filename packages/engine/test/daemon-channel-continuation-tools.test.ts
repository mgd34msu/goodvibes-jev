/**
 * daemon-channel-continuation-tools.test.ts
 *
 * The tools a channel conversation is actually offered on a SERVED daemon.
 *
 * `createRuntimeServices` installs a continuation runner that spawns a
 * conversational turn with the conversational tool list (profile, read, find,
 * fetch). `DaemonServer` then installs its OWN runner over it
 * (`configureDaemonSessionContinuation`). That runner used to spawn with no
 * tool list and a bare `shared-session:<id>` context, so a Telegram follow-up
 * queued behind a running turn was offered read, write, edit, find, exec,
 * analyze, inspect, fetch and registry, and not `profile`.
 *
 * Nothing here stubs a runner. Both cases run through the real composition:
 * the daemon's broker, the daemon's conversation gate, the daemon's
 * AgentManager, and a scripted provider that records the tool definitions it
 * was sent. A follow-up is continued the way it is in production, the first
 * agent finishes, AGENT_COMPLETED reaches the broker over the runtime bus, and
 * the broker hands the queued input to whichever runner is installed.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, spyOn, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, choiceAnswer } from '@goodvibes-jev/judgment/testing';
import { forgetGateReadings, gateReadingsPort, READ_ONLY } from './_helpers/gate-readings.ts';
import { seedBenchmarkCache } from './_helpers/benchmark-cache.ts';
import { ConfigManager } from '../sdk/src/platform/config/manager.js';
import { DaemonServer } from '../sdk/src/platform/daemon/facade.js';
import { gateSurfaceSpawn } from '../sdk/src/platform/daemon/surface-conversation-gate.js';
import type { DaemonSurfaceActionHelper } from '../sdk/src/platform/daemon/surface-actions.js';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.js';
import { createRuntimeServices, type RuntimeServices } from '../sdk/src/platform/runtime/services.js';
import { createRuntimeStore } from '../sdk/src/platform/runtime/store/index.js';
import type { ChatRequest, ChatResponse, LLMProvider } from '../sdk/src/platform/providers/interface.js';
import type { SharedSessionContinuationRunner, SharedSessionInputRecord } from '../sdk/src/platform/control-plane/session-intents.js';
import type { AgentRecord } from '../sdk/src/platform/tools/agent/record.js';
import type { SpawnInput } from '../sdk/src/platform/daemon/surface-conversation-gate.js';
import type { ModelDefinition } from '../sdk/src/platform/providers/registry.js';
import type { PersonalCaptureHolder } from '../sdk/src/platform/personal-capture/port.js';
import { trackDisposables } from './_helpers/disposables.ts';

const PROVIDER = 'scripted';
const MODEL = 'scripted-1';
const WAIT_MS = 15_000;

const FIRST_MESSAGE = 'Hey, are you there?';
const FOLLOW_UP = 'Hey, are you still there?';


const disposables = trackDisposables();

interface Harness {
  readonly services: RuntimeServices;
  readonly daemon: DaemonServer;
  /** Every request the scripted provider received, in order. */
  readonly requests: ChatRequest[];
  /** Lets the first model call (the running turn) return. */
  readonly releaseFirst: () => void;
  readonly runtimeContinuation: SharedSessionContinuationRunner;
  readonly profileCalls: { reads: number; acknowledgments: number };
}

function text(content: string): ChatResponse {
  return { content, toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'completed' };
}

function requestText(request: ChatRequest): string {
  return JSON.stringify(request.messages ?? []);
}

function toolNames(request: ChatRequest): string[] {
  return (request.tools ?? []).map((tool) => tool.name);
}

async function waitFor<T>(what: string, probe: () => T | undefined): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

function buildHarness(options: { attemptProfile?: boolean; ownerChannels?: string; useDefaultOwnerChannels?: boolean } = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-channel-continuation-tools-'));
  disposables.defer(() => rmSync(root, { recursive: true, force: true }));
  const workingDir = join(root, 'workspace');
  const homeDirectory = join(root, 'home');
  mkdirSync(workingDir, { recursive: true });
  mkdirSync(homeDirectory, { recursive: true });
  seedBenchmarkCache(homeDirectory, 'goodvibes');

  const configManager = new ConfigManager({ homeDir: homeDirectory, workingDir, surfaceRoot: 'goodvibes-test' });
  // Permission prompting is orthogonal to the scoped capability boundary.
  configManager.set('permissions.backgroundAgents', 'allow-all');
  if (!options.useDefaultOwnerChannels) configManager.set('profile.ownerChannels', options.ownerChannels ?? 'telegram:chat-1');

  const requests: ChatRequest[] = [];
  let release: () => void = () => {};
  const firstMayReturn = new Promise<void>((resolve) => { release = resolve; });
  let heldFirst = false;
  let attemptedProfile = false;
  const profileCalls = { reads: 0, acknowledgments: 0 };

  const provider = {
    name: PROVIDER,
    models: [MODEL],
    credentialAuthority: 'anonymous',
    modelSource: { kind: 'dated-static', asOf: '2026-01-01' },
    isConfigured: () => true,
    chat: async (request: ChatRequest): Promise<ChatResponse> => {
      requests.push(request);
      // The first conversational turn stays running until the test has queued
      // its follow-up behind it.
      if (!heldFirst && requestText(request).includes(FIRST_MESSAGE)) {
        heldFirst = true;
        await firstMayReturn;
      }
      if (options.attemptProfile && !attemptedProfile) {
        attemptedProfile = true;
        return {
          content: '', stopReason: 'tool_call', usage: { inputTokens: 10, outputTokens: 5 },
          toolCalls: [
            { id: 'profile-read-attempt', name: 'profile', arguments: { action: 'list' } },
            { id: 'profile-write-attempt', name: 'profile', arguments: { action: 'acknowledge_occasion', occasionId: 'synthetic-date' } },
          ],
        };
      }
      return text('I am here.');
    },
  } as unknown as LLMProvider;

  const services = disposables.add(createRuntimeServices({
    configManager,
    runtimeBus: new RuntimeEventBus(),
    runtimeStore: createRuntimeStore(),
    surfaceRoot: 'goodvibes',
    getConversationTitle: () => 'channel continuation tools',
    workingDir,
    homeDirectory,
  }));
  if (options.attemptProfile) {
    // Replace only the backing store port. The real profile tool, agent
    // registry, per-turn capture binding, and provider loop stay composed.
    const holder = (services.agentOrchestrator as unknown as {
      toolDeps: { personalCapture: PersonalCaptureHolder };
    }).toolDeps.personalCapture;
    holder.setPort({
      occasions: {
        list: async () => { profileCalls.reads++; return { today: '2026-01-01', occasions: [{ occasion: { id: 'SYNTHETIC_PRIVATE_PROFILE' } }] }; },
        listPlans: () => ({ plans: [] }),
        acknowledge: async () => { profileCalls.acknowledgments++; return { ok: true, reply: 'SYNTHETIC_PRIVATE_PROFILE' }; },
      },
    } as never);
  }
  services.providerRegistry.registerRuntimeProvider({
    provider,
    models: [{
      id: MODEL, provider: PROVIDER, registryKey: `${PROVIDER}:${MODEL}`, displayName: MODEL, description: 'scripted',
      capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
      contextWindow: 200_000, selectable: true, tier: 'standard',
    } as unknown as ModelDefinition],
    replace: true,
  });
  services.providerRegistry.setCurrentModel(`${PROVIDER}:${MODEL}`);

  // Composing the daemon over these services is what replaces the runtime's
  // continuation runner with the facade's. Dispose the daemon-owned resources
  // first, then its separately owned injected services, then temporary files.
  const runtimeContinuation = (services.sessionBroker as unknown as {
    continuationRunner: SharedSessionContinuationRunner;
  }).continuationRunner;
  const daemon = disposables.add(new DaemonServer({ runtimeServices: services }));
  const conversation = fakePort((_name, question) => choiceAnswer(question, 'conversation', 0.99));
  const prior = installJudgmentPort({ model: conversation.port.model, ask(request) {
    if (request.context?.battery !== 'engine.daemon.inbound-intent') throw new Error('Unexpected fixture reading');
    return conversation.port.ask(request);
  } });
  disposables.defer(() => { installJudgmentPort(prior); });
  return { services, daemon, requests, releaseFirst: () => release(), runtimeContinuation, profileCalls };
}

/**
 * Start the first turn of a Telegram conversation the way an adapter does:
 * the broker records the message, and the spawn goes through the daemon's own
 * conversation gate, which is what every channel adapter's `trySpawnAgent` is.
 */
async function startTelegramConversation(harness: Harness, identity = { channelId: 'chat-1', userId: '42' }): Promise<{ sessionId: string; agentId: string }> {
  const broker = harness.services.sessionBroker;
  const submission = await broker.submitMessage({
    surfaceKind: 'telegram',
    surfaceId: 'telegram:bot-1',
    externalId: identity.channelId,
    threadId: identity.channelId,
    userId: identity.userId,
    title: 'Telegram',
    body: FIRST_MESSAGE,
  });
  expect(submission.mode).toBe('spawn');
  const helper = (harness.daemon as unknown as { surfaceActionHelper: DaemonSurfaceActionHelper }).surfaceActionHelper;
  const spawned = await gateSurfaceSpawn(
    helper.conversationGateDeps(),
    { surface: 'telegram', text: FIRST_MESSAGE, userId: identity.userId, channelId: identity.channelId, threadId: identity.channelId },
    { mode: 'spawn', task: submission.task! },
    'test.telegramFirstTurn',
    submission.session.id,
  );
  if (spawned instanceof Response) {
    throw new Error(`first turn was not spawned: ${await spawned.text()}`);
  }
  await broker.bindAgent(submission.session.id, spawned.id);
  return { sessionId: submission.session.id, agentId: spawned.id };
}

function expectConversationalTools(request: ChatRequest): void {
  expect(toolNames(request).sort()).toEqual(['fetch', 'find', 'profile', 'read']);
}

describe('a served daemon offers a channel conversation the conversational tools', () => {
  test('the first turn of a Telegram conversation', async () => {
    const harness = buildHarness();
    try {
      await startTelegramConversation(harness);
      const first = await waitFor('the first turn to reach the provider', () =>
        harness.requests.find((r) => requestText(r).includes(FIRST_MESSAGE)));
      expectConversationalTools(first);
    } finally {
      harness.releaseFirst();
    }
  }, WAIT_MS + 5_000);

  for (const defaults of [false, true]) {
    test(`${defaults ? 'a permitted collaborator on shipped defaults' : 'an unlisted chat'} cannot read or acknowledge through an unoffered profile call`, async () => {
      const harness = buildHarness({ attemptProfile: true, ...(defaults ? { useDefaultOwnerChannels: true } : { ownerChannels: 'telegram:different-owner-chat' }) });
      forgetGateReadings();
      const readings = gateReadingsPort([['"action":"list"', READ_ONLY]]);
      // Explicit fixture answers let the real permission path settle. Unknown
      // question names fail rather than masking a new production decision.
      const knownQuestionNames = new Set(['route', 'mutates', 'outward', 'secrets', 'kind', 'family', 'irreversible', 'beyondProject', 'weakensSecurity', 'cardDetails']);
      const previous = installJudgmentPort({
        model: readings.port.model,
        async ask(request) {
          if (request.context?.battery === 'engine.daemon.inbound-intent') return fakePort((_name, question) => choiceAnswer(question, 'conversation', 0.99)).port.ask(request);
          for (const name of Object.keys(request.questions)) {
            if (!knownQuestionNames.has(name)) throw new Error(`Unexpected fixture judgment question: ${name}`);
          }
          return readings.port.ask(request);
        },
      });
      try {
        const identity = { channelId: 'shared-chat', userId: 'allowed-collaborator' };
        await harness.services.channelPolicy.upsertPolicy('telegram', { allowlistUserIds: ['owner-user', identity.userId] });
        const ingress = await harness.services.channelPolicy.evaluateIngress({
          surface: 'telegram', ...identity, conversationKind: 'group', text: FIRST_MESSAGE,
        });
        expect(ingress.allowed).toBe(true);
        if (defaults) {
          expect(harness.services.configManager.get('profile.ownerChannels')).toBe('');
          expect(harness.services.configManager.get('occasions.nudgeChannel')).toBe('telegram');
          expect(harness.services.configManager.describeConfigKeySource('occasions.nudgeChannel').tier).toBe('default');
        }
        await startTelegramConversation(harness, identity);
        const first = await waitFor('the unlisted chat to reach the provider', () => harness.requests[0]);
        expect(toolNames(first).sort()).toEqual(['fetch', 'find', 'read']);
        harness.releaseFirst();
        const resultRequest = await waitFor('denied profile tool results to return to the provider', () =>
          harness.requests.find((request) => request.messages.some((message) => message.role === 'tool')));
        const toolResults = resultRequest.messages.filter((message) => message.role === 'tool');
        expect(toolResults).toHaveLength(2);
        for (const result of toolResults) expect(String(result.content)).toContain("Unknown tool: 'profile'");
        expect(requestText(resultRequest)).not.toContain('SYNTHETIC_PRIVATE_PROFILE');
        expect(harness.profileCalls).toEqual({ reads: 0, acknowledgments: 0 });
        expect(harness.requests.every((request) => !toolNames(request).includes('profile'))).toBe(true);
      } finally {
        installJudgmentPort(previous);
        forgetGateReadings();
        harness.releaseFirst();
      }
    }, WAIT_MS + 5_000);
  }

  test('a follow-up queued behind a running turn, once it is continued', async () => {
    const harness = buildHarness();
    try {
      const { sessionId, agentId } = await startTelegramConversation(harness);
      await waitFor('the first turn to be running in the provider', () =>
        harness.requests.some((r) => requestText(r).includes(FIRST_MESSAGE)) ? true : undefined);

      const followUp = await harness.services.sessionBroker.followUpMessage({
        sessionId,
        surfaceKind: 'telegram',
        surfaceId: 'telegram:bot-1',
        externalId: 'chat-1',
        threadId: 'chat-1',
        userId: '42',
        title: 'Telegram',
        body: FOLLOW_UP,
      });
      expect(followUp.mode).toBe('queued-follow-up');
      expect(followUp.activeAgentId).toBe(agentId);

      // The running turn finishes; the broker continues the queued follow-up
      // through the runner the daemon installed.
      harness.releaseFirst();
      const continued = await waitFor('the continued turn to reach the provider', () =>
        harness.requests.find((r) => requestText(r).includes(FOLLOW_UP)));

      expectConversationalTools(continued);
    } finally {
      harness.releaseFirst();
    }
  }, WAIT_MS + 5_000);
});


describe('the SDK runtime continuation before the daemon replaces it', () => {
  for (const [name, surfaceKind, metadata] of [
    ['conversation', 'telegram', {}],
    ['confirmed work', 'telegram', { 'goodvibes.workAuthorized': true }],
    ['local work', 'tui', {}],
  ] as const) {
    test(`${name} receives its own capability boundary`, async () => {
      const harness = buildHarness();
      const calls: SpawnInput[] = [];
      const spawn = spyOn(harness.services.agentManager, 'spawn').mockImplementation((input) => {
        calls.push(input);
        return { id: 'captured-continuation', task: input.task, status: 'running' } as AgentRecord;
      });
      try {
        const input: SharedSessionInputRecord = {
          id: 'input-1', sessionId: 'session-1', intent: 'follow-up', state: 'queued', correlationId: 'correlation-1',
          body: 'Hello', createdAt: 1, updatedAt: 1, surfaceKind, metadata, externalId: 'chat-1',
          // The declared routing list is allowed for confirmed work; conversation
          // narrows it even when it includes project-writing tools.
          routing: { tools: ['read', 'write', 'exec', 'profile'] },
        };
        await harness.runtimeContinuation({ sessionId: input.sessionId, input, task: 'Unchanged task transcript' });
        expect(calls).toHaveLength(1);
        expect(calls[0]?.task).toBe('Unchanged task transcript');
        if (name === 'conversation') {
          expect(calls[0]?.outsideContract).toBe(true);
          expect(calls[0]?.tools).toEqual(['read', 'profile']);
          expect(calls[0]?.restrictTools).toBe(true);
          expect(calls[0]?.context).toContain('answering the owner in conversation');
        } else {
          expect(calls[0]?.outsideContract).toBeUndefined();
          expect(calls[0]?.tools).toEqual(['read', 'write', 'exec', 'profile']);
          expect(calls[0]?.restrictTools).toBeUndefined();
          expect(calls[0]?.context).toBeUndefined();
        }
      } finally {
        spawn.mockRestore();
        harness.releaseFirst();
      }
    });
  }
});

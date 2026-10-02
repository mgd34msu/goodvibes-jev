/**
 * hosted-session-turn.test.ts
 *
 * A real turn, in a real hosted session, against a stub provider.
 *
 * Everything else about hosted sessions can be true while the one claim that
 * matters is false: that this is the SAME loop a terminal runs, not a lighter
 * one wearing its name. So this drives an actual turn, model call, tool call,
 * tool result, second model call, through `createHostedSessionRuntime` over a
 * real client floor, and checks the three things that make it that loop:
 *
 *  - the tool the model asked for actually ran, out of the registry
 *    `registerAllTools` built, rooted at THIS session's workspace;
 *  - the turn's events reached the runtime bus stamped with this session's id,
 *    which is what lets an attached client watch a hosted turn over the SSE
 *    stream it already uses for a local one;
 *  - the transcript is the session's own, and survives a round trip through the
 *    persistence shape.
 */

import { JudgmentError } from '@goodvibes-jev/judgment';
import { installJudgmentPort, judgmentPort } from '@goodvibes-jev/engine/errors';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigManager } from '../sdk/src/platform/config/manager.ts';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.ts';
import { createRuntimeStore } from '../sdk/src/platform/runtime/store/index.ts';
import { createClientRuntimeServices, type ClientRuntimeServices } from '../sdk/src/platform/runtime/client-services.ts';
import { createHostedSessionRuntime } from '../sdk/src/platform/hosted-sessions/session-runtime.ts';
import type { ChatRequest, ChatResponse, LLMProvider } from '../sdk/src/platform/providers/interface.ts';
import type { ModelDefinition } from '../sdk/src/platform/providers/registry.ts';
import type { PermissionPromptDecision } from '../sdk/src/platform/permissions/prompt.ts';
import { installHostedSessionReadings } from './_helpers/hosted-session-readings.ts';

const PROVIDER = 'stub';
const MODEL = 'stub-1';

let root: string;
let workspace: string;
let services: ClientRuntimeServices;
let runtimeBus: RuntimeEventBus;
/** What the stub was asked, turn by turn. */
let requests: ChatRequest[];
/** The answers the stub gives, in order. */
let answers: ChatResponse[];
let heldChat: ((request: ChatRequest) => Promise<ChatResponse>) | undefined;
let readings: ReturnType<typeof installHostedSessionReadings>;

function textAnswer(content: string): ChatResponse {
  return {
    content,
    toolCalls: [],
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: 'completed',
  };
}

function stubProvider(): LLMProvider {
  return {
    name: PROVIDER,
    models: [MODEL],
    credentialAuthority: 'anonymous',
    modelSource: { kind: 'dated-static', asOf: '2026-01-01' },
    isConfigured: () => true,
    chat: async (request: ChatRequest): Promise<ChatResponse> => {
      requests.push(request);
      if (heldChat) return heldChat(request);
      return answers.shift() ?? textAnswer('nothing left to say');
    },
  } as unknown as LLMProvider;
}

function stubModel(): ModelDefinition {
  return {
    id: MODEL,
    provider: PROVIDER,
    registryKey: `${PROVIDER}:${MODEL}`,
    displayName: MODEL,
    description: 'a stub',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 8192,
    selectable: true,
    tier: 'standard',
  } as unknown as ModelDefinition;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hosted-turn-'));
  workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'note.txt'), 'the file this session can read\n');
  requests = [];
  answers = [];
  heldChat = undefined;
  runtimeBus = new RuntimeEventBus();

  const configManager = new ConfigManager({
    surfaceRoot: 'goodvibes',
    configDir: join(root, 'cfg'),
    workingDir: workspace,
    homeDir: root,
  });
  // Everything this turn does is allowed: the permission gate is not what is
  // under test here (the trust-gated ask has its own suites), and a decline
  // would make the tool result an honest refusal rather than a read.
  const approveEverything = async (): Promise<PermissionPromptDecision> => ({ approved: true });

  services = createClientRuntimeServices({
    configManager,
    runtimeBus,
    runtimeStore: createRuntimeStore(),
    surfaceRoot: 'goodvibes',
    workingDir: workspace,
    homeDirectory: root,
    requestApproval: approveEverything,
    modelDiscovery: 'skip',
  });
  services.providerRegistry.registerRuntimeProvider({
    provider: stubProvider(),
    models: [stubModel()],
    replace: true,
  });
  services.providerRegistry.setCurrentModel(`${PROVIDER}:${MODEL}`);
  readings = installHostedSessionReadings();
});

afterEach(() => {
  readings.restore();
  services.dispose();
  rmSync(root, { recursive: true, force: true });
});

test('a hosted session runs a real turn and the transcript is its own', async () => {
  answers.push(textAnswer('I read nothing; here is a plain answer.'));
  const session = createHostedSessionRuntime({
    sessionId: 'hosted-turn-1',
    workspaceRoot: workspace,
    floor: { services, contractRunner: services.contractRunner, dispose: (): void => {} },
    systemPrompt: 'you are hosted by the daemon',
  });

  await session.submit('say something');

  expect(readings.requests.filter((request) => request.context?.battery === 'contract.request-route')
    .map((request) => request.state)).toEqual([{ request: 'say something' }]);
  expect(requests).toHaveLength(1);
  // The system prompt this session was composed with reached the model.
  expect(requests[0]!.systemPrompt).toContain('you are hosted by the daemon');
  // And the tool registry the loop was built with is a real one.
  expect(requests[0]!.tools?.length ?? 0).toBeGreaterThan(0);

  const transcript = session.conversation.getMessageSnapshot();
  expect(transcript.some((m) => m.role === 'user' && m.content === 'say something')).toBe(true);
  expect(transcript.some((m) => m.role === 'assistant')).toBe(true);
  session.dispose();
});

test('a tool the model calls actually runs, rooted at this session\'s workspace', async () => {
  answers.push({
    content: '',
    toolCalls: [{ id: 'call-1', name: 'read', arguments: { files: [{ path: 'note.txt' }] } }],
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: 'tool_call',
  } as unknown as ChatResponse);
  answers.push(textAnswer('The note says what it says.'));

  const session = createHostedSessionRuntime({
    sessionId: 'hosted-turn-2',
    workspaceRoot: workspace,
    floor: { services, contractRunner: services.contractRunner, dispose: (): void => {} },
    systemPrompt: 'hosted',
  });

  await session.submit('read the note');

  // Two model calls: the one that asked for the tool, and the one that saw its
  // result. That round trip IS the tool-use loop.
  expect(requests).toHaveLength(2);
  const secondCallMessages = JSON.stringify(requests[1]!.messages);
  // The file's real content came back through the registry's read tool, which
  // means the registry was rooted at this workspace and the tool ran here.
  expect(secondCallMessages).toContain('the file this session can read');
  session.dispose();
});

test('turn events reach the runtime bus stamped with this session\'s id', async () => {
  const seen: { type: string; sessionId: string | undefined }[] = [];
  for (const type of ['TURN_SUBMITTED', 'TURN_COMPLETED'] as const) {
    runtimeBus.on(type, (envelope) => {
      seen.push({ type, sessionId: envelope.sessionId });
    });
  }
  answers.push(textAnswer('done'));

  const session = createHostedSessionRuntime({
    sessionId: 'hosted-turn-3',
    workspaceRoot: workspace,
    floor: { services, contractRunner: services.contractRunner, dispose: (): void => {} },
    systemPrompt: 'hosted',
  });
  await session.submit('go');

  // This is the whole streaming story: no new channel, because the events a
  // client already watches carry the hosted session's id.
  expect(seen.map((entry) => entry.type)).toEqual(['TURN_SUBMITTED', 'TURN_COMPLETED']);
  expect(new Set(seen.map((entry) => entry.sessionId))).toEqual(new Set(['hosted-turn-3']));
  session.dispose();
});

test('the transcript survives the persistence round trip a restart replays', async () => {
  answers.push(textAnswer('remember this'));
  const first = createHostedSessionRuntime({
    sessionId: 'hosted-turn-4',
    workspaceRoot: workspace,
    floor: { services, contractRunner: services.contractRunner, dispose: (): void => {} },
    systemPrompt: 'hosted',
  });
  await first.submit('the thing to remember');
  const payload = first.conversation.toJSON();
  first.dispose();

  const second = createHostedSessionRuntime({
    sessionId: 'hosted-turn-4',
    workspaceRoot: workspace,
    floor: { services, contractRunner: services.contractRunner, dispose: (): void => {} },
    systemPrompt: 'hosted',
  });
  second.conversation.fromJSON(payload as Parameters<typeof second.conversation.fromJSON>[0]);

  const restored = second.conversation.getMessageSnapshot();
  expect(restored.some((m) => m.role === 'user' && m.content === 'the thing to remember')).toBe(true);
  expect(restored.some((m) => m.role === 'assistant' && String(m.content).includes('remember this'))).toBe(true);
  second.dispose();
});

test('two hosted sessions in one workspace keep separate transcripts', async () => {
  answers.push(textAnswer('answer for a'), textAnswer('answer for b'));
  const floor = { services, contractRunner: services.contractRunner, dispose: (): void => {} };
  const a = createHostedSessionRuntime({ sessionId: 'hosted-a', workspaceRoot: workspace, floor, systemPrompt: 'hosted' });
  const b = createHostedSessionRuntime({ sessionId: 'hosted-b', workspaceRoot: workspace, floor, systemPrompt: 'hosted' });

  await a.submit('question a');
  await b.submit('question b');

  const aText = JSON.stringify(a.conversation.getMessageSnapshot());
  const bText = JSON.stringify(b.conversation.getMessageSnapshot());
  expect(aText).toContain('question a');
  expect(aText).not.toContain('question b');
  expect(bText).toContain('question b');
  expect(bText).not.toContain('question a');
  // The file cache and project index they share are per-workspace by design;
  // the conversation is not, and that is the split the engine rests on.
  expect(readFileSync(join(workspace, 'note.txt'), 'utf-8')).toContain('the file this session can read');
  a.dispose();
  b.dispose();
});


test('judgment preflight is inside the turn: no provider spend before it settles, and failure cleans up', async () => {
  const session = createHostedSessionRuntime({ sessionId: 'preflight-failure', workspaceRoot: workspace, floor: { services, contractRunner: services.contractRunner, dispose: (): void => {} }, systemPrompt: 'hosted' });
  const base = judgmentPort('test');
  let readingStarted!: () => void;
  const started = new Promise<void>((resolve) => { readingStarted = resolve; });
  let rejectReading!: (error: Error) => void;
  const delayed = new Promise<never>((_, reject) => { rejectReading = reject; });
  const seen: string[] = [];
  const errors: unknown[] = [];
  runtimeBus.on('TURN_ERROR', (envelope) => { errors.push(envelope.payload); });
  const previous = installJudgmentPort({ ...base, ask: async (request) => {
    seen.push(request.context?.battery ?? 'unnamed');
    if (request.context?.battery === 'engine.core.turn-shape') { readingStarted(); return delayed; }
    return base.ask(request);
  } });
  try {
    const turn = session.submit('keep this request after a failed reading');
    await started;
    expect(requests).toHaveLength(0);
    expect(session.orchestrator.isThinking).toBe(true);
    rejectReading(new JudgmentError('unavailable', 'synthetic judgment outage'));
    await turn;
    expect(requests).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(session.orchestrator.isThinking).toBe(false);
    expect(session.conversation.getMessageSnapshot().some((message) => message.role === 'user' && message.content === 'keep this request after a failed reading')).toBe(true);
    expect(seen).not.toContain('engine.failure-reading');
    installJudgmentPort(previous);
    answers.push(textAnswer('the next turn still works'));
    await session.submit('try again');
    expect(requests).toHaveLength(1);
  } finally { installJudgmentPort(previous); session.dispose(); }
});

test('cancelling a slow judgment retains the user turn and queues a newer turn until cleanup', async () => {
  const session = createHostedSessionRuntime({ sessionId: 'preflight-cancel', workspaceRoot: workspace, floor: { services, contractRunner: services.contractRunner, dispose: (): void => {} }, systemPrompt: 'hosted' });
  const base = judgmentPort('test');
  let readingStarted!: () => void;
  const started = new Promise<void>((resolve) => { readingStarted = resolve; });
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  let once = true;
  const previous = installJudgmentPort({ ...base, ask: async (request) => {
    if (request.context?.battery === 'engine.core.turn-shape' && once) { once = false; readingStarted(); await delayed; }
    return base.ask(request);
  } });
  try {
    const first = session.submit('first request');
    await started;
    expect(session.cancel()).toBe(true);
    await session.submit('newer request');
    expect(session.orchestrator.listQueuedMessages()).toHaveLength(1);
    expect(requests).toHaveLength(0);
    answers.push(textAnswer('answered the newer request'));
    release();
    await first;
    expect(requests).toHaveLength(1);
    const transcript = session.conversation.getMessageSnapshot();
    expect(transcript.filter((message) => message.role === 'user').map((message) => message.content)).toEqual(['first request', 'newer request']);
    expect(transcript.some((message) => message.content === '[Response cancelled]')).toBe(true);
    expect(session.orchestrator.listQueuedMessages()).toHaveLength(0);
    expect(session.orchestrator.isThinking).toBe(false);
  } finally { release(); installJudgmentPort(previous); session.dispose(); }
});

function cancellationSession() {
  return createHostedSessionRuntime({ sessionId: 'cancel-target', workspaceRoot: workspace, floor: { services, contractRunner: services.contractRunner, dispose: (): void => {} }, systemPrompt: 'hosted' });
}

test('expected cancellation during submitted notification is admitted before dispatch; identical retry has a fresh identity', async () => {
  const session = cancellationSession();
  const ids: string[] = [];
  const cancelled: string[] = [];
  runtimeBus.on('TURN_CANCEL', (event) => { if (event.payload.type !== 'TURN_CANCEL') return; cancelled.push(event.payload.turnId); });
  runtimeBus.on('TURN_SUBMITTED', (event) => { if (event.payload.type !== 'TURN_SUBMITTED') return;
    ids.push(event.payload.turnId);
    if (ids.length === 1) {
      expect(session.liveTurnControls.cancelTurn!(ids[0]!).status).toBe('cancellation-requested');
      expect(cancelled).toHaveLength(0);
    } else {
      expect(session.liveTurnControls.cancelTurn!(ids[0]!).status).toBe('already-ended');
    }
  });
  try {
    expect(session.liveTurnControls.cancelTurn!('unknown').status).toBe('turn-not-found');
    await session.submit('identical prompt');
    expect(requests).toHaveLength(0);
    expect(cancelled).toEqual([ids[0]!]);
    expect(session.liveTurnControls.cancelTurn!(ids[0]!).status).toBe('already-ended');
    await session.submit('identical prompt');
    expect(ids[1]).not.toBe(ids[0]);
    expect(requests).toHaveLength(1);
  } finally { session.dispose(); }
});

test('held provider cancellation is idempotent, settles honestly, and cannot cancel queued future work', async () => {
  const session = cancellationSession();
  let start!: () => void;
  const started = new Promise<void>((resolve) => { start = resolve; });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let signal: AbortSignal | undefined;
  heldChat = async (request) => { signal = request.signal; start(); await held; return textAnswer('late provider answer'); };
  const ids: string[] = [];
  const cancelled: string[] = [];
  runtimeBus.on('TURN_SUBMITTED', (event) => { if (event.payload.type !== 'TURN_SUBMITTED') return; ids.push(event.payload.turnId); });
  runtimeBus.on('TURN_CANCEL', (event) => { if (event.payload.type !== 'TURN_CANCEL') return; cancelled.push(event.payload.turnId); });
  try {
    const first = session.submit('first');
    await started;
    expect(session.liveTurnControls.cancelTurn!('wrong').status).toBe('stale-turn');
    expect(signal?.aborted).toBe(false);
    expect(session.liveTurnControls.cancelTurn!(ids[0]!).status).toBe('cancellation-requested');
    expect(signal?.aborted).toBe(true);
    expect(session.liveTurnControls.cancelTurn!(ids[0]!).status).toBe('cancellation-requested');
    expect(cancelled).toHaveLength(0);
    await session.submit('future');
    heldChat = undefined;
    release();
    await first;
    expect(cancelled).toEqual([ids[0]!]);
    expect(requests).toHaveLength(2);
    expect(session.liveTurnControls.cancelTurn!(ids[0]!).status).toBe('already-ended');
    expect(session.liveTurnControls.cancelTurn!(ids[1]!).status).toBe('already-ended');
    expect(session.conversation.getMessageSnapshot().some((m) => m.content === 'nothing left to say')).toBe(true);
  } finally { release(); session.dispose(); }
});

test('shutdown aborts the same held turn and never admits future work', async () => {
  const session = cancellationSession();
  let start!: () => void;
  const started = new Promise<void>((resolve) => { start = resolve; });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let id = '';
  runtimeBus.on('TURN_SUBMITTED', (event) => { if (event.payload.type !== 'TURN_SUBMITTED') return; id = event.payload.turnId; });
  heldChat = async () => { start(); await held; return textAnswer('late'); };
  const turn = session.submit('first');
  await started;
  session.dispose();
  expect(session.liveTurnControls.cancelTurn!(id).status).toBe('cancellation-requested');
  release();
  await turn;
  expect(session.liveTurnControls.cancelTurn!(id).status).toBe('already-ended');
  await session.submit('never');
  expect(requests).toHaveLength(1);
});

test('whole-turn request aborts a held actual tool and the following turn uses fresh signals', async () => {
  const session = cancellationSession();
  let start!: () => void;
  const started = new Promise<void>((resolve) => { start = resolve; });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let signal: AbortSignal | undefined;
  const ids: string[] = [];
  runtimeBus.on('TURN_SUBMITTED', (event) => { if (event.payload.type !== 'TURN_SUBMITTED') return; ids.push(event.payload.turnId); });
  session.toolRegistry.unregister('read');
  session.toolRegistry.register({ definition: { name: 'read', description: 'Read a test note.', parameters: { type: 'object', properties: {} } }, execute: async (_args, options) => { signal = options?.signal; start(); await held; return { success: true, output: 'late tool result' }; } });
  answers.push({ content: '', toolCalls: [{ id: 'held-read', name: 'read', arguments: {} }], usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'tool_call' } as unknown as ChatResponse);
  try {
    const turn = session.submit('read');
    await started;
    expect(signal?.aborted).toBe(false);
    expect(session.liveTurnControls.cancelTurn!(ids[0]!).status).toBe('cancellation-requested');
    expect(signal?.aborted).toBe(true);
    release();
    await turn;
    expect(session.liveTurnControls.cancelTurn!(ids[0]!).status).toBe('already-ended');
    await session.submit('next');
    expect(requests.at(-1)?.signal?.aborted).toBe(false);
    expect(ids).toHaveLength(2);
  } finally { release(); session.dispose(); }
});

test('a cancellation reentered from TURN_COMPLETED is already-ended and cannot rewrite the completed transcript', async () => {
  const session = cancellationSession();
  const terminal: string[] = [];
  runtimeBus.on('TURN_COMPLETED', (event) => { if (event.payload.type !== 'TURN_COMPLETED') return;
    terminal.push('completed');
    expect(session.liveTurnControls.cancelTurn!(event.payload.turnId).status).toBe('already-ended');
  });
  runtimeBus.on('TURN_CANCEL', () => { terminal.push('cancel'); });
  answers.push(textAnswer('completed answer'));
  try {
    await session.submit('finish');
    expect(terminal).toEqual(['completed']);
    expect(session.conversation.getMessageSnapshot().some((m) => m.content === 'completed answer')).toBe(true);
    expect(session.conversation.getMessageSnapshot().some((m) => m.content === '[Response cancelled]')).toBe(false);
  } finally { session.dispose(); }
});

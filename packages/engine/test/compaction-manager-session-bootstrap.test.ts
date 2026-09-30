/**
 * compaction-manager-session-bootstrap.test.ts
 *
 * A real hosted session bootstrap creates its CompactionManager, and a
 * compaction in that session goes through it: the lifecycle events reach the
 * session's bus in order, stamped with the session's id, the manager records a
 * boundary commit of the compacted conversation, and disposing the session
 * disposes the manager.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigManager } from '../sdk/src/platform/config/manager.ts';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.ts';
import { createRuntimeStore } from '../sdk/src/platform/runtime/store/index.ts';
import { createClientRuntimeServices, type ClientRuntimeServices } from '../sdk/src/platform/runtime/client-services.ts';
import { createHostedSessionRuntime } from '../sdk/src/platform/hosted-sessions/session-runtime.ts';
import { CompactionManager } from '../sdk/src/platform/runtime/compaction/index.ts';
import type { ChatResponse, LLMProvider } from '../sdk/src/platform/providers/interface.ts';
import type { ModelDefinition } from '../sdk/src/platform/providers/registry.ts';
import type { PermissionPromptDecision } from '../sdk/src/platform/permissions/prompt.ts';
import { installHostedSessionReadings } from './_helpers/hosted-session-readings.ts';

const PROVIDER = 'stub';
const MODEL = 'stub-1';
/** Under SMALL_WINDOW_THRESHOLD, so the session's auto compaction is the small-window one. */
const WINDOW = 8192;

let root: string;
let services: ClientRuntimeServices;
let runtimeBus: RuntimeEventBus;
let readings: ReturnType<typeof installHostedSessionReadings>;

function stubProvider(): LLMProvider {
  return {
    name: PROVIDER,
    models: [MODEL],
    credentialAuthority: 'anonymous',
    modelSource: { kind: 'dated-static', asOf: '2026-01-01' },
    isConfigured: () => true,
    // Reports 90% of the window in use, past the default 80% auto-compact threshold.
    chat: async (): Promise<ChatResponse> => ({
      content: 'done',
      toolCalls: [],
      usage: { inputTokens: Math.floor(WINDOW * 0.9), outputTokens: 5 },
      stopReason: 'completed',
    }),
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
    contextWindow: WINDOW,
    selectable: true,
    tier: 'standard',
  } as unknown as ModelDefinition;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'compaction-bootstrap-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  runtimeBus = new RuntimeEventBus();
  const configManager = new ConfigManager({
    surfaceRoot: 'goodvibes',
    configDir: join(root, 'cfg'),
    workingDir: workspace,
    homeDir: root,
  });
  services = createClientRuntimeServices({
    configManager,
    runtimeBus,
    runtimeStore: createRuntimeStore(),
    surfaceRoot: 'goodvibes',
    workingDir: workspace,
    homeDirectory: root,
    requestApproval: async (): Promise<PermissionPromptDecision> => ({ approved: true }),
    modelDiscovery: 'skip',
  });
  services.providerRegistry.registerRuntimeProvider({ provider: stubProvider(), models: [stubModel()], replace: true });
  services.providerRegistry.setCurrentModel(`${PROVIDER}:${MODEL}`);
  readings = installHostedSessionReadings();
});

afterEach(() => {
  readings.restore();
  services.dispose();
  rmSync(root, { recursive: true, force: true });
});

test('a session bootstrap creates the CompactionManager and a compaction in the session runs through it', async () => {
  const session = createHostedSessionRuntime({
    sessionId: 'hosted-compaction-1',
    workspaceRoot: join(root, 'workspace'),
    floor: { services, contractRunner: services.contractRunner, dispose: (): void => {} },
    systemPrompt: 'hosted',
  });

  const manager = session.orchestrator.getCompactionManager();
  expect(manager).toBeInstanceOf(CompactionManager);
  expect(manager!.state).toBe('idle');
  expect(manager!.lastCommit).toBeNull();

  // Enough history for keep-last-10 to drop something.
  for (let i = 0; i < 8; i++) {
    session.conversation.addUserMessage(`question ${i}`);
    session.conversation.addAssistantMessage(`answer ${i}`);
  }

  const seen: Array<{ type: string; sessionId: string | undefined }> = [];
  const off = runtimeBus.onDomain('compaction', (env) => {
    seen.push({ type: env.payload.type, sessionId: env.sessionId });
  });

  await session.submit('one more');
  off();

  // Small-window compaction is deterministic; only the turn's intake is read.
  expect(readings.requests.map((request) => request.context?.battery)).toEqual(['contract.request-route']);
  expect(seen.map((e) => e.type)).toEqual([
    'COMPACTION_CHECK',
    'COMPACTION_MICROCOMPACT',
    'COMPACTION_BOUNDARY_COMMIT',
    'COMPACTION_DONE',
    'COMPACTION_RECEIPT',
  ]);
  expect(seen.every((e) => e.sessionId === 'hosted-compaction-1')).toBe(true);

  const commit = manager!.lastCommit;
  expect(commit).not.toBeNull();
  expect(commit!.sessionId).toBe('hosted-compaction-1');
  expect(commit!.strategy).toBe('microcompact');
  expect(commit!.parentCheckpointId).toBeNull();
  expect(commit!.tokensBefore).toBe(Math.floor(WINDOW * 0.9));
  // 19 messages went in; keep-last-10 plus its summary pair came out.
  expect(commit!.messages.length).toBe(12);
  // The commit holds the conversation the compaction left, not a separate rewrite of it.
  expect(commit!.messages).toEqual(session.conversation.getMessagesForLLM().slice(0, commit!.messages.length));
  expect(manager!.state).toBe('idle');

  session.dispose();
  expect(manager!.disposed).toBe(true);
  expect(manager!.lastCommit).toBeNull();
});

test('a failed session compaction reports COMPACTION_FAILED through the manager and rethrows', async () => {
  const flags = services.featureFlags;
  const manager = new CompactionManager({ sessionId: 's-fail', bus: runtimeBus, flags, contextWindow: () => 1000 });
  const types: string[] = [];
  const off = runtimeBus.onDomain('compaction', (env) => { types.push(env.payload.type); });

  await expect(manager.runLifecycle({
    trigger: 'auto',
    strategy: 'autocompact',
    messages: [],
    tokenCount: 900,
    execute: async () => { throw new Error('extraction model unavailable'); },
    outcome: () => null,
  })).rejects.toThrow('extraction model unavailable');

  expect(types).toEqual(['COMPACTION_CHECK', 'COMPACTION_FAILED']);
  expect(manager.state).toBe('idle');
  expect(manager.lastCommit).toBeNull();

  manager.dispose();
  await expect(manager.runLifecycle({
    trigger: 'auto', strategy: 'autocompact', messages: [], tokenCount: 1,
    execute: async () => 1, outcome: () => null,
  })).rejects.toThrow('disposed');
  off();
});

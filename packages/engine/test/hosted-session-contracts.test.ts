/**
 * hosted-session-contracts.test.ts
 *
 * A hosted session as the host of the contracts it starts
 * (docs/design/contract-runner.md 10.2), over REAL client floors whose
 * contract runner is a recording fake:
 *
 *  - explicitly started contracts belong to their session, and the record
 *    lists them (and keeps them across a reload from disk);
 *  - contract notices and answers are delivered to the owning session;
 *  - the contract's outcome is said in the session;
 *  - the engine hands the contracts operator surface its floors' runners.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigManager } from '../sdk/src/platform/config/manager.ts';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.ts';
import { createRuntimeStore } from '../sdk/src/platform/runtime/store/index.ts';
import { createClientRuntimeServices } from '../sdk/src/platform/runtime/client-services.ts';
import { SessionLiveTurnControlsHolder } from '../sdk/src/platform/control-plane/routes/session-runtime.ts';
import { HostedSessionManager } from '../sdk/src/platform/hosted-sessions/manager.ts';
import { HostedSessionStore } from '../sdk/src/platform/hosted-sessions/store.ts';
import type { HostedWorkspaceFloor } from '../sdk/src/platform/hosted-sessions/workspace-floor.ts';
import type { HostedSessionUpdatePayload } from '../sdk/src/platform/hosted-sessions/types.ts';
import { escalate, fakeRunner, pass, type FakeRunner } from './contract/operator-support.ts';

let root: string;
let workspace: string;
let stateDir: string;
let published: HostedSessionUpdatePayload[];
let disposals: (() => void)[];
let runner: FakeRunner;

const storeLimits = { maxSessions: 20, maxMessagesPerSession: 100, terminatedRetentionMs: 60_000 };

function buildManager(): HostedSessionManager {
  const runtimeBus = new RuntimeEventBus();
  const configManager = new ConfigManager({ surfaceRoot: 'goodvibes', configDir: join(root, 'cfg'), workingDir: root, homeDir: root });
  const manager = new HostedSessionManager({
    floorFactory: ({ workspaceRoot }): HostedWorkspaceFloor => {
      const services = createClientRuntimeServices({
        configManager,
        runtimeBus,
        runtimeStore: createRuntimeStore(),
        surfaceRoot: 'goodvibes',
        workingDir: workspaceRoot,
        homeDirectory: root,
        requestApproval: async () => ({ approved: false }),
        modelDiscovery: 'skip',
      });
      disposals.push(() => services.dispose());
      // The floor's runner is the recording fake; its session hooks are the real runner's.
      return { services, contractRunner: { ...runner, hooks: () => services.contractRunner.hooks() }, dispose: (): void => services.dispose() };
    },
    store: new HostedSessionStore(stateDir, storeLimits),
    settings: { detachPolicy: () => 'survive', maxSessions: () => 8, attachmentTtlMs: () => 10 * 60_000 },
    runtimeBus,
    systemPrompt: ({ workspaceRoot }) => `hosted in ${workspaceRoot}`,
    liveTurns: new SessionLiveTurnControlsHolder(),
    isWorkspaceUsable: () => true,
  });
  manager.setEventPublisher({ publishEvent: (_event, payload) => { published.push(payload as HostedSessionUpdatePayload); } });
  return manager;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hosted-contracts-'));
  workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  stateDir = join(root, 'hosted-sessions');
  published = [];
  disposals = [];
  runner = fakeRunner();
});

afterEach(() => {
  for (const dispose of disposals.splice(0)) {
    try { dispose(); } catch { /* a floor the manager already disposed */ }
  }
  rmSync(root, { recursive: true, force: true });
});

test('an explicitly started contract is listed in its session across a reload', async () => {
  const manager = buildManager();
  await manager.init();
  const session = await manager.create({ workspaceRoot: workspace });
  const host = await manager.contractRunners().forSession(session.id);
  host!.runner.start({ ask: 'Add a --json flag to the export command.', sessionId: session.id, origin: 'hosted', projectRoot: workspace });

  expect(manager.historyOf(session.id).some((message) => message.content.includes('[Project mode]'))).toBe(false);
  expect(runner.started).toEqual([{ ask: 'Add a --json flag to the export command.', sessionId: session.id, origin: 'hosted', projectRoot: workspace }]);
  const contractId = [...runner.contracts.keys()][0]!;
  expect(manager.get(session.id)?.contractIds).toEqual([contractId]);
  expect(published.some((entry) => entry.event === 'hosted-session-contract-started' && entry.detail === contractId)).toBe(true);

  // The persisted record carries the list: a restart restores it.
  await manager.dispose();
  const report = await new HostedSessionStore(stateDir, storeLimits).load(Date.now());
  expect(report.restored.find((entry) => entry.record.id === session.id)?.record.contractIds).toEqual([contractId]);
});

test('a contract notice and its final answer reach the owning session', async () => {
  const manager = buildManager();
  await manager.init();
  const session = await manager.create({ workspaceRoot: workspace });
  const host = await manager.contractRunners().forSession(session.id);
  host!.runner.start({ ask: 'Rename the config key everywhere.', sessionId: session.id, origin: 'hosted', projectRoot: workspace });
  const contractId = [...runner.contracts.keys()][0]!;

  const question = `Contract ${contractId} could not get unit u1 to pass: the rename misses the docs. Change what is required, or stop?`;
  const escalationId = escalate(runner, contractId, question);
  expect(manager.historyOf(session.id).at(-1)).toMatchObject({ role: 'system', content: `[Contract] ${question}` });
  expect(published.some((entry) => entry.event === 'hosted-session-contract-notice' && entry.detail === `[Contract] ${question}`)).toBe(true);

  await host!.runner.reply(contractId, escalationId, 'Leave the docs out of it; ship the rename.');
  expect(runner.replies).toEqual([{ contractId, escalationId, text: 'Leave the docs out of it; ship the rename.' }]);
  expect(runner.started).toHaveLength(1);

  pass(runner, contractId, 'The key is renamed in the code and the tests.');
  expect(manager.historyOf(session.id).at(-1)).toMatchObject({ role: 'system', content: '[Contract] The key is renamed in the code and the tests.' });
  await manager.dispose();
});

test('a contract of another session is neither listed nor said here', async () => {
  const manager = buildManager();
  await manager.init();
  const session = await manager.create({ workspaceRoot: workspace });
  const other = runner.start({ ask: 'Other work.', sessionId: 'someone-else', origin: 'hosted', projectRoot: workspace });
  escalate(runner, other.contract.id, 'Contract asks someone else.');
  expect(manager.get(session.id)?.contractIds).toEqual([]);
  expect(manager.historyOf(session.id).some((message) => message.content.includes('someone else'))).toBe(false);
  await manager.dispose();
});

test('the engine gives the contracts operator surface its floors and a live session\'s runner', async () => {
  const manager = buildManager();
  await manager.init();
  const session = await manager.create({ workspaceRoot: workspace });
  const hosted = manager.contractRunners();
  expect(hosted.runners()).toHaveLength(1);
  const forSession = await hosted.forSession(session.id);
  expect(forSession?.workspaceRoot).toBe(workspace);
  forSession?.runner.start({ ask: 'From the operator.', sessionId: session.id, origin: 'hosted', projectRoot: workspace });
  expect(runner.started.at(-1)).toMatchObject({ ask: 'From the operator.', sessionId: session.id });
  expect(manager.get(session.id)?.contractIds).toHaveLength(1);
  expect(await hosted.forSession('hosted-nobody')).toBeNull();
  await manager.kill(session.id);
  expect(await hosted.forSession(session.id)).toBeNull();
  await manager.dispose();
});

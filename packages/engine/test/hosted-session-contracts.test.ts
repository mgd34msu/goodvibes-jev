import type { JudgmentPort } from '@goodvibes-jev/judgment';
/**
 * hosted-session-contracts.test.ts
 *
 * A hosted session as the host of the contracts it starts
 * (docs/design/contract-runner.md 10.2), over REAL client floors whose
 * contract runner is a recording fake:
 *
 *  - a turn the intake reads as work starts a contract under the session's
 *    id, and the record lists it (and keeps it across a reload from disk);
 *  - a question the contract puts to its owner is the session's reply, and
 *    the next turn goes to that escalation as the owner's answer;
 *  - the contract's outcome is said in the session;
 *  - the engine hands the contracts operator surface its floors' runners.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coreReadingsPort } from './_helpers/core-readings.ts';
import { choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';

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
import { decisionPort } from './helpers/decision-port.ts';

let root: string;
let workspace: string;
let stateDir: string;
let published: HostedSessionUpdatePayload[];
let disposals: (() => void)[];
let runner: FakeRunner;
let restoreReadings: (() => void) | undefined;
let routeReads: number;
let escalationStates: unknown[];

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

/** Every turn's request route reads `contract` at act. Installed after the floor exists, since a floor installs its own port. */
function routeEveryTurnToWork(): void {
  const fake = decisionPort(['contract.request-route', 'contract.escalation-turn'], (name, question, state) => {
    if (name === 'responds') {
      escalationStates.push(state);
      return noulAnswer(0.97);
    }
    if (name !== 'route') throw new Error(`hosted contracts fixture: unexpected question ${name}`);
    routeReads += 1;
    return choiceAnswer(question, 'contract', 0.97);
  });
  const core = coreReadingsPort({ intent: 'project', needsPlan: true, risk: 1 });
  const port: JudgmentPort = { model: fake.port.model, ask: (request) => request.context?.battery === 'engine.core.turn-shape' ? core.port.ask(request) : fake.port.ask(request) };
  const previous = installJudgmentPort(port);
  restoreReadings = () => { installJudgmentPort(previous); };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hosted-contracts-'));
  workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  stateDir = join(root, 'hosted-sessions');
  published = [];
  disposals = [];
  runner = fakeRunner();
  restoreReadings = undefined;
  routeReads = 0;
  escalationStates = [];
});

afterEach(() => {
  restoreReadings?.();
  for (const dispose of disposals.splice(0)) {
    try { dispose(); } catch { /* a floor the manager already disposed */ }
  }
  rmSync(root, { recursive: true, force: true });
});

test('a turn read as work starts a contract in the session, and the record lists it across a reload', async () => {
  const manager = buildManager();
  await manager.init();
  const session = await manager.create({ workspaceRoot: workspace });
  routeEveryTurnToWork();

  await manager.deliver(session.id, 'Add a --json flag to the export command.');

  expect(manager.historyOf(session.id).some((message) => message.content.includes('[Project mode]'))).toBe(false);
  expect(runner.started).toEqual([{ ask: 'Add a --json flag to the export command.', sessionId: session.id, origin: 'turn', projectRoot: workspace }]);
  const contractId = [...runner.contracts.keys()][0]!;
  expect(manager.get(session.id)?.contractIds).toEqual([contractId]);
  expect(published.some((entry) => entry.event === 'hosted-session-contract-started' && entry.detail === contractId)).toBe(true);
  expect(manager.historyOf(session.id).some((message) => message.role === 'system' && message.content.includes(`Contract ${contractId} took this request`))).toBe(true);

  // The persisted record carries the list: a restart restores it.
  await manager.dispose();
  const report = await new HostedSessionStore(stateDir, storeLimits).load(Date.now());
  expect(report.restored.find((entry) => entry.record.id === session.id)?.record.contractIds).toEqual([contractId]);
});

test('a contract\'s question is the session\'s reply, and the next turn answers it', async () => {
  const manager = buildManager();
  await manager.init();
  const session = await manager.create({ workspaceRoot: workspace });
  routeEveryTurnToWork();
  await manager.deliver(session.id, 'Rename the config key everywhere.');
  const contractId = [...runner.contracts.keys()][0]!;

  const question = `Contract ${contractId} could not get unit u1 to pass: the rename misses the docs. Change what is required, or stop?`;
  const escalationId = escalate(runner, contractId, question);
  expect(manager.historyOf(session.id).at(-1)).toMatchObject({ role: 'system', content: `[Contract] ${question}` });
  expect(published.some((entry) => entry.event === 'hosted-session-contract-notice' && entry.detail === `[Contract] ${question}`)).toBe(true);

  const readsBefore = routeReads;
  await manager.deliver(session.id, 'Leave the docs out of it; ship the rename.');
  expect(escalationStates).toEqual([{ question, turn: 'Leave the docs out of it; ship the rename.' }]);
  expect(runner.replies).toEqual([{ contractId, escalationId, text: 'Leave the docs out of it; ship the rename.' }]);
  // The reply went to the contract before any route was read, and started nothing new.
  expect(routeReads).toBe(readsBefore);
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

/**
 * Daemon-hosted sessions, this is the process that hosts them.
 *
 * The engine is the SDK's and has its own unit suites there. What this daemon
 * owns, and what these tests are the oracle for, is the composition: that the
 * verbs are actually invokable on this daemon's catalog, that a hosted session's
 * asks are gated by the trust decision of the SESSION's workspace rather than
 * the daemon's own directory, that the detach toggle reads this daemon's
 * setting, and that a restart reconciles from disk instead of losing sessions.
 *
 * Turn execution is not re-tested here; the SDK proves that against a stub
 * provider. What is proved here is that a turn CAN be driven, the live-turn
 * controls for a hosted session are bound where `sessions.toolCalls.cancel`
 * looks for them, which is the wiring that goes missing silently.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { GatewayMethodCatalog } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { SessionLiveTurnControlsHolder, createSessionRuntimeControls } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { composeHostedSessions } from '@goodvibes-jev/engine/sdk/platform/daemon';
import type { HostedSessionManager } from '@goodvibes-jev/engine/sdk/platform/hosted-sessions';
import { createShellPathService } from '../../runtime/index.js';
import { createHostedSessionOptions } from '../../runtime/hosted-session-composition.ts';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../../config/surface.ts';
import { spyOn } from 'bun:test';
import { withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { createHostedSessionRuntime } from '@goodvibes-jev/engine/sdk/platform/hosted-sessions';
import { executeToolCalls } from '@goodvibes-jev/engine/sdk/platform/core';
import { createDaemonWorkspaceTrustResolver } from '../../runtime/workspace-trust-composition.js';
import { createProductionDaemonInboxFactory } from '../../runtime/production-inbox-composition.js';
import { useGatewayFixture } from '../helpers/gateway-fixture.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';
const fixture = useGatewayFixture({ hostSessions: false, inboxFactory: createProductionDaemonInboxFactory() });
const getTestRuntimeServices = () => fixture().services;



let root: string;
let workspaceA: string;
let workspaceB: string;
let stateDir: string;
let published: { event: string; payload: unknown }[];
let liveTurns: SessionLiveTurnControlsHolder;
let managers: HostedSessionManager[];

function build(options?: { readonly detachPolicy?: 'kill' | 'survive' }): {
  manager: HostedSessionManager;
  catalog: GatewayMethodCatalog;
} {
  const services = getTestRuntimeServices();
  services.configManager.set('hostedSessions.detachPolicy', options?.detachPolicy ?? 'kill');
  const catalog = new GatewayMethodCatalog();
  const manager = composeHostedSessions({
    options: createHostedSessionOptions(services),
    configManager: services.configManager,
    runtimeBus: services.runtimeBus,
    shellPaths: createShellPathService({ workingDirectory: root, homeDirectory: root }),
    gatewayMethods: catalog,
    liveTurns,
    spine: services.sessionBroker,
    eventPublisher: { publishEvent: (event, payload) => { published.push({ event, payload }); } },
  });
  managers.push(manager);
  return { manager, catalog };
}

/** Invoke a verb the way the control plane does: params in the body. */
async function invoke(catalog: GatewayMethodCatalog, id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await catalog.invoke(id, { methodId: id, body, context: {} } as never);
  return result as Record<string, unknown>;
}

beforeEach(() => {
  root = makeOwnedTempDir('daemon-hosted-parity');
  workspaceA = join(root, 'workspace-a');
  workspaceB = join(root, 'workspace-b');
  stateDir = join(root, '.goodvibes', 'hosted-sessions');
  mkdirSync(workspaceA, { recursive: true });
  mkdirSync(workspaceB, { recursive: true });
  published = [];
  liveTurns = new SessionLiveTurnControlsHolder();
  managers = [];
});

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    await manager.dispose();
  }
  rmSync(root, { recursive: true, force: true });
});

describe('the composition states a trust posture, and it is the session\'s workspace', () => {
  it('autonomous hosted actions use session-workspace trust without a human wait or implicit grant', async () => {
    const services = getTestRuntimeServices();
    const trustFor = createDaemonWorkspaceTrustResolver(services);
    await services.workspaceTrustManager.setLevel('restricted');
    const trustA = trustFor(workspaceA);
    const options = createHostedSessionOptions(services);
    const floor = await options.floorFactory({ workspaceRoot: workspaceA });
    const runtime = createHostedSessionRuntime({ floor, sessionId: 'hosted-trust-parity', workspaceRoot: workspaceA,
      systemPrompt: options.systemPrompt?.({ sessionId: 'hosted-trust-parity', workspaceRoot: workspaceA }) ?? '' });
    const readings = fakePort((name, question) => {
      if (name === 'disposition') return choiceAnswer(question, 'act', 0.99);
      if (name === 'family' || name === 'capability') return choiceAnswer(question, 'generic', 0.99);
      if (name === 'kind') return choiceAnswer(question, 'other', 0.99);
      if (name === 'hazard') return choiceAnswer(question, 'none', 0.99);
      if (name === 'category') return choiceAnswer(question, 'lasting', 0.99);
      if (name === 'names_path' || name === 'owned_targets' || name === 'mutates') return noulAnswer(0.99);
      if (question.type === 'noul') return noulAnswer(0.01);
      throw new Error(`Unexpected synthetic hosted question: ${name}`);
    });
    const recorded = withDecisionLog(readings.port, floor.services.judgment.decisionLog);
    const port = spyOn(floor.services.judgment.port, 'ask').mockImplementation(request => recorded.ask(request));
    const human = spyOn(services.approvalBroker, 'requestApproval').mockImplementation(async () => { throw new Error('No human fallback'); });
    const raise = spyOn(services.approvalBroker, 'raiseApproval').mockImplementation(async () => { throw new Error('No trust question'); });
    const deps = { autonomousSource: () => ({ goal: 'Write only the owned session-workspace fixture', criteria: ['No network or human wait; respect workspace constraints'] }),
      permissionManager: floor.services.permissionManager, toolRegistry: runtime.toolRegistry, hookDispatcher: null, runtimeBus: null,
      sessionId: runtime.sessionId, emitterContext: () => ({ sessionId: runtime.sessionId, traceId: 'hosted-trust', source: 'orchestrator' as const }) };
    const write = (path: string) => executeToolCalls(deps, crypto.randomUUID(), [{ id: crypto.randomUUID(), name: 'write', arguments: { files: [{ path, content: 'owned-hosted-trust' }] } }]);
    const trustFile = join(workspaceA, '.goodvibes', GOODVIBES_DAEMON_SURFACE_ROOT, 'trust.json');
    try {
      expect(floor.services.workspaceTrust).toBe(trustA);
      expect(trustA).not.toBe(services.workspaceTrustManager);
      const result = await write(join(workspaceA, 'allowed.txt'));
      expect(result[0]?.success).toBe(true);
      expect(readFileSync(join(workspaceA, 'allowed.txt'), 'utf8')).toBe('owned-hosted-trust');
      expect(readings.requests.some(request => 'disposition' in request.questions)).toBe(true);
      expect(trustA.isDecided()).toBe(false);
      expect(existsSync(trustFile)).toBe(false);
      // Only an explicit local policy choice persists trust, never a Jev action.
      await trustA.setLevel('restricted');
      expect(JSON.parse(readFileSync(trustFile, 'utf8')).level).toBe('restricted');
      await expect(write(join(workspaceA, 'forbidden.txt'))).rejects.toThrow('restricted');
      expect(existsSync(join(workspaceA, 'forbidden.txt'))).toBe(false);
      expect(trustFor(workspaceB).isDecided()).toBe(false);
      expect(human).not.toHaveBeenCalled(); expect(raise).not.toHaveBeenCalled();
    } finally { raise.mockRestore(); human.mockRestore(); port.mockRestore(); runtime.dispose(); await floor.dispose(); }
  });

  it('composes the floor rooted at the session\'s workspace', async () => {
    const services = getTestRuntimeServices();
    const options = createHostedSessionOptions(services);
    const floor = await options.floorFactory({ workspaceRoot: workspaceB });
    expect(floor.services.workingDirectory).toBe(workspaceB);
    expect(floor.services.surfaceRoot).toBe(GOODVIBES_DAEMON_SURFACE_ROOT);
    // The daemon has a real review-chain controller and hands it over rather
    // than letting the session report none.
    expect(floor.contractRunner).toBeDefined();
    expect(floor.contractRunner).toBe(floor.services.contractRunner);
    await floor.dispose();
  });

  it('states an operator policy naming the workspace the session runs in', () => {
    const options = createHostedSessionOptions(getTestRuntimeServices());
    const prompt = options.systemPrompt?.({ sessionId: 'hosted-x', workspaceRoot: workspaceA }) ?? '';
    expect(prompt).toContain(workspaceA);
    expect(prompt).toContain('hosted by the daemon');
  });
});

describe('the verbs are invokable on this daemon\'s catalog', () => {
  it('creates, lists, attaches and kills over the wire shape', async () => {
    const { catalog } = build({ detachPolicy: 'survive' });

    const created = await invoke(catalog, 'sessions.hosted.create', {
      workspaceRoot: workspaceA,
      clientId: 'terminal-1',
      title: 'a hosted session',
    });
    const session = created['session'] as { id: string; status: string; effectiveDetachPolicy: string };
    expect(session.status).toBe('idle');
    expect(session.effectiveDetachPolicy).toBe('survive');

    const listed = await invoke(catalog, 'sessions.hosted.list', {});
    expect((listed['sessions'] as unknown[]).length).toBe(1);

    const attached = await invoke(catalog, 'sessions.hosted.attach', {
      sessionId: session.id,
      clientId: 'terminal-2',
    });
    expect((attached['session'] as { attachedClients: string[] }).attachedClients.sort())
      .toEqual(['terminal-1', 'terminal-2']);
    expect(Array.isArray(attached['history'])).toBe(true);

    const killed = await invoke(catalog, 'sessions.hosted.kill', { sessionId: session.id });
    expect((killed['session'] as { terminatedReason: string }).terminatedReason).toBe('killed');

    // Kept, with its reason, until retention retires it.
    const withTerminated = await invoke(catalog, 'sessions.hosted.list', { includeTerminated: true });
    expect((withTerminated['sessions'] as unknown[]).length).toBe(1);
    expect((await invoke(catalog, 'sessions.hosted.list', {}))['sessions']).toEqual([]);
  });

  it('refuses a workspace this daemon cannot host a session in', async () => {
    const { catalog } = build();
    await expect(invoke(catalog, 'sessions.hosted.create', { workspaceRoot: join(root, 'not-a-directory') }))
      .rejects.toThrow(/not a directory/);
  });

  it('publishes lifecycle notices on the hosted-session channel', async () => {
    const { catalog } = build({ detachPolicy: 'kill' });
    const created = await invoke(catalog, 'sessions.hosted.create', { workspaceRoot: workspaceA, clientId: 'a' });
    const session = created['session'] as { id: string };
    await invoke(catalog, 'sessions.hosted.detach', { sessionId: session.id, clientId: 'a' });

    expect(published.map((entry) => entry.event)).toEqual([
      'hosted-session-update',
      'hosted-session-update',
      'hosted-session-update',
    ]);
    const events = published.map((entry) => (entry.payload as { event: string }).event);
    expect(events).toEqual(['hosted-session-created', 'hosted-session-detached', 'hosted-session-terminated']);
  });
});

describe('the detach toggle reads this daemon\'s setting', () => {
  it('kill (the shipped default) ends the session on the last detach', async () => {
    const { manager } = build({ detachPolicy: 'kill' });
    const created = await manager.create({ workspaceRoot: workspaceA, clientId: 'a' });
    const after = await manager.detach(created.id, 'a');
    expect(after.status).toBe('terminated');
    expect(after.terminatedReason).toBe('detached');
  });

  it('survive leaves it reattachable', async () => {
    const { manager } = build({ detachPolicy: 'survive' });
    const created = await manager.create({ workspaceRoot: workspaceA, clientId: 'a' });
    expect((await manager.detach(created.id, 'a')).status).toBe('idle');
    expect((await manager.attach(created.id, 'b')).session.attachedClients).toEqual(['b']);
  });

  it('a per-session override beats the setting', async () => {
    const { manager } = build({ detachPolicy: 'kill' });
    const created = await manager.create({ workspaceRoot: workspaceA, clientId: 'a', detachPolicy: 'survive' });
    expect((await manager.detach(created.id, 'a')).status).toBe('idle');
  });
});

describe('a hosted turn is reachable by the session verbs', () => {
  it('binds live-turn controls under the hosted session id', async () => {
    const { manager } = build();
    const created = await manager.create({ workspaceRoot: workspaceA, clientId: 'a' });

    // The wiring that goes missing silently: without the per-session binding,
    // sessions.toolCalls.cancel answers SESSION_NOT_LOCAL for a loop running in
    // this very process.
    expect(liveTurns.hasSession(created.id)).toBe(true);
    const controls = createSessionRuntimeControls({
      config: {
        get: () => 'prompt' as never,
        set: () => {},
      },
      store: {
        getState: () => ({
          session: { id: 'the-daemons-own-runtime' },
          conversation: { estimatedContextTokens: 0 },
          model: { tokenLimits: { contextWindow: 1000 } },
        }),
      },
      liveTurnHolder: liveTurns,
    });
    expect(controls.isLocalSession(created.id)).toBe(true);
    expect(controls.getLiveTurnControls(created.id)).not.toBeNull();
    expect(controls.getLiveTurnControls(created.id)!.listQueuedMessages()).toEqual([]);

    await manager.kill(created.id);
    expect(liveTurns.hasSession(created.id)).toBe(false);
  });
});

describe('a restart reconciles from disk rather than losing sessions', () => {
  it('brings a survive-policy session back and terminates a kill-policy one with a reason', async () => {
    const services = getTestRuntimeServices();
    services.configManager.set('hostedSessions.detachPolicy', 'survive');
    const first = build({ detachPolicy: 'survive' }).manager;
    const survivor = await first.create({ workspaceRoot: workspaceA, clientId: 'a' });
    await first.dispose();
    // Written under the shellPaths user root this composition was given, which
    // is what makes the next start able to find it.
    expect(existsSync(join(stateDir, `${survivor.id}.json`))).toBe(true);

    const second = build({ detachPolicy: 'survive' }).manager;
    const report = await second.init();
    expect(report.rejected).toEqual([]);
    expect(second.get(survivor.id)?.status).toBe('idle');
    expect(second.get(survivor.id)?.restoredFromDisk).toBe(true);

    services.configManager.set('hostedSessions.detachPolicy', 'kill');
    const third = build().manager;
    await third.init();
    // Same record, read under a kill policy this time: it is terminated with
    // the reason that applies, not silently dropped.
    expect(third.get(survivor.id)?.status).toBe('terminated');
    expect(third.get(survivor.id)?.terminatedReason).toBe('daemon-shutdown');
  });
});

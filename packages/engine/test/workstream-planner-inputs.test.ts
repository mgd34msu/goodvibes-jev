// ---------------------------------------------------------------------------
// workstream-planner-inputs.test.ts: the AdaptivePlanner inputs a workstream
// draft is gated with. The risk is the `routing.request-risk` reading of the
// task (a severe reading closes the decomposition gate, so no planning agent
// runs); remoteAvailable comes from the remote supervisor's live sessions;
// backgroundEligible is true because a launched draft always runs as a
// background contract; the latency budget is unbounded.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Question } from '@goodvibes-jev/judgment';
import { fakePort, scoreAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { AdaptivePlanner } from '../sdk/src/platform/core/index.ts';
import type { PhaseRunnerAgentManagerLike } from '../sdk/src/platform/orchestration/index.ts';
import { createWorkstreamServices } from '../sdk/src/platform/orchestration/workstream-services.ts';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.ts';
import { RemoteRunnerRegistry, RemoteSupervisor } from '../sdk/src/platform/runtime/remote/index.ts';
import { createRuntimeStore, type RuntimeStore } from '../sdk/src/platform/runtime/store/index.ts';
import type { AcpConnection } from '../sdk/src/platform/runtime/store/domains/acp.ts';
import { configGetCategoryStub, configGetStub } from './_helpers/config-manager-stub.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const tempDirs: string[] = [];
let previousPort: ReturnType<typeof installJudgmentPort>;

beforeEach(() => {
  previousPort = installJudgmentPort(undefined);
});
afterEach(() => {
  installJudgmentPort(previousPort);
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

/** A port that reads every task's risk at `level` (0 negligible .. 3 severe) and records the requests. */
function riskPort(level: number) {
  return fakePort((name: string, question: Question) => {
    if (name !== 'risk') throw new Error(`unexpected question ${name}`);
    return scoreAnswer(question, level);
  });
}

function withConnection(store: RuntimeStore, connection: AcpConnection): void {
  store.setState((state) => ({
    acp: {
      ...state.acp,
      connections: new Map([[connection.agentId, connection]]),
      activeConnectionIds: [connection.agentId],
    },
  }));
}

function makeServices(options: { decomposition: 'heuristic' | 'agent'; store?: RuntimeStore }) {
  const projectRoot = makeProjectTempDir('gv-workstream-planner-inputs');
  tempDirs.push(projectRoot);
  mkdirSync(join(projectRoot, 'src'), { recursive: true });
  const spawned: string[] = [];
  const agentManager: PhaseRunnerAgentManagerLike = {
    spawn: (input) => {
      spawned.push(input.template ?? 'engineer');
      throw new Error('no agent is expected to be spawned');
    },
    getStatus: () => null,
    cancel: () => false,
    registerCancellationSignal: () => {},
    releaseCancellationSignal: () => {},
  };
  const planner = new AdaptivePlanner();
  const services = createWorkstreamServices({
    agentManager,
    configManager: {
      get: configGetStub({ 'contract.commitScope': 'off', 'planner.decomposition': options.decomposition }),
      getCategory: configGetCategoryStub({ contract: { commitScope: 'off', gates: [] } }),
    },
    adaptivePlanner: planner,
    runtimeBus: new RuntimeEventBus(),
    projectRoot,
    contractRunner: {
      start: () => { throw new Error('not launched in this test'); },
      startFromPlan: () => { throw new Error('not launched in this test'); },
    },
    sessionId: 'session-1',
    remoteSupervisor: new RemoteSupervisor(new RemoteRunnerRegistry({ getStatus: () => null, list: () => [] })),
    runtimeStore: options.store ?? createRuntimeStore(),
  });
  return { ...services, planner, spawned };
}

describe('workstream draft planner inputs', () => {
  test('the task risk is the routing.request-risk reading of the task as a planner brief', async () => {
    const { port, requests } = riskPort(1.5);
    installJudgmentPort(port);
    const { workstreamCommands, orchestrationEngine, planner } = makeServices({ decomposition: 'heuristic' });

    await workstreamCommands.proposeDraft('Move the billing service to webhooks and migrate existing customers.');

    expect(requests).toHaveLength(1);
    expect(Object.keys(requests[0]!.questions)).toEqual(['risk']);
    expect(requests[0]!.state).toEqual({ purpose: 'planner', work: 'Move the billing service to webhooks and migrate existing customers.' });
    const inputs = planner.getLatest()!.inputs;
    expect(inputs.riskScore).toBeCloseTo(0.5, 5);
    expect(inputs.latencyBudgetMs).toBe(Number.POSITIVE_INFINITY);
    expect(inputs.isMultiStep).toBe(true);
    expect(inputs.backgroundEligible).toBe(true);
    expect(inputs.remoteAvailable).toBe(false);
    orchestrationEngine.dispose();
  });

  test('a severe risk reading closes the decomposition gate, so no planning agent runs', async () => {
    installJudgmentPort(riskPort(3).port);
    const { workstreamCommands, orchestrationEngine, spawned } = makeServices({ decomposition: 'agent' });

    const draft = await workstreamCommands.proposeDraft('Delete the duplicate customer records from the production billing database.');

    expect(draft.gate).toMatchObject({ decompose: false, strategy: 'single', reasonCode: 'HIGH_RISK_SINGLE_PREFERRED' });
    expect(draft.provenance.kind).toBe('gate-declined');
    expect(draft.spec.items).toHaveLength(1);
    expect(spawned).toEqual([]);
    orchestrationEngine.dispose();
  });

  test('a low risk reading leaves the gate open', async () => {
    installJudgmentPort(riskPort(0).port);
    const { workstreamCommands, orchestrationEngine } = makeServices({ decomposition: 'heuristic' });
    const draft = await workstreamCommands.proposeDraft('Reword the comments in the README examples.');
    expect(draft.gate.decompose).toBe(true);
    orchestrationEngine.dispose();
  });

  test('remoteAvailable follows the remote supervisor: a connected runner with a fresh heartbeat', async () => {
    installJudgmentPort(riskPort(0).port);
    const store = createRuntimeStore();
    const { workstreamCommands, orchestrationEngine, planner } = makeServices({ decomposition: 'heuristic', store });

    await workstreamCommands.proposeDraft('Add a status endpoint.');
    expect(planner.getLatest()!.inputs.remoteAvailable).toBe(false);

    withConnection(store, { agentId: 'runner-1', label: 'runner', transportState: 'connected', connectedAt: Date.now(), completing: false, messageCount: 0, errorCount: 0 });
    await workstreamCommands.proposeDraft('Add a status endpoint.');
    expect(planner.getLatest()!.inputs.remoteAvailable).toBe(true);

    withConnection(store, { agentId: 'runner-1', label: 'runner', transportState: 'connected', connectedAt: Date.now() - 10 * 60_000, completing: false, messageCount: 0, errorCount: 0 });
    await workstreamCommands.proposeDraft('Add a status endpoint.');
    expect(planner.getLatest()!.inputs.remoteAvailable).toBe(false);

    withConnection(store, { agentId: 'runner-1', label: 'runner', transportState: 'reconnecting', connectedAt: Date.now(), completing: false, messageCount: 0, errorCount: 0 });
    await workstreamCommands.proposeDraft('Add a status endpoint.');
    expect(planner.getLatest()!.inputs.remoteAvailable).toBe(false);
    orchestrationEngine.dispose();
  });

  test('with no judgment port the draft is not proposed', async () => {
    const { workstreamCommands, orchestrationEngine } = makeServices({ decomposition: 'heuristic' });
    await expect(workstreamCommands.proposeDraft('Add a status endpoint.')).rejects.toBeInstanceOf(JudgmentPortMissingError);
    expect(workstreamCommands.listDrafts()).toHaveLength(0);
    orchestrationEngine.dispose();
  });
});

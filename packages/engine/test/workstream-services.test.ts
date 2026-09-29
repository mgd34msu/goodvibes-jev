// ---------------------------------------------------------------------------
// workstream-services.test.ts, the workstream draft facade
//
// Drafts are held, edited, approved, journaled and reloaded by the facade; a
// launch starts a contract (docs/design/contract-runner.md 10.4). The runner
// here is a recording fake: a multi-item draft must reach
// runner.startFromPlan as a drafted plan built from the draft's items, a
// single-item draft must reach runner.start with the item's task as the ask,
// and a launch must never create an engine workstream.
// ---------------------------------------------------------------------------

import { describe, test, expect, afterEach, beforeEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AdaptivePlanner } from '../sdk/src/platform/core/index.ts';
import type { PhaseRunnerAgentManagerLike } from '../sdk/src/platform/orchestration/index.ts';
import type { AgentRecord } from '../sdk/src/platform/tools/index.ts';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.ts';
import type { ConfigManager } from '../sdk/src/platform/config/index.ts';
import { configGetStub, configGetCategoryStub } from './_helpers/config-manager-stub.ts';
import { createWorkstreamServices, type WorkstreamServicesDeps } from '../sdk/src/platform/orchestration/workstream-services.ts';
import type { StartedContract } from '../sdk/src/platform/contract/runner.ts';
import type { StartContractInput, StartFromPlanInput } from '../sdk/src/platform/contract/types.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { fakePort, scoreAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { RemoteRunnerRegistry, RemoteSupervisor } from '../sdk/src/platform/runtime/remote/index.ts';
import { createRuntimeStore } from '../sdk/src/platform/runtime/store/index.ts';

/** A contract config category with commitScope 'off' and no gates, read by the draft's phase and by the engine. */
function makeConfigManager(decomposition: 'heuristic' | 'agent' = 'heuristic'): Pick<ConfigManager, 'get' | 'getCategory'> {
  const contractCategory = {
    maxFixRounds: 3,
    autoCommit: false,
    transportRetryLimit: 0,
    transportRetryDelayMs: 0,
    commitScope: 'off' as const,
    gates: [] as Array<{ name: string; command: string; enabled: boolean }>,
  };
  // Values are looked up through an untyped map (like help.test.ts's fakeConfig)
  // so the cast to the generic return type starts from `unknown`, not a
  // concrete literal, avoids the compiler over-expanding ConfigValue<K>'s
  // large conditional type when comparing it against a literal type.
  const values: Record<string, unknown> = {
    'contract.commitScope': 'off',
    // Default the decomposition to the heuristic path for the plain engine
    // wiring tests so they never spawn a real planning agent; the dedicated
    // agent-path test below overrides this.
    'planner.decomposition': decomposition,
  };
  const categories: Record<string, unknown> = {
    contract: contractCategory,
  };
  return {
    get: configGetStub(values),
    getCategory: configGetCategoryStub(categories),
  };
}

const PLANNER_DECOMPOSITION_JSON = JSON.stringify({
  items: [
    { title: 'First item', brief: 'do the first thing', ordinal: 1 },
    { title: 'Second item', brief: 'do the second thing', ordinal: 2, dependsOn: [1] },
  ],
});

function makeAgentManagerHarness(): {
  agentManager: PhaseRunnerAgentManagerLike;
  spawnedTemplates: string[];
} {
  const agentStore = new Map<string, AgentRecord>();
  const spawnedTemplates: string[] = [];
  let counter = 0;
  const agentManager: PhaseRunnerAgentManagerLike = {
    spawn: (input) => {
      const id = `agent-${++counter}`;
      spawnedTemplates.push(input.template ?? 'engineer');
      const isPlanner = input.template === 'planner';
      const record: AgentRecord = {
        id,
        task: input.task ?? '',
        template: input.template ?? 'engineer',
        tools: [],
        // A planning agent auto-completes with a valid decomposition so the
        // AgentManager-backed runner resolves on its first poll (no real LLM).
        status: isPlanner ? 'completed' : 'running',
        startedAt: Date.now(),
        ...(isPlanner ? { completedAt: Date.now(), fullOutput: PLANNER_DECOMPOSITION_JSON } : {}),
        toolCallCount: 0,
        ...(isPlanner ? { usage: { inputTokens: 300, outputTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 1, turnCount: 1 } } : {}),
        orchestrationDepth: 0,
        executionProtocol: 'direct',
        reviewMode: 'none',
        communicationLane: 'parent-only',
      };
      agentStore.set(id, record);
      return record;
    },
    getStatus: (id: string) => agentStore.get(id) ?? null,
    cancel: (id: string) => {
      const record = agentStore.get(id);
      if (!record) return false;
      record.status = 'cancelled';
      return true;
    },
    registerCancellationSignal: () => {},
    releaseCancellationSignal: () => {},
  };

  return { agentManager, spawnedTemplates };
}

/** A runner that records every start and startFromPlan call and answers with numbered contract and owner ids. */
function recordingRunner(): {
  runner: WorkstreamServicesDeps['contractRunner'];
  starts: StartContractInput[];
  planStarts: StartFromPlanInput[];
} {
  const starts: StartContractInput[] = [];
  const planStarts: StartFromPlanInput[] = [];
  let counter = 0;
  const started = (): StartedContract => {
    counter += 1;
    return { contract: { id: `contract-${counter}` }, owner: { id: `owner-${counter}` } } as unknown as StartedContract;
  };
  return {
    starts,
    planStarts,
    runner: {
      start: (input) => { starts.push(input); return started(); },
      startFromPlan: (input) => { planStarts.push(input); return started(); },
    },
  };
}

describe('createWorkstreamServices: drafts and contract launch', () => {
  const tempDirs: string[] = [];
  let previousPort: ReturnType<typeof installJudgmentPort>;

  // Every draft reads the task's risk (routing.request-risk) for the planner:
  // these tests read it as minor, which leaves the decomposition gate open.
  beforeEach(() => {
    previousPort = installJudgmentPort(fakePort((_name, question) => scoreAnswer(question, 1)).port);
  });

  afterEach(() => {
    installJudgmentPort(previousPort);
    while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
  });

  function makeScratchProjectRoot(): string {
    const dir = makeProjectTempDir('gv-workstream-services');
    tempDirs.push(dir);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'demo.ts'), 'export const demo = true;\n');
    return dir;
  }

  function makeServices(
    projectRoot: string,
    runner: WorkstreamServicesDeps['contractRunner'],
    options: { decomposition?: 'heuristic' | 'agent'; sessionId?: WorkstreamServicesDeps['sessionId'] } = {},
  ) {
    const { agentManager, spawnedTemplates } = makeAgentManagerHarness();
    const services = createWorkstreamServices({
      agentManager,
      configManager: makeConfigManager(options.decomposition ?? 'heuristic'),
      adaptivePlanner: new AdaptivePlanner(),
      runtimeBus: new RuntimeEventBus(),
      projectRoot,
      contractRunner: runner,
      sessionId: options.sessionId ?? 'session-1',
      remoteSupervisor: new RemoteSupervisor(new RemoteRunnerRegistry({ getStatus: () => null, list: () => [] })),
      runtimeStore: createRuntimeStore(),
    });
    return { ...services, spawnedTemplates };
  }

  test('create -> approve -> launch of a single-item draft starts a contract with the task as the ask', async () => {
    const projectRoot = makeScratchProjectRoot();
    const { runner, starts, planStarts } = recordingRunner();
    const { orchestrationEngine, workstreamCommands } = makeServices(projectRoot, runner);

    // create: the rendered draft is one engineer item whose task is the goal.
    const draft = await workstreamCommands.proposeDraft('ship the demo feature');
    expect(draft.spec.phases.map((p) => p.role)).toEqual(['engineer']);
    expect(draft.spec.items.map((i) => i.task)).toEqual(['ship the demo feature']);
    expect(draft.provenance.kind).toBe('heuristic-configured');
    expect(draft.approved).toBe(false);

    // approve: flips the draft's own boolean; nothing starts yet.
    expect(workstreamCommands.approveDraft(draft.id)?.approved).toBe(true);
    expect(starts).toHaveLength(0);

    // launch: runner.start with the item's task; the draft is dropped.
    const result = workstreamCommands.launchDraft(draft.id);
    expect(result).toEqual({ contractId: 'contract-1', ownerAgentId: 'owner-1' });
    expect(starts).toEqual([{ ask: 'ship the demo feature', sessionId: 'session-1', origin: 'proposal', projectRoot }]);
    expect(planStarts).toHaveLength(0);
    expect(workstreamCommands.getDraft(draft.id)).toBeUndefined();
    // A launch never creates an engine workstream.
    expect(orchestrationEngine.listWorkstreams()).toHaveLength(0);

    orchestrationEngine.dispose();
  });

  test('a single-item draft whose brief was edited launches the edited task; the session id is read at launch', async () => {
    const projectRoot = makeScratchProjectRoot();
    const { runner, starts } = recordingRunner();
    let session = 'session-early';
    const { orchestrationEngine, workstreamCommands } = makeServices(projectRoot, runner, { sessionId: () => session });

    const draft = await workstreamCommands.proposeDraft('ship the demo feature', 'worktree');
    const edited = workstreamCommands.editItem(draft.id, '1', 'ship the demo feature with tests');
    expect(edited && 'error' in edited).toBe(false);
    workstreamCommands.approveDraft(draft.id);
    session = 'session-late';
    workstreamCommands.launchDraft(draft.id);

    expect(starts).toEqual([{
      ask: 'ship the demo feature with tests',
      sessionId: 'session-late',
      origin: 'proposal',
      projectRoot,
      isolation: 'worktree',
    }]);
    orchestrationEngine.dispose();
  });

  test('resumeAllFromDisk runs at construction and never throws against an empty .goodvibes/orchestration directory', () => {
    const projectRoot = makeScratchProjectRoot();
    const { runner } = recordingRunner();
    let engine: ReturnType<typeof createWorkstreamServices>['orchestrationEngine'] | undefined;
    expect(() => {
      engine = makeServices(projectRoot, runner).orchestrationEngine;
    }).not.toThrow();
    expect(engine!.listWorkstreams()).toHaveLength(0);
    engine!.dispose();
  });

  test('a rejected draft (edit without re-approval) cannot be launched', async () => {
    const projectRoot = makeScratchProjectRoot();
    const { runner, starts, planStarts } = recordingRunner();
    const { orchestrationEngine, workstreamCommands } = makeServices(projectRoot, runner);

    const draft = await workstreamCommands.proposeDraft('original task');
    workstreamCommands.approveDraft(draft.id);
    await workstreamCommands.editDraft(draft.id, 'revised task');
    expect(workstreamCommands.getDraft(draft.id)!.approved).toBe(false);

    expect(workstreamCommands.launchDraft(draft.id)).toBeNull();
    expect(starts).toHaveLength(0);
    expect(planStarts).toHaveLength(0);
    orchestrationEngine.dispose();
  });

  test('a created draft survives a restart: a second services instance on the same root reloads it', async () => {
    const projectRoot = makeScratchProjectRoot();
    const { runner, starts } = recordingRunner();
    const first = makeServices(projectRoot, runner);
    const draft = await first.workstreamCommands.proposeDraft('persist me across a restart');
    first.workstreamCommands.approveDraft(draft.id);
    first.orchestrationEngine.dispose();

    // "Restart": a brand-new services instance over the SAME project root.
    const second = makeServices(projectRoot, runner);
    const reloaded = second.workstreamCommands.getDraft(draft.id);
    expect(reloaded).toBeDefined();
    expect(reloaded!.task).toBe('persist me across a restart');
    expect(reloaded!.approved).toBe(true); // approval state persisted too

    // And the reloaded, already-approved draft launches straight away.
    expect(second.workstreamCommands.launchDraft(draft.id)).not.toBeNull();
    expect(starts.map((input) => input.ask)).toEqual(['persist me across a restart']);
    // Launched ⇒ its draft snapshot is gone, so a THIRD instance sees nothing.
    const third = makeServices(projectRoot, runner);
    expect(third.workstreamCommands.getDraft(draft.id)).toBeUndefined();

    second.orchestrationEngine.dispose();
    third.orchestrationEngine.dispose();
  });

  test('a cancelled (removed) draft does not come back after a restart', async () => {
    const projectRoot = makeScratchProjectRoot();
    const { runner } = recordingRunner();
    const first = makeServices(projectRoot, runner);
    const draft = await first.workstreamCommands.proposeDraft('to be discarded');
    expect(first.workstreamCommands.removeDraft(draft.id)).toBe(true);
    first.orchestrationEngine.dispose();

    const second = makeServices(projectRoot, runner);
    expect(second.workstreamCommands.getDraft(draft.id)).toBeUndefined();
    expect(second.workstreamCommands.listDrafts()).toHaveLength(0);
    second.orchestrationEngine.dispose();
  });

  test('agent decomposition: create spawns a planner agent (fleet pickup) and tags provenance', async () => {
    const projectRoot = makeScratchProjectRoot();
    const { runner } = recordingRunner();
    const { orchestrationEngine, workstreamCommands, spawnedTemplates } = makeServices(projectRoot, runner, { decomposition: 'agent' });

    const draft = await workstreamCommands.proposeDraft('build a multi-step feature');

    // The planning agent was spawned through the shared AgentManager (so it
    // appears in the fleet like any agent). It is a 'planner'-template agent.
    expect(spawnedTemplates).toContain('planner');
    // Its structured output validated → agent provenance with usage + item count.
    expect(draft.provenance.kind).toBe('agent');
    expect(draft.provenance.itemCount).toBe(2);
    expect(draft.provenance.agentTokens).toBe(420);

    // A multi-item proposal keeps every item and the dependency between them.
    expect(draft.spec.phases.map((p) => p.role)).toEqual(['engineer']);
    expect(draft.spec.items).toHaveLength(2);
    expect(draft.spec.items.map((i) => i.title)).toEqual(['First item', 'Second item']);
    expect(draft.spec.items.map((i) => i.task)).toEqual(['do the first thing', 'do the second thing']);
    const first = draft.spec.items[0]!;
    const second = draft.spec.items[1]!;
    expect(second.dependsOn).toEqual([first.id!]); // "Second item" after "First item"
    expect(first.dependsOn ?? []).toEqual([]);
    expect(draft.spec.provenance?.decomposedBy).toBe('agent');

    orchestrationEngine.dispose();
  });

  test('launch of a multi-item draft starts the contract from a drafted plan built from the draft items', async () => {
    const projectRoot = makeScratchProjectRoot();
    const { runner, starts, planStarts } = recordingRunner();
    const { orchestrationEngine, workstreamCommands } = makeServices(projectRoot, runner, { decomposition: 'agent' });

    const draft = await workstreamCommands.proposeDraft('build a multi-step feature', 'shared');
    const [first, second] = draft.spec.items;
    workstreamCommands.approveDraft(draft.id);
    expect(workstreamCommands.launchDraft(draft.id)).toEqual({ contractId: 'contract-1', ownerAgentId: 'owner-1' });

    expect(starts).toHaveLength(0);
    expect(planStarts).toEqual([{
      ask: 'build a multi-step feature',
      sessionId: 'session-1',
      origin: 'proposal',
      projectRoot,
      isolation: 'shared',
      draft: {
        goal: 'build a multi-step feature',
        units: [
          { id: first!.id!, title: 'First item', brief: 'do the first thing', dependsOn: [] },
          { id: second!.id!, title: 'Second item', brief: 'do the second thing', dependsOn: [first!.id!] },
        ],
      },
    }]);
    expect(orchestrationEngine.listWorkstreams()).toHaveLength(0);
    orchestrationEngine.dispose();
  });
});

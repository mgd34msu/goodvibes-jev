import { describe, expect, test } from 'bun:test';
import { CommandRegistry } from '../../input/command-registry.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { registerBuiltinCommands } from '../../input/commands.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { createRuntimeOpsApi } from '@/runtime/index.ts';
import { createTaskManager } from '@/runtime/index.ts';
import { createFeatureFlagManager, deriveFeatureStates, type FeatureFlagManager } from '@/runtime/index.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { createTasksReadModel } from '../helpers/ui-read-models.ts';
import type { OperatorClient } from '@/runtime/index.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const shellPaths = createShellPathService({
  workingDirectory: join(tmpdir(), 'goodvibes-test'),
  homeDirectory: join(tmpdir(), 'goodvibes-home'),
});

function makeTaskCommandContext(
  out: string[],
  readModels: CommandContext['platform']['readModels'],
  ops: Partial<CommandContext['ops']> = {},
  clients: CommandContext['clients'] = {},
): CommandContext {
  const providerRegistry = {} as never;
  const conversationManager = {} as never;
  const configManager = {} as never;
  return {
    session: {
      conversationManager,
      runtime: {
        model: '',
        provider: '',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: '',
        sessionId: 'sess-tasks',
      },
    },
    provider: {
      providerRegistry,
    },
    workspace: {
      shellPaths,
    },
    platform: {
      config: {} as never,
      configManager,
      readModels,
    },
    ops,
    extensions: {
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
    },
    clients,
    renderRequest: () => {},
    print: (text: string) => { out.push(text); },
    exit: () => {},
  };
}

function createOperatorTaskClient(
  readModels: CommandContext['platform']['readModels'],
): OperatorClient {
  return {
    sessions: {} as never,
    approvals: {} as never,
    providers: {} as never,
    controlPlane: {} as never,
    events: {} as never,
    shellPaths,
    tasks: {
      snapshot: () => requireTasksReadModel(readModels).getSnapshot(),
      list: (limit = 100) => requireTasksReadModel(readModels).getSnapshot().tasks.slice(0, limit),
      get: (taskId) => requireTasksReadModel(readModels).getSnapshot().tasks.find((task) => task.id === taskId) ?? null,
      running: () => requireTasksReadModel(readModels).getSnapshot().tasks.filter((task) => task.status === 'running'),
    },
  };
}

function requireTasksReadModel(
  readModels: CommandContext['platform']['readModels'],
): NonNullable<CommandContext['platform']['readModels']>['tasks'] {
  const tasks = readModels?.tasks;
  if (!tasks) {
    throw new Error('tasks read model is required for task command tests');
  }
  return tasks;
}

describe('tasks command', () => {
  test('lists, shows, and outputs connected-host tasks', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const tasksCommand = registry.get('tasks');
    expect(tasksCommand).toEqual(expect.objectContaining({
      name: 'tasks',
      handler: expect.any(Function),
    }));

    const store = createRuntimeStore();
    const bus = new RuntimeEventBus();
    const taskManager = createTaskManager(store, bus, 'sess-tasks');
    const task = taskManager.createTask({
      kind: 'integration',
      title: 'Publish release evidence',
      description: 'Publish release evidence bundle',
      owner: 'release',
    });
    taskManager.startTask(task.id);
    taskManager.completeTask(task.id, { ok: true, artifactId: 'artifact-1' });

    const out: string[] = [];
    // No opsControlPlane: the Agent never constructs the ops intervention
    // plane (read-only tasks policy), and the read paths under test do not
    // need one.
    const opsApi = createRuntimeOpsApi({
      tasksReadModel: createTasksReadModel(store),
      taskManager,
    });
    const readModels = {
      tasks: createTasksReadModel(store),
    } as never;
    const ctx = makeTaskCommandContext(out, readModels, {
    }, {
      operator: createOperatorTaskClient(readModels),
      opsApi,
    });

    await tasksCommand!.handler(['list'], ctx);
    expect(out.join('\n')).toContain('Tasks (1)');
    expect(out.join('\n')).toContain('Publish release evidence');

    out.length = 0;
    await tasksCommand!.handler([], ctx);
    expect(out.join('\n')).toContain('Tasks (1)');
    expect(out.join('\n')).toContain('Publish release evidence');

    out.length = 0;
    await tasksCommand!.handler(['show', task.id], ctx);
    expect(out.join('\n')).toContain(`Task ${task.id}`);
    expect(out.join('\n')).toContain('kind: integration');

    out.length = 0;
    await tasksCommand!.handler(['output', task.id], ctx);
    expect(out.join('\n')).toContain('artifact-1');
  });

  test('a task list the daemon cannot answer still shows the local half, and says why', async () => {
    // The context above carries `configManager = {} as never`, which is exactly
    // the shape the verb caller reports as "no host can be resolved", the same
    // path a real install takes with daemon.enabled=false or no operator token.
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const tasksCommand = registry.get('tasks');

    const store = createRuntimeStore();
    const bus = new RuntimeEventBus();
    const taskManager = createTaskManager(store, bus, 'sess-tasks-degraded');
    const task = taskManager.createTask({ kind: 'exec', title: 'Local work in flight', owner: 'shell' });
    taskManager.startTask(task.id);

    const out: string[] = [];
    const readModels = { tasks: createTasksReadModel(store) } as never;
    const ctx = makeTaskCommandContext(out, readModels, {}, {
      operator: createOperatorTaskClient(readModels),
    });

    await tasksCommand!.handler(['list'], ctx);
    const listed = out.join('\n');
    // The local half is real work and is shown, tagged as this Agent's own...
    expect(listed).toContain('Local work in flight');
    expect(listed).toContain('local');
    // ...and the missing daemon half is stated rather than swallowed.
    expect(listed).toContain("the daemon's tasks are not included");

    // A daemon-side id the local registry does not know reads as unknown here
    // rather than as an error, and `show` names where a task runs.
    out.length = 0;
    await tasksCommand!.handler(['show', 'task-that-lives-on-the-daemon'], ctx);
    expect(out.join('\n')).toContain('Unknown task task-that-lives-on-the-daemon');

    out.length = 0;
    await tasksCommand!.handler(['show', task.id], ctx);
    expect(out.join('\n')).toContain('runs on this Agent');
  });

  test('the agent-shaped ops api refuses intervention verbs with the honest unavailability reason', () => {
    // bootstrap-shell builds opsApi WITHOUT an ops control plane, the Agent
    // never constructs one (connected-host tasks are read-only by product
    // policy). Anything that does reach the intervention verbs must get the
    // real reason, not a silent no-op.
    const store = createRuntimeStore();
    const bus = new RuntimeEventBus();
    const taskManager = createTaskManager(store, bus, 'sess-ops-honesty');
    const opsApi = createRuntimeOpsApi({
      tasksReadModel: createTasksReadModel(store),
      taskManager,
    });
    const task = taskManager.createTask({ kind: 'exec', title: 'held task', owner: 'shell' });
    taskManager.startTask(task.id);

    expect(() => opsApi.tasks.cancel(task.id)).toThrow('Ops control plane is not available in this runtime.');
    expect(() => opsApi.tasks.pause(task.id)).toThrow('Ops control plane is not available in this runtime.');
    expect(() => opsApi.agents.cancel('agent-1')).toThrow('Ops control plane is not available in this runtime.');
    // Read paths stay fully functional without a plane.
    expect(opsApi.tasks.get(task.id)?.status).toBe('running');
  });

  test('blocks copied task panel routing in Agent', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const tasksCommand = registry.get('tasks');
    expect(tasksCommand).toEqual(expect.objectContaining({
      name: 'tasks',
      handler: expect.any(Function),
    }));
    const out: string[] = [];
    const ctx = makeTaskCommandContext(out, undefined);

    await tasksCommand!.handler(['open'], ctx);

    expect(out.join('\n')).toContain('Agent Workspace -> Work & Approvals -> Filter host tasks');
  });

  test('blocks copied runtime task interventions in Agent', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const tasksCommand = registry.get('tasks');
    expect(tasksCommand).toEqual(expect.objectContaining({
      name: 'tasks',
      handler: expect.any(Function),
    }));

    const store = createRuntimeStore();
    const bus = new RuntimeEventBus();
    const taskManager = createTaskManager(store, bus, 'sess-tasks');
    const task = taskManager.createTask({
      kind: 'exec',
      title: 'Run verification',
      owner: 'shell',
    });
    taskManager.startTask(task.id);

    const out: string[] = [];
    // Even without any ops intervention plane the command must refuse the
    // mutation itself, the policy block runs before any client is touched.
    const opsApi = createRuntimeOpsApi({
      tasksReadModel: createTasksReadModel(store),
      taskManager,
    });
    const readModels = {
      tasks: createTasksReadModel(store),
    } as never;
    const ctx = makeTaskCommandContext(out, readModels, {
    }, {
      operator: createOperatorTaskClient(readModels),
      opsApi,
    });

    await tasksCommand!.handler(['pause', task.id, 'waiting', 'for', 'approval'], ctx);
    expect(taskManager.getTask(task.id)?.status).toBe('running');
    expect(out.join('\n')).toContain('Task mutation "pause" is blocked in GoodVibes Agent.');
    expect(out.join('\n')).toContain('no local task state was changed');

    out.length = 0;
    await tasksCommand!.handler(['resume', task.id], ctx);
    expect(taskManager.getTask(task.id)?.status).toBe('running');
    expect(out.join('\n')).toContain('Task mutation "resume" is blocked in GoodVibes Agent.');

    out.length = 0;
    await tasksCommand!.handler(['cancel', task.id], ctx);
    expect(taskManager.getTask(task.id)?.status).toBe('running');
    expect(out.join('\n')).toContain('Task mutation "cancel" is blocked in GoodVibes Agent.');
  });

  test('blocks copied task CRUD mutation flows in Agent', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const tasksCommand = registry.get('tasks');
    expect(tasksCommand).toEqual(expect.objectContaining({
      name: 'tasks',
      handler: expect.any(Function),
    }));

    const store = createRuntimeStore();
    const bus = new RuntimeEventBus();
    const taskManager = createTaskManager(store, bus, 'sess-task-crud');

    const out: string[] = [];
    // No opsControlPlane: the policy block must refuse CRUD mutations before
    // any client is touched, plane or not.
    const opsApi = createRuntimeOpsApi({
      tasksReadModel: createTasksReadModel(store),
      taskManager,
    });
    const readModels = {
      tasks: createTasksReadModel(store),
    } as never;
    const ctx = makeTaskCommandContext(out, readModels, {
    }, {
      operator: createOperatorTaskClient(readModels),
      opsApi,
    });
    ctx.session.runtime.sessionId = 'sess-task-crud';

    await tasksCommand!.handler(['create', 'integration', 'release-bot', 'Prepare', 'release', 'bundle'], ctx);
    expect(out.join('\n')).toContain('Task mutation "create" is blocked in GoodVibes Agent.');
    expect(taskManager.getTasksByKind('integration')).toHaveLength(0);

    out.length = 0;
    await tasksCommand!.handler(['update', 'task-1', 'description', 'Publish', 'and', 'verify', 'bundle'], ctx);
    expect(out.join('\n')).toContain('Task mutation "update" is blocked in GoodVibes Agent.');

    out.length = 0;
    await tasksCommand!.handler(['complete', 'task-1', 'bundle-ready'], ctx);
    expect(out.join('\n')).toContain('Task mutation "complete" is blocked in GoodVibes Agent.');

    const failedTask = taskManager.createTask({
      kind: 'exec',
      title: 'Run broken verification',
      owner: 'shell',
    });
    taskManager.startTask(failedTask.id);
    out.length = 0;
    await tasksCommand!.handler(['fail', failedTask.id, 'lint', 'failed'], ctx);
    expect(out.join('\n')).toContain('Task mutation "fail" is blocked in GoodVibes Agent.');
    expect(taskManager.getTask(failedTask.id)?.status).toBe('running');
  });

  // ---------------------------------------------------------------------------
  // runtime.unifiedTasks, driven to BOTH values through the real gate.
  //
  // This setting used to configure nothing: bootstrap.ts built its
  // opsTaskManager with createTaskManager's 3-arg form (no featureFlags), and
  // isFeatureGateEnabled is permissive when no manager is wired, so omitting
  // it did not disable task tracking when runtime.unifiedTasks was turned
  // off. Unlike the other five classes in this sweep, this key's schema
  // default was ALSO wrong (recorded false while every install always
  // shipped enabled, because of this exact gap), the SDK has corrected the
  // default to true/enabled, and bootstrap.ts now threads featureFlags, the
  // same shape as the other five fixes.
  //
  // Unlike the TUI, this product's own `/tasks create|update|complete|fail`
  // command is ALWAYS blocked by a separate connected-host-tasks-are-read-only
  // policy (see the test above), so the feature gate is not reachable through
  // the interactive command here. It IS reachable through the same taskManager
  // that automation/exec/agent-originated tasks create programmatically
  // (opsApi.tasks.create and taskManager.createTask directly), which is what
  // this test drives.
  // ---------------------------------------------------------------------------

  function featureFlagsFor(root: string, unifiedTasks: boolean): FeatureFlagManager {
    const configManager = new ConfigManager({ surfaceRoot: 'agent', workingDir: root, homeDir: root, configDir: join(root, '.goodvibes', 'agent') });
    configManager.set('runtime.unifiedTasks', unifiedTasks);
    const featureFlags = createFeatureFlagManager();
    featureFlags.loadFromConfig({ flags: deriveFeatureStates(configManager) });
    return featureFlags;
  }

  test('runtime.unifiedTasks false turns off task creation, and it refuses', () => {
    const root = makeProjectTempDir('gv-unified-tasks-gate');
    const store = createRuntimeStore();
    const bus = new RuntimeEventBus();
    // Constructed exactly as runtime/bootstrap.ts constructs it.
    const taskManager = createTaskManager(store, bus, 'sess-tasks-gate-off', featureFlagsFor(root, false));
    const opsApi = createRuntimeOpsApi({
      tasksReadModel: createTasksReadModel(store),
      taskManager,
    });

    let refusal = '';
    try {
      opsApi.tasks.create({ kind: 'exec', title: 'should be refused', owner: 'automation' });
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    expect(refusal).toContain('runtime.unifiedTasks');
    expect(taskManager.getTasksByKind('exec')).toEqual([]);
  });

  test('runtime.unifiedTasks true allows task creation, and is the shipped default', () => {
    const root = makeProjectTempDir('gv-unified-tasks-gate');
    const store = createRuntimeStore();
    const bus = new RuntimeEventBus();
    const taskManager = createTaskManager(store, bus, 'sess-tasks-gate-on', featureFlagsFor(root, true));
    const opsApi = createRuntimeOpsApi({
      tasksReadModel: createTasksReadModel(store),
      taskManager,
    });

    const task = opsApi.tasks.create({ kind: 'exec', title: 'should succeed', owner: 'automation' });
    expect(task.status).toBe('queued');

    // The default half: with the key never written, effective behaviour
    // matches true. This is what makes threading featureFlags a fix that
    // changes only whether the switch WORKS, not what an existing install does.
    // A genuinely fresh root (not `root`, which already has runtime.unifiedTasks
    // written under it), ConfigManager's project tier is keyed by
    // workingDir/surfaceRoot regardless of configDir, so reusing `root` here
    // would read back the write above instead of the real default.
    const unsetRoot = makeProjectTempDir('gv-unified-tasks-gate-unset');
    const unsetConfig = new ConfigManager({ surfaceRoot: 'agent', workingDir: unsetRoot, homeDir: unsetRoot, configDir: join(unsetRoot, '.goodvibes', 'unset') });
    expect(unsetConfig.get('runtime.unifiedTasks')).toBe(true);
    const flags = createFeatureFlagManager();
    flags.loadFromConfig({ flags: deriveFeatureStates(unsetConfig) });
    const unsetManager = createTaskManager(createRuntimeStore(), new RuntimeEventBus(), 'sess-tasks-gate-unset', flags);
    const unsetTask = unsetManager.createTask({ kind: 'exec', title: 'Unset default check', owner: 'test' });
    expect(unsetTask.status).toBe('queued');
  });
});

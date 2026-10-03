/**
 * `/tasks`, the Agent's read-only view of runtime tasks.
 *
 * The rows come from two places. This process's own registry holds the exec,
 * agent and ACP tasks the loop here spawned; the daemon holds the rest,
 * scheduled work, channel-driven runs, tasks other surfaces submitted. The
 * SDK's tasks client unions them, local rows winning on a shared id because
 * they are the live copy, and reports the daemon's half as missing rather than
 * failing the whole list when it cannot be reached.
 *
 * Every mutation stays blocked here, which is the Agent's own policy and not a
 * limit of the client: normal work belongs in the conversation, durable work in
 * /workplan, and implementation work goes to the terminal through /delegate.
 */
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import type { RuntimeTask, TaskLifecycleState } from '@/runtime/index.ts';
import { createTasksClient, type TasksClient, type UnionTask } from '@goodvibes-jev/engine/sdk/platform/runtime/client';
import { createAgentDaemonVerbCaller } from '../../runtime/client/daemon-verbs.ts';
import { requireOperatorClient, requireShellPaths } from './runtime-services.ts';

const BLOCKED_TASK_MUTATIONS: ReadonlySet<string> = new Set([
  'create',
  'update',
  'complete',
  'fail',
  'cancel',
  'pause',
  'resume',
  'retry',
]);

function printTaskMutationBlocked(print: (text: string) => void, subcommand: string): void {
  print([
    `Task mutation "${subcommand}" is blocked in GoodVibes Agent.`,
    '  policy connected-host tasks are read-only from the Agent TUI; normal work stays in the main conversation.',
    '  durable tasks use /workplan for visible planning and task tracking.',
    '  build/fix/review use /delegate <task> to hand explicit implementation work to GoodVibes TUI.',
    '  result no local task state was changed.',
  ].join('\n'));
}

/** The union reader: this process's own registry plus the connected daemon. */
function tasksClientFor(ctx: CommandContext): TasksClient {
  const operatorClient = requireOperatorClient(ctx);
  return createTasksClient({
    local: {
      list: (limit) => operatorClient.tasks.list(limit),
      get: (taskId) => operatorClient.tasks.get(taskId),
    },
    verbs: createAgentDaemonVerbCaller({
      configManager: ctx.platform.configManager,
      // Lazy: a disabled-daemon context with no shell paths wired still gets
      // the honest reason from probe() instead of throwing on the way in.
      homeDirectory: () => requireShellPaths(ctx).homeDirectory,
    }),
  });
}

function sortUnionTasks(tasks: readonly UnionTask[]): UnionTask[] {
  const statusOrder: TaskLifecycleState[] = ['running', 'queued', 'blocked', 'failed', 'completed', 'cancelled'];
  const ranking = new Map(statusOrder.map((status, index) => [status, index] as const));
  return [...tasks].sort((a, b) => {
    const rankDelta = (ranking.get(a.task.status) ?? 99) - (ranking.get(b.task.status) ?? 99);
    if (rankDelta !== 0) return rankDelta;
    const aWhen = a.task.startedAt ?? a.task.queuedAt;
    const bWhen = b.task.startedAt ?? b.task.queuedAt;
    return bWhen - aWhen;
  });
}

function summarizeTaskResult(task: RuntimeTask): string {
  const payload = (
    typeof task.result === 'string'
      ? task.result
      : task.error
        ?? (task.result !== undefined ? JSON.stringify(task.result) : task.description)
        ?? task.title
  );
  const normalized = String(payload).replace(/\s+/g, ' ').trim();
  return normalized.length <= 140 ? normalized : `${normalized.slice(0, 137)}...`;
}

export function registerTasksRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'tasks',
    aliases: ['task'],
    description: 'Inspect connected-host tasks without starting or mutating local background work',
    hidden: true,
    usage: '[list [status|kind] | show <taskId> | output <taskId>]',
    async handler(args, ctx) {
      const subcommand = args[0]?.toLowerCase() ?? 'list';
      if (subcommand === 'open' || subcommand === 'panel') {
        ctx.print('Open Agent Workspace -> Work & Approvals -> Filter host tasks for the workspace view, or run /tasks list for compact command output.');
        return;
      }

      if (BLOCKED_TASK_MUTATIONS.has(subcommand)) {
        printTaskMutationBlocked(ctx.print, subcommand);
        return;
      }

      const tasksClient = tasksClientFor(ctx);

      if (subcommand === 'list') {
        const { tasks: union, daemonUnavailable } = await tasksClient.list(500);
        const tasks = sortUnionTasks(union);
        const filter = args[1]?.toLowerCase();
        const filtered = tasks.filter((entry) => !filter || entry.task.status === filter || entry.task.kind === filter);
        // The daemon note rides ALONGSIDE whatever was found rather than
        // replacing it: the local half is real work, and hiding it behind an
        // error would lose tasks that are genuinely running here.
        const daemonNote = daemonUnavailable
          ? [`  (the daemon's tasks are not included: ${daemonUnavailable})`]
          : [];
        if (filtered.length === 0) {
          ctx.print([
            filter ? `No tasks matched "${filter}".` : 'No tasks recorded yet.',
            ...daemonNote,
          ].join('\n'));
          return;
        }
        ctx.print([
          `Tasks (${filtered.length})`,
          ...filtered.slice(0, 20).map(({ task, origin }) => `  ${task.id}  ${task.status.padEnd(9)} ${task.kind.padEnd(11)} ${task.owner.padEnd(10)} ${origin.padEnd(6)} ${task.title}`),
          ...daemonNote,
        ].join('\n'));
        return;
      }

      if (subcommand === 'show') {
        const taskId = args[1];
        if (!taskId) {
          ctx.print('Usage: /tasks show <taskId>');
          return;
        }
        const found = await tasksClient.get(taskId);
        if (!found) {
          ctx.print(`Unknown task ${taskId}`);
          return;
        }
        const { task, origin } = found;
        ctx.print([
          `Task ${task.id}`,
          `  title ${task.title}`,
          `  kind: ${task.kind}`,
          `  status ${task.status}`,
          `  owner ${task.owner}`,
          `  runs on ${origin === 'local' ? 'this Agent' : 'the daemon'}`,
          `  cancellable ${task.cancellable ? 'yes' : 'no'}`,
          `  queued at ${new Date(task.queuedAt).toISOString()}`,
          `  started at ${task.startedAt ? new Date(task.startedAt).toISOString() : 'n/a'}`,
          `  ended at ${task.endedAt ? new Date(task.endedAt).toISOString() : 'n/a'}`,
          `  parent ${task.parentTaskId ?? 'none'}`,
          `  children ${task.childTaskIds.join(', ') || '(none)'}`,
          `  correlation ID ${task.correlationId ?? 'n/a'}`,
          `  summary ${summarizeTaskResult(task)}`,
        ].join('\n'));
        return;
      }

      if (subcommand === 'output') {
        const taskId = args[1];
        if (!taskId) {
          ctx.print('Usage: /tasks output <taskId>');
          return;
        }
        const found = await tasksClient.get(taskId);
        if (!found) {
          ctx.print(`Unknown task ${taskId}`);
          return;
        }
        const { task } = found;
        const payload = typeof task.result === 'string'
          ? task.result
          : task.result !== undefined
            ? JSON.stringify(task.result, null, 2)
            : task.error ?? task.description ?? task.title;
        ctx.print(String(payload));
        return;
      }

      ctx.print(`Unknown tasks subcommand ${subcommand}`);
    },
  });
}

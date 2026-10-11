import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { assertCurrentToolInvocation, type ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { ShellPathService } from '@/runtime/index.ts';
import type { AgentConnectedHostConfigReader } from '../agent/routine-schedule-promotion.ts';
import { randomUUID } from 'node:crypto';

type ScheduleAction =
  | 'list'
  | 'create'
  | 'reminder'
  | 'edit'
  | 'run'
  | 'pause'
  | 'resume'
  | 'delete';

interface AgentScheduleToolArgs {
  readonly action?: unknown;
  readonly mode?: unknown;
  readonly scheduleId?: unknown;
  readonly jobId?: unknown;
  readonly targetId?: unknown;
  readonly task?: unknown;
  readonly message?: unknown;
  readonly successCriteria?: unknown;
  readonly scheduleKind?: unknown;
  readonly kind?: unknown;
  readonly scheduleValue?: unknown;
  readonly value?: unknown;
  readonly at?: unknown;
  readonly every?: unknown;
  readonly cron?: unknown;
  readonly timezone?: unknown;
  readonly staggerMs?: unknown;
  readonly name?: unknown;
  readonly prompt?: unknown;
  readonly provider?: unknown;
  readonly model?: unknown;
  readonly deliveryChannel?: unknown;
  readonly deliveryRoute?: unknown;
  readonly deliveryWebhook?: unknown;
  readonly deliveryLink?: unknown;
  readonly disabled?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
  readonly query?: unknown;
  readonly limit?: unknown;
}

const LIFECYCLE_ACTIONS: Readonly<Record<'run' | 'pause' | 'resume' | 'delete', string>> = {
  run: 'automation.schedules.run',
  pause: 'automation.schedules.disable',
  resume: 'automation.schedules.enable',
  delete: 'automation.schedules.delete',
};

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readScheduleId(args: AgentScheduleToolArgs): string {
  return readString(args.scheduleId) || readString(args.jobId) || readString(args.targetId);
}

function normalizeAction(value: unknown): ScheduleAction | null {
  const action = readString(value).toLowerCase();
  if (!action) return null;
  if (action === 'autonomous' || action === 'schedule' || action === 'create_task' || action === 'create-task') return 'create';
  if (action === 'remind' || action === 'reminder' || action === 'create_reminder' || action === 'create-reminder') return 'reminder';
  if (action === 'update' || action === 'patch') return 'edit';
  if (action === 'disable' || action === 'stop' || action === 'cancel') return 'pause';
  if (action === 'enable' || action === 'start') return 'resume';
  if (action === 'remove') return 'delete';
  if (action === 'ls' || action === 'status' || action === 'show') return 'list';
  if (action === 'list' || action === 'create' || action === 'edit' || action === 'run' || action === 'pause' || action === 'resume' || action === 'delete') return action;
  return null;
}

function hasEditFields(args: AgentScheduleToolArgs): boolean {
  return Boolean(
    readString(args.scheduleKind)
      || readString(args.kind)
      || readString(args.scheduleValue)
      || readString(args.value)
      || readString(args.at)
      || readString(args.every)
      || readString(args.cron)
      || readString(args.name)
      || readString(args.prompt)
      || readString(args.task)
      || readString(args.successCriteria)
      || args.staggerMs !== undefined,
  );
}

function readAction(args: AgentScheduleToolArgs): ScheduleAction {
  const explicit = normalizeAction(args.action) ?? normalizeAction(args.mode);
  if (explicit) return explicit;
  if (readString(args.message)) return 'reminder';
  if (readString(args.task)) return readScheduleId(args) && hasEditFields(args) ? 'edit' : 'create';
  if (readScheduleId(args) && hasEditFields(args)) return 'edit';
  return 'list';
}

function scheduleKind(args: AgentScheduleToolArgs): string {
  const direct = readString(args.scheduleKind) || readString(args.kind);
  if (direct) return direct.toLowerCase();
  if (readString(args.at)) return 'at';
  if (readString(args.every)) return 'every';
  if (readString(args.cron)) return 'cron';
  return '';
}

function scheduleValue(args: AgentScheduleToolArgs, kind: string): string {
  const direct = readString(args.scheduleValue) || readString(args.value);
  if (direct) return direct;
  if (kind === 'at') return readString(args.at);
  if (kind === 'every') return readString(args.every);
  if (kind === 'cron') return readString(args.cron);
  return readString(args.at) || readString(args.every) || readString(args.cron);
}

function sharedCreateArgs(args: AgentScheduleToolArgs): Record<string, unknown> {
  const kind = scheduleKind(args);
  return {
    scheduleKind: kind,
    scheduleValue: scheduleValue(args, kind),
    timezone: args.timezone,
    name: args.name,
    provider: args.provider,
    model: args.model,
    deliveryChannel: args.deliveryChannel,
    deliveryRoute: args.deliveryRoute,
    deliveryWebhook: args.deliveryWebhook,
    deliveryLink: args.deliveryLink,
    disabled: args.disabled,
    confirm: args.confirm,
    explicitUserRequest: args.explicitUserRequest,
  };
}

function autonomyArgs(args: AgentScheduleToolArgs): Record<string, unknown> {
  return {
    task: args.task,
    successCriteria: args.successCriteria,
    ...sharedCreateArgs(args),
  };
}

function reminderArgs(args: AgentScheduleToolArgs): Record<string, unknown> {
  return {
    message: args.message,
    ...sharedCreateArgs(args),
  };
}

function editArgs(args: AgentScheduleToolArgs): Record<string, unknown> {
  const kind = scheduleKind(args);
  return {
    scheduleId: readScheduleId(args),
    scheduleKind: kind || undefined,
    scheduleValue: kind ? scheduleValue(args, kind) : undefined,
    timezone: args.timezone,
    staggerMs: args.staggerMs,
    name: args.name,
    prompt: args.prompt,
    task: args.task,
    successCriteria: args.successCriteria,
    confirm: args.confirm,
    explicitUserRequest: args.explicitUserRequest,
  };
}

function listInput(args: AgentScheduleToolArgs): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  const query = readString(args.query) || readScheduleId(args);
  if (query) input.query = query;
  if (typeof args.limit === 'number' && Number.isFinite(args.limit)) input.limit = args.limit;
  return input;
}

export function createAgentScheduleTool(
  _shellPaths: ShellPathService,
  _configManager: AgentConnectedHostConfigReader,
  registry?: ToolRegistry,
): Tool {
  return {
    definition: {
      name: 'schedule',
      description: 'List, create, edit, run, pause, resume schedules.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'create', 'autonomous', 'remind', 'reminder', 'edit', 'run', 'pause', 'resume', 'enable', 'disable', 'delete'],
            description: 'Schedule action; changes require a current recorded admission.',
          },
          scheduleId: { type: 'string', description: 'Connected schedule id for edit/run/pause/resume/delete.' },
          jobId: { type: 'string', description: 'Alias for scheduleId.' },
          targetId: { type: 'string', description: 'Alias for scheduleId.' },
          task: { type: 'string', description: 'Autonomous task for action:create, or replacement task for action:edit.' },
          message: { type: 'string', description: 'Reminder text for action:reminder.' },
          successCriteria: { type: 'string', description: 'Required for autonomous scheduled tasks.' },
          scheduleKind: { type: 'string', enum: ['at', 'every', 'cron'], description: 'Schedule kind.' },
          kind: { type: 'string', enum: ['at', 'every', 'cron'], description: 'Alias for scheduleKind.' },
          scheduleValue: { type: 'string', description: 'ISO timestamp, interval, or cron expression.' },
          value: { type: 'string', description: 'Alias for scheduleValue.' },
          at: { type: 'string', description: 'ISO timestamp shortcut.' },
          every: { type: 'string', description: 'Interval shortcut such as 1d or 30m.' },
          cron: { type: 'string', description: 'Cron expression shortcut.' },
          timezone: { type: 'string', description: 'Optional IANA timezone.' },
          staggerMs: { type: 'number', description: 'Optional cron stagger in milliseconds for edits.' },
          name: { type: 'string', description: 'Connected schedule display name.' },
          prompt: { type: 'string', description: 'Exact replacement prompt for action:edit.' },
          provider: { type: 'string', description: 'Optional provider row id for scheduled execution.' },
          model: { type: 'string', description: 'Optional model id for scheduled execution.' },
          deliveryChannel: { type: 'string', description: 'Optional delivery channel target.' },
          deliveryRoute: { type: 'string', description: 'Optional connected route target.' },
          deliveryWebhook: { type: 'string', description: 'Optional webhook target.' },
          deliveryLink: { type: 'string', description: 'Optional link delivery target.' },
          disabled: { type: 'boolean', description: 'Create schedule disabled.' },
          query: { type: 'string', description: 'Optional list query or schedule lookup text.' },
          limit: { type: 'number', description: 'Optional list limit when supported by the connected host.' },
          confirm: { type: 'boolean', description: 'Optional request provenance; does not grant permission.' },
          explicitUserRequest: { type: 'string', description: 'Optional request provenance; the original admitted source remains authoritative.' },
        },
        additionalProperties: false,
      },
      sideEffects: ['network', 'state'],
      concurrency: 'serial',
    },
    execute: async (rawArgs, options) => {
      if (!registry || !assertCurrentToolInvocation(rawArgs, options)) {
        return { success: false, error: 'Schedule dispatch requires the current recorded tool admission.' };
      }
      const args: AgentScheduleToolArgs = rawArgs;
      const run = (name: string, input: Record<string, unknown>) => registry.executeNested(randomUUID(), name,
        Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)), options);
      const action = readAction(args);
      if (action === 'list') {
        return run('agent_operator_method', {
          methodId: 'automation.schedules.list',
          input: listInput(args),
        });
      }
      if (action === 'create') return run('agent_autonomy_schedule', autonomyArgs(args));
      if (action === 'reminder') return run('agent_reminder_schedule', reminderArgs(args));
      if (action === 'edit') return run('agent_schedule_edit', editArgs(args));

      const scheduleId = readScheduleId(args);
      if (!scheduleId) {
        return {
          success: false,
          error: `scheduleId is required for schedule action:${action}.`,
        };
      }
      return run('agent_operator_action', {
        action: LIFECYCLE_ACTIONS[action],
        scheduleId,
      });
    },
  };
}

export function registerAgentScheduleTool(
  registry: ToolRegistry,
  shellPaths: ShellPathService,
  configManager: AgentConnectedHostConfigReader,
): void {
  if (!registry.has('schedule')) registry.register(createAgentScheduleTool(shellPaths, configManager, registry));
}

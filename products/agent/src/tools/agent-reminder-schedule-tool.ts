import { captureScheduleEffect, createScheduleInputProjector, formatScheduleOperatorResult } from './agent-schedule-effect.ts';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { ShellPathService } from '@/runtime/index.ts';
import {
  buildReminderSchedulePreview,
  parseReminderScheduleArgs,
} from '../agent/reminder-schedule.ts';
import type { AgentConnectedHostConfigReader } from '../agent/routine-schedule-promotion.ts';

type ReminderScheduleKind = 'at' | 'every' | 'cron';

export interface AgentReminderScheduleToolArgs {
  readonly message?: unknown;
  readonly scheduleKind?: unknown;
  readonly scheduleValue?: unknown;
  readonly timezone?: unknown;
  readonly name?: unknown;
  readonly provider?: unknown;
  readonly model?: unknown;
  readonly deliveryChannel?: unknown;
  readonly deliveryRoute?: unknown;
  readonly deliveryWebhook?: unknown;
  readonly deliveryLink?: unknown;
  readonly disabled?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
}

const SCHEDULE_KINDS: readonly ReminderScheduleKind[] = ['at', 'every', 'cron'];

function isScheduleKind(value: unknown): value is ReminderScheduleKind {
  return typeof value === 'string' && SCHEDULE_KINDS.includes(value as ReminderScheduleKind);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readOptionalString(value: unknown): string | null {
  const text = readString(value);
  return text ? text : null;
}

function readBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === 'yes';
}

function addOptionalArg(args: string[], flag: string, value: unknown): void {
  const text = readOptionalString(value);
  if (!text) return;
  args.push(flag, text);
}

function scheduleFlag(kind: ReminderScheduleKind): string {
  if (kind === 'cron') return '--cron';
  if (kind === 'every') return '--every';
  return '--at';
}

function buildReminderScheduleArgs(rawArgs: AgentReminderScheduleToolArgs): readonly string[] {
  const message = readOptionalString(rawArgs.message);
  const scheduleValue = readOptionalString(rawArgs.scheduleValue);
  if (!message) throw new Error('message is required.');
  if (!isScheduleKind(rawArgs.scheduleKind)) throw new Error('scheduleKind must be one of: at, every, cron.');
  if (!scheduleValue) throw new Error('scheduleValue is required.');

  const args = [
    scheduleFlag(rawArgs.scheduleKind),
    scheduleValue,
    '--message',
    message,
  ];
  addOptionalArg(args, '--timezone', rawArgs.timezone);
  addOptionalArg(args, '--name', rawArgs.name);
  addOptionalArg(args, '--provider', rawArgs.provider);
  addOptionalArg(args, '--model', rawArgs.model);
  addOptionalArg(args, '--delivery-channel', rawArgs.deliveryChannel);
  addOptionalArg(args, '--delivery-route', rawArgs.deliveryRoute);
  addOptionalArg(args, '--delivery-webhook', rawArgs.deliveryWebhook);
  addOptionalArg(args, '--delivery-link', rawArgs.deliveryLink);
  if (readBoolean(rawArgs.disabled)) args.push('--disabled');

  return args;
}

export function createAgentReminderScheduleTool(
  shellPaths: ShellPathService,
  configManager: AgentConnectedHostConfigReader,
  registry: ToolRegistry,
): Tool {
  return {
    definition: {
      name: 'agent_reminder_schedule',
      description: 'Schedule one GoodVibes Agent reminder under recorded effect admission.',
      parameters: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'Reminder text to deliver when the schedule fires.',
          },
          scheduleKind: {
            type: 'string',
            enum: [...SCHEDULE_KINDS],
            description: 'Schedule kind: at, every, or cron.',
          },
          scheduleValue: {
            type: 'string',
            description: 'ISO timestamp, interval, or cron expression matching scheduleKind.',
          },
          timezone: {
            type: 'string',
            description: 'Optional IANA timezone for cron/at schedules.',
          },
          name: {
            type: 'string',
            description: 'Optional connected schedule display name.',
          },
          provider: {
            type: 'string',
            description: 'Optional provider row id for reminder execution.',
          },
          model: {
            type: 'string',
            description: 'Optional model id for reminder execution.',
          },
          deliveryChannel: {
            type: 'string',
            description: 'Optional delivery channel target.',
          },
          deliveryRoute: {
            type: 'string',
            description: 'Optional connected route target: routeId:label.',
          },
          deliveryWebhook: {
            type: 'string',
            description: 'Optional http(s) webhook target.',
          },
          deliveryLink: {
            type: 'string',
            description: 'Optional link delivery target.',
          },
          disabled: {
            type: 'boolean',
            description: 'Create the schedule disabled.',
          },
          confirm: {
            type: 'boolean',
            description: 'Optional audit annotation; does not grant effect authority.',
          },
          explicitUserRequest: {
            type: 'string',
            description: 'Optional request provenance; does not grant effect authority.',
          },
        },
        required: ['message', 'scheduleKind', 'scheduleValue'],
        additionalProperties: false,
      },
      sideEffects: ['network', 'state'],
    },
    execute: async (rawArgs, options) => {
      try {
        const effect = captureScheduleEffect(rawArgs, options, shellPaths, configManager, registry);
        const parsed = parseReminderScheduleArgs(buildReminderScheduleArgs(rawArgs));
        if (parsed.errors.length > 0) return { success: false, error: parsed.errors.join('\n') };
        const preview = buildReminderSchedulePreview(parsed);
        effect.assertCurrent();
        const result = await effect.invoke('automation.schedules.create', preview.payload);
        effect.assertCurrent();
        return formatScheduleOperatorResult(result, 'Created GoodVibes schedule for Agent reminder');
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

export function registerAgentReminderScheduleTool(
  registry: ToolRegistry,
  shellPaths: ShellPathService,
  configManager: AgentConnectedHostConfigReader,
): void {
  registry.register(createAgentReminderScheduleTool(shellPaths, configManager, registry), { inputProjection: createScheduleInputProjector(shellPaths, configManager) });
}

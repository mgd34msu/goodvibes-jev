import { captureScheduleEffect, createScheduleInputProjector, formatScheduleOperatorResult } from './agent-schedule-effect.ts';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { ShellPathService } from '@/runtime/index.ts';
import {
  buildScheduleEditPreview,
  parseScheduleEditArgs,
  scheduleEditKindFromValue,
} from '../agent/schedule-edit.ts';
import type { AgentConnectedHostConfigReader } from '../agent/routine-schedule-promotion.ts';

export interface AgentScheduleEditToolArgs {
  readonly scheduleId?: unknown;
  readonly jobId?: unknown;
  readonly scheduleKind?: unknown;
  readonly scheduleValue?: unknown;
  readonly timezone?: unknown;
  readonly staggerMs?: unknown;
  readonly name?: unknown;
  readonly prompt?: unknown;
  readonly task?: unknown;
  readonly successCriteria?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readOptionalString(value: unknown): string | null {
  const text = readString(value);
  return text ? text : null;
}

function addOptionalArg(args: string[], flag: string, value: unknown): void {
  const text = readOptionalString(value);
  if (!text) return;
  args.push(flag, text);
}

function addOptionalNumber(args: string[], flag: string, value: unknown): void {
  if (value === undefined || value === null || value === '') return;
  if (typeof value === 'number') {
    args.push(flag, String(value));
    return;
  }
  addOptionalArg(args, flag, value);
}

function buildScheduleEditArgs(rawArgs: AgentScheduleEditToolArgs): readonly string[] {
  const scheduleId = readOptionalString(rawArgs.scheduleId) ?? readOptionalString(rawArgs.jobId);
  if (!scheduleId) throw new Error('scheduleId is required.');

  const args = [scheduleId];
  const scheduleKind = scheduleEditKindFromValue(rawArgs.scheduleKind);
  const scheduleValue = readOptionalString(rawArgs.scheduleValue);
  if (scheduleKind && !scheduleValue) throw new Error('scheduleValue is required when scheduleKind is set.');
  if (!scheduleKind && scheduleValue) throw new Error('scheduleKind is required when scheduleValue is set.');
  if (scheduleKind && scheduleValue) args.push(`--${scheduleKind}`, scheduleValue);

  addOptionalArg(args, '--timezone', rawArgs.timezone);
  addOptionalNumber(args, '--stagger-ms', rawArgs.staggerMs);
  addOptionalArg(args, '--name', rawArgs.name);
  addOptionalArg(args, '--prompt', rawArgs.prompt);
  addOptionalArg(args, '--task', rawArgs.task);
  addOptionalArg(args, '--success-criteria', rawArgs.successCriteria);
  addOptionalArg(args, '--explicit-user-request', rawArgs.explicitUserRequest);
  return args;
}

export function createAgentScheduleEditTool(
  shellPaths: ShellPathService,
  configManager: AgentConnectedHostConfigReader,
  registry: ToolRegistry,
): Tool {
  return {
    definition: {
      name: 'agent_schedule_edit',
      description: 'Edit one connected GoodVibes schedule under recorded effect admission.',
      parameters: {
        type: 'object',
        properties: {
          scheduleId: {
            type: 'string',
            description: 'Connected schedule id to edit.',
          },
          jobId: {
            type: 'string',
            description: 'Automation job id when known instead of scheduleId.',
          },
          scheduleKind: {
            type: 'string',
            enum: ['at', 'every', 'cron'],
            description: 'Optional replacement schedule kind.',
          },
          scheduleValue: {
            type: 'string',
            description: 'Replacement ISO time, interval, or cron expression.',
          },
          timezone: {
            type: 'string',
            description: 'Optional IANA timezone for cron replacements.',
          },
          staggerMs: {
            type: 'number',
            description: 'Optional cron stagger in milliseconds.',
          },
          name: {
            type: 'string',
            description: 'Optional replacement schedule display name.',
          },
          prompt: {
            type: 'string',
            description: 'Optional exact replacement prompt.',
          },
          task: {
            type: 'string',
            description: 'Optional replacement autonomous task.',
          },
          successCriteria: {
            type: 'string',
            description: 'Required with task; expected run outcome.',
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
        anyOf: [{ required: ['scheduleId'] }, { required: ['jobId'] }],
        additionalProperties: false,
      },
      sideEffects: ['network', 'state'],
    },
    execute: async (rawArgs, options) => {
      try {
        const effect = captureScheduleEffect(rawArgs, options, shellPaths, configManager, registry);
        const parsed = parseScheduleEditArgs(buildScheduleEditArgs(rawArgs), { requireExplicitUserRequest: false });
        if (parsed.errors.length > 0) return { success: false, error: parsed.errors.join('\n') };
        const preview = buildScheduleEditPreview(parsed);
        effect.assertCurrent();
        const result = await effect.invoke('automation.jobs.update', preview.payload);
        effect.assertCurrent();
        return formatScheduleOperatorResult(result, 'Updated GoodVibes schedule');
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

export function registerAgentScheduleEditTool(
  registry: ToolRegistry,
  shellPaths: ShellPathService,
  configManager: AgentConnectedHostConfigReader,
): void {
  registry.register(createAgentScheduleEditTool(shellPaths, configManager, registry), { inputProjection: createScheduleInputProjector(shellPaths, configManager) });
}

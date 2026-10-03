import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { ShellPathService } from '@/runtime/index.ts';
import {
  buildScheduleEditPreview,
  editConnectedSchedule,
  enrichScheduleEditPreviewFromConnectedHost,
  parseScheduleEditArgs,
  resolveScheduleEditConnectedHostConnection,
  scheduleEditKindFromValue,
  type ScheduleEditResult,
} from '../agent/schedule-edit.ts';
import {
  formatScheduleEditFailure,
  formatScheduleEditPreview,
  formatScheduleEditSuccess,
} from '../agent/schedule-edit-format.ts';
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

function readBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === 'yes';
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
  const explicitUserRequest = readOptionalString(rawArgs.explicitUserRequest);
  if (!scheduleId) throw new Error('scheduleId is required.');
  if (!explicitUserRequest) throw new Error('explicitUserRequest is required.');

  const args = [scheduleId, '--explicit-user-request', explicitUserRequest];
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
  if (readBoolean(rawArgs.confirm)) args.push('--yes');
  return args;
}

function outputForResult(result: ScheduleEditResult): { readonly success: boolean; readonly output?: string; readonly error?: string } {
  if (result.ok) {
    return {
      success: true,
      output: formatScheduleEditSuccess(result),
    };
  }
  return {
    success: false,
    error: formatScheduleEditFailure(result),
  };
}

function confirmationError(preview: ReturnType<typeof buildScheduleEditPreview>): string {
  return [
    formatScheduleEditPreview(preview),
    '',
    'Model tool confirmation required. Call this tool with confirm:true only when the user explicitly asked GoodVibes Agent to edit this exact schedule.',
    'Do not infer schedule edits from vague optimization, cleanup, or follow-up suggestions.',
  ].join('\n');
}

export function createAgentScheduleEditTool(
  shellPaths: ShellPathService,
  configManager: AgentConnectedHostConfigReader,
): Tool {
  return {
    definition: {
      name: 'agent_schedule_edit',
      description: 'Edit one confirmed connected GoodVibes schedule.',
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
            description: 'Required true only when user requested this edit.',
          },
          explicitUserRequest: {
            type: 'string',
            description: 'User request authorizing this schedule edit.',
          },
        },
        required: ['scheduleId', 'confirm', 'explicitUserRequest'],
        additionalProperties: false,
      },
      sideEffects: ['network', 'state'],
    },
    execute: async (rawArgs: unknown) => {
      try {
        const args = rawArgs as AgentScheduleEditToolArgs;
        const parsed = parseScheduleEditArgs(buildScheduleEditArgs(args));
        if (parsed.errors.length > 0) {
          return {
            success: false,
            error: parsed.errors.join('\n'),
          };
        }
        let preview = buildScheduleEditPreview(parsed);
        const connection = resolveScheduleEditConnectedHostConnection(configManager, shellPaths.homeDirectory);
        if (!parsed.yes) {
          preview = await enrichScheduleEditPreviewFromConnectedHost(connection, preview);
          return {
            success: false,
            error: confirmationError(preview),
          };
        }
        return outputForResult(await editConnectedSchedule(connection, preview));
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

export function registerAgentScheduleEditTool(
  registry: ToolRegistry,
  shellPaths: ShellPathService,
  configManager: AgentConnectedHostConfigReader,
): void {
  registry.register(createAgentScheduleEditTool(shellPaths, configManager));
}

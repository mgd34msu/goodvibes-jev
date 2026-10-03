import type { AgentWorkspaceActionResult, AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';
import { isAffirmative } from './agent-workspace-editors.ts';
import { quoteSlashCommandArg } from './slash-command-parser.ts';

type AgentWorkspaceFieldReader = (fieldId: string) => string;
type ReminderScheduleKind = 'cron' | 'every' | 'at';

export type AgentReminderScheduleEditorSubmission =
  | {
    readonly kind: 'editor';
    readonly editor: AgentWorkspaceLocalEditor;
    readonly status: string;
    readonly actionResult?: AgentWorkspaceActionResult;
  }
  | {
    readonly kind: 'dispatch';
    readonly command: string;
    readonly status: string;
    readonly actionResult: AgentWorkspaceActionResult;
  };

export function createReminderScheduleEditor(): AgentWorkspaceLocalEditor {
  return {
    kind: 'reminder-schedule',
    mode: 'create',
    title: 'Create Reminder',
    selectedFieldIndex: 0,
    message: 'Create one connected reminder schedule. Type yes on the final field to confirm.',
    fields: [
      { id: 'message', label: 'Reminder', value: '', required: true, multiline: true, hint: 'What should the Agent remind you about? Ctrl-J inserts a new line.' },
      { id: 'scheduleKind', label: 'Schedule type', value: 'at', required: true, multiline: false, hint: 'at, every, or cron.' },
      { id: 'scheduleValue', label: 'Schedule value', value: '', required: true, multiline: false, hint: 'Examples: 2026-06-01T09:00:00-05:00, 7d, or 0 9 * * *.' },
      { id: 'timezone', label: 'Timezone', value: '', required: false, multiline: false, hint: 'Optional IANA timezone for cron schedules, for example America/Chicago.' },
      { id: 'scheduleName', label: 'Schedule name', value: '', required: false, multiline: false, hint: 'Optional display name for the connected reminder.' },
      { id: 'deliveryChannel', label: 'Delivery channel', value: '', required: false, multiline: false, hint: 'Optional channel target, for example slack, slack:ops-alerts:Ops, or telephony:+15551234567.' },
      { id: 'disabled', label: 'Create disabled', value: 'no', required: false, multiline: false, hint: 'yes/no. Default no.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /schedule remind with --yes.' },
    ],
  };
}

export function buildAgentReminderScheduleEditorSubmission(
  editor: AgentWorkspaceLocalEditor,
  readField: AgentWorkspaceFieldReader,
  commandDispatchAvailable: boolean,
): AgentReminderScheduleEditorSubmission {
  const confirm = readField('confirm');
  if (!isAffirmative(confirm)) {
    return {
      kind: 'editor',
      editor: { ...editor, message: 'Type yes to confirm reminder schedule creation.' },
      status: 'Reminder schedule creation not confirmed.',
    };
  }

  const scheduleKind = readScheduleKind(readField('scheduleKind'));
  if (!scheduleKind) {
    const detail = 'Schedule type must be at, every, or cron.';
    return {
      kind: 'editor',
      editor: { ...editor, message: detail },
      status: detail,
      actionResult: {
        kind: 'error',
        title: 'Reminder schedule type invalid',
        detail,
      },
    };
  }

  if (!commandDispatchAvailable) {
    return {
      kind: 'editor',
      editor: { ...editor, message: 'Command dispatch is unavailable; cannot create a reminder from this workspace.' },
      status: 'Command dispatch unavailable.',
      actionResult: {
        kind: 'error',
        title: 'Command dispatch unavailable',
        detail: 'The reminder schedule command cannot be opened from this runtime.',
      },
    };
  }

  const parts = [
    '/schedule',
    'remind',
    '--message',
    quoteSlashCommandArg(readField('message')),
    `--${scheduleKind}`,
    quoteSlashCommandArg(readField('scheduleValue')),
  ];
  const timezone = readField('timezone');
  if (timezone.length > 0) parts.push('--timezone', quoteSlashCommandArg(timezone));
  const scheduleName = readField('scheduleName');
  if (scheduleName.length > 0) parts.push('--name', quoteSlashCommandArg(scheduleName));
  const deliveryChannel = readField('deliveryChannel');
  if (deliveryChannel.length > 0) parts.push('--delivery-channel', quoteSlashCommandArg(deliveryChannel));
  if (isOptionalAffirmative(readField('disabled'))) parts.push('--disabled');
  parts.push('--yes');
  const command = parts.join(' ');

  return {
    kind: 'dispatch',
    command,
    status: 'Opening reminder schedule creation.',
    actionResult: {
      kind: 'dispatched',
      title: 'Opening reminder schedule creation',
      detail: 'The workspace handed a confirmed reminder schedule command to the shell-owned command router.',
      command,
      safety: 'safe',
    },
  };
}

function readScheduleKind(value: string): ReminderScheduleKind | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'cron' || normalized === 'every' || normalized === 'at') return normalized;
  return null;
}

function isOptionalAffirmative(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === 'yes' || normalized === 'y' || normalized === 'true' || normalized === 'enabled' || normalized === 'on';
}

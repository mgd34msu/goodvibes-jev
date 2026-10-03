import type { AgentWorkspaceActionResult, AgentWorkspaceLocalEditor, AgentWorkspaceLocalLibraryItem } from './agent-workspace-types.ts';
import { isAffirmative } from './agent-workspace-editors.ts';
import { quoteSlashCommandArg } from './slash-command-parser.ts';

type AgentWorkspaceFieldReader = (fieldId: string) => string;
type RoutineScheduleKind = 'cron' | 'every' | 'at';

export type AgentRoutineScheduleEditorSubmission =
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

export function createRoutineScheduleEditor(
  selectedRoutine: AgentWorkspaceLocalLibraryItem | null,
): AgentWorkspaceLocalEditor {
  const selected = selectedRoutine ? `${selectedRoutine.id} (${selectedRoutine.name})` : 'No routine selected';
  return {
    kind: 'routine-schedule',
    mode: 'create',
    title: 'Promote Routine to Schedule',
    selectedFieldIndex: 0,
    message: `Create one connected schedule from a reviewed local routine. Selected: ${selected}. Type yes on the final field to confirm.`,
    fields: [
      { id: 'routineId', label: 'Routine id', value: selectedRoutine?.id ?? '', required: true, multiline: false, hint: 'Agent-local routine id to promote.' },
      { id: 'scheduleKind', label: 'Schedule type', value: 'cron', required: true, multiline: false, hint: 'cron, every, or at.' },
      { id: 'scheduleValue', label: 'Schedule value', value: '', required: true, multiline: false, hint: 'Examples: 0 9 * * *, 7d, or 2026-06-01T09:00:00-05:00.' },
      { id: 'timezone', label: 'Timezone', value: '', required: false, multiline: false, hint: 'Optional IANA timezone, for example America/Chicago.' },
      { id: 'scheduleName', label: 'Schedule name', value: selectedRoutine?.name ?? '', required: false, multiline: false, hint: 'Optional display name for the connected schedule.' },
      { id: 'deliveryChannel', label: 'Delivery channel', value: '', required: false, multiline: false, hint: 'Optional channel target, for example slack, slack:ops-alerts:Ops, or telephony:+15551234567.' },
      { id: 'disabled', label: 'Create disabled', value: 'no', required: false, multiline: false, hint: 'yes/no. Default no.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /schedule promote-routine with --yes.' },
    ],
  };
}

export function buildAgentRoutineScheduleEditorSubmission(
  editor: AgentWorkspaceLocalEditor,
  readField: AgentWorkspaceFieldReader,
  commandDispatchAvailable: boolean,
): AgentRoutineScheduleEditorSubmission {
  const confirm = readField('confirm');
  if (!isAffirmative(confirm)) {
    return {
      kind: 'editor',
      editor: { ...editor, message: 'Type yes to confirm routine schedule promotion.' },
      status: 'Routine schedule promotion not confirmed.',
    };
  }

  const scheduleKind = readScheduleKind(readField('scheduleKind'));
  if (!scheduleKind) {
    const detail = 'Schedule type must be cron, every, or at.';
    return {
      kind: 'editor',
      editor: { ...editor, message: detail },
      status: detail,
      actionResult: {
        kind: 'error',
        title: 'Routine schedule type invalid',
        detail,
      },
    };
  }

  if (!commandDispatchAvailable) {
    return {
      kind: 'editor',
      editor: { ...editor, message: 'Command dispatch is unavailable; cannot promote a routine from this workspace.' },
      status: 'Command dispatch unavailable.',
      actionResult: {
        kind: 'error',
        title: 'Command dispatch unavailable',
        detail: 'The routine schedule promotion command cannot be opened from this runtime.',
      },
    };
  }

  const parts = [
    '/schedule',
    'promote-routine',
    quoteSlashCommandArg(readField('routineId')),
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
    status: 'Opening routine schedule promotion.',
    actionResult: {
      kind: 'dispatched',
      title: 'Opening routine schedule promotion',
      detail: 'The workspace handed a confirmed routine schedule promotion command to the shell-owned command router.',
      command,
      safety: 'safe',
    },
  };
}

function readScheduleKind(value: string): RoutineScheduleKind | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'cron' || normalized === 'every' || normalized === 'at') return normalized;
  return null;
}

function isOptionalAffirmative(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === 'yes' || normalized === 'y' || normalized === 'true' || normalized === 'enabled' || normalized === 'on';
}

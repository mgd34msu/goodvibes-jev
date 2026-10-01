import type { AgentWorkspaceEditorKind, AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';
import type { AgentWorkspaceOperationsCommandEditorKind } from './agent-workspace-operations-command-editors.ts';
import { isAgentWorkspaceOperationsCommandEditorKind } from './agent-workspace-operations-command-editors.ts';
import { quoteSlashCommandArg } from './slash-command-parser.ts';
import type { AgentWorkspaceCommandEditorSubmission, AgentWorkspaceCommandSubmissionHandler, AgentWorkspaceFieldReader } from './agent-workspace-command-editor-engine.ts';
import { buildCommandEditorSubmissionFromTable, dispatchCommandEditorSubmission, editorMessageSubmission, isAffirmative } from './agent-workspace-command-editor-engine.ts';

export type AgentWorkspaceOperationsCommandEditorSubmission = AgentWorkspaceCommandEditorSubmission;

function unconfirmed(editor: AgentWorkspaceLocalEditor, message: string): AgentWorkspaceCommandEditorSubmission {
  return editorMessageSubmission(editor, message);
}

function optionalNoteArgs(value: string): string {
  const trimmed = value.trim();
  return trimmed ? ` --note ${quoteSlashCommandArg(trimmed)}` : '';
}

function optionalRememberArgs(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return isAffirmative(trimmed) ? ' --remember' : ' --no-remember';
}

function optionalCommandArg(flag: string, value: string): string {
  const trimmed = value.trim();
  return trimmed ? ` ${flag} ${quoteSlashCommandArg(trimmed)}` : '';
}

export function isAgentWorkspaceOperationsCommandSubmissionKind(kind: AgentWorkspaceEditorKind): kind is AgentWorkspaceOperationsCommandEditorKind {
  return isAgentWorkspaceOperationsCommandEditorKind(kind);
}

const OPERATIONS_COMMAND_SUBMISSION_HANDLERS: Readonly<Record<AgentWorkspaceOperationsCommandEditorKind, AgentWorkspaceCommandSubmissionHandler>> = {
  'plan-seed': (_editor, readField) => {
    const command = `/plan ${quoteSlashCommandArg(readField('goal'))}`;
    return dispatchCommandEditorSubmission(
      command,
      'Opening planning goal seeding',
      'The workspace handed a concrete planning goal to the shell-owned command router without creating coding-role Agent jobs.',
      'safe',
    );
  },
  'plan-approve': (editor, readField) => {
    if (!isAffirmative(readField('confirm'))) return unconfirmed(editor, 'Planning approval not confirmed. Type yes, then press Enter.');
    return dispatchCommandEditorSubmission(
      '/plan approve --yes',
      'Opening planning approval',
      'The workspace handed confirmed planning approval to the shell-owned command router.',
      'safe',
    );
  },
  'plan-override': (editor, readField) => {
    if (!isAffirmative(readField('confirm'))) return unconfirmed(editor, 'Planning strategy override not confirmed. Type yes, then press Enter.');
    return dispatchCommandEditorSubmission(
      `/plan override ${quoteSlashCommandArg(readField('strategy'))} --yes`,
      'Opening planning strategy override',
      'The workspace handed a confirmed planning strategy override to the shell-owned command router.',
      'safe',
    );
  },
  'plan-clear': (editor, readField) => {
    if (!isAffirmative(readField('confirm'))) return unconfirmed(editor, 'Planning clear not confirmed. Type yes, then press Enter.');
    return dispatchCommandEditorSubmission(
      '/plan clear --yes',
      'Opening planning clear',
      'The workspace handed confirmed planning-state clearing to the shell-owned command router.',
      'safe',
    );
  },
  'approval-approve': (editor, readField) => approvalAction(editor, readField),
  'approval-deny': (editor, readField) => approvalAction(editor, readField),
  'approval-cancel': (editor, readField) => approvalAction(editor, readField),
  'automation-job-run': (editor, readField) => automationAction(editor, readField),
  'automation-job-pause': (editor, readField) => automationAction(editor, readField),
  'automation-job-resume': (editor, readField) => automationAction(editor, readField),
  'automation-run-cancel': (editor, readField) => automationAction(editor, readField),
  'automation-run-retry': (editor, readField) => automationAction(editor, readField),
  'schedule-run': (editor, readField) => automationAction(editor, readField),
  'schedule-edit': (editor, readField) => {
    if (!isAffirmative(readField('confirm'))) return unconfirmed(editor, 'Schedule edit not confirmed. Type yes, then press Enter.');
    const scheduleKind = readField('scheduleKind').trim();
    const scheduleValue = readField('scheduleValue').trim();
    if ((scheduleKind && !scheduleValue) || (!scheduleKind && scheduleValue)) {
      return unconfirmed(editor, 'Schedule type and schedule value must be set together.');
    }
    const hasChange = Boolean(
      scheduleKind
      || readField('timezone').trim()
      || readField('scheduleName').trim()
      || readField('task').trim()
      || readField('successCriteria').trim()
      || readField('prompt').trim(),
    );
    if (!hasChange) return unconfirmed(editor, 'Schedule edit needs at least one changed field.');
    const task = readField('task').trim();
    const successCriteria = readField('successCriteria').trim();
    if ((task && !successCriteria) || (!task && successCriteria)) {
      return unconfirmed(editor, 'Task and success criteria must be set together.');
    }
    if (readField('prompt').trim() && task) {
      return unconfirmed(editor, 'Use either Exact prompt or Task, not both.');
    }
    const command = [
      '/schedule edit',
      quoteSlashCommandArg(readField('scheduleId')),
      scheduleKind && scheduleValue ? `--${scheduleKind} ${quoteSlashCommandArg(scheduleValue)}` : '',
      optionalCommandArg('--timezone', readField('timezone')).trim(),
      optionalCommandArg('--name', readField('scheduleName')).trim(),
      optionalCommandArg('--task', readField('task')).trim(),
      optionalCommandArg('--success-criteria', readField('successCriteria')).trim(),
      optionalCommandArg('--prompt', readField('prompt')).trim(),
      '--yes',
    ].filter(Boolean).join(' ');
    return dispatchCommandEditorSubmission(
      command,
      'Opening confirmed schedule edit',
      'The workspace handed an explicit connected-host schedule edit to the shell-owned command router.',
      'safe',
    );
  },
  'routine-receipt': (editor, readField) => receiptInspection(editor, readField),
  'schedule-receipt': (editor, readField) => receiptInspection(editor, readField),
  'health-repair': (editor, readField) => planApprovalHealthShow(editor, readField),
  'approval-review': (editor, readField) => planApprovalHealthShow(editor, readField),
  'plan-show': (editor, readField) => planApprovalHealthShow(editor, readField),
};

function approvalAction(editor: AgentWorkspaceLocalEditor, readField: AgentWorkspaceFieldReader): AgentWorkspaceCommandEditorSubmission {
  if (!isAffirmative(readField('confirm'))) return unconfirmed(editor, 'Approval action not confirmed. Type yes, then press Enter.');
  const verb = editor.kind.replace('approval-', '');
  const command = `/approval ${verb} ${quoteSlashCommandArg(readField('approvalId'))}${optionalNoteArgs(readField('note'))}${optionalRememberArgs(readField('remember'))} --yes`;
  const title = `${verb[0]?.toUpperCase() ?? ''}${verb.slice(1)} approval`;
  return dispatchCommandEditorSubmission(
    command,
    title,
    'The workspace handed an explicit confirmed approval action to the shell-owned command router.',
    'safe',
  );
}

function automationAction(editor: AgentWorkspaceLocalEditor, readField: AgentWorkspaceFieldReader): AgentWorkspaceCommandEditorSubmission {
  if (!isAffirmative(readField('confirm'))) return unconfirmed(editor, 'Automation action not confirmed. Type yes, then press Enter.');
  const command = editor.kind === 'automation-job-run'
    ? `/automation job run ${quoteSlashCommandArg(readField('jobId'))} --yes`
    : editor.kind === 'automation-job-pause'
      ? `/automation job pause ${quoteSlashCommandArg(readField('jobId'))} --yes`
      : editor.kind === 'automation-job-resume'
        ? `/automation job resume ${quoteSlashCommandArg(readField('jobId'))} --yes`
        : editor.kind === 'automation-run-cancel'
          ? `/automation run cancel ${quoteSlashCommandArg(readField('runId'))} --yes`
          : editor.kind === 'automation-run-retry'
            ? `/automation run retry ${quoteSlashCommandArg(readField('runId'))} --yes`
            : `/automation schedule run ${quoteSlashCommandArg(readField('scheduleId'))} --yes`;
  return dispatchCommandEditorSubmission(
    command,
    'Opening confirmed automation action',
    'The workspace handed an explicit connected-host automation action to the shell-owned command router.',
    'safe',
  );
}

function receiptInspection(editor: AgentWorkspaceLocalEditor, readField: AgentWorkspaceFieldReader): AgentWorkspaceCommandEditorSubmission {
  const routine = editor.kind === 'routine-receipt';
  const command = `/${routine ? 'routines' : 'schedule'} receipt ${quoteSlashCommandArg(readField('receiptId'))}`;
  const title = routine ? 'Opening routine receipt' : 'Opening schedule receipt';
  return dispatchCommandEditorSubmission(
    command,
    title,
    routine
      ? 'The workspace handed read-only routine receipt inspection to the shell-owned command router.'
      : 'The workspace handed read-only schedule receipt inspection to the shell-owned command router.',
    'read-only',
  );
}

function planApprovalHealthShow(editor: AgentWorkspaceLocalEditor, readField: AgentWorkspaceFieldReader): AgentWorkspaceCommandEditorSubmission {
  const plan = editor.kind === 'plan-show';
  const approval = editor.kind === 'approval-review';
  const command = plan
    ? `/plan show ${quoteSlashCommandArg(readField('planId'))}`
    : approval
      ? `/approval review ${quoteSlashCommandArg(readField('kind'))}`
      : `/health repair ${quoteSlashCommandArg(readField('domain'))}`;
  const title = plan ? 'Opening saved plan' : approval ? 'Opening approval review' : 'Opening health repair guidance';
  return dispatchCommandEditorSubmission(
    command,
    title,
    plan
      ? 'The workspace handed read-only saved-plan inspection to the shell-owned command router.'
      : approval
        ? 'The workspace handed read-only approval class review to the shell-owned command router.'
        : 'The workspace handed read-only health repair guidance to the shell-owned command router.',
    'read-only',
  );
}

export function buildAgentWorkspaceOperationsCommandEditorSubmission(
  editor: AgentWorkspaceLocalEditor,
  readField: AgentWorkspaceFieldReader,
): AgentWorkspaceCommandEditorSubmission {
  return buildCommandEditorSubmissionFromTable(
    editor.kind as AgentWorkspaceOperationsCommandEditorKind,
    editor,
    readField,
    OPERATIONS_COMMAND_SUBMISSION_HANDLERS,
  );
}

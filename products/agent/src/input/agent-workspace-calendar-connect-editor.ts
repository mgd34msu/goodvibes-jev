/**
 * Calendar connect card, promotes the "Calendar workflows" workspace
 * card from a dead guidance card into a real, dispatchable action.
 *
 * GROUNDED: unlike email, there is no external calendar account/CalDAV
 * connector anywhere in this codebase (no config schema, no credential path,
 * no service, /calendar is a purely local .ics-backed event store,
 * src/agent/calendar-registry.ts + src/input/commands/calendar-runtime.ts).
 * Building a credential-capturing "connect wizard" for a service that does
 * not exist would repeat exactly the dogfood finding this brief fixes
 * (advertising a capability that isn't dispatchable). The honest promotion
 * is: a real stepped form that adds a LOCAL calendar event through the
 * existing, already-safe /calendar add command, no credentials involved,
 * with the card's own wording stating plainly that this is local-only.
 *
 * This follows the ordinary generic command-editor pattern (like
 * agent-workspace-reminder-schedule-editor.ts): build one command string,
 * dispatch it through the shell-owned command router. No secret ever touches
 * this path, so the command-string leak class documented in
 * agent-workspace-email-connect-editor.ts does not apply here.
 */
import type { AgentWorkspaceActionResult, AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';
import { isAffirmative } from './agent-workspace-editors.ts';
import { quoteSlashCommandArg } from './slash-command-parser.ts';

type FieldReader = (fieldId: string) => string;

export type AgentCalendarConnectEditorSubmission =
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

export function createCalendarConnectEditor(): AgentWorkspaceLocalEditor {
  return {
    kind: 'calendar-connect',
    mode: 'create',
    title: 'Add Calendar Event',
    selectedFieldIndex: 0,
    message: 'No external calendar account is connected in this build (no CalDAV/Google/Outlook sync), this adds an event to your local Agent calendar. Type yes on the final field to confirm.',
    fields: [
      { id: 'title', label: 'Title', value: '', required: true, multiline: false, hint: 'Event title.' },
      { id: 'start', label: 'Start', value: '', required: true, multiline: false, hint: 'ISO date or datetime, for example 2026-08-01T09:00:00-05:00.' },
      { id: 'end', label: 'End', value: '', required: false, multiline: false, hint: 'Optional ISO end date or datetime.' },
      { id: 'location', label: 'Location', value: '', required: false, multiline: false, hint: 'Optional location.' },
      { id: 'notes', label: 'Notes', value: '', required: false, multiline: true, hint: 'Optional notes. Ctrl-J inserts a new line.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /calendar add with --yes.' },
    ],
  };
}

export function buildAgentWorkspaceCalendarConnectEditorSubmission(
  editor: AgentWorkspaceLocalEditor,
  readField: FieldReader,
  commandDispatchAvailable: boolean,
): AgentCalendarConnectEditorSubmission {
  if (!isAffirmative(readField('confirm'))) {
    return {
      kind: 'editor',
      editor: { ...editor, message: 'Type yes to confirm adding this calendar event.' },
      status: 'Calendar event not confirmed.',
    };
  }
  if (!commandDispatchAvailable) {
    const detail = 'Command dispatch is unavailable; cannot add a calendar event from this workspace.';
    return {
      kind: 'editor',
      editor: { ...editor, message: detail },
      status: detail,
      actionResult: { kind: 'error', title: 'Command dispatch unavailable', detail, safety: 'safe' },
    };
  }

  const title = readField('title').trim();
  const start = readField('start').trim();
  if (!title || !start) {
    const detail = 'Title and start are required.';
    return {
      kind: 'editor',
      editor: { ...editor, message: detail },
      status: detail,
      actionResult: { kind: 'error', title: 'Calendar event incomplete', detail, safety: 'safe' },
    };
  }

  const parts = ['/calendar', 'add', '--title', quoteSlashCommandArg(title), '--start', quoteSlashCommandArg(start)];
  const end = readField('end').trim();
  if (end.length > 0) parts.push('--end', quoteSlashCommandArg(end));
  const location = readField('location').trim();
  if (location.length > 0) parts.push('--location', quoteSlashCommandArg(location));
  const notes = readField('notes').trim();
  if (notes.length > 0) parts.push('--notes', quoteSlashCommandArg(notes));
  parts.push('--yes');
  const command = parts.join(' ');

  return {
    kind: 'dispatch',
    command,
    status: 'Adding calendar event.',
    actionResult: {
      kind: 'dispatched',
      title: 'Adding calendar event',
      detail: 'The workspace handed a confirmed local calendar event command to the shell-owned command router. This is a local calendar only, no external account is connected.',
      command,
      safety: 'safe',
    },
  };
}

/**
 * Calendar connect card editor tests.
 *
 * Unlike email, there is no external calendar credential path anywhere in
 * this codebase (grounded: no CalDAV config schema, no connector, only the
 * local .ics-backed /calendar command). This editor is the honest promotion
 * of the dead "Calendar workflows" guidance card into a real dispatchable
 * action that adds a LOCAL event through the existing /calendar add command
 *, the generic command-editor dispatch pipeline (build a command string,
 * hand it to the shell-owned router), same shape as reminder-schedule.
 */
import { describe, expect, test } from 'bun:test';
import {
  createCalendarConnectEditor,
  buildAgentWorkspaceCalendarConnectEditorSubmission,
} from '../../input/agent-workspace-calendar-connect-editor.ts';

function fieldReaderFrom(fields: Record<string, string>): (id: string) => string {
  return (id: string) => fields[id] ?? '';
}

describe('createCalendarConnectEditor', () => {
  test('states plainly that no external calendar account is connected', () => {
    const editor = createCalendarConnectEditor();
    expect(editor.kind).toBe('calendar-connect');
    expect(editor.message).toContain('No external calendar account is connected');
    expect(editor.message.toLowerCase()).toContain('local');
  });

  test('has the expected event fields', () => {
    const editor = createCalendarConnectEditor();
    expect(editor.fields.map((f) => f.id)).toEqual(['title', 'start', 'end', 'location', 'notes', 'confirm']);
  });
});

describe('buildAgentWorkspaceCalendarConnectEditorSubmission', () => {
  const editor = createCalendarConnectEditor();

  test('not confirmed: stays open, no dispatch', () => {
    const result = buildAgentWorkspaceCalendarConnectEditorSubmission(
      editor, fieldReaderFrom({ title: 'Standup', start: '2026-08-01T09:00:00-05:00', confirm: 'no' }), true,
    );
    expect(result.kind).toBe('editor');
  });

  test('missing title/start: honest error, no dispatch', () => {
    const result = buildAgentWorkspaceCalendarConnectEditorSubmission(
      editor, fieldReaderFrom({ title: '', start: '', confirm: 'yes' }), true,
    );
    expect(result.kind).toBe('editor');
    if (result.kind === 'editor') {
      expect(result.actionResult?.kind).toBe('error');
    }
  });

  test('command dispatch unavailable: honest error naming the limitation', () => {
    const result = buildAgentWorkspaceCalendarConnectEditorSubmission(
      editor, fieldReaderFrom({ title: 'Standup', start: '2026-08-01T09:00:00-05:00', confirm: 'yes' }), false,
    );
    expect(result.kind).toBe('editor');
    if (result.kind === 'editor') {
      expect(result.actionResult?.detail).toContain('unavailable');
    }
  });

  test('valid submission: dispatches a real /calendar add command with quoted args and --yes', () => {
    const result = buildAgentWorkspaceCalendarConnectEditorSubmission(
      editor,
      fieldReaderFrom({
        title: 'Team standup',
        start: '2026-08-01T09:00:00-05:00',
        end: '2026-08-01T09:30:00-05:00',
        location: 'Zoom',
        notes: 'Weekly sync',
        confirm: 'yes',
      }),
      true,
    );
    expect(result.kind).toBe('dispatch');
    if (result.kind === 'dispatch') {
      expect(result.command).toStartWith('/calendar add ');
      expect(result.command).toContain('--title');
      expect(result.command).toContain('Team standup');
      expect(result.command).toContain('--start');
      expect(result.command).toContain('--end');
      expect(result.command).toContain('--location');
      expect(result.command).toContain('--notes');
      expect(result.command).toEndWith('--yes');
      // The card's own honesty: no credentials or external account involved
      expect(result.actionResult.detail).toContain('local calendar only');
    }
  });

  test('optional fields omitted when blank', () => {
    const result = buildAgentWorkspaceCalendarConnectEditorSubmission(
      editor, fieldReaderFrom({ title: 'Solo event', start: '2026-08-01T09:00:00-05:00', confirm: 'yes' }), true,
    );
    expect(result.kind).toBe('dispatch');
    if (result.kind === 'dispatch') {
      expect(result.command).not.toContain('--end');
      expect(result.command).not.toContain('--location');
      expect(result.command).not.toContain('--notes');
    }
  });
});

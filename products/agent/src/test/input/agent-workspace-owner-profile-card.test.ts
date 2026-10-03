/**
 * The Your Profile workspace card.
 *
 * The four things the verbs expose have to be reachable from the screen he
 * actually looks at: read what is there, correct a field, delete a fact, see
 * where a fact came from. This drives each card through the real workspace,
 * open the category, select the action, activate it, fill the fields, submit,
 * and asserts on the command that reaches the shell-owned router.
 *
 * Two rules get their own tests because they are the ones a later edit could
 * quietly lose: a People line is not reachable without the words he used that
 * pointed at that person (docs/owner-profile.md §10), and neither mutating card
 * dispatches anything without confirmation.
 */

import { describe, expect, test } from 'bun:test';
import { AGENT_WORKSPACE_CATEGORIES } from '../../input/agent-workspace-categories.ts';
import { AgentWorkspace } from '../../input/agent-workspace.ts';
import { buildAgentWorkspaceCommandEditorSubmission } from '../../input/agent-workspace-command-editor.ts';
import { createAgentWorkspaceEditor } from '../../input/agent-workspace-activation.ts';
import type { AgentWorkspaceEditorKind, AgentWorkspaceLocalEditor } from '../../input/agent-workspace-types.ts';
import type { CommandContext } from '../../input/command-registry.ts';

function commandContext(): CommandContext {
  return { executeCommand: async () => true, print: () => {} } as unknown as CommandContext;
}

function openCard(kind: AgentWorkspaceEditorKind): AgentWorkspaceLocalEditor {
  const editor = createAgentWorkspaceEditor(kind, {
    runtimeStarterTemplates: [],
    selectedRoutine: null,
    recentReviewerHandoffArtifacts: [],
    reviewPacketDefaults: null,
    emailConnectStatus: null,
    calendarOAuthConfigStatus: null,
  });
  if (!editor) throw new Error(`no editor for ${kind}`);
  return editor;
}

function submit(kind: AgentWorkspaceEditorKind, values: Readonly<Record<string, string>>) {
  const editor = openCard(kind);
  // Both dispatch routes available: this suite is about what the card BUILDS,
  // not about how the shell degrades when a router is missing.
  return buildAgentWorkspaceCommandEditorSubmission(editor, (fieldId) => values[fieldId] ?? '', true, true);
}

describe('Your Profile workspace card', () => {
  test('the category exists and offers the four things the verbs expose', () => {
    const category = AGENT_WORKSPACE_CATEGORIES.find((entry) => entry.id === 'owner-profile');
    expect(category, 'the owner-profile category is missing from the workspace').toBeTruthy();
    expect(category?.label).toBe('Your Profile');
    const editorKinds = (category?.actions ?? []).map((action) => action.editorKind).filter(Boolean);
    // read what is there / correct a field / delete a fact / see provenance
    expect(editorKinds).toContain('owner-profile-read');
    expect(editorKinds).toContain('owner-profile-set');
    expect(editorKinds).toContain('owner-profile-forget');
    expect(editorKinds).toContain('owner-profile-provenance');
  });

  test('every card opens a real editor with fields from the live workspace', () => {
    const workspace = new AgentWorkspace();
    const category = AGENT_WORKSPACE_CATEGORIES.find((entry) => entry.id === 'owner-profile');
    for (const action of category?.actions ?? []) {
      if (action.kind !== 'editor') continue;
      workspace.open(commandContext(), () => {}, 'owner-profile');
      workspace.selectedActionIndex = workspace.actions.findIndex((entry) => entry.id === action.id);
      expect(workspace.selectedActionIndex, `${action.id} is not visible in the card`).toBeGreaterThanOrEqual(0);
      workspace.activateSelected();
      expect(workspace.localEditor?.kind, `${action.id} opened the wrong editor`).toBe(action.editorKind);
      expect((workspace.localEditor?.fields ?? []).length, `${action.id} opened an editor with no fields`).toBeGreaterThan(0);
    }
  });
});

describe('Your Profile card: reading', () => {
  test('read dispatches the profile read once confirmed', () => {
    const submission = submit('owner-profile-read', { confirm: 'yes' });
    expect(submission.kind).toBe('dispatch');
    if (submission.kind !== 'dispatch') return;
    expect(submission.command).toBe('/owner-profile read');
    expect(submission.actionResult.safety).toBe('read-only');
  });

  test('one field and its provenance are separate, both read-only', () => {
    const field = submit('owner-profile-get', { fieldId: 'location.timezone' });
    expect(field.kind).toBe('dispatch');
    if (field.kind === 'dispatch') expect(field.command).toBe('/owner-profile get location.timezone');

    const provenance = submit('owner-profile-provenance', { fieldId: 'commerce.shippingAddress' });
    expect(provenance.kind).toBe('dispatch');
    if (provenance.kind === 'dispatch') {
      expect(provenance.command).toBe('/owner-profile provenance commerce.shippingAddress');
      expect(provenance.actionResult.safety).toBe('read-only');
    }
  });

  test('status is offered and never carries a value', () => {
    const submission = submit('owner-profile-status', { confirm: 'yes' });
    expect(submission.kind).toBe('dispatch');
    if (submission.kind !== 'dispatch') return;
    expect(submission.command).toBe('/owner-profile status');
    expect(submission.actionResult.detail).toContain('never returns a value');
  });
});

describe('Your Profile card: third-party containment', () => {
  test('a person is not reachable without the words that pointed at them', () => {
    const submission = submit('owner-profile-person', { name: 'Sarah' });
    // Held at the card. Nothing is dispatched, so nothing about Sarah reaches
    // the transcript a later turn could compose from.
    expect(submission.kind).toBe('editor');
    if (submission.kind !== 'editor') return;
    expect(submission.editor.message).toContain('Say what pointed at this person');
  });

  test('naming them lets the lookup through', () => {
    const submission = submit('owner-profile-person', {
      name: 'Sarah',
      namedBy: 'email my sister the tickets',
    });
    expect(submission.kind).toBe('dispatch');
    if (submission.kind !== 'dispatch') return;
    expect(submission.command).toBe('/owner-profile person Sarah --named-by "email my sister the tickets"');
    expect(submission.actionResult.detail).toContain('no call that lists everyone');
  });

  test('the read card says the People section is counted, not listed', () => {
    const editor = openCard('owner-profile-read');
    expect(editor.message).toContain('People section is counted rather than listed');
  });
});

describe('Your Profile card: correcting and forgetting', () => {
  test('a correction carries his words verbatim when he supplies them', () => {
    const submission = submit('owner-profile-set', {
      fieldId: 'commerce.shippingAddress',
      value: '200 Office Way',
      said: 'ship it to my office instead',
      confirm: 'yes',
    });
    expect(submission.kind).toBe('dispatch');
    if (submission.kind !== 'dispatch') return;
    expect(submission.command).toBe(
      '/owner-profile set commerce.shippingAddress "200 Office Way" --said "ship it to my office instead" --yes',
    );
  });

  test('a correction with no words omits --said, so the handler records the edit honestly', () => {
    const submission = submit('owner-profile-set', {
      fieldId: 'location.timezone',
      value: 'America/Detroit',
      confirm: 'yes',
    });
    expect(submission.kind).toBe('dispatch');
    if (submission.kind !== 'dispatch') return;
    expect(submission.command).toBe('/owner-profile set location.timezone America/Detroit --yes');
    expect(submission.command).not.toContain('--said');
  });

  test('forget deletes the line and its kept history, once confirmed', () => {
    const submission = submit('owner-profile-forget', { fieldId: 'contact.phone', confirm: 'yes' });
    expect(submission.kind).toBe('dispatch');
    if (submission.kind !== 'dispatch') return;
    expect(submission.command).toBe('/owner-profile forget contact.phone --yes');
    expect(submission.actionResult.detail).toContain('nothing is tombstoned');
  });

  test('the note card names a line by its content, and says why', () => {
    const submission = submit('owner-profile-forget-note', {
      section: 'Notes',
      text: 'Allergic to shellfish',
      confirm: 'yes',
    });
    expect(submission.kind).toBe('dispatch');
    if (submission.kind !== 'dispatch') return;
    expect(submission.command).toBe('/owner-profile forget --section Notes --text "Allergic to shellfish" --yes');
    expect(submission.command).not.toContain('--line');
    expect(submission.actionResult.detail).toContain('named by its content');

    const editor = openCard('owner-profile-forget-note');
    expect(editor.message).toContain('never by their position');
  });

  test('neither mutating card dispatches without confirmation', () => {
    const set = submit('owner-profile-set', { fieldId: 'contact.phone', value: '555' });
    expect(set.kind).toBe('editor');
    if (set.kind === 'editor') expect(set.editor.message).toContain('not confirmed');

    const forget = submit('owner-profile-forget', { fieldId: 'contact.phone' });
    expect(forget.kind).toBe('editor');
    if (forget.kind === 'editor') expect(forget.editor.message).toContain('not confirmed');

    const forgetNote = submit('owner-profile-forget-note', { section: 'Notes', text: 'Allergic to shellfish' });
    expect(forgetNote.kind).toBe('editor');
    if (forgetNote.kind === 'editor') expect(forgetNote.editor.message).toContain('not confirmed');
  });
});

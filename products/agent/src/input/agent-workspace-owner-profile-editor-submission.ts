/**
 * Turning a filled owner-profile card into an `/owner-profile` command.
 *
 * Same two-stage shape as every other card family here: the editor collects
 * fields, this builds the slash command and hands it to the shell-owned router.
 * The command is the same one the top-level CLI runs, so a card and a shell can
 * never answer differently.
 *
 * `namedBy` on the person card is checked here but NOT sent: the verb takes a
 * name and nothing else, and inventing a parameter the daemon does not have
 * would be a fake gate. It is a real gate at this layer, the card will not
 * dispatch without it, and it stays local rather than pretending to be
 * enforced downstream (docs/owner-profile.md §10).
 */

import type { AgentWorkspaceEditorKind, AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';
import { quoteSlashCommandArg } from './slash-command-parser.ts';
import type { AgentWorkspaceOwnerProfileEditorKind } from './agent-workspace-owner-profile-editors.ts';
import { isAgentWorkspaceOwnerProfileEditorKind } from './agent-workspace-owner-profile-editors.ts';
import type {
  AgentWorkspaceCommandEditorSubmission,
  AgentWorkspaceCommandSubmissionHandler,
  AgentWorkspaceFieldReader,
} from './agent-workspace-command-editor-engine.ts';
import {
  appendOptionalArg,
  buildCommandEditorSubmissionFromTable,
  dispatchCommandEditorSubmission,
  editorMessageSubmission,
  isAffirmative,
} from './agent-workspace-command-editor-engine.ts';

export type AgentWorkspaceOwnerProfileEditorSubmission = AgentWorkspaceCommandEditorSubmission;

export function isAgentWorkspaceOwnerProfileSubmissionKind(
  kind: AgentWorkspaceEditorKind,
): kind is AgentWorkspaceOwnerProfileEditorKind {
  return isAgentWorkspaceOwnerProfileEditorKind(kind);
}

function unconfirmed(editor: AgentWorkspaceLocalEditor, label: string): AgentWorkspaceCommandEditorSubmission {
  return editorMessageSubmission(editor, `${label} not confirmed. Type yes, then press Enter.`, `${label} not confirmed.`);
}

function requireConfirmation(
  editor: AgentWorkspaceLocalEditor,
  readField: AgentWorkspaceFieldReader,
  label: string,
): AgentWorkspaceCommandEditorSubmission | null {
  return isAffirmative(readField('confirm')) ? null : unconfirmed(editor, label);
}

const OWNER_PROFILE_SUBMISSION_HANDLERS: Readonly<
  Record<AgentWorkspaceOwnerProfileEditorKind, AgentWorkspaceCommandSubmissionHandler>
> = {
  'owner-profile-read': (editor, readField) => {
    const confirmation = requireConfirmation(editor, readField, 'Profile read');
    if (confirmation) return confirmation;
    return dispatchCommandEditorSubmission(
      '/owner-profile read',
      'Opening your profile',
      'The workspace handed a profile read to the shell-owned command router. The People section is counted, not listed.',
      'read-only',
    );
  },
  'owner-profile-get': (_editor, readField) => dispatchCommandEditorSubmission(
    `/owner-profile get ${quoteSlashCommandArg(readField('fieldId'))}`,
    'Opening one profile field',
    'The workspace handed a single-field profile read to the shell-owned command router.',
    'read-only',
  ),
  'owner-profile-person': (editor, readField) => {
    // The whole point of the card's second field. Without his words pointing at
    // someone, no People line is reachable from here at all.
    if (readField('namedBy').trim().length === 0) {
      return editorMessageSubmission(
        editor,
        'Say what pointed at this person before looking them up, the words you used, e.g. "email my sister the tickets".',
        'Person lookup needs the words that named them.',
      );
    }
    return dispatchCommandEditorSubmission(
      `/owner-profile person ${quoteSlashCommandArg(readField('name'))} --named-by ${quoteSlashCommandArg(readField('namedBy'))}`,
      'Looking up one person',
      'The workspace handed a single-person profile lookup to the shell-owned command router. There is no call that lists everyone.',
      'read-only',
    );
  },
  'owner-profile-provenance': (_editor, readField) => dispatchCommandEditorSubmission(
    `/owner-profile provenance ${quoteSlashCommandArg(readField('fieldId'))}`,
    'Tracing where a fact came from',
    'The workspace handed a profile provenance lookup to the shell-owned command router.',
    'read-only',
  ),
  'owner-profile-set': (editor, readField) => {
    const confirmation = requireConfirmation(editor, readField, 'Profile write');
    if (confirmation) return confirmation;
    const parts = ['/owner-profile', 'set', quoteSlashCommandArg(readField('fieldId')), quoteSlashCommandArg(readField('value'))];
    appendOptionalArg(parts, '--said', readField('said'));
    parts.push('--yes');
    return dispatchCommandEditorSubmission(
      parts.join(' '),
      'Correcting a profile field',
      'The workspace handed a confirmed profile write to the shell-owned command router. Any previous value is kept as history, so this is reversible.',
      'safe',
    );
  },
  'owner-profile-forget': (editor, readField) => {
    const confirmation = requireConfirmation(editor, readField, 'Profile deletion');
    if (confirmation) return confirmation;
    return dispatchCommandEditorSubmission(
      `/owner-profile forget ${quoteSlashCommandArg(readField('fieldId'))} --yes`,
      'Forgetting a profile fact',
      'The workspace handed a confirmed profile deletion to the shell-owned command router. The line and its kept history go; nothing is tombstoned.',
      'safe',
    );
  },
  'owner-profile-forget-note': (editor, readField) => {
    const confirmation = requireConfirmation(editor, readField, 'Note deletion');
    if (confirmation) return confirmation;
    return dispatchCommandEditorSubmission(
      `/owner-profile forget --section ${quoteSlashCommandArg(readField('section'))} --text ${quoteSlashCommandArg(readField('text'))} --yes`,
      'Forgetting one line',
      'The workspace handed a confirmed prose-line deletion to the shell-owned command router. The line is named by its content, so a line that has since changed is not deleted by mistake.',
      'safe',
    );
  },
  'owner-profile-status': (editor, readField) => {
    const confirmation = requireConfirmation(editor, readField, 'Profile status');
    if (confirmation) return confirmation;
    return dispatchCommandEditorSubmission(
      '/owner-profile status',
      'Opening profile status',
      'The workspace handed a profile status read to the shell-owned command router. Status never returns a value.',
      'read-only',
    );
  },
};

export function buildAgentWorkspaceOwnerProfileEditorSubmission(
  editor: AgentWorkspaceLocalEditor,
  readField: AgentWorkspaceFieldReader,
): AgentWorkspaceOwnerProfileEditorSubmission {
  if (!isAgentWorkspaceOwnerProfileEditorKind(editor.kind)) {
    return editorMessageSubmission(editor, `No owner-profile card exists for ${editor.kind}.`);
  }
  return buildCommandEditorSubmissionFromTable(
    editor.kind,
    editor,
    readField,
    OWNER_PROFILE_SUBMISSION_HANDLERS,
  );
}

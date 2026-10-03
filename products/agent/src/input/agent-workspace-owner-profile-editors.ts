/**
 * The workspace cards for the owner profile, what the platform knows about him.
 *
 * Seven editors covering the four things the verbs expose and he will actually
 * want: read what is there, look one field up, see where a fact came from,
 * correct a field, forget one, look one person up by name, and check whether
 * the file loaded at all.
 *
 * Two things are deliberate.
 *
 * **The People section is counted here, not listed.** The card is on screen
 * inside a session, so its output is in the transcript a later turn composes
 * from, the same reason `profile.read` is barred from a composition path
 * (docs/owner-profile.md §10). `owner-profile-person` is the way through, and it
 * asks for the words he used that pointed at that person before it will run.
 * That field is not decoration: it is what makes "he named them" a fact about
 * the instruction rather than a judgement the model makes about relevance.
 *
 * **Correcting a field asks for his words.** `said` is what answers "where did
 * you get that" later, so the set card has a field for it and offers the
 * settings-edit stand-in only when he leaves it blank. Both mutating cards
 * carry a confirm field, like every other mutating card in this workspace.
 */

import type { AgentWorkspaceEditorKind, AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';
import type { AgentWorkspaceEditorSpecEntry } from './agent-workspace-command-editor-engine.ts';
import { createAgentWorkspaceEditorFromTable } from './agent-workspace-command-editor-engine.ts';

export type AgentWorkspaceOwnerProfileEditorKind = Extract<
  AgentWorkspaceEditorKind,
  | 'owner-profile-read'
  | 'owner-profile-get'
  | 'owner-profile-person'
  | 'owner-profile-provenance'
  | 'owner-profile-set'
  | 'owner-profile-forget'
  | 'owner-profile-forget-note'
  | 'owner-profile-status'
>;

export function isAgentWorkspaceOwnerProfileEditorKind(
  kind: AgentWorkspaceEditorKind,
): kind is AgentWorkspaceOwnerProfileEditorKind {
  return kind === 'owner-profile-read'
    || kind === 'owner-profile-get'
    || kind === 'owner-profile-person'
    || kind === 'owner-profile-provenance'
    || kind === 'owner-profile-set'
    || kind === 'owner-profile-forget'
    || kind === 'owner-profile-forget-note'
    || kind === 'owner-profile-status';
}

const OWNER_PROFILE_EDITOR_SPECS: Readonly<
  Record<AgentWorkspaceOwnerProfileEditorKind, AgentWorkspaceEditorSpecEntry<AgentWorkspaceOwnerProfileEditorKind>>
> = {
  'owner-profile-read': {
    mode: 'create',
    title: 'What GoodVibes Knows About You',
    selectedFieldIndex: 0,
    message: 'Print your whole profile, section by section, with the surface, date and your own words on every line it learned. The People section is counted rather than listed, look one person up by name instead. The file is yours: you can open and edit it by hand at any time, and your edits win.',
    fields: [
      { id: 'confirm', label: 'Show it', value: 'yes', required: true, multiline: false, hint: 'Type yes to print the profile here.' },
    ],
  },
  'owner-profile-get': {
    mode: 'create',
    title: 'Show One Profile Field',
    selectedFieldIndex: 0,
    message: 'Print one field with its provenance. A field you have not set says so rather than inventing a value, and a value that did not parse comes back exactly as written with the reason.',
    fields: [
      { id: 'fieldId', label: 'Field id', value: '', required: true, multiline: false, hint: 'For example location.timezone, contact.email, commerce.shippingAddress.' },
    ],
  },
  'owner-profile-person': {
    mode: 'create',
    title: 'Look Up One Person',
    selectedFieldIndex: 0,
    message: 'Show what your profile records about one person, by name. There is no call that lists everyone: a People line reaches a turn only because you pointed at that person, which is why the second field is required.',
    fields: [
      { id: 'name', label: 'Name', value: '', required: true, multiline: false, hint: 'One person, by the name you use for them.' },
      { id: 'namedBy', label: 'Your words', value: '', required: true, multiline: false, hint: 'What you said that pointed at this person, e.g. "email my sister the tickets".' },
    ],
  },
  'owner-profile-provenance': {
    mode: 'create',
    title: 'Where Did You Get That',
    selectedFieldIndex: 0,
    message: 'Trace one field: which surface recorded it, when, and your exact words at the time, plus every earlier value still kept, so a wrong correction can be put back. A line you typed yourself reports no provenance rather than being dressed up as a recorded source.',
    fields: [
      { id: 'fieldId', label: 'Field id', value: '', required: true, multiline: false, hint: 'For example commerce.shippingAddress.' },
    ],
  },
  'owner-profile-set': {
    mode: 'update',
    title: 'Correct A Profile Field',
    selectedFieldIndex: 0,
    message: 'Write or correct one field. Any previous value moves into a kept history comment, so this is reversible. Leave your words blank and the line records that you edited it here.',
    fields: [
      { id: 'fieldId', label: 'Field id', value: '', required: true, multiline: false, hint: 'For example location.timezone, commerce.shippingAddress.' },
      { id: 'value', label: 'Value', value: '', required: true, multiline: false, hint: 'The value to record, written the way you want it to read.' },
      { id: 'said', label: 'Your words', value: '', required: false, multiline: false, hint: 'Optional. What you said that produced this fact, recorded verbatim. Blank records that you edited it here.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to write the field.' },
    ],
  },
  'owner-profile-forget': {
    mode: 'delete',
    title: 'Forget A Profile Fact',
    selectedFieldIndex: 0,
    message: 'Delete one field and every kept history comment for it. No tombstone and no retention window, deleting means deleting. Forgetting something that was not there says so instead of reporting success.',
    fields: [
      { id: 'fieldId', label: 'Field id', value: '', required: true, multiline: false, hint: 'For example contact.phone.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to delete the line and its kept history.' },
    ],
  },
  'owner-profile-forget-note': {
    mode: 'delete',
    title: 'Forget A Note Or Person',
    selectedFieldIndex: 0,
    message: 'Delete one prose line, a note, a person, a place, a work line. Give the line exactly as the profile reads it: lines are named by their content, never by their position, because you edit this file yourself and a position from an earlier read can point somewhere else by now. If the text no longer matches, nothing is deleted and it says so.',
    fields: [
      { id: 'section', label: 'Section', value: '', required: true, multiline: false, hint: 'Notes, People, Places, Work, or Style.' },
      { id: 'text', label: 'The line', value: '', required: true, multiline: false, hint: 'The line as it reads in your profile, without the trailing note about where it came from. Matched on the whole line, so a paraphrase finds nothing.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to delete that line.' },
    ],
  },
  'owner-profile-status': {
    mode: 'create',
    title: 'Profile Status',
    selectedFieldIndex: 0,
    message: 'Whether the profile loaded, where the file is, its section names and counts, and any value that did not parse with the reason. This never prints a value, which is what makes it safe to paste into a support thread.',
    fields: [
      { id: 'confirm', label: 'Show it', value: 'yes', required: true, multiline: false, hint: 'Type yes to print the status here.' },
    ],
  },
};

export function createAgentWorkspaceOwnerProfileEditor(
  kind: AgentWorkspaceOwnerProfileEditorKind,
): AgentWorkspaceLocalEditor {
  return createAgentWorkspaceEditorFromTable(kind, OWNER_PROFILE_EDITOR_SPECS);
}

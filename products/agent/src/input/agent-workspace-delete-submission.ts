/**
 * The two delete-confirmation submitters, lifted out of `agent-workspace.ts`.
 *
 * They moved because that file hit the 800-line architecture cap while the
 * action-result block was being made scrollable, and these two are the most
 * self-contained thing in it: one shape of work (confirm an id, delete the
 * record, report it) that touches the workspace only through a small set of
 * callbacks. Extracting them leaves real headroom rather than trimming
 * comments until the file happens to fit.
 *
 * Behaviour is unchanged, including the rule that a deletion is only accepted
 * when the typed id matches exactly, so a stray Enter cannot destroy a record.
 */
import type { ShellPathService } from '@/runtime/index.ts';
import { AgentNoteRegistry } from '../agent/note-registry.ts';
import { AgentPersonaRegistry } from '../agent/persona-registry.ts';
import { AgentRoutineRegistry } from '../agent/routine-registry.ts';
import { AgentSkillRegistry } from '../agent/skill-registry.ts';
import type { MemoryApi } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import { deleteAgentWorkspaceMemoryEditor } from './agent-workspace-memory-editor.ts';
import type { AgentWorkspaceLocalEditor, AgentWorkspaceLocalEditorKind } from './agent-workspace-types.ts';

export interface AgentWorkspaceDeleteSubmissionHost {
  localEditor: AgentWorkspaceLocalEditor | null;
  status: string;
  editorField: (id: string) => string;
  memoryApi: () => MemoryApi;
  finishLocalDelete: (kind: AgentWorkspaceLocalEditorKind, id: string, name: string) => void;
}

/** Shared refusal: the typed id did not match, so nothing is deleted. */
function refuse(host: AgentWorkspaceDeleteSubmissionHost, editor: AgentWorkspaceLocalEditor, expectedId: string): void {
  host.localEditor = {
    ...editor,
    message: `Deletion not confirmed. Type ${expectedId} exactly, then press Enter.`,
  };
  host.status = 'Deletion not confirmed.';
}

export function submitAgentWorkspaceLocalDeleteEditor(
  host: AgentWorkspaceDeleteSubmissionHost,
  shellPaths: ShellPathService,
  editor: AgentWorkspaceLocalEditor,
): void {
  const expectedId = editor.recordId ?? '';
  const confirmedId = host.editorField('confirm');
  if (!expectedId || confirmedId !== expectedId) {
    refuse(host, editor, expectedId);
    return;
  }
  if (editor.kind === 'memory') {
    const removed = host.memoryApi().delete(expectedId);
    if (!removed) throw new Error(`Unknown Agent memory ${expectedId}`);
    host.finishLocalDelete(editor.kind, expectedId, expectedId);
  } else if (editor.kind === 'persona') {
    const removed = AgentPersonaRegistry.fromShellPaths(shellPaths).deletePersona(expectedId);
    host.finishLocalDelete(editor.kind, removed.id, removed.name);
  } else if (editor.kind === 'note') {
    const removed = AgentNoteRegistry.fromShellPaths(shellPaths).deleteNote(expectedId);
    host.finishLocalDelete(editor.kind, removed.id, removed.title);
  } else if (editor.kind === 'skill') {
    const removed = AgentSkillRegistry.fromShellPaths(shellPaths).deleteSkill(expectedId);
    host.finishLocalDelete(editor.kind, removed.id, removed.name);
  } else if (editor.kind === 'routine') {
    const removed = AgentRoutineRegistry.fromShellPaths(shellPaths).deleteRoutine(expectedId);
    host.finishLocalDelete(editor.kind, removed.id, removed.name);
  } else {
    throw new Error(`Unsupported delete editor kind ${editor.kind}`);
  }
}

export function submitAgentWorkspaceMemoryDeleteEditor(
  host: AgentWorkspaceDeleteSubmissionHost,
  editor: AgentWorkspaceLocalEditor,
): void {
  const expectedId = editor.recordId ?? '';
  const confirmedId = host.editorField('confirm');
  const removed = deleteAgentWorkspaceMemoryEditor(editor, confirmedId, host.memoryApi());
  if (!removed) {
    refuse(host, editor, expectedId);
    return;
  }
  host.finishLocalDelete('memory', removed.id, removed.name);
}

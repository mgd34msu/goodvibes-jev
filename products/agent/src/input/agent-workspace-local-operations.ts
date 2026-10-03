import type { MemoryApi } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import type { ShellPathService } from '@/runtime/index.ts';
import { AgentNoteRegistry } from '../agent/note-registry.ts';
import { AgentPersonaRegistry } from '../agent/persona-registry.ts';
import { AgentRoutineRegistry } from '../agent/routine-registry.ts';
import { AgentSkillRegistry } from '../agent/skill-registry.ts';
import { quoteSlashCommandArg } from './slash-command-parser.ts';
import {
  createKnowledgeUrlEditorFromNote,
  createMemoryEditorFromNote,
  createMemoryUpdateEditor,
  createNoteUpdateEditor,
  createPersonaEditorFromNote,
  createPersonaUpdateEditor,
  createRoutineEditorFromNote,
  createRoutineUpdateEditor,
  createSkillEditorFromNote,
  createSkillUpdateEditor,
} from './agent-workspace-editors.ts';
import type {
  AgentWorkspaceActionResult,
  AgentWorkspaceLocalEditor,
  AgentWorkspaceLocalEditorKind,
  AgentWorkspaceLocalLibraryItem,
  AgentWorkspaceLocalOperation,
} from './agent-workspace-types.ts';

interface AgentWorkspaceLocalOperationHost {
  status: string;
  lastActionResult: AgentWorkspaceActionResult | null;
  localEditor: AgentWorkspaceLocalEditor | null;
  hasCommandDispatch(): boolean;
  dispatchWorkspaceCommand(command: string): void;
}

interface AgentWorkspaceLocalOperationCallbacks {
  readonly shellPaths: () => ShellPathService | undefined;
  readonly selectedItemForOperation: (operation: AgentWorkspaceLocalOperation) => AgentWorkspaceLocalLibraryItem | null;
  readonly memoryApi: () => MemoryApi;
  readonly finishLocalOperation: (kind: AgentWorkspaceLocalEditorKind, title: string, detail: string) => void;
  readonly openDeleteEditor: (kind: AgentWorkspaceLocalEditorKind, selected: AgentWorkspaceLocalLibraryItem) => void;
}

function setGuidanceEditor(host: AgentWorkspaceLocalOperationHost, editor: AgentWorkspaceLocalEditor, status: string): void {
  host.localEditor = editor;
  host.status = status;
  host.lastActionResult = {
    kind: 'guidance',
    title: editor.title,
    detail: editor.message,
    safety: 'safe',
  };
}

export function applyAgentWorkspaceLocalLibraryOperation(
  host: AgentWorkspaceLocalOperationHost,
  operation: AgentWorkspaceLocalOperation,
  callbacks: AgentWorkspaceLocalOperationCallbacks,
): void {
  const shellPaths = callbacks.shellPaths();
  if (!shellPaths) {
    host.status = 'Agent-local registry files are unavailable.';
    host.lastActionResult = {
      kind: 'error',
      title: 'Local registry unavailable',
      detail: 'The Agent workspace cannot locate the Agent-local registry files for this runtime.',
    };
    return;
  }
  try {
    if (operation === 'persona-clear') {
      AgentPersonaRegistry.fromShellPaths(shellPaths).clearActive();
      callbacks.finishLocalOperation('persona', 'Cleared active persona', 'The default Agent policy will apply to later turns.');
      return;
    }
    const selected = callbacks.selectedItemForOperation(operation);
    if (!selected) {
      host.status = 'No selected local registry item.';
      host.lastActionResult = {
        kind: 'guidance',
        title: 'Nothing selected',
        detail: 'Create or select a local library item before running this action.',
        safety: 'safe',
      };
      return;
    }
    if (operation === 'memory-edit') {
      const memory = callbacks.memoryApi();
      const record = memory.get(selected.id);
      if (!record) throw new Error(`Unknown Agent memory ${selected.id}`);
      setGuidanceEditor(host, createMemoryUpdateEditor(record), `Editing memory ${record.id}.`);
    } else if (operation === 'memory-review') {
      const record = callbacks.memoryApi().review(selected.id, { state: 'reviewed', confidence: selected.confidence ?? 100, reviewedBy: 'operator' });
      if (!record) throw new Error(`Unknown Agent memory ${selected.id}`);
      callbacks.finishLocalOperation('memory', `Reviewed memory ${record.id}`, `${record.summary} is marked reviewed.`);
    } else if (operation === 'memory-stale') {
      const record = callbacks.memoryApi().review(selected.id, { state: 'stale', staleReason: 'Marked stale from Agent workspace', reviewedBy: 'operator' });
      if (!record) throw new Error(`Unknown Agent memory ${selected.id}`);
      callbacks.finishLocalOperation('memory', `Marked memory stale ${record.id}`, `${record.summary} needs review before reuse.`);
    } else if (operation === 'memory-delete') {
      callbacks.openDeleteEditor('memory', selected);
    } else if (operation === 'note-edit') {
      const note = AgentNoteRegistry.fromShellPaths(shellPaths).get(selected.id);
      if (!note) throw new Error(`Unknown note ${selected.id}`);
      setGuidanceEditor(host, createNoteUpdateEditor(note), `Editing note ${note.title}.`);
    } else if (operation === 'note-review') {
      const note = AgentNoteRegistry.fromShellPaths(shellPaths).markReviewed(selected.id);
      callbacks.finishLocalOperation('note', `Reviewed note ${note.title}`, `${note.title} is marked reviewed in the local scratchpad.`);
    } else if (operation === 'note-stale') {
      const note = AgentNoteRegistry.fromShellPaths(shellPaths).markStale(selected.id, 'Marked stale from Agent workspace');
      callbacks.finishLocalOperation('note', `Marked note stale ${note.title}`, `${note.title} needs review before reuse.`);
    } else if (operation === 'note-delete') {
      callbacks.openDeleteEditor('note', selected);
    } else if (operation === 'note-promote-memory') {
      const note = AgentNoteRegistry.fromShellPaths(shellPaths).get(selected.id);
      if (!note) throw new Error(`Unknown note ${selected.id}`);
      setGuidanceEditor(host, createMemoryEditorFromNote(note), `Creating memory from note ${note.title}.`);
    } else if (operation === 'note-promote-persona') {
      const note = AgentNoteRegistry.fromShellPaths(shellPaths).get(selected.id);
      if (!note) throw new Error(`Unknown note ${selected.id}`);
      setGuidanceEditor(host, createPersonaEditorFromNote(note), `Creating persona from note ${note.title}.`);
    } else if (operation === 'note-promote-skill') {
      const note = AgentNoteRegistry.fromShellPaths(shellPaths).get(selected.id);
      if (!note) throw new Error(`Unknown note ${selected.id}`);
      setGuidanceEditor(host, createSkillEditorFromNote(note), `Creating skill from note ${note.title}.`);
    } else if (operation === 'note-promote-routine') {
      const note = AgentNoteRegistry.fromShellPaths(shellPaths).get(selected.id);
      if (!note) throw new Error(`Unknown note ${selected.id}`);
      setGuidanceEditor(host, createRoutineEditorFromNote(note), `Creating routine from note ${note.title}.`);
    } else if (operation === 'note-promote-knowledge-url') {
      const note = AgentNoteRegistry.fromShellPaths(shellPaths).get(selected.id);
      if (!note) throw new Error(`Unknown note ${selected.id}`);
      const sourceUrl = note.sourceUrl?.trim();
      if (!sourceUrl) {
        host.status = 'Selected note has no reviewed source URL.';
        host.lastActionResult = {
          kind: 'guidance',
          title: 'No note source URL',
          detail: 'Edit the selected note and add a reviewed HTTP(S) source URL before ingesting it into Agent Knowledge.',
          safety: 'safe',
        };
        return;
      }
      const parsed = new URL(sourceUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Selected note source URL must be HTTP or HTTPS before Agent Knowledge ingest.');
      }
      setGuidanceEditor(host, createKnowledgeUrlEditorFromNote(note), `Preparing Agent Knowledge ingest from note ${note.title}.`);
    } else if (operation === 'persona-edit') {
      const registry = AgentPersonaRegistry.fromShellPaths(shellPaths);
      const persona = registry.get(selected.id);
      if (!persona) throw new Error(`Unknown persona ${selected.id}`);
      setGuidanceEditor(host, createPersonaUpdateEditor(persona, registry.snapshot().activePersonaId === persona.id), `Editing persona ${persona.name}.`);
    } else if (operation === 'persona-use') {
      AgentPersonaRegistry.fromShellPaths(shellPaths).setActive(selected.id);
      callbacks.finishLocalOperation('persona', `Using persona ${selected.name}`, `${selected.name} will shape later main-conversation turns.`);
    } else if (operation === 'persona-review') {
      AgentPersonaRegistry.fromShellPaths(shellPaths).markReviewed(selected.id);
      callbacks.finishLocalOperation('persona', `Reviewed persona ${selected.name}`, `${selected.name} is marked reviewed.`);
    } else if (operation === 'persona-delete') {
      callbacks.openDeleteEditor('persona', selected);
    } else if (operation === 'skill-edit') {
      const skill = AgentSkillRegistry.fromShellPaths(shellPaths).get(selected.id);
      if (!skill) throw new Error(`Unknown skill ${selected.id}`);
      setGuidanceEditor(host, createSkillUpdateEditor(skill), `Editing skill ${skill.name}.`);
    } else if (operation === 'skill-enable') {
      AgentSkillRegistry.fromShellPaths(shellPaths).setEnabled(selected.id, true);
      callbacks.finishLocalOperation('skill', `Enabled skill ${selected.name}`, `${selected.name} can now inform main-conversation turns.`);
    } else if (operation === 'skill-disable') {
      AgentSkillRegistry.fromShellPaths(shellPaths).setEnabled(selected.id, false);
      callbacks.finishLocalOperation('skill', `Disabled skill ${selected.name}`, `${selected.name} remains saved but is no longer injected into guidance.`);
    } else if (operation === 'skill-review') {
      AgentSkillRegistry.fromShellPaths(shellPaths).markReviewed(selected.id);
      callbacks.finishLocalOperation('skill', `Reviewed skill ${selected.name}`, `${selected.name} is marked reviewed.`);
    } else if (operation === 'skill-delete') {
      callbacks.openDeleteEditor('skill', selected);
    } else if (operation === 'routine-edit') {
      const routine = AgentRoutineRegistry.fromShellPaths(shellPaths).get(selected.id);
      if (!routine) throw new Error(`Unknown routine ${selected.id}`);
      setGuidanceEditor(host, createRoutineUpdateEditor(routine), `Editing routine ${routine.name}.`);
    } else if (operation === 'routine-start') {
      if (host.hasCommandDispatch()) {
        const command = `/routines start ${quoteSlashCommandArg(selected.id)}`;
        host.dispatchWorkspaceCommand(command);
        host.status = `Opening routine ${selected.name}.`;
        host.lastActionResult = {
          kind: 'dispatched',
          title: `Opening routine ${selected.name}`,
          detail: `${selected.name} will print its workflow steps in the main conversation. No hidden job was created.`,
          command,
          safety: 'safe',
        };
        return;
      }
      AgentRoutineRegistry.fromShellPaths(shellPaths).markStarted(selected.id);
      callbacks.finishLocalOperation('routine', `Started routine ${selected.name}`, `${selected.name} was marked started for this main-conversation workflow. No hidden job was created.`);
    } else if (operation === 'routine-enable') {
      AgentRoutineRegistry.fromShellPaths(shellPaths).setEnabled(selected.id, true);
      callbacks.finishLocalOperation('routine', `Enabled routine ${selected.name}`, `${selected.name} can now inform main-conversation turns.`);
    } else if (operation === 'routine-disable') {
      AgentRoutineRegistry.fromShellPaths(shellPaths).setEnabled(selected.id, false);
      callbacks.finishLocalOperation('routine', `Disabled routine ${selected.name}`, `${selected.name} remains saved but is no longer injected into guidance.`);
    } else if (operation === 'routine-review') {
      AgentRoutineRegistry.fromShellPaths(shellPaths).markReviewed(selected.id);
      callbacks.finishLocalOperation('routine', `Reviewed routine ${selected.name}`, `${selected.name} is marked reviewed.`);
    } else {
      callbacks.openDeleteEditor('routine', selected);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    host.status = detail;
    host.lastActionResult = {
      kind: 'error',
      title: 'Local registry action failed',
      detail,
    };
  }
}

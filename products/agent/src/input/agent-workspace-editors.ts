import type { AgentPersonaRecord } from '../agent/persona-registry.ts';
import type { AgentRoutineRecord } from '../agent/routine-registry.ts';
import type { AgentSkillRecord } from '../agent/skill-registry.ts';
import type { AgentNoteRecord } from '../agent/note-registry.ts';
import type { MemoryRecord } from '@goodvibes-jev/engine/sdk/platform/state';
import type {
  AgentWorkspaceLocalEditor,
  AgentWorkspaceLocalEditorKind,
  AgentWorkspaceLocalLibraryItem,
  AgentWorkspaceRuntimeStarterTemplateItem,
} from './agent-workspace-types.ts';

export function createProfileEditor(templates: readonly AgentWorkspaceRuntimeStarterTemplateItem[]): AgentWorkspaceLocalEditor {
  const defaultTemplate = templates.find((template) => template.id === 'research')?.id ?? templates[0]?.id ?? 'none';
  const preview = templates.length === 0
    ? 'No starter templates found; use none to create an empty isolated profile.'
    : templates
      .slice(0, 6)
      .map((template) => `${template.id} (${template.name})`)
      .join(', ');
  return {
    kind: 'profile',
    mode: 'create',
    title: 'Create Agent Profile',
    selectedFieldIndex: 0,
    message: 'Create an isolated Agent home seeded with a persona, skills, and routines. The current process keeps using its existing home until relaunched with --agent-profile.',
    fields: [
      { id: 'name', label: 'Profile name', value: '', required: true, multiline: false, hint: 'Short profile name. It normalizes to lowercase letters, numbers, dots, underscores, and dashes.' },
      { id: 'template', label: 'Starter template', value: defaultTemplate, required: false, multiline: false, hint: `Template id or none. Available: ${preview}.` },
    ],
  };
}

export function createLearnedBehaviorEditor(): AgentWorkspaceLocalEditor {
  return {
    kind: 'learned-behavior',
    mode: 'create',
    title: 'Capture Learned Behavior',
    selectedFieldIndex: 0,
    message: 'Turn a reviewed workflow or lesson into Agent-local behavior. This writes only to Agent-local personas, skills, or routines.',
    fields: [
      { id: 'target', label: 'Behavior type', value: 'skill', required: true, multiline: false, hint: 'skill, routine, or persona.' },
      { id: 'name', label: 'Name', value: '', required: true, multiline: false, hint: 'Short name for the learned behavior.' },
      { id: 'description', label: 'Description', value: '', required: true, multiline: false, hint: 'One-line summary of when to use it.' },
      { id: 'notes', label: 'Lesson or workflow', value: '', required: true, multiline: true, hint: 'Paste the procedure, persona guidance, or repeatable workflow. Ctrl-J inserts a new line.' },
      { id: 'triggers', label: 'Triggers', value: '', required: false, multiline: false, hint: 'Comma-separated words that suggest this behavior.' },
      { id: 'tags', label: 'Tags', value: 'learned', required: false, multiline: false, hint: 'Comma-separated optional tags.' },
      { id: 'enable', label: 'Enable or activate', value: 'yes', required: false, multiline: false, hint: 'yes/no. Skills and routines enable; personas activate.' },
    ],
  };
}

export function createLocalEditor(kind: AgentWorkspaceLocalEditorKind | 'knowledge-url'): AgentWorkspaceLocalEditor {
  if (kind === 'profile') return createProfileEditor([]);
  if (kind === 'knowledge-url') {
    return {
      kind,
      mode: 'create',
      title: 'Ingest Agent Knowledge URL',
      selectedFieldIndex: 0,
      message: 'Add a source-backed URL to the isolated Agent Knowledge segment. Type yes on the final field to confirm.',
      fields: [
        { id: 'url', label: 'URL', value: '', required: true, multiline: false, hint: 'HTTP or HTTPS URL to ingest into Agent Knowledge only.' },
        { id: 'tags', label: 'Tags', value: '', required: false, multiline: false, hint: 'Comma-separated optional tags. Spaces are not needed.' },
        { id: 'folder', label: 'Folder', value: '', required: false, multiline: false, hint: 'Optional Agent Knowledge folder path.' },
        { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /knowledge ingest-url with --yes.' },
      ],
    };
  }
  if (kind === 'memory') {
    return {
      kind,
      mode: 'create',
      title: 'Create Memory',
      selectedFieldIndex: 0,
      message: 'Record a durable, non-secret Agent memory. This stays in the Agent-owned memory store and never writes to default knowledge.',
      fields: [
        { id: 'cls', label: 'Class', value: 'fact', required: true, multiline: false, hint: 'fact, decision, constraint, incident, pattern, risk, runbook, architecture, or ownership.' },
        { id: 'scope', label: 'Scope', value: 'project', required: true, multiline: false, hint: 'session, project, or team.' },
        { id: 'summary', label: 'Summary', value: '', required: true, multiline: false, hint: 'One durable sentence. Do not store secrets.' },
        { id: 'detail', label: 'Detail', value: '', required: false, multiline: true, hint: 'Optional supporting detail. Ctrl-J inserts a new line.' },
        { id: 'tags', label: 'Tags', value: '', required: false, multiline: false, hint: 'Comma-separated optional tags.' },
        { id: 'confidence', label: 'Confidence', value: '80', required: false, multiline: false, hint: '0-100 confidence score.' },
      ],
    };
  }
  if (kind === 'note') {
    return {
      kind,
      mode: 'create',
      title: 'Create Note',
      selectedFieldIndex: 0,
      message: 'Capture a local working note or source-triage note. Notes stay in the Agent-local scratchpad and are not memory or Agent Knowledge.',
      fields: [
        { id: 'title', label: 'Title', value: '', required: true, multiline: false, hint: 'Short note title.' },
        { id: 'body', label: 'Note', value: '', required: true, multiline: true, hint: 'Working note, source triage, or temporary decision. Ctrl-J inserts a new line.' },
        { id: 'sourceUrl', label: 'Source URL', value: '', required: false, multiline: false, hint: 'Optional reviewed URL. This does not ingest the URL into Agent Knowledge.' },
        { id: 'tags', label: 'Tags', value: 'scratchpad', required: false, multiline: false, hint: 'Comma-separated optional tags.' },
      ],
    };
  }
  if (kind === 'persona') {
    return {
      kind,
      mode: 'create',
      title: 'Create Persona',
      selectedFieldIndex: 0,
      message: 'Enter a local behavior profile for the serial main-conversation assistant.',
      fields: [
        { id: 'name', label: 'Name', value: '', required: true, multiline: false, hint: 'Short persona name.' },
        { id: 'description', label: 'Description', value: '', required: true, multiline: false, hint: 'One-line summary of when to use it.' },
        { id: 'body', label: 'Instructions', value: '', required: true, multiline: true, hint: 'Operating guidance. Ctrl-J inserts a new line.' },
        { id: 'tags', label: 'Tags', value: '', required: false, multiline: false, hint: 'Comma-separated optional tags.' },
        { id: 'triggers', label: 'Triggers', value: '', required: false, multiline: false, hint: 'Comma-separated words that suggest this persona.' },
        { id: 'activate', label: 'Activate now', value: 'yes', required: false, multiline: false, hint: 'yes/no.' },
      ],
    };
  }
  if (kind === 'skill') {
    return {
      kind,
      mode: 'create',
      title: 'Create Skill',
      selectedFieldIndex: 0,
      message: 'Enter a reusable local procedure the assistant can apply from the main conversation.',
      fields: [
        { id: 'name', label: 'Name', value: '', required: true, multiline: false, hint: 'Short skill name.' },
        { id: 'description', label: 'Description', value: '', required: true, multiline: false, hint: 'One-line summary of the procedure.' },
        { id: 'procedure', label: 'Procedure', value: '', required: true, multiline: true, hint: 'Reusable steps. Ctrl-J inserts a new line.' },
        { id: 'triggers', label: 'Triggers', value: '', required: false, multiline: false, hint: 'Comma-separated words that suggest this skill.' },
        { id: 'tags', label: 'Tags', value: '', required: false, multiline: false, hint: 'Comma-separated optional tags.' },
        { id: 'requiresEnv', label: 'Required env vars', value: '', required: false, multiline: false, hint: 'Comma-separated env var names. Values are never stored.' },
        { id: 'requiresCommands', label: 'Required commands', value: '', required: false, multiline: false, hint: 'Comma-separated binaries that must be on PATH.' },
        { id: 'enabled', label: 'Enable now', value: 'yes', required: false, multiline: false, hint: 'yes/no.' },
      ],
    };
  }
  return {
    kind,
    mode: 'create',
    title: 'Create Routine',
    selectedFieldIndex: 0,
    message: 'Enter a repeatable workflow. It runs in the main conversation unless explicitly promoted to a connected schedule.',
    fields: [
      { id: 'name', label: 'Name', value: '', required: true, multiline: false, hint: 'Short routine name.' },
      { id: 'description', label: 'Description', value: '', required: true, multiline: false, hint: 'One-line summary of the workflow.' },
      { id: 'steps', label: 'Steps', value: '', required: true, multiline: true, hint: 'Workflow steps. Ctrl-J inserts a new line.' },
      { id: 'triggers', label: 'Triggers', value: '', required: false, multiline: false, hint: 'Comma-separated words that suggest this routine.' },
      { id: 'tags', label: 'Tags', value: '', required: false, multiline: false, hint: 'Comma-separated optional tags.' },
      { id: 'requiresEnv', label: 'Required env vars', value: '', required: false, multiline: false, hint: 'Comma-separated env var names. Values are never stored.' },
      { id: 'requiresCommands', label: 'Required commands', value: '', required: false, multiline: false, hint: 'Comma-separated binaries that must be on PATH.' },
      { id: 'enabled', label: 'Enable now', value: 'yes', required: false, multiline: false, hint: 'yes/no.' },
    ],
  };
}

export function createMemoryUpdateEditor(record: MemoryRecord): AgentWorkspaceLocalEditor {
  return {
    kind: 'memory',
    mode: 'update',
    recordId: record.id,
    title: 'Edit Memory',
    selectedFieldIndex: 0,
    message: `Editing ${record.id}. Saving updates only the Agent-owned memory record.`,
    fields: [
      { id: 'scope', label: 'Scope', value: record.scope, required: true, multiline: false, hint: 'session, project, or team.' },
      { id: 'summary', label: 'Summary', value: record.summary, required: true, multiline: false, hint: 'One durable sentence. Do not store secrets.' },
      { id: 'detail', label: 'Detail', value: record.detail ?? '', required: false, multiline: true, hint: 'Optional supporting detail. Ctrl-J inserts a new line.' },
      { id: 'tags', label: 'Tags', value: record.tags.join(', '), required: false, multiline: false, hint: 'Comma-separated optional tags.' },
    ],
  };
}

function noteDescription(note: AgentNoteRecord): string {
  const compact = note.body.replace(/\s+/g, ' ').trim();
  const firstSentence = compact.split(/(?<=[.!?])\s+/)[0]?.trim() ?? compact;
  const base = firstSentence.length > 160 ? `${firstSentence.slice(0, 157)}...` : firstSentence;
  return base || note.title;
}

function noteTags(note: AgentNoteRecord, extraTag: string): string {
  return [...new Set([...note.tags, extraTag])].join(', ');
}

export function createMemoryEditorFromNote(note: AgentNoteRecord): AgentWorkspaceLocalEditor {
  const sourceLine = note.sourceUrl ? `\n\nOrigin URL: ${note.sourceUrl}` : '';
  return {
    kind: 'memory',
    mode: 'create',
    title: 'Create Memory From Note',
    selectedFieldIndex: 0,
    message: `Promote ${note.title} into durable Agent memory. Saving writes memory only; the note remains in the scratchpad.`,
    fields: [
      { id: 'cls', label: 'Class', value: 'fact', required: true, multiline: false, hint: 'fact, decision, constraint, incident, pattern, risk, runbook, architecture, or ownership.' },
      { id: 'scope', label: 'Scope', value: 'project', required: true, multiline: false, hint: 'session, project, or team.' },
      { id: 'summary', label: 'Summary', value: note.title, required: true, multiline: false, hint: 'One durable sentence. Do not store secrets.' },
      { id: 'detail', label: 'Detail', value: `${note.body}${sourceLine}`, required: false, multiline: true, hint: 'Optional supporting detail. Ctrl-J inserts a new line.' },
      { id: 'tags', label: 'Tags', value: noteTags(note, 'from-note'), required: false, multiline: false, hint: 'Comma-separated optional tags.' },
      { id: 'confidence', label: 'Confidence', value: note.reviewState === 'reviewed' ? '85' : '65', required: false, multiline: false, hint: '0-100 confidence score.' },
    ],
  };
}

export function createPersonaEditorFromNote(note: AgentNoteRecord): AgentWorkspaceLocalEditor {
  return {
    kind: 'persona',
    mode: 'create',
    title: 'Create Persona From Note',
    selectedFieldIndex: 0,
    message: `Use ${note.title} as the starting point for a local persona. Saving creates a persona only; the note remains in the scratchpad.`,
    fields: [
      { id: 'name', label: 'Name', value: note.title, required: true, multiline: false, hint: 'Short persona name.' },
      { id: 'description', label: 'Description', value: noteDescription(note), required: true, multiline: false, hint: 'One-line summary of when to use it.' },
      { id: 'body', label: 'Instructions', value: note.body, required: true, multiline: true, hint: 'Operating guidance. Ctrl-J inserts a new line.' },
      { id: 'tags', label: 'Tags', value: noteTags(note, 'from-note'), required: false, multiline: false, hint: 'Comma-separated optional tags.' },
      { id: 'triggers', label: 'Triggers', value: '', required: false, multiline: false, hint: 'Comma-separated words that suggest this persona.' },
      { id: 'activate', label: 'Activate now', value: 'no', required: false, multiline: false, hint: 'yes/no.' },
    ],
  };
}

export function createSkillEditorFromNote(note: AgentNoteRecord): AgentWorkspaceLocalEditor {
  return {
    kind: 'skill',
    mode: 'create',
    title: 'Create Skill From Note',
    selectedFieldIndex: 0,
    message: `Use ${note.title} as the starting point for a reusable local skill. Saving creates a skill only; the note remains in the scratchpad.`,
    fields: [
      { id: 'name', label: 'Name', value: note.title, required: true, multiline: false, hint: 'Short skill name.' },
      { id: 'description', label: 'Description', value: noteDescription(note), required: true, multiline: false, hint: 'One-line summary of the procedure.' },
      { id: 'procedure', label: 'Procedure', value: note.body, required: true, multiline: true, hint: 'Reusable steps. Ctrl-J inserts a new line.' },
      { id: 'triggers', label: 'Triggers', value: '', required: false, multiline: false, hint: 'Comma-separated words that suggest this skill.' },
      { id: 'tags', label: 'Tags', value: noteTags(note, 'from-note'), required: false, multiline: false, hint: 'Comma-separated optional tags.' },
      { id: 'requiresEnv', label: 'Required env vars', value: '', required: false, multiline: false, hint: 'Comma-separated env var names. Values are never stored.' },
      { id: 'requiresCommands', label: 'Required commands', value: '', required: false, multiline: false, hint: 'Comma-separated binaries that must be on PATH.' },
      { id: 'enabled', label: 'Enable now', value: 'yes', required: false, multiline: false, hint: 'yes/no.' },
    ],
  };
}

export function createRoutineEditorFromNote(note: AgentNoteRecord): AgentWorkspaceLocalEditor {
  return {
    kind: 'routine',
    mode: 'create',
    title: 'Create Routine From Note',
    selectedFieldIndex: 0,
    message: `Use ${note.title} as the starting point for a repeatable local routine. Saving creates a routine only; the note remains in the scratchpad.`,
    fields: [
      { id: 'name', label: 'Name', value: note.title, required: true, multiline: false, hint: 'Short routine name.' },
      { id: 'description', label: 'Description', value: noteDescription(note), required: true, multiline: false, hint: 'One-line summary of the workflow.' },
      { id: 'steps', label: 'Steps', value: note.body, required: true, multiline: true, hint: 'Workflow steps. Ctrl-J inserts a new line.' },
      { id: 'triggers', label: 'Triggers', value: '', required: false, multiline: false, hint: 'Comma-separated words that suggest this routine.' },
      { id: 'tags', label: 'Tags', value: noteTags(note, 'from-note'), required: false, multiline: false, hint: 'Comma-separated optional tags.' },
      { id: 'requiresEnv', label: 'Required env vars', value: '', required: false, multiline: false, hint: 'Comma-separated env var names. Values are never stored.' },
      { id: 'requiresCommands', label: 'Required commands', value: '', required: false, multiline: false, hint: 'Comma-separated binaries that must be on PATH.' },
      { id: 'enabled', label: 'Enable now', value: 'yes', required: false, multiline: false, hint: 'yes/no.' },
    ],
  };
}

export function createKnowledgeUrlEditorFromNote(note: AgentNoteRecord): AgentWorkspaceLocalEditor {
  return {
    kind: 'knowledge-url',
    mode: 'create',
    title: 'Ingest Note Source Into Agent Knowledge',
    selectedFieldIndex: 3,
    message: `Review the source URL from ${note.title}, then type yes to ingest it into isolated Agent Knowledge. The scratchpad note remains unchanged.`,
    fields: [
      { id: 'url', label: 'URL', value: note.sourceUrl ?? '', required: true, multiline: false, hint: 'HTTP or HTTPS URL to ingest into Agent Knowledge only.' },
      { id: 'tags', label: 'Tags', value: noteTags(note, 'from-note'), required: false, multiline: false, hint: 'Comma-separated optional tags. Spaces are not needed.' },
      { id: 'folder', label: 'Folder', value: 'notes', required: false, multiline: false, hint: 'Optional Agent Knowledge folder path.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /knowledge ingest-url with --yes.' },
    ],
  };
}

export function createNoteUpdateEditor(record: AgentNoteRecord): AgentWorkspaceLocalEditor {
  return {
    kind: 'note',
    mode: 'update',
    recordId: record.id,
    title: 'Edit Note',
    selectedFieldIndex: 0,
    message: `Editing ${record.title}. Saving keeps it in the Agent-local scratchpad only.`,
    fields: [
      { id: 'title', label: 'Title', value: record.title, required: true, multiline: false, hint: 'Short note title.' },
      { id: 'body', label: 'Note', value: record.body, required: true, multiline: true, hint: 'Working note, source triage, or temporary decision. Ctrl-J inserts a new line.' },
      { id: 'sourceUrl', label: 'Source URL', value: record.sourceUrl ?? '', required: false, multiline: false, hint: 'Optional reviewed URL. This does not ingest the URL into Agent Knowledge.' },
      { id: 'tags', label: 'Tags', value: record.tags.join(', '), required: false, multiline: false, hint: 'Comma-separated optional tags.' },
    ],
  };
}

export function createPersonaUpdateEditor(record: AgentPersonaRecord, active: boolean): AgentWorkspaceLocalEditor {
  return {
    kind: 'persona',
    mode: 'update',
    recordId: record.id,
    title: 'Edit Persona',
    selectedFieldIndex: 0,
    message: `Editing ${record.name}. Saving marks it fresh for review.`,
    fields: [
      { id: 'name', label: 'Name', value: record.name, required: true, multiline: false, hint: 'Short persona name.' },
      { id: 'description', label: 'Description', value: record.description, required: true, multiline: false, hint: 'One-line summary of when to use it.' },
      { id: 'body', label: 'Instructions', value: record.body, required: true, multiline: true, hint: 'Operating guidance. Ctrl-J inserts a new line.' },
      { id: 'tags', label: 'Tags', value: record.tags.join(', '), required: false, multiline: false, hint: 'Comma-separated optional tags.' },
      { id: 'triggers', label: 'Triggers', value: record.triggers.join(', '), required: false, multiline: false, hint: 'Comma-separated words that suggest this persona.' },
      { id: 'activate', label: 'Active', value: active ? 'yes' : 'no', required: false, multiline: false, hint: 'yes/no. Setting no clears this persona only if it is currently active.' },
    ],
  };
}

export function createSkillUpdateEditor(record: AgentSkillRecord): AgentWorkspaceLocalEditor {
  return {
    kind: 'skill',
    mode: 'update',
    recordId: record.id,
    title: 'Edit Skill',
    selectedFieldIndex: 0,
    message: `Editing ${record.name}. Saving marks it fresh for review.`,
    fields: [
      { id: 'name', label: 'Name', value: record.name, required: true, multiline: false, hint: 'Short skill name.' },
      { id: 'description', label: 'Description', value: record.description, required: true, multiline: false, hint: 'One-line summary of the procedure.' },
      { id: 'procedure', label: 'Procedure', value: record.procedure, required: true, multiline: true, hint: 'Reusable steps. Ctrl-J inserts a new line.' },
      { id: 'triggers', label: 'Triggers', value: record.triggers.join(', '), required: false, multiline: false, hint: 'Comma-separated words that suggest this skill.' },
      { id: 'tags', label: 'Tags', value: record.tags.join(', '), required: false, multiline: false, hint: 'Comma-separated optional tags.' },
      { id: 'requiresEnv', label: 'Required env vars', value: record.requirements.filter((requirement) => requirement.kind === 'env').map((requirement) => requirement.name).join(', '), required: false, multiline: false, hint: 'Comma-separated env var names. Values are never stored.' },
      { id: 'requiresCommands', label: 'Required commands', value: record.requirements.filter((requirement) => requirement.kind === 'command').map((requirement) => requirement.name).join(', '), required: false, multiline: false, hint: 'Comma-separated binaries that must be on PATH.' },
      { id: 'enabled', label: 'Enabled', value: record.enabled ? 'yes' : 'no', required: false, multiline: false, hint: 'yes/no.' },
    ],
  };
}

export function createRoutineUpdateEditor(record: AgentRoutineRecord): AgentWorkspaceLocalEditor {
  return {
    kind: 'routine',
    mode: 'update',
    recordId: record.id,
    title: 'Edit Routine',
    selectedFieldIndex: 0,
    message: `Editing ${record.name}. Saving marks it fresh for review.`,
    fields: [
      { id: 'name', label: 'Name', value: record.name, required: true, multiline: false, hint: 'Short routine name.' },
      { id: 'description', label: 'Description', value: record.description, required: true, multiline: false, hint: 'One-line summary of the workflow.' },
      { id: 'steps', label: 'Steps', value: record.steps, required: true, multiline: true, hint: 'Workflow steps. Ctrl-J inserts a new line.' },
      { id: 'triggers', label: 'Triggers', value: record.triggers.join(', '), required: false, multiline: false, hint: 'Comma-separated words that suggest this routine.' },
      { id: 'tags', label: 'Tags', value: record.tags.join(', '), required: false, multiline: false, hint: 'Comma-separated optional tags.' },
      { id: 'requiresEnv', label: 'Required env vars', value: record.requirements.filter((requirement) => requirement.kind === 'env').map((requirement) => requirement.name).join(', '), required: false, multiline: false, hint: 'Comma-separated env var names. Values are never stored.' },
      { id: 'requiresCommands', label: 'Required commands', value: record.requirements.filter((requirement) => requirement.kind === 'command').map((requirement) => requirement.name).join(', '), required: false, multiline: false, hint: 'Comma-separated binaries that must be on PATH.' },
      { id: 'enabled', label: 'Enabled', value: record.enabled ? 'yes' : 'no', required: false, multiline: false, hint: 'yes/no.' },
    ],
  };
}

export function createDeleteEditor(kind: AgentWorkspaceLocalEditorKind, item: AgentWorkspaceLocalLibraryItem): AgentWorkspaceLocalEditor {
  const label = kind[0]!.toUpperCase() + kind.slice(1);
  return {
    kind,
    mode: 'delete',
    recordId: item.id,
    title: `Delete ${label}`,
    selectedFieldIndex: 0,
    message: `Type ${item.id} exactly to delete ${item.name}. This only changes the Agent-local registry.`,
    fields: [
      { id: 'confirm', label: 'Confirm id', value: '', required: true, multiline: false, hint: `Type ${item.id} exactly.` },
    ],
  };
}

export function splitList(value: string): string[] {
  return value.split(',').map((part) => part.trim()).filter(Boolean);
}

export function isAffirmative(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === '' || normalized === 'yes' || normalized === 'y' || normalized === 'true' || normalized === 'enabled' || normalized === 'on';
}

export function editorCategoryId(kind: AgentWorkspaceLocalEditorKind): string {
  if (kind === 'memory') return 'memory';
  if (kind === 'note') return 'notes';
  if (kind === 'profile') return 'profiles';
  if (kind === 'persona') return 'personas';
  if (kind === 'skill') return 'skills';
  return 'routines';
}

import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { AgentNoteRegistry } from '../agent/note-registry.ts';
import { AgentPersonaRegistry } from '../agent/persona-registry.ts';
import { AgentRoutineRegistry } from '../agent/routine-registry.ts';
import { AgentSkillRegistry } from '../agent/skill-registry.ts';
import type { CommandContext } from '../input/command-registry.ts';
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
  isAffirmative,
  splitList,
} from '../input/agent-workspace-editors.ts';
import type { AgentWorkspaceAction, AgentWorkspaceLocalEditor, AgentWorkspaceLocalOperation } from '../input/agent-workspace-types.ts';

export interface AgentHarnessLocalOperationArgs {
  readonly fields?: unknown;
  readonly recordId?: unknown;
  readonly id?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
}

export interface AgentHarnessLocalOperationDeps {
  readonly commandContext: CommandContext;
  readonly toolRegistry: ToolRegistry;
}

type HarnessResult =
  | { readonly success: true; readonly output: string }
  | { readonly success: false; readonly error: string };

type RegistryDomain = 'memory' | 'note' | 'persona' | 'skill' | 'routine';
type RegistryAction = 'update' | 'review' | 'stale' | 'delete' | 'use' | 'clear_active' | 'enable' | 'disable' | 'start';

interface RegistryTarget {
  readonly domain: RegistryDomain;
  readonly action: RegistryAction;
  readonly requiresRecordId: boolean;
}

function output(value: unknown): HarnessResult {
  return { success: true, output: typeof value === 'string' ? value : JSON.stringify(value, null, 2) };
}

function error(message: string): HarnessResult {
  return { success: false, error: message };
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readFieldMap(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, typeof entry === 'string' ? entry : String(entry)]));
}

function describeEditor(editor: AgentWorkspaceLocalEditor): Record<string, unknown> {
  return {
    kind: editor.kind,
    mode: editor.mode,
    recordId: editor.recordId,
    title: editor.title,
    message: editor.message,
    fields: editor.fields.map((field) => ({
      id: field.id,
      label: field.label,
      required: field.required,
      multiline: field.multiline,
      hint: field.hint,
      default: field.redact ? '<redacted>' : field.value,
    })),
  };
}

function readRecordId(args: AgentHarnessLocalOperationArgs): string {
  const fields = readFieldMap(args.fields);
  return readString(args.recordId ?? args.id ?? fields.recordId ?? fields.id);
}

function requireConfirmed(args: AgentHarnessLocalOperationArgs, label: string): string | null {
  if (!readString(args.explicitUserRequest)) return `${label} requires explicitUserRequest with the user's exact request or a short faithful summary.`;
  if (args.confirm !== true) return `${label} requires confirm:true after an explicit user request.`;
  return null;
}

function fieldReader(editor: AgentWorkspaceLocalEditor, fields: Readonly<Record<string, string>>): (id: string) => string {
  return (id: string) => fields[id] ?? editor.fields.find((field) => field.id === id)?.value ?? '';
}

function hasExecutionFields(args: AgentHarnessLocalOperationArgs): boolean {
  return Object.keys(readFieldMap(args.fields)).some((key) => key !== 'id' && key !== 'recordId');
}

function missingRequiredFields(editor: AgentWorkspaceLocalEditor, fields: Readonly<Record<string, string>>): readonly string[] {
  const read = fieldReader(editor, fields);
  return editor.fields.filter((field) => field.required && !read(field.id).trim()).map((field) => field.id);
}

function registryTarget(operation: AgentWorkspaceLocalOperation): RegistryTarget | null {
  if (operation === 'memory-edit') return { domain: 'memory', action: 'update', requiresRecordId: true };
  if (operation === 'memory-review') return { domain: 'memory', action: 'review', requiresRecordId: true };
  if (operation === 'memory-stale') return { domain: 'memory', action: 'stale', requiresRecordId: true };
  if (operation === 'memory-delete') return { domain: 'memory', action: 'delete', requiresRecordId: true };
  if (operation === 'note-edit') return { domain: 'note', action: 'update', requiresRecordId: true };
  if (operation === 'note-review') return { domain: 'note', action: 'review', requiresRecordId: true };
  if (operation === 'note-stale') return { domain: 'note', action: 'stale', requiresRecordId: true };
  if (operation === 'note-delete') return { domain: 'note', action: 'delete', requiresRecordId: true };
  if (operation === 'persona-edit') return { domain: 'persona', action: 'update', requiresRecordId: true };
  if (operation === 'persona-use') return { domain: 'persona', action: 'use', requiresRecordId: true };
  if (operation === 'persona-review') return { domain: 'persona', action: 'review', requiresRecordId: true };
  if (operation === 'persona-clear') return { domain: 'persona', action: 'clear_active', requiresRecordId: false };
  if (operation === 'persona-delete') return { domain: 'persona', action: 'delete', requiresRecordId: true };
  if (operation === 'skill-edit') return { domain: 'skill', action: 'update', requiresRecordId: true };
  if (operation === 'skill-enable') return { domain: 'skill', action: 'enable', requiresRecordId: true };
  if (operation === 'skill-disable') return { domain: 'skill', action: 'disable', requiresRecordId: true };
  if (operation === 'skill-review') return { domain: 'skill', action: 'review', requiresRecordId: true };
  if (operation === 'skill-delete') return { domain: 'skill', action: 'delete', requiresRecordId: true };
  if (operation === 'routine-edit') return { domain: 'routine', action: 'update', requiresRecordId: true };
  if (operation === 'routine-start') return { domain: 'routine', action: 'start', requiresRecordId: true };
  if (operation === 'routine-enable') return { domain: 'routine', action: 'enable', requiresRecordId: true };
  if (operation === 'routine-disable') return { domain: 'routine', action: 'disable', requiresRecordId: true };
  if (operation === 'routine-review') return { domain: 'routine', action: 'review', requiresRecordId: true };
  if (operation === 'routine-delete') return { domain: 'routine', action: 'delete', requiresRecordId: true };
  return null;
}

function editorForOperation(context: CommandContext, operation: AgentWorkspaceLocalOperation, recordId: string): AgentWorkspaceLocalEditor | null {
  const shellPaths = context.workspace.shellPaths;
  if (operation === 'memory-edit') {
    const record = context.clients?.agentKnowledgeApi?.memory?.get(recordId);
    return record ? createMemoryUpdateEditor(record) : null;
  }
  if (!shellPaths) return null;
  if (operation === 'note-edit') {
    const note = AgentNoteRegistry.fromShellPaths(shellPaths).get(recordId);
    return note ? createNoteUpdateEditor(note) : null;
  }
  if (operation === 'note-promote-memory' || operation === 'note-promote-persona' || operation === 'note-promote-skill' || operation === 'note-promote-routine' || operation === 'note-promote-knowledge-url') {
    const note = AgentNoteRegistry.fromShellPaths(shellPaths).get(recordId);
    if (!note) return null;
    if (operation === 'note-promote-memory') return createMemoryEditorFromNote(note);
    if (operation === 'note-promote-persona') return createPersonaEditorFromNote(note);
    if (operation === 'note-promote-skill') return createSkillEditorFromNote(note);
    if (operation === 'note-promote-routine') return createRoutineEditorFromNote(note);
    return note.sourceUrl ? createKnowledgeUrlEditorFromNote(note) : null;
  }
  if (operation === 'persona-edit') {
    const registry = AgentPersonaRegistry.fromShellPaths(shellPaths);
    const persona = registry.get(recordId);
    return persona ? createPersonaUpdateEditor(persona, registry.snapshot().activePersonaId === persona.id) : null;
  }
  if (operation === 'skill-edit') {
    const skill = AgentSkillRegistry.fromShellPaths(shellPaths).get(recordId);
    return skill ? createSkillUpdateEditor(skill) : null;
  }
  if (operation === 'routine-edit') {
    const routine = AgentRoutineRegistry.fromShellPaths(shellPaths).get(recordId);
    return routine ? createRoutineUpdateEditor(routine) : null;
  }
  return null;
}

function localRegistryArgsFromEditor(editor: AgentWorkspaceLocalEditor, fields: Readonly<Record<string, string>>, id?: string): Record<string, unknown> {
  const read = fieldReader(editor, fields);
  if (editor.kind === 'memory') return { domain: 'memory', action: editor.mode === 'update' ? 'update' : 'create', id, cls: read('cls'), scope: read('scope'), summary: read('summary'), detail: read('detail'), tags: splitList(read('tags')), confidence: read('confidence'), provenance: editor.recordId ? 'agent-harness-local-operation' : 'agent-harness-note-promotion' };
  if (editor.kind === 'note') return { domain: 'note', action: editor.mode === 'update' ? 'update' : 'create', id, title: read('title'), body: read('body'), sourceUrl: read('sourceUrl'), tags: splitList(read('tags')), provenance: editor.recordId ? 'agent-harness-local-operation' : 'agent-harness-note-promotion' };
  if (editor.kind === 'persona') return { domain: 'persona', action: editor.mode === 'update' ? 'update' : 'create', id, name: read('name'), description: read('description'), body: read('body'), tags: splitList(read('tags')), triggers: splitList(read('triggers')), activate: read('activate'), provenance: editor.recordId ? 'agent-harness-local-operation' : 'agent-harness-note-promotion' };
  if (editor.kind === 'skill') return { domain: 'skill', action: editor.mode === 'update' ? 'update' : 'create', id, name: read('name'), description: read('description'), procedure: read('procedure'), tags: splitList(read('tags')), triggers: splitList(read('triggers')), requiresEnv: splitList(read('requiresEnv')), requiresCommands: splitList(read('requiresCommands')), enabled: isAffirmative(read('enabled')), provenance: editor.recordId ? 'agent-harness-local-operation' : 'agent-harness-note-promotion' };
  return { domain: 'routine', action: editor.mode === 'update' ? 'update' : 'create', id, name: read('name'), description: read('description'), steps: read('steps'), tags: splitList(read('tags')), triggers: splitList(read('triggers')), requiresEnv: splitList(read('requiresEnv')), requiresCommands: splitList(read('requiresCommands')), enabled: isAffirmative(read('enabled')), provenance: editor.recordId ? 'agent-harness-local-operation' : 'agent-harness-note-promotion' };
}

function localRegistryArgsForTarget(target: RegistryTarget, args: AgentHarnessLocalOperationArgs, recordId: string): Record<string, unknown> {
  const fields = readFieldMap(args.fields);
  const base = { domain: target.domain, action: target.action, ...(recordId ? { id: recordId } : {}) };
  const edit = target.action === 'update' ? localRegistryArgsFromEditor({ kind: target.domain, mode: 'update', recordId, title: '', selectedFieldIndex: 0, message: '', fields: [] } as AgentWorkspaceLocalEditor, fields, recordId) : {};
  return {
    ...base,
    ...edit,
    ...(target.action === 'stale' && fields.reason ? { reason: fields.reason } : {}),
    ...(target.action === 'delete' ? { confirm: args.confirm, explicitUserRequest: readString(args.explicitUserRequest) } : {}),
  };
}

async function executeTool(toolRegistry: ToolRegistry, name: string, toolArgs: Record<string, unknown>): Promise<HarnessResult> {
  if (!toolRegistry.has(name)) return output({ status: 'model_tool_required', modelExecution: { tool: name, args: toolArgs } });
  const result = await toolRegistry.execute(`agent-harness-${name}-${Date.now()}`, name, toolArgs) as { readonly success: boolean; readonly output?: string; readonly error?: string };
  if (!result.success) return error(result.error ?? `${name} failed.`);
  return output({ status: 'executed_model_tool', tool: name, output: result.output ?? '' });
}

export function describeLocalWorkspaceModelExecution(action: AgentWorkspaceAction): Record<string, unknown> | null {
  if (action.kind === 'local-selection') return { tool: 'agent_local_registry', domain: action.localKind, actions: ['list', 'search', 'get'], note: 'TUI selection maps to recordId for model-run local-operation actions.' };
  if (!action.localOperation) return null;
  const target = registryTarget(action.localOperation);
  if (target) return { tool: 'agent_local_registry', domain: target.domain, action: target.action, requiresRecordId: target.requiresRecordId };
  if (action.localOperation === 'note-promote-knowledge-url') return { tool: 'agent_knowledge_ingest', sourceKind: 'url', requiresRecordId: true, selectedRecordDomain: 'note' };
  return { tool: 'agent_local_registry', selectedRecordDomain: 'note', action: 'create', requiresRecordId: true };
}

export async function runLocalWorkspaceEditorAction(
  deps: AgentHarnessLocalOperationDeps,
  editor: AgentWorkspaceLocalEditor,
  args: AgentHarnessLocalOperationArgs,
): Promise<HarnessResult> {
  const fields = readFieldMap(args.fields);
  const missing = missingRequiredFields(editor, fields);
  if (missing.length > 0) {
    return output({
      status: 'missing_required_fields',
      missing,
      editor: describeEditor(editor),
    });
  }
  const confirmationError = requireConfirmed(args, 'Workspace local registry editor action');
  if (confirmationError) return error(confirmationError);
  if (
    editor.kind !== 'memory'
    && editor.kind !== 'note'
    && editor.kind !== 'persona'
    && editor.kind !== 'skill'
    && editor.kind !== 'routine'
  ) {
    return output({
      status: 'model_tool_required',
      editor: describeEditor(editor),
    });
  }
  return executeTool(
    deps.toolRegistry,
    'agent_local_registry',
    localRegistryArgsFromEditor(editor, fields, editor.recordId),
  );
}

export async function runLocalWorkspaceAction(
  deps: AgentHarnessLocalOperationDeps,
  action: AgentWorkspaceAction,
  args: AgentHarnessLocalOperationArgs,
): Promise<HarnessResult> {
  if (action.kind === 'local-selection') return output({ status: 'local_selection', action: action.id, modelExecution: describeLocalWorkspaceModelExecution(action) });
  const operation = action.localOperation;
  if (!operation) return output({ status: 'local_registry_action', action: action.id, modelExecution: describeLocalWorkspaceModelExecution(action) });
  const target = registryTarget(operation);
  const recordId = readRecordId(args);
  if (target?.requiresRecordId && !recordId) return output({ status: 'needs_record_id', action: action.id, modelExecution: describeLocalWorkspaceModelExecution(action) });
  const editor = recordId ? editorForOperation(deps.commandContext, operation, recordId) : null;
  if (editor && !hasExecutionFields(args) && args.confirm !== true) return output({ status: 'editor', action: action.id, editor: describeEditor(editor), modelExecution: describeLocalWorkspaceModelExecution(action) });
  const confirmationError = requireConfirmed(args, 'Workspace local registry action');
  if (confirmationError) return error(confirmationError);
  if (editor) {
    const fields = readFieldMap(args.fields);
    const missing = missingRequiredFields(editor, fields);
    if (missing.length > 0) return output({ status: 'missing_required_fields', missing, action: action.id, editor: describeEditor(editor) });
    if (editor.kind === 'knowledge-url') return executeTool(deps.toolRegistry, 'agent_knowledge_ingest', { sourceKind: 'url', url: fieldReader(editor, fields)('url'), tags: splitList(fieldReader(editor, fields)('tags')), folderPath: fieldReader(editor, fields)('folder'), confirm: args.confirm, explicitUserRequest: readString(args.explicitUserRequest) });
    return executeTool(deps.toolRegistry, 'agent_local_registry', localRegistryArgsFromEditor(editor, fields, recordId));
  }
  if (!target) return output({ status: 'local_registry_action', action: action.id, modelExecution: describeLocalWorkspaceModelExecution(action) });
  return executeTool(deps.toolRegistry, 'agent_local_registry', localRegistryArgsForTarget(target, args, recordId));
}

import type { AgentWorkspaceEditorKind, AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';
import type { AgentWorkspaceEditorSpecEntry } from './agent-workspace-command-editor-engine.ts';
import { createAgentWorkspaceEditorFromTable } from './agent-workspace-command-editor-engine.ts';

export type AgentWorkspaceMediaCommandEditorKind = Extract<AgentWorkspaceEditorKind, 'media-generate'>;

export function isAgentWorkspaceMediaCommandEditorKind(kind: AgentWorkspaceEditorKind): kind is AgentWorkspaceMediaCommandEditorKind {
  return kind === 'media-generate';
}

const MEDIA_COMMAND_EDITOR_SPECS: Readonly<Record<AgentWorkspaceMediaCommandEditorKind, AgentWorkspaceEditorSpecEntry<AgentWorkspaceMediaCommandEditorKind>>> = {
  'media-generate': {
    mode: 'create',
    title: 'Generate Media',
    selectedFieldIndex: 0,
    message: 'Generate image or video artifacts through a configured media provider. Type yes on the final field to confirm.',
    fields: [
      { id: 'prompt', label: 'Prompt', value: '', required: true, multiline: true, hint: 'Describe the media to generate. Ctrl-J inserts a new line.' },
      { id: 'provider', label: 'Provider', value: '', required: false, multiline: false, hint: 'Optional media provider id, such as fal, comfy, runway, alibaba, or byteplus.' },
      { id: 'model', label: 'Model', value: '', required: false, multiline: false, hint: 'Optional provider-specific media model id.' },
      { id: 'mime', label: 'Output MIME', value: '', required: false, multiline: false, hint: 'Optional output type, such as image/png or video/mp4.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /media generate with --yes.' },
    ],
  },
};

export function createAgentWorkspaceMediaCommandEditor(kind: AgentWorkspaceMediaCommandEditorKind): AgentWorkspaceLocalEditor {
  return createAgentWorkspaceEditorFromTable(kind, MEDIA_COMMAND_EDITOR_SPECS);
}

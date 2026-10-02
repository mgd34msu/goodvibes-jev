import type { AgentWorkspaceEditorKind, AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';
import type { AgentWorkspaceEditorSpec, AgentWorkspaceEditorSpecEntry } from './agent-workspace-command-editor-engine.ts';
import { createAgentWorkspaceEditorFromTable } from './agent-workspace-command-editor-engine.ts';

export type AgentWorkspaceKnowledgeCommandEditorKind = Extract<
  AgentWorkspaceEditorKind,
  | 'knowledge-get'
  | 'knowledge-map'
  | 'knowledge-connector-show'
  | 'knowledge-connector-doctor'
  | 'knowledge-review-issue'
  | 'knowledge-consolidate'
  | 'knowledge-packet'
  | 'knowledge-explain'
>;

export function isAgentWorkspaceKnowledgeCommandEditorKind(kind: AgentWorkspaceEditorKind): kind is AgentWorkspaceKnowledgeCommandEditorKind {
  return kind === 'knowledge-get'
    || kind === 'knowledge-map'
    || kind === 'knowledge-connector-show'
    || kind === 'knowledge-connector-doctor'
    || kind === 'knowledge-review-issue'
    || kind === 'knowledge-consolidate'
    || kind === 'knowledge-packet'
    || kind === 'knowledge-explain';
}

function knowledgeConnectorSpec(kind: AgentWorkspaceKnowledgeCommandEditorKind): AgentWorkspaceEditorSpec {
  const doctor = kind === 'knowledge-connector-doctor';
  return {
    mode: 'create',
    title: doctor ? 'Doctor Agent Knowledge Connector' : 'Show Agent Knowledge Connector',
    selectedFieldIndex: 0,
    message: doctor
      ? 'Run a read-only readiness doctor for one Agent Knowledge connector.'
      : 'Show one Agent Knowledge connector from the isolated Agent Knowledge connector registry.',
    fields: [
      { id: 'connectorId', label: 'Connector id', value: '', required: true, multiline: false, hint: 'Connector id from the Agent Knowledge connector inventory.' },
    ],
  };
}

function knowledgeExplainOrPacketSpec(kind: AgentWorkspaceKnowledgeCommandEditorKind): AgentWorkspaceEditorSpec {
  const explain = kind === 'knowledge-explain';
  return {
    mode: 'create',
    title: explain ? 'Explain Memory Selection' : 'Build Prompt Packet',
    selectedFieldIndex: 0,
    message: explain
      ? 'Explain which Agent Knowledge and memory context would be selected for a task.'
      : 'Build a compact Agent Knowledge prompt packet for a task.',
    fields: [
      { id: 'task', label: 'Task', value: '', required: true, multiline: true, hint: 'Task or question. Ctrl-J inserts a new line.' },
      { id: 'scopes', label: 'Scopes', value: '', required: false, multiline: false, hint: 'Optional comma-separated --scope values.' },
    ],
  };
}

const KNOWLEDGE_COMMAND_EDITOR_SPECS: Readonly<Record<AgentWorkspaceKnowledgeCommandEditorKind, AgentWorkspaceEditorSpecEntry<AgentWorkspaceKnowledgeCommandEditorKind>>> = {
  'knowledge-get': {
    mode: 'create',
    title: 'Show Agent Knowledge Item',
    selectedFieldIndex: 0,
    message: 'Show one source, node, or issue from the isolated Agent Knowledge segment.',
    fields: [
      { id: 'id', label: 'Item id', value: '', required: true, multiline: false, hint: 'Agent Knowledge source, node, or issue id.' },
    ],
  },
  'knowledge-map': {
    mode: 'create',
    title: 'Map Agent Knowledge',
    selectedFieldIndex: 0,
    message: 'Summarize the isolated Agent Knowledge graph map. Leave query blank for a bounded full map summary.',
    fields: [
      { id: 'query', label: 'Query', value: '', required: false, multiline: false, hint: 'Optional map filter query.' },
      { id: 'limit', label: 'Limit', value: '50', required: false, multiline: false, hint: 'Maximum map records to summarize.' },
    ],
  },
  'knowledge-connector-show': knowledgeConnectorSpec,
  'knowledge-connector-doctor': knowledgeConnectorSpec,
  'knowledge-review-issue': {
    mode: 'update',
    title: 'Review Agent Knowledge Issue',
    selectedFieldIndex: 0,
    message: 'Accept, reject, resolve, reopen, edit, or forget one Agent Knowledge issue. Type yes on the final field to confirm.',
    fields: [
      { id: 'issueId', label: 'Issue id', value: '', required: true, multiline: false, hint: 'Issue id from the review queue.' },
      { id: 'action', label: 'Action', value: 'resolve', required: true, multiline: false, hint: 'accept, reject, resolve, reopen, edit, or forget.' },
      { id: 'reviewer', label: 'Reviewer', value: 'agent', required: false, multiline: false, hint: 'Reviewer label. Blank defaults to agent.' },
      { id: 'value', label: 'Value JSON', value: '', required: false, multiline: true, hint: 'Optional JSON object for edit actions. Ctrl-J inserts a new line.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /knowledge review-issue with --yes.' },
    ],
  },
  'knowledge-consolidate': {
    mode: 'update',
    title: 'Consolidate Agent Knowledge',
    selectedFieldIndex: 0,
    message: 'Run isolated Agent Knowledge consolidation. Type yes on the final field to confirm.',
    fields: [
      { id: 'mode', label: 'Mode', value: 'light', required: true, multiline: false, hint: 'light or deep.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /knowledge consolidate with --yes.' },
    ],
  },
  'knowledge-explain': knowledgeExplainOrPacketSpec,
  'knowledge-packet': knowledgeExplainOrPacketSpec,
};

export function createAgentWorkspaceKnowledgeCommandEditor(kind: AgentWorkspaceKnowledgeCommandEditorKind): AgentWorkspaceLocalEditor {
  return createAgentWorkspaceEditorFromTable(kind, KNOWLEDGE_COMMAND_EDITOR_SPECS);
}

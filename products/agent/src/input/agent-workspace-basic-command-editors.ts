import type { AgentWorkspaceEditorKind, AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';
import type { AgentWorkspaceOwnerProfileEditorKind } from './agent-workspace-owner-profile-editors.ts';
import { createAgentWorkspaceOwnerProfileEditor, isAgentWorkspaceOwnerProfileEditorKind } from './agent-workspace-owner-profile-editors.ts';
import type { AgentWorkspaceAccessCommandEditorKind } from './agent-workspace-access-command-editors.ts';
import { createAgentWorkspaceAccessCommandEditor, isAgentWorkspaceAccessCommandEditorKind } from './agent-workspace-access-command-editors.ts';
import type { AgentWorkspaceChannelCommandEditorKind } from './agent-workspace-channel-command-editors.ts';
import { createAgentWorkspaceChannelCommandEditor, isAgentWorkspaceChannelCommandEditorKind } from './agent-workspace-channel-command-editors.ts';
import type { AgentWorkspaceKnowledgeCommandEditorKind } from './agent-workspace-knowledge-command-editors.ts';
import { createAgentWorkspaceKnowledgeCommandEditor, isAgentWorkspaceKnowledgeCommandEditorKind } from './agent-workspace-knowledge-command-editors.ts';
import type { AgentWorkspaceLibraryCommandEditorKind } from './agent-workspace-library-command-editors.ts';
import { createAgentWorkspaceLibraryCommandEditor, isAgentWorkspaceLibraryCommandEditorKind } from './agent-workspace-library-command-editors.ts';
import type { AgentWorkspaceMcpCommandEditorKind } from './agent-workspace-mcp-command-editors.ts';
import { createAgentWorkspaceMcpCommandEditor, isAgentWorkspaceMcpCommandEditorKind } from './agent-workspace-mcp-command-editors.ts';
import type { AgentWorkspaceMemoryCommandEditorKind } from './agent-workspace-memory-command-editors.ts';
import { createAgentWorkspaceMemoryCommandEditor, isAgentWorkspaceMemoryCommandEditorKind } from './agent-workspace-memory-command-editors.ts';
import type { AgentWorkspaceMediaCommandEditorKind } from './agent-workspace-media-command-editors.ts';
import { createAgentWorkspaceMediaCommandEditor, isAgentWorkspaceMediaCommandEditorKind } from './agent-workspace-media-command-editors.ts';
import type { AgentWorkspaceOperationsCommandEditorKind } from './agent-workspace-operations-command-editors.ts';
import { createAgentWorkspaceOperationsCommandEditor, isAgentWorkspaceOperationsCommandEditorKind } from './agent-workspace-operations-command-editors.ts';
import type { AgentWorkspaceProviderCommandEditorKind } from './agent-workspace-provider-command-editors.ts';
import { createAgentWorkspaceProviderCommandEditor, isAgentWorkspaceProviderCommandEditorKind } from './agent-workspace-provider-command-editors.ts';
import type { AgentWorkspaceSessionCommandEditorKind } from './agent-workspace-session-command-editors.ts';
import { createAgentWorkspaceSessionCommandEditor, isAgentWorkspaceSessionCommandEditorKind } from './agent-workspace-session-command-editors.ts';
import type { AgentWorkspaceSkillBundleCommandEditorKind } from './agent-workspace-skill-bundle-command-editors.ts';
import { createAgentWorkspaceSkillBundleCommandEditor, isAgentWorkspaceSkillBundleCommandEditorKind } from './agent-workspace-skill-bundle-command-editors.ts';
import type { AgentWorkspaceTaskCommandEditorKind } from './agent-workspace-task-command-editors.ts';
import { createAgentWorkspaceTaskCommandEditor, isAgentWorkspaceTaskCommandEditorKind } from './agent-workspace-task-command-editors.ts';
import type { AgentWorkspaceProfileEditorKind } from './agent-workspace-profile-editors.ts';
import { createAgentWorkspaceProfileEditor, isAgentWorkspaceProfileEditorKind } from './agent-workspace-profile-editors.ts';
import type { AgentWorkspaceEditorSpec, AgentWorkspaceEditorSpecEntry } from './agent-workspace-command-editor-engine.ts';
import { createAgentWorkspaceEditorFromTable } from './agent-workspace-command-editor-engine.ts';
export type { AgentWorkspaceBasicCommandEditorSubmission } from './agent-workspace-basic-command-editor-submission.ts';
export { buildAgentWorkspaceBasicCommandEditorSubmission } from './agent-workspace-basic-command-editor-submission.ts';

/** The kinds `createAgentWorkspaceBasicCommandEditor` builds itself, rather than delegating to a sibling domain module. */
type AgentWorkspaceBasicOwnCommandEditorKind = Extract<
  AgentWorkspaceEditorKind,
  'knowledge-file' | 'knowledge-urls' | 'knowledge-bookmarks' | 'knowledge-browser-history' | 'knowledge-connector-ingest' | 'knowledge-reindex' | 'tts-prompt' | 'image-input' | 'skill-bundle' | 'skill-discovery-import'
  | 'support-bundle-export' | 'support-bundle-inspect' | 'support-bundle-import'
  | 'subscription-inspect' | 'subscription-login-start' | 'subscription-login-finish' | 'subscription-logout'
  | 'model-pin' | 'model-unpin'
  | 'delegate-task'
  | 'workplan-add' | 'workplan-show' | 'workplan-status' | 'workplan-delete' | 'workplan-clear-completed'
  | 'persona-discovery-import'
  | 'routine-discovery-import'
  | 'skill-standard-import'
  | 'skill-standard-export'
  | 'notify-webhook' | 'notify-webhook-remove' | 'notify-webhook-clear' | 'notify-webhook-test' | 'notify-send'
  | 'secret-set' | 'secret-link' | 'secret-test' | 'secret-delete'
>;

export type AgentWorkspaceBasicCommandEditorKind = AgentWorkspaceAccessCommandEditorKind | AgentWorkspaceChannelCommandEditorKind | AgentWorkspaceKnowledgeCommandEditorKind | AgentWorkspaceLibraryCommandEditorKind | AgentWorkspaceMcpCommandEditorKind | AgentWorkspaceMemoryCommandEditorKind | AgentWorkspaceMediaCommandEditorKind | AgentWorkspaceOperationsCommandEditorKind | AgentWorkspaceOwnerProfileEditorKind | AgentWorkspaceProviderCommandEditorKind | AgentWorkspaceSessionCommandEditorKind | AgentWorkspaceSkillBundleCommandEditorKind | AgentWorkspaceTaskCommandEditorKind | AgentWorkspaceProfileEditorKind | AgentWorkspaceBasicOwnCommandEditorKind;

export function isAgentWorkspaceBasicCommandEditorKind(kind: AgentWorkspaceEditorKind): kind is AgentWorkspaceBasicCommandEditorKind {
  return isAgentWorkspaceAccessCommandEditorKind(kind)
    || isAgentWorkspaceChannelCommandEditorKind(kind)
    || isAgentWorkspaceKnowledgeCommandEditorKind(kind)
    || isAgentWorkspaceLibraryCommandEditorKind(kind)
    || isAgentWorkspaceMcpCommandEditorKind(kind)
    || isAgentWorkspaceMemoryCommandEditorKind(kind)
    || isAgentWorkspaceMediaCommandEditorKind(kind)
    || isAgentWorkspaceOperationsCommandEditorKind(kind)
    || isAgentWorkspaceOwnerProfileEditorKind(kind)
    || isAgentWorkspaceProviderCommandEditorKind(kind)
    || isAgentWorkspaceSessionCommandEditorKind(kind)
    || isAgentWorkspaceSkillBundleCommandEditorKind(kind)
    || isAgentWorkspaceTaskCommandEditorKind(kind)
    || kind === 'knowledge-bookmarks'
    || kind === 'knowledge-file'
    || kind === 'knowledge-urls'
    || kind === 'knowledge-browser-history'
    || kind === 'knowledge-connector-ingest'
    || kind === 'knowledge-reindex'
    || kind === 'tts-prompt'
    || kind === 'image-input'
    || kind === 'skill-bundle'
    || kind === 'persona-discovery-import'
    || kind === 'routine-discovery-import'
    || kind === 'skill-discovery-import'
    || kind === 'skill-standard-import'
    || kind === 'skill-standard-export'
    || isAgentWorkspaceProfileEditorKind(kind)
    || kind === 'support-bundle-export'
    || kind === 'support-bundle-inspect'
    || kind === 'support-bundle-import'
    || kind === 'subscription-inspect'
    || kind === 'subscription-login-start'
    || kind === 'subscription-login-finish'
    || kind === 'subscription-logout'
    || kind === 'model-pin'
    || kind === 'model-unpin'
    || kind === 'delegate-task'
    || kind === 'workplan-add'
    || kind === 'workplan-show'
    || kind === 'workplan-status'
    || kind === 'workplan-delete'
    || kind === 'workplan-clear-completed'
    || kind === 'notify-webhook'
    || kind === 'notify-webhook-remove'
    || kind === 'notify-webhook-clear'
    || kind === 'notify-webhook-test'
    || kind === 'notify-send'
    || kind === 'secret-set'
    || kind === 'secret-link'
    || kind === 'secret-test'
    || kind === 'secret-delete';
}

function modelPinUnpinSpec(kind: AgentWorkspaceBasicOwnCommandEditorKind): AgentWorkspaceEditorSpec {
  const pinning = kind === 'model-pin';
  return {
    mode: 'create',
    title: pinning ? 'Pin Model' : 'Unpin Model',
    selectedFieldIndex: 0,
    message: pinning
      ? 'Pin one model registry key so it is easy to reuse from the Agent TUI.'
      : 'Remove one pinned model registry key from the Agent model favorites.',
    fields: [
      {
        id: 'model',
        label: 'Model registry key',
        value: '',
        required: true,
        multiline: false,
        hint: 'Use a registry key shown by the model picker, such as openai:gpt-5.5.',
      },
    ],
  };
}

/**
 * The field-spec data table for the kinds this module builds itself (the rest are
 * delegated to sibling domain modules above). Split out of the single
 * ~600-line `createAgentWorkspaceBasicCommandEditor` if-chain into a data table, the
 * same shape used by every other agent-workspace command-editor domain.
 */
const BASIC_OWN_COMMAND_EDITOR_SPECS: Readonly<Record<AgentWorkspaceBasicOwnCommandEditorKind, AgentWorkspaceEditorSpecEntry<AgentWorkspaceBasicOwnCommandEditorKind>>> = {
  'knowledge-bookmarks': {
    mode: 'create',
    title: 'Import Bookmarks into Agent Knowledge',
    selectedFieldIndex: 0,
    message: 'Import a browser bookmark export into the isolated Agent Knowledge segment. Type yes on the final field to confirm.',
    fields: [
      { id: 'path', label: 'Bookmark export path', value: '', required: true, multiline: false, hint: 'Path to an HTML or JSON browser bookmark export.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /knowledge import-bookmarks with --yes.' },
    ],
  },
  'knowledge-file': {
    mode: 'create',
    title: 'Ingest File into Agent Knowledge',
    selectedFieldIndex: 0,
    message: 'Import a local source-backed file into the isolated Agent Knowledge segment. Type yes on the final field to confirm.',
    fields: [
      { id: 'path', label: 'File path', value: '', required: true, multiline: false, hint: 'Path to a local document or text file to ingest.' },
      { id: 'title', label: 'Title', value: '', required: false, multiline: false, hint: 'Optional source title.' },
      { id: 'tags', label: 'Tags', value: '', required: false, multiline: false, hint: 'Comma-separated optional tags.' },
      { id: 'folder', label: 'Folder', value: '', required: false, multiline: false, hint: 'Optional Agent Knowledge folder path.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /knowledge ingest-file with --yes.' },
    ],
  },
  'knowledge-urls': {
    mode: 'create',
    title: 'Import URL List into Agent Knowledge',
    selectedFieldIndex: 0,
    message: 'Import a local newline-delimited URL list into the isolated Agent Knowledge segment. Type yes on the final field to confirm.',
    fields: [
      { id: 'path', label: 'URL list path', value: '', required: true, multiline: false, hint: 'Path to a local file containing one URL per line.' },
      { id: 'allowPrivateHosts', label: 'Allow private hosts', value: '', required: false, multiline: false, hint: 'yes/no. Blank defaults to no.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /knowledge import-urls with --yes.' },
    ],
  },
  'knowledge-browser-history': {
    mode: 'create',
    title: 'Import Browser History into Agent Knowledge',
    selectedFieldIndex: 0,
    message: 'Import local browser history/bookmarks into the isolated Agent Knowledge segment. Type yes on the final field to confirm.',
    fields: [
      { id: 'browsers', label: 'Browsers', value: '', required: false, multiline: false, hint: 'Optional comma list: chrome, brave, edge, firefox, safari, etc.' },
      { id: 'sources', label: 'Sources', value: 'history,bookmark', required: false, multiline: false, hint: 'history, bookmark, or both.' },
      { id: 'limit', label: 'Limit', value: '250', required: false, multiline: false, hint: 'Maximum browser entries to import.' },
      { id: 'sinceDays', label: 'Since days', value: '', required: false, multiline: false, hint: 'Optional age window, such as 30.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /knowledge import-browser-history with --yes.' },
    ],
  },
  'knowledge-connector-ingest': {
    mode: 'create',
    title: 'Ingest Connector Input',
    selectedFieldIndex: 0,
    message: 'Send explicit connector input into the isolated Agent Knowledge segment. Type yes on the final field to confirm.',
    fields: [
      { id: 'connectorId', label: 'Connector id', value: '', required: true, multiline: false, hint: 'Connector id from /knowledge connectors.' },
      { id: 'input', label: 'Input', value: '', required: false, multiline: true, hint: 'Optional JSON or text input. Ctrl-J inserts a new line.' },
      { id: 'path', label: 'Path', value: '', required: false, multiline: false, hint: 'Optional local path for connectors that read files.' },
      { id: 'content', label: 'Content', value: '', required: false, multiline: true, hint: 'Optional raw content for connectors that accept text.' },
      { id: 'allowPrivateHosts', label: 'Allow private hosts', value: 'no', required: false, multiline: false, hint: 'yes/no. Defaults to no.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /knowledge ingest-connector with --yes.' },
    ],
  },
  'knowledge-reindex': {
    mode: 'update',
    title: 'Reindex Agent Knowledge',
    selectedFieldIndex: 0,
    message: 'Rebuild the isolated Agent Knowledge index. Type yes on the final field to confirm.',
    fields: [
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /knowledge reindex with --yes.' },
    ],
  },
  'notify-webhook': {
    mode: 'create',
    title: 'Add Notification Webhook',
    selectedFieldIndex: 0,
    message: 'Add one webhook notification target for explicit reminder/routine delivery. Type yes on the final field to confirm.',
    fields: [
      { id: 'url', label: 'Webhook URL', value: '', required: true, multiline: false, hint: 'HTTP(S) target, for example https://ntfy.sh/my-topic.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /notify add with --yes.' },
    ],
  },
  'notify-webhook-remove': {
    mode: 'delete',
    title: 'Remove Notification Webhook',
    selectedFieldIndex: 0,
    message: 'Remove one configured webhook notification target. Type yes on the final field to confirm.',
    fields: [
      { id: 'url', label: 'Webhook URL', value: '', required: true, multiline: false, hint: 'Exact HTTP(S) webhook URL to remove from configured notification targets.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /notify remove with --yes.' },
    ],
  },
  'notify-webhook-clear': {
    mode: 'delete',
    title: 'Clear Notification Webhooks',
    selectedFieldIndex: 0,
    message: 'Remove every configured webhook notification target. Type yes on the final field to confirm.',
    fields: [
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /notify clear with --yes.' },
    ],
  },
  'notify-webhook-test': {
    mode: 'create',
    title: 'Test Notification Webhooks',
    selectedFieldIndex: 0,
    message: 'Send one test notification to configured webhook targets. Type yes on the final field to confirm.',
    fields: [
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /notify test with --yes.' },
    ],
  },
  'notify-send': {
    mode: 'create',
    title: 'Send Notification',
    selectedFieldIndex: 0,
    message: 'Send one message to configured Agent notification webhook targets. Type yes on the final field to confirm.',
    fields: [
      { id: 'message', label: 'Message', value: '', required: true, multiline: true, hint: 'Plain-text message to send. Ctrl-J inserts a new line.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /notify send with --yes.' },
    ],
  },
  'secret-set': {
    mode: 'create',
    title: 'Store Secret Value',
    selectedFieldIndex: 0,
    message: 'Store one secret value through the Agent secret manager. The value is masked in this workspace. Type yes on the final field to confirm.',
    fields: [
      { id: 'key', label: 'Secret key', value: '', required: true, multiline: false, hint: 'Environment-style key, such as OPENAI_API_KEY.' },
      { id: 'value', label: 'Secret value', value: '', required: true, multiline: false, hint: 'Raw value to store. It is masked here and never rendered in action results.', redact: true },
      { id: 'scope', label: 'Scope', value: '', required: false, multiline: false, hint: 'project or user. Blank defaults to project.' },
      { id: 'storage', label: 'Storage', value: '', required: false, multiline: false, hint: 'secure or plaintext. Blank defaults to secure.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to store the secret value.' },
    ],
  },
  'secret-link': {
    mode: 'create',
    title: 'Link Secret Reference',
    selectedFieldIndex: 0,
    message: 'Link one key to an external goodvibes://secrets/... reference. Type yes on the final field to confirm.',
    fields: [
      { id: 'key', label: 'Secret key', value: '', required: true, multiline: false, hint: 'Environment-style key, such as SLACK_BOT_TOKEN.' },
      { id: 'ref', label: 'Secret ref', value: '', required: true, multiline: false, hint: 'goodvibes://secrets/... reference from a supported provider.' },
      { id: 'scope', label: 'Scope', value: '', required: false, multiline: false, hint: 'project or user. Blank defaults to project.' },
      { id: 'storage', label: 'Storage', value: '', required: false, multiline: false, hint: 'secure or plaintext. Blank defaults to secure.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to link the secret reference.' },
    ],
  },
  'secret-test': {
    mode: 'create',
    title: 'Test Secret Reference',
    selectedFieldIndex: 0,
    message: 'Resolve one goodvibes://secrets/... reference and show only resolved/missing status. Type yes on the final field to confirm.',
    fields: [
      { id: 'ref', label: 'Secret ref', value: '', required: true, multiline: false, hint: 'goodvibes://secrets/... reference to test without printing its value.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to test the secret reference.' },
    ],
  },
  'secret-delete': {
    mode: 'delete',
    title: 'Delete Stored Secret',
    selectedFieldIndex: 0,
    message: 'Delete one stored secret key from the selected scope and storage mode. Type yes on the final field to confirm.',
    fields: [
      { id: 'key', label: 'Secret key', value: '', required: true, multiline: false, hint: 'Stored key to delete.' },
      { id: 'scope', label: 'Scope', value: '', required: false, multiline: false, hint: 'Optional project or user. Blank lets the command choose the matching stored key.' },
      { id: 'storage', label: 'Storage', value: '', required: false, multiline: false, hint: 'Optional secure or plaintext.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to delete the stored secret key.' },
    ],
  },
  'tts-prompt': {
    mode: 'create',
    title: 'Speak Assistant Reply',
    selectedFieldIndex: 0,
    message: 'Submit a normal assistant prompt and play the reply through configured live TTS.',
    fields: [
      { id: 'prompt', label: 'Prompt', value: '', required: true, multiline: true, hint: 'Assistant prompt to speak. Ctrl-J inserts a new line.' },
    ],
  },
  'image-input': {
    mode: 'create',
    title: 'Attach Image Input',
    selectedFieldIndex: 0,
    message: 'Attach an image to the next assistant turn. The existing image command validates file type and model support.',
    fields: [
      { id: 'path', label: 'Image path', value: '', required: true, multiline: false, hint: 'PNG, JPEG, WebP, or GIF path under the current workspace.' },
      { id: 'prompt', label: 'Prompt', value: '', required: false, multiline: true, hint: 'Optional prompt. Ctrl-J inserts a new line.' },
    ],
  },
  'model-pin': modelPinUnpinSpec,
  'model-unpin': modelPinUnpinSpec,
  'support-bundle-export': {
    mode: 'create',
    title: 'Export Agent Support Bundle',
    selectedFieldIndex: 0,
    message: 'Export a redacted Agent support bundle from this workspace. Type yes on the final field to confirm.',
    fields: [
      { id: 'path', label: 'Output path', value: 'goodvibes-agent-bundle.json', required: true, multiline: false, hint: 'Workspace-relative JSON path to write.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /bundle export with --yes.' },
    ],
  },
  'support-bundle-inspect': {
    mode: 'create',
    title: 'Inspect Agent Support Bundle',
    selectedFieldIndex: 0,
    message: 'Inspect a redacted Agent support bundle before import or sharing.',
    fields: [
      { id: 'path', label: 'Bundle path', value: 'goodvibes-agent-bundle.json', required: true, multiline: false, hint: 'Workspace-relative bundle JSON path.' },
    ],
  },
  'support-bundle-import': {
    mode: 'update',
    title: 'Import Agent Support Bundle',
    selectedFieldIndex: 0,
    message: 'Import non-redacted config values from a reviewed Agent support bundle. Type yes on the final field to confirm.',
    fields: [
      { id: 'path', label: 'Bundle path', value: 'goodvibes-agent-bundle.json', required: true, multiline: false, hint: 'Workspace-relative bundle JSON path to import.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /bundle import with --yes.' },
    ],
  },
  'subscription-inspect': {
    mode: 'create',
    title: 'Inspect Provider Subscription',
    selectedFieldIndex: 0,
    message: 'Inspect one provider subscription route without starting login or printing token values.',
    fields: [
      { id: 'provider', label: 'Provider', value: 'openai', required: true, multiline: false, hint: 'Subscription provider id, such as openai.' },
    ],
  },
  'subscription-login-start': {
    mode: 'create',
    title: 'Start Provider Subscription Login',
    selectedFieldIndex: 0,
    message: 'Begin one provider subscription OAuth login, save the pending session, and return here for completion.',
    fields: [
      { id: 'provider', label: 'Provider', value: 'openai', required: true, multiline: false, hint: 'Subscription provider id, such as openai.' },
      { id: 'openBrowser', label: 'Open browser', value: 'yes', required: false, multiline: false, hint: 'yes/no. Use no to print the authorization URL only.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to save pending login state and open or show the authorization URL.' },
    ],
  },
  'subscription-login-finish': {
    mode: 'update',
    title: 'Finish Provider Subscription Login',
    selectedFieldIndex: 0,
    message: 'Finish a pending provider subscription OAuth login from a code or redirected URL and save the subscription session.',
    fields: [
      { id: 'provider', label: 'Provider', value: 'openai', required: true, multiline: false, hint: 'Provider id used when starting login.' },
      { id: 'code', label: 'Code or redirect URL', value: '', required: true, multiline: false, hint: 'OAuth code or full redirect URL containing code=...' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to exchange the code and save the provider subscription session.' },
    ],
  },
  'subscription-logout': {
    mode: 'delete',
    title: 'Logout Provider Subscription',
    selectedFieldIndex: 0,
    message: 'Remove one active or pending provider subscription session. Ambient API key resolution applies again if configured.',
    fields: [
      { id: 'provider', label: 'Provider', value: 'openai', required: true, multiline: false, hint: 'Stored subscription provider id.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to remove active or pending subscription state.' },
    ],
  },
  'delegate-task': {
    mode: 'create',
    title: 'Delegate Build Work to GoodVibes TUI',
    selectedFieldIndex: 0,
    message: 'Send one explicit build/fix/review task to GoodVibes TUI/shared-session routes with a visible handoff brief. Type yes on the final field to confirm.',
    fields: [
      { id: 'task', label: 'Original task', value: '', required: true, multiline: true, hint: 'Paste the full original user ask. Ctrl-J inserts a new line.' },
      { id: 'reason', label: 'Why delegate', value: '', required: false, multiline: true, hint: 'Isolation, remote host, separate worktree, parallelism, TUI workflow, or review need. Ctrl-J inserts a new line.' },
      { id: 'success', label: 'Success criteria', value: '', required: false, multiline: true, hint: 'Expected evidence: diff, tests, artifact, findings, or completion signal. Ctrl-J inserts a new line.' },
      { id: 'workspace', label: 'Workspace hint', value: '', required: false, multiline: false, hint: 'Optional target workspace, branch, worktree, machine, or package.' },
      { id: 'priority', label: 'Priority', value: '', required: false, multiline: false, hint: 'Optional priority, deadline, or sequencing note.' },
      { id: 'review', label: 'Request delegated review', value: '', required: false, multiline: false, hint: 'yes/no. Blank means no delegated review request.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /delegate for this task.' },
    ],
  },
  'workplan-add': {
    mode: 'create',
    title: 'Add Work Plan Item',
    selectedFieldIndex: 0,
    message: 'Create one visible work plan item from the Agent workspace.',
    fields: [
      { id: 'title', label: 'Title', value: '', required: true, multiline: true, hint: 'Task title. Ctrl-J inserts a new line.' },
      { id: 'owner', label: 'Owner', value: '', required: false, multiline: false, hint: 'Optional owner label.' },
      { id: 'source', label: 'Source', value: '', required: false, multiline: false, hint: 'Optional source label. Blank defaults to manual.' },
      { id: 'notes', label: 'Notes', value: '', required: false, multiline: true, hint: 'Optional notes. Ctrl-J inserts a new line.' },
    ],
  },
  'workplan-show': {
    mode: 'create',
    title: 'Show Work Plan Detail',
    selectedFieldIndex: 0,
    message: 'Print the detailed work plan from the Agent workspace without mutating work state.',
    fields: [
      { id: 'format', label: 'Format', value: '', required: false, multiline: false, hint: 'Optional. Blank uses the default detail view; markdown also works.' },
    ],
  },
  'workplan-status': {
    mode: 'update',
    title: 'Update Work Plan Status',
    selectedFieldIndex: 0,
    message: 'Update one visible work plan item status from the Agent workspace.',
    fields: [
      { id: 'id', label: 'Work item id', value: '', required: true, multiline: false, hint: 'Existing work plan item id.' },
      { id: 'status', label: 'Status', value: '', required: true, multiline: false, hint: 'pending, start, blocked, done, failed, or cancelled.' },
    ],
  },
  'workplan-delete': {
    mode: 'delete',
    title: 'Remove Work Plan Item',
    selectedFieldIndex: 0,
    message: 'Remove one work plan item. Type yes on the final field to confirm.',
    fields: [
      { id: 'id', label: 'Work item id', value: '', required: true, multiline: false, hint: 'Existing work plan item id.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /workplan remove with --yes.' },
    ],
  },
  'workplan-clear-completed': {
    mode: 'delete',
    title: 'Clear Completed Work Plan Items',
    selectedFieldIndex: 0,
    message: 'Clear completed and cancelled work plan items. Type yes to confirm.',
    fields: [
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /workplan clear-completed with --yes.' },
    ],
  },
  'skill-discovery-import': {
    mode: 'create',
    title: 'Import Discovered Skill',
    selectedFieldIndex: 0,
    message: 'Import one discovered SKILL.md or .md skill file into the Agent-local skill registry. Type yes on the final field to confirm.',
    fields: [
      { id: 'name', label: 'Discovered skill', value: '', required: true, multiline: false, hint: 'Name shown by /skills discover.' },
      { id: 'enabled', label: 'Enable now', value: 'yes', required: false, multiline: false, hint: 'yes/no.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /skills import-discovered with --yes.' },
    ],
  },
  'persona-discovery-import': {
    mode: 'create',
    title: 'Import Discovered Persona',
    selectedFieldIndex: 0,
    message: 'Import one discovered persona markdown file into the Agent-local persona registry. Type yes on the final field to confirm.',
    fields: [
      { id: 'name', label: 'Discovered persona', value: '', required: true, multiline: false, hint: 'Name shown by /personas discover.' },
      { id: 'use', label: 'Use now', value: 'yes', required: false, multiline: false, hint: 'yes/no.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /personas import-discovered with --yes.' },
    ],
  },
  'routine-discovery-import': {
    mode: 'create',
    title: 'Import Discovered Routine',
    selectedFieldIndex: 0,
    message: 'Import one discovered routine markdown file into the Agent-local routine registry. Type yes on the final field to confirm.',
    fields: [
      { id: 'name', label: 'Discovered routine', value: '', required: true, multiline: false, hint: 'Name shown by /routines discover.' },
      { id: 'enabled', label: 'Enable now', value: 'yes', required: false, multiline: false, hint: 'yes/no.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /routines import-discovered with --yes.' },
    ],
  },
  'skill-standard-import': {
    mode: 'create',
    title: 'Import Shared Skill',
    selectedFieldIndex: 0,
    message: 'Import one SKILL.md file in the open skill format into the Agent-local skill library. The skill will wait for your review before it can be enabled.',
    fields: [
      { id: 'path', label: 'Path to SKILL.md', value: '', required: true, multiline: false, hint: 'Full path to a SKILL.md file.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to import with --yes.' },
    ],
  },
  'skill-standard-export': {
    mode: 'create',
    title: 'Export Skill to Share',
    selectedFieldIndex: 0,
    message: 'Export one Agent-local skill as a SKILL.md folder you can publish or hand to another assistant.',
    fields: [
      { id: 'id', label: 'Skill id or name', value: '', required: true, multiline: false, hint: 'Local skill id or name.' },
      { id: 'dest', label: 'Destination folder', value: '', required: true, multiline: false, hint: 'Directory to write <slug>/SKILL.md into.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to export with --yes.' },
    ],
  },
  'skill-bundle': {
    mode: 'create',
    title: 'Create Skill Bundle',
    selectedFieldIndex: 0,
    message: 'Group existing local skills into a reviewable bundle that can be enabled together.',
    fields: [
      { id: 'name', label: 'Bundle name', value: '', required: true, multiline: false, hint: 'Short bundle name.' },
      { id: 'description', label: 'Description', value: '', required: true, multiline: false, hint: 'One-line bundle summary.' },
      { id: 'skills', label: 'Skill ids', value: '', required: true, multiline: false, hint: 'Comma-separated existing local skill ids.' },
      { id: 'enabled', label: 'Enable now', value: 'yes', required: false, multiline: false, hint: 'yes/no.' },
    ],
  },
};

export function createAgentWorkspaceBasicCommandEditor(kind: AgentWorkspaceBasicCommandEditorKind): AgentWorkspaceLocalEditor {
  if (isAgentWorkspaceAccessCommandEditorKind(kind)) {
    return createAgentWorkspaceAccessCommandEditor(kind);
  }
  if (isAgentWorkspaceChannelCommandEditorKind(kind)) {
    return createAgentWorkspaceChannelCommandEditor(kind);
  }
  if (isAgentWorkspaceKnowledgeCommandEditorKind(kind)) {
    return createAgentWorkspaceKnowledgeCommandEditor(kind);
  }
  if (isAgentWorkspaceLibraryCommandEditorKind(kind)) {
    return createAgentWorkspaceLibraryCommandEditor(kind);
  }
  if (isAgentWorkspaceMcpCommandEditorKind(kind)) {
    return createAgentWorkspaceMcpCommandEditor(kind);
  }
  if (isAgentWorkspaceMemoryCommandEditorKind(kind)) {
    return createAgentWorkspaceMemoryCommandEditor(kind);
  }
  if (isAgentWorkspaceMediaCommandEditorKind(kind)) {
    return createAgentWorkspaceMediaCommandEditor(kind);
  }
  if (isAgentWorkspaceOperationsCommandEditorKind(kind)) {
    return createAgentWorkspaceOperationsCommandEditor(kind);
  }
  if (isAgentWorkspaceOwnerProfileEditorKind(kind)) {
    return createAgentWorkspaceOwnerProfileEditor(kind);
  }
  if (isAgentWorkspaceProviderCommandEditorKind(kind)) {
    return createAgentWorkspaceProviderCommandEditor(kind);
  }
  if (isAgentWorkspaceSessionCommandEditorKind(kind)) {
    return createAgentWorkspaceSessionCommandEditor(kind);
  }
  if (isAgentWorkspaceSkillBundleCommandEditorKind(kind)) {
    return createAgentWorkspaceSkillBundleCommandEditor(kind);
  }
  if (isAgentWorkspaceTaskCommandEditorKind(kind)) {
    return createAgentWorkspaceTaskCommandEditor(kind);
  }
  if (isAgentWorkspaceProfileEditorKind(kind)) {
    return createAgentWorkspaceProfileEditor(kind);
  }
  return createAgentWorkspaceEditorFromTable(kind as AgentWorkspaceBasicOwnCommandEditorKind, BASIC_OWN_COMMAND_EDITOR_SPECS);
}

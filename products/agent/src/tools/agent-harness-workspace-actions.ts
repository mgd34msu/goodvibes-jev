import type { CommandContext } from '../input/command-registry.ts';
import { createAgentWorkspaceEditor } from '../input/agent-workspace-activation.ts';
import { AGENT_WORKSPACE_CATEGORIES } from '../input/agent-workspace-categories.ts';
import { searchAgentWorkspaceActions } from '../input/agent-workspace-search.ts';
import { buildAgentWorkspaceRuntimeSnapshot } from '../input/agent-workspace-snapshot.ts';
import type { AgentWorkspaceAction, AgentWorkspaceCategory, AgentWorkspaceEditorKind, AgentWorkspaceLocalEditor, AgentWorkspaceLocalLibraryItem, AgentWorkspaceRuntimeSnapshot } from '../input/agent-workspace-types.ts';
import { parseSlashCommand } from '../input/slash-command-parser.ts';
import { describeCommandPolicy } from './agent-harness-metadata.ts';
import { describeLocalWorkspaceModelExecution } from './agent-harness-local-operations.ts';
import { describeWorkspaceEditorModelExecution } from './agent-harness-workspace-editor-execution.ts';

export { AGENT_WORKSPACE_CATEGORIES };

export interface AgentHarnessWorkspaceActionArgs {
  readonly query?: unknown;
  readonly command?: unknown;
  readonly actionId?: unknown;
  readonly recordId?: unknown;
  readonly fields?: unknown;
  readonly target?: unknown;
  readonly category?: unknown;
  readonly categoryId?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

export interface WorkspaceEditorContext {
  readonly runtimeStarterTemplates: AgentWorkspaceRuntimeSnapshot['runtimeStarterTemplates'];
  readonly selectedRoutine: AgentWorkspaceLocalLibraryItem | null;
  readonly recentReviewerHandoffArtifacts: AgentWorkspaceRuntimeSnapshot['recentReviewerHandoffArtifacts'];
  readonly reviewPacketDefaults: AgentWorkspaceRuntimeSnapshot['reviewPacketDefaults'] | null;
  readonly calendarOAuthConfigStatus: AgentWorkspaceRuntimeSnapshot['calendarOAuthConfigStatus'] | null;
}

export interface WorkspaceActionLookup {
  readonly source: 'actionId' | 'command' | 'target' | 'query';
  readonly input: string;
  readonly resolvedBy: 'id' | 'case-insensitive-id' | 'label' | 'case-insensitive-label' | 'command' | 'search';
}

export type WorkspaceActionResolution =
  | {
    readonly status: 'found';
    readonly category: AgentWorkspaceCategory;
    readonly action: AgentWorkspaceAction;
    readonly lookup: WorkspaceActionLookup;
  }
  | {
    readonly status: 'ambiguous';
    readonly input: string;
    readonly candidates: readonly { readonly actionId: string; readonly categoryId: string; readonly label: string; readonly command?: string }[];
  };

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(1000, Math.trunc(parsed)));
}

function readFieldMap(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, typeof entry === 'string' ? entry : String(entry)]));
}

export function allWorkspaceActions(): ReadonlyArray<{
  readonly category: AgentWorkspaceCategory;
  readonly action: AgentWorkspaceAction;
}> {
  return AGENT_WORKSPACE_CATEGORIES.flatMap((category) => category.actions.map((action) => ({ category, action })));
}

export function describeWorkspaceCategory(category: AgentWorkspaceCategory): Record<string, unknown> {
  return {
    id: category.id,
    group: category.group,
    label: category.label,
    summary: category.summary,
    detail: category.detail,
    actions: category.actions.length,
  };
}

export function describeWorkspaceEditor(editor: AgentWorkspaceLocalEditor): Record<string, unknown> {
  return {
    kind: editor.kind,
    mode: editor.mode,
    title: editor.title,
    message: editor.message,
    fields: editor.fields.map((field) => ({
      id: field.id,
      label: field.label,
      required: field.required,
      multiline: field.multiline,
      hint: field.hint,
      redact: field.redact === true,
      default: field.redact ? '<redacted>' : field.value,
    })),
  };
}

function previewText(value: string, maxLength = 56): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function commandRouteHint(command: string): string {
  const parsed = parseSlashCommand(command);
  const commandName = parsed.name || command.replace(/^\//, '').trim().split(/\s+/)[0] || command;
  return describeCommandPolicy(commandName).preferredModelTool ?? `workspace action:"run_command" commandName:"${commandName}"`;
}

function editorRouteHint(editorKind: AgentWorkspaceEditorKind): string {
  if (
    editorKind === 'memory'
    || editorKind === 'note'
    || editorKind === 'persona'
    || editorKind === 'skill'
    || editorKind === 'routine'
  ) return 'agent_local_registry';
  if (
    editorKind === 'knowledge-url'
    || editorKind === 'knowledge-urls'
    || editorKind === 'knowledge-file'
    || editorKind === 'knowledge-bookmarks'
    || editorKind === 'knowledge-browser-history'
    || editorKind === 'knowledge-connector-ingest'
  ) return 'agent_knowledge_ingest';
  if (
    editorKind === 'knowledge-reindex'
    || editorKind === 'knowledge-review-issue'
    || editorKind === 'knowledge-consolidate'
  ) return 'workspace action:"run"';
  if (editorKind.startsWith('knowledge-')) return 'agent_knowledge';
  if (
    editorKind === 'document-review-packet-preset'
    || editorKind === 'document-review-packet-preset-refresh'
  ) return 'agent_review_packet_presets';
  if (editorKind === 'document-review-packet-share') return 'agent_review_packet_share';
  if (editorKind.startsWith('document-')) return 'agent_documents';
  if (
    editorKind === 'artifact-browser'
    || editorKind === 'artifact-show'
    || editorKind === 'artifact-export-file'
    || editorKind === 'artifact-export-package'
  ) return 'agent_artifacts';
  if (editorKind === 'artifact-promote-knowledge') return 'agent_knowledge_ingest';
  if (editorKind === 'web-research' || editorKind === 'web-fetch') return 'main conversation prompt';
  if (editorKind === 'research-run') return 'research action:"create_run"';
  if (editorKind === 'research-source') return 'research action:"add_source"';
  if (editorKind === 'research-report') return 'research action:"report"';
  if (editorKind === 'media-generate') return 'agent_media_generate';
  if (
    editorKind === 'model-compare'
    || editorKind === 'local-model-benchmark'
    || editorKind === 'model-compare-review'
    || editorKind === 'model-compare-judge'
    || editorKind === 'model-compare-apply'
    || editorKind === 'model-compare-route-decision'
    || editorKind === 'model-compare-export'
    || editorKind === 'model-compare-analytics'
  ) return 'agent_model_compare';
  if (editorKind === 'channel-send') return 'agent_channel_send';
  if (editorKind === 'notify-send' || editorKind === 'notify-webhook-test') return 'agent_notify';
  if (editorKind === 'reminder-schedule') return 'schedule action:"remind"';
  if (editorKind === 'schedule-edit') return 'schedule action:"edit"';
  if (editorKind === 'schedule-run') return 'schedule action:"run"';
  if (
    editorKind.startsWith('approval-')
    || editorKind.startsWith('automation-')
  ) return 'agent_operator_action';
  if (editorKind.startsWith('workplan-') || editorKind.startsWith('plan-') || editorKind.startsWith('task-')) return 'agent_work_plan';
  return 'agent_harness mode:"run_workspace_action"';
}

function localActionRouteHint(action: AgentWorkspaceAction): string {
  const modelExecution = describeLocalWorkspaceModelExecution(action);
  const tool = modelExecution && typeof modelExecution.tool === 'string' ? modelExecution.tool : '';
  return tool || 'agent_local_registry';
}

function workspaceActionRouteHint(action: AgentWorkspaceAction): string {
  if (action.kind === 'settings-import') return 'settings action:"import"';
  if (action.kind === 'setup-checkpoint') {
    if (action.setupCheckpointOperation === 'mark-current') return 'agent_harness mode:"mark_setup_checkpoint" confirm:true explicitUserRequest:"..."';
    if (action.setupCheckpointOperation === 'clear') return 'agent_harness mode:"clear_setup_checkpoint" confirm:true explicitUserRequest:"..."';
    return 'agent_harness mode:"setup_checkpoint"';
  }
  if (action.id === 'account-route-readiness') return 'models action:"status" includeParameters:true';
  if (action.id === 'account-local-model-cookbook') return 'models action:"local"';
  if (action.id === 'account-local-server-health') return 'models action:"smoke" confirm:true';
  if (action.id === 'account-run-local-model-benchmark') return 'agent_model_compare';
  if (action.id === 'account-local-benchmark-evidence') return 'models action:"local" includeParameters:true';
  if (action.id === 'assistant-browser-cockpit') return 'computer action:"open_browser"';
  if (action.id === 'research-briefing') return 'research action:"briefing"';
  if (action.id === 'research-workflow-plan') return 'research action:"plan"';
  if (action.id === 'research-runner-readiness') return 'research action:"runner"';
  if (action.id === 'research-run-queue') return 'research action:"runs"';
  if (action.id === 'research-public-search') return 'research action:"search"';
  if (action.id === 'research-source-queue') return 'research action:"sources"';
  if (action.id === 'research-report-artifacts') return 'research action:"reports"';
  if (action.id === 'work-background-processes') return 'execution action:"processes"';
  if (action.id === 'work-process-capabilities') return 'process action:"capabilities"';
  if (action.id === 'context-project-files') return 'context action:"files"';
  if (action.id === 'context-project-file') return 'context action:"file"';
  if (action.id === 'context-prompt-context') return 'context action:"prompt" includeParameters:true';
  if (action.id === 'voice-workflow-posture') return 'device action:"voice"';
  if (action.id === 'device-capability-map') return 'device action:"status"';
  if (action.id === 'browser-cockpit-readiness') return 'computer action:"browser"';
  if (action.id === 'personal-ops-briefing') return 'personal_ops action:"briefing"';
  if (action.id === 'personal-ops-queue') return 'personal_ops action:"queue"';
  if (action.id === 'personal-ops-intake') return 'personal_ops action:"intake"';
  if (
    action.id === 'personal-ops-autonomy-queue'
    || action.id === 'work-autonomy-queue'
    || action.id === 'schedule-autonomy-queue'
  ) return 'autonomy action:"queue"';
  if (action.id === 'memory-learning-curator') return 'memory action:"curator"';
  if (action.id === 'memory-prompt-plan') return 'memory action:"curator" includeParameters:true';
  if (action.id === 'memory-posture') return 'memory action:"status"';
  if (action.command) return commandRouteHint(action.command);
  if (action.editorKind) return editorRouteHint(action.editorKind);
  if (action.kind === 'local-selection' || action.kind === 'local-operation') return localActionRouteHint(action);
  // Compatibility detail route remains: agent_harness mode:"open_ui_surface".
  if (action.targetCategoryId || action.kind === 'workspace') return 'workspace action:"open"';
  if (action.kind === 'guidance') return action.safety === 'blocked' ? 'main conversation policy' : 'main conversation';
  return 'workspace action:"action"';
}

function selectedRoutineFromArgs(
  snapshot: AgentWorkspaceRuntimeSnapshot,
  args: AgentHarnessWorkspaceActionArgs,
): AgentWorkspaceLocalLibraryItem | null {
  const fields = readFieldMap(args.fields);
  const routineId = readString(args.recordId) || readString(fields.routineId) || readString(fields.id);
  if (!routineId) return null;
  return snapshot.localRoutines.find((routine) => routine.id === routineId || routine.name.toLowerCase() === routineId.toLowerCase()) ?? null;
}

export function buildWorkspaceEditorContext(context: CommandContext, args: AgentHarnessWorkspaceActionArgs): WorkspaceEditorContext {
  try {
    const snapshot = buildAgentWorkspaceRuntimeSnapshot(context);
    return {
      runtimeStarterTemplates: snapshot.runtimeStarterTemplates,
      selectedRoutine: selectedRoutineFromArgs(snapshot, args),
      recentReviewerHandoffArtifacts: snapshot.recentReviewerHandoffArtifacts,
      reviewPacketDefaults: snapshot.reviewPacketDefaults,
      calendarOAuthConfigStatus: snapshot.calendarOAuthConfigStatus,
    };
  } catch {
    return {
      runtimeStarterTemplates: [],
      selectedRoutine: null,
      recentReviewerHandoffArtifacts: [],
      reviewPacketDefaults: null,
      calendarOAuthConfigStatus: null,
    };
  }
}

export function createWorkspaceEditor(
  editorKind: AgentWorkspaceEditorKind,
  editorContext: WorkspaceEditorContext | null,
): AgentWorkspaceLocalEditor | null {
  return createAgentWorkspaceEditor(editorKind, {
    runtimeStarterTemplates: editorContext?.runtimeStarterTemplates ?? [],
    selectedRoutine: editorKind === 'routine-schedule' ? editorContext?.selectedRoutine ?? null : null,
    recentReviewerHandoffArtifacts: editorContext?.recentReviewerHandoffArtifacts ?? [],
    reviewPacketDefaults: editorContext?.reviewPacketDefaults ?? null,
    calendarOAuthConfigStatus: editorContext?.calendarOAuthConfigStatus ?? null,
  });
}

export function describeWorkspaceAction(
  category: AgentWorkspaceCategory,
  action: AgentWorkspaceAction,
  options: { readonly includeEditor?: boolean; readonly editorContext?: WorkspaceEditorContext | null; readonly lookup?: WorkspaceActionLookup } = {},
): Record<string, unknown> {
  const editor = options.includeEditor && action.editorKind ? createWorkspaceEditor(action.editorKind, options.editorContext ?? null) : null;
  return {
    id: action.id,
    categoryId: category.id,
    category: category.label,
    group: category.group,
    label: action.label,
    detail: action.detail,
    kind: action.kind,
    safety: action.safety,
    modelRoute: previewText(workspaceActionRouteHint(action), 72),
    ...(action.command ? { command: action.command } : {}),
    ...(action.targetCategoryId ? { targetCategoryId: action.targetCategoryId } : {}),
    ...(action.editorKind ? { editorKind: action.editorKind } : {}),
    ...(action.localKind ? { localKind: action.localKind } : {}),
    ...(action.localOperation ? { localOperation: action.localOperation } : {}),
    ...(options.lookup ? { lookup: options.lookup } : {}),
    ...(editor ? { editor: describeWorkspaceEditor(editor) } : {}),
    ...(action.kind === 'settings-import' ? {
      modelExecution: {
        route: 'settings-import',
        dispatcher: 'run_workspace_action',
        confirmation: 'required',
        preview: 'available-without-confirmation',
        note: 'Imports only Agent-owned shared GoodVibes settings and provider subscription state after explicit user confirmation.',
      },
    } : {}),
    ...(action.kind === 'setup-checkpoint' ? {
      setupCheckpointOperation: action.setupCheckpointOperation ?? 'show',
      modelExecution: {
        route: action.setupCheckpointOperation === 'mark-current'
          ? 'mark_setup_checkpoint'
          : action.setupCheckpointOperation === 'clear'
            ? 'clear_setup_checkpoint'
            : 'setup_checkpoint',
        dispatcher: 'agent_harness',
        confirmation: action.setupCheckpointOperation === 'show' ? 'not-required' : 'required',
        note: 'Setup wizard checkpoints persist only the visible current setup step in Agent-owned state so first-run setup can resume across restarts.',
      },
    } : {}),
    ...(action.id === 'assistant-browser-cockpit' ? {
      modelExecution: {
        route: 'open_ui_surface',
        surfaceId: 'connected-browser-cockpit',
        confirmation: 'required',
        readinessRoute: 'agent_harness mode:"ui_surface" surfaceId:"connected-browser-cockpit" includeParameters:true',
        fallback: 'Inspect host action:"service" endpointId:"web" or host action:"services" when the web cockpit is not enabled.',
        note: 'Opens the connected-host browser/PWA cockpit through the configured web route; readiness inspection also reports certified workspace category coverage, mobile/PWA controls, and first-run receipt evidence without creating a separate Agent-hosted web app.',
      },
    } : {}),
    ...(action.kind === 'local-selection' || action.kind === 'local-operation' ? {
      modelExecution: describeLocalWorkspaceModelExecution(action),
    } : {}),
    ...(action.kind === 'editor' && action.editorKind ? {
      modelExecution: describeWorkspaceEditorModelExecution(action.editorKind),
    } : {}),
  };
}

function describeWorkspaceActionSummary(
  category: AgentWorkspaceCategory,
  action: AgentWorkspaceAction,
): Record<string, unknown> {
  return {
    id: action.id,
    categoryId: category.id,
    category: category.label,
    group: category.group,
    label: action.label,
    summary: previewText(action.detail),
    kind: action.kind,
    safety: action.safety,
    modelRoute: previewText(workspaceActionRouteHint(action), 72),
    ...(action.command ? { command: action.command } : {}),
    ...(action.targetCategoryId ? { targetCategoryId: action.targetCategoryId } : {}),
    ...(action.editorKind ? { editorKind: action.editorKind } : {}),
    ...(action.localKind ? { localKind: action.localKind } : {}),
    ...(action.localOperation ? { localOperation: action.localOperation } : {}),
  };
}

export function listWorkspaceActions(
  context: CommandContext,
  args: AgentHarnessWorkspaceActionArgs,
): readonly Record<string, unknown>[] {
  const query = readString(args.query);
  const categoryId = readString(args.categoryId || args.category);
  const limit = readLimit(args.limit, 1000);
  const includeEditor = args.includeParameters === true;
  const editorContext = includeEditor ? buildWorkspaceEditorContext(context, args) : null;
  const source = query
    ? searchAgentWorkspaceActions(AGENT_WORKSPACE_CATEGORIES, query).map((result) => ({ category: result.category, action: result.action }))
    : allWorkspaceActions();
  return source
    .filter((entry) => !categoryId || entry.category.id === categoryId)
    .slice(0, limit)
    .map((entry) => includeEditor
      ? describeWorkspaceAction(entry.category, entry.action, { includeEditor, editorContext })
      : describeWorkspaceActionSummary(entry.category, entry.action));
}

function workspaceActionLookupFromArgs(args: AgentHarnessWorkspaceActionArgs): { readonly source: WorkspaceActionLookup['source']; readonly input: string } | null {
  const actionId = readString(args.actionId);
  if (actionId) return { source: 'actionId', input: actionId };
  const command = readString(args.command);
  if (command) return { source: 'command', input: command };
  const target = readString(args.target);
  if (target) return { source: 'target', input: target };
  const query = readString(args.query);
  return query ? { source: 'query', input: query } : null;
}

function describeWorkspaceActionCandidates(
  entries: readonly { readonly category: AgentWorkspaceCategory; readonly action: AgentWorkspaceAction }[],
): readonly { readonly actionId: string; readonly categoryId: string; readonly label: string; readonly command?: string }[] {
  return entries.slice(0, 8).map((entry) => ({
    actionId: entry.action.id,
    categoryId: entry.category.id,
    label: entry.action.label,
    ...(entry.action.command ? { command: entry.action.command } : {}),
  }));
}

export function resolveWorkspaceActionDetail(args: AgentHarnessWorkspaceActionArgs): WorkspaceActionResolution | null {
  const lookup = workspaceActionLookupFromArgs(args);
  const categoryId = readString(args.categoryId || args.category);
  if (!lookup) return null;
  const entries = allWorkspaceActions().filter((entry) => !categoryId || entry.category.id === categoryId);
  const normalized = lookup.input.toLowerCase();
  const commandInput = lookup.source === 'command' ? lookup.input.trim() : '';

  const exactId = entries.find((entry) => entry.action.id === lookup.input);
  if (exactId) return { status: 'found', ...exactId, lookup: { ...lookup, resolvedBy: 'id' } };
  const exactLabel = entries.find((entry) => entry.action.label === lookup.input);
  if (exactLabel) return { status: 'found', ...exactLabel, lookup: { ...lookup, resolvedBy: 'label' } };
  const exactCommand = commandInput ? entries.find((entry) => entry.action.command === commandInput) : null;
  if (exactCommand) return { status: 'found', ...exactCommand, lookup: { ...lookup, resolvedBy: 'command' } };

  const insensitiveId = entries.find((entry) => entry.action.id.toLowerCase() === normalized);
  if (insensitiveId) return { status: 'found', ...insensitiveId, lookup: { ...lookup, resolvedBy: 'case-insensitive-id' } };
  const insensitiveLabel = entries.find((entry) => entry.action.label.toLowerCase() === normalized);
  if (insensitiveLabel) return { status: 'found', ...insensitiveLabel, lookup: { ...lookup, resolvedBy: 'case-insensitive-label' } };

  const searched = searchAgentWorkspaceActions(AGENT_WORKSPACE_CATEGORIES, lookup.input)
    .map((result) => ({ category: result.category, action: result.action }))
    .filter((entry) => !categoryId || entry.category.id === categoryId);
  if (searched.length === 1) return { status: 'found', ...searched[0]!, lookup: { ...lookup, resolvedBy: 'search' } };
  if (searched.length > 1) return { status: 'ambiguous', input: lookup.input, candidates: describeWorkspaceActionCandidates(searched) };
  return null;
}

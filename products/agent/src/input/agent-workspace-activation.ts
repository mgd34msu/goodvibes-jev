import { createLearnedBehaviorEditor, createLocalEditor, createProfileEditor } from './agent-workspace-editors.ts';
import { createAgentArtifactBrowserEditor, createAgentArtifactExportEditor, createAgentArtifactPackageEditor, createAgentArtifactPromoteKnowledgeEditor, createAgentArtifactShowEditor } from './agent-workspace-artifact-browser-editor.ts';
import { createAgentDocumentAcceptSuggestionEditor, createAgentDocumentAttachArtifactEditor, createAgentDocumentBrowseEditor, createAgentDocumentCommentEditor, createAgentDocumentCreateEditor, createAgentDocumentExportEditor, createAgentDocumentInsertArtifactEditor, createAgentDocumentRejectSuggestionEditor, createAgentDocumentResolveCommentEditor, createAgentDocumentReviewEditor, createAgentDocumentShowEditor, createAgentDocumentSuggestEditor, createAgentDocumentUpdateEditor } from './agent-workspace-document-editor.ts';
import { createAgentDocumentReviewerReadinessEditor, createAgentDocumentReviewPacketPresetEditor, createAgentDocumentReviewPacketPresetRefreshEditor, createAgentDocumentReviewPacketShareEditor, createAgentDocumentReviewPacketWizardEditor } from './agent-workspace-document-ops-editor.ts';
import { createAgentWorkspaceBasicCommandEditor, isAgentWorkspaceBasicCommandEditorKind } from './agent-workspace-basic-command-editors.ts';
import { createAgentKnowledgeQueryEditor } from './agent-workspace-knowledge-query-editor.ts';
import { createAgentLocalModelBenchmarkEditor, createAgentModelCompareAnalyticsEditor, createAgentModelCompareApplyEditor, createAgentModelCompareEditor, createAgentModelCompareExportEditor, createAgentModelCompareHandoffDiffEditor, createAgentModelCompareJudgmentEditor, createAgentModelCompareReviewEditor, createAgentModelCompareRouteDecisionEditor } from './agent-workspace-model-compare-editor.ts';
import { createAgentResearchReportEditor } from './agent-workspace-research-report-editor.ts';
import { createAgentResearchRunEditor } from './agent-workspace-research-run-editor.ts';
import { createAgentResearchSourceEditor } from './agent-workspace-research-source-editor.ts';
import { createReminderScheduleEditor } from './agent-workspace-reminder-schedule-editor.ts';
import { createEmailConnectWizardEditor } from './agent-workspace-email-connect-editor.ts';
import { createCalendarConnectEditor } from './agent-workspace-calendar-connect-editor.ts';
import { createCalendarSubscribeWizardEditor } from './agent-workspace-calendar-subscribe-editor.ts';
import { createCalendarOAuthEditor } from './agent-workspace-calendar-oauth-editor.ts';
import {
  createGoogleAdoptEditor,
  createGoogleAppPasswordEditor,
  createGoogleClientFileEditor,
  createGoogleClientManualEditor,
  createGoogleConnectEditor,
  createGoogleForgetEditor,
  createGoogleReauthorizeEditor,
  createGoogleStatusEditor,
  createGoogleWalkthroughEditor,
} from './agent-workspace-google-setup-editor.ts';
import type { AgentWorkspaceCalendarOAuthConfigStatus } from './agent-workspace-calendar-oauth-editor.ts';
import { createRoutineScheduleEditor } from './agent-workspace-routine-schedule-editor.ts';
import { createAgentWorkspaceWebResearchEditor } from './agent-workspace-web-research-editor.ts';
import { parseSlashCommand } from './slash-command-parser.ts';
import type {
  AgentWorkspaceActionResult,
  AgentWorkspaceCategory,
  AgentWorkspaceCommandDispatcher,
  AgentWorkspaceEditorKind,
  AgentWorkspaceEmailConnectStatus,
  AgentWorkspaceFocusPane,
  AgentWorkspaceLocalEditor,
  AgentWorkspaceLocalEditorKind,
  AgentWorkspaceLocalLibraryItem,
  AgentWorkspaceLocalOperation,
  AgentWorkspaceRecentReviewerHandoffArtifact,
  AgentWorkspaceReviewPacketDefaults,
  AgentWorkspaceRuntimeSnapshot,
  AgentWorkspaceRuntimeStarterTemplateItem,
} from './agent-workspace-types.ts';

interface AgentWorkspaceActivationHost {
  readonly categories: readonly AgentWorkspaceCategory[];
  readonly selectedCategory: AgentWorkspaceCategory;
  readonly selectedAction: AgentWorkspaceCategory['actions'][number] | null;
  readonly runtimeSnapshot: AgentWorkspaceRuntimeSnapshot | null;
  localEditor: AgentWorkspaceLocalEditor | null;
  focusPane: AgentWorkspaceFocusPane;
  selectedCategoryIndex: number;
  selectedActionIndex: number;
  status: string;
  lastActionResult: AgentWorkspaceActionResult | null;
  submitEditorFieldOrForm(requestRender?: () => void): void;
  focusActions(): void;
  clampSelection(): void;
  moveLocalLibraryItemSelection(kind: AgentWorkspaceLocalEditorKind, delta: number): void;
  selectedLocalLibraryItem(kind: AgentWorkspaceLocalEditorKind): AgentWorkspaceLocalLibraryItem | null;
  applyLocalLibraryOperation(operation: AgentWorkspaceLocalOperation): void;
  applySettingAction(action: AgentWorkspaceCategory['actions'][number], requestRender?: () => void): void;
  importTuiSettings(requestRender?: () => void): void;
  applySetupCheckpointAction(action: AgentWorkspaceCategory['actions'][number], requestRender?: () => void): void;
  openModelPickerAction(action: AgentWorkspaceCategory['actions'][number], requestRender?: () => void): void;
  openSettingsModalAction(action: AgentWorkspaceCategory['actions'][number], requestRender?: () => void): void;
  completeOnboarding(): void;
  hasCommandDispatch(): boolean;
  dispatchWorkspaceCommand(command: string, behavior?: 'inline' | 'compose' | 'exit'): void;
  commitActionSearchSelection(): boolean;
}

export function activateAgentWorkspaceSelection(
  workspace: AgentWorkspaceActivationHost,
  requestRender?: () => void,
): void {
  if (workspace.localEditor) {
    workspace.submitEditorFieldOrForm(requestRender);
    return;
  }
  if (workspace.focusPane === 'categories') {
    workspace.focusActions();
    return;
  }
  if (!workspace.commitActionSearchSelection()) return;
  const action = workspace.selectedAction;
  if (!action) return;
  if (action.kind === 'setting') {
    workspace.applySettingAction(action, requestRender);
    return;
  }
  if (action.kind === 'settings-import') {
    workspace.importTuiSettings(requestRender);
    return;
  }
  if (action.kind === 'setup-checkpoint') {
    workspace.applySetupCheckpointAction(action, requestRender);
    return;
  }
  if (action.kind === 'model-picker') {
    workspace.openModelPickerAction(action, requestRender);
    return;
  }
  if (action.kind === 'settings-modal') {
    workspace.openSettingsModalAction(action, requestRender);
    return;
  }
  if (action.kind === 'editor' && action.editorKind) {
    const editor = createAgentWorkspaceEditor(action.editorKind, {
      runtimeStarterTemplates: workspace.runtimeSnapshot?.runtimeStarterTemplates ?? [],
      selectedRoutine: workspace.selectedLocalLibraryItem('routine'),
      recentReviewerHandoffArtifacts: workspace.runtimeSnapshot?.recentReviewerHandoffArtifacts ?? [],
      reviewPacketDefaults: workspace.runtimeSnapshot?.reviewPacketDefaults ?? null,
      emailConnectStatus: workspace.runtimeSnapshot?.emailConnectStatus ?? null,
      calendarOAuthConfigStatus: workspace.runtimeSnapshot?.calendarOAuthConfigStatus ?? null,
    });
    if (!editor) {
      workspace.status = `Editor unavailable: ${action.editorKind}.`;
      workspace.lastActionResult = {
        kind: 'error',
        title: 'Editor unavailable',
        detail: `No Agent workspace editor exists for ${action.editorKind}.`,
        safety: action.safety,
      };
      return;
    }
    workspace.localEditor = editor;
    workspace.status = `Editing ${editor.title}.`;
    workspace.lastActionResult = {
      kind: 'guidance',
      title: editor.title,
      detail: editor.message,
      safety: action.safety,
    };
    return;
  }
  if (action.kind === 'local-selection' && action.localKind) {
    workspace.moveLocalLibraryItemSelection(action.localKind, action.selectionDelta ?? 0);
    return;
  }
  if (action.kind === 'local-operation' && action.localOperation) {
    workspace.applyLocalLibraryOperation(action.localOperation);
    return;
  }
  if (action.kind === 'onboarding-complete') {
    workspace.completeOnboarding();
    return;
  }
  if (action.kind === 'guidance' || !action.command) {
    handleGuidanceOrWorkspaceAction(workspace, action);
    return;
  }
  if (action.safety === 'blocked') {
    workspace.status = `Blocked here: ${action.label}.`;
    workspace.lastActionResult = {
      kind: 'blocked',
      title: `${action.label} is blocked in Agent`,
      detail: action.detail,
      command: action.command,
      safety: action.safety,
    };
    return;
  }
  const parsed = parseSlashCommand(action.command);
  if (!parsed.name) {
    workspace.status = `No command is configured for ${action.label}.`;
    workspace.lastActionResult = {
      kind: 'error',
      title: 'Command unavailable',
      detail: `No command is configured for ${action.label}.`,
      safety: action.safety,
    };
    return;
  }
  if (/<[^>\s]+(?:\s+[^>]*)?>/.test(action.command)) {
    workspace.status = `Command needs concrete values before dispatch: ${action.command}.`;
    workspace.lastActionResult = {
      kind: 'guidance',
      title: `${action.label} needs details`,
      detail: 'This action needs concrete values before it can run. Return to the composer and include the real task text.',
      command: action.command,
      safety: action.safety,
    };
    return;
  }
  if (!workspace.hasCommandDispatch()) {
    workspace.status = `Command dispatch is not available for ${action.command}.`;
    workspace.lastActionResult = {
      kind: 'error',
      title: 'Command dispatch unavailable',
      detail: `The command ${action.command} cannot be opened from this runtime.`,
      command: action.command,
      safety: action.safety,
    };
    return;
  }
  workspace.status = `Opening ${action.command}.`;
  workspace.lastActionResult = {
    kind: 'dispatched',
    title: `Opening ${action.label}`,
    detail: 'The workspace handed this command to the shell-owned command router.',
    command: action.command,
    safety: action.safety,
  };
  workspace.dispatchWorkspaceCommand(action.command, action.commandBehavior);
}

export function createAgentWorkspaceEditor(
  editorKind: AgentWorkspaceEditorKind,
  options: {
    readonly runtimeStarterTemplates?: readonly AgentWorkspaceRuntimeStarterTemplateItem[];
    readonly selectedRoutine?: AgentWorkspaceLocalLibraryItem | null;
    readonly recentReviewerHandoffArtifacts?: readonly AgentWorkspaceRecentReviewerHandoffArtifact[];
    readonly reviewPacketDefaults?: AgentWorkspaceReviewPacketDefaults | null;
    readonly emailConnectStatus?: AgentWorkspaceEmailConnectStatus | null;
    readonly calendarOAuthConfigStatus?: AgentWorkspaceCalendarOAuthConfigStatus | null;
  } = {},
): AgentWorkspaceLocalEditor | null {
  if (editorKind === 'email-connect-wizard') return createEmailConnectWizardEditor(options.emailConnectStatus ?? null);
  if (editorKind === 'calendar-connect') return createCalendarConnectEditor();
  if (editorKind === 'calendar-subscribe-wizard') return createCalendarSubscribeWizardEditor();
  if (editorKind === 'calendar-oauth-google') return createCalendarOAuthEditor('google', options.calendarOAuthConfigStatus?.google ?? false);
  if (editorKind === 'calendar-oauth-outlook') return createCalendarOAuthEditor('microsoft', options.calendarOAuthConfigStatus?.microsoft ?? false);
  if (editorKind === 'google-status') return createGoogleStatusEditor();
  if (editorKind === 'google-connect') return createGoogleConnectEditor();
  if (editorKind === 'google-reauthorize') return createGoogleReauthorizeEditor();
  if (editorKind === 'google-forget') return createGoogleForgetEditor();
  if (editorKind === 'google-setup-walkthrough') return createGoogleWalkthroughEditor();
  if (editorKind === 'google-setup-app-password') return createGoogleAppPasswordEditor();
  if (editorKind === 'google-adopt') return createGoogleAdoptEditor();
  if (editorKind === 'google-client-file') return createGoogleClientFileEditor();
  if (editorKind === 'google-client-manual') return createGoogleClientManualEditor();
  if (editorKind === 'profile') return createProfileEditor(options.runtimeStarterTemplates ?? []);
  if (editorKind === 'learned-behavior') return createLearnedBehaviorEditor();
  if (editorKind === 'web-research') return createAgentWorkspaceWebResearchEditor('research');
  if (editorKind === 'web-fetch') return createAgentWorkspaceWebResearchEditor('fetch');
  if (editorKind === 'research-run') return createAgentResearchRunEditor();
  if (editorKind === 'research-source') return createAgentResearchSourceEditor();
  if (editorKind === 'research-report') return createAgentResearchReportEditor();
  if (editorKind === 'artifact-browser') return createAgentArtifactBrowserEditor();
  if (editorKind === 'artifact-show') return createAgentArtifactShowEditor();
  if (editorKind === 'artifact-export-file') return createAgentArtifactExportEditor();
  if (editorKind === 'artifact-export-package') return createAgentArtifactPackageEditor();
  if (editorKind === 'artifact-promote-knowledge') return createAgentArtifactPromoteKnowledgeEditor();
  if (editorKind === 'document-browse') return createAgentDocumentBrowseEditor();
  if (editorKind === 'document-show') return createAgentDocumentShowEditor();
  if (editorKind === 'document-create') return createAgentDocumentCreateEditor();
  if (editorKind === 'document-update') return createAgentDocumentUpdateEditor();
  if (editorKind === 'document-review') return createAgentDocumentReviewEditor();
  if (editorKind === 'document-comment') return createAgentDocumentCommentEditor();
  if (editorKind === 'document-resolve-comment') return createAgentDocumentResolveCommentEditor();
  if (editorKind === 'document-suggest') return createAgentDocumentSuggestEditor();
  if (editorKind === 'document-accept-suggestion') return createAgentDocumentAcceptSuggestionEditor();
  if (editorKind === 'document-reject-suggestion') return createAgentDocumentRejectSuggestionEditor();
  if (editorKind === 'document-insert-artifact') return createAgentDocumentInsertArtifactEditor();
  if (editorKind === 'document-attach-artifact') return createAgentDocumentAttachArtifactEditor();
  if (editorKind === 'document-export') return createAgentDocumentExportEditor(options.reviewPacketDefaults ?? null);
  if (editorKind === 'document-reviewer-readiness') return createAgentDocumentReviewerReadinessEditor();
  if (editorKind === 'document-review-packet-wizard') return createAgentDocumentReviewPacketWizardEditor();
  if (editorKind === 'document-review-packet-preset') return createAgentDocumentReviewPacketPresetEditor(options.reviewPacketDefaults ?? null);
  if (editorKind === 'document-review-packet-preset-refresh') return createAgentDocumentReviewPacketPresetRefreshEditor();
  if (editorKind === 'document-review-packet-share') return createAgentDocumentReviewPacketShareEditor(options.reviewPacketDefaults ?? null);
  if (editorKind === 'model-compare') return createAgentModelCompareEditor();
  if (editorKind === 'local-model-benchmark') return createAgentLocalModelBenchmarkEditor();
  if (editorKind === 'model-compare-review') return createAgentModelCompareReviewEditor();
  if (editorKind === 'model-compare-handoff-diff') return createAgentModelCompareHandoffDiffEditor(options.recentReviewerHandoffArtifacts ?? []);
  if (editorKind === 'model-compare-judge') return createAgentModelCompareJudgmentEditor();
  if (editorKind === 'model-compare-apply') return createAgentModelCompareApplyEditor(options.reviewPacketDefaults ?? null);
  if (editorKind === 'model-compare-route-decision') return createAgentModelCompareRouteDecisionEditor(options.reviewPacketDefaults ?? null);
  if (editorKind === 'model-compare-export') return createAgentModelCompareExportEditor(options.reviewPacketDefaults ?? null);
  if (editorKind === 'model-compare-analytics') return createAgentModelCompareAnalyticsEditor();
  if (editorKind && isAgentWorkspaceBasicCommandEditorKind(editorKind)) return createAgentWorkspaceBasicCommandEditor(editorKind);
  if (editorKind === 'knowledge-ask') return createAgentKnowledgeQueryEditor('ask');
  if (editorKind === 'knowledge-search') return createAgentKnowledgeQueryEditor('search');
  if (editorKind === 'reminder-schedule') return createReminderScheduleEditor();
  if (editorKind === 'routine-schedule') return createRoutineScheduleEditor(options.selectedRoutine ?? null);
  if (
    editorKind === 'memory'
    || editorKind === 'note'
    || editorKind === 'persona'
    || editorKind === 'skill'
    || editorKind === 'routine'
    || editorKind === 'knowledge-url'
  ) {
    return createLocalEditor(editorKind);
  }
  return null;
}

function handleGuidanceOrWorkspaceAction(
  workspace: AgentWorkspaceActivationHost,
  action: AgentWorkspaceCategory['actions'][number],
): void {
  if (action.kind === 'workspace' && action.targetCategoryId) {
    const targetIndex = workspace.categories.findIndex((category) => category.id === action.targetCategoryId);
    if (targetIndex >= 0) {
      workspace.selectedCategoryIndex = targetIndex;
      workspace.selectedActionIndex = 0;
      workspace.focusActions();
      workspace.status = `Opened ${workspace.selectedCategory.label}.`;
      workspace.lastActionResult = {
        kind: 'refreshed',
        title: `Opened ${workspace.selectedCategory.label}`,
        detail: action.detail,
        safety: action.safety,
      };
      workspace.clampSelection();
      return;
    }
    workspace.status = `Workspace area unavailable: ${action.targetCategoryId}.`;
    workspace.lastActionResult = {
      kind: 'error',
      title: 'Workspace area unavailable',
      detail: `No Agent workspace category exists for ${action.targetCategoryId}.`,
      safety: action.safety,
    };
    return;
  }
  workspace.status = action.detail;
  workspace.lastActionResult = {
    kind: 'guidance',
    title: action.label,
    detail: action.detail,
    safety: action.safety,
  };
}

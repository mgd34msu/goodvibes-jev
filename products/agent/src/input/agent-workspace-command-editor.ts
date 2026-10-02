import type { AgentWorkspaceBasicCommandEditorKind } from './agent-workspace-basic-command-editors.ts';
import { buildAgentArtifactBrowserPromptSubmission, buildAgentArtifactExportPromptSubmission, buildAgentArtifactPackagePromptSubmission, buildAgentArtifactPromoteKnowledgePromptSubmission } from './agent-workspace-artifact-browser-editor.ts';
import { buildAgentWorkspaceBasicCommandEditorSubmission, isAgentWorkspaceBasicCommandEditorKind } from './agent-workspace-basic-command-editors.ts';
import { buildAgentDocumentReviewerReadinessPromptSubmission, buildAgentDocumentReviewPacketPresetPromptSubmission, buildAgentDocumentReviewPacketPresetRefreshPromptSubmission, buildAgentDocumentReviewPacketSharePromptSubmission, buildAgentDocumentReviewPacketWizardPromptSubmission } from './agent-workspace-document-ops-editor.ts';
import { buildAgentDocumentPromptSubmission } from './agent-workspace-document-editor.ts';
import { buildAgentKnowledgeUrlEditorSubmission } from './agent-workspace-knowledge-url-editor.ts';
import { buildAgentKnowledgeQueryEditorSubmission } from './agent-workspace-knowledge-query-editor.ts';
import { buildAgentModelCompareAnalyticsPromptSubmission, buildAgentModelCompareApplyPromptSubmission, buildAgentModelCompareExportPromptSubmission, buildAgentModelCompareHandoffDiffPromptSubmission, buildAgentModelCompareJudgmentPromptSubmission, buildAgentModelComparePromptSubmission, buildAgentModelCompareReviewPromptSubmission, buildAgentModelCompareRouteDecisionPromptSubmission } from './agent-workspace-model-compare-editor.ts';
import { buildAgentResearchReportPromptSubmission } from './agent-workspace-research-report-editor.ts';
import { buildAgentResearchRunPromptSubmission } from './agent-workspace-research-run-editor.ts';
import { buildAgentResearchSourcePromptSubmission } from './agent-workspace-research-source-editor.ts';
import { buildAgentReminderScheduleEditorSubmission } from './agent-workspace-reminder-schedule-editor.ts';
import { buildAgentWorkspaceCalendarConnectEditorSubmission } from './agent-workspace-calendar-connect-editor.ts';
import { buildAgentRoutineScheduleEditorSubmission } from './agent-workspace-routine-schedule-editor.ts';
import { buildAgentWorkspaceWebResearchSubmission } from './agent-workspace-web-research-editor.ts';
import type { AgentWorkspaceActionResult, AgentWorkspaceEditorKind, AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';

type AgentWorkspaceFieldReader = (fieldId: string) => string;
type AgentWorkspaceCommandEditorKind = AgentWorkspaceBasicCommandEditorKind | Extract<
  AgentWorkspaceEditorKind,
  'web-research'
  | 'web-fetch'
  | 'research-run'
  | 'research-source'
  | 'research-report'
  | 'knowledge-url'
  | 'knowledge-urls'
  | 'knowledge-file'
  | 'knowledge-browser-history'
  | 'knowledge-connector-ingest'
  | 'knowledge-reindex'
  | 'knowledge-search'
  | 'knowledge-ask'
  | 'model-compare'
  | 'local-model-benchmark'
  | 'document-browse'
  | 'document-show'
  | 'document-create'
  | 'document-update'
  | 'document-review'
  | 'document-comment'
  | 'document-resolve-comment'
  | 'document-suggest'
  | 'document-accept-suggestion'
  | 'document-reject-suggestion'
  | 'document-insert-artifact'
  | 'document-attach-artifact'
  | 'document-export'
  | 'document-reviewer-readiness'
  | 'document-review-packet-wizard'
  | 'document-review-packet-preset'
  | 'document-review-packet-preset-refresh'
  | 'document-review-packet-share'
  | 'model-compare-review'
  | 'model-compare-handoff-diff'
  | 'model-compare-judge'
  | 'model-compare-apply'
  | 'model-compare-route-decision'
  | 'model-compare-export'
  | 'model-compare-analytics'
  | 'mcp-server'
  | 'notify-webhook'
  | 'notify-webhook-remove'
  | 'notify-webhook-clear'
  | 'notify-webhook-test'
  | 'notify-send'
  | 'secret-set'
  | 'secret-link'
  | 'secret-test'
  | 'secret-delete'
  | 'routine-schedule'
  | 'reminder-schedule'
  | 'calendar-connect'
  | 'knowledge-bookmarks'
  | 'tts-prompt'
  | 'image-input'
  | 'artifact-browser'
  | 'artifact-show'
  | 'artifact-export-file'
  | 'artifact-export-package'
  | 'artifact-promote-knowledge'
  | 'skill-bundle'
  | 'persona-discovery-import'
  | 'routine-discovery-import'
  | 'skill-discovery-import'
  | 'skill-standard-import'
  | 'skill-standard-export'
  | 'profile-template-export'
  | 'profile-template-import'
  | 'profile-template-from-discovered'
  | 'profile-from-discovered'
  | 'profile-default'
  | 'profile-default-clear'
  | 'support-bundle-export'
  | 'support-bundle-inspect'
  | 'support-bundle-import'
  | 'subscription-inspect'
  | 'subscription-login-start'
  | 'subscription-login-finish'
  | 'subscription-logout'
  | 'delegate-task'
  | 'workplan-add'
  | 'workplan-status'
  | 'workplan-delete'
  | 'workplan-clear-completed'
>;

type AgentWorkspaceCommandEditorSubmission =
  | {
    readonly kind: 'editor';
    readonly editor: AgentWorkspaceLocalEditor;
    readonly status: string;
    readonly actionResult?: AgentWorkspaceActionResult;
  }
  | {
    readonly kind: 'dispatch';
    readonly command: string;
    readonly status: string;
    readonly actionResult: AgentWorkspaceActionResult;
  }
  | {
    readonly kind: 'prompt';
    readonly prompt: string;
    readonly status: string;
    readonly actionResult: AgentWorkspaceActionResult;
  };

export function isAgentWorkspaceCommandEditorKind(kind: AgentWorkspaceEditorKind): kind is AgentWorkspaceCommandEditorKind {
  return kind === 'web-research'
    || kind === 'web-fetch'
    || kind === 'research-run'
    || kind === 'research-source'
    || kind === 'research-report'
    || kind === 'knowledge-url'
    || kind === 'knowledge-search'
    || kind === 'knowledge-ask'
    || kind === 'artifact-browser'
    || kind === 'artifact-show'
    || kind === 'artifact-export-file'
    || kind === 'artifact-export-package'
    || kind === 'artifact-promote-knowledge'
    || kind === 'model-compare'
    || kind === 'local-model-benchmark'
    || kind === 'document-browse'
    || kind === 'document-show'
    || kind === 'document-create'
    || kind === 'document-update'
    || kind === 'document-review'
    || kind === 'document-comment'
    || kind === 'document-resolve-comment'
    || kind === 'document-suggest'
    || kind === 'document-accept-suggestion'
    || kind === 'document-reject-suggestion'
    || kind === 'document-insert-artifact'
    || kind === 'document-attach-artifact'
    || kind === 'document-export'
    || kind === 'document-reviewer-readiness'
    || kind === 'document-review-packet-wizard'
    || kind === 'document-review-packet-preset'
    || kind === 'document-review-packet-preset-refresh'
    || kind === 'document-review-packet-share'
    || kind === 'model-compare-review'
    || kind === 'model-compare-handoff-diff'
    || kind === 'model-compare-judge'
    || kind === 'model-compare-apply'
    || kind === 'model-compare-route-decision'
    || kind === 'model-compare-export'
    || kind === 'model-compare-analytics'
    || kind === 'routine-schedule'
    || kind === 'reminder-schedule'
    || kind === 'calendar-connect'
    || isAgentWorkspaceBasicCommandEditorKind(kind);
}

export function buildAgentWorkspaceCommandEditorSubmission(
  editor: AgentWorkspaceLocalEditor,
  readField: AgentWorkspaceFieldReader,
  commandDispatchAvailable: boolean,
  promptDispatchAvailable: boolean,
): AgentWorkspaceCommandEditorSubmission {
  if (editor.kind === 'web-research' || editor.kind === 'web-fetch') {
    return buildAgentWorkspaceWebResearchSubmission(editor, readField, promptDispatchAvailable);
  }
  if (editor.kind === 'research-report') {
    return buildAgentResearchReportPromptSubmission(editor, readField, promptDispatchAvailable);
  }
  if (editor.kind === 'research-run') {
    return buildAgentResearchRunPromptSubmission(editor, readField, promptDispatchAvailable);
  }
  if (editor.kind === 'research-source') {
    return buildAgentResearchSourcePromptSubmission(editor, readField, promptDispatchAvailable);
  }
  if (editor.kind === 'knowledge-url') return buildAgentKnowledgeUrlEditorSubmission(editor, readField, commandDispatchAvailable);
  if (editor.kind === 'knowledge-search' || editor.kind === 'knowledge-ask') {
    return buildAgentKnowledgeQueryEditorSubmission(editor, readField, commandDispatchAvailable);
  }
  if (editor.kind === 'artifact-browser' || editor.kind === 'artifact-show') {
    return buildAgentArtifactBrowserPromptSubmission(editor, readField, promptDispatchAvailable);
  }
  if (editor.kind === 'artifact-export-file') {
    return buildAgentArtifactExportPromptSubmission(editor, readField, promptDispatchAvailable);
  }
  if (editor.kind === 'artifact-export-package') {
    return buildAgentArtifactPackagePromptSubmission(editor, readField, promptDispatchAvailable);
  }
  if (editor.kind === 'artifact-promote-knowledge') {
    return buildAgentArtifactPromoteKnowledgePromptSubmission(editor, readField, promptDispatchAvailable);
  }
  if (
    editor.kind === 'document-browse'
    || editor.kind === 'document-show'
    || editor.kind === 'document-create'
    || editor.kind === 'document-update'
    || editor.kind === 'document-review'
    || editor.kind === 'document-comment'
    || editor.kind === 'document-resolve-comment'
    || editor.kind === 'document-suggest'
    || editor.kind === 'document-accept-suggestion'
    || editor.kind === 'document-reject-suggestion'
    || editor.kind === 'document-insert-artifact'
    || editor.kind === 'document-attach-artifact'
    || editor.kind === 'document-export'
  ) {
    return buildAgentDocumentPromptSubmission(editor, readField, promptDispatchAvailable);
  }
  if (editor.kind === 'document-reviewer-readiness') {
    return buildAgentDocumentReviewerReadinessPromptSubmission(editor, readField, promptDispatchAvailable);
  }
  if (editor.kind === 'document-review-packet-wizard') {
    return buildAgentDocumentReviewPacketWizardPromptSubmission(editor, readField, promptDispatchAvailable);
  }
  if (editor.kind === 'document-review-packet-preset') {
    return buildAgentDocumentReviewPacketPresetPromptSubmission(editor, readField, promptDispatchAvailable);
  }
  if (editor.kind === 'document-review-packet-preset-refresh') {
    return buildAgentDocumentReviewPacketPresetRefreshPromptSubmission(editor, readField, promptDispatchAvailable);
  }
  if (editor.kind === 'document-review-packet-share') {
    return buildAgentDocumentReviewPacketSharePromptSubmission(editor, readField, promptDispatchAvailable);
  }
  if (editor.kind === 'model-compare' || editor.kind === 'local-model-benchmark') {
    return buildAgentModelComparePromptSubmission(editor, readField, promptDispatchAvailable);
  }
  if (editor.kind === 'model-compare-review') {
    return buildAgentModelCompareReviewPromptSubmission(editor, readField, promptDispatchAvailable);
  }
  if (editor.kind === 'model-compare-handoff-diff') {
    return buildAgentModelCompareHandoffDiffPromptSubmission(editor, readField, promptDispatchAvailable);
  }
  if (editor.kind === 'model-compare-judge') {
    return buildAgentModelCompareJudgmentPromptSubmission(editor, readField, promptDispatchAvailable);
  }
  if (editor.kind === 'model-compare-apply') {
    return buildAgentModelCompareApplyPromptSubmission(editor, readField, promptDispatchAvailable);
  }
  if (editor.kind === 'model-compare-route-decision') {
    return buildAgentModelCompareRouteDecisionPromptSubmission(editor, readField, promptDispatchAvailable);
  }
  if (editor.kind === 'model-compare-export') {
    return buildAgentModelCompareExportPromptSubmission(editor, readField, promptDispatchAvailable);
  }
  if (editor.kind === 'model-compare-analytics') {
    return buildAgentModelCompareAnalyticsPromptSubmission(editor, readField, promptDispatchAvailable);
  }
  if (isAgentWorkspaceBasicCommandEditorKind(editor.kind)) {
    return buildAgentWorkspaceBasicCommandEditorSubmission(editor, readField, commandDispatchAvailable);
  }
  if (editor.kind === 'reminder-schedule') return buildAgentReminderScheduleEditorSubmission(editor, readField, commandDispatchAvailable);
  if (editor.kind === 'calendar-connect') return buildAgentWorkspaceCalendarConnectEditorSubmission(editor, readField, commandDispatchAvailable);
  return buildAgentRoutineScheduleEditorSubmission(editor, readField, commandDispatchAvailable);
}

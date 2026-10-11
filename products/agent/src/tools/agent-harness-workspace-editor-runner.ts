import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { buildAgentArtifactBrowserToolArgs, buildAgentArtifactExportToolArgs, buildAgentArtifactPackageToolArgs, buildAgentArtifactPromoteKnowledgeToolArgs, buildAgentArtifactShowToolArgs } from '../input/agent-workspace-artifact-browser-editor.ts';
import { buildAgentDocumentReviewerReadinessToolArgs, buildAgentDocumentReviewPacketPresetRefreshToolArgs, buildAgentDocumentReviewPacketPresetToolArgs, buildAgentDocumentReviewPacketShareToolArgs, buildAgentDocumentReviewPacketWizardToolArgs } from '../input/agent-workspace-document-ops-editor.ts';
import { buildAgentDocumentToolArgs } from '../input/agent-workspace-document-editor.ts';
import { buildAgentWorkspaceCommandEditorSubmission, isAgentWorkspaceCommandEditorKind } from '../input/agent-workspace-command-editor.ts';
import { buildAgentModelCompareAnalyticsToolArgs, buildAgentModelCompareApplyToolArgs, buildAgentModelCompareExportToolArgs, buildAgentModelCompareHandoffDiffToolArgs, buildAgentModelCompareJudgmentToolArgs, buildAgentModelCompareReviewToolArgs, buildAgentModelCompareRouteDecisionToolArgs, buildAgentModelCompareToolArgs } from '../input/agent-workspace-model-compare-editor.ts';
import { captureAgentResearchReportToolArgs } from '../input/agent-workspace-research-report-editor.ts';
import { buildAgentResearchRunToolArgs } from '../input/agent-workspace-research-run-editor.ts';
import { buildAgentResearchSourceToolArgs } from '../input/agent-workspace-research-source-editor.ts';
import { isAffirmative, splitList } from '../input/agent-workspace-editors.ts';
import { createAgentWorkspaceLearnedBehavior } from '../input/agent-workspace-learned-behavior.ts';
import type { AgentWorkspaceAction, AgentWorkspaceLocalEditor } from '../input/agent-workspace-types.ts';
import { describeDocumentOpsLane } from './agent-harness-document-ops.ts';
import { runLocalWorkspaceEditorAction } from './agent-harness-local-operations.ts';
import { describeWorkspaceEditorModelExecution } from './agent-harness-workspace-editor-execution.ts';
import { describeWorkspaceEditor } from './agent-harness-workspace-actions.ts';
import { runTranslatedWorkspaceCommand } from './agent-harness-command-runner.ts';
import { captureHarnessLocalEffect } from './agent-harness-local-effect.ts';
import { harnessCatalogExecutionGuard, retainHarnessCatalogCurrent } from './agent-harness-catalog-ingress.ts';
import { agentResearchSourceOwner } from '../agent/protected-research-report.ts';
import { personaStorePath } from '../agent/persona-registry.ts';
import { skillStorePath } from '../agent/skill-registry.ts';
import { routineStorePath } from '../agent/routine-registry.ts';
import type { AgentHarnessToolDeps } from './agent-harness-tool-types.ts';
import { error, output, readFieldMap, readString, requireConfirmedAction } from './agent-harness-tool-utils.ts';

function fieldReader(editor: AgentWorkspaceLocalEditor, fields: Readonly<Record<string, string>>): (fieldId: string) => string {
  return (fieldId: string) => fields[fieldId] ?? editor.fields.find((field) => field.id === fieldId)?.value ?? '';
}

function modelEditorToolArgs(built: object, suppliedRequest: unknown): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(built)) {
    if (key !== 'confirm' && key !== 'explicitUserRequest') payload[key] = value;
  }
  const request = readString(suppliedRequest);
  if (Object.hasOwn(built, 'explicitUserRequest') && request) payload.explicitUserRequest = request;
  return payload;
}

function missingRequiredEditorFields(editor: AgentWorkspaceLocalEditor, fields: Readonly<Record<string, string>>): readonly string[] {
  const readField = fieldReader(editor, fields);
  return editor.fields
    .filter((field) => field.id !== 'confirm' && field.id !== 'explicitUserRequest' && field.required && !readField(field.id).trim())
    .map((field) => field.id);
}

export async function runWorkspaceEditorAction(
  deps: AgentHarnessToolDeps,
  action: AgentWorkspaceAction,
  editor: AgentWorkspaceLocalEditor,
  args: Record<string, unknown>,
  options?: Parameters<Tool['execute']>[1],
): Promise<{ readonly success: boolean; readonly output?: string; readonly error?: string }> {
  const fields = readFieldMap(args.fields);
  const missing = missingRequiredEditorFields(editor, fields);
  if (missing.length > 0) {
    return output({
      status: 'missing_required_fields',
      missing,
      action: action.id,
      editor: describeWorkspaceEditor(editor),
      modelExecution: describeWorkspaceEditorModelExecution(editor.kind),
    });
  }

  if (editor.kind === 'learned-behavior') {
    const confirmationError = requireConfirmedAction(args, options, 'Workspace learned-behavior capture');
    if (confirmationError) return error(confirmationError);
    const shellPaths = deps.commandContext.workspace.shellPaths;
    if (!shellPaths) return error('Agent shell paths are unavailable.');
    const readField = fieldReader(editor, fields);
    const target = readField('target').trim().toLowerCase();
    if (target !== 'skill' && target !== 'routine' && target !== 'persona') {
      return error('learned-behavior target must be skill, routine, or persona.');
    }
    const assertCurrent = captureHarnessLocalEffect(deps.commandContext, args, options, paths => [
      target === 'persona' ? personaStorePath(paths) : target === 'skill' ? skillStorePath(paths) : routineStorePath(paths),
    ]);
    const created = createAgentWorkspaceLearnedBehavior(shellPaths, {
      target,
      name: readField('name'),
      description: readField('description'),
      notes: readField('notes'),
      tags: splitList(readField('tags')),
      triggers: splitList(readField('triggers')),
      enable: isAffirmative(readField('enable')),
    }, assertCurrent);
    return output({
      status: 'created',
      kind: created.kind,
      id: created.id,
      name: created.name,
      policy: 'Agent-local behavior only; no connected-host mutation, default knowledge write, or delegated job was created.',
    });
  }

  if (editor.kind === 'profile') {
    const readField = fieldReader(editor, fields);
    const name = readField('name');
    const template = readField('template');
    const parts = ['/agent-profile', 'create', name];
    if (template.trim() && template.trim().toLowerCase() !== 'none') parts.push('--template', template);
    parts.push('--yes');
    return runTranslatedWorkspaceCommand(deps, args, parts.map((part, index) => index < 2 || part.startsWith('--') ? part : JSON.stringify(part)).join(' '), options);
  }

  if (editor.kind === 'artifact-browser') {
    const artifactsToolArgs = buildAgentArtifactBrowserToolArgs(fieldReader(editor, fields));
    const result = await deps.toolRegistry.executeNested(
      'agent-harness-workspace-artifact-browser',
      'agent_artifacts',
      modelEditorToolArgs(artifactsToolArgs, args.explicitUserRequest),
      options,
    );
    return output({
      status: result.success ? 'executed_model_tool' : 'model_tool_failed',
      action: action.id,
      tool: 'agent_artifacts',
      output: result.output ?? null,
      error: result.error ?? null,
      modelExecution: describeWorkspaceEditorModelExecution(editor.kind),
    });
  }

  if (editor.kind === 'artifact-show') {
    const artifactToolArgs = buildAgentArtifactShowToolArgs(fieldReader(editor, fields));
    const result = await deps.toolRegistry.executeNested(
      'agent-harness-workspace-artifact-show',
      'agent_artifacts',
      modelEditorToolArgs(artifactToolArgs, args.explicitUserRequest),
      options,
    );
    return output({
      status: result.success ? 'executed_model_tool' : 'model_tool_failed',
      action: action.id,
      tool: 'agent_artifacts',
      output: result.output ?? null,
      error: result.error ?? null,
      modelExecution: describeWorkspaceEditorModelExecution(editor.kind),
    });
  }

  if (editor.kind === 'artifact-export-file') {
    const confirmationError = requireConfirmedAction(args, options, 'Workspace artifact export');
    if (confirmationError) return error(confirmationError);
    const artifactToolArgs = buildAgentArtifactExportToolArgs(
      fieldReader(editor, fields),
      readString(args.explicitUserRequest),
    );
    const result = await deps.toolRegistry.executeNested(
      'agent-harness-workspace-artifact-export',
      'agent_artifacts',
      modelEditorToolArgs(artifactToolArgs, args.explicitUserRequest),
      options,
    );
    return output({
      status: result.success ? 'executed_model_tool' : 'model_tool_failed',
      action: action.id,
      tool: 'agent_artifacts',
      output: result.output ?? null,
      error: result.error ?? null,
      modelExecution: describeWorkspaceEditorModelExecution(editor.kind),
    });
  }

  if (editor.kind === 'artifact-export-package') {
    const confirmationError = requireConfirmedAction(args, options, 'Workspace artifact package export');
    if (confirmationError) return error(confirmationError);
    const readField = fieldReader(editor, fields);
    const artifactToolArgs = buildAgentArtifactPackageToolArgs(
      readField,
      readString(args.explicitUserRequest),
    );
    const result = await deps.toolRegistry.executeNested(
      'agent-harness-workspace-artifact-package-export',
      'agent_artifacts',
      modelEditorToolArgs(artifactToolArgs, args.explicitUserRequest),
      options,
    );
    return output({
      status: result.success ? 'executed_model_tool' : 'model_tool_failed',
      action: action.id,
      tool: 'agent_artifacts',
      output: result.output ?? null,
      error: result.error ?? null,
      modelExecution: describeWorkspaceEditorModelExecution(editor.kind),
    });
  }

  if (editor.kind === 'artifact-promote-knowledge') {
    const confirmationError = requireConfirmedAction(args, options, 'Workspace artifact Knowledge promotion');
    if (confirmationError) return error(confirmationError);
    const ingestToolArgs = buildAgentArtifactPromoteKnowledgeToolArgs(
      fieldReader(editor, fields),
      readString(args.explicitUserRequest),
    );
    const result = await deps.toolRegistry.executeNested(
      'agent-harness-workspace-artifact-promote-knowledge',
      'agent_knowledge_ingest',
      modelEditorToolArgs(ingestToolArgs, args.explicitUserRequest),
      options,
    );
    return output({
      status: result.success ? 'executed_model_tool' : 'model_tool_failed',
      action: action.id,
      tool: 'agent_knowledge_ingest',
      output: result.output ?? null,
      error: result.error ?? null,
      modelExecution: describeWorkspaceEditorModelExecution(editor.kind),
    });
  }

  if (editor.kind === 'research-report') {
    const confirmationError = requireConfirmedAction(args, options, 'Workspace research report artifact save');
    if (confirmationError) return error(confirmationError);
    const researchToolArgs = captureAgentResearchReportToolArgs(
      fieldReader(editor, fields),
      readString(args.explicitUserRequest),
    );
    const result = await deps.toolRegistry.executeNested(
      'agent-harness-workspace-research-report',
      'agent_research_report',
      modelEditorToolArgs(researchToolArgs, args.explicitUserRequest),
      options,
    );
    return output({
      status: result.success ? 'executed_model_tool' : 'model_tool_failed',
      action: action.id,
      tool: 'agent_research_report',
      output: result.output ?? null,
      error: result.error ?? null,
      modelExecution: describeWorkspaceEditorModelExecution(editor.kind),
    });
  }

  if (editor.kind === 'research-run') {
    const confirmationError = requireConfirmedAction(args, options, 'Workspace research run creation');
    if (confirmationError) return error(confirmationError);
    const runToolArgs = buildAgentResearchRunToolArgs(
      fieldReader(editor, fields),
      readString(args.explicitUserRequest),
    );
    const result = await deps.toolRegistry.executeNested(
      'agent-harness-workspace-research-run',
      'agent_research_runs',
      modelEditorToolArgs(runToolArgs, args.explicitUserRequest),
      options,
    );
    return output({
      status: result.success ? 'executed_model_tool' : 'model_tool_failed',
      action: action.id,
      tool: 'agent_research_runs',
      output: result.output ?? null,
      error: result.error ?? null,
      modelExecution: describeWorkspaceEditorModelExecution(editor.kind),
    });
  }

  if (editor.kind === 'research-source') {
    const confirmationError = requireConfirmedAction(args, options, 'Workspace research source queue add');
    if (confirmationError) return error(confirmationError);
    const sourceToolArgs = buildAgentResearchSourceToolArgs(
      fieldReader(editor, fields),
      readString(args.explicitUserRequest),
    );
    const result = await deps.toolRegistry.executeNested(
      'agent-harness-workspace-research-source',
      'agent_research_sources',
      modelEditorToolArgs(sourceToolArgs, args.explicitUserRequest),
      options,
    );
    return output({
      status: result.success ? 'executed_model_tool' : 'model_tool_failed',
      action: action.id,
      tool: 'agent_research_sources',
      output: result.output ?? null,
      error: result.error ?? null,
      modelExecution: describeWorkspaceEditorModelExecution(editor.kind),
    });
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
    const isMutation = editor.kind !== 'document-browse' && editor.kind !== 'document-show';
    if (isMutation) {
      const confirmationError = requireConfirmedAction(args, options, 'Workspace Agent document action');
      if (confirmationError) return error(confirmationError);
    }
    const documentToolArgs = buildAgentDocumentToolArgs(
      editor,
      fieldReader(editor, fields),
      readString(args.explicitUserRequest),
    );
    const result = await deps.toolRegistry.executeNested(
      'agent-harness-workspace-document',
      'agent_documents',
      modelEditorToolArgs(documentToolArgs, args.explicitUserRequest),
      options,
    );
    return output({
      status: result.success ? 'executed_model_tool' : 'model_tool_failed',
      action: action.id,
      tool: 'agent_documents',
      output: result.output ?? null,
      error: result.error ?? null,
      modelExecution: describeWorkspaceEditorModelExecution(editor.kind),
    });
  }

  if (editor.kind === 'document-reviewer-readiness') {
    const readinessArgs = buildAgentDocumentReviewerReadinessToolArgs(fieldReader(editor, fields));
    const reading = { signal: options?.signal, sourceOwner: agentResearchSourceOwner(deps.toolRegistry),
      assertCurrent: harnessCatalogExecutionGuard(args, options), retainCurrent: retainHarnessCatalogCurrent(args) };
    const resolved = await describeDocumentOpsLane(deps.commandContext, readinessArgs, reading);
    reading.assertCurrent();
    if (resolved.status !== 'found') {
      return error(resolved.status === 'ambiguous'
        ? `Ambiguous Document Ops lane reviewer_readiness. Candidates: ${JSON.stringify(resolved.candidates)}`
        : resolved.usage);
    }
    return output({
      status: 'executed_harness_lane',
      action: action.id,
      tool: 'agent_harness',
      output: resolved.lane,
      modelExecution: describeWorkspaceEditorModelExecution(editor.kind),
    });
  }
  if (editor.kind === 'document-review-packet-wizard') {
    const wizardArgs = buildAgentDocumentReviewPacketWizardToolArgs(fieldReader(editor, fields));
    const reading = { signal: options?.signal, sourceOwner: agentResearchSourceOwner(deps.toolRegistry),
      assertCurrent: harnessCatalogExecutionGuard(args, options), retainCurrent: retainHarnessCatalogCurrent(args) };
    const resolved = await describeDocumentOpsLane(deps.commandContext, wizardArgs, reading);
    reading.assertCurrent();
    if (resolved.status !== 'found') {
      return error(resolved.status === 'ambiguous'
        ? `Ambiguous Document Ops lane review_packet_wizard. Candidates: ${JSON.stringify(resolved.candidates)}`
        : resolved.usage);
    }
    return output({
      status: 'executed_harness_lane',
      action: action.id,
      tool: 'agent_harness',
      output: resolved.lane,
      modelExecution: describeWorkspaceEditorModelExecution(editor.kind),
    });
  }
  if (editor.kind === 'document-review-packet-preset') {
    const confirmationError = requireConfirmedAction(args, options, 'Workspace review packet preset save');
    if (confirmationError) return error(confirmationError);
    const presetArgs = buildAgentDocumentReviewPacketPresetToolArgs(
      fieldReader(editor, fields),
      readString(args.explicitUserRequest),
    );
    const result = await deps.toolRegistry.executeNested(
      'agent-harness-workspace-review-packet-preset',
      'agent_review_packet_presets',
      modelEditorToolArgs(presetArgs, args.explicitUserRequest),
      options,
    );
    return output({
      status: result.success ? 'executed_model_tool' : 'model_tool_failed',
      action: action.id,
      tool: 'agent_review_packet_presets',
      output: result.output ?? null,
      error: result.error ?? null,
      modelExecution: describeWorkspaceEditorModelExecution(editor.kind),
    });
  }
  if (editor.kind === 'document-review-packet-preset-refresh') {
    const confirmationError = requireConfirmedAction(args, options, 'Workspace review packet preset refresh');
    if (confirmationError) return error(confirmationError);
    const presetArgs = buildAgentDocumentReviewPacketPresetRefreshToolArgs(
      fieldReader(editor, fields),
      readString(args.explicitUserRequest),
    );
    const result = await deps.toolRegistry.executeNested(
      'agent-harness-workspace-review-packet-preset-refresh',
      'agent_review_packet_presets',
      modelEditorToolArgs(presetArgs, args.explicitUserRequest),
      options,
    );
    return output({
      status: result.success ? 'executed_model_tool' : 'model_tool_failed',
      action: action.id,
      tool: 'agent_review_packet_presets',
      output: result.output ?? null,
      error: result.error ?? null,
      modelExecution: describeWorkspaceEditorModelExecution(editor.kind),
    });
  }
  if (editor.kind === 'document-review-packet-share') {
    const confirmationError = requireConfirmedAction(args, options, 'Workspace review packet share');
    if (confirmationError) return error(confirmationError);
    const shareArgs = buildAgentDocumentReviewPacketShareToolArgs(
      fieldReader(editor, fields),
      readString(args.explicitUserRequest),
    );
    const result = await deps.toolRegistry.executeNested(
      'agent-harness-workspace-review-packet-share',
      'agent_review_packet_share',
      modelEditorToolArgs(shareArgs, args.explicitUserRequest),
      options,
    );
    return output({
      status: result.success ? 'executed_model_tool' : 'model_tool_failed',
      action: action.id,
      tool: 'agent_review_packet_share',
      output: result.output ?? null,
      error: result.error ?? null,
      modelExecution: describeWorkspaceEditorModelExecution(editor.kind),
    });
  }

  if (editor.kind === 'model-compare' || editor.kind === 'local-model-benchmark') {
    const confirmationError = requireConfirmedAction(args, options, 'Workspace blind model comparison');
    if (confirmationError) return error(confirmationError);
    const compareToolArgs = buildAgentModelCompareToolArgs(
      fieldReader(editor, fields),
      readString(args.explicitUserRequest),
    );
    const result = await deps.toolRegistry.executeNested(
      'agent-harness-workspace-model-compare',
      'agent_model_compare',
      modelEditorToolArgs(compareToolArgs, args.explicitUserRequest),
      options,
    );
    return output({
      status: result.success ? 'executed_model_tool' : 'model_tool_failed',
      action: action.id,
      tool: 'agent_model_compare',
      output: result.output ?? null,
      error: result.error ?? null,
      modelExecution: describeWorkspaceEditorModelExecution(editor.kind),
    });
  }

  if (editor.kind === 'model-compare-review') {
    const reviewToolArgs = buildAgentModelCompareReviewToolArgs(fieldReader(editor, fields));
    const result = await deps.toolRegistry.executeNested(
      'agent-harness-workspace-model-compare-review',
      'agent_model_compare',
      modelEditorToolArgs(reviewToolArgs, args.explicitUserRequest),
      options,
    );
    return output({
      status: result.success ? 'executed_model_tool' : 'model_tool_failed',
      action: action.id,
      tool: 'agent_model_compare',
      output: result.output ?? null,
      error: result.error ?? null,
      modelExecution: describeWorkspaceEditorModelExecution(editor.kind),
    });
  }

  if (editor.kind === 'model-compare-handoff-diff') {
    const handoffDiffArgs = buildAgentModelCompareHandoffDiffToolArgs(fieldReader(editor, fields));
    const result = await deps.toolRegistry.executeNested(
      'agent-harness-workspace-model-compare-handoff-diff',
      'agent_model_compare',
      modelEditorToolArgs(handoffDiffArgs, args.explicitUserRequest),
      options,
    );
    return output({
      status: result.success ? 'executed_model_tool' : 'model_tool_failed',
      action: action.id,
      tool: 'agent_model_compare',
      output: result.output ?? null,
      error: result.error ?? null,
      modelExecution: describeWorkspaceEditorModelExecution(editor.kind),
    });
  }

  if (editor.kind === 'model-compare-judge') {
    const confirmationError = requireConfirmedAction(args, options, 'Workspace comparison judgment');
    if (confirmationError) return error(confirmationError);
    const judgmentToolArgs = buildAgentModelCompareJudgmentToolArgs(
      fieldReader(editor, fields),
      readString(args.explicitUserRequest),
    );
    const result = await deps.toolRegistry.executeNested(
      'agent-harness-workspace-model-compare-judge',
      'agent_model_compare',
      modelEditorToolArgs(judgmentToolArgs, args.explicitUserRequest),
      options,
    );
    return output({
      status: result.success ? 'executed_model_tool' : 'model_tool_failed',
      action: action.id,
      tool: 'agent_model_compare',
      output: result.output ?? null,
      error: result.error ?? null,
      modelExecution: describeWorkspaceEditorModelExecution(editor.kind),
    });
  }

  if (editor.kind === 'model-compare-apply') {
    const confirmationError = requireConfirmedAction(args, options, 'Workspace comparison route update');
    if (confirmationError) return error(confirmationError);
    const applyToolArgs = buildAgentModelCompareApplyToolArgs(
      fieldReader(editor, fields),
      readString(args.explicitUserRequest),
    );
    const result = await deps.toolRegistry.executeNested(
      'agent-harness-workspace-model-compare-apply',
      'agent_model_compare',
      modelEditorToolArgs(applyToolArgs, args.explicitUserRequest),
      options,
    );
    return output({
      status: result.success ? 'executed_model_tool' : 'model_tool_failed',
      action: action.id,
      tool: 'agent_model_compare',
      output: result.output ?? null,
      error: result.error ?? null,
      modelExecution: describeWorkspaceEditorModelExecution(editor.kind),
    });
  }

  if (editor.kind === 'model-compare-route-decision') {
    const confirmationError = requireConfirmedAction(args, options, 'Workspace comparison route decision');
    if (confirmationError) return error(confirmationError);
    const routeDecisionToolArgs = buildAgentModelCompareRouteDecisionToolArgs(
      fieldReader(editor, fields),
      readString(args.explicitUserRequest),
    );
    const result = await deps.toolRegistry.executeNested(
      'agent-harness-workspace-model-compare-route-decision',
      'agent_model_compare',
      modelEditorToolArgs(routeDecisionToolArgs, args.explicitUserRequest),
      options,
    );
    return output({
      status: result.success ? 'executed_model_tool' : 'model_tool_failed',
      action: action.id,
      tool: 'agent_model_compare',
      output: result.output ?? null,
      error: result.error ?? null,
      modelExecution: describeWorkspaceEditorModelExecution(editor.kind),
    });
  }

  if (editor.kind === 'model-compare-export') {
    const confirmationError = requireConfirmedAction(args, options, 'Workspace comparison export');
    if (confirmationError) return error(confirmationError);
    const exportToolArgs = buildAgentModelCompareExportToolArgs(
      fieldReader(editor, fields),
      readString(args.explicitUserRequest),
    );
    const result = await deps.toolRegistry.executeNested(
      'agent-harness-workspace-model-compare-export',
      'agent_model_compare',
      modelEditorToolArgs(exportToolArgs, args.explicitUserRequest),
      options,
    );
    return output({
      status: result.success ? 'executed_model_tool' : 'model_tool_failed',
      action: action.id,
      tool: 'agent_model_compare',
      output: result.output ?? null,
      error: result.error ?? null,
      modelExecution: describeWorkspaceEditorModelExecution(editor.kind),
    });
  }

  if (editor.kind === 'model-compare-analytics') {
    const analyticsToolArgs = buildAgentModelCompareAnalyticsToolArgs(fieldReader(editor, fields));
    const result = await deps.toolRegistry.executeNested(
      'agent-harness-workspace-model-compare-analytics',
      'agent_model_compare',
      modelEditorToolArgs(analyticsToolArgs, args.explicitUserRequest),
      options,
    );
    return output({
      status: result.success ? 'executed_model_tool' : 'model_tool_failed',
      action: action.id,
      tool: 'agent_model_compare',
      output: result.output ?? null,
      error: result.error ?? null,
      modelExecution: describeWorkspaceEditorModelExecution(editor.kind),
    });
  }

  if (!isAgentWorkspaceCommandEditorKind(editor.kind)) {
    if (
      editor.kind === 'memory'
      || editor.kind === 'note'
      || editor.kind === 'persona'
      || editor.kind === 'skill'
      || editor.kind === 'routine'
    ) {
      return runLocalWorkspaceEditorAction(deps, editor, args, options);
    }
    return output({
      status: 'model_tool_required',
      action: action.id,
      editor: describeWorkspaceEditor(editor),
      modelExecution: describeWorkspaceEditorModelExecution(editor.kind),
    });
  }

  const submission = buildAgentWorkspaceCommandEditorSubmission(
    editor,
    fieldReader(editor, fields),
    true,
    true,
  );
  if (submission.kind === 'editor') {
    return output({
      status: submission.status,
      action: action.id,
      editor: describeWorkspaceEditor(submission.editor),
      modelExecution: describeWorkspaceEditorModelExecution(editor.kind),
      actionResult: submission.actionResult ?? null,
    });
  }
  if (submission.kind === 'prompt') {
    return output({
      status: submission.status,
      action: action.id,
      prompt: submission.prompt,
      actionResult: submission.actionResult,
      modelExecution: describeWorkspaceEditorModelExecution(editor.kind),
      note: 'This workspace action submits a normal main-conversation prompt in the TUI. In model-tool context, use the returned prompt as the conversation task instead of creating a hidden nested turn.',
    });
  }
  return runTranslatedWorkspaceCommand(deps, args, submission.command, options);
}

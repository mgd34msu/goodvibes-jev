import { buildAgentArtifactBrowserToolArgs, buildAgentArtifactExportToolArgs, buildAgentArtifactPackageToolArgs, buildAgentArtifactPromoteKnowledgeToolArgs, buildAgentArtifactShowToolArgs } from '../input/agent-workspace-artifact-browser-editor.ts';
import { buildAgentDocumentReviewerReadinessToolArgs, buildAgentDocumentReviewPacketPresetRefreshToolArgs, buildAgentDocumentReviewPacketPresetToolArgs, buildAgentDocumentReviewPacketShareToolArgs, buildAgentDocumentReviewPacketWizardToolArgs } from '../input/agent-workspace-document-ops-editor.ts';
import { buildAgentDocumentToolArgs } from '../input/agent-workspace-document-editor.ts';
import { buildAgentWorkspaceCommandEditorSubmission, isAgentWorkspaceCommandEditorKind } from '../input/agent-workspace-command-editor.ts';
import { buildAgentModelCompareAnalyticsToolArgs, buildAgentModelCompareApplyToolArgs, buildAgentModelCompareExportToolArgs, buildAgentModelCompareHandoffDiffToolArgs, buildAgentModelCompareJudgmentToolArgs, buildAgentModelCompareReviewToolArgs, buildAgentModelCompareRouteDecisionToolArgs, buildAgentModelCompareToolArgs } from '../input/agent-workspace-model-compare-editor.ts';
import { buildAgentResearchReportToolArgs } from '../input/agent-workspace-research-report-editor.ts';
import { buildAgentResearchRunToolArgs } from '../input/agent-workspace-research-run-editor.ts';
import { buildAgentResearchSourceToolArgs } from '../input/agent-workspace-research-source-editor.ts';
import { isAffirmative, splitList } from '../input/agent-workspace-editors.ts';
import { createAgentWorkspaceLearnedBehavior } from '../input/agent-workspace-learned-behavior.ts';
import type { AgentWorkspaceAction, AgentWorkspaceLocalEditor } from '../input/agent-workspace-types.ts';
import { describeDocumentOpsLane } from './agent-harness-document-ops.ts';
import { runLocalWorkspaceEditorAction } from './agent-harness-local-operations.ts';
import { describeWorkspaceEditorModelExecution } from './agent-harness-workspace-editor-execution.ts';
import { describeWorkspaceEditor } from './agent-harness-workspace-actions.ts';
import { runCommand } from './agent-harness-command-runner.ts';
import type { AgentHarnessToolArgs, AgentHarnessToolDeps } from './agent-harness-tool-types.ts';
import { error, output, readFieldMap, readString, requireConfirmedAction } from './agent-harness-tool-utils.ts';

function fieldReader(editor: AgentWorkspaceLocalEditor, fields: Readonly<Record<string, string>>): (fieldId: string) => string {
  return (fieldId: string) => fields[fieldId] ?? editor.fields.find((field) => field.id === fieldId)?.value ?? '';
}

function missingRequiredEditorFields(editor: AgentWorkspaceLocalEditor, fields: Readonly<Record<string, string>>): readonly string[] {
  const readField = fieldReader(editor, fields);
  return editor.fields
    .filter((field) => field.required && !readField(field.id).trim())
    .map((field) => field.id);
}

export async function runWorkspaceEditorAction(
  deps: AgentHarnessToolDeps,
  action: AgentWorkspaceAction,
  editor: AgentWorkspaceLocalEditor,
  args: AgentHarnessToolArgs,
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
    const confirmationError = requireConfirmedAction(args, 'Workspace learned-behavior capture');
    if (confirmationError) return error(confirmationError);
    const shellPaths = deps.commandContext.workspace.shellPaths;
    if (!shellPaths) return error('Agent shell paths are unavailable.');
    const readField = fieldReader(editor, fields);
    const target = readField('target').trim().toLowerCase();
    if (target !== 'skill' && target !== 'routine' && target !== 'persona') {
      return error('learned-behavior target must be skill, routine, or persona.');
    }
    const created = createAgentWorkspaceLearnedBehavior(shellPaths, {
      target,
      name: readField('name'),
      description: readField('description'),
      notes: readField('notes'),
      tags: splitList(readField('tags')),
      triggers: splitList(readField('triggers')),
      enable: isAffirmative(readField('enable')),
    });
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
    return runCommand(deps, {
      ...args,
      command: parts.map((part, index) => index < 2 || part.startsWith('--') ? part : JSON.stringify(part)).join(' '),
    });
  }

  if (editor.kind === 'artifact-browser') {
    const artifactsToolArgs = buildAgentArtifactBrowserToolArgs(fieldReader(editor, fields));
    const result = await deps.toolRegistry.execute(
      'agent-harness-workspace-artifact-browser',
      'agent_artifacts',
      artifactsToolArgs as unknown as Record<string, unknown>,
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
    const result = await deps.toolRegistry.execute(
      'agent-harness-workspace-artifact-show',
      'agent_artifacts',
      artifactToolArgs as unknown as Record<string, unknown>,
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
    const confirmationError = requireConfirmedAction(args, 'Workspace artifact export');
    if (confirmationError) return error(confirmationError);
    const formConfirmation = fieldReader(editor, fields)('confirm').trim().toLowerCase();
    if (formConfirmation !== 'yes' && formConfirmation !== 'true') {
      return output({
        status: 'not_confirmed',
        action: action.id,
        editor: describeWorkspaceEditor(editor),
        modelExecution: describeWorkspaceEditorModelExecution(editor.kind),
        note: 'Type yes in the editor confirmation field before exporting the artifact to a workspace file.',
      });
    }
    const artifactToolArgs = buildAgentArtifactExportToolArgs(
      fieldReader(editor, fields),
      readString(args.explicitUserRequest) || 'Export a reviewed saved Agent artifact to a workspace file.',
    );
    const result = await deps.toolRegistry.execute(
      'agent-harness-workspace-artifact-export',
      'agent_artifacts',
      artifactToolArgs as unknown as Record<string, unknown>,
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
    const confirmationError = requireConfirmedAction(args, 'Workspace artifact package export');
    if (confirmationError) return error(confirmationError);
    const readField = fieldReader(editor, fields);
    const formConfirmation = readField('confirm').trim().toLowerCase();
    if (formConfirmation !== 'yes' && formConfirmation !== 'true') {
      return output({
        status: 'not_confirmed',
        action: action.id,
        editor: describeWorkspaceEditor(editor),
        modelExecution: describeWorkspaceEditorModelExecution(editor.kind),
        note: 'Type yes in the editor confirmation field before exporting the selected artifacts to a package output.',
      });
    }
    const packageFormat = readField('packageFormat').trim().toLowerCase();
    const defaultRequest = packageFormat === 'zip' || packageFormat === 'archive'
      ? 'Export reviewed saved Agent artifacts to a workspace ZIP archive.'
      : 'Export reviewed saved Agent artifacts to a workspace package directory.';
    const artifactToolArgs = buildAgentArtifactPackageToolArgs(
      readField,
      readString(args.explicitUserRequest) || defaultRequest,
    );
    const result = await deps.toolRegistry.execute(
      'agent-harness-workspace-artifact-package-export',
      'agent_artifacts',
      artifactToolArgs as unknown as Record<string, unknown>,
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
    const confirmationError = requireConfirmedAction(args, 'Workspace artifact Knowledge promotion');
    if (confirmationError) return error(confirmationError);
    const formConfirmation = fieldReader(editor, fields)('confirm').trim().toLowerCase();
    if (formConfirmation !== 'yes' && formConfirmation !== 'true') {
      return output({
        status: 'not_confirmed',
        action: action.id,
        editor: describeWorkspaceEditor(editor),
        modelExecution: describeWorkspaceEditorModelExecution(editor.kind),
        note: 'Type yes in the editor confirmation field before ingesting the artifact into Agent Knowledge.',
      });
    }
    const ingestToolArgs = buildAgentArtifactPromoteKnowledgeToolArgs(
      fieldReader(editor, fields),
      readString(args.explicitUserRequest) || 'Promote a reviewed saved Agent artifact into isolated Agent Knowledge.',
    );
    const result = await deps.toolRegistry.execute(
      'agent-harness-workspace-artifact-promote-knowledge',
      'agent_knowledge_ingest',
      ingestToolArgs as unknown as Record<string, unknown>,
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
    const confirmationError = requireConfirmedAction(args, 'Workspace research report artifact save');
    if (confirmationError) return error(confirmationError);
    const formConfirmation = fieldReader(editor, fields)('confirm').trim().toLowerCase();
    if (formConfirmation !== 'yes' && formConfirmation !== 'true') {
      return output({
        status: 'not_confirmed',
        action: action.id,
        editor: describeWorkspaceEditor(editor),
        modelExecution: describeWorkspaceEditorModelExecution(editor.kind),
        note: 'Type yes in the editor confirmation field before saving the sourced research report artifact.',
      });
    }
    const researchToolArgs = buildAgentResearchReportToolArgs(
      fieldReader(editor, fields),
      readString(args.explicitUserRequest) || 'Save a reviewed source-grounded research report as an Agent artifact.',
    );
    const result = await deps.toolRegistry.execute(
      'agent-harness-workspace-research-report',
      'agent_research_report',
      researchToolArgs as unknown as Record<string, unknown>,
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
    const confirmationError = requireConfirmedAction(args, 'Workspace research run creation');
    if (confirmationError) return error(confirmationError);
    const formConfirmation = fieldReader(editor, fields)('confirm').trim().toLowerCase();
    if (formConfirmation !== 'yes' && formConfirmation !== 'true') {
      return output({
        status: 'not_confirmed',
        action: action.id,
        editor: describeWorkspaceEditor(editor),
        modelExecution: describeWorkspaceEditorModelExecution(editor.kind),
        note: 'Type yes in the editor confirmation field before creating the visible local research run.',
      });
    }
    const runToolArgs = buildAgentResearchRunToolArgs(
      fieldReader(editor, fields),
      readString(args.explicitUserRequest) || 'Create one visible checkpointable local research run.',
    );
    const result = await deps.toolRegistry.execute(
      'agent-harness-workspace-research-run',
      'agent_research_runs',
      runToolArgs as unknown as Record<string, unknown>,
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
    const confirmationError = requireConfirmedAction(args, 'Workspace research source queue add');
    if (confirmationError) return error(confirmationError);
    const formConfirmation = fieldReader(editor, fields)('confirm').trim().toLowerCase();
    if (formConfirmation !== 'yes' && formConfirmation !== 'true') {
      return output({
        status: 'not_confirmed',
        action: action.id,
        editor: describeWorkspaceEditor(editor),
        modelExecution: describeWorkspaceEditorModelExecution(editor.kind),
        note: 'Type yes in the editor confirmation field before adding the source to the local research queue.',
      });
    }
    const sourceToolArgs = buildAgentResearchSourceToolArgs(
      fieldReader(editor, fields),
      readString(args.explicitUserRequest) || 'Add one source to the project-local research queue.',
    );
    const result = await deps.toolRegistry.execute(
      'agent-harness-workspace-research-source',
      'agent_research_sources',
      sourceToolArgs as unknown as Record<string, unknown>,
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
      const confirmationError = requireConfirmedAction(args, 'Workspace Agent document action');
      if (confirmationError) return error(confirmationError);
      const formConfirmation = fieldReader(editor, fields)('confirm').trim().toLowerCase();
      if (formConfirmation !== 'yes' && formConfirmation !== 'true') {
        return output({
          status: 'not_confirmed',
          action: action.id,
          editor: describeWorkspaceEditor(editor),
          modelExecution: describeWorkspaceEditorModelExecution(editor.kind),
          note: 'Type yes in the editor confirmation field before changing Agent document drafts.',
        });
      }
    }
    const documentToolArgs = buildAgentDocumentToolArgs(
      editor,
      fieldReader(editor, fields),
      readString(args.explicitUserRequest) || 'Run the Agent document workspace action.',
    );
    const result = await deps.toolRegistry.execute(
      'agent-harness-workspace-document',
      'agent_documents',
      documentToolArgs as unknown as Record<string, unknown>,
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
    const resolved = describeDocumentOpsLane(deps.commandContext, readinessArgs);
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
    const resolved = describeDocumentOpsLane(deps.commandContext, wizardArgs);
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
    const confirmationError = requireConfirmedAction(args, 'Workspace review packet preset save');
    if (confirmationError) return error(confirmationError);
    const formConfirmation = fieldReader(editor, fields)('confirm').trim().toLowerCase();
    if (formConfirmation !== 'yes' && formConfirmation !== 'true') {
      return output({
        status: 'not_confirmed',
        action: action.id,
        editor: describeWorkspaceEditor(editor),
        modelExecution: describeWorkspaceEditorModelExecution(editor.kind),
        note: 'Type yes in the editor confirmation field before saving a review packet preset artifact.',
      });
    }
    const presetArgs = buildAgentDocumentReviewPacketPresetToolArgs(
      fieldReader(editor, fields),
      readString(args.explicitUserRequest) || 'Save the current Document Ops review packet preset from an Agent workspace action.',
    );
    const result = await deps.toolRegistry.execute(
      'agent-harness-workspace-review-packet-preset',
      'agent_review_packet_presets',
      presetArgs as unknown as Record<string, unknown>,
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
    const confirmationError = requireConfirmedAction(args, 'Workspace review packet preset refresh');
    if (confirmationError) return error(confirmationError);
    const formConfirmation = fieldReader(editor, fields)('confirm').trim().toLowerCase();
    if (formConfirmation !== 'yes' && formConfirmation !== 'true') {
      return output({
        status: 'not_confirmed',
        action: action.id,
        editor: describeWorkspaceEditor(editor),
        modelExecution: describeWorkspaceEditorModelExecution(editor.kind),
        note: 'Type yes in the editor confirmation field before refreshing a review packet preset artifact.',
      });
    }
    const presetArgs = buildAgentDocumentReviewPacketPresetRefreshToolArgs(
      fieldReader(editor, fields),
      readString(args.explicitUserRequest) || 'Refresh the Document Ops review packet preset from an Agent workspace action.',
    );
    const result = await deps.toolRegistry.execute(
      'agent-harness-workspace-review-packet-preset-refresh',
      'agent_review_packet_presets',
      presetArgs as unknown as Record<string, unknown>,
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
    const confirmationError = requireConfirmedAction(args, 'Workspace review packet share');
    if (confirmationError) return error(confirmationError);
    const formConfirmation = fieldReader(editor, fields)('confirm').trim().toLowerCase();
    if (formConfirmation !== 'yes' && formConfirmation !== 'true') {
      return output({
        status: 'not_confirmed',
        action: action.id,
        editor: describeWorkspaceEditor(editor),
        modelExecution: describeWorkspaceEditorModelExecution(editor.kind),
        note: 'Type yes in the editor confirmation field before sharing a review packet archive reference.',
      });
    }
    const shareArgs = buildAgentDocumentReviewPacketShareToolArgs(
      fieldReader(editor, fields),
      readString(args.explicitUserRequest) || 'Share the Document Ops review packet archive from an Agent workspace action.',
    );
    const result = await deps.toolRegistry.execute(
      'agent-harness-workspace-review-packet-share',
      'agent_review_packet_share',
      shareArgs as unknown as Record<string, unknown>,
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
    const confirmationError = requireConfirmedAction(args, 'Workspace blind model comparison');
    if (confirmationError) return error(confirmationError);
    const formConfirmation = fieldReader(editor, fields)('confirm').trim().toLowerCase();
    if (formConfirmation !== 'yes' && formConfirmation !== 'true') {
      return output({
        status: 'not_confirmed',
        action: action.id,
        editor: describeWorkspaceEditor(editor),
        modelExecution: describeWorkspaceEditorModelExecution(editor.kind),
        note: 'Type yes in the editor confirmation field before spending model tokens.',
      });
    }
    const compareToolArgs = buildAgentModelCompareToolArgs(
      fieldReader(editor, fields),
      readString(args.explicitUserRequest) || 'Run the blind model comparison from an Agent workspace action.',
    );
    const result = await deps.toolRegistry.execute(
      'agent-harness-workspace-model-compare',
      'agent_model_compare',
      compareToolArgs as unknown as Record<string, unknown>,
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
    const result = await deps.toolRegistry.execute(
      'agent-harness-workspace-model-compare-review',
      'agent_model_compare',
      reviewToolArgs as unknown as Record<string, unknown>,
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
    const result = await deps.toolRegistry.execute(
      'agent-harness-workspace-model-compare-handoff-diff',
      'agent_model_compare',
      handoffDiffArgs as unknown as Record<string, unknown>,
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
    const confirmationError = requireConfirmedAction(args, 'Workspace comparison judgment');
    if (confirmationError) return error(confirmationError);
    const formConfirmation = fieldReader(editor, fields)('confirm').trim().toLowerCase();
    if (formConfirmation !== 'yes' && formConfirmation !== 'true') {
      return output({
        status: 'not_confirmed',
        action: action.id,
        editor: describeWorkspaceEditor(editor),
        modelExecution: describeWorkspaceEditorModelExecution(editor.kind),
        note: 'Type yes in the editor confirmation field before saving the judgment artifact.',
      });
    }
    const judgmentToolArgs = buildAgentModelCompareJudgmentToolArgs(
      fieldReader(editor, fields),
      readString(args.explicitUserRequest) || 'Save the blind model comparison judgment from an Agent workspace action.',
    );
    const result = await deps.toolRegistry.execute(
      'agent-harness-workspace-model-compare-judge',
      'agent_model_compare',
      judgmentToolArgs as unknown as Record<string, unknown>,
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
    const confirmationError = requireConfirmedAction(args, 'Workspace comparison route update');
    if (confirmationError) return error(confirmationError);
    const formConfirmation = fieldReader(editor, fields)('confirm').trim().toLowerCase();
    if (formConfirmation !== 'yes' && formConfirmation !== 'true') {
      return output({
        status: 'not_confirmed',
        action: action.id,
        editor: describeWorkspaceEditor(editor),
        modelExecution: describeWorkspaceEditorModelExecution(editor.kind),
        note: 'Type yes in the editor confirmation field before applying the winning model route.',
      });
    }
    const applyToolArgs = buildAgentModelCompareApplyToolArgs(
      fieldReader(editor, fields),
      readString(args.explicitUserRequest) || 'Apply the revealed blind model comparison judgment from an Agent workspace action.',
    );
    const result = await deps.toolRegistry.execute(
      'agent-harness-workspace-model-compare-apply',
      'agent_model_compare',
      applyToolArgs as unknown as Record<string, unknown>,
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
    const confirmationError = requireConfirmedAction(args, 'Workspace comparison route decision');
    if (confirmationError) return error(confirmationError);
    const formConfirmation = fieldReader(editor, fields)('confirm').trim().toLowerCase();
    if (formConfirmation !== 'yes' && formConfirmation !== 'true') {
      return output({
        status: 'not_confirmed',
        action: action.id,
        editor: describeWorkspaceEditor(editor),
        modelExecution: describeWorkspaceEditorModelExecution(editor.kind),
        note: 'Type yes in the editor confirmation field before saving the route-decision receipt.',
      });
    }
    const routeDecisionToolArgs = buildAgentModelCompareRouteDecisionToolArgs(
      fieldReader(editor, fields),
      readString(args.explicitUserRequest) || 'Record a leave-unchanged blind model comparison route decision from an Agent workspace action.',
    );
    const result = await deps.toolRegistry.execute(
      'agent-harness-workspace-model-compare-route-decision',
      'agent_model_compare',
      routeDecisionToolArgs as unknown as Record<string, unknown>,
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
    const confirmationError = requireConfirmedAction(args, 'Workspace comparison export');
    if (confirmationError) return error(confirmationError);
    const formConfirmation = fieldReader(editor, fields)('confirm').trim().toLowerCase();
    if (formConfirmation !== 'yes' && formConfirmation !== 'true') {
      return output({
        status: 'not_confirmed',
        action: action.id,
        editor: describeWorkspaceEditor(editor),
        modelExecution: describeWorkspaceEditorModelExecution(editor.kind),
        note: 'Type yes in the editor confirmation field before creating the markdown report artifact.',
      });
    }
    const exportToolArgs = buildAgentModelCompareExportToolArgs(
      fieldReader(editor, fields),
      readString(args.explicitUserRequest) || 'Export the saved blind model comparison artifact from an Agent workspace action.',
    );
    const result = await deps.toolRegistry.execute(
      'agent-harness-workspace-model-compare-export',
      'agent_model_compare',
      exportToolArgs as unknown as Record<string, unknown>,
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
    const result = await deps.toolRegistry.execute(
      'agent-harness-workspace-model-compare-analytics',
      'agent_model_compare',
      analyticsToolArgs as unknown as Record<string, unknown>,
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
      return runLocalWorkspaceEditorAction(deps, editor, args);
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
  return runCommand(deps, {
    ...args,
    command: submission.command,
  });
}

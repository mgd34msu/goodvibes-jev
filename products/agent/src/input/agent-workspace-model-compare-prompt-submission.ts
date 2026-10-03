import type { AgentWorkspaceActionResult, AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';
import type { AgentWorkspaceFieldReader } from './agent-workspace-model-compare-types.ts';
import { compareExportMode, compareReviewMode, isAffirmative, quoteBlock, readList, readPositiveInteger } from './agent-workspace-model-compare-utils.ts';

type AgentModelComparePromptSubmissionResult = {
  readonly kind: 'editor';
  readonly editor: AgentWorkspaceLocalEditor;
  readonly status: string;
  readonly actionResult: AgentWorkspaceActionResult;
} | {
  readonly kind: 'prompt';
  readonly prompt: string;
  readonly status: string;
  readonly actionResult: AgentWorkspaceActionResult;
};

export function buildAgentModelComparePromptSubmission(
  editor: AgentWorkspaceLocalEditor,
  readField: AgentWorkspaceFieldReader,
  promptDispatchAvailable: boolean,
): AgentModelComparePromptSubmissionResult {
  if (!isAffirmative(readField('confirm'))) {
    return {
      kind: 'editor',
      editor: {
        ...editor,
        selectedFieldIndex: Math.max(0, editor.fields.findIndex((field) => field.id === 'confirm')),
        message: 'Model comparison not confirmed. Type yes, then press Enter.',
      },
      status: 'Model comparison not confirmed.',
      actionResult: {
        kind: 'error',
        title: 'Model comparison not confirmed',
        detail: 'Type yes on the confirmation field before spending model tokens.',
        safety: 'safe',
      },
    };
  }
  if (!promptDispatchAvailable) {
    return {
      kind: 'editor',
      editor: {
        ...editor,
        message: 'Prompt dispatch is unavailable in this runtime. Use agent_harness mode:"run_workspace_action" with this editor schema.',
      },
      status: 'Prompt dispatch unavailable.',
      actionResult: {
        kind: 'error',
        title: 'Prompt dispatch unavailable',
        detail: 'This runtime cannot submit the comparison request from the workspace form.',
        safety: 'safe',
      },
    };
  }

  const modelRefs = readList(readField('modelRefs'));
  const artifactId = readField('artifactId').trim();
  const candidateCount = readPositiveInteger(readField('candidateCount')) ?? 2;
  const reveal = isAffirmative(readField('reveal'));
  const rubric = readField('rubric').trim();
  const systemPrompt = readField('systemPrompt').trim();
  const maxTokens = readPositiveInteger(readField('maxTokens')) ?? 2048;
  const benchmarkKind = readField('benchmarkKind').trim();
  const taskType = readField('taskType').trim();
  const documentId = readField('documentId').trim();
  const explicitUserRequest = 'Run the blind model comparison from the Agent workspace form.';
  const prompt = [
    'Run a blind model comparison with the `agent_model_compare` tool.',
    'Use confirm:true because this workspace form was explicitly confirmed by the user.',
    `Use explicitUserRequest: ${JSON.stringify(explicitUserRequest)}.`,
    '',
    'Candidate prompt:',
    quoteBlock(readField('prompt')),
    '',
    artifactId ? `Source artifact id: ${artifactId}.` : 'Source artifact id: none.',
    '',
    modelRefs.length > 0
      ? `Candidate models: ${modelRefs.join(', ')}.`
      : `Candidate models: auto-select ${candidateCount} selectable models.`,
    rubric ? `Rubric: ${rubric}` : 'Rubric: none.',
    systemPrompt ? `System prompt: ${systemPrompt}` : 'System prompt: none.',
    `Max tokens per candidate: ${maxTokens}.`,
    benchmarkKind ? `Benchmark kind: ${benchmarkKind}.` : 'Benchmark kind: none.',
    taskType ? `Task type: ${taskType}.` : 'Task type: none.',
    documentId ? `Document id: ${documentId}.` : 'Document id: none.',
    `Reveal identities immediately: ${reveal ? 'yes' : 'no'}.`,
    'Do not change the selected model after the comparison unless the user asks for that route update separately.',
  ].join('\n');

  return {
    kind: 'prompt',
    prompt,
    status: 'Submitting blind model comparison request.',
    actionResult: {
      kind: 'guidance',
      title: 'Blind model comparison',
      detail: 'Submitted a confirmed request to run the first-class model comparison tool.',
      safety: 'safe',
    },
  };
}

export function buildAgentModelCompareReviewPromptSubmission(
  editor: AgentWorkspaceLocalEditor,
  readField: AgentWorkspaceFieldReader,
  promptDispatchAvailable: boolean,
): AgentModelComparePromptSubmissionResult {
  if (!promptDispatchAvailable) {
    return {
      kind: 'editor',
      editor: {
        ...editor,
        message: 'Prompt dispatch is unavailable in this runtime. Use agent_harness mode:"run_workspace_action" with this editor schema.',
      },
      status: 'Prompt dispatch unavailable.',
      actionResult: {
        kind: 'error',
        title: 'Prompt dispatch unavailable',
        detail: 'This runtime cannot submit the comparison review request from the workspace form.',
        safety: 'read-only',
      },
    };
  }

  const mode = compareReviewMode(readField('view'));
  const artifactId = readField('artifactId').trim();
  const comparisonId = readField('comparisonId').trim();
  const leftArtifactId = readField('leftArtifactId').trim() || artifactId;
  const rightArtifactId = readField('rightArtifactId').trim();
  const relatedArtifactIds = readList(readField('relatedArtifactIds'));
  const previewBytes = readPositiveInteger(readField('previewBytes')) ?? 2000;
  const reveal = isAffirmative(readField('reveal'));
  const prompt = [
    mode === 'handoffDiff'
      ? 'Render a visual diff between two saved reviewer handoff artifacts with the `agent_model_compare` tool.'
      : mode === 'sideBySide'
        ? 'Render a side-by-side reviewer view for a saved blind model comparison with the `agent_model_compare` tool.'
        : 'Review a saved blind model comparison with the `agent_model_compare` tool.',
    `Use mode:"${mode}".`,
    artifactId ? `Use artifactId: ${JSON.stringify(artifactId)}.` : 'No artifactId was provided.',
    comparisonId ? `Use comparisonId: ${JSON.stringify(comparisonId)}.` : 'No comparisonId was provided.',
    mode === 'handoffDiff' && leftArtifactId ? `Use leftArtifactId: ${JSON.stringify(leftArtifactId)}.` : '',
    mode === 'handoffDiff' && rightArtifactId ? `Use rightArtifactId: ${JSON.stringify(rightArtifactId)}.` : '',
    relatedArtifactIds.length > 0 ? `Related artifact ids: ${relatedArtifactIds.join(', ')}.` : 'Related artifact ids: none.',
    `Preview bytes: ${previewBytes}.`,
    `Reveal identities in the review: ${reveal ? 'yes' : 'no'}.`,
    mode === 'handoffDiff'
      ? 'If no handoff ids were provided, list recent saved reviewer handoff artifacts.'
      : 'If no ids were provided, list recent saved comparison artifacts.',
    'Do not change the selected model after the review unless the user asks for that route update separately.',
  ].filter(Boolean).join('\n');

  return {
    kind: 'prompt',
    prompt,
    status: `Submitting saved comparison ${mode} request.`,
    actionResult: {
      kind: 'guidance',
      title: mode === 'handoffDiff'
        ? 'Reviewer handoff diff'
        : mode === 'sideBySide'
          ? 'Side-by-side compare review'
          : 'Saved comparison review',
      detail: mode === 'handoffDiff'
        ? 'Submitted a read-only request to compare two saved reviewer handoff artifacts.'
        : mode === 'sideBySide'
          ? 'Submitted a read-only request to compare related artifact excerpts with saved comparison evidence.'
          : 'Submitted a read-only request to review saved blind comparison artifacts.',
      safety: 'read-only',
    },
  };
}

export function buildAgentModelCompareHandoffDiffPromptSubmission(
  editor: AgentWorkspaceLocalEditor,
  readField: AgentWorkspaceFieldReader,
  promptDispatchAvailable: boolean,
): AgentModelComparePromptSubmissionResult {
  if (!promptDispatchAvailable) {
    return {
      kind: 'editor',
      editor: {
        ...editor,
        message: 'Prompt dispatch is unavailable in this runtime. Use agent_harness mode:"run_workspace_action" with this editor schema.',
      },
      status: 'Prompt dispatch unavailable.',
      actionResult: {
        kind: 'error',
        title: 'Prompt dispatch unavailable',
        detail: 'This runtime cannot submit the reviewer handoff diff request from the workspace form.',
        safety: 'read-only',
      },
    };
  }

  const leftArtifactId = readField('leftArtifactId').trim();
  const rightArtifactId = readField('rightArtifactId').trim();
  const sectionId = readField('sectionId').trim() || 'all';
  const prompt = [
    'Render a visual diff between two saved reviewer handoff artifacts with the `agent_model_compare` tool.',
    'Use mode:"handoffDiff".',
    leftArtifactId ? `Use leftArtifactId: ${JSON.stringify(leftArtifactId)}.` : 'No leftArtifactId was provided; list saved reviewer handoffs if either id is missing.',
    rightArtifactId ? `Use rightArtifactId: ${JSON.stringify(rightArtifactId)}.` : 'No rightArtifactId was provided; list saved reviewer handoffs if either id is missing.',
    `Use sectionId: ${JSON.stringify(sectionId)}.`,
    'Use the existing split-pane Agent workspace path for the result; do not change the selected model.',
  ].join('\n');

  return {
    kind: 'prompt',
    prompt,
    status: 'Submitting reviewer handoff diff request.',
    actionResult: {
      kind: 'guidance',
      title: 'Reviewer handoff diff',
      detail: 'Submitted a read-only request to compare two reviewer handoff artifacts with section jump focus.',
      safety: 'read-only',
    },
  };
}

export function buildAgentModelCompareJudgmentPromptSubmission(
  editor: AgentWorkspaceLocalEditor,
  readField: AgentWorkspaceFieldReader,
  promptDispatchAvailable: boolean,
): AgentModelComparePromptSubmissionResult {
  if (!isAffirmative(readField('confirm'))) {
    return {
      kind: 'editor',
      editor: {
        ...editor,
        selectedFieldIndex: Math.max(0, editor.fields.findIndex((field) => field.id === 'confirm')),
        message: 'Judgment not confirmed. Type yes, then press Enter.',
      },
      status: 'Judgment not confirmed.',
      actionResult: {
        kind: 'error',
        title: 'Judgment not confirmed',
        detail: 'Type yes on the confirmation field before saving the judgment artifact.',
        safety: 'safe',
      },
    };
  }
  if (!promptDispatchAvailable) {
    return {
      kind: 'editor',
      editor: {
        ...editor,
        message: 'Prompt dispatch is unavailable in this runtime. Use agent_harness mode:"run_workspace_action" with this editor schema.',
      },
      status: 'Prompt dispatch unavailable.',
      actionResult: {
        kind: 'error',
        title: 'Prompt dispatch unavailable',
        detail: 'This runtime cannot submit the comparison judgment request from the workspace form.',
        safety: 'safe',
      },
    };
  }

  const artifactId = readField('artifactId').trim();
  const comparisonId = readField('comparisonId').trim();
  const winnerBlindId = readField('winnerBlindId').trim();
  const reasons = readField('reasons').trim();
  const notes = readField('notes').trim();
  const reveal = isAffirmative(readField('reveal'));
  const explicitUserRequest = 'Save the blind model comparison judgment from the Agent workspace form.';
  const prompt = [
    'Save a blind model comparison judgment with the `agent_model_compare` tool.',
    'Use confirm:true because this workspace form was explicitly confirmed by the user.',
    `Use explicitUserRequest: ${JSON.stringify(explicitUserRequest)}.`,
    artifactId ? `Use artifactId: ${JSON.stringify(artifactId)}.` : 'No artifactId was provided.',
    comparisonId ? `Use comparisonId: ${JSON.stringify(comparisonId)}.` : 'No comparisonId was provided.',
    `Winner blind id: ${winnerBlindId || '(missing)'}.`,
    `Reasons: ${reasons || '(missing)'}.`,
    notes ? `Notes: ${notes}.` : 'Notes: none.',
    `Reveal model identity in judgment: ${reveal ? 'yes' : 'no'}.`,
    'Do not change the selected model after saving the judgment unless the user asks for that route update separately.',
  ].join('\n');

  return {
    kind: 'prompt',
    prompt,
    status: 'Submitting saved comparison judgment request.',
    actionResult: {
      kind: 'guidance',
      title: 'Saved comparison judgment',
      detail: 'Submitted a confirmed request to save a local comparison judgment artifact.',
      safety: 'safe',
    },
  };
}

export function buildAgentModelCompareApplyPromptSubmission(
  editor: AgentWorkspaceLocalEditor,
  readField: AgentWorkspaceFieldReader,
  promptDispatchAvailable: boolean,
): AgentModelComparePromptSubmissionResult {
  if (!isAffirmative(readField('confirm'))) {
    return {
      kind: 'editor',
      editor: {
        ...editor,
        selectedFieldIndex: Math.max(0, editor.fields.findIndex((field) => field.id === 'confirm')),
        message: 'Route update not confirmed. Type yes, then press Enter.',
      },
      status: 'Route update not confirmed.',
      actionResult: {
        kind: 'error',
        title: 'Route update not confirmed',
        detail: 'Type yes on the confirmation field before applying the winning model route.',
        safety: 'safe',
      },
    };
  }
  if (!promptDispatchAvailable) {
    return {
      kind: 'editor',
      editor: {
        ...editor,
        message: 'Prompt dispatch is unavailable in this runtime. Use agent_harness mode:"run_workspace_action" with this editor schema.',
      },
      status: 'Prompt dispatch unavailable.',
      actionResult: {
        kind: 'error',
        title: 'Prompt dispatch unavailable',
        detail: 'This runtime cannot submit the comparison route update request from the workspace form.',
        safety: 'safe',
      },
    };
  }

  const artifactId = readField('artifactId').trim();
  const explicitUserRequest = 'Apply the revealed blind model comparison judgment from the Agent workspace form.';
  const prompt = [
    'Apply a revealed blind model comparison judgment with the `agent_model_compare` tool.',
    'Use mode:"apply" and confirm:true because this workspace form was explicitly confirmed by the user.',
    `Use explicitUserRequest: ${JSON.stringify(explicitUserRequest)}.`,
    artifactId ? `Use artifactId: ${JSON.stringify(artifactId)}.` : 'No artifactId was provided.',
    'Only proceed if the judgment artifact includes a revealed winner model.',
  ].join('\n');

  return {
    kind: 'prompt',
    prompt,
    status: 'Submitting comparison route update request.',
    actionResult: {
      kind: 'guidance',
      title: 'Apply compare winner',
      detail: 'Submitted a confirmed request to apply a revealed comparison judgment to the selected model route.',
      safety: 'safe',
    },
  };
}

export function buildAgentModelCompareRouteDecisionPromptSubmission(
  editor: AgentWorkspaceLocalEditor,
  readField: AgentWorkspaceFieldReader,
  promptDispatchAvailable: boolean,
): AgentModelComparePromptSubmissionResult {
  if (!isAffirmative(readField('confirm'))) {
    return {
      kind: 'editor',
      editor: {
        ...editor,
        selectedFieldIndex: Math.max(0, editor.fields.findIndex((field) => field.id === 'confirm')),
        message: 'Route decision not confirmed. Type yes, then press Enter.',
      },
      status: 'Route decision not confirmed.',
      actionResult: {
        kind: 'error',
        title: 'Route decision not confirmed',
        detail: 'Type yes on the confirmation field before saving a leave-unchanged route-decision receipt.',
        safety: 'safe',
      },
    };
  }
  if (!promptDispatchAvailable) {
    return {
      kind: 'editor',
      editor: {
        ...editor,
        message: 'Prompt dispatch is unavailable in this runtime. Use agent_harness mode:"run_workspace_action" with this editor schema.',
      },
      status: 'Prompt dispatch unavailable.',
      actionResult: {
        kind: 'error',
        title: 'Prompt dispatch unavailable',
        detail: 'This runtime cannot submit the comparison route-decision receipt request from the workspace form.',
        safety: 'safe',
      },
    };
  }

  const artifactId = readField('artifactId').trim();
  const explicitUserRequest = 'Record that the revealed blind model comparison judgment should leave the current Agent model route unchanged.';
  const prompt = [
    'Record a blind model comparison route-decision receipt with the `agent_model_compare` tool.',
    'Use mode:"routeDecision", decision:"left-unchanged", and confirm:true because this workspace form was explicitly confirmed by the user.',
    `Use explicitUserRequest: ${JSON.stringify(explicitUserRequest)}.`,
    artifactId ? `Use artifactId: ${JSON.stringify(artifactId)}.` : 'No artifactId was provided.',
    'Do not change the selected model route from this form.',
  ].join('\n');

  return {
    kind: 'prompt',
    prompt,
    status: 'Submitting comparison route-decision receipt request.',
    actionResult: {
      kind: 'guidance',
      title: 'Record route decision',
      detail: 'Submitted a confirmed request to save a leave-unchanged comparison route-decision receipt.',
      safety: 'safe',
    },
  };
}

export function buildAgentModelCompareExportPromptSubmission(
  editor: AgentWorkspaceLocalEditor,
  readField: AgentWorkspaceFieldReader,
  promptDispatchAvailable: boolean,
): AgentModelComparePromptSubmissionResult {
  if (!isAffirmative(readField('confirm'))) {
    return {
      kind: 'editor',
      editor: {
        ...editor,
        selectedFieldIndex: Math.max(0, editor.fields.findIndex((field) => field.id === 'confirm')),
        message: 'Export not confirmed. Type yes, then press Enter.',
      },
      status: 'Export not confirmed.',
      actionResult: {
        kind: 'error',
        title: 'Export not confirmed',
        detail: 'Type yes on the confirmation field before creating the markdown report artifact.',
        safety: 'safe',
      },
    };
  }
  if (!promptDispatchAvailable) {
    return {
      kind: 'editor',
      editor: {
        ...editor,
        message: 'Prompt dispatch is unavailable in this runtime. Use agent_harness mode:"run_workspace_action" with this editor schema.',
      },
      status: 'Prompt dispatch unavailable.',
      actionResult: {
        kind: 'error',
        title: 'Prompt dispatch unavailable',
        detail: 'This runtime cannot submit the comparison export request from the workspace form.',
        safety: 'safe',
      },
    };
  }

  const mode = compareExportMode(readField('reportKind'));
  const artifactId = readField('artifactId').trim();
  const relatedArtifactIds = readList(readField('relatedArtifactIds'));
  const reveal = isAffirmative(readField('reveal'));
  const explicitUserRequest = mode === 'handoff'
    ? 'Create a reviewer handoff from the saved blind model comparison artifact in the Agent workspace form.'
    : mode === 'handoffArchive'
      ? 'Create a reviewer handoff ZIP archive from the saved blind model comparison handoff artifact in the Agent workspace form.'
      : 'Export the saved blind model comparison artifact from the Agent workspace form.';
  const prompt = [
    mode === 'handoff'
      ? 'Create a reviewer handoff for a saved blind model comparison or judgment artifact with the `agent_model_compare` tool.'
      : mode === 'handoffArchive'
        ? 'Create a ZIP archive artifact from a saved blind model comparison reviewer handoff with the `agent_model_compare` tool.'
        : 'Export a saved blind model comparison or judgment artifact with the `agent_model_compare` tool.',
    `Use mode:"${mode}" and confirm:true because this workspace form was explicitly confirmed by the user.`,
    `Use explicitUserRequest: ${JSON.stringify(explicitUserRequest)}.`,
    artifactId ? `Use artifactId: ${JSON.stringify(artifactId)}.` : 'No artifactId was provided.',
    relatedArtifactIds.length > 0 ? `Related artifact ids: ${relatedArtifactIds.join(', ')}.` : 'Related artifact ids: none.',
    `Reveal model identities in comparison exports: ${reveal ? 'yes' : 'no'}.`,
    mode === 'handoffArchive'
      ? 'Create one local ZIP artifact, keep the original handoff/source/evidence artifacts, and do not change model routing.'
      : 'Create one local markdown artifact and do not change model routing.',
  ].join('\n');

  return {
    kind: 'prompt',
    prompt,
    status: `Submitting comparison ${mode} request.`,
    actionResult: {
      kind: 'guidance',
      title: mode === 'handoff'
        ? 'Compare reviewer handoff'
        : mode === 'handoffArchive'
          ? 'Archive reviewer handoff'
          : 'Export compare report',
      detail: mode === 'handoff'
        ? 'Submitted a confirmed request to create a reviewer handoff from saved comparison evidence.'
        : mode === 'handoffArchive'
          ? 'Submitted a confirmed request to create a ZIP archive artifact from a saved reviewer handoff.'
          : 'Submitted a confirmed request to export a saved comparison or judgment as markdown.',
      safety: 'safe',
    },
  };
}

export function buildAgentModelCompareAnalyticsPromptSubmission(
  editor: AgentWorkspaceLocalEditor,
  readField: AgentWorkspaceFieldReader,
  promptDispatchAvailable: boolean,
): AgentModelComparePromptSubmissionResult {
  if (!promptDispatchAvailable) {
    return {
      kind: 'editor',
      editor: {
        ...editor,
        message: 'Prompt dispatch is unavailable in this runtime. Use agent_harness mode:"run_workspace_action" with this editor schema.',
      },
      status: 'Prompt dispatch unavailable.',
      actionResult: {
        kind: 'error',
        title: 'Prompt dispatch unavailable',
        detail: 'This runtime cannot submit the comparison analytics/synthesis request from the workspace form.',
        safety: 'read-only',
      },
    };
  }

  const mode = readField('view').trim().toLowerCase() === 'synthesis' ? 'synthesis' : 'analytics';
  const limit = readPositiveInteger(readField('limit')) ?? 20;
  const benchmarkKind = readField('benchmarkKind').trim();
  const taskType = readField('taskType').trim();
  const documentId = readField('documentId').trim();
  const includeReasons = isAffirmative(readField('includeReasons'));
  const prompt = [
    'Review saved blind model comparison judgments with the `agent_model_compare` tool.',
    `Use mode:"${mode}".`,
    `Judgment limit: ${limit}.`,
    benchmarkKind ? `Benchmark kind filter: ${benchmarkKind}.` : 'Benchmark kind filter: none.',
    taskType ? `Task type filter: ${taskType}.` : 'Task type filter: none.',
    documentId ? `Document id filter: ${documentId}.` : 'Document id filter: none.',
    `Include reason excerpts: ${includeReasons ? 'yes' : 'no'}.`,
    'This is read-only and must not change model routing.',
  ].join('\n');

  return {
    kind: 'prompt',
    prompt,
    status: `Submitting comparison ${mode} request.`,
    actionResult: {
      kind: 'guidance',
      title: mode === 'synthesis' ? 'Compare synthesis' : 'Compare analytics',
      detail: `Submitted a read-only request to ${mode === 'synthesis' ? 'synthesize' : 'summarize'} saved comparison judgments.`,
      safety: 'read-only',
    },
  };
}

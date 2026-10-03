import type { AgentWorkspaceLocalEditor, AgentWorkspaceRecentReviewerHandoffArtifact, AgentWorkspaceReviewPacketDefaults } from './agent-workspace-types.ts';
import type { AgentModelCompareAnalyticsWorkspaceToolArgs, AgentModelCompareApplyWorkspaceToolArgs, AgentModelCompareExportWorkspaceToolArgs, AgentModelCompareHandoffDiffWorkspaceToolArgs, AgentModelCompareJudgmentWorkspaceToolArgs, AgentModelCompareReviewWorkspaceToolArgs, AgentModelCompareRouteDecisionWorkspaceToolArgs, AgentModelCompareWorkspaceToolArgs, AgentWorkspaceFieldReader } from './agent-workspace-model-compare-types.ts';
import { compareExportMode, compareReviewMode, isAffirmative, readList, readPositiveInteger } from './agent-workspace-model-compare-utils.ts';

export type { AgentModelCompareAnalyticsWorkspaceToolArgs, AgentModelCompareApplyWorkspaceToolArgs, AgentModelCompareExportWorkspaceToolArgs, AgentModelCompareHandoffDiffWorkspaceToolArgs, AgentModelCompareJudgmentWorkspaceToolArgs, AgentModelCompareReviewWorkspaceToolArgs, AgentModelCompareRouteDecisionWorkspaceToolArgs, AgentModelCompareWorkspaceToolArgs, AgentWorkspaceFieldReader } from './agent-workspace-model-compare-types.ts';
export { buildAgentModelCompareAnalyticsPromptSubmission, buildAgentModelCompareApplyPromptSubmission, buildAgentModelCompareExportPromptSubmission, buildAgentModelCompareHandoffDiffPromptSubmission, buildAgentModelCompareJudgmentPromptSubmission, buildAgentModelComparePromptSubmission, buildAgentModelCompareReviewPromptSubmission, buildAgentModelCompareRouteDecisionPromptSubmission } from './agent-workspace-model-compare-prompt-submission.ts';

export function createAgentModelCompareEditor(): AgentWorkspaceLocalEditor {
  return {
    kind: 'model-compare',
    mode: 'create',
    title: 'Run Blind Model Compare',
    selectedFieldIndex: 0,
    message: 'Run one prompt against two to four selectable models and save a local JSON review artifact. Leave models blank to auto-select candidates. Type yes on the final field to confirm.',
    fields: [
      { id: 'prompt', label: 'Prompt', value: '', required: true, multiline: true, hint: 'Exact prompt sent identically to every candidate model. Ctrl-J inserts a new line.' },
      { id: 'artifactId', label: 'Source artifact', value: '', required: false, multiline: false, hint: 'Optional saved text artifact id to include identically in the candidate prompt.' },
      { id: 'modelRefs', label: 'Models', value: '', required: false, multiline: true, hint: 'Optional registry keys or model ids, separated by commas or new lines. Blank auto-selects.' },
      { id: 'candidateCount', label: 'Auto count', value: '2', required: false, multiline: false, hint: 'Used only when Models is blank. 2 to 4.' },
      { id: 'rubric', label: 'Rubric', value: '', required: false, multiline: true, hint: 'Optional judging rubric shown with blinded results.' },
      { id: 'systemPrompt', label: 'System prompt', value: '', required: false, multiline: true, hint: 'Optional system prompt sent identically to every candidate.' },
      { id: 'maxTokens', label: 'Max tokens', value: '2048', required: false, multiline: false, hint: 'Per-candidate output cap. Defaults to 2048.' },
      { id: 'benchmarkKind', label: 'Benchmark tag', value: '', required: false, multiline: false, hint: 'Optional benchmark tag for filtered analytics.' },
      { id: 'taskType', label: 'Task type', value: '', required: false, multiline: false, hint: 'Optional tag such as writing, research, code-review, or benchmark.' },
      { id: 'documentId', label: 'Document id', value: '', required: false, multiline: false, hint: 'Optional document id tag. Source document exports can fill this automatically.' },
      { id: 'reveal', label: 'Reveal now', value: 'no', required: false, multiline: false, hint: 'yes/no. Blank or no keeps model identities hidden until reveal.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run a token-spending model comparison and save the local review artifact.' },
    ],
  };
}

export function createAgentLocalModelBenchmarkEditor(): AgentWorkspaceLocalEditor {
  return {
    kind: 'local-model-benchmark',
    mode: 'create',
    title: 'Run Local Model Benchmark',
    selectedFieldIndex: 0,
    message: 'Run the local-route benchmark with the first-class blind comparison tool and save a tagged local review artifact. Enter a local model route plus a baseline route, then type yes on the final field.',
    fields: [
      {
        id: 'prompt',
        label: 'Prompt',
        value: [
          'Benchmark this local route on one practical task:',
          '1. summarize the current project goal in five bullets,',
          '2. identify one likely setup risk,',
          '3. propose one next action with a command or route.',
        ].join(' '),
        required: true,
        multiline: true,
        hint: 'Exact benchmark prompt sent identically to every candidate model. Ctrl-J inserts a new line.',
      },
      { id: 'artifactId', label: 'Source artifact', value: '', required: false, multiline: false, hint: 'Optional saved text artifact id to include identically in the benchmark prompt.' },
      { id: 'modelRefs', label: 'Models', value: '', required: false, multiline: true, hint: 'Recommended: local route first, then current/baseline route. Registry keys or model ids, separated by commas or new lines.' },
      { id: 'candidateCount', label: 'Auto count', value: '2', required: false, multiline: false, hint: 'Used only when Models is blank. 2 to 4.' },
      { id: 'rubric', label: 'Rubric', value: 'Prefer fast first useful output, correct project context, concrete setup-risk identification, and one actionable next route or command.', required: false, multiline: true, hint: 'Judging rubric shown with blinded benchmark results.' },
      { id: 'systemPrompt', label: 'System prompt', value: '', required: false, multiline: true, hint: 'Optional system prompt sent identically to every candidate.' },
      { id: 'maxTokens', label: 'Max tokens', value: '1024', required: false, multiline: false, hint: 'Per-candidate output cap. Defaults to 1024 for this benchmark.' },
      { id: 'benchmarkKind', label: 'Benchmark tag', value: 'local-model-route', required: false, multiline: false, hint: 'Keeps the saved comparison visible in local model benchmark history.' },
      { id: 'taskType', label: 'Task type', value: 'local-model-route', required: false, multiline: false, hint: 'Tags the saved judgment trend for filtered analytics.' },
      { id: 'reveal', label: 'Reveal now', value: 'no', required: false, multiline: false, hint: 'yes/no. Blank or no keeps model identities hidden until reveal.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to spend model tokens and save the local benchmark artifact.' },
    ],
  };
}

export function createAgentModelCompareReviewEditor(): AgentWorkspaceLocalEditor {
  return {
    kind: 'model-compare-review',
    mode: 'create',
    title: 'Review Saved Compare',
    selectedFieldIndex: 0,
    message: 'Review saved blind comparison artifacts, render related evidence side by side, or compare two reviewer handoffs. Leave ids blank to list recent saved comparisons or handoffs.',
    fields: [
      { id: 'view', label: 'View', value: 'review', required: false, multiline: false, hint: 'review, sideBySide, or handoffDiff. Diff compares two saved reviewer handoff artifacts.' },
      { id: 'artifactId', label: 'Artifact id', value: '', required: false, multiline: false, hint: 'Saved artifact id such as artifact-123. Blank lists recent saved comparisons.' },
      { id: 'comparisonId', label: 'Comparison id', value: '', required: false, multiline: false, hint: 'Comparison id such as cmp_... if known. Artifact id is usually easier.' },
      { id: 'leftArtifactId', label: 'Left handoff', value: '', required: false, multiline: false, hint: 'For handoffDiff: first saved reviewer handoff artifact id. Artifact id can also fill this.' },
      { id: 'rightArtifactId', label: 'Right handoff', value: '', required: false, multiline: false, hint: 'For handoffDiff: second saved reviewer handoff artifact id.' },
      { id: 'relatedArtifactIds', label: 'Related artifacts', value: '', required: false, multiline: true, hint: 'For sideBySide: document export, archive, or artifact ids, separated by commas or new lines.' },
      { id: 'previewBytes', label: 'Preview bytes', value: '2000', required: false, multiline: false, hint: 'For sideBySide: max bytes per related artifact preview, 200 to 10000.' },
      { id: 'reveal', label: 'Reveal', value: 'no', required: false, multiline: false, hint: 'yes/no. No keeps identities hidden and renders the blind review board.' },
    ],
  };
}

export function createAgentModelCompareHandoffDiffEditor(
  recentHandoffs: readonly AgentWorkspaceRecentReviewerHandoffArtifact[] = [],
): AgentWorkspaceLocalEditor {
  const right = recentHandoffs.length >= 2 ? recentHandoffs[0] : undefined;
  const left = recentHandoffs.length >= 2 ? recentHandoffs[1] : undefined;
  const recentHint = recentHandoffs.length >= 2
    ? ` Prefilled with the two newest handoffs: ${left?.id ?? ''} -> ${right?.id ?? ''}.`
    : ' Leave both ids blank to list recent saved handoffs.';
  return {
    kind: 'model-compare-handoff-diff',
    mode: 'create',
    title: 'Diff Reviewer Handoffs',
    selectedFieldIndex: 0,
    message: `Compare two saved reviewer handoff artifacts in the workspace split view. Use Section jump to focus the diff on all, metadata, policy, related, or comparison evidence.${recentHint}`,
    fields: [
      { id: 'leftArtifactId', label: 'Left handoff', value: left?.id ?? '', required: false, multiline: false, hint: left ? `Older handoff ${left.handoffId}; source ${left.sourceArtifactId}; related ${left.relatedArtifactCount}. Clear both ids to list saved handoffs.` : 'First saved reviewer handoff artifact id. Leave both handoff fields blank to list recent saved handoffs.' },
      { id: 'rightArtifactId', label: 'Right handoff', value: right?.id ?? '', required: false, multiline: false, hint: right ? `Newer handoff ${right.handoffId}; source ${right.sourceArtifactId}; related ${right.relatedArtifactCount}. Clear both ids to list saved handoffs.` : 'Second saved reviewer handoff artifact id. Leave both handoff fields blank to list recent saved handoffs.' },
      { id: 'sectionId', label: 'Section jump', value: 'all', required: false, multiline: false, hint: 'all, metadata, policy, related, or comparison. Related focuses changed document/artifact evidence.' },
    ],
  };
}

export function createAgentModelCompareJudgmentEditor(): AgentWorkspaceLocalEditor {
  return {
    kind: 'model-compare-judge',
    mode: 'create',
    title: 'Save Compare Judgment',
    selectedFieldIndex: 0,
    message: 'Save the winning candidate and reasons as a local judgment artifact. This does not change the selected model.',
    fields: [
      { id: 'artifactId', label: 'Artifact id', value: '', required: false, multiline: false, hint: 'Saved comparison artifact id such as artifact-123.' },
      { id: 'comparisonId', label: 'Comparison id', value: '', required: false, multiline: false, hint: 'Comparison id such as cmp_... if known.' },
      { id: 'winnerBlindId', label: 'Winner', value: '', required: true, multiline: false, hint: 'Candidate label, such as A or Candidate B.' },
      { id: 'reasons', label: 'Reasons', value: '', required: true, multiline: true, hint: 'Why this candidate won. Ctrl-J inserts a new line.' },
      { id: 'notes', label: 'Notes', value: '', required: false, multiline: true, hint: 'Optional risks, follow-ups, or rubric notes.' },
      { id: 'reveal', label: 'Reveal in judgment', value: 'no', required: false, multiline: false, hint: 'yes/no. Yes includes model identity for later route update.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to save this judgment artifact.' },
    ],
  };
}

function packetSourceArtifactId(defaults: AgentWorkspaceReviewPacketDefaults | null): string {
  return defaults?.revealedJudgmentArtifactId
    ?? defaults?.judgmentArtifactId
    ?? defaults?.comparisonArtifactId
    ?? '';
}

export function createAgentModelCompareApplyEditor(defaults: AgentWorkspaceReviewPacketDefaults | null = null): AgentWorkspaceLocalEditor {
  const artifactId = defaults?.revealedJudgmentArtifactId ?? '';
  const artifactHint = defaults?.summary
    ? `Default from latest revealed packet judgment. Packet default: ${defaults.summary}. Clear it to choose another saved judgment.`
    : 'Saved revealed judgment artifact id such as artifact-123.';
  return {
    kind: 'model-compare-apply',
    mode: 'create',
    title: 'Apply Compare Winner',
    selectedFieldIndex: 0,
    message: artifactId
      ? 'Apply a revealed saved judgment artifact to the main Agent model route.'
      : 'Apply a revealed saved judgment artifact to the main Agent model route. This changes provider.model after confirmation.',
    fields: [
      { id: 'artifactId', label: 'Judgment artifact id', value: artifactId, required: true, multiline: false, hint: artifactId ? artifactHint : 'Saved revealed judgment artifact id such as artifact-123.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to change the selected Agent model.' },
    ],
  };
}

export function createAgentModelCompareRouteDecisionEditor(defaults: AgentWorkspaceReviewPacketDefaults | null = null): AgentWorkspaceLocalEditor {
  const artifactId = defaults?.revealedJudgmentArtifactId ?? '';
  const artifactHint = defaults?.summary
    ? `Default from latest revealed packet judgment. Packet default: ${defaults.summary}.`
    : 'Saved revealed judgment artifact id such as artifact-123.';
  return {
    kind: 'model-compare-route-decision',
    mode: 'create',
    title: 'Record Route Decision',
    selectedFieldIndex: 0,
    message: artifactId
      ? 'Record that the current Agent model route should stay unchanged for this revealed judgment.'
      : 'Record that the current Agent model route should stay unchanged for a revealed saved judgment.',
    fields: [
      { id: 'artifactId', label: 'Judgment artifact id', value: artifactId, required: true, multiline: false, hint: artifactHint },
      { id: 'decision', label: 'Decision', value: 'left-unchanged', required: true, multiline: false, hint: 'left-unchanged. Use Apply Compare Winner for route updates.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to save the route-decision receipt without changing the selected model.' },
    ],
  };
}

export function createAgentModelCompareExportEditor(defaults: AgentWorkspaceReviewPacketDefaults | null = null): AgentWorkspaceLocalEditor {
  const defaultKind = defaults?.handoffArtifactId
    ? 'archive'
    : defaults?.relatedArtifactIds.length
      ? 'handoff'
      : 'report';
  const artifactId = defaultKind === 'archive'
    ? defaults?.handoffArtifactId ?? ''
    : packetSourceArtifactId(defaults);
  const relatedArtifactIds = defaultKind === 'handoff' ? (defaults?.relatedArtifactIds ?? []).join('\n') : '';
  return {
    kind: 'model-compare-export',
    mode: 'create',
    title: 'Export Compare Report/Handoff',
    selectedFieldIndex: 0,
    message: artifactId
      ? 'Export a saved comparison or judgment as a markdown report, create a reviewer handoff with related document/artifact ids, or archive a saved handoff as one ZIP artifact.'
      : 'Export a saved comparison or judgment as a markdown report, create a reviewer handoff with related document/artifact ids, or archive a saved handoff as one ZIP artifact. This does not change the selected model.',
    fields: [
      { id: 'reportKind', label: 'Kind', value: defaultKind, required: false, multiline: false, hint: defaults?.handoffArtifactId ? `Default archive uses the latest reviewer handoff. Packet default: ${defaults.summary}. Change to report or handoff to use comparison/judgment artifacts.` : defaults?.relatedArtifactIds.length ? `Default handoff carries latest related packet evidence. Packet default: ${defaults.summary}. Change to report for markdown only.` : 'report, handoff, or archive. Archive expects a saved handoff artifact id and creates one ZIP artifact.' },
      { id: 'artifactId', label: 'Artifact id', value: artifactId, required: true, multiline: false, hint: artifactId ? `Default from latest packet comparison, judgment, or reviewer handoff. Packet default: ${defaults?.summary ?? artifactId}. Clear it to choose another saved artifact.` : 'Saved comparison/judgment artifact for report or handoff; saved handoff artifact for archive.' },
      { id: 'relatedArtifactIds', label: 'Related artifacts', value: relatedArtifactIds, required: false, multiline: true, hint: relatedArtifactIds ? `Default related evidence from latest document export, attachments, source artifacts, or handoff metadata. Packet default: ${defaults?.summary ?? relatedArtifactIds}.` : 'For handoff: document export, archive, or artifact ids, separated by commas or new lines.' },
      { id: 'reveal', label: 'Reveal in export', value: defaultKind === 'handoff' ? 'yes' : 'no', required: false, multiline: false, hint: 'yes/no. For comparison artifacts, yes includes model identities. Judgment artifacts use their saved reveal state.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to create the local report, handoff, or ZIP archive artifact.' },
    ],
  };
}

export function createAgentModelCompareAnalyticsEditor(): AgentWorkspaceLocalEditor {
  return {
    kind: 'model-compare-analytics',
    mode: 'create',
    title: 'Compare Analytics/Synthesis',
    selectedFieldIndex: 0,
    message: 'Summarize or synthesize saved blind comparison judgments by winner, model, blind slot, themes, task type, document id, benchmark tag, and recent reasons. This is read-only.',
    fields: [
      { id: 'view', label: 'View', value: 'analytics', required: false, multiline: false, hint: 'analytics or synthesis. Synthesis groups saved judgment themes across sessions.' },
      { id: 'limit', label: 'Judgment limit', value: '20', required: false, multiline: false, hint: 'Maximum saved judgment artifacts to inspect. Defaults to 20.' },
      { id: 'benchmarkKind', label: 'Benchmark tag', value: '', required: false, multiline: false, hint: 'Optional filter, such as local-model-route.' },
      { id: 'taskType', label: 'Task type', value: '', required: false, multiline: false, hint: 'Optional filter, such as writing, research, code-review, or local-model-route.' },
      { id: 'documentId', label: 'Document id', value: '', required: false, multiline: false, hint: 'Optional filter for judgments tied to one Agent document id.' },
      { id: 'includeReasons', label: 'Include reasons', value: 'yes', required: false, multiline: false, hint: 'yes/no. Yes includes short reason and note excerpts in the recent-judgments list.' },
    ],
  };
}

export function buildAgentModelCompareToolArgs(
  readField: AgentWorkspaceFieldReader,
  explicitUserRequest: string,
): AgentModelCompareWorkspaceToolArgs {
  const prompt = readField('prompt').trim();
  const artifactId = readField('artifactId').trim();
  const modelRefs = readList(readField('modelRefs'));
  const candidateCount = readPositiveInteger(readField('candidateCount'));
  const rubric = readField('rubric').trim();
  const systemPrompt = readField('systemPrompt').trim();
  const maxTokens = readPositiveInteger(readField('maxTokens'));
  const benchmarkKind = readField('benchmarkKind').trim();
  const taskType = readField('taskType').trim();
  const documentId = readField('documentId').trim();
  const reveal = isAffirmative(readField('reveal'));

  return {
    mode: 'run',
    prompt,
    ...(artifactId ? { artifactId } : {}),
    ...(modelRefs.length > 0 ? { modelRefs } : {}),
    ...(candidateCount !== null ? { candidateCount } : {}),
    ...(rubric ? { rubric } : {}),
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(maxTokens !== null ? { maxTokens } : {}),
    ...(benchmarkKind ? { benchmarkKind } : {}),
    ...(taskType ? { taskType } : {}),
    ...(documentId ? { documentId } : {}),
    reveal,
    confirm: true,
    explicitUserRequest,
  };
}

export function buildAgentModelCompareReviewToolArgs(
  readField: AgentWorkspaceFieldReader,
): AgentModelCompareReviewWorkspaceToolArgs {
  const mode = compareReviewMode(readField('view'));
  const artifactId = readField('artifactId').trim();
  const comparisonId = readField('comparisonId').trim();
  const leftArtifactId = readField('leftArtifactId').trim() || artifactId;
  const rightArtifactId = readField('rightArtifactId').trim();
  const relatedArtifactIds = readList(readField('relatedArtifactIds'));
  const previewBytes = readPositiveInteger(readField('previewBytes'));
  const reveal = isAffirmative(readField('reveal'));
  if (mode === 'handoffDiff') {
    const sectionId = readField('sectionId').trim();
    return {
      mode,
      ...(leftArtifactId ? { leftArtifactId } : {}),
      ...(rightArtifactId ? { rightArtifactId } : {}),
      ...(sectionId && sectionId.toLowerCase() !== 'all' ? { sectionId } : {}),
      ...(previewBytes !== null ? { previewBytes } : {}),
    };
  }
  return {
    mode,
    ...(artifactId ? { artifactId } : {}),
    ...(comparisonId ? { comparisonId } : {}),
    ...(relatedArtifactIds.length > 0 ? { relatedArtifactIds } : {}),
    ...(previewBytes !== null ? { previewBytes } : {}),
    reveal,
  };
}

export function buildAgentModelCompareHandoffDiffToolArgs(
  readField: AgentWorkspaceFieldReader,
): AgentModelCompareHandoffDiffWorkspaceToolArgs {
  const sectionId = readField('sectionId').trim();
  return {
    mode: 'handoffDiff',
    ...(readField('leftArtifactId').trim() ? { leftArtifactId: readField('leftArtifactId').trim() } : {}),
    ...(readField('rightArtifactId').trim() ? { rightArtifactId: readField('rightArtifactId').trim() } : {}),
    ...(sectionId && sectionId.toLowerCase() !== 'all' ? { sectionId } : {}),
  };
}

export function buildAgentModelCompareJudgmentToolArgs(
  readField: AgentWorkspaceFieldReader,
  explicitUserRequest: string,
): AgentModelCompareJudgmentWorkspaceToolArgs {
  const artifactId = readField('artifactId').trim();
  const comparisonId = readField('comparisonId').trim();
  const notes = readField('notes').trim();
  return {
    mode: 'judge',
    ...(artifactId ? { artifactId } : {}),
    ...(comparisonId ? { comparisonId } : {}),
    winnerBlindId: readField('winnerBlindId').trim(),
    reasons: readField('reasons').trim(),
    ...(notes ? { notes } : {}),
    reveal: isAffirmative(readField('reveal')),
    confirm: true,
    explicitUserRequest,
  };
}

export function buildAgentModelCompareApplyToolArgs(
  readField: AgentWorkspaceFieldReader,
  explicitUserRequest: string,
): AgentModelCompareApplyWorkspaceToolArgs {
  return {
    mode: 'apply',
    artifactId: readField('artifactId').trim(),
    confirm: true,
    explicitUserRequest,
  };
}

export function buildAgentModelCompareRouteDecisionToolArgs(
  readField: AgentWorkspaceFieldReader,
  explicitUserRequest: string,
): AgentModelCompareRouteDecisionWorkspaceToolArgs {
  return {
    mode: 'routeDecision',
    artifactId: readField('artifactId').trim(),
    decision: 'left-unchanged',
    confirm: true,
    explicitUserRequest,
  };
}

export function buildAgentModelCompareExportToolArgs(
  readField: AgentWorkspaceFieldReader,
  explicitUserRequest: string,
): AgentModelCompareExportWorkspaceToolArgs {
  const mode = compareExportMode(readField('reportKind'));
  const relatedArtifactIds = readList(readField('relatedArtifactIds'));
  return {
    mode,
    artifactId: readField('artifactId').trim(),
    ...(relatedArtifactIds.length > 0 ? { relatedArtifactIds } : {}),
    reveal: isAffirmative(readField('reveal')),
    confirm: true,
    explicitUserRequest,
  };
}

export function buildAgentModelCompareAnalyticsToolArgs(
  readField: AgentWorkspaceFieldReader,
): AgentModelCompareAnalyticsWorkspaceToolArgs {
  const view = readField('view').trim().toLowerCase();
  const limit = readPositiveInteger(readField('limit'));
  const benchmarkKind = readField('benchmarkKind').trim();
  const taskType = readField('taskType').trim();
  const documentId = readField('documentId').trim();
  return {
    mode: view === 'synthesis' ? 'synthesis' : 'analytics',
    ...(limit !== null ? { limit } : {}),
    ...(benchmarkKind ? { benchmarkKind } : {}),
    ...(taskType ? { taskType } : {}),
    ...(documentId ? { documentId } : {}),
    includeReasons: isAffirmative(readField('includeReasons')),
  };
}

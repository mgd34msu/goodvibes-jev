import type { CommandContext } from '../input/command-registry.ts';
import { AGENT_WORKSPACE_CATEGORIES } from '../input/agent-workspace-categories.ts';
import { buildAgentWorkspaceRuntimeSnapshot } from '../input/agent-workspace-snapshot.ts';
import type { AgentWorkspaceReviewPacketWizard, AgentWorkspaceReviewPacketWizardStep } from '../input/agent-workspace-types.ts';
import { previewHarnessText } from './agent-harness-text.ts';
import { buildReviewerReadinessChecklist } from './agent-harness-document-ops-reviewer-readiness.ts';
import type {
  AgentHarnessDocumentOpsArgs,
  DocumentOpsLane,
  DocumentOpsLaneId,
  DocumentOpsLaneResolution,
  DocumentOpsStatus,
  ReviewerReadinessCheck,
  ReviewerReadinessChecklist,
} from './agent-harness-document-ops-types.ts';
export type {
  DocumentOpsLaneId,
  DocumentOpsLaneResolution,
} from './agent-harness-document-ops-types.ts';

const LANE_IDS: readonly DocumentOpsLaneId[] = [
  'documents',
  'uploads',
  'exports',
  'reviewer_readiness',
  'review_packet_timeline',
  'review_packet_wizard',
  'source_library',
  'media_artifacts',
  'artifact_browser',
  'model_compare',
];

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function workspaceActionIds(): ReadonlySet<string> {
  return new Set(AGENT_WORKSPACE_CATEGORIES.flatMap((category) => category.actions.map((action) => action.id)));
}

function existingActions(ids: readonly string[], available: ReadonlySet<string>): readonly string[] {
  return ids.filter((id) => available.has(id));
}

function hasTool(context: CommandContext, toolName: string): boolean {
  return context.extensions.toolRegistry.has(toolName);
}

function statusRank(status: DocumentOpsStatus): number {
  if (status === 'attention') return 5;
  if (status === 'ready') return 4;
  if (status === 'partial') return 3;
  if (status === 'needs-setup') return 2;
  return 1;
}

function searchText(lane: DocumentOpsLane): string {
  return [
    lane.id,
    lane.label,
    lane.status,
    lane.outcome,
    lane.current,
    lane.next,
    lane.userRoute,
    lane.modelRoute,
    lane.signals.join('\n'),
    lane.actionIds.join('\n'),
    lane.reviewPacketWizard ? [
      lane.reviewPacketWizard.status,
      lane.reviewPacketWizard.next,
      lane.reviewPacketWizard.finalReview,
      lane.reviewPacketWizard.steps.map((step) => [
        step.id,
        step.label,
        step.status,
        step.detail,
        step.userRoute,
        step.modelRoute,
        step.backtrackRoute ?? '',
      ].join(' ')).join('\n'),
    ].join('\n') : '',
    lane.reviewerReadiness ? [
      lane.reviewerReadiness.status,
      lane.reviewerReadiness.next,
      lane.reviewerReadiness.policy,
      lane.reviewerReadiness.checks.map((check) => [
        check.id,
        check.label,
        check.status,
        check.detail,
        check.inspectRoute,
        check.repairRoute ?? '',
      ].join(' ')).join('\n'),
    ].join('\n') : '',
  ].join('\n').toLowerCase();
}

function describeReviewerReadinessCheck(check: ReviewerReadinessCheck, includeParameters: boolean): Record<string, unknown> {
  return {
    id: check.id,
    label: check.label,
    status: check.status,
    count: check.count,
    detail: previewHarnessText(check.detail, includeParameters ? 180 : 96),
    inspectRoute: previewHarnessText(check.inspectRoute, includeParameters ? 180 : 96),
    ...(check.repairRoute ? { repairRoute: previewHarnessText(check.repairRoute, includeParameters ? 240 : 120) } : {}),
  };
}

function describeReviewerReadiness(checklist: ReviewerReadinessChecklist, includeParameters: boolean): Record<string, unknown> {
  return {
    status: checklist.status,
    next: previewHarnessText(checklist.next, includeParameters ? 220 : 120),
    summary: checklist.summary,
    checks: checklist.checks
      .slice(0, includeParameters ? checklist.checks.length : 4)
      .map((check) => describeReviewerReadinessCheck(check, includeParameters)),
    policy: previewHarnessText(checklist.policy, includeParameters ? 220 : 120),
  };
}

function describeReviewPacketWizardStep(step: AgentWorkspaceReviewPacketWizardStep, includeParameters: boolean): Record<string, unknown> {
  return {
    id: step.id,
    label: step.label,
    status: step.status,
    detail: previewHarnessText(step.detail, includeParameters ? 180 : 96),
    userRoute: previewHarnessText(step.userRoute, includeParameters ? 180 : 96),
    modelRoute: previewHarnessText(step.modelRoute, includeParameters ? 220 : 120),
    actionId: step.actionId,
    ...(step.backtrackRoute ? { backtrackRoute: previewHarnessText(step.backtrackRoute, includeParameters ? 220 : 120) } : {}),
  };
}

function describeReviewPacketPresetLineage(
  lineage: AgentWorkspaceReviewPacketWizard['presetLineage'],
  includeParameters: boolean,
): Record<string, unknown> | null {
  if (!lineage) return null;
  return {
    artifactId: lineage.artifactId,
    presetId: lineage.presetId,
    name: lineage.name,
    refreshed: lineage.refreshed,
    refreshedFromArtifactId: lineage.refreshedFromArtifactId,
    refreshedFromPresetId: lineage.refreshedFromPresetId,
    freshnessMissingCount: lineage.freshnessMissingCount,
    freshnessSupersededCount: lineage.freshnessSupersededCount,
    freshnessUnresolvedCount: lineage.freshnessUnresolvedCount,
    summary: previewHarnessText(lineage.summary, includeParameters ? 220 : 120),
    inspectRoute: previewHarnessText(lineage.inspectRoute, includeParameters ? 220 : 120),
  };
}

function describeReviewPacketWizard(wizard: AgentWorkspaceReviewPacketWizard, includeParameters: boolean): Record<string, unknown> {
  const presetLineage = describeReviewPacketPresetLineage(wizard.presetLineage, includeParameters);
  return {
    status: wizard.status,
    progress: `${wizard.completedSteps}/${wizard.totalSteps}`,
    completedSteps: wizard.completedSteps,
    totalSteps: wizard.totalSteps,
    currentStepId: wizard.currentStepId,
    currentStepLabel: wizard.currentStepLabel,
    next: previewHarnessText(wizard.next, includeParameters ? 240 : 120),
    finalReview: previewHarnessText(wizard.finalReview, includeParameters ? 220 : 120),
    ...(presetLineage ? { presetLineage } : {}),
    steps: wizard.steps
      .slice(0, includeParameters ? wizard.steps.length : 4)
      .map((step) => describeReviewPacketWizardStep(step, includeParameters)),
    policy: 'The review packet wizard is read-only. It guides the user through existing document, comparison, handoff, route-decision, archive, and share routes; every write or external delivery still requires the owning confirmed action.',
  };
}

function describeLane(lane: DocumentOpsLane, includeParameters: boolean): Record<string, unknown> {
  return {
    id: lane.id,
    label: lane.label,
    status: lane.status,
    outcome: lane.outcome,
    current: lane.current,
    next: lane.next,
    userRoute: previewHarnessText(lane.userRoute, 96),
    modelRoute: previewHarnessText(lane.modelRoute, 96),
    signals: lane.signals,
    ...(lane.reviewerReadiness ? { reviewerReadiness: describeReviewerReadiness(lane.reviewerReadiness, includeParameters) } : {}),
    ...(lane.reviewPacketWizard ? { reviewPacketWizard: describeReviewPacketWizard(lane.reviewPacketWizard, includeParameters) } : {}),
    ...(includeParameters ? {
      routes: {
        user: lane.userRoute,
        model: lane.modelRoute,
      },
      actionIds: lane.actionIds,
      safety: 'Document writes, file ingest, export, media generation, model comparison, and model changes stay explicit user-visible actions. Blind model comparison spends tokens only through confirmed agent_model_compare runs.',
    } : {}),
  };
}

function buildLanes(context: CommandContext): readonly DocumentOpsLane[] {
  const snapshot = buildAgentWorkspaceRuntimeSnapshot(context);
  const available = workspaceActionIds();
  const documentActions = existingActions([
    'document-browse-drafts',
    'document-show-draft',
    'document-create-draft',
    'document-revise-draft',
    'document-review-draft',
    'document-comment-draft',
    'document-resolve-comment',
    'document-suggest-draft',
    'document-accept-suggestion',
    'document-reject-suggestion',
    'document-insert-artifact',
    'document-attach-artifact',
    'document-review-packet-timeline',
    'document-review-packet-wizard',
    'document-save-review-packet-preset',
    'document-refresh-review-packet-preset',
    'document-reviewer-readiness',
    'document-export-draft',
    'document-draft-chat',
  ], available);
  const uploadActions = existingActions([
    'document-attach-image',
    'document-ingest-file',
    'document-ingest-url-list',
    'knowledge-import-bookmarks',
    'knowledge-import-browser-history',
    'conversation-image',
  ], available);
  const exportActions = existingActions([
    'conversation-export-current',
    'conversation-session-export',
    'document-export-draft',
    'document-export-artifact-file',
    'document-export-artifact-package',
    'document-export-conversation',
    'document-export-session',
  ], available);
  const sourceActions = existingActions([
    'research-knowledge-search',
    'research-knowledge-ask',
    'document-sources',
    'document-show-source',
  ], available);
  const mediaActions = existingActions([
    'media-providers',
    'media-generate',
    'document-media-providers',
    'document-generate-media',
  ], available);
  const artifactBrowserActions = existingActions([
    'document-browse-artifacts',
    'document-show-artifact',
    'document-export-artifact-file',
    'document-export-artifact-package',
    'document-promote-artifact',
    'document-insert-artifact',
    'document-attach-artifact',
  ], available);
  const modelCompareActions = existingActions([
    'document-run-compare',
    'document-review-compare',
    'document-diff-handoffs',
    'document-judge-compare',
    'document-compare-analytics',
    'document-apply-compare',
    'document-record-route-decision',
    'document-export-compare',
    'document-model-routing',
    'account-main-model',
  ], available);
  const modelCompareReady = hasTool(context, 'agent_model_compare') && modelCompareActions.includes('document-run-compare');
  const documentsReady = hasTool(context, 'agent_documents')
    && documentActions.includes('document-browse-drafts')
    && documentActions.includes('document-show-draft')
    && documentActions.includes('document-create-draft')
    && documentActions.includes('document-revise-draft')
    && documentActions.includes('document-comment-draft')
    && documentActions.includes('document-resolve-comment')
    && documentActions.includes('document-suggest-draft')
    && documentActions.includes('document-accept-suggestion')
    && documentActions.includes('document-reject-suggestion')
    && documentActions.includes('document-insert-artifact')
    && documentActions.includes('document-attach-artifact')
    && documentActions.includes('document-export-draft');
  const artifactBrowserReady = hasTool(context, 'agent_artifacts')
    && hasTool(context, 'agent_knowledge_ingest')
    && Boolean(context.platform.artifactStore?.list)
    && Boolean(context.platform.artifactStore?.readContent)
    && artifactBrowserActions.includes('document-browse-artifacts')
    && artifactBrowserActions.includes('document-show-artifact')
    && artifactBrowserActions.includes('document-export-artifact-file')
    && artifactBrowserActions.includes('document-export-artifact-package')
    && artifactBrowserActions.includes('document-promote-artifact');
  const reviewerReadiness = buildReviewerReadinessChecklist(context, {
    documentsReady,
    modelCompareReady,
    artifactBrowserReady,
  });

  return [
    {
      id: 'documents',
      label: 'Documents',
      status: documentsReady ? 'ready' : 'partial',
      outcome: 'Draft, revise, and export user-facing documents without leaving the Agent conversation.',
      current: documentsReady
        ? 'Agent has project-scoped markdown document drafts with version history, review status, review comments, AI suggestion review, read-only inspection, confirmed artifact attachment, confirmed artifact insertion, and confirmed artifact export with reviewer-ready comment and suggestion appendices.'
        : 'Agent can draft and revise documents in the main conversation and export transcript/session artifacts, but the dedicated markdown draft tool is not fully wired.',
      next: documentsReady
        ? 'Use versioned drafts, comments, suggestions, artifact reuse, artifact packages or ZIP archives, and artifact-backed comparison as one document workflow.'
        : 'Wire agent_documents plus browse/show/create/revise/review/export workspace actions.',
      userRoute: 'Agent Workspace -> Documents & Files -> Create document draft',
      modelRoute: documentsReady ? 'agent_documents' : 'agent_harness mode:"workspace_actions" categoryId:"documents"',
      signals: [
        `Chat route ${snapshot.provider} / ${snapshot.modelDisplayName}`,
        `Document draft tool: ${hasTool(context, 'agent_documents') ? 'available' : 'gap'}`,
        `${documentActions.length} document draft action(s)`,
        `${exportActions.length} export action(s) available`,
        documentsReady ? 'Versioned markdown drafts: available' : 'Versioned markdown drafts: gap',
        documentActions.includes('document-comment-draft') ? 'Review comments: available' : 'Review comments: gap',
        documentActions.includes('document-suggest-draft') ? 'AI suggestion review: available' : 'AI suggestion review: not wired',
        documentActions.includes('document-attach-artifact') ? 'Artifact-to-document attachment: available' : 'Artifact-to-document attachment: gap',
        documentActions.includes('document-insert-artifact') ? 'Artifact-to-document insert: available' : 'Artifact-to-document insert: gap',
        documentActions.includes('document-save-review-packet-preset') ? 'Review packet presets: available' : 'Review packet presets: gap',
        documentActions.includes('document-refresh-review-packet-preset') ? 'Preset refresh: available' : 'Preset refresh: gap',
      ],
      actionIds: documentActions,
    },
    {
      id: 'uploads',
      label: 'Uploads',
      status: uploadActions.length >= 4 ? 'ready' : uploadActions.length > 0 ? 'partial' : 'gap',
      outcome: 'Attach, paste, or ingest files and URLs through explicit user-visible routes.',
      current: `${uploadActions.length} upload/ingest action(s) are reachable from the workspace.`,
      next: uploadActions.length > 0
        ? 'Use attach, paste, or reviewed source ingest depending on whether the file is prompt context or durable Agent Knowledge.'
        : 'Wire upload, paste, and file ingest actions before exposing this as ready.',
      userRoute: 'Agent Workspace -> Documents & Files -> Attach artifact to draft',
      modelRoute: 'agent_harness mode:"workspace_actions" query:"upload file ingest"',
      signals: [
        `${uploadActions.length} upload/ingest action(s)`,
        `Artifact max ${Math.round(snapshot.artifactMaxBytes / (1024 * 1024))} MB`,
      ],
      actionIds: uploadActions,
    },
    {
      id: 'exports',
      label: 'Exports',
      status: exportActions.length >= 2 ? 'ready' : exportActions.length > 0 ? 'partial' : 'gap',
      outcome: 'Turn conversations, sessions, documents, and saved artifacts into local files the user can keep or reuse.',
      current: `${exportActions.length} export action(s) are reachable for conversation, session, document, comparison, and saved artifact output.`,
      next: 'Keep transcript, session, document, comparison, and artifact exports visible, explicit, and reusable from one place.',
      userRoute: 'Agent Workspace -> Documents & Files -> Export document artifact',
      modelRoute: 'agent_harness mode:"workspace_actions" query:"export artifact"',
      signals: [
        `${exportActions.length} export action(s)`,
        `Session ${snapshot.sessionId}`,
      ],
      actionIds: exportActions,
    },
    {
      id: 'reviewer_readiness',
      label: 'Reviewer Readiness',
      status: reviewerReadiness.status === 'ready' ? 'ready' : reviewerReadiness.status === 'attention' ? 'attention' : 'needs-setup',
      outcome: 'Know what must be resolved before exporting, handing off, archiving, or applying comparison-backed route changes.',
      current: `${reviewerReadiness.summary.documents} document draft(s), ${reviewerReadiness.summary.openComments} open comment(s), ${reviewerReadiness.summary.proposedSuggestions} proposed suggestion(s), ${reviewerReadiness.summary.savedComparisons} saved comparison(s), ${reviewerReadiness.summary.revealedJudgments} revealed judgment(s).`,
      next: reviewerReadiness.next,
      userRoute: 'Agent Workspace -> Documents & Files -> Review readiness preflight',
      modelRoute: 'agent_harness mode:"document_ops_lane" laneId:"reviewer_readiness"',
      signals: [
        `Reviewer readiness ${reviewerReadiness.status}`,
        `Open comments ${reviewerReadiness.summary.openComments}`,
        `Proposed suggestions ${reviewerReadiness.summary.proposedSuggestions}`,
        `Missing source artifacts ${reviewerReadiness.summary.documentsMissingSourceArtifacts}`,
        `Unrevealed comparisons ${reviewerReadiness.summary.unrevealedComparisons}`,
        `Hidden judgments ${reviewerReadiness.summary.hiddenJudgments}`,
        `Route decisions ${reviewerReadiness.summary.revealedJudgments}`,
        `Handoffs missing related evidence ${reviewerReadiness.summary.handoffsMissingRelatedArtifacts}`,
      ],
      actionIds: [
        ...documentActions.filter((id) => [
          'document-show-draft',
          'document-reviewer-readiness',
          'document-resolve-comment',
          'document-accept-suggestion',
          'document-reject-suggestion',
          'document-attach-artifact',
          'document-export-draft',
        ].includes(id)),
        ...modelCompareActions.filter((id) => [
          'document-review-compare',
          'document-diff-handoffs',
          'document-judge-compare',
          'document-apply-compare',
          'document-export-compare',
        ].includes(id)),
        ...artifactBrowserActions.filter((id) => [
          'document-browse-artifacts',
          'document-show-artifact',
        ].includes(id)),
      ],
      reviewerReadiness,
    },
    {
      id: 'review_packet_timeline',
      label: 'Review Packet Timeline',
      status: !snapshot.reviewPacketTimeline.available
        ? 'needs-setup'
        : snapshot.reviewPacketTimeline.items.some((event) => event.status === 'attention')
          ? 'attention'
          : snapshot.reviewPacketTimeline.count > 0
          ? 'ready'
          : 'partial',
      outcome: 'Scan one chronological packet history across document review, source evidence, blind comparisons, judgments, handoffs, archives, and route decisions.',
      current: snapshot.reviewPacketTimeline.items[0]
        ? `${snapshot.reviewPacketTimeline.count} packet event(s); latest ${snapshot.reviewPacketTimeline.items[0].label}.`
        : 'No document, artifact, comparison, judgment, handoff, archive, or route-decision packet events are available yet.',
      next: snapshot.reviewPacketTimeline.next,
      userRoute: 'Agent Workspace -> Documents & Files -> Review packet timeline',
      modelRoute: 'agent_harness mode:"document_ops_lane" laneId:"review_packet_timeline"',
      signals: [
        `Timeline available ${snapshot.reviewPacketTimeline.available ? 'yes' : 'no'}`,
        `Timeline events ${snapshot.reviewPacketTimeline.count}`,
        ...snapshot.reviewPacketTimeline.items.slice(0, 5).map((event) => `${event.status}: ${event.kind} ${event.label} -> ${event.route}`),
      ],
      actionIds: [
        ...documentActions.filter((id) => [
          'document-review-packet-timeline',
          'document-show-draft',
          'document-reviewer-readiness',
          'document-resolve-comment',
          'document-accept-suggestion',
          'document-reject-suggestion',
          'document-attach-artifact',
          'document-export-draft',
        ].includes(id)),
        ...modelCompareActions.filter((id) => [
          'document-review-compare',
          'document-diff-handoffs',
          'document-judge-compare',
          'document-apply-compare',
          'document-export-compare',
        ].includes(id)),
        ...artifactBrowserActions.filter((id) => [
          'document-browse-artifacts',
          'document-show-artifact',
        ].includes(id)),
      ],
    },
    {
      id: 'review_packet_wizard',
      label: 'Review Packet Wizard',
      status: snapshot.reviewPacketWizard.status === 'complete'
        ? 'ready'
        : snapshot.reviewPacketWizard.status === 'blocked'
          ? 'needs-setup'
          : snapshot.reviewPacketWizard.status === 'empty'
            ? 'partial'
            : 'attention',
      outcome: 'Carry one reviewer packet through draft review, document export, comparison judgment, reviewer handoff, route decision, and final archive review without re-entering ids.',
      current: snapshot.reviewPacketWizard.currentStepLabel
        ? `${snapshot.reviewPacketWizard.completedSteps}/${snapshot.reviewPacketWizard.totalSteps} step(s) complete; current ${snapshot.reviewPacketWizard.currentStepLabel}.`
        : `${snapshot.reviewPacketWizard.completedSteps}/${snapshot.reviewPacketWizard.totalSteps} step(s) complete.`,
      next: snapshot.reviewPacketWizard.next,
      userRoute: 'Agent Workspace -> Documents & Files -> Review packet wizard',
      modelRoute: 'agent_harness mode:"document_ops_lane" laneId:"review_packet_wizard"',
      signals: [
        `Wizard status ${snapshot.reviewPacketWizard.status}`,
        `Wizard progress ${snapshot.reviewPacketWizard.completedSteps}/${snapshot.reviewPacketWizard.totalSteps}`,
        `Current step ${snapshot.reviewPacketWizard.currentStepLabel ?? 'none'}`,
        `Final review ${snapshot.reviewPacketWizard.finalReview}`,
        ...snapshot.reviewPacketWizard.steps.map((step) => `${step.status}: ${step.label} -> ${step.modelRoute}`),
      ],
      actionIds: existingActions([
        'document-review-packet-wizard',
        'document-share-review-packet',
        'document-record-route-decision',
        ...snapshot.reviewPacketWizard.steps.map((step) => step.actionId),
      ], available),
      reviewPacketWizard: snapshot.reviewPacketWizard,
    },
    {
      id: 'source_library',
      label: 'Sources',
      status: sourceActions.length >= 2 ? 'ready' : sourceActions.length > 0 ? 'partial' : 'gap',
      outcome: 'Inspect source-backed records before citing, summarizing, or promoting knowledge.',
      current: `${sourceActions.length} source lookup/search action(s) are reachable through isolated Agent Knowledge.`,
      next: 'Use source search/show for citation checks; ingest reviewed files or URLs only through explicit source actions.',
      userRoute: 'Agent Workspace -> Documents & Files -> Show source or node',
      modelRoute: 'agent_harness mode:"workspace_actions" query:"Agent Knowledge sources"',
      signals: [
        `Knowledge route ${snapshot.knowledgeRoute}`,
        `Knowledge isolation ${snapshot.knowledgeIsolation}`,
      ],
      actionIds: sourceActions,
    },
    {
      id: 'media_artifacts',
      label: 'Media Artifacts',
      status: snapshot.mediaGenerationProviderCount > 0 ? 'ready' : mediaActions.length > 0 ? 'needs-setup' : 'gap',
      outcome: 'Generate image or video artifacts through configured providers and keep generated bytes out of the transcript.',
      current: `${snapshot.voiceMediaReadiness.readyMediaProviderCount}/${snapshot.mediaProviderCount} media provider(s) ready; ${snapshot.mediaGenerationProviderCount} generation provider(s).`,
      next: snapshot.mediaGenerationProviderCount > 0
        ? 'Use confirmed media generation when the user asks for a concrete artifact.'
        : 'Configure a media generation provider before claiming generated media is ready.',
      userRoute: 'Agent Workspace -> Documents & Files -> Generate media artifact',
      modelRoute: 'agent_media_generate',
      signals: [
        `${mediaActions.length} media action(s)`,
        `${snapshot.mediaGenerationProviderCount} generation provider(s)`,
      ],
      actionIds: mediaActions,
    },
    {
      id: 'artifact_browser',
      label: 'Artifact Browser',
      status: artifactBrowserReady ? 'ready' : artifactBrowserActions.length > 0 ? 'partial' : 'gap',
      outcome: 'Find and reuse uploaded, exported, generated, and source-backed artifacts from one place.',
      current: artifactBrowserReady
        ? 'Agent has a unified artifact browser with filters, redacted metadata, bounded text previews, confirmed artifact export-to-file, confirmed multi-artifact package export and ZIP archive export, confirmed artifact-to-Knowledge promotion, confirmed artifact-to-document attachment, and confirmed artifact-to-document insertion over the SDK artifact store.'
        : 'Artifacts are real and visible in transcript, source, session, and media routes, but the unified browser is not fully wired in this runtime.',
      next: artifactBrowserReady
        ? 'Use package or ZIP archive exports across document, upload, generated media, session, comparison, and Knowledge artifacts.'
        : 'Wire agent_artifacts and browse/show workspace actions over the SDK artifact store.',
      userRoute: 'Agent Workspace -> Documents & Files -> Browse artifacts, Export package, or Promote to Knowledge',
      modelRoute: artifactBrowserReady ? 'agent_artifacts + agent_knowledge_ingest' : 'agent_harness mode:"workspace_actions" categoryId:"artifacts"',
      signals: [
        `${uploadActions.length + exportActions.length + mediaActions.length} related artifact action(s)`,
        `Artifact browser tool: ${hasTool(context, 'agent_artifacts') ? 'available' : 'gap'}`,
        `Knowledge ingest tool: ${hasTool(context, 'agent_knowledge_ingest') ? 'available' : 'gap'}`,
        `Artifact list/read store: ${context.platform.artifactStore?.list && context.platform.artifactStore?.readContent ? 'available' : 'gap'}`,
        `Artifact export action: ${artifactBrowserActions.includes('document-export-artifact-file') ? 'available' : 'gap'}`,
        `Artifact package export action: ${artifactBrowserActions.includes('document-export-artifact-package') ? 'available' : 'gap'}`,
        `Knowledge promotion action: ${artifactBrowserActions.includes('artifact-promote-knowledge') ? 'available' : 'gap'}`,
        `Document attachment action: ${artifactBrowserActions.includes('artifact-attach-document') ? 'available' : 'gap'}`,
        `Document insertion action: ${artifactBrowserActions.includes('artifact-insert-document') ? 'available' : 'gap'}`,
      ],
      actionIds: artifactBrowserActions,
    },
    {
      id: 'model_compare',
      label: 'Blind Model Compare',
      status: modelCompareReady ? 'partial' : 'gap',
      outcome: 'Run the same prompt across multiple models, hide model identities while judging, save a judgment, then apply the revealed winner or record leave-unchanged evidence only after confirmation.',
      current: modelCompareReady
        ? 'Agent has a confirmed blind comparison runner with selectable or auto-selected candidates, identical prompt or saved text artifact delivery, rubric capture, delayed reveal, durable JSON comparison artifacts, read-only saved review boards, side-by-side reviewer views, visual reviewer handoff diffs, confirmed saved judgment artifacts, task/document/benchmark-filtered preference analytics/synthesis, markdown report export, reviewer handoff artifacts, one-click reviewer handoff ZIP archives with source and matching route-decision receipt evidence, separate confirmed winner route updates, and leave-unchanged route-decision receipts.'
        : 'Model routing and model catalog inspection exist, but Agent does not have a blind side-by-side comparison runner or saved comparison artifacts.',
      next: modelCompareReady
        ? 'Use cross-session synthesis and reviewer handoff ZIP archives around saved comparison, judgment, export, route-update, route-decision receipt, and source-artifact reuse artifacts.'
        : 'Implement a blind compare runner with selectable candidate models, identical prompt/context, rubric capture, delayed reveal, export, and route update handoff.',
      userRoute: 'Agent Workspace -> Documents & Files -> Run blind compare',
      modelRoute: modelCompareReady ? 'agent_model_compare' : 'models action:"status"',
      signals: [
        `Current model ${snapshot.provider} / ${snapshot.modelDisplayName}`,
        `Blind compare runner: ${modelCompareReady ? 'available' : 'gap'}`,
        `Saved comparison artifact: ${modelCompareReady && context.platform.artifactStore ? 'available' : 'gap'}`,
        `Artifact-to-compare reuse: ${modelCompareActions.includes('document-run-compare') ? 'available' : 'gap'}`,
        `Saved review board/side-by-side/handoff diff view: ${modelCompareActions.includes('document-review-compare') && modelCompareActions.includes('document-diff-handoffs') ? 'available' : 'gap'}`,
        `Saved judgment artifact: ${modelCompareActions.includes('document-judge-compare') ? 'available' : 'gap'}`,
        `Saved preference analytics/synthesis with task/document/benchmark filters: ${modelCompareActions.includes('document-compare-analytics') ? 'available' : 'gap'}`,
        `Winner route update: ${modelCompareActions.includes('document-apply-compare') ? 'available' : 'gap'}`,
        `Leave-unchanged route receipt: ${modelCompareActions.includes('document-record-route-decision') ? 'available' : 'gap'}`,
        `Markdown export/handoff/archive: ${modelCompareActions.includes('document-export-compare') ? 'available' : 'gap'}`,
      ],
      actionIds: modelCompareActions,
    },
  ];
}

function nextActions(lanes: readonly DocumentOpsLane[]): readonly string[] {
  const urgent = lanes
    .filter((lane) => lane.status === 'gap' || lane.status === 'needs-setup' || lane.status === 'attention')
    .map((lane) => `${lane.label}: ${lane.next}`);
  const partial = lanes
    .filter((lane) => lane.status === 'partial')
    .map((lane) => `${lane.label}: ${lane.next}`);
  return [...urgent, ...partial].slice(0, 5);
}

export function documentOpsCatalogStatus(context: CommandContext): Record<string, unknown> {
  const lanes = buildLanes(context);
  const counts = lanes.reduce<Record<DocumentOpsStatus, number>>((acc, lane) => {
    acc[lane.status] += 1;
    return acc;
  }, { ready: 0, attention: 0, partial: 0, 'needs-setup': 0, gap: 0 });
  return {
    modes: ['document_ops', 'document_ops_lane'],
    lanes: lanes.length,
    ...counts,
    bestReadyStatus: lanes.reduce((best, lane) => Math.max(best, statusRank(lane.status)), 0),
  };
}

export function documentOpsSummary(context: CommandContext, args: AgentHarnessDocumentOpsArgs): Record<string, unknown> {
  const includeParameters = args.includeParameters === true;
  const lanes = buildLanes(context);
  const reviewerReadiness = lanes.find((lane) => lane.id === 'reviewer_readiness')?.reviewerReadiness;
  return {
    lanes: lanes.map((lane) => describeLane(lane, includeParameters)),
    returned: lanes.length,
    total: lanes.length,
    ...(reviewerReadiness ? { reviewerReadiness: describeReviewerReadiness(reviewerReadiness, includeParameters) } : {}),
    policy: 'Document Ops unifies versioned document drafts, chronological review packet timelines, guided review packet wizard progress, reviewer-readiness checks, review comments, AI suggestion review, uploads, exports, sources, media artifacts, artifact browsing, artifact-to-Knowledge promotion, and model comparison.',
    nextActions: nextActions(lanes),
  };
}

export function describeDocumentOpsLane(context: CommandContext, args: AgentHarnessDocumentOpsArgs): DocumentOpsLaneResolution {
  const laneId = readString(args.laneId);
  const target = readString(args.target);
  const query = readString(args.query);
  const input = laneId || target || query;
  if (!input) {
    return {
      status: 'missing_lookup',
      usage: `document_ops_lane requires laneId, target, or query. Lane ids: ${LANE_IDS.join(', ')}.`,
    };
  }
  const normalized = input.toLowerCase();
  const lanes = buildLanes(context);
  const exact = lanes.find((lane) => lane.id === normalized);
  if (exact) return { status: 'found', lane: describeLane(exact, true) };
  const matches = lanes.filter((lane) => searchText(lane).includes(normalized));
  if (matches.length === 1) return { status: 'found', lane: describeLane(matches[0]!, true) };
  if (matches.length > 1) {
    return {
      status: 'ambiguous',
      input,
      candidates: matches.map((lane) => ({
        laneId: lane.id,
        label: lane.label,
        status: lane.status,
        modelRoute: lane.modelRoute,
      })),
    };
  }
  return {
    status: 'missing_lookup',
    usage: `Unknown Document Ops lane ${input}. Lane ids: ${LANE_IDS.join(', ')}.`,
  };
}

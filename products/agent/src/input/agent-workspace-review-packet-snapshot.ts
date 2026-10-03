import type { ArtifactDescriptor } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import type { CommandContext } from './command-registry.ts';
import { AgentDocumentRegistry, type AgentDocumentRecord } from '../agent/document-registry.ts';
import type { AgentWorkspaceReviewPacketDefaults, AgentWorkspaceReviewPacketTimeline, AgentWorkspaceReviewPacketTimelineEvent, AgentWorkspaceReviewPacketWizard, AgentWorkspaceReviewPacketWizardStep, AgentWorkspaceReviewPacketWizardStepStatus, AgentWorkspaceReviewerReadinessBadge } from './agent-workspace-types.ts';
import { readArtifactMetadataNumber, readArtifactMetadataString, readArtifactMetadataStringList } from './agent-workspace-artifact-metadata.ts';
import { buildReviewPacketPresetLineage, compactTimelineText, isDocumentExportArtifact, isModelCompareArtifact, isModelCompareExportArtifact, isModelCompareJudgmentArtifact, isModelCompareRouteDecisionArtifact, isReviewerHandoffArchiveArtifact, isReviewerHandoffArtifact, isReviewPacketPresetArtifact, isoToEpoch, reviewPacketPresetFreshness, uniqueStrings } from './agent-workspace-review-packet-utils.ts';

export function readDocumentDrafts(context: CommandContext): readonly AgentDocumentRecord[] {
  try {
    const shellPaths = context.workspace?.shellPaths;
    if (!shellPaths) return [];
    return AgentDocumentRegistry.fromShellPaths(shellPaths).list();
  } catch {
    return [];
  }
}

export function buildReviewPacketTimeline(
  documents: readonly AgentDocumentRecord[],
  artifacts: readonly ArtifactDescriptor[],
  artifactListAvailable: boolean,
): AgentWorkspaceReviewPacketTimeline {
  const events: AgentWorkspaceReviewPacketTimelineEvent[] = [];
  for (const document of documents) {
    const openComments = document.comments.filter((comment) => comment.status === 'open').length;
    const proposedSuggestions = document.suggestions.filter((suggestion) => suggestion.status === 'proposed').length;
    events.push({
      id: `document:${document.id}`,
      kind: 'document',
      at: isoToEpoch(document.updatedAt),
      label: `Document ${document.status}: ${document.title}`,
      detail: `${document.versions.length} version(s), ${openComments} open comment(s), ${proposedSuggestions} proposed suggestion(s), ${document.attachments.length} attachment(s), last artifact ${document.lastArtifactId ?? 'none'}`,
      status: openComments + proposedSuggestions > 0 ? 'attention' : document.status === 'reviewed' ? 'ready' : 'info',
      route: `agent_documents show documentId:"${document.id}" includeVersions:true`,
      sourceId: document.id,
    });
    for (const comment of document.comments) {
      events.push({
        id: `comment:${document.id}:${comment.id}`,
        kind: 'comment',
        at: isoToEpoch(comment.resolvedAt ?? comment.updatedAt ?? comment.createdAt),
        label: `${comment.status === 'open' ? 'Open' : 'Resolved'} comment: ${document.title}`,
        detail: compactTimelineText(comment.body),
        status: comment.status === 'open' ? 'attention' : 'complete',
        route: comment.status === 'open'
          ? `agent_documents resolveComment documentId:"${document.id}" commentId:"${comment.id}" confirm:true explicitUserRequest:"..."`
          : `agent_documents show documentId:"${document.id}" includeVersions:true`,
        sourceId: comment.id,
      });
    }
    for (const suggestion of document.suggestions) {
      events.push({
        id: `suggestion:${document.id}:${suggestion.id}`,
        kind: 'suggestion',
        at: isoToEpoch(suggestion.resolvedAt ?? suggestion.updatedAt ?? suggestion.createdAt),
        label: `${suggestion.status === 'proposed' ? 'Proposed' : suggestion.status === 'accepted' ? 'Accepted' : 'Rejected'} suggestion: ${suggestion.title}`,
        detail: compactTimelineText(`${document.title}: ${suggestion.summary}`),
        status: suggestion.status === 'proposed' ? 'attention' : 'complete',
        route: suggestion.status === 'proposed'
          ? `agent_documents acceptSuggestion documentId:"${document.id}" suggestionId:"${suggestion.id}" confirm:true explicitUserRequest:"..." or agent_documents rejectSuggestion documentId:"${document.id}" suggestionId:"${suggestion.id}" confirm:true explicitUserRequest:"..."`
          : `agent_documents show documentId:"${document.id}" includeVersions:true`,
        sourceId: suggestion.id,
      });
    }
    for (const attachment of document.attachments) {
      events.push({
        id: `attachment:${document.id}:${attachment.id}`,
        kind: 'attachment',
        at: isoToEpoch(attachment.updatedAt ?? attachment.createdAt),
        label: `Attached artifact: ${attachment.label}`,
        detail: `${document.title}: ${attachment.artifactId}${attachment.note ? ` - ${compactTimelineText(attachment.note, 64)}` : ''}`,
        status: 'complete',
        route: `agent_artifacts show artifactId:"${attachment.artifactId}"`,
        sourceId: attachment.artifactId,
      });
    }
  }

  for (const artifact of artifacts) {
    const metadata = artifact.metadata;
    if (isDocumentExportArtifact(artifact)) {
      const documentId = readArtifactMetadataString(metadata, 'documentId') || 'unknown-document';
      const versionId = readArtifactMetadataString(metadata, 'versionId') || 'unknown-version';
      events.push({
        id: `document-export:${artifact.id}`,
        kind: 'document-export',
        at: artifact.createdAt,
        label: `Document export: ${documentId}`,
        detail: `version ${versionId}; artifact ${artifact.id}`,
        status: 'complete',
        route: `agent_artifacts show artifactId:"${artifact.id}"`,
        sourceId: artifact.id,
      });
      continue;
    }
    if (isModelCompareArtifact(artifact)) {
      const comparisonId = readArtifactMetadataString(metadata, 'comparisonId') || artifact.id;
      const completed = readArtifactMetadataNumber(metadata, 'completedCandidates');
      const candidates = readArtifactMetadataNumber(metadata, 'candidateCount');
      const source = readArtifactMetadataString(metadata, 'sourceArtifactId') || readArtifactMetadataString(metadata, 'documentId') || 'none';
      const revealed = metadata.revealIncludedInTranscript === true;
      events.push({
        id: `compare:${artifact.id}`,
        kind: 'compare',
        at: artifact.createdAt,
        label: `Blind compare ${revealed ? 'revealed' : 'hidden'}: ${comparisonId}`,
        detail: `${completed ?? '?'}/${candidates ?? '?'} candidate(s) complete; source ${source}`,
        status: revealed ? 'ready' : 'attention',
        route: revealed ? `agent_model_compare review artifactId:"${artifact.id}" reveal:true` : `agent_model_compare reveal artifactId:"${artifact.id}"`,
        sourceId: artifact.id,
      });
      continue;
    }
    if (isModelCompareJudgmentArtifact(artifact)) {
      const comparisonId = readArtifactMetadataString(metadata, 'comparisonId') || 'unknown-comparison';
      const winnerBlindId = readArtifactMetadataString(metadata, 'winnerBlindId') || 'unknown-winner';
      const winnerModel = readArtifactMetadataString(metadata, 'winnerModel');
      const revealed = metadata.revealIncludedInJudgment === true && winnerModel.length > 0;
      events.push({
        id: `judgment:${artifact.id}`,
        kind: 'judgment',
        at: artifact.createdAt,
        label: `Comparison judgment ${revealed ? 'revealed' : 'hidden'}: ${comparisonId}`,
        detail: revealed ? `winner ${winnerModel}; blind slot ${winnerBlindId}` : `winner blind slot ${winnerBlindId}; reveal needed before route decisions`,
        status: 'attention',
        route: revealed
          ? `agent_model_compare apply artifactId:"${artifact.id}" confirm:true explicitUserRequest:"..."`
          : `agent_model_compare review artifactId:"${artifact.id}"`,
        sourceId: artifact.id,
      });
      continue;
    }
    if (isModelCompareRouteDecisionArtifact(artifact)) {
      const comparisonId = readArtifactMetadataString(metadata, 'comparisonId') || 'unknown-comparison';
      const decisionId = readArtifactMetadataString(metadata, 'decisionId') || artifact.id;
      const decision = readArtifactMetadataString(metadata, 'decision') || 'unknown-decision';
      const judgmentArtifactId = readArtifactMetadataString(metadata, 'judgmentArtifactId') || 'unknown-judgment';
      const selectedModel = readArtifactMetadataString(metadata, 'selectedModel') || readArtifactMetadataString(metadata, 'currentModel') || 'unknown-model';
      events.push({
        id: `route-decision:${artifact.id}`,
        kind: 'route-decision',
        at: artifact.createdAt,
        label: `Route decision: ${decisionId}`,
        detail: `${comparisonId}; ${decision}; judgment ${judgmentArtifactId}; selected ${selectedModel}`,
        status: 'complete',
        route: `agent_artifacts show artifactId:"${artifact.id}"`,
        sourceId: artifact.id,
      });
      continue;
    }
    if (isReviewPacketPresetArtifact(artifact)) {
      const name = readArtifactMetadataString(metadata, 'name') || artifact.filename || artifact.id;
      const summary = readArtifactMetadataString(metadata, 'summary') || 'review packet preset';
      const freshness = reviewPacketPresetFreshness(artifact, artifacts);
      const sourceArtifactId = readArtifactMetadataString(metadata, 'revealedJudgmentArtifactId')
        || readArtifactMetadataString(metadata, 'judgmentArtifactId')
        || readArtifactMetadataString(metadata, 'comparisonArtifactId')
        || readArtifactMetadataString(metadata, 'documentExportArtifactId')
        || 'none';
      const handoffArtifactId = readArtifactMetadataString(metadata, 'handoffArtifactId') || 'none';
      const relatedCount = readArtifactMetadataStringList(metadata, 'relatedArtifactIds').length;
      events.push({
        id: `packet-preset:${artifact.id}`,
        kind: 'packet-preset',
        at: artifact.createdAt,
        label: `Packet preset: ${name}`,
        detail: `${compactTimelineText(summary, 72)}; source ${sourceArtifactId}; handoff ${handoffArtifactId}; ${relatedCount} related artifact(s); ${freshness.summary}`,
        status: freshness.status,
        route: `agent_review_packet_presets show artifactId:"${artifact.id}"`,
        sourceId: artifact.id,
      });
      continue;
    }
    if (isModelCompareExportArtifact(artifact)) {
      const comparisonId = readArtifactMetadataString(metadata, 'comparisonId') || 'unknown-comparison';
      const sourceKind = readArtifactMetadataString(metadata, 'sourceKind') || 'unknown';
      events.push({
        id: `compare-export:${artifact.id}`,
        kind: 'compare-export',
        at: artifact.createdAt,
        label: `Compare report: ${comparisonId}`,
        detail: `${sourceKind} report artifact ${artifact.id}`,
        status: 'complete',
        route: `agent_artifacts show artifactId:"${artifact.id}"`,
        sourceId: artifact.id,
      });
      continue;
    }
    if (isReviewerHandoffArtifact(artifact)) {
      const handoffId = readArtifactMetadataString(metadata, 'handoffId') || artifact.id;
      const comparisonId = readArtifactMetadataString(metadata, 'comparisonId') || 'unknown-comparison';
      const sourceKind = readArtifactMetadataString(metadata, 'sourceKind') || 'unknown';
      const relatedCount = readArtifactMetadataStringList(metadata, 'relatedArtifactIds').length;
      events.push({
        id: `handoff:${artifact.id}`,
        kind: 'handoff',
        at: artifact.createdAt,
        label: `Reviewer handoff: ${handoffId}`,
        detail: `${comparisonId}; source ${sourceKind}; ${relatedCount} related artifact(s)`,
        status: relatedCount > 0 ? 'ready' : 'attention',
        route: relatedCount > 0
          ? `agent_model_compare handoffDiff leftArtifactId:"${artifact.id}" rightArtifactId:"..."`
          : `agent_model_compare handoff artifactId:"${readArtifactMetadataString(metadata, 'sourceArtifactId') || artifact.id}" relatedArtifactIds:"..." confirm:true explicitUserRequest:"..."`,
        sourceId: artifact.id,
      });
      continue;
    }
    if (isReviewerHandoffArchiveArtifact(artifact)) {
      const archiveId = readArtifactMetadataString(metadata, 'archiveId') || artifact.id;
      const comparisonId = readArtifactMetadataString(metadata, 'comparisonId') || 'unknown-comparison';
      const artifactCount = readArtifactMetadataNumber(metadata, 'artifactCount');
      events.push({
        id: `handoff-archive:${artifact.id}`,
        kind: 'handoff-archive',
        at: artifact.createdAt,
        label: `Handoff archive: ${archiveId}`,
        detail: `${comparisonId}; ${artifactCount ?? '?'} artifact(s) packaged`,
        status: 'complete',
        route: `agent_artifacts show artifactId:"${artifact.id}"`,
        sourceId: artifact.id,
      });
    }
  }

  const ordered = events
    .filter((event) => Number.isFinite(event.at))
    .sort((left, right) => right.at - left.at || left.id.localeCompare(right.id));
  const attention = ordered.find((event) => event.status === 'attention');
  return {
    available: artifactListAvailable,
    count: ordered.length,
    next: !artifactListAvailable
      ? 'Artifact listing is unavailable; timeline shows document-local events only.'
      : attention
        ? `${attention.label}: ${attention.detail}`
        : ordered.length > 0
          ? 'Review packet timeline is clear; export, handoff, archive, or route decisions can use the visible readiness checks.'
          : 'Create or attach a document, source artifact, comparison, judgment, handoff, or archive to start a review packet timeline.',
    items: ordered.slice(0, 8),
  };
}

export function buildReviewPacketDefaults(
  documents: readonly AgentDocumentRecord[],
  artifacts: readonly ArtifactDescriptor[],
): AgentWorkspaceReviewPacketDefaults {
  const latestDocument = [...documents]
    .filter((document) => document.status !== 'archived')
    .sort((left, right) => isoToEpoch(right.updatedAt) - isoToEpoch(left.updatedAt) || left.id.localeCompare(right.id))[0] ?? null;
  const latestDocumentExport = artifacts.filter(isDocumentExportArtifact).sort((left, right) => right.createdAt - left.createdAt)[0] ?? null;
  const latestComparison = artifacts.filter(isModelCompareArtifact).sort((left, right) => right.createdAt - left.createdAt)[0] ?? null;
  const latestJudgment = artifacts.filter(isModelCompareJudgmentArtifact).sort((left, right) => right.createdAt - left.createdAt)[0] ?? null;
  const latestRevealedJudgment = artifacts
    .filter((artifact) => (
      isModelCompareJudgmentArtifact(artifact)
      && artifact.metadata.revealIncludedInJudgment === true
      && readArtifactMetadataString(artifact.metadata, 'winnerModel').length > 0
    ))
    .sort((left, right) => right.createdAt - left.createdAt)[0] ?? null;
  const latestHandoff = artifacts.filter(isReviewerHandoffArtifact).sort((left, right) => right.createdAt - left.createdAt)[0] ?? null;
  const latestHandoffArchive = artifacts.filter(isReviewerHandoffArchiveArtifact).sort((left, right) => right.createdAt - left.createdAt)[0] ?? null;
  const latestPreset = artifacts.filter(isReviewPacketPresetArtifact).sort((left, right) => right.createdAt - left.createdAt)[0] ?? null;
  const presetMetadata = latestPreset?.metadata ?? {};
  const latestRevealedJudgmentComparisonId = readArtifactMetadataString(latestRevealedJudgment?.metadata ?? {}, 'comparisonId');
  const latestRouteDecision = artifacts
    .filter(isModelCompareRouteDecisionArtifact)
    .filter((artifact) => {
      if (!latestRevealedJudgment) return true;
      const judgmentArtifactId = readArtifactMetadataString(artifact.metadata, 'judgmentArtifactId');
      const comparisonId = readArtifactMetadataString(artifact.metadata, 'comparisonId');
      return judgmentArtifactId === latestRevealedJudgment.id || (latestRevealedJudgmentComparisonId.length > 0 && comparisonId === latestRevealedJudgmentComparisonId);
    })
    .sort((left, right) => right.createdAt - left.createdAt)[0] ?? null;
  const liveRelatedArtifactIds = uniqueStrings([
    latestDocumentExport?.id,
    latestDocument?.lastArtifactId,
    ...(latestDocument?.attachments.map((attachment) => attachment.artifactId) ?? []),
    readArtifactMetadataString(latestComparison?.metadata ?? {}, 'sourceArtifactId'),
    ...readArtifactMetadataStringList(latestHandoff?.metadata ?? {}, 'relatedArtifactIds'),
  ], 8);
  const presetRelatedArtifactIds = readArtifactMetadataStringList(presetMetadata, 'relatedArtifactIds').slice(0, 8);
  const relatedArtifactIds = liveRelatedArtifactIds.length > 0 ? liveRelatedArtifactIds : presetRelatedArtifactIds;
  const documentId = (latestDocument?.id ?? readArtifactMetadataString(presetMetadata, 'documentId')) || null;
  const documentTitle = (latestDocument?.title ?? readArtifactMetadataString(presetMetadata, 'documentTitle')) || null;
  const documentExportArtifactId = (latestDocumentExport?.id ?? readArtifactMetadataString(presetMetadata, 'documentExportArtifactId')) || null;
  const comparisonArtifactId = (latestComparison?.id ?? readArtifactMetadataString(presetMetadata, 'comparisonArtifactId')) || null;
  const judgmentArtifactId = (latestJudgment?.id ?? readArtifactMetadataString(presetMetadata, 'judgmentArtifactId')) || null;
  const revealedJudgmentArtifactId = (latestRevealedJudgment?.id ?? readArtifactMetadataString(presetMetadata, 'revealedJudgmentArtifactId')) || null;
  const routeDecisionArtifactId = (latestRouteDecision?.id ?? readArtifactMetadataString(presetMetadata, 'routeDecisionArtifactId')) || null;
  const routeDecision = latestRouteDecision
    ? readArtifactMetadataString(latestRouteDecision.metadata, 'decision') || null
    : readArtifactMetadataString(presetMetadata, 'routeDecision') || null;
  const handoffArtifactId = (latestHandoff?.id ?? readArtifactMetadataString(presetMetadata, 'handoffArtifactId')) || null;
  const handoffArchiveArtifactId = (latestHandoffArchive?.id ?? readArtifactMetadataString(presetMetadata, 'handoffArchiveArtifactId')) || null;
  const sourceArtifactId = revealedJudgmentArtifactId ?? judgmentArtifactId ?? comparisonArtifactId ?? null;
  const reviewPacketPresetName = readArtifactMetadataString(presetMetadata, 'name') || null;
  const reviewPacketPresetLineage = buildReviewPacketPresetLineage(latestPreset);
  const summary = [
    documentId ? `document ${documentId}` : '',
    sourceArtifactId ? `source ${sourceArtifactId}` : '',
    handoffArtifactId ? `handoff ${handoffArtifactId}` : '',
    relatedArtifactIds.length > 0 ? `${relatedArtifactIds.length} related` : '',
    latestPreset ? `preset ${latestPreset.id}` : '',
  ].filter(Boolean).join('; ') || 'no packet defaults yet';
  return {
    documentId,
    documentTitle,
    documentExportArtifactId,
    comparisonArtifactId,
    judgmentArtifactId,
    revealedJudgmentArtifactId,
    routeDecisionArtifactId,
    routeDecision,
    handoffArtifactId,
    handoffArchiveArtifactId,
    reviewPacketPresetArtifactId: latestPreset?.id ?? null,
    reviewPacketPresetName,
    reviewPacketPresetLineage,
    relatedArtifactIds,
    summary,
  };
}

function packetStepStatus(done: boolean, priorDone: boolean): AgentWorkspaceReviewPacketWizardStepStatus {
  if (done) return 'done';
  return priorDone ? 'current' : 'blocked';
}

function buildReviewPacketWizardStep(input: {
  readonly id: string;
  readonly label: string;
  readonly status: AgentWorkspaceReviewPacketWizardStepStatus;
  readonly detail: string;
  readonly userRoute: string;
  readonly modelRoute: string;
  readonly actionId: string;
  readonly backtrackRoute?: string | null;
}): AgentWorkspaceReviewPacketWizardStep {
  return {
    id: input.id,
    label: input.label,
    status: input.status,
    detail: input.detail,
    userRoute: input.userRoute,
    modelRoute: input.modelRoute,
    actionId: input.actionId,
    backtrackRoute: input.backtrackRoute ?? (input.status === 'done' ? input.modelRoute : null),
  };
}

export function buildReviewPacketWizard(
  documents: readonly AgentDocumentRecord[],
  artifactListAvailable: boolean,
  defaults: AgentWorkspaceReviewPacketDefaults,
): AgentWorkspaceReviewPacketWizard {
  const latestDocument = [...documents]
    .filter((document) => document.status !== 'archived')
    .sort((left, right) => isoToEpoch(right.updatedAt) - isoToEpoch(left.updatedAt) || left.id.localeCompare(right.id))[0] ?? null;
  const openComments = latestDocument?.comments.filter((comment) => comment.status === 'open').length ?? 0;
  const proposedSuggestions = latestDocument?.suggestions.filter((suggestion) => suggestion.status === 'proposed').length ?? 0;
  const documentReviewed = Boolean(latestDocument && openComments === 0 && proposedSuggestions === 0);
  const documentExported = Boolean(defaults.documentExportArtifactId || latestDocument?.lastArtifactId);
  const judgmentReady = Boolean(defaults.revealedJudgmentArtifactId);
  const handoffReady = Boolean(defaults.handoffArtifactId && defaults.relatedArtifactIds.length > 0);
  const archiveReady = Boolean(defaults.handoffArchiveArtifactId);
  const routeDecisionDone = Boolean(defaults.routeDecisionArtifactId || archiveReady);
  const presetLineage = defaults.reviewPacketPresetLineage;
  const finalArchiveReview = archiveReady
    ? [
      `Inspect final archive ${defaults.handoffArchiveArtifactId}.`,
      presetLineage?.refreshed
        ? `Verify refreshed preset lineage: ${presetLineage.summary}.`
        : presetLineage
          ? `Preset lineage: ${presetLineage.summary}.`
          : 'No saved packet preset lineage is attached.',
      'Use Documents & Compare -> Share review packet only after the user confirms the delivery target.',
    ].join(' ')
    : 'Final evidence review stays pending until a reviewer handoff ZIP archive exists.';
  const documentRoute = latestDocument
    ? `agent_documents show documentId:"${latestDocument.id}" includeVersions:true`
    : 'agent_documents list';
  const steps: AgentWorkspaceReviewPacketWizardStep[] = [];
  steps.push(buildReviewPacketWizardStep({
    id: 'draft-review',
    label: 'Draft review',
    status: documentReviewed ? 'done' : 'current',
    detail: latestDocument
      ? documentReviewed
        ? `${latestDocument.title} has no open comments or proposed suggestions.`
        : `${latestDocument.title} has ${openComments} open comment(s) and ${proposedSuggestions} proposed suggestion(s) to resolve before export.`
      : 'Create or select a document draft before building a reviewer packet.',
    userRoute: latestDocument ? 'Documents & Compare -> Show document draft' : 'Documents & Compare -> Create document draft',
    modelRoute: latestDocument
      ? documentRoute
      : 'agent_harness mode:"workspace_action" actionId:"document-create-draft"',
    actionId: latestDocument ? 'document-show-draft' : 'document-create-draft',
  }));
  steps.push(buildReviewPacketWizardStep({
    id: 'document-export',
    label: 'Document export',
    status: packetStepStatus(documentExported, documentReviewed),
    detail: documentExported
      ? `Document evidence is exported as ${defaults.documentExportArtifactId ?? latestDocument?.lastArtifactId}.`
      : documentReviewed
        ? 'Export the reviewed draft as a saved artifact for comparison and handoff evidence.'
        : 'Resolve draft review items before exporting reviewer evidence.',
    userRoute: 'Documents & Compare -> Export document artifact',
    modelRoute: latestDocument
      ? `agent_documents export documentId:"${latestDocument.id}" confirm:true explicitUserRequest:"..."`
      : 'agent_harness mode:"workspace_action" actionId:"document-export-draft"',
    actionId: 'document-export-draft',
    backtrackRoute: defaults.documentExportArtifactId
      ? `agent_artifacts show artifactId:"${defaults.documentExportArtifactId}"`
      : null,
  }));
  steps.push(buildReviewPacketWizardStep({
    id: 'compare-judgment',
    label: 'Compare judgment',
    status: packetStepStatus(judgmentReady, documentExported),
    detail: judgmentReady
      ? `Revealed judgment ${defaults.revealedJudgmentArtifactId} is ready for route review.`
      : defaults.judgmentArtifactId
        ? `Judgment ${defaults.judgmentArtifactId} exists, but winner identity is not revealed for route decisions.`
        : defaults.comparisonArtifactId
          ? `Comparison ${defaults.comparisonArtifactId} is available; save or reveal a judgment before handoff.`
          : documentExported
            ? 'Run a blind comparison from the exported document evidence, then save a revealed judgment.'
            : 'Export document evidence before comparing models.',
    userRoute: defaults.comparisonArtifactId ? 'Documents & Compare -> Review saved compare' : 'Documents & Compare -> Run blind compare',
    modelRoute: defaults.revealedJudgmentArtifactId
      ? `agent_model_compare review artifactId:"${defaults.revealedJudgmentArtifactId}" reveal:true`
      : defaults.judgmentArtifactId
        ? `agent_model_compare review artifactId:"${defaults.judgmentArtifactId}"`
        : defaults.comparisonArtifactId
          ? `agent_model_compare review artifactId:"${defaults.comparisonArtifactId}"`
          : 'agent_harness mode:"workspace_action" actionId:"document-run-compare"',
    actionId: defaults.comparisonArtifactId ? 'document-review-compare' : 'document-run-compare',
  }));
  steps.push(buildReviewPacketWizardStep({
    id: 'reviewer-handoff',
    label: 'Reviewer handoff',
    status: packetStepStatus(handoffReady, judgmentReady),
    detail: handoffReady
      ? `Reviewer handoff ${defaults.handoffArtifactId} includes ${defaults.relatedArtifactIds.length} related evidence artifact(s).`
      : judgmentReady
        ? 'Create a reviewer handoff from the revealed judgment and related document/export evidence.'
        : 'Save a revealed comparison judgment before creating reviewer handoff evidence.',
    userRoute: 'Documents & Compare -> Export compare report',
    modelRoute: defaults.revealedJudgmentArtifactId
      ? `agent_model_compare handoff artifactId:"${defaults.revealedJudgmentArtifactId}" relatedArtifactIds:${JSON.stringify(defaults.relatedArtifactIds)} confirm:true explicitUserRequest:"..."`
      : 'agent_harness mode:"workspace_action" actionId:"document-export-compare"',
    actionId: 'document-export-compare',
    backtrackRoute: defaults.handoffArtifactId
      ? `agent_artifacts show artifactId:"${defaults.handoffArtifactId}"`
      : null,
  }));
  steps.push(buildReviewPacketWizardStep({
    id: 'route-decision',
    label: 'Route decision',
    status: routeDecisionDone ? 'done' : handoffReady ? 'current' : judgmentReady ? 'pending' : 'blocked',
    detail: routeDecisionDone
      ? defaults.routeDecisionArtifactId
        ? `Route decision ${defaults.routeDecisionArtifactId} records ${defaults.routeDecision ?? 'a saved decision'}.`
        : 'Final packet evidence exists; route-decision review has been carried to archive/final review.'
      : handoffReady
        ? 'Apply the revealed winner or explicitly leave the current model unchanged before final archive review.'
        : judgmentReady
          ? 'Create reviewer handoff evidence before applying or leaving the revealed winning route.'
          : 'A revealed judgment is required before deciding whether to update the selected model route.',
    userRoute: 'Documents & Compare -> Apply compare winner or Record route decision',
    modelRoute: defaults.revealedJudgmentArtifactId
      ? `agent_model_compare apply artifactId:"${defaults.revealedJudgmentArtifactId}" confirm:true explicitUserRequest:"..." or agent_model_compare routeDecision artifactId:"${defaults.revealedJudgmentArtifactId}" decision:"left-unchanged" confirm:true explicitUserRequest:"..."`
      : 'agent_harness mode:"workspace_action" actionId:"document-apply-compare"',
    actionId: 'document-apply-compare',
    backtrackRoute: defaults.routeDecisionArtifactId
      ? `agent_artifacts show artifactId:"${defaults.routeDecisionArtifactId}"`
      : null,
  }));
  steps.push(buildReviewPacketWizardStep({
    id: 'final-archive-review',
    label: 'Final archive review',
    status: archiveReady ? 'done' : routeDecisionDone && handoffReady ? 'current' : handoffReady ? 'pending' : 'blocked',
    detail: archiveReady
      ? `Reviewer packet archive ${defaults.handoffArchiveArtifactId} is ready for final evidence review.`
      : handoffReady
        ? 'Archive the reviewer handoff as one ZIP artifact after route-decision review.'
        : 'Create a reviewer handoff with related evidence before archiving the packet.',
    userRoute: 'Documents & Compare -> Export compare report',
    modelRoute: defaults.handoffArtifactId
      ? `agent_model_compare handoffArchive artifactId:"${defaults.handoffArtifactId}" confirm:true explicitUserRequest:"..."`
      : 'agent_harness mode:"workspace_action" actionId:"document-export-compare"',
    actionId: 'document-export-compare',
    backtrackRoute: defaults.handoffArchiveArtifactId
      ? `agent_artifacts show artifactId:"${defaults.handoffArchiveArtifactId}"`
      : null,
  }));
  const completedSteps = steps.filter((step) => step.status === 'done').length;
  const current = steps.find((step) => step.status === 'current') ?? steps.find((step) => step.status === 'pending') ?? null;
  const status = !artifactListAvailable && steps.length > 0
    ? 'blocked'
    : completedSteps === steps.length
      ? 'complete'
      : latestDocument
        ? 'active'
        : 'empty';
  return {
    available: artifactListAvailable,
    status,
    completedSteps,
    totalSteps: steps.length,
    currentStepId: current?.id ?? null,
    currentStepLabel: current?.label ?? null,
    next: current
      ? `${current.label}: ${current.detail}`
      : 'Review packet wizard is complete; inspect the final archive and saved packet evidence.',
    finalReview: finalArchiveReview,
    presetLineage,
    steps,
  };
}

export function reviewerReadinessBadge(
  documents: readonly AgentDocumentRecord[],
  artifacts: readonly ArtifactDescriptor[],
  artifactListAvailable: boolean,
): AgentWorkspaceReviewerReadinessBadge {
  const reviewDocuments = documents.filter((document) => document.status !== 'archived');
  const openComments = reviewDocuments.reduce((total, document) => total + document.comments.filter((comment) => comment.status === 'open').length, 0);
  const proposedSuggestions = reviewDocuments.reduce((total, document) => total + document.suggestions.filter((suggestion) => suggestion.status === 'proposed').length, 0);
  const documentsMissingSourceArtifacts = reviewDocuments.filter((document) => document.attachments.length === 0 && !document.lastArtifactId).length;
  const comparisons = artifacts.filter(isModelCompareArtifact);
  const judgments = artifacts.filter(isModelCompareJudgmentArtifact);
  const routeDecisions = artifacts.filter(isModelCompareRouteDecisionArtifact);
  const handoffs = artifacts.filter(isReviewerHandoffArtifact);
  const revealedJudgments = judgments.filter((artifact) => (
    artifact.metadata.revealIncludedInJudgment === true
    && readArtifactMetadataString(artifact.metadata, 'winnerModel').length > 0
  ));
  const hiddenJudgments = judgments.filter((artifact) => (
    artifact.metadata.revealIncludedInJudgment !== true
    || readArtifactMetadataString(artifact.metadata, 'winnerModel').length === 0
  ));
  const routeDecisionComparisonIds = new Set(routeDecisions.map((artifact) => readArtifactMetadataString(artifact.metadata, 'comparisonId')).filter(Boolean));
  const routeDecisionJudgmentArtifactIds = new Set(routeDecisions.map((artifact) => readArtifactMetadataString(artifact.metadata, 'judgmentArtifactId')).filter(Boolean));
  const revealedJudgmentsWaitingOnRouteDecision = revealedJudgments.filter((artifact) => {
    const comparisonId = readArtifactMetadataString(artifact.metadata, 'comparisonId');
    return !routeDecisionJudgmentArtifactIds.has(artifact.id) && (!comparisonId || !routeDecisionComparisonIds.has(comparisonId));
  });
  const revealedComparisonIds = new Set(revealedJudgments.map((artifact) => readArtifactMetadataString(artifact.metadata, 'comparisonId')).filter(Boolean));
  const unrevealedComparisons = comparisons.filter((artifact) => {
    const comparisonId = readArtifactMetadataString(artifact.metadata, 'comparisonId');
    return artifact.metadata.revealIncludedInTranscript !== true && (!comparisonId || !revealedComparisonIds.has(comparisonId));
  });
  const comparisonSourceMissing = comparisons.filter((artifact) => (
    !readArtifactMetadataString(artifact.metadata, 'sourceArtifactId')
    && !readArtifactMetadataString(artifact.metadata, 'documentId')
  )).length;
  const missingSourceArtifacts = documentsMissingSourceArtifacts + comparisonSourceMissing;
  const handoffsMissingRelatedArtifacts = handoffs.filter((artifact) => readArtifactMetadataStringList(artifact.metadata, 'relatedArtifactIds').length === 0).length;
  const issueCount = openComments
    + proposedSuggestions
    + missingSourceArtifacts
    + unrevealedComparisons.length
    + hiddenJudgments.length
    + revealedJudgmentsWaitingOnRouteDecision.length
    + handoffsMissingRelatedArtifacts;
  const next = !artifactListAvailable
    ? 'Artifact listing is unavailable; run Review readiness preflight before export, archive, or route update.'
    : openComments + proposedSuggestions > 0
      ? 'Resolve open comments or accept/reject proposed suggestions before exporting reviewer packets.'
      : missingSourceArtifacts > 0
        ? 'Attach source artifacts or related evidence before export, handoff, or archive.'
        : unrevealedComparisons.length + hiddenJudgments.length > 0
          ? 'Reveal comparison/judgment identity before applying a model route or final reviewer handoff.'
          : revealedJudgmentsWaitingOnRouteDecision.length > 0
            ? 'Apply the revealed winner or explicitly leave routing unchanged before archiving.'
            : handoffsMissingRelatedArtifacts > 0
              ? 'Recreate reviewer handoffs with related evidence before ZIP archive.'
              : 'Reviewer readiness preflight is clear for export, handoff archive, or route update.';
  return {
    status: !artifactListAvailable ? 'needs-setup' : issueCount > 0 ? 'attention' : 'ready',
    summary: `${issueCount} issue(s): ${openComments} comment(s), ${proposedSuggestions} suggestion(s), ${missingSourceArtifacts} source/evidence gap(s), ${unrevealedComparisons.length + hiddenJudgments.length} hidden comparison item(s), ${revealedJudgmentsWaitingOnRouteDecision.length} route decision(s), ${handoffsMissingRelatedArtifacts} handoff evidence gap(s).`,
    next,
    issueCount,
    openComments,
    proposedSuggestions,
    missingSourceArtifacts,
    unrevealedComparisons: unrevealedComparisons.length,
    hiddenJudgments: hiddenJudgments.length,
    revealedJudgments: revealedJudgmentsWaitingOnRouteDecision.length,
    handoffsMissingRelatedArtifacts,
  };
}

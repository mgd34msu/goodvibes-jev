import type { ArtifactDescriptor } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import type { CommandContext } from '../input/command-registry.ts';
import { AgentDocumentRegistry, type AgentDocumentRecord } from '../agent/document-registry.ts';
import type { ReviewerReadinessCheck, ReviewerReadinessChecklist, ReviewerReadinessStatus } from './agent-harness-document-ops-types.ts';

function readMetadataString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readMetadataStringList(value: unknown): readonly string[] {
  if (typeof value === 'string') {
    return value.split(/[,\n]/).map((entry) => entry.trim()).filter(Boolean);
  }
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean);
}

function artifactPurpose(artifact: ArtifactDescriptor): string {
  return readMetadataString(artifact.metadata.purpose);
}

function isModelCompareArtifact(artifact: ArtifactDescriptor): boolean {
  const purpose = artifactPurpose(artifact);
  if (purpose === 'agent-model-compare') return true;
  if (purpose) return false;
  return readMetadataString(artifact.filename).startsWith('blind-model-comparison-cmp_');
}

function isModelCompareJudgmentArtifact(artifact: ArtifactDescriptor): boolean {
  const purpose = artifactPurpose(artifact);
  if (purpose === 'agent-model-compare-judgment') return true;
  if (purpose) return false;
  return readMetadataString(artifact.filename).startsWith('blind-model-comparison-judgment-');
}

function isModelCompareRouteDecisionArtifact(artifact: ArtifactDescriptor): boolean {
  return artifactPurpose(artifact) === 'agent-model-compare-route-decision';
}

function isModelCompareHandoffArtifact(artifact: ArtifactDescriptor): boolean {
  const purpose = artifactPurpose(artifact);
  if (purpose === 'agent-model-compare-handoff') return true;
  if (purpose) return false;
  return readMetadataString(artifact.filename).startsWith('blind-model-comparison-handoff-');
}

function readDocuments(context: CommandContext): readonly AgentDocumentRecord[] {
  const shellPaths = context.workspace?.shellPaths;
  if (!shellPaths) return [];
  try {
    return AgentDocumentRegistry.fromShellPaths(shellPaths).list();
  } catch {
    return [];
  }
}

function readArtifacts(context: CommandContext): readonly ArtifactDescriptor[] {
  try {
    return context.platform.artifactStore?.list?.(100) ?? [];
  } catch {
    return [];
  }
}

function reviewerReadinessStatus(checks: readonly ReviewerReadinessCheck[]): ReviewerReadinessStatus {
  if (checks.some((check) => check.status === 'needs-setup')) return 'needs-setup';
  if (checks.some((check) => check.status === 'attention')) return 'attention';
  return 'ready';
}

export function buildReviewerReadinessChecklist(
  context: CommandContext,
  options: {
    readonly documentsReady: boolean;
    readonly modelCompareReady: boolean;
    readonly artifactBrowserReady: boolean;
  },
): ReviewerReadinessChecklist {
  const documents = readDocuments(context);
  const reviewDocuments = documents.filter((document) => document.status !== 'archived');
  const openComments = reviewDocuments.reduce((total, document) => total + document.comments.filter((comment) => comment.status === 'open').length, 0);
  const proposedSuggestions = reviewDocuments.reduce((total, document) => total + document.suggestions.filter((suggestion) => suggestion.status === 'proposed').length, 0);
  const documentsMissingSourceArtifacts = reviewDocuments.filter((document) => document.attachments.length === 0 && !document.lastArtifactId).length;
  const artifacts = readArtifacts(context);
  const comparisons = artifacts.filter(isModelCompareArtifact);
  const judgments = artifacts.filter(isModelCompareJudgmentArtifact);
  const routeDecisions = artifacts.filter(isModelCompareRouteDecisionArtifact);
  const handoffs = artifacts.filter(isModelCompareHandoffArtifact);
  const revealedJudgments = judgments.filter((artifact) => (
    artifact.metadata.revealIncludedInJudgment === true
    && readMetadataString(artifact.metadata.winnerModel).length > 0
  ));
  const hiddenJudgments = judgments.filter((artifact) => (
    artifact.metadata.revealIncludedInJudgment !== true
    || readMetadataString(artifact.metadata.winnerModel).length === 0
  ));
  const routeDecisionComparisonIds = new Set(routeDecisions.map((artifact) => readMetadataString(artifact.metadata.comparisonId)).filter(Boolean));
  const routeDecisionJudgmentArtifactIds = new Set(routeDecisions.map((artifact) => readMetadataString(artifact.metadata.judgmentArtifactId)).filter(Boolean));
  const revealedJudgmentsWaitingOnRouteDecision = revealedJudgments.filter((artifact) => {
    const comparisonId = readMetadataString(artifact.metadata.comparisonId);
    return !routeDecisionJudgmentArtifactIds.has(artifact.id) && (!comparisonId || !routeDecisionComparisonIds.has(comparisonId));
  });
  const revealedComparisonIds = new Set(revealedJudgments.map((artifact) => readMetadataString(artifact.metadata.comparisonId)).filter(Boolean));
  const unrevealedComparisons = comparisons.filter((artifact) => {
    const comparisonId = readMetadataString(artifact.metadata.comparisonId);
    return artifact.metadata.revealIncludedInTranscript !== true && (!comparisonId || !revealedComparisonIds.has(comparisonId));
  });
  const handoffsMissingRelatedArtifacts = handoffs.filter((artifact) => readMetadataStringList(artifact.metadata.relatedArtifactIds).length === 0).length;
  const comparisonSourceMissing = comparisons.filter((artifact) => (
    !readMetadataString(artifact.metadata.sourceArtifactId)
    && !readMetadataString(artifact.metadata.documentId)
  )).length;
  const missingSourceArtifacts = documentsMissingSourceArtifacts + comparisonSourceMissing;
  const firstOpenCommentDocument = reviewDocuments.find((document) => document.comments.some((comment) => comment.status === 'open'));
  const firstProposedSuggestionDocument = reviewDocuments.find((document) => document.suggestions.some((suggestion) => suggestion.status === 'proposed'));
  const firstUnrevealedComparison = unrevealedComparisons[0];
  const firstHiddenJudgment = hiddenJudgments[0];
  const firstRevealedJudgment = revealedJudgmentsWaitingOnRouteDecision[0];
  const firstHandoffMissingRelated = handoffs.find((artifact) => readMetadataStringList(artifact.metadata.relatedArtifactIds).length === 0);

  const checks: ReviewerReadinessCheck[] = [
    {
      id: 'review-tooling',
      label: 'Review tooling',
      status: options.documentsReady && options.modelCompareReady && options.artifactBrowserReady ? 'pass' : 'needs-setup',
      count: Number(options.documentsReady) + Number(options.modelCompareReady) + Number(options.artifactBrowserReady),
      detail: options.documentsReady && options.modelCompareReady && options.artifactBrowserReady
        ? 'Document, artifact, and blind comparison routes are available.'
        : 'Document, artifact, and blind comparison routes must be available before a reviewer-ready export can be trusted.',
      inspectRoute: 'agent_harness mode:"document_ops"',
      repairRoute: 'agent_harness mode:"workspace_actions" categoryId:"documents"',
    },
    {
      id: 'document-review-state',
      label: 'Document comments and suggestions',
      status: openComments + proposedSuggestions > 0 ? 'attention' : 'pass',
      count: openComments + proposedSuggestions,
      detail: openComments + proposedSuggestions > 0
        ? `${openComments} open comment(s) and ${proposedSuggestions} proposed suggestion(s) need a visible resolve, accept, or reject decision.`
        : 'No open document comments or proposed AI suggestions are waiting on reviewer action.',
      inspectRoute: firstOpenCommentDocument || firstProposedSuggestionDocument
        ? `agent_documents show documentId:"${firstOpenCommentDocument?.id ?? firstProposedSuggestionDocument?.id}" includeVersions:true`
        : 'agent_documents list',
      repairRoute: firstOpenCommentDocument
        ? `agent_documents resolveComment documentId:"${firstOpenCommentDocument.id}" commentId:"..." confirm:true explicitUserRequest:"..."`
        : firstProposedSuggestionDocument
          ? `agent_documents acceptSuggestion documentId:"${firstProposedSuggestionDocument.id}" suggestionId:"..." confirm:true explicitUserRequest:"..." or agent_documents rejectSuggestion documentId:"${firstProposedSuggestionDocument.id}" suggestionId:"..." confirm:true explicitUserRequest:"..."`
          : undefined,
    },
    {
      id: 'source-artifacts',
      label: 'Source artifacts',
      status: missingSourceArtifacts > 0 ? 'attention' : 'pass',
      count: missingSourceArtifacts,
      detail: missingSourceArtifacts > 0
        ? `${documentsMissingSourceArtifacts} document draft(s) and ${comparisonSourceMissing} comparison artifact(s) have no attached source artifact or document source marker.`
        : 'Document drafts and saved comparisons have source artifacts or explicit document/source markers where the current stores can verify them.',
      inspectRoute: 'agent_harness mode:"document_ops_lane" laneId:"artifact_browser"',
      repairRoute: missingSourceArtifacts > 0
        ? 'agent_documents attachArtifact documentId:"..." artifactId:"..." confirm:true explicitUserRequest:"..." or agent_model_compare handoff artifactId:"..." relatedArtifactIds:"..." confirm:true explicitUserRequest:"..."'
        : undefined,
    },
    {
      id: 'comparison-reveal',
      label: 'Blind comparison reveal',
      status: unrevealedComparisons.length + hiddenJudgments.length > 0 ? 'attention' : 'pass',
      count: unrevealedComparisons.length + hiddenJudgments.length,
      detail: unrevealedComparisons.length + hiddenJudgments.length > 0
        ? `${unrevealedComparisons.length} saved comparison(s) and ${hiddenJudgments.length} judgment(s) still hide winner identity before reviewer handoff.`
        : 'Saved comparison judgments with route-change implications are revealed, or no hidden comparison artifacts are pending.',
      inspectRoute: firstUnrevealedComparison
        ? `agent_model_compare review artifactId:"${firstUnrevealedComparison.id}"`
        : firstHiddenJudgment
          ? `agent_model_compare review artifactId:"${firstHiddenJudgment.id}"`
          : 'agent_model_compare review',
      repairRoute: firstUnrevealedComparison
        ? `agent_model_compare reveal artifactId:"${firstUnrevealedComparison.id}"`
        : firstHiddenJudgment
          ? `agent_model_compare judge artifactId:"${readMetadataString(firstHiddenJudgment.metadata.sourceArtifactId) || firstHiddenJudgment.id}" winnerBlindId:"${readMetadataString(firstHiddenJudgment.metadata.winnerBlindId) || '...'}" reveal:true confirm:true explicitUserRequest:"..."`
          : undefined,
    },
    {
      id: 'route-change-decision',
      label: 'Route-change decision',
      status: revealedJudgmentsWaitingOnRouteDecision.length > 0 ? 'attention' : 'pass',
      count: revealedJudgmentsWaitingOnRouteDecision.length,
      detail: revealedJudgmentsWaitingOnRouteDecision.length > 0
        ? `${revealedJudgmentsWaitingOnRouteDecision.length} revealed judgment(s) can drive a confirmed model route update, or the user can explicitly leave routing unchanged before archiving.`
        : 'No revealed model comparison judgment is waiting on an apply-or-leave-unchanged decision.',
      inspectRoute: firstRevealedJudgment
        ? `agent_model_compare review artifactId:"${firstRevealedJudgment.id}" reveal:true`
        : 'models action:"status"',
      repairRoute: firstRevealedJudgment
        ? `agent_model_compare apply artifactId:"${firstRevealedJudgment.id}" confirm:true explicitUserRequest:"..." or agent_model_compare routeDecision artifactId:"${firstRevealedJudgment.id}" decision:"left-unchanged" confirm:true explicitUserRequest:"..."`
        : undefined,
    },
    {
      id: 'handoff-archive-evidence',
      label: 'Reviewer handoff evidence',
      status: handoffsMissingRelatedArtifacts > 0 ? 'attention' : 'pass',
      count: handoffsMissingRelatedArtifacts,
      detail: handoffsMissingRelatedArtifacts > 0
        ? `${handoffsMissingRelatedArtifacts} reviewer handoff artifact(s) have no related evidence artifact ids before archive.`
        : 'Reviewer handoff artifacts include related evidence ids, or no reviewer handoff archive is pending.',
      inspectRoute: firstHandoffMissingRelated
        ? `agent_model_compare review artifactId:"${firstHandoffMissingRelated.id}"`
        : 'agent_model_compare review',
      repairRoute: firstHandoffMissingRelated
        ? `agent_model_compare handoff artifactId:"${readMetadataString(firstHandoffMissingRelated.metadata.sourceArtifactId) || firstHandoffMissingRelated.id}" relatedArtifactIds:"..." confirm:true explicitUserRequest:"..."`
        : undefined,
    },
  ];
  const status = reviewerReadinessStatus(checks);
  const firstAction = checks.find((check) => check.status === 'attention' || check.status === 'needs-setup');
  return {
    status,
    next: firstAction
      ? `${firstAction.label}: ${firstAction.detail}`
      : 'Export or archive reviewer packets through the returned confirmed document, artifact, or comparison routes.',
    summary: {
      documents: documents.length,
      openComments,
      proposedSuggestions,
      documentsMissingSourceArtifacts,
      savedComparisons: comparisons.length,
      unrevealedComparisons: unrevealedComparisons.length,
      hiddenJudgments: hiddenJudgments.length,
      revealedJudgments: revealedJudgmentsWaitingOnRouteDecision.length,
      handoffsMissingRelatedArtifacts,
    },
    checks,
    policy: 'Reviewer readiness is read-only. It flags unresolved review work and returns exact existing routes; document exports, comparison handoffs, archives, and model route updates still require explicit confirmation.',
  };
}

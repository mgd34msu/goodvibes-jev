import type { ArtifactDescriptor } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import type { AgentWorkspaceRecentReviewerHandoffArtifact, AgentWorkspaceReviewPacketPresetLineage } from './agent-workspace-types.ts';
import { readArtifactMetadataNumber, readArtifactMetadataString, readArtifactMetadataStringList } from './agent-workspace-artifact-metadata.ts';

export function isoToEpoch(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function compactTimelineText(value: string, maxLength = 96): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

export function uniqueStrings(values: readonly (string | null | undefined)[], limit: number): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
    if (result.length >= limit) break;
  }
  return result;
}

export function isReviewerHandoffArtifact(artifact: ArtifactDescriptor): boolean {
  const purpose = readArtifactMetadataString(artifact.metadata, 'purpose');
  if (purpose === 'agent-model-compare-handoff') return true;
  if (purpose.length > 0) return false;
  return (artifact.filename ?? '').startsWith('blind-model-comparison-handoff-');
}

export function isModelCompareArtifact(artifact: ArtifactDescriptor): boolean {
  const purpose = readArtifactMetadataString(artifact.metadata, 'purpose');
  if (purpose === 'agent-model-compare') return true;
  if (purpose.length > 0) return false;
  return (artifact.filename ?? '').startsWith('blind-model-comparison-cmp_');
}

export function isModelCompareJudgmentArtifact(artifact: ArtifactDescriptor): boolean {
  const purpose = readArtifactMetadataString(artifact.metadata, 'purpose');
  if (purpose === 'agent-model-compare-judgment') return true;
  if (purpose.length > 0) return false;
  return (artifact.filename ?? '').startsWith('blind-model-comparison-judgment-');
}

export function isDocumentExportArtifact(artifact: ArtifactDescriptor): boolean {
  return readArtifactMetadataString(artifact.metadata, 'purpose') === 'agent-document-export';
}

export function isModelCompareExportArtifact(artifact: ArtifactDescriptor): boolean {
  return readArtifactMetadataString(artifact.metadata, 'purpose') === 'agent-model-compare-export';
}

export function isReviewerHandoffArchiveArtifact(artifact: ArtifactDescriptor): boolean {
  return readArtifactMetadataString(artifact.metadata, 'purpose') === 'agent-model-compare-handoff-archive';
}

export function isModelCompareRouteDecisionArtifact(artifact: ArtifactDescriptor): boolean {
  return readArtifactMetadataString(artifact.metadata, 'purpose') === 'agent-model-compare-route-decision';
}

export function isReviewPacketPresetArtifact(artifact: ArtifactDescriptor): boolean {
  return readArtifactMetadataString(artifact.metadata, 'purpose') === 'agent-review-packet-preset';
}

export function artifactById(artifacts: readonly ArtifactDescriptor[], artifactId: string): ArtifactDescriptor | null {
  return artifacts.find((artifact) => artifact.id === artifactId) ?? null;
}

export function firstArtifactMetadataString(
  artifacts: readonly ArtifactDescriptor[],
  artifactIds: readonly string[],
  keys: readonly string[],
): string {
  for (const artifactId of artifactIds) {
    const artifact = artifactById(artifacts, artifactId);
    if (!artifact) continue;
    for (const key of keys) {
      const value = readArtifactMetadataString(artifact.metadata, key);
      if (value) return value;
    }
  }
  return '';
}

export function latestMatchingArtifact(
  artifacts: readonly ArtifactDescriptor[],
  currentArtifactId: string,
  predicate: (artifact: ArtifactDescriptor) => boolean,
): ArtifactDescriptor | null {
  const current = artifactById(artifacts, currentArtifactId);
  const currentCreatedAt = current?.createdAt ?? -1;
  return artifacts
    .filter((artifact) => artifact.id !== currentArtifactId && artifact.createdAt > currentCreatedAt && predicate(artifact))
    .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))[0] ?? null;
}

export function reviewPacketPresetFreshness(
  preset: ArtifactDescriptor,
  artifacts: readonly ArtifactDescriptor[],
): { readonly missingCount: number; readonly newerCount: number; readonly summary: string; readonly status: 'info' | 'attention' } {
  const metadata = preset.metadata;
  const primaryIds = [
    readArtifactMetadataString(metadata, 'documentExportArtifactId'),
    readArtifactMetadataString(metadata, 'comparisonArtifactId'),
    readArtifactMetadataString(metadata, 'judgmentArtifactId'),
    readArtifactMetadataString(metadata, 'revealedJudgmentArtifactId'),
    readArtifactMetadataString(metadata, 'routeDecisionArtifactId'),
    readArtifactMetadataString(metadata, 'handoffArtifactId'),
    readArtifactMetadataString(metadata, 'handoffArchiveArtifactId'),
  ].filter(Boolean);
  const relatedIds = readArtifactMetadataStringList(metadata, 'relatedArtifactIds');
  const referencedIds = uniqueStrings([...primaryIds, ...relatedIds], 40);
  const missingCount = referencedIds.filter((artifactId) => !artifactById(artifacts, artifactId)).length;
  const documentId = readArtifactMetadataString(metadata, 'documentId')
    || firstArtifactMetadataString(artifacts, primaryIds, ['documentId', 'sourceDocumentId']);
  const comparisonId = firstArtifactMetadataString(artifacts, primaryIds, ['comparisonId']);
  const sourceArtifactId = firstArtifactMetadataString(artifacts, primaryIds, ['sourceArtifactId'])
    || readArtifactMetadataString(metadata, 'documentExportArtifactId');
  const handoffSourceArtifactId = readArtifactMetadataString(metadata, 'revealedJudgmentArtifactId')
    || readArtifactMetadataString(metadata, 'judgmentArtifactId')
    || readArtifactMetadataString(metadata, 'comparisonArtifactId')
    || readArtifactMetadataString(metadata, 'documentExportArtifactId');
  const judgmentArtifactId = readArtifactMetadataString(metadata, 'revealedJudgmentArtifactId')
    || readArtifactMetadataString(metadata, 'judgmentArtifactId')
    || firstArtifactMetadataString(artifacts, [readArtifactMetadataString(metadata, 'routeDecisionArtifactId')], ['judgmentArtifactId']);
  const handoffArtifactId = readArtifactMetadataString(metadata, 'handoffArtifactId')
    || firstArtifactMetadataString(artifacts, [readArtifactMetadataString(metadata, 'handoffArchiveArtifactId')], ['handoffArtifactId']);
  const documentExportArtifactId = readArtifactMetadataString(metadata, 'documentExportArtifactId');
  const comparisonArtifactId = readArtifactMetadataString(metadata, 'comparisonArtifactId');
  const judgmentPresetArtifactId = readArtifactMetadataString(metadata, 'judgmentArtifactId');
  const revealedJudgmentArtifactId = readArtifactMetadataString(metadata, 'revealedJudgmentArtifactId');
  const routeDecisionArtifactId = readArtifactMetadataString(metadata, 'routeDecisionArtifactId');
  const handoffPresetArtifactId = readArtifactMetadataString(metadata, 'handoffArtifactId');
  const handoffArchiveArtifactId = readArtifactMetadataString(metadata, 'handoffArchiveArtifactId');
  const freshnessChecks: Array<ArtifactDescriptor | null> = [
    documentId && documentExportArtifactId
      ? latestMatchingArtifact(artifacts, documentExportArtifactId, (artifact) => (
        isDocumentExportArtifact(artifact) && readArtifactMetadataString(artifact.metadata, 'documentId') === documentId
      ))
      : null,
    comparisonArtifactId && (documentId || sourceArtifactId)
      ? latestMatchingArtifact(artifacts, comparisonArtifactId, (artifact) => (
        isModelCompareArtifact(artifact)
        && (
          Boolean(documentId && readArtifactMetadataString(artifact.metadata, 'documentId') === documentId)
          || Boolean(sourceArtifactId && readArtifactMetadataString(artifact.metadata, 'sourceArtifactId') === sourceArtifactId)
        )
      ))
      : null,
    judgmentPresetArtifactId && (comparisonId || sourceArtifactId || documentId)
      ? latestMatchingArtifact(artifacts, judgmentPresetArtifactId, (artifact) => (
        isModelCompareJudgmentArtifact(artifact)
        && (
          Boolean(comparisonId && readArtifactMetadataString(artifact.metadata, 'comparisonId') === comparisonId)
          || Boolean(documentId && readArtifactMetadataString(artifact.metadata, 'documentId') === documentId)
          || Boolean(sourceArtifactId && readArtifactMetadataString(artifact.metadata, 'sourceArtifactId') === sourceArtifactId)
        )
      ))
      : null,
    revealedJudgmentArtifactId && (comparisonId || sourceArtifactId || documentId)
      ? latestMatchingArtifact(artifacts, revealedJudgmentArtifactId, (artifact) => (
        isModelCompareJudgmentArtifact(artifact)
        && artifact.metadata.revealIncludedInJudgment === true
        && readArtifactMetadataString(artifact.metadata, 'winnerModel').length > 0
        && (
          Boolean(comparisonId && readArtifactMetadataString(artifact.metadata, 'comparisonId') === comparisonId)
          || Boolean(documentId && readArtifactMetadataString(artifact.metadata, 'documentId') === documentId)
          || Boolean(sourceArtifactId && readArtifactMetadataString(artifact.metadata, 'sourceArtifactId') === sourceArtifactId)
        )
      ))
      : null,
    routeDecisionArtifactId && (comparisonId || judgmentArtifactId)
      ? latestMatchingArtifact(artifacts, routeDecisionArtifactId, (artifact) => (
        isModelCompareRouteDecisionArtifact(artifact)
        && (
          Boolean(judgmentArtifactId && readArtifactMetadataString(artifact.metadata, 'judgmentArtifactId') === judgmentArtifactId)
          || Boolean(comparisonId && readArtifactMetadataString(artifact.metadata, 'comparisonId') === comparisonId)
        )
      ))
      : null,
    handoffPresetArtifactId && (comparisonId || handoffSourceArtifactId)
      ? latestMatchingArtifact(artifacts, handoffPresetArtifactId, (artifact) => (
        isReviewerHandoffArtifact(artifact)
        && (
          Boolean(handoffSourceArtifactId && readArtifactMetadataString(artifact.metadata, 'sourceArtifactId') === handoffSourceArtifactId)
          || Boolean(comparisonId && readArtifactMetadataString(artifact.metadata, 'comparisonId') === comparisonId)
        )
      ))
      : null,
    handoffArchiveArtifactId && (comparisonId || handoffArtifactId)
      ? latestMatchingArtifact(artifacts, handoffArchiveArtifactId, (artifact) => (
        isReviewerHandoffArchiveArtifact(artifact)
        && (
          Boolean(handoffArtifactId && readArtifactMetadataString(artifact.metadata, 'handoffArtifactId') === handoffArtifactId)
          || Boolean(comparisonId && readArtifactMetadataString(artifact.metadata, 'comparisonId') === comparisonId)
        )
      ))
      : null,
  ];
  const newerCount = new Set(freshnessChecks.filter((artifact): artifact is ArtifactDescriptor => artifact !== null).map((artifact) => artifact.id)).size;
  const needsReview = missingCount > 0 || newerCount > 0;
  return {
    missingCount,
    newerCount,
    summary: needsReview ? `freshness needs review: ${missingCount} missing, ${newerCount} newer` : 'freshness current',
    status: needsReview ? 'attention' : 'info',
  };
}

export function buildReviewPacketPresetLineage(preset: ArtifactDescriptor | null): AgentWorkspaceReviewPacketPresetLineage | null {
  if (!preset) return null;
  const metadata = preset.metadata;
  const refreshedFromArtifactId = readArtifactMetadataString(metadata, 'refreshOfArtifactId') || null;
  const refreshedFromPresetId = readArtifactMetadataString(metadata, 'refreshOfPresetId') || null;
  const freshnessMissingCount = readArtifactMetadataNumber(metadata, 'freshnessMissingCount');
  const freshnessSupersededCount = readArtifactMetadataNumber(metadata, 'freshnessSupersededCount');
  const freshnessUnresolvedCount = readArtifactMetadataNumber(metadata, 'freshnessUnresolvedCount');
  const repairedCount = (freshnessMissingCount ?? 0) + (freshnessSupersededCount ?? 0);
  const name = readArtifactMetadataString(metadata, 'name') || null;
  const presetId = readArtifactMetadataString(metadata, 'presetId') || null;
  const displayName = name ?? preset.filename ?? preset.id;
  const summary = refreshedFromArtifactId
    ? [
      `${displayName} refreshed from ${refreshedFromArtifactId}`,
      refreshedFromPresetId ? `source preset ${refreshedFromPresetId}` : '',
      `repaired ${repairedCount}`,
      `unresolved ${freshnessUnresolvedCount ?? 0}`,
    ].filter(Boolean).join('; ')
    : [
      `${displayName} has no refresh lineage`,
      presetId ? `preset ${presetId}` : '',
    ].filter(Boolean).join('; ');
  return {
    artifactId: preset.id,
    presetId,
    name,
    refreshed: Boolean(refreshedFromArtifactId),
    refreshedFromArtifactId,
    refreshedFromPresetId,
    freshnessMissingCount,
    freshnessSupersededCount,
    freshnessUnresolvedCount,
    summary,
    inspectRoute: `agent_review_packet_presets show artifactId:"${preset.id}"`,
  };
}

export function summarizeReviewerHandoffArtifact(artifact: ArtifactDescriptor): AgentWorkspaceRecentReviewerHandoffArtifact {
  const metadata = artifact.metadata;
  return {
    id: artifact.id,
    filename: artifact.filename ?? '(unnamed handoff artifact)',
    createdAt: artifact.createdAt,
    handoffId: readArtifactMetadataString(metadata, 'handoffId') || 'unknown-handoff',
    comparisonId: readArtifactMetadataString(metadata, 'comparisonId') || 'unknown-comparison',
    sourceArtifactId: readArtifactMetadataString(metadata, 'sourceArtifactId') || '(missing source)',
    sourceKind: readArtifactMetadataString(metadata, 'sourceKind') || 'unknown',
    relatedArtifactCount: readArtifactMetadataStringList(metadata, 'relatedArtifactIds').length,
  };
}

import type {
  KnowledgeIssueRecord,
  KnowledgeJobMode,
  KnowledgeJobRecord,
  KnowledgeMaterializedProjection,
  KnowledgeStatus,
} from './types.js';
import type { BrowserKnowledgeIngestResult } from './browser-history/index.js';
import type { KnowledgeSemanticService } from './semantic/index.js';

export interface KnowledgeServiceJobRunnerContext {
  readonly lint: () => Promise<readonly KnowledgeIssueRecord[]>;
  readonly reindex: () => Promise<{ readonly status: KnowledgeStatus; readonly issues: readonly KnowledgeIssueRecord[] }>;
  readonly refreshSources: (
    kind: 'stale' | 'bookmark',
    sourceIds?: readonly string[],
    limit?: number | undefined,
  ) => Promise<number>;
  readonly syncBrowserHistory: (input: { readonly limit?: number | undefined }) => Promise<BrowserKnowledgeIngestResult>;
  readonly materializeProjection: (input: {
    readonly kind: 'overview' | 'bundle';
    readonly limit: number;
  }) => Promise<KnowledgeMaterializedProjection>;
  readonly semanticService: KnowledgeSemanticService;
  readonly runConsolidation: (
    kind: 'light-consolidation' | 'deep-consolidation',
    input: { readonly limit?: number | undefined; readonly autoPromote: boolean },
  ) => Promise<{ readonly id: string; readonly metrics: Record<string, number> }>;
}

export async function runKnowledgeServiceJobByKind(
  kind: KnowledgeJobRecord['kind'],
  input: { readonly mode?: KnowledgeJobMode | undefined; readonly sourceIds?: readonly string[] | undefined; readonly limit?: number | undefined },
  context: KnowledgeServiceJobRunnerContext,
): Promise<Record<string, unknown>> {
  switch (kind) {
    case 'lint': {
      const issues = await context.lint();
      return { issueCount: issues.length };
    }
    case 'reindex': {
      const result = await context.reindex();
      return { sourceCount: result.status.sourceCount, issueCount: result.issues.length };
    }
    case 'refresh-stale':
      return { refreshed: await context.refreshSources('stale', input.sourceIds, input.limit) };
    case 'refresh-bookmarks':
      return { refreshed: await context.refreshSources('bookmark', input.sourceIds, input.limit) };
    case 'sync-browser-history': {
      const result = await context.syncBrowserHistory({ limit: input.limit });
      return {
        imported: result.imported,
        failed: result.failed,
        captured: result.captured,
        capturePartial: result.outcomes.filter((outcome) => outcome.capture === 'partial').length,
        captureFailed: result.outcomes.filter((outcome) => outcome.capture === 'failed').length,
        compilationHeld: result.outcomes.filter((outcome) => outcome.compilation === 'held').length,
        compilationFailed: result.outcomes.filter((outcome) => outcome.compilation === 'failed').length,
        outcomes: result.outcomes,
        profileCount: result.profiles.length,
        errorCount: result.errors.length,
      };
    }
    case 'rebuild-projections': {
      const overview = await context.materializeProjection({ kind: 'overview', limit: Math.max(8, input.limit ?? 12) });
      const bundle = await context.materializeProjection({ kind: 'bundle', limit: Math.max(12, input.limit ?? 18) });
      return {
        projections: [
          { targetId: overview.bundle.target.targetId, artifactId: overview.artifact.id },
          { targetId: bundle.bundle.target.targetId, artifactId: bundle.artifact.id },
        ],
      };
    }
    case 'semantic-enrichment':
      return context.semanticService.reindex({
        sourceIds: input.sourceIds,
        limit: input.limit,
      });
    case 'semantic-self-improvement': {
      const result = await context.semanticService.selfImprove({
        sourceIds: input.sourceIds,
        limit: input.limit,
        reason: 'scheduled',
      });
      return { ...result };
    }
    case 'light-consolidation': {
      const report = await context.runConsolidation('light-consolidation', {
        limit: input.limit,
        autoPromote: false,
      });
      return { reportId: report.id, metrics: report.metrics };
    }
    case 'deep-consolidation': {
      const report = await context.runConsolidation('deep-consolidation', {
        limit: input.limit,
        autoPromote: true,
      });
      return { reportId: report.id, metrics: report.metrics };
    }
    default:
      return {};
  }
}

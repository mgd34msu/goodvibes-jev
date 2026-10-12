import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { withNativeCatalog, rankResearchRecords } from './agent-harness-research-catalog-source.ts';
import { selectHarnessCatalog } from './agent-harness-catalog-selection.ts';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { previewHarnessText } from './agent-harness-text.ts';

const RELEASE_EVIDENCE_ARTIFACTS = [
  {
    id: 'release-notes',
    path: 'release/release-notes.md',
    kind: 'markdown',
    description: 'Shipped release notes included with operator/audit release artifacts.',
  },
  {
    id: 'performance-snapshot',
    path: 'release/performance-snapshot.json',
    kind: 'json',
    description: 'Recorded performance snapshot used by the release performance gate.',
  },
  {
    id: 'release-readiness',
    path: 'release/release-readiness.json',
    kind: 'json',
    description: 'Release inventory with owner, evidence, and quality dimensions.',
  },
  {
    id: 'live-verification-json',
    path: 'release/live-verification/live-verification.json',
    kind: 'json',
    description: 'Machine-readable strict live verification report.',
  },
  {
    id: 'live-verification-markdown',
    path: 'release/live-verification/live-verification.md',
    kind: 'markdown',
    description: 'Human-readable strict live verification report.',
  },
] as const;

type ReleaseEvidenceArtifactId = typeof RELEASE_EVIDENCE_ARTIFACTS[number]['id'];

interface ReleaseEvidenceArtifact {
  readonly id: ReleaseEvidenceArtifactId;
  readonly path: string;
  readonly kind: 'json' | 'markdown';
  readonly description: string;
}

interface ReleaseEvidenceArgs {
  readonly query?: unknown;
  readonly target?: unknown;
  readonly artifactId?: unknown;
  readonly limit?: unknown;
  readonly includeParameters?: unknown;
}

interface ReleaseEvidenceLookup {
  readonly source: 'artifactId' | 'target' | 'query';
  readonly input: string;
}

type ReleaseEvidenceArtifactLoadResult =
  | {
    readonly status: 'available';
    readonly artifact: ReleaseEvidenceArtifact;
    readonly absolutePath: string;
    readonly source: string;
    readonly parsed?: unknown;
    readonly sizeBytes: number;
  }
  | {
    readonly status: 'missing' | 'invalid';
    readonly artifact: ReleaseEvidenceArtifact;
    readonly absolutePath: string;
    readonly reason: string;
  };

export type ReleaseEvidenceArtifactResolution =
  | {
    readonly status: 'found';
    readonly lookup: ReleaseEvidenceLookup & { readonly resolvedBy: 'id' | 'case-insensitive-id' | 'path' | 'search' };
    readonly artifact: Record<string, unknown>;
  }
  | {
    readonly status: 'ambiguous';
    readonly input: string;
    readonly candidates: readonly Record<string, unknown>[];
  }
  | {
    readonly status: 'not_found' | 'missing_lookup';
    readonly input?: string;
    readonly total?: number;
    readonly usage?: string;
  };

function packageRoot(): string {
  return join(import.meta.dir, '..', '..');
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(100, Math.trunc(parsed)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function normalized(value: string): string {
  return value.toLowerCase();
}



function releaseEvidenceModelRoute(artifact?: ReleaseEvidenceArtifact): string {
  if (artifact) return 'audit action:"artifact"';
  return 'audit action:"evidence" or action:"artifact"';
}

function releaseEvidencePolicy(): Record<string, unknown> {
  return {
    effect: 'operator-audit-read-only',
    audience: 'release operators and maintainers',
    values: 'Returns packaged release artifacts, summaries, and optional artifact content for release audit.',
    boundary: 'Release artifacts are audit material. They are not visible product routes and do not mutate runtime state.',
  };
}

function evidenceLookupFromArgs(args: ReleaseEvidenceArgs): ReleaseEvidenceLookup | null {
  const artifactId = readString(args.artifactId);
  if (artifactId) return { source: 'artifactId', input: artifactId };
  const target = readString(args.target);
  if (target) return { source: 'target', input: target };
  const query = readString(args.query);
  return query ? { source: 'query', input: query } : null;
}

function loadArtifact(artifact: ReleaseEvidenceArtifact): ReleaseEvidenceArtifactLoadResult {
  const absolutePath = join(packageRoot(), artifact.path);
  if (!existsSync(absolutePath)) {
    return {
      status: 'missing',
      artifact,
      absolutePath,
      reason: `${artifact.path} is not present in this Agent installation.`,
    };
  }
  try {
    const source = readFileSync(absolutePath, 'utf-8');
    const sizeBytes = statSync(absolutePath).size;
    if (artifact.kind === 'json') {
      return {
        status: 'available',
        artifact,
        absolutePath,
        source,
        parsed: JSON.parse(source) as unknown,
        sizeBytes,
      };
    }
    return { status: 'available', artifact, absolutePath, source, sizeBytes };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 'invalid',
      artifact,
      absolutePath,
      reason: `${artifact.path} could not be read: ${message}`,
    };
  }
}

function firstHeading(source: string): string | undefined {
  return source.split(/\r?\n/).find((line) => line.startsWith('# '))?.replace(/^#\s+/, '').trim() || undefined;
}

function countMarkdownBullets(source: string): number {
  return source.split(/\r?\n/).filter((line) => /^-\s+/.test(line)).length;
}

function countBy(items: readonly Record<string, unknown>[], key: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const value = readString(item[key]) || '<missing>';
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function summarizeJsonArtifact(artifactId: ReleaseEvidenceArtifactId, parsed: unknown): Record<string, unknown> {
  const root = asRecord(parsed);
  if (artifactId === 'performance-snapshot') {
    const surfacePerf = asRecord(root.surfacePerf);
    const extraMetrics = asRecord(root.extraMetrics);
    return {
      budgetStatus: surfacePerf.budgetStatus,
      targetBudgetMs: surfacePerf.targetBudgetMs,
      overBudgetCount: surfacePerf.overBudgetCount,
      extraMetrics: Object.keys(extraMetrics).length,
    };
  }
  if (artifactId === 'release-readiness') {
    const items = Array.isArray(root.items) ? root.items.filter(isRecord) : [];
    return {
      gate: root.gate,
      checkedAt: root.checkedAt,
      items: items.length,
      statuses: countBy(items, 'status'),
      owners: countBy(items, 'owner'),
    };
  }
  if (artifactId === 'live-verification-json') {
    return {
      generatedAt: root.generatedAt,
      strict: root.strict,
      ok: root.ok,
      counts: root.counts,
    };
  }
  return {};
}

function summarizeMarkdownArtifact(artifactId: ReleaseEvidenceArtifactId, source: string): Record<string, unknown> {
  if (artifactId === 'release-notes') {
    return {
      title: firstHeading(source),
      bullets: countMarkdownBullets(source),
    };
  }
  if (artifactId === 'live-verification-markdown') {
    const generated = source.match(/^Generated:\s*(.+)$/m)?.[1]?.trim();
    const result = source.match(/^Result:\s*(.+)$/m)?.[1]?.trim();
    return {
      title: firstHeading(source),
      generatedAt: generated,
      result,
    };
  }
  return { title: firstHeading(source) };
}

function summarizeLoadedArtifact(
  loaded: ReleaseEvidenceArtifactLoadResult,
  options: { readonly includeSource?: boolean } = {},
): Record<string, unknown> {
  const base = {
    id: loaded.artifact.id,
    path: loaded.artifact.path,
    kind: loaded.artifact.kind,
    description: loaded.artifact.description,
    status: loaded.status,
    modelRoute: releaseEvidenceModelRoute(loaded.artifact),
  };
  if (loaded.status !== 'available') {
    return { ...base, reason: loaded.reason };
  }

  const summary = loaded.artifact.kind === 'json'
    ? summarizeJsonArtifact(loaded.artifact.id, loaded.parsed)
    : summarizeMarkdownArtifact(loaded.artifact.id, loaded.source);
  return {
    ...base,
    sizeBytes: loaded.sizeBytes,
    summary,
    policy: releaseEvidencePolicy(),
    modelAccess: {
      listArtifacts: 'audit action:"evidence"',
      inspectArtifact: `audit action:"artifact" artifactId:"${loaded.artifact.id}"`,
      lowerLevelArtifact: `agent_harness mode:"release_evidence_artifact" artifactId:"${loaded.artifact.id}" includeParameters:true`,
      includeContent: 'Pass includeParameters:true only when release audit requires artifact content.',
    },
    ...(options.includeSource
      ? loaded.artifact.kind === 'json'
        ? { data: loaded.parsed }
        : { content: loaded.source }
      : {}),
  };
}



function evidenceBundleStatus(loaded: readonly ReleaseEvidenceArtifactLoadResult[]): Record<string, unknown> {
  const available = loaded.filter((artifact) => artifact.status === 'available').length;
  return {
    status: available === RELEASE_EVIDENCE_ARTIFACTS.length ? 'available' : available > 0 ? 'degraded' : 'unavailable',
    artifacts: RELEASE_EVIDENCE_ARTIFACTS.length,
    available,
    missingOrInvalid: RELEASE_EVIDENCE_ARTIFACTS.length - available,
    paths: RELEASE_EVIDENCE_ARTIFACTS.map((artifact) => artifact.path),
  };
}

export async function releaseEvidenceBundleStatus(options: CatalogRankingOptions = {}): Promise<Record<string, unknown>> {
  return withNativeCatalog({}, options, RELEASE_EVIDENCE_ARTIFACTS.map(artifact => join(packageRoot(), artifact.path)),
    () => RELEASE_EVIDENCE_ARTIFACTS.map(loadArtifact), async (_args, loaded) => evidenceBundleStatus(loaded));
}

export async function releaseEvidenceSummary(rawArgs: ReleaseEvidenceArgs, options: CatalogRankingOptions = {}): Promise<Record<string, unknown>> {
  return withNativeCatalog(rawArgs, options, RELEASE_EVIDENCE_ARTIFACTS.map(artifact => join(packageRoot(), artifact.path)),
    () => RELEASE_EVIDENCE_ARTIFACTS.map(loadArtifact), async (args, allLoaded, options) => {
  const query = readString(args.query || args.target);
  const selected = await rankResearchRecords(allLoaded, query, loaded => ({ id: loaded.artifact.id, description: loaded.artifact.description, evidence: loaded }), options, 'agent.release.evidence');
  const limit = readLimit(args.limit, 100);
  const loaded = selected.slice(0, limit);
  const status = evidenceBundleStatus(allLoaded);
  return {
    mode: 'release_evidence',
    ...status,
    filtered: selected.length,
    returned: loaded.length,
    artifactsList: loaded.map((artifact) => summarizeLoadedArtifact(artifact, { includeSource: args.includeParameters === true })),
    policy: releaseEvidencePolicy(),
    modelAccess: {
      listArtifacts: 'audit action:"evidence"',
      inspectArtifact: 'audit action:"artifact" with artifactId, target, or query',
      lowerLevelArtifact: 'agent_harness mode:"release_evidence_artifact" artifactId:"..." includeParameters:true',
    },
    artifactLookup: 'Use audit action:"artifact" with artifactId, target, or query to inspect one release evidence artifact; lower-level agent_harness mode:"release_evidence_artifact" remains available.',
  };

  });
}

function capturedArtifact(loaded: readonly ReleaseEvidenceArtifactLoadResult[], id: ReleaseEvidenceArtifactId): ReleaseEvidenceArtifactLoadResult {
  const original = loaded.find(entry => entry.artifact.id === id);
  if (!original) throw new ToolInputProjectionError('held');
  return original;
}

export async function describeHarnessReleaseEvidenceArtifact(rawArgs: ReleaseEvidenceArgs, options: CatalogRankingOptions = {}): Promise<ReleaseEvidenceArtifactResolution> {
  return withNativeCatalog(rawArgs, options, RELEASE_EVIDENCE_ARTIFACTS.map(artifact => join(packageRoot(), artifact.path)),
    () => RELEASE_EVIDENCE_ARTIFACTS.map(loadArtifact), async (args, allLoaded, options) => {
  const lookup = evidenceLookupFromArgs(args);
  if (!lookup) {
    return {
      status: 'missing_lookup',
      total: RELEASE_EVIDENCE_ARTIFACTS.length,
      usage: 'Provide artifactId, target, or query for mode:"release_evidence_artifact".',
    };
  }

  const exactId = RELEASE_EVIDENCE_ARTIFACTS.find((artifact) => artifact.id === lookup.input);
  if (exactId) {
    return {
      status: 'found',
      lookup: { ...lookup, resolvedBy: 'id' },
      artifact: summarizeLoadedArtifact(capturedArtifact(allLoaded, exactId.id), { includeSource: true }),
    };
  }

  const input = normalized(lookup.input);
  const insensitiveId = RELEASE_EVIDENCE_ARTIFACTS.find((artifact) => artifact.id.toLowerCase() === input);
  if (insensitiveId) {
    return {
      status: 'found',
      lookup: { ...lookup, resolvedBy: 'case-insensitive-id' },
      artifact: summarizeLoadedArtifact(capturedArtifact(allLoaded, insensitiveId.id), { includeSource: true }),
    };
  }

  const path = RELEASE_EVIDENCE_ARTIFACTS.find((artifact) => artifact.path.toLowerCase() === input);
  if (path) {
    return {
      status: 'found',
      lookup: { ...lookup, resolvedBy: 'path' },
      artifact: summarizeLoadedArtifact(capturedArtifact(allLoaded, path.id), { includeSource: true }),
    };
  }

  const selected = await selectHarnessCatalog(allLoaded, lookup.input, loaded => ({ id: loaded.artifact.id, description: loaded.artifact.description, evidence: loaded }), options, 'agent.release.evidence.artifact');
  if (selected) return { status: 'found', lookup: { ...lookup, resolvedBy: 'search' }, artifact: summarizeLoadedArtifact(selected, { includeSource: true }) };

  return {
    status: 'not_found',
    input: lookup.input,
    total: RELEASE_EVIDENCE_ARTIFACTS.length,
  };

  });
}

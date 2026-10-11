import { randomUUID } from 'node:crypto';
import { snapshotNodeInput } from './activation/projection.js';
import { KnowledgeNodeActivationHeldError } from './activation/types.js';
import { KnowledgeNodeMutationHeldError } from './store-node-authority.js';
import { KnowledgeEntityAliasHoldError } from './entity-aliases.js';
import { knowledgeIngestGuard, stageKnowledgePendingSource } from './ingest-preparation.js';
import { JudgmentInputError } from '../gate/judgment-input.js';
import { KnowledgeExtractionJudgmentHoldError } from './extraction-policy.js';
import { prepareKnowledgeExtraction, type PreparedKnowledgeExtraction } from './prepared-extraction.js';
import { readFile } from 'node:fs/promises';
import {
  emitKnowledgeIngestCompleted,
  emitKnowledgeIngestFailed,
  emitKnowledgeIngestStarted,
} from '../runtime/emitters/index.js';
import { summarizeError } from '../utils/error-display.js';
import { finalizeKnowledgeIngestedSource } from './ingest-compile.js';
import type { KnowledgeIngestContext, KnowledgeIngestOwnership } from './ingest-context.js';
import {
  canonicalizeUri,
  inferSourceTypeFromArtifact,
  isHttpUri,
  isSourcePastRefreshWindow,
  mergeTags,
} from './shared.js';

/** One refresh-window table and lookup for the knowledge subsystem (shared.ts); re-exported for ingest.ts. */
export { getSourceRefreshWindowMs, isSourcePastRefreshWindow } from './shared.js';
import type {
  KnowledgeBatchIngestResult,
  KnowledgeBookmarkSeed,
  KnowledgeExtractionRecord,
  KnowledgeIssueRecord,
  KnowledgeSourceRecord,
  KnowledgeSourceType,
} from './types.js';

export async function ingestKnowledgeUrl(
  context: KnowledgeIngestContext,
  input: {
    readonly url: string;
    readonly title?: string | undefined;
    readonly tags?: readonly string[] | undefined;
    readonly folderPath?: string | undefined;
    readonly sessionId?: string | undefined;
    readonly sourceType?: KnowledgeSourceType | undefined;
    readonly connectorId?: string | undefined;
    readonly signal?: AbortSignal | undefined;
    readonly allowPrivateHosts?: boolean | undefined;
    readonly metadata?: Record<string, unknown> | undefined;
  },
  ownership: KnowledgeIngestOwnership = {},
): Promise<{ source: KnowledgeSourceRecord; artifactId?: string; extraction?: KnowledgeExtractionRecord; issues: readonly KnowledgeIssueRecord[] }> {
  const { assertCurrent: callerCurrent, signal: callerSignal, onCommitted, deferSemanticEnrichment } = ownership;
  const { signal: inputSignal, ...values } = input;
  const signal = ownership.signal && inputSignal ? AbortSignal.any([ownership.signal, inputSignal]) : ownership.signal ?? inputSignal;
  const assertOwned = () => {
    try {
      if (ownership.assertCurrent !== callerCurrent || ownership.signal !== callerSignal || ownership.onCommitted !== onCommitted
        || ownership.deferSemanticEnrichment !== deferSemanticEnrichment) throw new Error('retired');
      signal?.throwIfAborted(); callerCurrent?.();
    }
    catch { throw new KnowledgeEntityAliasHoldError(); }
  };
  assertOwned();
  input = { ...snapshotNodeInput(values), signal };
  await context.store.init();
  assertOwned();
  const canonicalUri = canonicalizeUri(input.url) ?? undefined;
  const sourceId = reserveSourceId(context, canonicalUri);
  const connectorId = input.connectorId ?? (input.sourceType === 'bookmark' ? 'bookmark' : 'url');
  const sourceCurrent = knowledgeIngestGuard(context, sourceId, canonicalUri, signal);
  const assertCurrent = () => { assertOwned(); sourceCurrent(); };
  assertCurrent();
  const preparation = await capturePreparation(async () => {
    const artifact = await context.artifactStore.create({
      uri: input.url,
      allowPrivateHosts: input.allowPrivateHosts,
      metadata: { sourceConnector: connectorId, requestedAt: Date.now() },
    }, { signal, assertCurrent });
    assertCurrent();
    return prepareKnowledgeExtraction(context, sourceId, artifact.id, { signal, assertCurrent });
  });
  assertCurrent();
  const pending = stageKnowledgePendingSource(context, {
    id: sourceId,
    connectorId,
    sourceType: input.sourceType ?? 'url',
    title: input.title,
    sourceUri: input.url,
    canonicalUri,
    tags: input.tags,
    folderPath: input.folderPath,
    status: 'pending',
    sessionId: input.sessionId,
    metadata: input.metadata,
  });
  context.emitIfReady((bus, ctx) => emitKnowledgeIngestStarted(bus, ctx, {
    sourceId: pending.id,
    connectorId: pending.connectorId,
    sourceType: pending.sourceType,
    uri: input.url,
  }), pending.sessionId);
  try {
    if (!preparation.ready) throw preparation.error;
    const result = await finalizeKnowledgeIngestedSource(context, {
      sourceId: pending.id,
      artifactId: preparation.token.artifactId,
      preparedExtraction: preparation.token,
      signal,
      inputTitle: input.title,
      sourceType: input.sourceType ?? pending.sourceType,
      connectorId: pending.connectorId,
      tags: mergeTags(pending.tags, input.tags),
      folderPath: input.folderPath ?? pending.folderPath,
      sessionId: input.sessionId ?? pending.sessionId,
      metadata: {
        ...pending.metadata,
        ...(input.metadata ?? {}),
      },
    }, { ...ownership, signal, assertCurrent: assertOwned });
    const issues = await context.lint();
    context.emitIfReady((bus, ctx) => emitKnowledgeIngestCompleted(bus, ctx, {
      sourceId: result.source.id,
      status: result.source.status,
      artifactId: result.artifactId,
      title: result.source.title,
    }), result.source.sessionId);
    return { ...result, issues };
  } catch (error) {
    if (ownership.assertCurrent || ownership.onCommitted || ownership.signal) throw error;
    if (error instanceof KnowledgeEntityAliasHoldError || error instanceof KnowledgeExtractionJudgmentHoldError || error instanceof KnowledgeNodeActivationHeldError || error instanceof KnowledgeNodeMutationHeldError || error instanceof JudgmentInputError) throw error;
    const failed = await context.store.upsertSource({
      id: pending.id,
      connectorId: pending.connectorId,
      sourceType: pending.sourceType,
      title: pending.title,
      sourceUri: pending.sourceUri,
      canonicalUri: pending.canonicalUri,
      tags: pending.tags,
      folderPath: pending.folderPath,
      status: 'failed',
      crawlError: summarizeError(error),
      sessionId: pending.sessionId,
      metadata: pending.metadata,
    });
    await context.syncReviewedMemory();
    const issues = await context.lint();
    context.emitIfReady((bus, ctx) => emitKnowledgeIngestFailed(bus, ctx, {
      sourceId: failed.id,
      error: failed.crawlError ?? 'Knowledge ingest failed.',
    }), failed.sessionId);
    return { source: failed, issues };
  }
}

export async function ingestKnowledgeArtifact(
  context: KnowledgeIngestContext,
  input: {
    readonly artifactId?: string | undefined;
    readonly path?: string | undefined;
    readonly uri?: string | undefined;
    readonly title?: string | undefined;
    readonly tags?: readonly string[] | undefined;
    readonly folderPath?: string | undefined;
    readonly sessionId?: string | undefined;
    readonly sourceType?: KnowledgeSourceType | undefined;
    readonly connectorId?: string | undefined;
    readonly signal?: AbortSignal | undefined;
    readonly allowPrivateHosts?: boolean | undefined;
    readonly metadata?: Record<string, unknown> | undefined;
  },
  ownership: KnowledgeIngestOwnership = {},
): Promise<{ source: KnowledgeSourceRecord; artifactId?: string; extraction?: KnowledgeExtractionRecord; issues: readonly KnowledgeIssueRecord[] }> {
  const { signal: inputSignal, ...values } = input;
  const signal = ownership.signal && inputSignal ? AbortSignal.any([ownership.signal, inputSignal]) : ownership.signal ?? inputSignal;
  const assertOwned = () => {
    try { signal?.throwIfAborted(); ownership.assertCurrent?.(); }
    catch { throw new KnowledgeEntityAliasHoldError(); }
  };
  assertOwned();
  input = { ...snapshotNodeInput(values), signal };
  await context.store.init();
  assertOwned();
  let artifactId = input.artifactId;
  let sourceUri = input.uri;
  if (!artifactId) {
    if (input.path) {
      const artifact = await context.artifactStore.create({
        path: input.path,
        metadata: {
          sourceConnector: input.connectorId ?? 'artifact',
          requestedAt: Date.now(),
        },
      });
      artifactId = artifact.id;
      sourceUri = input.path;
    } else if (input.uri) {
      const artifact = await context.artifactStore.create({
        uri: input.uri,
        allowPrivateHosts: input.allowPrivateHosts,
        metadata: {
          sourceConnector: input.connectorId ?? 'artifact',
          requestedAt: Date.now(),
        },
      });
      artifactId = artifact.id;
      sourceUri = artifact.sourceUri ?? input.uri;
    }
  }
  if (!artifactId) throw new Error('Artifact ingest requires artifactId, path, or uri.');
  const record = context.artifactStore.getRecord(artifactId);
  if (!record) throw new Error(`Unknown artifact: ${artifactId}`);
  const canonicalUri = canonicalizeUri(sourceUri ?? '') ?? undefined;
  const sourceId = reserveSourceId(context, canonicalUri);
  const sourceCurrent = knowledgeIngestGuard(context, sourceId, canonicalUri, signal);
  const assertCurrent = () => { assertOwned(); sourceCurrent(); };
  assertCurrent();
  const preparation = await capturePreparation(() => prepareKnowledgeExtraction(context, sourceId, artifactId));
  assertCurrent();
  const pending = stageKnowledgePendingSource(context, {
    id: sourceId,
    connectorId: input.connectorId ?? 'artifact',
    sourceType: input.sourceType ?? inferSourceTypeFromArtifact(record),
    title: input.title ?? record.filename,
    sourceUri,
    canonicalUri,
    tags: input.tags,
    folderPath: input.folderPath,
    status: 'pending',
    sessionId: input.sessionId,
    metadata: {
      ...(input.metadata ?? {}),
      artifactMimeType: record.mimeType,
    },
  });
  context.emitIfReady((bus, ctx) => emitKnowledgeIngestStarted(bus, ctx, {
    sourceId: pending.id,
    connectorId: pending.connectorId,
    sourceType: pending.sourceType,
    uri: sourceUri,
  }), pending.sessionId);
  try {
    if (!preparation.ready) throw preparation.error;
    const result = await finalizeKnowledgeIngestedSource(context, {
      sourceId: pending.id,
      artifactId,
      preparedExtraction: preparation.token,
      signal,
      inputTitle: input.title,
      sourceType: pending.sourceType,
      connectorId: pending.connectorId,
      tags: mergeTags(pending.tags, input.tags),
      folderPath: pending.folderPath,
      sessionId: input.sessionId ?? pending.sessionId,
      metadata: {
        ...pending.metadata,
        ...(input.metadata ?? {}),
      },
    }, { ...ownership, signal, assertCurrent: assertOwned });
    const issues = await context.lint();
    context.emitIfReady((bus, ctx) => emitKnowledgeIngestCompleted(bus, ctx, {
      sourceId: result.source.id,
      status: result.source.status,
      artifactId: result.artifactId,
      title: result.source.title,
    }), result.source.sessionId);
    return { ...result, issues };
  } catch (error) {
    // Host-owned operations never turn a revoked/precommit failure into a new
    // failed-source write, or overwrite a committed receipt after bookkeeping fails.
    if (ownership.assertCurrent || ownership.onCommitted || ownership.signal) throw error;
    if (error instanceof KnowledgeEntityAliasHoldError || error instanceof KnowledgeExtractionJudgmentHoldError || error instanceof KnowledgeNodeActivationHeldError || error instanceof KnowledgeNodeMutationHeldError || error instanceof JudgmentInputError) throw error;
    const failed = await context.store.upsertSource({
      id: pending.id,
      connectorId: pending.connectorId,
      sourceType: pending.sourceType,
      title: pending.title,
      sourceUri: pending.sourceUri,
      canonicalUri: pending.canonicalUri,
      tags: pending.tags,
      folderPath: pending.folderPath,
      status: 'failed',
      crawlError: summarizeError(error),
      sessionId: pending.sessionId,
      metadata: pending.metadata,
    });
    await context.syncReviewedMemory();
    const issues = await context.lint();
    context.emitIfReady((bus, ctx) => emitKnowledgeIngestFailed(bus, ctx, {
      sourceId: failed.id,
      error: failed.crawlError ?? 'Artifact ingest failed.',
    }), failed.sessionId);
    return { source: failed, issues };
  }
}

export async function importKnowledgeBookmarksFromFile(
  context: KnowledgeIngestContext,
  input: { readonly path: string; readonly sessionId?: string | undefined; readonly allowPrivateHosts?: boolean | undefined },
): Promise<KnowledgeBatchIngestResult> {
  const content = await readFile(input.path, 'utf-8');
  return ingestKnowledgeWithConnector(context, 'bookmark', content, input.sessionId, input.allowPrivateHosts);
}

export async function importKnowledgeUrlsFromFile(
  context: KnowledgeIngestContext,
  input: { readonly path: string; readonly sessionId?: string | undefined; readonly allowPrivateHosts?: boolean | undefined },
): Promise<KnowledgeBatchIngestResult> {
  const content = await readFile(input.path, 'utf-8');
  return ingestKnowledgeWithConnector(context, 'url-list', content, input.sessionId, input.allowPrivateHosts);
}

export async function ingestKnowledgeBookmarkSeeds(
  context: KnowledgeIngestContext,
  seeds: readonly KnowledgeBookmarkSeed[],
  sessionId?: string,
  sourceType: KnowledgeSourceType = 'bookmark',
  connectorId = 'bookmark',
  allowPrivateHosts?: boolean,
): Promise<KnowledgeBatchIngestResult> {
  const sources: KnowledgeSourceRecord[] = [];
  const errors: string[] = [];
  let imported = 0;
  let failed = 0;
  for (const seed of seeds) {
    try {
      const result = await ingestKnowledgeUrl(context, {
        url: seed.url,
        title: seed.title,
        tags: seed.tags,
        folderPath: seed.folderPath,
        sessionId,
        sourceType,
        connectorId,
        allowPrivateHosts,
        metadata: seed.metadata,
      });
      sources.push(result.source);
      if (result.source.status === 'failed') failed += 1;
      else imported += 1;
    } catch (error) {
      failed += 1;
      errors.push(`${seed.url}: ${summarizeError(error)}`);
    }
  }
  return { imported, failed, sources, errors };
}

export async function ingestKnowledgeWithConnector(
  context: KnowledgeIngestContext,
  connectorId: string,
  input: unknown,
  sessionId?: string,
  allowPrivateHosts?: boolean,
): Promise<KnowledgeBatchIngestResult> {
  const resolved = await context.connectorRegistry.resolve(connectorId, input);
  return ingestKnowledgeBookmarkSeeds(
    context,
    resolved.seeds,
    sessionId,
    resolved.sourceType ?? 'other',
    resolved.connectorId ?? connectorId,
    allowPrivateHosts,
  );
}

export async function ingestKnowledgeConnectorInput(context: KnowledgeIngestContext, input: {
  readonly connectorId: string;
  readonly input?: unknown | undefined;
  readonly content?: string | undefined;
  readonly path?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly allowPrivateHosts?: boolean | undefined;
}): Promise<KnowledgeBatchIngestResult> {
  const connectorId = input.connectorId.trim();
  if (!connectorId) throw new Error('Missing connectorId');
  let resolvedInput: unknown;
  if (Object.hasOwn(input, 'input')) {
    resolvedInput = input.input;
  } else if (typeof input.content === 'string') {
    resolvedInput = input.content;
  } else if (typeof input.path === 'string' && input.path.trim()) {
    resolvedInput = await readFile(input.path, 'utf-8');
  } else {
    throw new Error('Connector ingest requires input, content, or path.');
  }
  return ingestKnowledgeWithConnector(context, connectorId, resolvedInput, input.sessionId, input.allowPrivateHosts);
}

export async function refreshKnowledgeSources(context: KnowledgeIngestContext, sources: readonly KnowledgeSourceRecord[]): Promise<number> {
  let refreshed = 0;
  for (const source of sources) {
    const result = await ingestKnowledgeUrl(context, {
      url: source.sourceUri ?? source.canonicalUri ?? '',
      title: source.title,
      tags: source.tags,
      folderPath: source.folderPath,
      sessionId: source.sessionId,
      sourceType: source.sourceType,
      connectorId: source.connectorId,
      metadata: {
        ...source.metadata,
        refreshedAt: Date.now(),
      },
    });
    if (result.source.status === 'indexed') refreshed += 1;
  }
  return refreshed;
}

export function pickKnowledgeRefreshCandidates(
  context: { readonly store: { listSources(limit: number): KnowledgeSourceRecord[] } },
  mode: 'stale' | 'bookmark',
  explicitIds: readonly string[] | undefined,
  limit = 25,
): KnowledgeSourceRecord[] {
  const max = Math.max(1, limit);
  let sources = context.store.listSources(Number.MAX_SAFE_INTEGER);
  if (explicitIds?.length) {
    const wanted = new Set(explicitIds);
    sources = sources.filter((source) => wanted.has(source.id));
  }
  if (mode === 'bookmark') {
    sources = sources.filter((source) => source.connectorId === 'bookmark' || source.connectorId === 'url-list');
  } else {
    sources = sources.filter((source) => (
      source.status === 'stale'
      || source.status === 'failed'
      || isSourcePastRefreshWindow(source)
    ));
  }
  return sources.filter((source) => isHttpUri(source.sourceUri)).slice(0, max);
}

/** Reserve identity without publishing pending or overwriting an existing source. */
function reserveSourceId(context: KnowledgeIngestContext, canonicalUri: string | undefined): string {
  return (canonicalUri ? context.store.getSourceByCanonicalUri(canonicalUri)?.id : undefined)
    ?? `source-${randomUUID().slice(0, 8)}`;
}

type ExtractionPreparation =
  | { readonly ready: true; readonly token: PreparedKnowledgeExtraction }
  | { readonly ready: false; readonly error: unknown };

/** Operational parse/fetch errors keep their existing failed-record path; holds do not. */
async function capturePreparation(read: () => Promise<PreparedKnowledgeExtraction>): Promise<ExtractionPreparation> {
  try { return { ready: true, token: await read() }; }
  catch (error) {
    if (error instanceof KnowledgeExtractionJudgmentHoldError || error instanceof JudgmentInputError) throw error;
    return { ready: false, error };
  }
}

import { randomUUID } from 'node:crypto';
import type { SQLiteStore } from '../state/sqlite-store.js';
import type { KnowledgeSourceRecord, KnowledgeSourceUpsertInput, KnowledgeExtractionRecord, KnowledgeExtractionUpsertInput } from './types.js';
import { nowMs, stableText, uniq } from './store-schema.js';
import { ensureKnowledgeSpaceMetadata, getExplicitKnowledgeSpaceId, getKnowledgeSpaceId } from './spaces.js';
import { KNOWLEDGE_EXTRACTOR_VERSION } from './extraction-policy.js';

/** Pure normalization shared by ordinary upserts and staged imports. */
export function prepareKnowledgeSourceRecord(input: KnowledgeSourceUpsertInput, existing: KnowledgeSourceRecord | null | undefined): KnowledgeSourceRecord {
    const now = nowMs();
    // n1: `opt` is a local helper that collapses the 18 conditional spread expressions
    // in the record below. Returns `{ [key]: newVal }` when newVal is non-null,
    // falls back to `{ [key]: existingVal }` to preserve existing value on partial
    // update, or `{}` when neither is present.
    function opt<K extends string, V>(key: K, newVal: V | null, existingVal?: V): { [P in K]?: V } {
      if (newVal !== null) return { [key]: newVal } as { [P in K]?: V };
      if (existingVal !== undefined) return { [key]: existingVal } as { [P in K]?: V };
      return {} as { [P in K]?: V };
    }
    const _title = stableText(input.title);
    const _sourceUri = stableText(input.sourceUri);
    const _canonicalUri = stableText(input.canonicalUri);
    const _summary = stableText(input.summary);
    const _description = stableText(input.description);
    const _folderPath = stableText(input.folderPath);
    const _artifactId = stableText(input.artifactId);
    const _contentHash = stableText(input.contentHash);
    const _crawlError = stableText(input.crawlError);
    const _sessionId = stableText(input.sessionId);
    const sourceMetadata = ensureKnowledgeSpaceMetadata({
      ...(existing?.metadata ?? {}),
      ...(input.metadata ?? {}),
    });
    const record: KnowledgeSourceRecord = {
      id: existing?.id ?? input.id ?? `source-${randomUUID().slice(0, 8)}`,
      connectorId: input.connectorId,
      sourceType: input.sourceType,
      ...opt('title', _title),
      ...opt('sourceUri', _sourceUri),
      ...opt('canonicalUri', _canonicalUri),
      ...opt('summary', _summary),
      ...opt('description', _description),
      tags: uniq(input.tags ?? existing?.tags),
      ...opt('folderPath', _folderPath, existing?.folderPath),
      status: input.status,
      ...opt('artifactId', _artifactId, existing?.artifactId),
      ...opt('contentHash', _contentHash, existing?.contentHash),
      ...(typeof input.lastCrawledAt === 'number' ? { lastCrawledAt: input.lastCrawledAt } : existing?.lastCrawledAt ? { lastCrawledAt: existing.lastCrawledAt } : {}),
      ...opt('crawlError', _crawlError, existing?.crawlError && input.status !== 'indexed' ? existing.crawlError : undefined),
      ...opt('sessionId', _sessionId, existing?.sessionId),
      metadata: sourceMetadata,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    return record;
}

export function writeKnowledgeSourceRow(sqlite: SQLiteStore, record: KnowledgeSourceRecord): void {
    sqlite.run(`
      INSERT OR REPLACE INTO knowledge_sources (
        id, connector_id, source_type, title, source_uri, canonical_uri, summary, description,
        tags, folder_path, status, artifact_id, content_hash, last_crawled_at, crawl_error,
        session_id, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      record.id,
      record.connectorId,
      record.sourceType,
      record.title ?? null,
      record.sourceUri ?? null,
      record.canonicalUri ?? null,
      record.summary ?? null,
      record.description ?? null,
      JSON.stringify([...record.tags]),
      record.folderPath ?? null,
      record.status,
      record.artifactId ?? null,
      record.contentHash ?? null,
      record.lastCrawledAt ?? null,
      record.crawlError ?? null,
      record.sessionId ?? null,
      JSON.stringify(record.metadata),
      record.createdAt,
      record.updatedAt,
    ]);
}

export function prepareKnowledgeExtractionRecord(input: KnowledgeExtractionUpsertInput, existing: KnowledgeExtractionRecord | null | undefined, source: KnowledgeSourceRecord | undefined): KnowledgeExtractionRecord {
    const now = nowMs();
    const _artifactId = stableText(input.artifactId);
    const _title = stableText(input.title);
    const _summary = stableText(input.summary);
    const _excerpt = stableText(input.excerpt);
    const mergedExtractionMetadata = {
      ...(existing?.metadata ?? {}),
      ...(input.metadata ?? {}),
      // A freshly written extraction is produced by the current extractor
      // generation, so it carries the current version (an explicit input version
      // wins, e.g. import re-materialization). An advancing version then
      // re-extracts only genuinely older stored captures (Defect 8) without
      // looping on the extractions it just rewrote.
      extractorVersion: typeof input.metadata?.extractorVersion === 'number'
        ? input.metadata.extractorVersion
        : KNOWLEDGE_EXTRACTOR_VERSION,
    };
    const extractionSource = source;
    const extractionMetadata = getExplicitKnowledgeSpaceId({ metadata: mergedExtractionMetadata }) || !extractionSource
      ? mergedExtractionMetadata
      : ensureKnowledgeSpaceMetadata(mergedExtractionMetadata, getKnowledgeSpaceId(extractionSource));
    const record: KnowledgeExtractionRecord = {
      id: existing?.id ?? input.id ?? `extract-${randomUUID().slice(0, 8)}`,
      sourceId: input.sourceId,
      ...(_artifactId !== null ? { artifactId: _artifactId } : existing?.artifactId ? { artifactId: existing.artifactId } : {}),
      extractorId: input.extractorId,
      format: input.format,
      ...(_title !== null ? { title: _title } : existing?.title ? { title: existing.title } : {}),
      ...(_summary !== null ? { summary: _summary } : existing?.summary ? { summary: existing.summary } : {}),
      ...(_excerpt !== null ? { excerpt: _excerpt } : existing?.excerpt ? { excerpt: existing.excerpt } : {}),
      sections: uniq(input.sections ?? existing?.sections),
      links: uniq(input.links ?? existing?.links),
      estimatedTokens: Math.max(0, Number(input.estimatedTokens ?? existing?.estimatedTokens ?? 0)),
      structure: {
        ...(existing?.structure ?? {}),
        ...(input.structure ?? {}),
      },
      metadata: extractionMetadata,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    return record;
}

export function writeKnowledgeExtractionRow(sqlite: SQLiteStore, record: KnowledgeExtractionRecord): void {
    sqlite.run(`
      INSERT OR REPLACE INTO knowledge_extractions (
        id, source_id, artifact_id, extractor_id, format, title, summary, excerpt,
        sections, links, estimated_tokens, structure, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      record.id,
      record.sourceId,
      record.artifactId ?? null,
      record.extractorId,
      record.format,
      record.title ?? null,
      record.summary ?? null,
      record.excerpt ?? null,
      JSON.stringify([...record.sections]),
      JSON.stringify([...record.links]),
      record.estimatedTokens,
      JSON.stringify(record.structure),
      JSON.stringify(record.metadata),
      record.createdAt,
      record.updatedAt,
    ]);
}

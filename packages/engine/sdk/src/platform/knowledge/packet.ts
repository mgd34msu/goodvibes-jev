import type { KnowledgeStore } from './store.js';
import type { KnowledgeSpaceScopeInput } from './spaces.js';
import type { KnowledgePacket, KnowledgePacketDetail, KnowledgePacketItem, KnowledgeSearchResult, KnowledgeUsageRecord } from './types.js';
import { emitKnowledgePacketBuilt } from '../runtime/emitters/index.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { assertJudgmentInput, JudgmentInputError } from '../gate/judgment-input.js';
import { snapshotNodeInput } from './activation/projection.js';
import { KnowledgeEvidenceRelevanceHeldError as Held } from './semantic/evidence-ranking/reader.js';
import { freezeSupport } from './semantic/verification/projection.js';
import { readPublicKnowledgeSelection } from './public-retrieval.js';
import { DEFAULT_PACKET_BUDGET, DEFAULT_PACKET_LIMIT, estimateTokens, renderPacket, renderKnowledgePacketItem } from './shared.js';

export interface KnowledgePacketContext {
  readonly store: KnowledgeStore;
  readonly deferUsage: (input: {
    readonly targetKind: KnowledgeUsageRecord['targetKind'];
    readonly targetId: string;
    readonly usageKind: KnowledgeUsageRecord['usageKind'];
    readonly task?: string | undefined;
    readonly sessionId?: string | undefined;
    readonly score?: number | undefined;
    readonly metadata?: Record<string, unknown> | undefined;
  }) => void;
  readonly emitIfReady: (
    fn: (bus: RuntimeEventBus, ctx: { readonly traceId: string; readonly sessionId: string; readonly source: string }) => void,
    sessionId?: string,
  ) => void;
}

type PacketOptions = { readonly detail?: KnowledgePacketDetail; readonly budgetLimit?: number; readonly signal?: AbortSignal } & KnowledgeSpaceScopeInput;
const RELEVANCE_REASON = 'Selected by the shared semantic relevance reading; legacy retrieval points were not computed';

/** A first lookup awaits a real reading, without a synchronous cold-cache or lexical fallback. */
export async function searchKnowledge(context: KnowledgePacketContext, query: string, limit = 10,
  scope: KnowledgeSpaceScopeInput = {}): Promise<KnowledgeSearchResult[]> {
  const selection = await readPublicKnowledgeSelection(context.store, { query, scope, mode: 'search' });
  selection.assertCurrent();
  const results = selection.accepted.slice(0, Math.max(1, limit)).map((entry): KnowledgeSearchResult => ({
    kind: entry.kind, id: entry.id, score: 0, reason: RELEVANCE_REASON,
    ...(entry.source ? { source: entry.source } : {}), ...(entry.node ? { node: entry.node } : {}),
  }));
  for (const result of results.slice(0, 6)) {
    selection.assertCurrent();
    context.deferUsage({ targetKind: result.kind, targetId: result.id, usageKind: 'search-hit', task: query,
      score: result.score, metadata: { reason: result.reason } });
  }
  return results;
}

export async function buildKnowledgePacket(context: KnowledgePacketContext, task: string, writeScope: readonly string[] = [],
  limit = DEFAULT_PACKET_LIMIT, options: PacketOptions = {}): Promise<KnowledgePacket> {
  const prepared = await preparePacket(context, task, writeScope, limit, options);
  prepared.assertCurrent();
  return prepared.packet;
}

export async function buildKnowledgePromptPacket(context: KnowledgePacketContext, task: string, writeScope: readonly string[] = [],
  limit = DEFAULT_PACKET_LIMIT, options: PacketOptions = {}): Promise<string | null> {
  const prepared = await prepareKnowledgePromptPacket(context, task, writeScope, limit, options);
  return readPreparedKnowledgePromptPacket(prepared, task, writeScope);
}

declare const preparedKnowledgePromptBrand: unique symbol;
/** Opaque request-bound result of an awaited packet reading, never serializable authority. */
export interface PreparedKnowledgePromptPacket { readonly [preparedKnowledgePromptBrand]: true; }
const preparedPrompts = new WeakMap<PreparedKnowledgePromptPacket, {
  readonly task: string;
  readonly writeScope: string;
  readonly prompt: string | null;
  readonly assertCurrent: () => void;
}>();

/** Prepare at an actual asynchronous execution boundary before synchronous layout. */
export async function prepareKnowledgePromptPacket(context: KnowledgePacketContext, task: string, writeScope: readonly string[] = [],
  limit = DEFAULT_PACKET_LIMIT, options: PacketOptions = {}): Promise<PreparedKnowledgePromptPacket> {
  const selection = await preparePacket(context, task, writeScope, limit, options);
  selection.assertCurrent();
  const handle = Object.freeze({}) as PreparedKnowledgePromptPacket;
  preparedPrompts.set(handle, { task, writeScope: JSON.stringify(selection.packet.writeScope),
    prompt: renderPacket(selection.packet.items, selection.packet), assertCurrent: selection.assertCurrent });
  return handle;
}

/** Only a real settled reading for this exact request can enter synchronous composition. */
export function readPreparedKnowledgePromptPacket(prepared: PreparedKnowledgePromptPacket, task: string,
  writeScope: readonly string[] = []): string | null {
  const known = preparedPrompts.get(prepared);
  if (!known) throw new Held('malformed');
  const scopes = snapshotNodeInput(writeScope);
  if (known.task !== task || known.writeScope !== JSON.stringify(scopes)) throw new Held('stale');
  known.assertCurrent();
  return known.prompt;
}

function requestSnapshot(task: string, writeScope: readonly string[], limit: number, options: PacketOptions) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(options)) || Object.getOwnPropertySymbols(options).length) {
    throw new JudgmentInputError('unsupported-input');
  }
  const fields = Object.getOwnPropertyDescriptors(options);
  if (Object.values(fields).some((field) => !('value' in field) || typeof field.value === 'function')) throw new JudgmentInputError('unsupported-input');
  const data = snapshotNodeInput(Object.fromEntries(Object.entries(fields).filter(([key]) => key !== 'signal')
    .map(([key, field]) => [key, field.value]))) as Omit<PacketOptions, 'signal'>;
  const detail = data.detail ?? 'standard';
  if (!['compact', 'standard', 'detailed'].includes(detail) || !Number.isFinite(limit)
    || (data.budgetLimit !== undefined && !Number.isFinite(data.budgetLimit))) throw new Held('malformed');
  const request = snapshotNodeInput({ task, writeScope, limit, options: data });
  assertJudgmentInput({ task: request.task, writeScope: request.writeScope });
  return { request, detail, budgetLimit: Math.max(80, data.budgetLimit ?? DEFAULT_PACKET_BUDGET[detail]),
    signal: fields.signal?.value as AbortSignal | undefined };
}

async function preparePacket(context: KnowledgePacketContext, task: string, writeScope: readonly string[], limit: number, options: PacketOptions) {
  const captured = requestSnapshot(task, writeScope, limit, options);
  const version = JSON.stringify(captured.request);
  const assertRequestCurrent = () => {
    const current = requestSnapshot(task, writeScope, limit, options);
    if (current.signal !== captured.signal || JSON.stringify(current.request) !== version) throw new Held('stale');
    if (captured.signal?.aborted) throw new Held('aborted');
  };
  const selection = await readPublicKnowledgeSelection(context.store, {
    query: task, writeScope: captured.request.writeScope, mode: 'packet',
    scope: { knowledgeSpaceId: captured.request.options.knowledgeSpaceId, includeAllSpaces: captured.request.options.includeAllSpaces },
    ...(captured.signal ? { signal: captured.signal } : {}),
  }, { assertCurrent: assertRequestCurrent });
  const assertCurrent = () => { assertRequestCurrent(); selection.assertCurrent(); };
  assertCurrent();
  const { detail, budgetLimit } = captured;
  const usageCounts = buildUsageCounts(context);
  const candidates: KnowledgePacketItem[] = selection.accepted.map((row) => {
    const related = selection.relatedLabels(row.kind, row.id);
    let summary: string | undefined;
    let evidence: readonly string[];
    if (row.source) {
      const spans = row.spans ?? [];
      // Exact-span readings own meaning. Detail changes layout, never clips an
      // exception or revives a summary that the reader did not select.
      const summaries = spans.filter((span) => ['source.summary', 'source.description', 'extraction.summary'].includes(span.field));
      summary = (detail === 'compact' ? spans : summaries).map((span) => span.text).join('\n\n') || undefined;
      evidence = detail === 'compact' ? [] : spans.filter((span) => !summaries.includes(span)).map((span) => span.text);
    } else {
      summary = row.node?.summary;
      evidence = row.nodeText ? [row.nodeText] : [];
    }
    const item: KnowledgePacketItem = {
      kind: row.kind, id: row.id,
      title: row.source ? row.source.title ?? row.source.canonicalUri ?? row.source.sourceUri ?? row.source.id : row.node!.title,
      ...(summary !== undefined ? { summary } : {}),
      ...(row.source ? { uri: row.source.canonicalUri ?? row.source.sourceUri } : {}),
      reason: RELEVANCE_REASON, score: 0, estimatedTokens: 0, related, evidence,
      metadata: row.source ? { sourceType: row.source.sourceType, status: row.source.status,
        extractionFormat: context.store.getExtractionBySourceId(row.id)?.format, usageCount: usageCounts.get(`source:${row.id}`) ?? 0 }
        : { kind: row.node!.kind, status: row.node!.status, usageCount: usageCounts.get(`node:${row.id}`) ?? 0 },
    };
    return { ...item, estimatedTokens: estimateTokens(renderKnowledgePacketItem(item)) };
  });
  const items: KnowledgePacketItem[] = [];
  let estimatedTokens = 0, droppedForBudget = 0;
  // Preserve whole-item packing after complete semantic reading. The first
  // item is retained even above budget; the rank window applies only here.
  for (const item of candidates.slice(0, Math.max(1, limit * 4))) {
    if (items.length >= Math.max(1, limit)) break;
    if (estimatedTokens + item.estimatedTokens > budgetLimit && items.length > 0) { droppedForBudget++; continue; }
    items.push(item); estimatedTokens += item.estimatedTokens;
  }
  const totalCandidates = candidates.length, droppedCount = totalCandidates - items.length;
  const packet: KnowledgePacket = freezeSupport({ task, writeScope: [...captured.request.writeScope], generatedAt: Date.now(),
    detail, strategy: 'semantic-ranked exact-span packet', budgetLimit, estimatedTokens, items,
    totalCandidates, droppedCount, truncated: droppedCount > 0, droppedForBudget, budgetExhausted: droppedForBudget > 0 });
  assertCurrent();
  for (const item of items) {
    assertCurrent();
    context.deferUsage({ targetKind: item.kind, targetId: item.id, usageKind: 'packet-item', task, score: 0,
      metadata: { detail, writeScope: [...packet.writeScope] } });
  }
  assertCurrent();
  context.emitIfReady((bus, ctx) => emitKnowledgePacketBuilt(bus, ctx, { task, itemCount: items.length, estimatedTokens, detail }));
  return { packet, assertCurrent };
}

/** Usage is descriptive metadata and never admits or ranks candidates. */
function buildUsageCounts(context: KnowledgePacketContext): Map<string, number> {
  const counts = new Map<string, number>();
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const record of context.store.listUsageRecords(10_000)) {
    if (record.createdAt < cutoff) continue;
    const key = `${record.targetKind}:${record.targetId}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

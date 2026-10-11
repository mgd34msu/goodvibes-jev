import { captureStrictRepairJson, admitRepairJson } from './web-gap-repair/admission.js';
import { knowledgeSearchStamp, sameKnowledgeRecord } from '../store-record-representation.js';
import { JudgmentInputError } from '../../gate/judgment-input.js';
import { canonicalizeUri } from '../shared.js';
import type { KnowledgeIngestOwnership } from '../ingest-context.js';
import type { KnowledgeSourceType } from '../types.js';
import type { WebSearchRequest, WebSearchResponse, WebSearchResult } from '../../web-search/types.js';
import type { KnowledgeSemanticGapRepairer, KnowledgeSemanticGapRepairRequest, KnowledgeSemanticGapRepairResult } from './types.js';
import { repairProfileSubject } from './repair-profile.js';
import { knowledgeSourceJudgmentUris } from '../source-structural-references.js';
import { uniqueStrings } from './utils.js';
import { freezeSupport } from './verification/projection.js';
import { captureWebGapRepairRequest, ownWebGapRepairResult, registerWebGapRepairer } from './web-gap-repair/ownership.js';
import { createWebGapReadings } from './web-gap-repair/reader.js';
import { KnowledgeWebGapRepairHeldError as Held, WEB_GAP_REPAIR_LIMITS as LIMITS } from './web-gap-repair/types.js';
export { KnowledgeWebGapRepairHeldError } from './web-gap-repair/types.js';
interface GapRepairSearch { search(request: WebSearchRequest): Promise<WebSearchResponse>; }
interface GapRepairIngest {
  ingestUrl(input: {
    readonly url: string; readonly knowledgeSpaceId?: string | undefined; readonly title?: string | undefined;
    readonly tags?: readonly string[] | undefined; readonly sourceType?: KnowledgeSourceType | undefined;
    readonly connectorId?: string | undefined; readonly allowPrivateHosts?: boolean | undefined;
    readonly metadata?: Record<string, unknown> | undefined;
  }, ownership?: KnowledgeIngestOwnership): Promise<{ readonly source: { readonly id: string; readonly status: string } }>;
}
export interface WebGapRepairOptions {
  readonly searchService: GapRepairSearch; readonly ingestService: GapRepairIngest;
  readonly maxResults?: number | undefined; readonly maxSearches?: number | undefined;
  readonly maxSources?: number | undefined; readonly minDistinctDomains?: number | undefined;
  /** Explicit caller policy applied to canonical relevance probability, never a point score. */
  readonly minConfidence?: number | undefined; readonly maxIngest?: number | undefined;
  readonly searchTimeoutMs?: number | undefined; readonly ingestTimeoutMs?: number | undefined;
}
interface Candidate extends WebSearchResult {
  readonly reference: string; readonly searchQuery: string; readonly existingSourceId?: string | undefined;
  readonly confidence: number; readonly authority: 'official-vendor' | 'vendor' | 'secondary';
  readonly relevant: boolean; readonly existingStatus?: string | undefined;
}
const domain = (url: string): string | undefined => { try { const uri = new URL(url); return ['http:', 'https:'].includes(uri.protocol) && !uri.username && !uri.password ? uri.hostname.toLowerCase() : undefined; } catch { return undefined; } };
const policyKeys = ['maxResults', 'maxSearches', 'maxSources', 'minDistinctDomains', 'minConfidence', 'maxIngest', 'searchTimeoutMs', 'ingestTimeoutMs'] as const;
export function createWebKnowledgeGapRepairer(options: WebGapRepairOptions): KnowledgeSemanticGapRepairer {
  return registerWebGapRepairer(request => repair(request, options));
}
async function repair(request: KnowledgeSemanticGapRepairRequest, options: WebGapRepairOptions): Promise<KnowledgeSemanticGapRepairResult> {
  const owned = captureWebGapRepairRequest(request), input = owned.snapshot;
  const searchService = options.searchService, ingestService = options.ingestService, search = searchService.search, ingest = ingestService.ingestUrl;
  const policy = Object.fromEntries(policyKeys.map(key => [key, options[key]]));
  for (const value of Object.values(policy)) if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) throw new Held('malformed');
  if (input.maxSources !== undefined && (!Number.isInteger(input.maxSources) || input.maxSources < 0)) throw new Held('malformed');
  const sourceLimit = Math.max(2, Math.min(5, input.maxSources ?? options.maxSources ?? options.maxIngest ?? 5));
  const searchLimit = Math.max(1, Math.min(5, options.maxSearches ?? 5));
  const minConfidence = Math.max(1, Math.min(100, options.minConfidence ?? 70));
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, ...(owned.signal ? [owned.signal] : [])]);
  const deadlineAt = Math.min(owned.deadlineAt ?? Infinity, Date.now() + LIMITS.timeoutMs);
  const responses: { original: WebSearchResponse; snapshot: WebSearchResponse }[] = [];
  let timedOut = false, finished = false;
  const ownerCurrent = () => {
    if (timedOut || Date.now() >= deadlineAt) throw new Held('budget');
    owned.assertCurrent();
    if (finished || signal.aborted) throw new Held('aborted');
    if (options.searchService !== searchService || options.ingestService !== ingestService || searchService.search !== search || ingestService.ingestUrl !== ingest
      || policyKeys.some(key => options[key] !== policy[key])) throw new Held('stale');
    for (const response of responses) if (!sameKnowledgeRecord(captureStrictRepairJson(response.original), response.snapshot)) throw new Held('stale');
  };
  const reader = createWebGapReadings({ signal, assertCurrent: ownerCurrent });
  const check = () => { ownerCurrent(); reader.assertCurrent(); };
  let rejectStop: (error: Error) => void = () => {};
  const stopped = new Promise<never>((_, reject) => { rejectStop = reject; });
  const abort = () => rejectStop(new Held(timedOut ? 'budget' : 'aborted'));
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(1, deadlineAt - Date.now()));
  const queries: string[] = [], all: Candidate[] = [], ingested: string[] = [], skipped: string[] = [];
  let searched = false;
  const result = (selected: readonly Candidate[], sufficient: boolean, reason?: string): KnowledgeSemanticGapRepairResult => {
    check();
    const selectedRefs = new Set(selected.map(candidate => candidate.reference));
    const acceptedSourceIds = uniqueStrings([...selected.flatMap(candidate => candidate.existingSourceId ? [candidate.existingSourceId] : []), ...ingested]);
    // Result ownership retains original request/configuration/reading captures. Operation
    // cleanup retires pending effects, not the completed receipt consumed by the caller.
    return ownWebGapRepairResult(freezeSupport({ searched, query: queries[0], evidenceSufficient: sufficient, acceptedSourceIds,
      ingestedSourceIds: [...ingested], skippedUrls: [...skipped], sourceAssessments: all.map(candidate => ({
        url: candidate.url, title: candidate.title, domain: domain(candidate.url), rank: candidate.rank, query: candidate.searchQuery,
        accepted: selectedRefs.has(candidate.reference), confidence: candidate.confidence,
        reasons: [candidate.relevant ? 'semantic-relevance' : 'semantic-mismatch', `publisher:${candidate.authority}`, ...(candidate.existingSourceId ? ['already-indexed'] : [])],
        trustReason: `Canonical publisher reading: ${candidate.authority}`,
        ...(!selectedRefs.has(candidate.reference) ? { rejectionReason: candidate.relevant ? 'not-selected' : 'query-mismatch' } : {}),
      })), ...(reason ? { reason } : {}) }), check);
  };
  const run = async () => {
    // No IDs, clocks or arbitrary source metadata are sent. Complete originals have
    // already passed raw-row or ordinary input admission, including rejected rows.
    const subjects = input.linkedObjects.map(repairProfileSubject);
    const context = { purpose: 'knowledge-gap-repair', query: input.query, gaps: input.gaps.map(gap => ({ title: gap.title, summary: gap.summary, reason: gap.metadata.reason })), subjects,
      sources: request.sources.map(source => ({ title: source.title, summary: source.summary, description: source.description, sourceType: source.sourceType, ...knowledgeSourceJudgmentUris(source) })),
      facts: input.facts.map(fact => ({ title: fact.title, summary: fact.summary, value: fact.metadata.value })) };
    reader.preflight(context);
    const subjectText = subjects.map(subject => [subject.title, ...Object.values(subject.identity ?? {})].join(' ')).join('\n');
    // Preserve every original character and field separator. The generic
    // uniqueStrings helper normalizes whitespace/case and is not query identity.
    const queryTexts = [...new Set([input.query, ...input.gaps.map(gap => [gap.title, gap.summary].filter(value => value !== undefined).join('\n'))])].filter(query => query.length > 0);
    const offered = [...new Set(queryTexts.flatMap(query => subjectText ? [query, `${subjectText}\n${query}`] : [query]))];
    // No lexical window: oversize candidate sets hold in full after admission.
    if (offered.length > 30 || input.sources.length > LIMITS.candidates) throw new Held('budget');
    const candidates = offered.map((text, index) => ({ id: `query-${index + 1}`, content: text }));
    const first = await reader.query(context, candidates); check();
    if (!first) return result([], false, 'No grounded web query was selected.');
    const canonical = new Set<string>();
    const assess = async (source: WebSearchResult, searchQuery: string, existingSourceId?: string, existingStatus?: string) => {
      const reference = `source-${all.length + 1}`;
      const reading = await reader.source(context, { title: source.title, snippet: source.snippet, url: source.url,
        claimedDomain: source.domain, evidence: source.evidence, rank: source.rank, searchQuery });
      check(); all.push({ ...source, reference, searchQuery, existingSourceId, existingStatus, ...reading });
    };
    for (const source of input.sources) {
      if ((source.status !== 'indexed' && source.status !== 'pending') || source.tags.includes('generated-page')
        || source.metadata.projectionKind === 'device-passport' || source.metadata.projectionKind === 'room-page') continue;
      const url = source.url ?? source.sourceUri ?? source.canonicalUri;
      if (!url || !domain(url)) continue;
      const key = canonicalizeUri(url); if (!key || canonical.has(key)) continue;
      canonical.add(key);
      await assess({ rank: 0, url, title: source.title, snippet: [source.summary, source.description, ...source.tags].filter(value => value !== undefined).join('\n'),
        type: 'organic', providerId: 'indexed', metadata: {} }, input.query, source.id, source.status);
    }
    // Existing rejected/ineligible URLs cannot be refreshed under the old read receipt.
    for (const source of input.sources) for (const url of [source.url, source.sourceUri, source.canonicalUri]) { const key = canonicalizeUri(url ?? ''); if (key) canonical.add(key); }
    const select = () => {
      const domains = new Set<string>();
      // Declared consumer preference over settled publisher categories, not semantic scoring.
      const authorityOrder = ['official-vendor', 'vendor', 'secondary'];
      return all.filter(candidate => candidate.relevant && candidate.confidence >= minConfidence
          && (candidate.existingStatus !== 'pending' || candidate.authority !== 'secondary'))
        .sort((a, b) => authorityOrder.indexOf(a.authority) - authorityOrder.indexOf(b.authority) || b.confidence - a.confidence || a.rank - b.rank)
        .filter(candidate => { const host = domain(candidate.url)!; if (domains.has(host)) return false; domains.add(host); return true; }).slice(0, sourceLimit);
    };
    const enough = (selected: readonly Candidate[]) => selected.some(candidate => candidate.authority === 'official-vendor')
      || new Set(selected.map(candidate => domain(candidate.url))).size >= Math.max(2, options.minDistinctDomains ?? 2);
    let next: string | undefined = first;
    while (next && queries.length < searchLimit) {
      check(); const query = candidates.find(candidate => candidate.id === next)?.content;
      if (typeof query !== 'string') throw new Held('malformed');
      queries.push(query); searched = true;
      const response = await bounded(() => search.call(searchService, { query, maxResults: Math.max(sourceLimit, Math.min(8, options.maxResults ?? sourceLimit)),
        verbosity: 'snippets', safeSearch: 'moderate', metadata: { purpose: 'knowledge-gap-repair', knowledgeSpaceId: input.spaceId } }), options.searchTimeoutMs ?? 8_000);
      check();
      // Full raw response privacy comes before cap, deduplication, eligibility or projection.
      const snapshot = admitRepairJson(response) as WebSearchResponse;
      responses.push({ original: response, snapshot });
      if (!Array.isArray(snapshot.results) || snapshot.results.length + all.length > LIMITS.candidates) throw new Held('budget');
      for (const source of snapshot.results) {
        if (typeof source.url !== 'string' || typeof source.rank !== 'number' || !Number.isFinite(source.rank)) throw new Held('malformed');
        const key = canonicalizeUri(source.url);
        if (!key || !domain(source.url) || canonical.has(key)) continue;
        canonical.add(key); await assess(source, query);
      }
      if (enough(select())) break;
      const remaining = candidates.filter(candidate => !queries.includes(candidate.content));
      next = remaining.length ? await reader.query(context, remaining) : undefined;
    }
    const selected = select();
    if (!enough(selected)) { skipped.push(...all.filter(candidate => !candidate.existingSourceId).map(candidate => candidate.url)); return result(selected.filter(candidate => candidate.existingSourceId), false, 'Insufficient distinct source-backed evidence was found for gap repair.'); }
    const existingCount = selected.filter(candidate => candidate.existingSourceId).length;
    for (const candidate of selected.filter(candidate => !candidate.existingSourceId).slice(0, Math.max(0, Math.min(sourceLimit - existingCount, options.maxIngest ?? sourceLimit)))) {
      check();
      let committed: string | undefined, effectOpen = true;
      const effectCurrent = () => { if (!effectOpen) throw new Held('stale'); check(); };
      let ingestedResult: { readonly source: { readonly id: string; readonly status: string } };
      try { ingestedResult = await bounded(() => ingest.call(ingestService, {
        url: candidate.url, knowledgeSpaceId: input.spaceId, ...(candidate.title ? { title: candidate.title } : {}),
        sourceType: 'url', connectorId: 'semantic-gap-repair', tags: ['semantic-gap-repair', 'gap-repair', ...uniqueStrings([...input.linkedObjects.flatMap(node => [node.kind, node.title]), ...input.sources.flatMap(source => source.tags)]).slice(0, 12)],
        metadata: { knowledgeSpaceId: input.spaceId, sourceDiscovery: knowledgeSearchStamp({ purpose: 'semantic-gap-repair', query: candidate.searchQuery,
          searchQueries: queries, providerId: candidate.providerId, gapIds: input.gaps.map(gap => gap.id), gapQuestions: input.gaps.map(gap => gap.title),
          originalSourceIds: input.sources.map(source => source.id), linkedObjectIds: input.linkedObjects.map(node => node.id), confidence: candidate.confidence,
          confidenceReasons: ['semantic-relevance', `publisher:${candidate.authority}`], sourceRank: candidate.rank, sourceDomain: domain(candidate.url),
          trustReason: `Canonical publisher reading: ${candidate.authority}`, agreementSourceCount: selected.length, checkedSourceLimit: sourceLimit, selectedUrl: candidate.url }) },
      }, { signal, assertCurrent: effectCurrent, deferSemanticEnrichment: true, onCommitted: id => { committed = id; } }), options.ingestTimeoutMs ?? 10_000);
      } finally { effectOpen = false; }
      check();
      if (committed && committed !== ingestedResult.source.id) throw new Held('stale');
      if (ingestedResult.source.status === 'indexed' || ingestedResult.source.status === 'pending') ingested.push(ingestedResult.source.id);
      else skipped.push(candidate.url);
    }
    return result(selected, true, existingCount + ingested.length ? undefined : 'Gap repair searched but did not accept usable sources.');
  };
  async function bounded<T>(work: () => Promise<T>, timeoutMs: number): Promise<T> {
    check();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => { timeout = setTimeout(() => { timedOut = true; controller.abort(); reject(new Held('budget')); }, Math.min(timeoutMs, Math.max(1, deadlineAt - Date.now()))); });
    try { return await Promise.race([work(), stopped, expired]); }
    finally { clearTimeout(timeout); }
  }
  try { return await Promise.race([run(), stopped]); }
  catch (error) {
    finished = true; controller.abort();
    throw error instanceof Held || error instanceof JudgmentInputError ? error : new Held('unavailable');
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', abort);
    // Keep completed evidence current through the consumer's synchronous receipt checks;
    // errors retire all late asynchronous effects immediately.
  }
}

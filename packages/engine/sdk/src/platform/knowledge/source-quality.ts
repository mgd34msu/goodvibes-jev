import { KnowledgeNodeMutationHeldError } from './store-node-authority.js';
import { KnowledgeGeneratedFactSupportHeldError } from './semantic/verification/types.js';
import { judgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { mapLimit, JudgmentError } from '@goodvibes-jev/judgment';
import { assertJudgmentInput, JudgmentInputError } from '../gate/judgment-input.js';
import { sourceRankingContent } from './semantic/answer-source-ranking.js';
import { pageSourceQuality } from './semantic/ranking/source-quality.js';
import type { KnowledgeSourceRecord } from './types.js';

export interface KnowledgePageSourceQualityPolicy {
  /** Structural provenance flag supplied by the owning projection pipeline. */
  readonly isGeneratedSource?: ((source: KnowledgeSourceRecord) => boolean) | undefined;
  /** What the reference is for; no regex/point policy substitutes for a reading. */
  readonly purpose?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}
export type KnowledgeSourceAuthority = 'official-vendor' | 'vendor' | 'secondary' | 'unverified';
export interface KnowledgePageSourceReading {
  readonly source: KnowledgeSourceRecord;
  readonly useful: boolean;
  readonly probability?: number | undefined;
  readonly authority: KnowledgeSourceAuthority;
  readonly decisionId?: string | undefined;
}
export class KnowledgeSourceQualityHeldError extends Error {
  override readonly name = 'KnowledgeSourceQualityHeldError';
  constructor(readonly reason: 'unsettled' | 'unavailable' | 'no-match' | 'stale' | 'aborted' = 'unsettled') {
    super(reason === 'aborted' ? 'Knowledge source quality reading was cancelled; no source was authorized for use.' : reason === 'stale' ? 'Knowledge source changed during its quality reading; no source was written.' : reason === 'no-match' ? 'No eligible knowledge source supports the requested reference.' : 'Knowledge source quality did not settle; no source was authorized for use.');
  }
}

/** These failures must not be swallowed before downstream knowledge writes. */
export function isKnowledgeSourceQualityFailure(error: unknown): error is Error {
  return error instanceof KnowledgeNodeMutationHeldError || error instanceof KnowledgeGeneratedFactSupportHeldError || error instanceof KnowledgeSourceQualityHeldError || error instanceof JudgmentError || error instanceof JudgmentPortMissingError || error instanceof JudgmentInputError;
}
export interface KnowledgePageSourceCandidate {
  readonly source: KnowledgeSourceRecord;
  readonly existing?: KnowledgeSourceRecord | undefined;
  readonly status?: KnowledgeSourceRecord['status'] | undefined;
}

/** A per-operation reader shares exact readings, never a process-wide semantic cache. */
export function createKnowledgePageSourceReader(policy: KnowledgePageSourceQualityPolicy = {}) {
  const cache = new Map<string, Promise<KnowledgePageSourceReading>>();
  const sourceVersions = new Map<string, string>();
  const throwIfAborted = () => { if (policy.signal?.aborted) throw new KnowledgeSourceQualityHeldError('aborted'); };
  const purpose = policy.purpose ?? 'A grounded factual reference page about the subject described by the source';
  function excluded(source: KnowledgeSourceRecord, status: KnowledgeSourceRecord['status'], existing?: KnowledgeSourceRecord) {
    return (status !== 'indexed' && status !== 'pending') || policy.isGeneratedSource?.(source) || (existing && policy.isGeneratedSource?.(existing));
  }
  function stateFor(source: KnowledgeSourceRecord, existing?: KnowledgeSourceRecord, status = source.status) {
    return { purpose, candidate: sourceRankingContent(source), effectiveStatus: status, ...(existing ? { previous: sourceRankingContent(existing) } : {}) };
  }
  async function read(source: KnowledgeSourceRecord, existing?: KnowledgeSourceRecord, status = source.status): Promise<KnowledgePageSourceReading> {
    throwIfAborted();
    if (excluded(source, status, existing)) return { source, useful: false, authority: 'unverified' };
    const version = JSON.stringify(source);
    const earlier = sourceVersions.get(source.id);
    if (earlier !== undefined && earlier !== version) throw new KnowledgeSourceQualityHeldError('stale');
    sourceVersions.set(source.id, version);
    const state = stateFor(source, existing, status);
    assertJudgmentInput(state);
    const key = JSON.stringify(state);
    let pending = cache.get(key);
    if (!pending) {
      pending = (async () => {
        const run = await pageSourceQuality.run(judgmentPort('engine.knowledge.page-source-quality'), state, { site: 'engine.knowledge.page-source-quality', ...(policy.signal ? { signal: policy.signal } : {}) });
        throwIfAborted();
        const { useful, authority } = run.readings;
        if (useful.outcome !== 'act' || authority.outcome !== 'act') {
          run.recordAction('held: source usefulness or authority unsettled');
          throw new KnowledgeSourceQualityHeldError();
        }
        run.recordAction(useful.verdict === 'yes' ? `source eligible: ${authority.choice}` : 'source excluded: not useful');
        return { source, useful: useful.verdict === 'yes', probability: useful.probability, authority: authority.choice, decisionId: run.result.decisionId };
      })().catch((error: unknown) => {
        if (isKnowledgeSourceQualityFailure(error)) throw error;
        throw new KnowledgeSourceQualityHeldError('unavailable');
      });
      cache.set(key, pending);
    }
    const result = await pending;
    throwIfAborted();
    return { ...result, source };
  }
  async function readCandidates(candidates: readonly KnowledgePageSourceCandidate[]): Promise<KnowledgePageSourceReading[]> {
    throwIfAborted();
    if (candidates.length > 50) throw new JudgmentInputError('unsupported-input');
    assertJudgmentInput(candidates.filter(({ source, existing, status }) => !excluded(source, status ?? source.status, existing)).map(({ source, existing, status }) => stateFor(source, existing, status ?? source.status)));
    return mapLimit(candidates, 4, ({ source, existing, status }) => read(source, existing, status ?? source.status));
  }
  async function rank(sources: readonly KnowledgeSourceRecord[]): Promise<KnowledgePageSourceReading[]> {
    const byId = new Map<string, KnowledgeSourceRecord>();
    for (const source of sources) {
      const previous = byId.get(source.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(source)) throw new KnowledgeSourceQualityHeldError('stale');
      byId.set(source.id, source);
    }
    const unique = [...byId.values()];
    const shortlist = unique.filter((source) => !excluded(source, source.status)).slice(0, 50);
    // Refuse the entire selected batch before any concurrent request starts.
    const readings = await readCandidates(shortlist.map((source) => ({ source })));
    return readings.filter((item) => item.useful).sort((a, b) => b.probability! - a.probability! || a.source.id.localeCompare(b.source.id));
  }
  function assertCurrent(current: (id: string) => KnowledgeSourceRecord | null | undefined): void {
    throwIfAborted();
    for (const [id, version] of sourceVersions) if (JSON.stringify(current(id)) !== version) throw new KnowledgeSourceQualityHeldError('stale');
  }
  return { read, rank, readCandidates, assertCurrent };
}

export async function isUsefulKnowledgePageSource(source: KnowledgeSourceRecord, policy: KnowledgePageSourceQualityPolicy = {}): Promise<boolean> {
  return (await createKnowledgePageSourceReader(policy).read(source)).useful;
}
export async function isUsefulKnowledgePageSourceCandidate(source: KnowledgeSourceRecord, existing: KnowledgeSourceRecord | undefined, status: KnowledgeSourceRecord['status'], policy: KnowledgePageSourceQualityPolicy = {}): Promise<boolean> {
  return (await createKnowledgePageSourceReader(policy).read(source, existing, status)).useful;
}
export async function rankKnowledgePageSources(sources: readonly KnowledgeSourceRecord[], policy: KnowledgePageSourceQualityPolicy = {}): Promise<KnowledgeSourceRecord[]> {
  return (await createKnowledgePageSourceReader(policy).rank(sources)).map((item) => item.source);
}
/** Prefer the batch rank helper when sorting a collection. */
export async function compareKnowledgePageSources(left: KnowledgeSourceRecord, right: KnowledgeSourceRecord, policy: KnowledgePageSourceQualityPolicy = {}): Promise<number> {
  const readings = await createKnowledgePageSourceReader(policy).rank([left, right]);
  const probabilities = new Map(readings.map((item) => [item.source.id, item.probability!]));
  return (probabilities.get(right.id) ?? 0) - (probabilities.get(left.id) ?? 0) || left.id.localeCompare(right.id);
}
export async function knowledgePageSourceWeight(source: KnowledgeSourceRecord, policy: KnowledgePageSourceQualityPolicy = {}): Promise<number> {
  const reading = await createKnowledgePageSourceReader(policy).read(source);
  return reading.useful ? reading.probability! : 0;
}
export async function readKnowledgeSourceAuthority(source: KnowledgeSourceRecord, policy: KnowledgePageSourceQualityPolicy = {}): Promise<KnowledgeSourceAuthority> {
  return (await createKnowledgePageSourceReader(policy).read(source)).authority;
}

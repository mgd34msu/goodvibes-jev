import { estimateTokens, hashState, LIMITS, type JudgmentPort } from '@goodvibes-jev/judgment';
import type { UnitEvidence } from './evidence.js';
import { sourceCitationPurpose } from './batteries/source-citation-purpose.js';
import type { JudgmentUsage } from './types.js';

const caches = new WeakMap<object, Map<string, boolean>>();
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const citations = (path: string, text: string): [number, number][] => [...text.matchAll(
  new RegExp('(?<![\\w./-])' + escape(path) + '(?::|#L)(\\d+)(?:[-–]L?(\\d+))?', 'g'),
)].map(match => [Number(match[1]), Number(match[2] ?? match[1])]);

/** Keep every observation and the full report. Only receipt-only source
 * quotations are removed from the check's view; raw evidence stays on the unit.
 */
export async function selectSourceCitationEvidence(owner: object, evidence: UnitEvidence, port: JudgmentPort, signal?: AbortSignal): Promise<{ evidence: UnitEvidence; usage: JudgmentUsage }> {
  const usage: JudgmentUsage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  if (!evidence.sourceReads?.length || estimateTokens(evidence.sourceReads) < LIMITS.maxStateWithQuestionTokens) return { evidence, usage };
  const paragraphs = evidence.output.split(/\n\s*\n/);
  const cited = evidence.sourceReads.filter(read => read.contentKind === 'cited-source' && read.returnedContent);
  const cache = caches.get(owner) ?? new Map<string, boolean>(); caches.set(owner, cache);
  const receiptOnly = await Promise.all(paragraphs.map(async paragraph => {
    if (!cited.some(read => citations(read.path, paragraph).length)) return false;
    const key = hashState({ report: evidence.output, paragraph });
    if (cache.has(key)) return cache.get(key)!;
    const read = await sourceCitationPurpose.run(port, { report: evidence.output, paragraph }, { site: 'contract.check.source-citation-purpose', ...(signal === undefined ? {} : { signal }) });
    usage.calls++; usage.inputTokens += read.result.usage?.inputTokens ?? 0; usage.outputTokens += read.result.usage?.outputTokens ?? 0;
    const onlyReceipts = read.readings.receipt_only.verdict === 'yes' && read.readings.receipt_only.outcome === 'act';
    read.recordAction(onlyReceipts ? 'retain-read-scope-without-receipt-quotations' : 'retain-primary-source-quotations');
    cache.set(key, onlyReceipts);
    return onlyReceipts;
  }));
  if (!receiptOnly.some(Boolean)) return { evidence, usage };
  const claimText = paragraphs.filter((_, index) => !receiptOnly[index]).join('\n\n');
  const sourceReads = evidence.sourceReads.map(read => {
    if (read.contentKind !== 'cited-source' || !read.returnedContent) return read;
    const ranges = citations(read.path, claimText);
    const rows = read.returnedContent.split('\n').filter(row => {
      const match = /^[ \t]*(\d+) \|/.exec(row), line = Number(match?.[1]);
      return match && ranges.some(([start, end]) => line >= start && line <= end);
    });
    const { returnedContent: _contents, contentKind: _kind, ...scope } = read;
    return rows.length ? { ...scope, returnedContent: rows.join('\n'), contentKind: 'cited-source' as const } : scope;
  });
  return { evidence: { ...evidence, sourceReads }, usage };
}

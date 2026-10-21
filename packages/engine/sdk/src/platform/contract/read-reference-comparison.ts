import type { SourceReadEvidence } from './evidence.js';
import { hashState, type JsonValue } from '@goodvibes-jev/judgment';
import { compactJsonReference } from './json-reference.js';

type Interval = [number, number];
type ObservedReadScope = Omit<SourceReadEvidence, 'returnedLines'> & { readonly returnedLines?: number };
type ObservationSource = { source: string; reads: readonly ObservedReadScope[] };

function merge(ranges: readonly Interval[]): Interval[] {
  const result: Interval[] = [];
  for (const [start, end] of [...ranges].sort(([a], [b]) => a - b)) {
    const last = result.at(-1);
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else result.push([start, end]);
  }
  return result;
}

function intervals(text: string): Interval[] {
  return merge(text.split(',').flatMap(value => {
    const match = /^\s*(\d+)(?:[-–]L?(\d+))?\s*$/.exec(value);
    if (!match) return [];
    const start = Number(match[1]), end = Number(match[2] ?? match[1]);
    return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start > 0 && end >= start ? [[start, end] as Interval] : [];
  }));
}

function subtract(expected: readonly Interval[], observed: readonly Interval[]): Interval[] {
  const missing: Interval[] = [];
  for (const [start, end] of expected) {
    let next = start;
    for (const [first, last] of observed) {
      if (last < next) continue;
      if (first > end) break;
      if (first > next) missing.push([next, Math.min(first - 1, end)]);
      next = Math.max(next, last + 1);
      if (next > end) break;
    }
    if (next <= end) missing.push([next, end]);
  }
  return missing;
}

/** Compare literal references with actual host observations. Parsing a citation
 * does not decide whether it is an obligation or whether the review is good. */
export function compareReadReferences(contexts: readonly { field: string; text: string }[], reads: readonly ObservedReadScope[],
  sources?: readonly ObservationSource[]) {
  const references = new Map<string, { path: string; ranges: Interval[]; mentions: { field: string; literal: string }[] }>();
  for (const context of contexts) {
    const pattern = /(?<![\w./-])((?:\/?[\w@.+-]+\/)*[\w@.+-]+\.[A-Za-z0-9]+)(?::|#L)(\d+(?:[-–]L?\d+)?(?:,\s*\d+(?:[-–]L?\d+)?)*)/g;
    for (const match of context.text.matchAll(pattern)) {
      const ranges = intervals(match[2]!);
      if (!ranges.length) continue;
      const key = JSON.stringify([match[1], ranges]);
      const reference = references.get(key) ?? { path: match[1]!, ranges, mentions: [] };
      reference.mentions.push({ field: context.field, literal: match[0] });
      references.set(key, reference);
    }
  }
  return [...references.values()].map(reference => {
    const observed = merge(reads.filter(read => read.path === reference.path).flatMap(read => read.returnedRanges.flatMap(intervals)));
    const missing = subtract(reference.ranges, observed);
    const total = (ranges: readonly Interval[]) => ranges.reduce((count, [start, end]) => count + end - start + 1, 0);
    return { path: reference.path, mentions: reference.mentions, referencedRanges: reference.ranges,
      actualHostReturnedRanges: observed, referencedLines: total(reference.ranges),
      coveredReferencedLines: total(reference.ranges) - total(missing), missingReferencedRanges: missing, missingReferencedLines: total(missing),
      ...(sources === undefined ? {} : { observationSources: sources.flatMap(({ source, reads }) => {
        const matched = reads.filter(read => read.path === reference.path);
        return matched.length ? [{ source, returnedRanges: matched.flatMap(read => [...read.returnedRanges]) }] : [];
      }) }),
      meaning: 'Deterministic interval comparison of these verbatim references with actual retained successful host read observations. Observation sources distinguish current work from passed peer or qualified original-owner work; none is reattributed to this worker. Only referenced intersections count; extra dependency context is not missing work. This establishes returned scope only, not freshness against changed source, which references are mandatory, semantic review quality, test/script execution or native acceptance.',
    };
  });
}

/** Do not let JSON.parse silently discard an earlier duplicate property. */
function uniqueJsonKeys(text: string): boolean {
  const stack: ({ keys: Set<string>; key: boolean } | null)[] = [];
  for (const [token] of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\],]/g)) {
    if (token === '{') stack.push({ keys: new Set(), key: true });
    else if (token === '[') stack.push(null);
    else if (token === '}' || token === ']') stack.pop();
    else {
      const frame = stack.at(-1);
      if (!frame) continue;
      if (token === ',') frame.key = true;
      else if (token.startsWith('"') && frame.key) {
        const key = JSON.parse(token) as string;
        if (frame.keys.has(key)) return false;
        frame.keys.add(key); frame.key = false;
      }
    }
  }
  return true;
}

/** Arithmetic over literal path/ranges objects in complete byte-bound JSON.
 * This neither declares those references mandatory nor approves their review. */
export function compareJsonReadReferences(reads: readonly SourceReadEvidence[], currentFiles: readonly JsonValue[],
  observations: readonly ObservationSource[]) {
  const seen = new Map<string, Interval[]>();
  for (const source of observations) for (const read of source.reads) {
    seen.set(read.path, [...(seen.get(read.path) ?? []), ...read.returnedRanges.flatMap(intervals)]);
  }
  const observed = new Map([...seen].map(([path, ranges]) => [path, merge(ranges)]));
  return reads.flatMap(read => {
    const projected = compactJsonReference(read, currentFiles);
    if (!('referenceProjection' in projected) || !uniqueJsonKeys(projected.returnedContent!)) return [];
    const groups: { reference: string; arrayItems: number; entries: { path: string; ranges: Interval[] }[] }[] = [];
    const pending: { value: unknown; reference: string }[] = [{ value: JSON.parse(projected.returnedContent!), reference: '$' }];
    while (pending.length) {
      const { value, reference } = pending.pop()!;
      if (Array.isArray(value)) {
        const entries = value.flatMap(entry => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.path !== 'string' || !Array.isArray(entry.ranges)
            || !entry.ranges.every((range: unknown) => Array.isArray(range) && range.length === 2
              && range.every(Number.isSafeInteger) && range[0] > 0 && range[1] >= range[0])) return [];
          return [{ path: entry.path as string, ranges: entry.ranges as Interval[] }];
        });
        if (entries.length) groups.push({ reference, arrayItems: value.length, entries });
        for (let index = value.length - 1; index >= 0; index--) pending.push({ value: value[index], reference: `${reference}[${index}]` });
      } else if (value && typeof value === 'object') {
        for (const [key, entry] of Object.entries(value).reverse()) pending.push({ value: entry, reference: `${reference}[${JSON.stringify(key)}]` });
      }
    }
    if (!groups.length) return [];
    return [{ source: 'native-host-interval-comparison', referencePath: read.path,
      referenceSha256: projected.referenceProjection.currentFileSha256,
      originalReturnedContentDigest: projected.referenceProjection.originalReturnedContentDigest,
      observationScopeDigest: hashState(observations.map(({ source, reads }) => ({ source,
        reads: reads.map(({ path, returnedRanges }) => ({ path, returnedRanges: [...returnedRanges] })) }))),
      observationSources: observations.map(({ source, reads }) => ({ source, records: reads.length })),
      groups: groups.map(group => {
        const expected = new Map<string, Interval[]>();
        for (const entry of group.entries) expected.set(entry.path, [...(expected.get(entry.path) ?? []), ...entry.ranges]);
        let referencedLines = 0, missingLines = 0;
        const missing = [...expected].flatMap(([path, ranges]) => {
          const merged = merge(ranges), residual = subtract(merged, observed.get(path) ?? []);
          referencedLines += merged.reduce((n, [a, b]) => n + b - a + 1, 0);
          missingLines += residual.reduce((n, [a, b]) => n + b - a + 1, 0);
          return residual.length ? [{ path, ranges: residual }] : [];
        });
        return { reference: group.reference, arrayItems: group.arrayItems, literalRecords: group.entries.length, paths: expected.size,
          referencedLines, coveredReferencedLines: referencedLines - missingLines, missingReferencedLines: missingLines, missing };
      }),
      meaning: 'Actual host computation over literal path/ranges data in this complete returned JSON reference, whose original bytes match the current file SHA256. Inclusive per-path interval unions and subtraction use the explicitly attributed retained successful observations. This proves numeric returned scope for recognized reference objects only, not their status as requirements, fresh reads by this worker, semantic assessments, test/script execution, unchanged source contents or native acceptance. Original reference text and observations remain retained unchanged.' }];
  });
}

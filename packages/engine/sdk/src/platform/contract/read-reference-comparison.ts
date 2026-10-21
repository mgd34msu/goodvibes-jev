import type { SourceReadEvidence } from './evidence.js';

type Interval = [number, number];

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
export function compareReadReferences(contexts: readonly { field: string; text: string }[], reads: readonly SourceReadEvidence[]) {
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
      meaning: 'Deterministic interval comparison of these verbatim references with actual retained successful host read observations. Only referenced intersections count; extra dependency context is not missing work. This establishes returned scope only, not which references are mandatory, semantic review quality, test execution or native acceptance.',
    };
  });
}

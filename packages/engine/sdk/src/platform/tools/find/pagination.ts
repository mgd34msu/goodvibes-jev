import type { OutputOptions } from './shared.js';

/** Pagination limits output, never search coverage or the reported total. */
export function paginateFindResult(result: Record<string, unknown>, output: OutputOptions): Record<string, unknown> {
  if (result.error || output.format === 'count_only') return result;
  const key = ['files', 'locations', 'matches', 'symbols'].find(key => result[key] !== undefined);
  if (!key) return result;
  const value = result[key];
  const grouped = !Array.isArray(value) && value !== null && typeof value === 'object';
  const groups = grouped ? Object.entries(value as Record<string, unknown[]>) : undefined;
  const rows: unknown[] = groups ? groups.flatMap(([, rows]) => rows) : value as unknown[];
  if (!Array.isArray(rows)) return result;
  const offset = output.offset ?? 0;
  const limit = output.max_total_matches ?? output.max_results ?? 100;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 0) return { error: 'Pagination offset and page size must be nonnegative integers' };
  const perFile = output.max_per_item;
  if (perFile !== undefined && (!Number.isSafeInteger(perFile) || perFile < 0)) return { error: 'max_per_item must be a nonnegative integer' };
  const counts = new Map<string, number>();
  const eligible = perFile === undefined || key === 'files' ? rows : rows.filter(row => {
    const file = row && typeof row === 'object' ? (row as { file?: string }).file : undefined;
    if (file === undefined) return true;
    const count = counts.get(file) ?? 0;
    counts.set(file, count + 1);
    return count < perFile;
  });
  const page = eligible.slice(offset, offset + limit);
  if (offset === 0 && page.length === rows.length) return result;
  const selected = new Set(page);
  const displayed = groups ? Object.fromEntries(groups.map(([name, rows]) => [name, rows.filter(row => selected.has(row))]).filter(([, rows]) => (rows as unknown[]).length)) : page;
  const hasMore = offset + page.length < eligible.length;
  return {
    ...result, [key]: displayed, total: result.count ?? rows.length, returned: page.length,
    offset, has_more: hasMore,
    ...(hasMore && page.length > 0 ? { next_offset: offset + page.length } : {}),
    ...(eligible.length < rows.length ? { omitted_by_per_file_limit: rows.length - eligible.length } : {}),
    ...(result.relationships && typeof result.relationships === 'object' ? { relationships: Object.fromEntries(Object.entries(result.relationships).filter(([file]) => page.some(row => row && typeof row === 'object' && (row as { file?: string }).file === file))) } : {}),
  };
}

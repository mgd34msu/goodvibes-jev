/**
 * read-access.ts, a small shared seam that lets search / list / map tools apply
 * the SAME read-permission decision the read tool gets, per candidate file.
 *
 * The single source of truth is the injected {@link ReadAccessFilter}, wired at
 * the composition root to `PermissionManager.readAccess`, which asks Jev whether
 * a read of the file touches secret or credential material. Tools MUST use this
 * filter rather than re-implementing any path matching, so a read the gate would
 * hold behind an ask can never be bypassed by a search that returns content, and
 * can never drift from a parallel matcher. Tools apply it only to the files whose
 * content they are about to surface, so a large search does not read every
 * candidate.
 *
 * Two enforcement shapes, matching the read tool's contract:
 *   - CONTENT results (grep match text, previews, extracted exports/symbols): a
 *     restricted file's content NEVER appears.
 *   - Path-only listings: the path is still shown but flagged access-restricted
 *     (hiding existence would be dishonest; exposing content is the real leak).
 *
 * Either way the result metadata carries a count of how many results were
 * withheld, the same "names shown, values withheld" idiom as withheld_env.
 */

/** Resolves true when a read of `absolutePath` is currently allowed (content may be shown). */
export type ReadAccessFilter = (absolutePath: string) => Promise<boolean>;

/** A filter that allows everything, the default when no permission seam is wired. */
export const ALLOW_ALL_READ_ACCESS: ReadAccessFilter = async () => true;

/** How many read-access decisions run at once. */
const READ_ACCESS_CONCURRENCY = 8;

/** Split items into content-allowed vs access-restricted by their path, in order. */
export async function partitionByReadAccess<T>(
  items: readonly T[],
  pathOf: (item: T) => string,
  filter: ReadAccessFilter | undefined,
): Promise<{ allowed: T[]; restricted: T[] }> {
  if (!filter) return { allowed: [...items], restricted: [] };
  const verdicts: boolean[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      verdicts[index] = await filter(pathOf(items[index]!));
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_ACCESS_CONCURRENCY, items.length) }, worker));
  const allowed: T[] = [];
  const restricted: T[] = [];
  items.forEach((item, index) => (verdicts[index] ? allowed : restricted).push(item));
  return { allowed, restricted };
}

/**
 * The metadata note for withheld results, or null when nothing was withheld.
 * Phrasing mirrors the withheld_env "N …" idiom so surfaces read consistently.
 */
export function accessRestrictedNote(restrictedCount: number): string | null {
  if (restrictedCount <= 0) return null;
  return `${restrictedCount} result${restrictedCount === 1 ? '' : 's'} in access-restricted file${restrictedCount === 1 ? '' : 's'}`;
}

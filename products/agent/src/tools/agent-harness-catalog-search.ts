/**
 * agent-harness-catalog-search.ts, how every agent_harness catalog decides
 * that a query matched.
 *
 * Each catalog used to answer this question on its own, and they answered it
 * the same wrong way: take the caller's words, lowercase them, and look for
 * that ONE CONTIGUOUS STRING in the entry's text (the settings catalog and the
 * slash-command catalog), or require every word to appear (the mode and model
 * tool catalogs). Both rules make a plain-English question come back empty. A
 * model asking a settings catalog of 572 keys for "spending limit" or "credit
 * card" got `{"settings": [], "total": 0}`, no key's description happens to
 * contain either phrase, and read it as a platform with no payment settings at
 * all, while `payments.budget.dailyItem` sat in the schema the whole time.
 *
 * The rule here is two-tier, and the order is the point:
 *
 *  1. STRICT, the whole phrase appears, or every word appears somewhere. This
 *     is exactly what the catalogs did before, so a query that found something
 *     yesterday finds the same set today. Widening the primary rule would have
 *     changed every existing answer, and a search that returns more for a query
 *     that already worked is a regression dressed as an improvement.
 *
 *  2. RELAXED, only when the strict pass found NOTHING, and only for a query
 *     of more than one word: any single word of the query is enough. The
 *     alternative to a loose answer here is an empty one, and an empty catalog
 *     page is read as "this platform cannot do that". The caller is told the
 *     match was loose (see `relaxed`) so nothing pretends the phrase was found.
 *
 * Ranking stays with each catalog: only it knows whether a hit on an id
 * outweighs a hit on a description.
 */

/** Query words, split on anything that is not a letter or digit. */
export function catalogSearchTokens(input: string): readonly string[] {
  return input.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 0);
}

/** The whole phrase appears, or every word of it does. */
export function catalogTextMatches(text: string, query: string): boolean {
  const normalized = query.toLowerCase().trim();
  if (normalized.length === 0) return true;
  const haystack = text.toLowerCase();
  if (haystack.includes(normalized)) return true;
  const tokens = catalogSearchTokens(normalized);
  return tokens.length > 0 && tokens.every((token) => haystack.includes(token));
}

/** Any one word of the query appears. Only ever used as the fallback pass. */
export function catalogTextMatchesAnyWord(text: string, query: string): boolean {
  const tokens = catalogSearchTokens(query);
  if (tokens.length === 0) return true;
  const haystack = text.toLowerCase();
  return tokens.some((token) => haystack.includes(token));
}

export interface CatalogSearchResult<T> {
  /** Matching entries, in the order they were given. */
  readonly matches: readonly T[];
  /** True when these came from the relaxed pass: single words, not the phrase. */
  readonly relaxed: boolean;
}

/**
 * Runs the strict pass, then the relaxed one if the strict pass came back
 * empty. An empty query matches everything, as every catalog already assumed.
 */
export function searchCatalog<T>(
  entries: readonly T[],
  query: string,
  searchText: (entry: T) => string,
): CatalogSearchResult<T> {
  const normalized = query.toLowerCase().trim();
  if (normalized.length === 0) return { matches: entries, relaxed: false };

  const strict = entries.filter((entry) => catalogTextMatches(searchText(entry), normalized));
  if (strict.length > 0) return { matches: strict, relaxed: false };

  // Only a real phrase relaxes, and "real" means words the caller separated
  // with spaces. Splitting on punctuation instead would make `zzz-no-such-tool`
  // a four-word query that relaxes to its `tool` fragment and answers with
  // dozens of tools, a made-up identifier turned into a page of near misses.
  // One word, however it is punctuated, gets the honest empty answer.
  if (normalized.split(/\s+/).filter(Boolean).length < 2) return { matches: strict, relaxed: false };

  const relaxed = entries.filter((entry) => catalogTextMatchesAnyWord(searchText(entry), normalized));
  return { matches: relaxed, relaxed: relaxed.length > 0 };
}

/** The sentence a page appends when its rows came from the relaxed pass. */
export const RELAXED_MATCH_NOTE =
  'No entry matched that whole phrase, so these matched single words from it, read them as near misses, not exact answers.';

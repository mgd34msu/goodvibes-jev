import type { AgentHarnessToolArgs } from './agent-harness-tool-types.ts';
import { RELAXED_MATCH_NOTE } from './agent-harness-catalog-search.ts';

export function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function settingLookupArgs(args: AgentHarnessToolArgs) {
  return {
    key: readString(args.key) || undefined,
    target: readString(args.target) || undefined,
    query: readString(args.query) || undefined,
    category: readString(args.category) || undefined,
    prefix: readString(args.prefix) || undefined,
    includeHidden: args.includeHidden === true,
  };
}

/**
 * Reads a caller-supplied page size, bounded by a ceiling.
 *
 * `max` defaults to 500 because that suits the small catalogs, but a surface
 * whose catalog can outgrow it must pass its own, a ceiling below the catalog
 * silently drops the tail. Whatever ceiling applies, the caller of this
 * function still owes the response a `returned`/`total` pair (see
 * {@link catalogEnvelope}); clamping quietly is the failure this parameter
 * exists to make impossible to reach by accident.
 */
export function readLimit(value: unknown, fallback: number, max = 500): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return Math.max(1, Math.min(max, fallback));
  return Math.max(1, Math.min(max, Math.trunc(parsed)));
}


export function readFieldMap(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, typeof entry === 'string' ? entry : String(entry)]));
}

/** Filter arguments a catalog query applied, by argument name. */
export type CatalogFilters = Readonly<Record<string, string | undefined>>;

/**
 * Builds the `{ <key>: [...], returned, total }` envelope every catalog mode
 * returns, and makes an empty page explain itself.
 *
 * A catalog used to answer `{"actions": [], "returned": 0, "total": 463}`, it
 * reported that hundreds of entries exist and named none of them, and it never
 * echoed the filter that had excluded them. A caller who passed, say,
 * `category:"actions"` (matching no category) could not tell its own argument
 * was the cause, so the only way forward was to guess repeatedly. The envelope
 * now always echoes the filters it applied, and when a page comes back empty it
 * says why and what to send instead.
 *
 * @param key      - Field name holding the page (e.g. 'actions', 'tools').
 * @param items    - The page itself.
 * @param total    - How many entries exist in the whole catalog.
 * @param filters  - Filter arguments that were applied, by argument name.
 * @param discovery - Route that lists everything, quoted in the guidance.
 */
/**
 * Collects the named filter arguments a catalog query received, dropping the
 * ones that were not supplied, ready for {@link catalogEnvelope}.
 */
export function catalogFilters(
  args: object,
  names: readonly string[],
): CatalogFilters {
  const source = args as Readonly<Record<string, unknown>>;
  const filters: Record<string, string> = {};
  for (const name of names) {
    const value = readString(source[name]);
    if (value) filters[name] = value;
  }
  return filters;
}

/**
 * The other catalogs a query could be asked of, quoted when one comes back
 * empty.
 *
 * A capability lives on exactly one of these surfaces, and the model has no way
 * to know which before it looks. Asking `mode:"tools"` for "payment" returns
 * nothing, correctly, there is no payments tool, and that empty page was read
 * as "this platform cannot take a payment", while a `payments.*` settings
 * section and a `/payments` command sat one mode away. An empty page now says
 * where else to look.
 */
const SIBLING_CATALOG_ROUTES = 'agent_harness mode:"settings"|"commands"|"workspace_actions"|"tools"|"modes"';

export interface CatalogEnvelopeOptions {
  /** Rows matched single words from the query, not the phrase itself. */
  readonly relaxedQuery?: boolean;
}

export function catalogEnvelope(
  key: string,
  items: readonly unknown[],
  total: number,
  filters: CatalogFilters = {},
  discovery?: string,
  options: CatalogEnvelopeOptions = {},
): Record<string, unknown> {
  const applied = Object.entries(filters)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0);

  const searched = applied.some(([name]) => name === 'query' || name === 'target');
  const elsewhere = searched
    ? ` A capability may live on another surface: ${SIBLING_CATALOG_ROUTES} each search a different one.`
    : '';

  const envelope: Record<string, unknown> = {
    [key]: items,
    returned: items.length,
    total,
    ...(applied.length > 0 ? { appliedFilters: Object.fromEntries(applied) } : {}),
    ...(options.relaxedQuery ? { queryMatch: 'relaxed' } : {}),
  };

  // An empty catalog still owes the reader a sentence, and that sentence is not
  // about the filter: `total` is the catalog's own size (which the settings
  // page finally reports), so zero here means the catalog holds nothing and no
  // other arguments would change that. It used to return with three bare
  // fields, and `{"x": [], "returned": 0, "total": 0}` as a whole answer is the
  // shape a reader takes for "this platform cannot do that".
  if (total === 0) {
    envelope.note = `This catalog holds no ${key} at all, so no argument emptied this page.${elsewhere}`;
    return envelope;
  }

  // A SHORTENED page discloses that it is short.
  //
  // This envelope used to say nothing whenever it returned any rows at all, on
  // the reasoning that a populated page speaks for itself. It does not: "here
  // are 20 of 300" read as a complete answer is the same failure as an empty
  // page read as "no such capability", just in slower motion. `returned` and
  // `total` were always both present, but a number two fields away is easy to
  // miss in a way a sentence is not.
  const relaxedNote = options.relaxedQuery ? ` ${RELAXED_MATCH_NOTE}` : '';

  if (items.length > 0) {
    if (items.length >= total && !options.relaxedQuery) return envelope;
    const shownFilters = applied.map(([name, value]) => `${name}="${value}"`).join(', ');
    if (items.length >= total) {
      envelope.note = `Showing all ${total} ${key}.${relaxedNote}`;
      return envelope;
    }
    envelope.note = `Showing ${items.length} of ${total} ${key}. `
      + (shownFilters
        ? `This is a filtered view (${shownFilters}), not the full catalog`
        : 'This is a partial view, not the full catalog')
      + `${discovery ? `; re-send as ${discovery} to see everything` : ''}.${relaxedNote}`;
    return envelope;
  }

  const shown = applied.map(([name, value]) => `${name}="${value}"`).join(', ');
  envelope.note = applied.length > 0
    ? `No ${key} matched ${shown}. ${total} ${key} exist in this catalog`
      + `${discovery ? `; re-send as ${discovery} to list them all` : '; re-send without that filter to list them all'}`
      + `, or supply a different value.${elsewhere}`
    : `This catalog reports ${total} ${key} but returned none for these arguments`
      + `${discovery ? `; ${discovery} lists them all` : ''}.`;
  return envelope;
}

export function output(value: unknown): { readonly success: true; readonly output: string } {
  return {
    success: true,
    output: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  };
}

export function error(message: string): { readonly success: false; readonly error: string } { return { success: false, error: message }; }

export function requireConfirmedAction(args: AgentHarnessToolArgs, action: string): string | null {
  const explicitUserRequest = readString(args.explicitUserRequest);
  if (!explicitUserRequest) return `${action} requires explicitUserRequest with the user's exact request or a short faithful summary.`;
  if (args.confirm !== true) return `${action} requires confirm:true after an explicit user request.`;
  return null;
}

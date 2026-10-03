/**
 * Why a list came back empty.
 *
 * The agent asked for channels and got `{"channels": [], "returned": 0,
 * "total": 14, "enabled": 2, "ready": 2}`, zero rows, alongside a count saying
 * fourteen exist and two are ready. Nothing in that response mentioned that a
 * search term had been applied, or how to see the rest, so the agent read it as
 * "there is nothing here" and told its owner it could not send a message.
 *
 * An inventory that filters must say so in the same breath. This helper is the
 * one place that wording is produced, so every list explains what matched and
 * what it means.
 */

export interface InventoryDisclosureInput {
  /** What the list is of, in plain words: "channels", "model tools". */
  readonly subject: string;
  readonly returned: number;
  readonly total: number;
  /** Filters that were applied. Entries with empty values are ignored. */
  readonly filters: Readonly<Record<string, unknown>>;
  /** The exact call that returns the unfiltered list. */
  readonly listAllRoute: string;
  /** Optional extra facts worth stating, e.g. "2 of them are ready". */
  readonly context?: readonly string[];
}

export interface InventoryDisclosure {
  readonly note: string;
  readonly appliedFilters: Readonly<Record<string, unknown>>;
  readonly listAllRoute: string;
}

function meaningfulFilters(filters: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const applied: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim().length === 0) continue;
    if (typeof value === 'boolean' && !value) continue;
    applied[key] = value;
  }
  return applied;
}

/**
 * The disclosure for a list result, or null when the result speaks for itself.
 *
 * Produced whenever rows were withheld, always for the zero-returned case that
 * caused the incident, and also for a truncated list, because "here are 20 of
 * 300" read as a complete answer is the same failure in slower motion.
 */
export function inventoryDisclosure(input: InventoryDisclosureInput): InventoryDisclosure | null {
  const withheld = input.total - input.returned;
  if (withheld <= 0) return null;
  const applied = meaningfulFilters(input.filters);
  const filterText = Object.entries(applied)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? `"${value}"` : String(value)}`)
    .join(', ');

  const opening = input.returned === 0
    ? `No ${input.subject} matched, but ${String(input.total)} exist.`
    : `Showing ${String(input.returned)} of ${String(input.total)} ${input.subject}.`;
  const cause = filterText
    ? `This is a filtered view (${filterText}), not the full inventory.`
    : 'This is a partial view, not the full inventory.';
  const extra = input.context && input.context.length > 0 ? ` ${input.context.join(' ')}` : '';

  return {
    note: `${opening} ${cause}${extra} An empty or short result here does not mean the capability is absent, call ${input.listAllRoute} to see everything.`,
    appliedFilters: applied,
    listAllRoute: input.listAllRoute,
  };
}

/** Merges a disclosure into a list payload, adding nothing when there is nothing to say. */
export function withInventoryDisclosure(
  payload: Record<string, unknown>,
  input: InventoryDisclosureInput,
): Record<string, unknown> {
  const disclosure = inventoryDisclosure(input);
  if (!disclosure) return payload;
  return {
    ...payload,
    filtered: true,
    note: disclosure.note,
    appliedFilters: disclosure.appliedFilters,
    listAllRoute: disclosure.listAllRoute,
  };
}

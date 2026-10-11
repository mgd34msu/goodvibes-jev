import type { ProfilePersonReadingOptions } from '../owner-profile/person-reading.js';
/**
 * reader.ts, the profile, read as occasions and plans.
 *
 * One direction only. This module reads the owner's file and types what it
 * finds; nothing here writes, and nothing here takes a date from anywhere other
 * than the owner's file. That is the §6 rule made structural: a calendar entry is a
 * single occurrence of an ephemeral thing, and sourcing an occasion from one
 * would give the wrong recurrence and lose the fact the moment the event passed.
 * There is no calendar-shaped input to this module, so there is no path to get
 * it wrong later.
 *
 * The reader is also where CONFLICTS are found. The profile already preserves
 * every line the owner wrote, so two different dates for the same thing are both
 * sitting in the document; taking the newer one silently would be the one
 * behaviour explicitly ruled out. Both are reported, and the conflict becomes an
 * open item that is raised now and raised again if it is ignored.
 */
import type { ProfileLine } from '../owner-profile/types.js';
import { renderOccasionDate, type IsoDate } from './dates.js';
import { parseOccasionLine, parsePlanLine } from './grammar.js';
import { OccasionReadingWork } from './readings.js';
import { resolveOccasionSubject } from './subject.js';
import type {
  Occasion,
  OccasionConflict,
  Plan,
  UnparsedOccasionLine,
  UnparsedPlanLine,
} from './types.js';

/**
 * The narrow read surface this module needs from the owner-profile store.
 *
 * Three named methods, no generic section reader: the store deliberately has no
 * "give me any closed section" call and this interface must not become one by
 * accident.
 */
export interface OccasionProfileSource {
  /** Raw prose lines under `## Important dates`. */
  importantDates(): readonly ProfileLine[];
  /** Raw prose lines under `## Plans`. */
  plans(): readonly ProfileLine[];
  /** Profile lines mentioning one person, by name. Opens the interview. */
  person(name: string, options?: ProfilePersonReadingOptions): readonly ProfileLine[] | Promise<readonly ProfileLine[]>;
  /** Captures the actual profile incarnation without exposing closed content. */
  captureRead?(): { readonly assertCurrent: () => void };
  /**
   * What the owner calls THEMSELVES: `identity.name` and `identity.goesBy`.
   *
   * The linkage that lets an entry using the owner's own name be recognised as
   * being about the person whose file this is, without any name literal living
   * in the code. Values they have not declared are simply absent from the list.
   *
   * OPTIONAL, and absent means "no names known" rather than "no match". A
   * narrow embed that does not supply it gets `unattributed` for everything,
   * which is the ordinary cadence, the failure direction that costs the owner a
   * nudge they did not need rather than one they did.
   */
  ownerNames?(): readonly string[];
}

/** Everything the dates section holds, including what did not parse. */
export interface OccasionReadResult {
  readonly occasions: readonly Occasion[];
  readonly unparsed: readonly UnparsedOccasionLine[];
  readonly conflicts: readonly OccasionConflict[];
}

/** Everything the plans section holds. */
export interface PlanReadResult {
  readonly plans: readonly Plan[];
  readonly unparsed: readonly UnparsedPlanLine[];
}

/**
 * Read every occasion, in document order.
 *
 * The FIRST line for an id is the active occasion, matching the profile's own
 * rule for a duplicated mechanical field. A later line for the same id is not
 * dropped: if it names a different date it becomes a conflict, and if it names
 * the same one it is a harmless duplicate that stays in the file and stays
 * visible.
 */
export function readOccasionDeclarations(source: OccasionProfileSource): OccasionReadResult {
  const occasions: Occasion[] = [];
  const unparsed: UnparsedOccasionLine[] = [];
  const byId = new Map<string, Occasion[]>();
  // This structural projection grants only explicit schema attribution.


  for (const line of source.importantDates()) {
    const result = parseOccasionLine(line.lineIndex, line.text);
    if (!result.ok) {
      unparsed.push(result.unparsed);
      continue;
    }
    // Free-form attribution is settled only by the asynchronous reader below.
    const parsed = result.occasion;
    const occasion: Occasion = {
      ...parsed,
      subject: parsed.selfDeclared ? 'owner' : 'unattributed',
    };
    const seen = byId.get(occasion.id);
    if (seen === undefined) {
      byId.set(occasion.id, [occasion]);
      occasions.push(occasion);
    } else {
      seen.push(occasion);
    }
  }

  const conflicts: OccasionConflict[] = [];
  for (const [id, group] of byId) {
    if (group.length < 2) continue;
    const dates = [...new Set(group.map((entry) => renderOccasionDate(entry.date)))];
    if (dates.length < 2) continue;
    conflicts.push({
      occasionId: id,
      title: group[0]?.title ?? id,
      dates,
      lineIndexes: group.map((entry) => entry.lineIndex),
    });
  }

  return { occasions, unparsed, conflicts };
}

/** Semantic attribution used by the live service; capture/removal only need structural declarations. */
export async function readOccasions(source: OccasionProfileSource, work = new OccasionReadingWork()): Promise<OccasionReadResult> {
  const lease = source.captureRead?.();
  if (lease) work.retain(lease.assertCurrent);
  const original = { lines: source.importantDates(), names: source.ownerNames?.() ?? [] };
  const captured = work.snapshot(original);
  const sourceKey = JSON.stringify(captured);
  work.retain(() => { if (JSON.stringify({ lines: source.importantDates(), names: source.ownerNames?.() ?? [] }) !== sourceKey) throw new Error('Occasion source changed.'); });
  const result = readOccasionDeclarations({ ...source, importantDates: () => captured.lines });
  const occasions: Occasion[] = [];
  for (const occasion of result.occasions) {
    // Full lines were screened above. Closed-tier dates never enter model context.
    const subject = await resolveOccasionSubject({ title: occasion.title, person: occasion.person, selfDeclared: occasion.selfDeclared }, captured.names, work);
    occasions.push({ ...occasion, subject });
  }
  work.assertCurrent(); return { ...result, occasions };
}

/** Read every plan, in document order. */
export function readPlans(source: OccasionProfileSource): PlanReadResult {
  const plans: Plan[] = [];
  const unparsed: UnparsedPlanLine[] = [];
  for (const line of source.plans()) {
    const result = parsePlanLine(line.lineIndex, line.text);
    if (result.ok) plans.push(result.plan);
    else unparsed.push(result.unparsed);
  }
  return { plans, unparsed };
}

/** The plan covering `date` that takes the owner away from home, if there is one. */
export function awayPlanOn(plans: readonly Plan[], date: IsoDate): Plan | undefined {
  return plans.find((plan) => plan.away && plan.from <= date && date <= plan.to);
}

/**
 * The next away plan that STARTS on or after `date`, if there is one.
 *
 * Used to move a nudge earlier so it reaches the owner before they leave rather
 * than while they are standing in an airport. Ordered by start date because two
 * overlapping trips would otherwise resolve by document order, which is the
 * order they happened to type them in.
 */
export function nextAwayPlanFrom(plans: readonly Plan[], date: IsoDate): Plan | undefined {
  return plans
    .filter((plan) => plan.away && plan.from >= date)
    .sort((left, right) => (left.from < right.from ? -1 : left.from > right.from ? 1 : 0))[0];
}

/** True when the owner is away on `date`. */
export function isAwayOn(plans: readonly Plan[], date: IsoDate): boolean {
  return awayPlanOn(plans, date) !== undefined;
}

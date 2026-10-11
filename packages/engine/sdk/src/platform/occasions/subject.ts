/** Semantic subject attribution; exact selfDeclared markers remain mechanical. */
import { occasionSubject, occasionEntry, OccasionReadingHeldError, OccasionReadingWork } from './readings.js';
import { normalizeProfileKey } from '../owner-profile/fields.js';
import type { Occasion, OccasionSubject } from './types.js';

/**
 * The words that mark a line as being about the owner himself.
 *
 * Accepted both bare (`· mine ·`) and behind `for` (`· for me ·`), because both
 * are things a person writes and neither is ambiguous with a person's name.
 */
const SELF_WORDS: readonly string[] = ['me', 'myself', 'mine', 'self'];

/** True when a segment, with or without its `for`, declares the owner. */
export function isSelfAttribution(value: string): boolean {
  return SELF_WORDS.includes(normalizeProfileKey(value));
}

/**
 * @deprecated Compatibility-only mechanical parsing utility.
 * This does not establish occasion attribution; use resolveOccasionSubject.
 */
export function possessiveSubject(title: string): string {
  const match = /^(.+?)['’]s\s+\S/.exec(title.trim());
  return (match?.[1] ?? '').trim();
}

/**
 * @deprecated Compatibility-only mechanical parsing utility.
 * This does not establish occasion attribution; use resolveOccasionSubject.
 */
export function ownerAliasSet(declaredNames: readonly string[]): ReadonlySet<string> {
  const aliases = new Set<string>();
  for (const raw of declaredNames) {
    const normalized = normalizeProfileKey(raw);
    if (normalized.length === 0) continue;
    aliases.add(normalized);
    const first = normalized.split(' ')[0] ?? '';
    if (first.length > 0) aliases.add(first);
  }
  return aliases;
}

/** Explicit schema attribution remains authoritative; all prose attribution is a reading. */
export async function resolveOccasionSubject(
  occasion: Pick<Occasion, 'title' | 'person' | 'selfDeclared'>,
  declaredNames: readonly string[],
  work = new OccasionReadingWork(),
): Promise<OccasionSubject> {
  const source = work.snapshot({ occasion, declaredNames });
  if (source.occasion.selfDeclared) return 'owner';
  const result = await work.wait(() => occasionSubject.run(work.port, occasionEntry({ title: source.occasion.title, person: source.occasion.person, declaredNames: source.declaredNames }), { ...(work.signal ? { signal: work.signal } : {}), site: 'engine.occasions.subject' }));
  const reading = result.readings.subject;
  if (reading.outcome !== 'act' || !['owner', 'other', 'unknown'].includes(String(reading.choice))) throw new OccasionReadingHeldError();
  result.recordAction('attributed occasion subject'); work.assertCurrent();
  return reading.choice === 'owner' ? 'owner' : reading.choice === 'other' ? 'other' : 'unattributed';
}

/**
 * Whether this occasion may ever be PUSHED at the owner.
 *
 * One rule, and it is narrow on purpose: something about the owner that they
 * only have to remember is something they already know. Their own birthday,
 * their own anniversary of anything. They do not need a message about it,
 * least of all an hourly one, so nothing is sent, and it stays visible to
 * anything that ASKS what is coming up.
 *
 * The narrowness is the load-bearing part. An occasion about the owner that
 * wants an ACTION, `Renew passport · 2026-11-02 · once · gift-giving` is the
 * shape, and the kind is the thing that says an action is wanted, is not
 * covered, and keeps the ordinary two-boundary cadence. They do not know when
 * their passport expires. They do know when they were born.
 */
export function pushableSubject(
  occasion: Pick<Occasion, 'subject' | 'kind'>,
): boolean {
  return !(occasion.subject === 'owner' && occasion.kind === 'remember-only');
}

/** Why an occasion is not pushed, in words a surface can show the owner. */
export function selfOccasionReason(occasion: Pick<Occasion, 'title'>): string {
  return `${occasion.title} is about you and is one to remember rather than act on, `
    + 'so it is kept and answerable but never sent to you.';
}

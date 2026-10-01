/**
 * owner-profile.ts, the view types and wire readers for the daemon's owner-profile
 * verbs (profile.read / .get / .person / .provenance / .set / .append / .forget / .undo
 * / .status), per docs/owner-profile.md §11.1.
 *
 * BOUND TO THE GENERATED CONTRACT
 * Every shape below is derived from `OperatorMethodOutput<'profile.*'>` in the installed
 * @goodvibes-jev/engine/contracts, not from prose. The `Wire*` aliases at the top ARE the
 * generated types, so a future contract change that alters a field name breaks this file
 * at compile time instead of silently reading `undefined`. The named view types exist for
 * the same reason memory-governance.ts's MemoryGovernanceSnapshot does: the hook, the
 * component and the tests need a name to import, and two of the generated fields are
 * open `string`s this surface must narrow (`state.kind` and `section.tier`).
 *
 * WHY A RUNTIME PARSE SURVIVES THE GENERATED TYPES
 * The generated type is a compile-time promise about a well-behaved daemon; it is not a
 * runtime guarantee. `invokeOperator` performs no schema validation on the wire (its own
 * doc comment says so), so a 200 from an intermediary, an older build, or a proxy can
 * still carry anything. Each reader therefore narrows the body to its generated output
 * type with an explicit `as unknown as Wire…` immediately after an `isRecord` guard, then
 * checks the load-bearing fields before projecting. A body that is not a profile returns
 * null, which the caller renders as an honest error, never an empty profile, and never a
 * crash on `undefined.length`.
 *
 * The alias tolerance the pre-contract version of this file carried (accepting `key` or
 * `id` or `field`, `lines` or `prose` or `bullets`, and so on) is GONE. The names are
 * known now, so guessing at them would only hide a real mismatch.
 *
 * CONTAINMENT (§10, §11.3)
 * Nothing here logs, and nothing here persists. `readProfileStatus` reads state, path,
 * section NAMES, counts and invalid-field reasons, the generated `profile.status` output
 * has no `value` property anywhere, which is what makes that verb safe in a diagnostics
 * bundle, and this reader does not reintroduce one. `sectionHoldsThirdPartyData` marks the
 * `People` section so the rendering surface can keep it out of copy/export affordances.
 */
import type { OperatorMethodOutput } from '@goodvibes-jev/engine/contracts';

// The generated output shapes, named once. profile.set / .append / .forget / .undo all
// answer the same write result, so one alias covers the four.
type WireReadOutput = OperatorMethodOutput<'profile.read'>;
type WireStatusOutput = OperatorMethodOutput<'profile.status'>;
type WireProvenanceOutput = OperatorMethodOutput<'profile.provenance'>;
type WireWriteOutput = OperatorMethodOutput<'profile.set'>;

// ---------------------------------------------------------------------------
// View types
// ---------------------------------------------------------------------------

/**
 * The load state, narrowed from the wire's open `state.kind` string. These three are the
 * states the daemon's own store produces (§4.4, §12); a `kind` outside them means this
 * surface is talking to a build it does not understand, and the readers answer null
 * rather than picking whichever of the three looks closest.
 */
export type ProfileState = 'loaded' | 'disabled' | 'unavailable';

/**
 * Which tier a section belongs to (§11.2), narrowed from the wire's open `tier` string.
 * Open-tier content is injected into the agent's context each turn; closed-tier content
 * is reachable only through a named call, and every read of it is disclosed.
 */
export type ProfileTier = 'open' | 'closed';

/** The provenance suffix a learned line carries (§4.2). All three parts are required by
 *  the contract, a line with no suffix carries no provenance object at all. */
export interface ProfileProvenance {
  readonly surface: string;
  readonly date: string;
  readonly said: string;
}

/** A mechanical field (§4.3). `valid: false` still carries the value, verbatim. */
export interface ProfileField {
  /** The verbs' `fieldId` argument, e.g. `commerce.shippingAddress`. */
  readonly fieldId: string;
  /** The label as written in the document, e.g. `shipping address`. */
  readonly label: string;
  readonly value: string;
  readonly valid: boolean;
  readonly invalidReason?: string;
  readonly provenance?: ProfileProvenance;
}

/** A prose line, a bullet or a paragraph, preserved as written (§4.4). */
export interface ProfileProseLine {
  /**
   * Position in the raw line array. The in-memory model is legitimately positional (§5.1)
   * and this is a stable react key and the document order, so it is kept, but it must
   * NEVER reach a verb. `profile.forget` refuses a `lineIndex` outright (400), because a
   * position taken from an earlier read may be a different line by the time the owner
   * clicks: he edits this file himself, and a settings page left open is exactly where a
   * stale index happens.
   */
  readonly lineIndex: number;
  readonly section: string;
  readonly text: string;
  readonly provenance?: ProfileProvenance;
}

export interface ProfileSection {
  /** The heading text as written, his renames are respected (§4.5). */
  readonly heading: string;
  readonly tier: ProfileTier;
  readonly fields: readonly ProfileField[];
  readonly prose: readonly ProfileProseLine[];
}

/** `profile.read`, the whole document, by section (§8.3), with its load state flattened. */
export interface ProfileDocument {
  readonly state: ProfileState;
  /** Why it could not be read, when state is 'unavailable' (§4.4). */
  readonly reason?: string;
  readonly path: string;
  readonly sections: readonly ProfileSection[];
}

export interface ProfileInvalidField {
  readonly fieldId: string;
  readonly reason: string;
}

/** `profile.status`, the diagnostic answer. State, path, names, counts, reasons. No values. */
export interface ProfileStatus {
  readonly state: ProfileState;
  readonly reason?: string;
  readonly path: string;
  readonly exists?: boolean;
  readonly sections: readonly string[];
  readonly lineCount?: number;
  readonly fieldCount?: number;
  readonly proseLineCount?: number;
  readonly invalidFields: readonly ProfileInvalidField[];
}

/** One `<!-- was: … -->` predecessor (§9.1), what `profile.undo` would promote back. */
export interface ProfileSupersededValue {
  readonly fieldId: string;
  readonly section: string;
  readonly value: string;
  readonly supersededOn: string;
  readonly provenance?: ProfileProvenance;
}

/** `profile.provenance`, surface, date, verbatim, and superseded predecessors (§8.3). */
export interface ProfileProvenanceAnswer {
  readonly fieldId: string;
  /** Whether the field is in the document at all. */
  readonly present: boolean;
  /**
   * True when the field exists but carries no provenance suffix, he wrote or edited it
   * by hand, and §4.2's honest answer is to say so rather than dress it up as a source.
   */
  readonly handEdited: boolean;
  readonly provenance?: ProfileProvenance;
  readonly superseded: readonly ProfileSupersededValue[];
}

/** One thing a write did. Names the field; never repeats the value. */
export interface ProfileChange {
  readonly kind: string;
  readonly fieldId: string | null;
  readonly section: string;
  readonly label: string;
  readonly superseded: boolean;
}

/**
 * What every write verb answers. `ok: false` always carries the daemon's own reason,
 * which is how "there was nothing to forget" and "that write was refused" stay two
 * different sentences without this surface having to guess which one it is looking at.
 */
export interface ProfileWriteOutcome {
  readonly ok: boolean;
  readonly reason?: string;
  readonly changes: readonly ProfileChange[];
  readonly disclosure: string;
}

/**
 * What a mutating verb is being asked about.
 *
 * A mechanical field is addressed by its `fieldId`. A prose line is addressed by its
 * CONTENT, the section it sits in plus its exact text, never by its position (§9.2).
 * The owner is a concurrent writer: he can edit the file in his editor while this page is
 * open, so an index captured at render time may name a different line by the time he
 * clicks. Content addressing degrades honestly instead, matching nothing and removing
 * nothing when the document has moved on.
 *
 * `profile.provenance` and `profile.undo` take a fieldId only, which is why prose lines
 * get neither a lookup nor an undo (§9.1: prose bullets are not superseded).
 */
export type ProfileTarget =
  | { readonly kind: 'field'; readonly fieldId: string }
  | { readonly kind: 'line'; readonly section: string; readonly text: string };

/** The wire input `profile.forget` takes for a target. */
export type ProfileForgetTarget =
  | { readonly fieldId: string }
  | { readonly section: string; readonly text: string };

/**
 * The full `profile.forget` body: a target plus the required authority claim. Narrower
 * than the generated input, which still declares the retired `lineIndex` and makes every
 * property optional, the daemon 400s on a body missing a target, missing an authority, or
 * carrying a lineIndex at all, so this type makes each of those a compile error here
 * rather than a round trip.
 */
export type ProfileForgetInput = ProfileForgetTarget & { readonly authority: string };

// ---------------------------------------------------------------------------
// Primitive readers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

const STATES: readonly ProfileState[] = ['loaded', 'disabled', 'unavailable'];

function readState(kind: unknown): ProfileState | undefined {
  return STATES.find((state) => state === kind);
}

function readTier(tier: unknown): ProfileTier {
  // An unrecognised tier is read as closed. This is the one place a guess is made, and it
  // is made in the containing direction: a section this surface cannot classify is treated
  // as the more protected of the two, never as freely-injected open-tier content.
  return tier === 'open' ? 'open' : 'closed';
}

function readProvenanceValue(value: unknown): ProfileProvenance | undefined {
  if (!isRecord(value)) return undefined;
  const surface = readString(value.surface);
  const date = readString(value.date);
  const said = readString(value.said);
  if (surface === undefined || date === undefined || said === undefined) return undefined;
  return { surface, date, said };
}

// ---------------------------------------------------------------------------
// profile.read
// ---------------------------------------------------------------------------

function readField(value: unknown): ProfileField | null {
  if (!isRecord(value)) return null;
  const fieldId = readString(value.fieldId);
  const label = readString(value.label);
  const text = readString(value.value);
  if (fieldId === undefined || label === undefined || text === undefined) return null;
  const invalidReason = readString(value.invalidReason);
  const provenance = readProvenanceValue(value.provenance);
  return {
    fieldId,
    label,
    value: text,
    valid: value.valid !== false,
    ...(invalidReason !== undefined ? { invalidReason } : {}),
    ...(provenance !== undefined ? { provenance } : {}),
  };
}

function readProseLine(value: unknown): ProfileProseLine | null {
  if (!isRecord(value)) return null;
  const lineIndex = readNumber(value.lineIndex);
  const text = readString(value.text);
  if (lineIndex === undefined || text === undefined) return null;
  const provenance = readProvenanceValue(value.provenance);
  return {
    lineIndex,
    section: readString(value.section) ?? '',
    text,
    ...(provenance !== undefined ? { provenance } : {}),
  };
}

function readSection(value: unknown): ProfileSection | null {
  if (!isRecord(value)) return null;
  const heading = readString(value.heading);
  if (heading === undefined) return null;
  const fields = (Array.isArray(value.fields) ? value.fields : [])
    .map(readField)
    .filter((field): field is ProfileField => field !== null);
  const prose = (Array.isArray(value.prose) ? value.prose : [])
    .map(readProseLine)
    .filter((line): line is ProfileProseLine => line !== null);
  return { heading, tier: readTier(value.tier), fields, prose };
}

/**
 * `profile.read` → the whole document, or null when the answer does not carry one.
 *
 * Null means "render the honest cannot-read state", it is NOT an empty profile, and the
 * distinction is the whole point of §4.4: "I could not open the file" and "I know nothing
 * about you" are different sentences. Sections are dropped for a non-loaded state, so a
 * disabled or unreadable profile can never render content beneath its own banner.
 */
export function readProfileDocument(value: unknown): ProfileDocument | null {
  if (!isRecord(value)) return null;
  const wire = value as unknown as WireReadOutput;
  if (!isRecord(wire.state)) return null;
  const state = readState(wire.state.kind);
  const path = readString(wire.state.path);
  if (state === undefined || path === undefined) return null;
  const reason = readString(wire.state.reason);
  const sections = state === 'loaded'
    ? (Array.isArray(wire.sections) ? wire.sections : [])
      .map(readSection)
      .filter((section): section is ProfileSection => section !== null)
    : [];
  return {
    state,
    ...(reason !== undefined && reason.length > 0 ? { reason } : {}),
    path,
    sections,
  };
}

// ---------------------------------------------------------------------------
// profile.status
// ---------------------------------------------------------------------------

function readInvalidField(value: unknown): ProfileInvalidField | null {
  if (!isRecord(value)) return null;
  const fieldId = readString(value.fieldId);
  if (fieldId === undefined) return null;
  return { fieldId, reason: readString(value.reason) ?? 'no reason given' };
}

/**
 * `profile.status` → the diagnostic answer, or null when the body does not carry one.
 * The generated output shape has no `value` property anywhere and this reader adds none:
 * that is what makes the verb safe to put in a support bundle (§11.3).
 */
export function readProfileStatus(value: unknown): ProfileStatus | null {
  if (!isRecord(value)) return null;
  const wire = value as unknown as WireStatusOutput;
  const state = readState(wire.kind);
  const path = readString(wire.path);
  if (state === undefined || path === undefined) return null;
  const reason = readString(wire.reason);
  const exists = typeof wire.exists === 'boolean' ? wire.exists : undefined;
  const lineCount = readNumber(wire.lineCount);
  const fieldCount = readNumber(wire.fieldCount);
  const proseLineCount = readNumber(wire.proseLineCount);
  return {
    state,
    ...(reason !== undefined && reason.length > 0 ? { reason } : {}),
    path,
    ...(exists !== undefined ? { exists } : {}),
    sections: (Array.isArray(wire.sections) ? wire.sections : []).filter(
      (name): name is string => typeof name === 'string',
    ),
    ...(lineCount !== undefined ? { lineCount } : {}),
    ...(fieldCount !== undefined ? { fieldCount } : {}),
    ...(proseLineCount !== undefined ? { proseLineCount } : {}),
    invalidFields: (Array.isArray(wire.invalidFields) ? wire.invalidFields : [])
      .map(readInvalidField)
      .filter((entry): entry is ProfileInvalidField => entry !== null),
  };
}

// ---------------------------------------------------------------------------
// profile.provenance
// ---------------------------------------------------------------------------

function readSupersededValue(value: unknown): ProfileSupersededValue | null {
  if (!isRecord(value)) return null;
  const fieldId = readString(value.fieldId);
  const text = readString(value.value);
  if (fieldId === undefined || text === undefined) return null;
  const provenance = readProvenanceValue(value.provenance);
  return {
    fieldId,
    section: readString(value.section) ?? '',
    value: text,
    supersededOn: readString(value.supersededOn) ?? '',
    ...(provenance !== undefined ? { provenance } : {}),
  };
}

/**
 * `profile.provenance` → where a field came from, or null when the body carries nothing
 * recognisable. A field that exists with no suffix comes back `handEdited: true` with no
 * provenance, which is §4.2's own answer ("no provenance recorded; you edited this line
 * by hand"), never dressed up as a recorded source.
 */
export function readProfileProvenanceAnswer(value: unknown): ProfileProvenanceAnswer | null {
  if (!isRecord(value)) return null;
  const wire = value as unknown as WireProvenanceOutput;
  const fieldId = readString(wire.fieldId);
  if (fieldId === undefined || typeof wire.present !== 'boolean') return null;
  const provenance = readProvenanceValue(wire.provenance);
  return {
    fieldId,
    present: wire.present,
    // The generated type says this is a boolean, so a `=== true` compare reads as
    // redundant to the linter, but the wire is not the type, and a body missing the flag
    // must not read as "hand edited". typeof keeps the runtime check without the compare.
    handEdited: typeof wire.handEdited === 'boolean' ? wire.handEdited : false,
    ...(provenance !== undefined ? { provenance } : {}),
    superseded: (Array.isArray(wire.superseded) ? wire.superseded : [])
      .map(readSupersededValue)
      .filter((entry): entry is ProfileSupersededValue => entry !== null),
  };
}

// ---------------------------------------------------------------------------
// profile.set / .append / .forget / .undo
// ---------------------------------------------------------------------------

function readChange(value: unknown): ProfileChange | null {
  if (!isRecord(value)) return null;
  const section = readString(value.section);
  const label = readString(value.label);
  if (section === undefined || label === undefined) return null;
  return {
    kind: readString(value.kind) ?? '',
    fieldId: readString(value.fieldId) ?? null,
    section,
    label,
    superseded: value.superseded === true,
  };
}

/**
 * Every write verb's answer, or null when the body does not carry one.
 *
 * `ok` is required by the contract, so its absence is a malformed answer rather than a
 * failure, and the two are reported differently. Null must never be rendered as a
 * success: for a delete in particular, a daemon that did not say it deleted has not told
 * us it deleted (§9.2).
 */
export function readProfileWriteOutcome(value: unknown): ProfileWriteOutcome | null {
  if (!isRecord(value)) return null;
  const wire = value as unknown as WireWriteOutput;
  if (typeof wire.ok !== 'boolean') return null;
  const reason = readString(wire.reason);
  return {
    ok: wire.ok,
    ...(reason !== undefined && reason.length > 0 ? { reason } : {}),
    changes: (Array.isArray(wire.changes) ? wire.changes : [])
      .map(readChange)
      .filter((change): change is ProfileChange => change !== null),
    disclosure: readString(wire.disclosure) ?? '',
  };
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

/** The wire input `profile.forget` takes: a field id, or a section plus the exact text. */
export function forgetTargetInput(target: ProfileTarget): ProfileForgetTarget {
  return target.kind === 'field'
    ? { fieldId: target.fieldId }
    : { section: target.section, text: target.text };
}

/** A stable string for react keys and query keys. Never rendered to the operator. */
export function profileTargetId(target: ProfileTarget): string {
  return target.kind === 'field' ? `field:${target.fieldId}` : `line:${target.section}:${target.text}`;
}

// ---------------------------------------------------------------------------
// Third-party personal data (§10)
// ---------------------------------------------------------------------------

/**
 * Headings match case-insensitively with whitespace collapsed, the same rule the
 * daemon's own `canonicalProfileSection` applies, so this surface classifies a heading
 * exactly the way the store does. A heading the owner has renamed outside the canonical
 * set is recognised by neither, which is a property of the design rather than a gap here:
 * the store treats such a section as one of his own.
 */
function normalizeHeading(heading: string): string {
  return heading.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** The section holding facts about people who never agreed to be in a database (§10). */
export const THIRD_PARTY_SECTION_HEADINGS: ReadonlySet<string> = new Set(['people']);

export function sectionHoldsThirdPartyData(section: ProfileSection): boolean {
  return THIRD_PARTY_SECTION_HEADINGS.has(normalizeHeading(section.heading));
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

export function profileStateLabel(state: ProfileState): string {
  switch (state) {
    case 'loaded': return 'Loaded';
    case 'disabled': return 'Turned off';
    case 'unavailable': return 'Could not be read';
  }
}

/** The webui's own `.badge` tone classes, same idiom memoryTierBadgeClass uses. */
export function profileStateBadgeClass(state: ProfileState): 'ok' | 'neutral' | 'bad' {
  switch (state) {
    case 'loaded': return 'ok';
    case 'disabled': return 'neutral';
    case 'unavailable': return 'bad';
  }
}

/** One line saying what a section's tier means for the agent, in plain terms (§11.2). */
export function tierNote(tier: ProfileTier): string {
  return tier === 'open'
    ? 'Open: this is in the agent’s context every turn, so it never has to ask.'
    : 'Closed: never put in the agent’s context. It is read only when something asks for it by name, and every read is disclosed.';
}

/**
 * §4.4's own sentence, in shape: "Your profile could not be read: <reason> (<path>)". A
 * daemon that gives no reason gets an honest sentence saying so rather than an invented one.
 */
export function profileUnavailableLine(reason: string | undefined, path: string): string {
  const head = reason !== undefined
    ? `Your profile could not be read: ${reason}`
    : 'Your profile could not be read, and the daemon did not give a reason';
  return `${head} (${path})`;
}

/** §12's stated disabled state, never an empty profile. */
export function profileDisabledLine(): string {
  return 'Your profile is turned off, so nothing is loaded. Turn on profile.enabled in Settings to use it.';
}

/** One line for a provenance record: which surface, when, and his words (§4.2). */
export function provenanceSummary(provenance: ProfileProvenance): string {
  return `${provenance.surface}, ${provenance.date}: "${provenance.said}"`;
}

/**
 * What a write actually did, in one line.
 *
 * A refusal is reported in the DAEMON's own words. That matters most for `forget`: the
 * store answers `ok: false` with "Your profile has no <label> recorded, so there was
 * nothing to forget" for an absent field and with a trust refusal for a blocked one, and
 * relaying its sentence keeps those two distinct without this surface guessing which it
 * is looking at. A no-op is never rendered as a success (§9.2).
 */
export function writeReportLine(
  outcome: ProfileWriteOutcome | null,
  fallbackSuccess: string,
  malformed: string,
): { readonly tone: 'ok' | 'info' | 'warning'; readonly text: string } {
  if (outcome === null) return { tone: 'warning', text: malformed };
  if (!outcome.ok) {
    return { tone: 'info', text: outcome.reason ?? 'The daemon refused that, without saying why.' };
  }
  const disclosure = outcome.disclosure.length > 0 ? outcome.disclosure : undefined;
  return { tone: 'ok', text: disclosure ?? fallbackSuccess };
}

/** What a delete actually removed, named from the daemon's own change list (§9.2). */
export function deletedWhat(outcome: ProfileWriteOutcome, fallbackLabel: string): string {
  const labels = outcome.changes.map((change) => change.label).filter((label) => label.length > 0);
  return labels.length > 0 ? labels.join(', ') : fallbackLabel;
}

/**
 * Appended whenever a delete finds nothing to delete.
 *
 * A forget names a row this page rendered from an earlier read, so a failure usually means
 * the file has moved on since, he edited it himself, or another surface did. Saying only
 * "nothing was removed" would be true and useless; the useful part is that the page may no
 * longer match the file, and that it is being re-read.
 *
 * The wording says MAY rather than asserting the file changed, because one failure branch
 * is not staleness at all: matching now ignores the Markdown list marker on both sides, so
 * a section holding both `- Foo` and a bare `Foo` produces two matches and is refused as
 * ambiguous. The file is exactly as the page showed it there. Claiming "the file changed"
 * would be a confident false statement in that case, and this note is appended without
 * classifying the cause on purpose, deciding which branch fired would mean sniffing a
 * reason string the SDK is free to reword, and re-reading is correct after any of them.
 */
export const STALE_VIEW_NOTE =
  'This page may no longer match the file; reloading it so you can see what is actually there.';

/**
 * What a delete did, in one line.
 *
 * Success names what actually went, from the daemon's own change list. Every failure,
 * an absent field, a note whose text is no longer there, a section renamed away, or two
 * identical notes the daemon will not guess between, relays the daemon's own sentence and
 * adds the staleness note, because in all of them the row he clicked no longer matches the
 * document. A body that never said `ok` is reported as unsaid, never as a deletion.
 */
export function forgetReportLine(
  outcome: ProfileWriteOutcome | null,
  label: string,
): { readonly tone: 'ok' | 'info' | 'warning'; readonly text: string } {
  if (outcome === null) {
    return {
      tone: 'warning',
      text: `The daemon answered, but did not say whether ${label} was deleted. Check the profile below before assuming it went.`,
    };
  }
  if (!outcome.ok) {
    const reason = outcome.reason ?? 'Nothing was deleted, and the daemon did not say why.';
    return { tone: 'warning', text: `${reason} ${STALE_VIEW_NOTE}` };
  }
  return { tone: 'ok', text: `Deleted ${deletedWhat(outcome, label)} from your profile.` };
}

/** The `said` a settings-surface write carries (§7 layer 3, §9.3). */
export const SETTINGS_EDIT_UTTERANCE = '(edited in settings)';

/**
 * The surface name a write from this app declares. One of the daemon's own
 * `ProfileSurface` values (tui | agent | webui | voice | hand-edit), anything else is a
 * 400 from routes/owner-profile.ts's readSurface, never a silent default.
 */
export const WEBUI_PROFILE_SURFACE = 'webui';

/**
 * The authority every write from this surface claims (§7 layer 1).
 *
 * This is a CLAIM about where the fact came from, and this surface can make it honestly:
 * the only thing that reaches a profile write here is the owner typing into his own
 * settings page. No page content, no message body and no document composes these calls,
 * so `owner-direct` is the true answer rather than the convenient one.
 *
 * It is stated on every write because the daemon requires every caller to say where a
 * fact came from: routes/owner-profile.ts's readAuthority refuses an absent or
 * unrecognised value with a 400. It refuses rather than defaulting because §7 gives
 * `forget` and `undo` an authority check and nothing else, an unstated authority on a
 * delete would not be a weakened gate, it would be no gate, and a caller sending none
 * could delete the owner's shipping address.
 *
 * This is the honest answer for THIS surface only. The agent must not hardcode it: it can
 * genuinely receive a purported fact from an email, a web page or a channel message, and
 * it has to state which so the SDK can refuse.
 */
export const WEBUI_PROFILE_AUTHORITY = 'owner-direct';

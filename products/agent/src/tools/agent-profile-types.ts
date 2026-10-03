/**
 * agent-profile-types.ts, the owner-profile control-plane payloads, as this
 * surface handles them.
 *
 * The nine `profile.*` verbs (docs/owner-profile.md §11.1) are in the platform
 * runtime's generated operator contract, so every request and response type
 * here is the CONTRACT'S type, `OperatorMethodInput` / `OperatorMethodOutput`
 *, rather than a hand-written copy that could drift from it.
 *
 * What the contract types do not do is check anything at runtime. Both routes a
 * call can take hand back `unknown`: the in-process gateway catalog's `invoke`
 * is typed `Promise<unknown>`, and the connected-host route returns a decoded
 * wire payload. So each verb gets one narrower that checks the fields the
 * response is discriminated on and then makes the cast explicit
 * (`as unknown as <contract type>`), returning null when the payload is not
 * that shape. A daemon that answers something unexpected, an older build, a
 * proxy, a truncated body, makes the verb say it could not read the answer,
 * instead of throwing part-way through a turn.
 *
 * Nothing in this module logs, stores or formats a profile VALUE. §11.3 keeps
 * values out of logs, exports and diagnostics; this module only describes their
 * shape.
 */

import type { OperatorMethodInput, OperatorMethodOutput } from '@goodvibes-jev/engine/sdk/contracts';
import type { AuthoritySurface } from '../trust/untrusted-content.ts';

/** Every write takes one. Only `owner-direct` is accepted by the daemon (§7 layer 1). */
export type ProfileAuthority = AuthoritySurface;

export const PROFILE_AUTHORITIES: readonly ProfileAuthority[] = [
  'owner-direct',
  'web-page',
  'email',
  'channel-message',
  'document',
  'calendar-event',
];

/**
 * `ProfileAuthority` above already IS the SDK's own type, `AuthoritySurface`,
 * imported through `trust/untrusted-content.ts`'s re-export, so there is no
 * local copy of the union to drift. `PROFILE_AUTHORITIES`, the runtime array
 * of its members, is a different question: the SDK
 * (`platform/security/untrusted-content.ts`) exports `AuthoritySurface` as a
 * type only. It has no runtime array enumerating that type's members, only
 * functions that take one already-known surface (`surfaceTrustTier`,
 * `surfaceIsUntrusted`, `surfaceHasCommandAuthority`), and the generated
 * operator contract's JSON schema for `authority` is an unconstrained
 * `{"type":"string"}`, not an enum. So there is genuinely no upstream VALUE
 * this array could import or be asserted equal to; this array stays local by
 * necessity, not by choice.
 *
 * What compiles in its place: a switch over every literal, checked against
 * `ProfileAuthority` with an `assertNever` default. If the SDK's
 * `AuthoritySurface` ever gains or loses a member, this file fails to compile
 * until the switch (and `PROFILE_AUTHORITIES` alongside it) is updated to
 * match, instead of the array silently going stale, the exact drift class
 * behind three defects this session. Exercised in
 * `src/test/tools/agent-profile-types.test.ts`, which also asserts
 * `PROFILE_AUTHORITIES` and this switch's cases name the same set at runtime.
 */
function assertNeverProfileAuthority(value: never): never {
  throw new Error(`unreachable: unhandled ProfileAuthority ${String(value)}`);
}

export function exhaustiveProfileAuthorityCheck(value: ProfileAuthority): true {
  switch (value) {
    case 'owner-direct':
    case 'web-page':
    case 'email':
    case 'channel-message':
    case 'document':
    case 'calendar-event':
      return true;
    default:
      return assertNeverProfileAuthority(value);
  }
}

export function isProfileAuthority(value: unknown): value is ProfileAuthority {
  return typeof value === 'string' && (PROFILE_AUTHORITIES as readonly string[]).includes(value);
}

/**
 * The surface name written into a line's provenance suffix. Distinct from the
 * authority: the authority says whether the fact came from HIM, this says which
 * of his surfaces recorded it. Both this tool and this binary's CLI are the
 * agent; `hand-edit` belongs to lines he types into the file himself.
 */
export const PROFILE_RECORDING_SURFACE = 'agent';

/** The nine control-plane verbs, by the ids the daemon registers them under. */
export const PROFILE_METHOD_IDS = {
  read: 'profile.read',
  get: 'profile.get',
  person: 'profile.person',
  provenance: 'profile.provenance',
  set: 'profile.set',
  append: 'profile.append',
  forget: 'profile.forget',
  undo: 'profile.undo',
  status: 'profile.status',
} as const;

export type ProfileMethodId = (typeof PROFILE_METHOD_IDS)[keyof typeof PROFILE_METHOD_IDS];

// ── Actions ────────────────────────────────────────────────────────────────

export type ProfileAction =
  | 'read' | 'get' | 'person' | 'provenance'
  | 'set' | 'append' | 'forget' | 'undo' | 'status';

export const PROFILE_ACTIONS: readonly ProfileAction[] = [
  'read', 'get', 'person', 'provenance', 'set', 'append', 'forget', 'undo', 'status',
];

/** The four that change the file. Everything else only looks. */
export const PROFILE_WRITE_ACTIONS: ReadonlySet<ProfileAction> = new Set<ProfileAction>([
  'set', 'append', 'forget', 'undo',
]);

/**
 * One action vocabulary, shared by the tool and by the permission classifier
 * that decides whether a call is a read or a write. Two copies of this list
 * would let an alias classify as a read on one side and act as a write on the
 * other, which is the wrong direction for a mistake to point.
 *
 * Returns null for anything unrecognised; every caller treats that as a write,
 * never as a read.
 */
export function normalizeProfileAction(value: unknown): ProfileAction | null {
  const raw = (typeof value === 'string' ? value : '').trim().toLowerCase().replace(/-/g, '_');
  if (!raw) return null;
  if (raw === 'read' || raw === 'all' || raw === 'document' || raw === 'about_me') return 'read';
  if (raw === 'get' || raw === 'field' || raw === 'lookup') return 'get';
  if (raw === 'person' || raw === 'people' || raw === 'contact') return 'person';
  if (raw === 'provenance' || raw === 'source' || raw === 'where') return 'provenance';
  if (raw === 'set' || raw === 'record' || raw === 'correct' || raw === 'update') return 'set';
  if (raw === 'append' || raw === 'add' || raw === 'note') return 'append';
  if (raw === 'forget' || raw === 'delete' || raw === 'remove') return 'forget';
  if (raw === 'undo' || raw === 'restore') return 'undo';
  if (raw === 'status' || raw === 'health' || raw === 'diagnostics') return 'status';
  return null;
}

// ── Contract payloads ──────────────────────────────────────────────────────

export type ProfileReadResponse = OperatorMethodOutput<'profile.read'>;
export type ProfileGetResponse = OperatorMethodOutput<'profile.get'>;
export type ProfilePersonResponse = OperatorMethodOutput<'profile.person'>;
export type ProfileProvenanceResponse = OperatorMethodOutput<'profile.provenance'>;
/** `set`, `append`, `forget` and `undo` all answer with this. */
export type ProfileWriteResponse = OperatorMethodOutput<'profile.set'>;
export type ProfileStatusResponse = OperatorMethodOutput<'profile.status'>;

export type ProfileSetInput = OperatorMethodInput<'profile.set'>;
export type ProfileAppendInput = OperatorMethodInput<'profile.append'>;
export type ProfileForgetInput = OperatorMethodInput<'profile.forget'>;
export type ProfileUndoInput = OperatorMethodInput<'profile.undo'>;

export type ProfileSectionResponse = ProfileReadResponse['sections'][number];
export type ProfileLineResponse = ProfileSectionResponse['prose'][number];
export type ProfileFieldResponse = ProfileSectionResponse['fields'][number];

// ── Narrowing ──────────────────────────────────────────────────────────────

/** What a narrower's caller says when the payload is not the shape the verb promises. */
export const PROFILE_RESPONSE_UNREADABLE =
  'The daemon answered in a shape this build does not recognise. Nothing was read or changed by this call; report that rather than guessing at the answer.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function narrowProfileRead(value: unknown): ProfileReadResponse | null {
  if (!isRecord(value)) return null;
  if (!isRecord(value.state) || typeof value.state.kind !== 'string') return null;
  if (!Array.isArray(value.sections)) return null;
  return value as unknown as ProfileReadResponse;
}

export function narrowProfileGet(value: unknown): ProfileGetResponse | null {
  if (!isRecord(value)) return null;
  if (typeof value.fieldId !== 'string' || typeof value.present !== 'boolean') return null;
  return value as unknown as ProfileGetResponse;
}

export function narrowProfilePerson(value: unknown): ProfilePersonResponse | null {
  if (!isRecord(value)) return null;
  if (typeof value.name !== 'string' || !Array.isArray(value.lines)) return null;
  return value as unknown as ProfilePersonResponse;
}

export function narrowProfileProvenance(value: unknown): ProfileProvenanceResponse | null {
  if (!isRecord(value)) return null;
  if (typeof value.fieldId !== 'string' || typeof value.present !== 'boolean') return null;
  if (typeof value.handEdited !== 'boolean' || !Array.isArray(value.superseded)) return null;
  return value as unknown as ProfileProvenanceResponse;
}

export function narrowProfileWrite(value: unknown): ProfileWriteResponse | null {
  if (!isRecord(value)) return null;
  if (typeof value.ok !== 'boolean' || !Array.isArray(value.changes)) return null;
  if (typeof value.disclosure !== 'string') return null;
  return value as unknown as ProfileWriteResponse;
}

export function narrowProfileStatus(value: unknown): ProfileStatusResponse | null {
  if (!isRecord(value)) return null;
  if (typeof value.kind !== 'string' || typeof value.path !== 'string') return null;
  return value as unknown as ProfileStatusResponse;
}

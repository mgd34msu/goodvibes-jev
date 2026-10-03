/**
 * `PROFILE_AUTHORITIES` / `ProfileAuthority`, and why this file keeps a local
 * array instead of importing one from the SDK.
 *
 * `ProfileAuthority` already IS the SDK's own type (`AuthoritySurface`,
 * reached through `trust/untrusted-content.ts`'s re-export), there is no
 * mirrored TYPE to drift. `PROFILE_AUTHORITIES` is different: it is a runtime
 * array of that type's members, and the SDK
 * (`platform/security/untrusted-content.ts`) exports `AuthoritySurface` as a
 * type only, confirmed by reading the built `.d.ts`/`.js`: the module hands
 * back functions of an already-known surface (`surfaceTrustTier`,
 * `surfaceIsUntrusted`, `surfaceHasCommandAuthority`), never a list of every
 * surface, and the generated operator contract's JSON schema for `authority`
 * is an unconstrained `{"type":"string"}` rather than an enum. There is no
 * upstream runtime value to import or assert equality against.
 *
 * What stands in for that: `exhaustiveProfileAuthorityCheck` is a switch over
 * every literal of `ProfileAuthority`, with an `assertNever` default, it
 * fails to COMPILE if the SDK's `AuthoritySurface` ever gains or loses a
 * member, which is the earliest possible signal for the drift class behind
 * three defects this session. This suite exercises it at runtime too, and
 * pins that `PROFILE_AUTHORITIES` and the switch's cases name the same set,
 * so a future edit that adds a case to one without the other fails here.
 */

import { describe, expect, test } from 'bun:test';
import {
  exhaustiveProfileAuthorityCheck,
  isProfileAuthority,
  PROFILE_AUTHORITIES,
  type ProfileAuthority,
} from '../../tools/agent-profile-types.ts';

/**
 * The switch's own literal set, kept here ONLY so this test can compare it to
 * `PROFILE_AUTHORITIES` at runtime, never imported by production code. If
 * `exhaustiveProfileAuthorityCheck`'s cases and this list disagree, either
 * this list or the production switch is stale, and this test is where that
 * shows up.
 */
const SWITCH_CASES: readonly ProfileAuthority[] = [
  'owner-direct',
  'web-page',
  'email',
  'channel-message',
  'document',
  'calendar-event',
];

describe('agent-profile-types: PROFILE_AUTHORITIES has no SDK runtime value to import', () => {
  test('every entry in PROFILE_AUTHORITIES passes the exhaustive switch without throwing', () => {
    for (const authority of PROFILE_AUTHORITIES) {
      expect(exhaustiveProfileAuthorityCheck(authority)).toBe(true);
    }
  });

  test('PROFILE_AUTHORITIES and the exhaustive switch name exactly the same set', () => {
    expect(new Set(PROFILE_AUTHORITIES)).toEqual(new Set(SWITCH_CASES));
    expect(PROFILE_AUTHORITIES.length).toBe(new Set(PROFILE_AUTHORITIES).size);
  });

  test('isProfileAuthority accepts every listed authority and rejects an unknown one', () => {
    for (const authority of PROFILE_AUTHORITIES) {
      expect(isProfileAuthority(authority)).toBe(true);
    }
    expect(isProfileAuthority('trusted-source')).toBe(false);
    expect(isProfileAuthority('')).toBe(false);
  });
});

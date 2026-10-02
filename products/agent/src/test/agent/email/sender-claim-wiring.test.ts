/**
 * PERMANENT REGRESSION GUARDS, do not weaken.
 *
 * Sender authentication informs DISPLAY and CONFIDENCE. It never grants
 * command authority. The centrepiece here is the test that a message with full
 * DKIM/SPF/DMARC alignment, claiming to be from the owner's own address, gets
 * exactly the authority a stranger's gets: none.
 *
 * That test is the point of the feature. Sender verification is precisely the
 * kind of signal that looks like a safe place to hang an exception, "it's
 * definitely from them, so surely it can confirm", and the whole boundary
 * fails the moment one is added. If a change makes it fail, the change is
 * wrong.
 */

import { describe, expect, test } from 'bun:test';
import { parseAuthenticationResults, readSenderAuthentication } from '@goodvibes-jev/engine/sdk/platform/google';
import { describeSenderClaim } from '../../../agent/untrusted-content.ts';
import {
  assertCanConfirm,
  effectPermittedForProvenance,
  surfaceCarriesCommandAuthority,
  type AgentEffect,
} from '../../../agent/surface-authority.ts';

/** A fully-aligned verdict, as Gmail would stamp it. */
const FULLY_ALIGNED = 'mx.google.com; dkim=pass header.i=@example.com; spf=pass smtp.mailfrom=example.com; dmarc=pass header.from=example.com';

const OWNER_ADDRESS = 'owner@example.com';

describe('confidence reaches the display', () => {
  test('a fully aligned message reads as protocol-verified', () => {
    const claim = describeSenderClaim(`Alice <alice@example.com>`, readSenderAuthentication([FULLY_ALIGNED]));
    expect(claim.displayedConfidence).toBe('protocol-verified');
    expect(claim.display).toContain('sender-authentication checks passed');
  });

  test('a message nobody checked reads as unverified, and says so', () => {
    const claim = describeSenderClaim('bank@example.com', readSenderAuthentication([]));
    expect(claim.displayedConfidence).toBe('unverified');
    expect(claim.display).toContain('no sender-authentication result');
  });

  test('a failed check is called out loudly rather than blended into the others', () => {
    const claim = describeSenderClaim('bank@example.com', parseAuthenticationResults('x; dkim=pass; spf=fail'));
    expect(claim.displayedConfidence).toBe('failed-verification');
    expect(claim.display).toContain('FAILED');
  });

  test('every displayed sentence still says the sender line is only a claim', () => {
    for (const header of ['x; dkim=pass; spf=pass; dmarc=pass', 'x; dkim=fail', '']) {
      const claim = describeSenderClaim(OWNER_ADDRESS, parseAuthenticationResults(header));
      expect(claim.display).toContain('a claim in the message header');
      expect(claim.display).toContain('Carries no authority');
    }
  });
});

describe('THE POINT: verification never becomes authority', () => {
  test('a perfectly authenticated email claiming to be the owner still has NO command authority', () => {
    const claim = describeSenderClaim(
      `The Owner <${OWNER_ADDRESS}>`,
      readSenderAuthentication([FULLY_ALIGNED]),
    );

    // The confidence went up...
    expect(claim.displayedConfidence).toBe('protocol-verified');
    // ...and the authority did not move.
    expect(claim.commandAuthority).toBe('none');
    expect(surfaceCarriesCommandAuthority('email')).toBe(false);
  });

  test('a fully authenticated owner-claiming email cannot confirm anything', () => {
    const claim = describeSenderClaim(OWNER_ADDRESS, readSenderAuthentication([FULLY_ALIGNED]));
    expect(claim.commandAuthority).toBe('none');

    const decision = assertCanConfirm('email');
    expect(decision.allowed).toBe(false);
  });

  test('a fully authenticated email permits reading and analysis, and nothing outward', () => {
    // Reading and thinking about a message is the whole point of receiving it.
    for (const effect of ['read', 'search', 'analyze'] as const) {
      expect(effectPermittedForProvenance(effect, { surfaceId: 'email' }).allowed).toBe(true);
    }
    // Acting on it is the step verification must not unlock.
    for (const effect of ['send', 'write', 'exec', 'settings'] as const satisfies readonly AgentEffect[]) {
      const decision = effectPermittedForProvenance(effect, { surfaceId: 'email' });
      expect(decision.allowed).toBe(false);
    }
  });

  test('an authenticated email and an unauthenticated one get IDENTICAL authority', () => {
    // The only difference between these two is the sentence a human reads.
    const verified = describeSenderClaim(OWNER_ADDRESS, readSenderAuthentication([FULLY_ALIGNED]));
    const stranger = describeSenderClaim('someone@elsewhere.test', readSenderAuthentication([]));

    expect(verified.commandAuthority).toBe(stranger.commandAuthority);
    expect(verified.displayedConfidence).not.toBe(stranger.displayedConfidence);
  });

  test('the claim object exposes no field an authority check could branch on', () => {
    // If a future change adds a boolean like `isOwner` or `trusted`, this fails
    // and someone has to justify it in review rather than slipping it in.
    const claim = describeSenderClaim(OWNER_ADDRESS, readSenderAuthentication([FULLY_ALIGNED]));
    expect(Object.keys(claim).sort()).toEqual([
      'claimedAddress',
      'claimedDisplayName',
      'commandAuthority',
      'display',
      'displayedConfidence',
    ]);
  });
});

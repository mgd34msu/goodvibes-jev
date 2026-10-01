/**
 * The session's open verification expectations.
 *
 * `VerificationExpectationBook` is the narrow hole that lets a verification
 * email the agent itself provoked establish one thing: whoever controls the
 * minted alias received this token. It had no caller, so the hole was never
 * opened and the aliasing that feeds it was never used.
 *
 * The book is session-scoped and in memory on purpose. An expectation is a
 * fifteen-minute window around a signup the agent is performing right now;
 * persisting it across restarts would keep a matching window open long after
 * the signup it belonged to, which is the opposite of narrow. Losing the book
 * on exit means an unfinished signup simply cannot be auto-verified, which is
 * the safe direction to fail in.
 *
 * Shared between the tool that mints the alias and the tool that reads the
 * mail, exactly like the untrusted-content ledger.
 */

import { VerificationExpectationBook } from '@goodvibes-jev/engine/sdk/platform/google';
import { surfaceHasCommandAuthority } from '../../trust/untrusted-content.ts';

let book: VerificationExpectationBook | null = null;

/**
 * The session book. Constructed with the real surface-authority probe, so if
 * email ever gains command authority, opening an expectation fails loudly
 * rather than quietly widening the hole.
 */
export function getSessionExpectationBook(): VerificationExpectationBook {
  if (book === null) {
    book = new VerificationExpectationBook({
      surfaceHasCommandAuthority: (surface: string) => surface === 'email' && surfaceHasCommandAuthority('email'),
    });
  }
  return book;
}

/** Test seam: drops every open expectation between cases. */
export function resetSessionExpectationBookForTests(): void {
  book = null;
}

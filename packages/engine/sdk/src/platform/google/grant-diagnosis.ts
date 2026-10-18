import { retainStrictJudgmentJson } from '../gate/judgment-result.js';
import { readGrantFailure } from './failure-readings.js';

/** Why a grant is no longer usable. */
export type GoogleGrantFailureCause =
  /** The token was minted under a different Google account than the configured one. */
  | 'account-mismatch'
  /** The person (or Google) revoked the grant, or it aged out. */
  | 'revoked'
  /** The refresh token does not belong to the client id being used with it. */
  | 'client-mismatch'
  /** Google attributes expiry to the Testing app token lifetime. */
  | 'testing-expiry'
  /** The response did not establish a specific cause. */
  | 'unknown';

export interface GoogleGrantDiagnosis {
  readonly cause: GoogleGrantFailureCause;
  /** Plain words. Never a token, never a raw Google error alone. */
  readonly problem: string;
  /** What the platform can offer to do next. */
  readonly fix: string;
  /** True for every cause here, a dead grant always needs a person. */
  readonly needsReauthorization: true;
}

export interface GrantDiagnosisInput {
  /** Google's error text, interpreted as evidence. May be empty. */
  readonly googleError: string;
  /** The account this product is configured for, when known. */
  readonly intendedAccount: string | null;
  /** The account the machine is actually signed in as (gcloud), when known. */
  readonly signedInAccount: string | null;
  /** Last known publishing status, as context for a reported Testing-token expiry. */
  readonly publishingStatus: 'testing' | 'in-production' | 'unknown';
  /** Where the credential came from, which changes the remedy wording. */
  readonly credentialOrigin: 'secret-store' | 'gmail-mcp' | null;
}

const REAUTHORIZE_OFFER = 'Say the word and I will start a fresh consent';

function normalize(account: string | null): string | null {
  const trimmed = account?.trim().toLowerCase();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : null;
}

/** Compare known account identities locally, then interpret Google's explanation. */
export async function diagnoseInvalidGrant(original: GrantDiagnosisInput): Promise<GoogleGrantDiagnosis> {
  const source = retainStrictJudgmentJson(original);
  const input = source.snapshot;
  const intended = normalize(input.intendedAccount);
  const signedIn = normalize(input.signedInAccount);

  if (intended !== null && signedIn !== null && intended !== signedIn) {
    return {
      cause: 'account-mismatch',
      problem:
        `This machine is signed in as ${signedIn}, but this product is set up for ${intended}. `
        + 'If consent was approved under the signed-in account, its refresh token cannot speak for the configured account.',
      fix:
        `${REAUTHORIZE_OFFER}. On the Google consent screen, sign in as ${intended}, `
        + `not ${signedIn}. If the account picker is already showing ${signedIn}, choose "Use another account".`,
      needsReauthorization: true,
    };
  }

  let cause: 'revoked' | 'client-mismatch' | 'testing-expiry' | 'unknown' = 'unknown';
  const explanation = input.googleError.trim();
  if (explanation && explanation !== 'invalid_grant' && explanation !== 'Google rejected the token request (invalid_grant).') {
    try { cause = await readGrantFailure(input, { assertCurrent: source.assertCurrent }); }
    catch { /* An unavailable reading does not establish a cause. */ }
  }
  source.assertCurrent();
  if (cause === 'revoked') {
    return {
      cause: 'revoked',
      problem:
        'Google reports this refresh token as expired or revoked. That happens when the account\'s access to the app was removed at '
        + 'https://myaccount.google.com/permissions, when the password was changed, or when a token issued under a Testing app aged out.',
      fix: `${REAUTHORIZE_OFFER} for you to approve. Nothing is deleted until you say so.`,
      needsReauthorization: true,
    };
  }

  if (cause === 'client-mismatch') {
    return {
      cause: 'client-mismatch',
      problem:
        'The stored refresh token does not belong to the stored OAuth client id. A token is tied to the exact client that requested it, '
        + 'so this happens when one half of a credential was replaced without the other.',
      fix: `${REAUTHORIZE_OFFER}, minting a token against the client that is actually stored.`,
      needsReauthorization: true,
    };
  }

  if (cause === 'testing-expiry') {
    return {
      cause: 'testing-expiry',
      problem:
        'Google attributes this credential’s expiry to the Testing app token lifetime.',
      fix:
        'Check the app at https://console.cloud.google.com/auth/audience. If it is still in Testing, set publishing status to "In production", '
        + `then ${REAUTHORIZE_OFFER.toLowerCase()}.`,
      needsReauthorization: true,
    };
  }

  const testingNote = input.publishingStatus === 'testing'
    ? ' The app is in Testing, where a token lifetime of seven days can apply; its status alone does not establish why this token failed.' : '';
  const adoptedNote =
    input.credentialOrigin === 'gmail-mcp'
      ? ' This credential was taken up from another tool\'s files, so it may also have been rotated by that tool.'
      : '';

  return {
    cause: 'unknown',
    problem:
      'Google rejected this refresh token; the specific cause could not be established. Possible causes include: the token was approved by a different '
      + 'Google account than the one configured here, the grant was revoked at https://myaccount.google.com/permissions, or the token does not match the '
      + `stored client id.${testingNote}${adoptedNote}`,
    fix:
      `${REAUTHORIZE_OFFER}, watch which account it offers, because approving as the wrong account is the most common cause of this.`,
    needsReauthorization: true,
  };
}

/** The diagnosis as lines for a transcript. Problem first, then the remedy. */
export function describeGrantDiagnosis(diagnosis: GoogleGrantDiagnosis): readonly string[] {
  return [diagnosis.problem, `Do this: ${diagnosis.fix}`];
}

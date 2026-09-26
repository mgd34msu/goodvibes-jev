/**
 * Claim verification: whether the files a unit agent reports creating or
 * changing exist, a deterministic input to a check's outcome
 * (docs/design/contract-runner.md sections 4.3 and 4.6).
 *
 * This module holds the result types now; the parser and the on-disk check
 * (`parseUnitCompletionReport`, `verifyUnitClaims`) move here in ledger task R.3.
 */
import type { ClaimVerificationKind } from '../../events/contract.js';

/**
 * Discriminator for a claim verification outcome:
 * - 'files_verified': claims present and all found on disk.
 * - 'git_corroborated': claims present, some missing on disk, but git shows changes.
 * - 'verified_empty': no claims made but git shows changes (real work without listed files).
 * - 'unverifiable_no_claims': no claims and no git changes; for a unit that must write, a claims nudge.
 * - 'unverified': claims present but not found on disk and git shows no changes.
 */
export type { ClaimVerificationKind };

/** The result of checking a completion report's file claims against the working tree. */
export interface ClaimVerificationResult {
  /** All paths claimed as created, modified, or deleted. */
  claimedPaths: string[];
  /** Paths that exist on disk (for created/modified claims). */
  foundPaths: string[];
  /** Paths that were claimed but not found on disk. */
  missingPaths: string[];
  /** Whether git shows any changes since the agent started; null outside a git repository. */
  gitDiffDetected: boolean | null;
  /** Use this rather than `verified` to tell 'unverifiable_no_claims' from 'verified_empty'. */
  kind: ClaimVerificationKind;
  /** True when kind is neither 'unverified' nor 'unverifiable_no_claims'. */
  verified: boolean;
  /** What was and was not found, in words. */
  summary: string;
}

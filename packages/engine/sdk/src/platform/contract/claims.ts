/**
 * Claim verification: whether the files a unit agent reports creating or
 * changing exist, a deterministic input to a check's outcome
 * (docs/design/contract-runner.md sections 4.3 and 4.6). Reading the report
 * the agent prompt dictates and checking paths on disk are fixed formats and
 * file-system facts, so this is code, never a judgment.
 */
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { ClaimVerificationKind } from '../../events/contract.js';
import { parseCompletionReport, type CompletionReport } from '../agents/completion-report.js';

/**
 * Discriminator for a claim verification outcome:
 * - 'files_verified': claims present and all found on disk.
 * - 'git_corroborated': claims present, some missing on disk, but the unit changed files since its baseline.
 * - 'verified_empty': no claims made but the unit changed files (real work without listed files), or a read-only unit whose claims are not checked.
 * - 'unverifiable_no_claims': no claims and no changed files; for a unit that must write, a claims nudge.
 * - 'unverified': claims present but not found on disk and no changed files.
 */
export type { ClaimVerificationKind };

/** The result of checking a completion report's file claims against the working tree. */
export interface ClaimVerificationResult {
  /** All paths claimed as created or modified. */
  claimedPaths: string[];
  /** Paths that exist on disk. */
  foundPaths: string[];
  /** Paths that were claimed but not found on disk. */
  missingPaths: string[];
  /** Whether the unit changed any file since its baseline: the evidence's baseline-scoped changed paths, not a diff of the whole tree. */
  changesDetected: boolean;
  /** Use this rather than `verified` to tell 'unverifiable_no_claims' from 'verified_empty'. */
  kind: ClaimVerificationKind;
  /** True when kind is neither 'unverified' nor 'unverifiable_no_claims'. */
  verified: boolean;
  /** What was and was not found, in words. */
  summary: string;
}

/** A unit agent's final output and the completion report read from it. */
export interface UnitCompletionReport {
  /** The report the output ends with; null when the agent gave none. */
  readonly report: CompletionReport | null;
  /** The agent's whole final output, verbatim. */
  readonly rawOutput: string;
}

/** Reads a unit agent's final output: the report it ends with, or null when it gave none. Nothing is made up for plain output. */
export function parseUnitCompletionReport(rawOutput: string): UnitCompletionReport {
  return { report: parseCompletionReport(rawOutput), rawOutput };
}

/** What a claim check reads besides the report. */
export interface ClaimCheckInput {
  /** The unit's worktree, or the project root in shared mode. */
  readonly cwd: string;
  /** Whether the unit's plan role has it change files (`unitMustWrite`). */
  readonly mustWrite: boolean;
  /** The unit's baseline-scoped changed paths (`UnitEvidence.changedPaths`). */
  readonly changedPaths: readonly string[];
}

/** Missing paths named in the summary before the rest are counted. */
const SUMMARY_MISSING_LIMIT = 5;

/** The report's `filesCreated` and `filesModified` entries, whatever its archetype; empty when it carries neither array. */
function claimedFiles(report: CompletionReport | null): string[] {
  if (report === null) return [];
  const fields = report as unknown as { filesCreated?: unknown; filesModified?: unknown };
  return [fields.filesCreated, fields.filesModified].flatMap((list) => (Array.isArray(list) ? list.filter((path): path is string => typeof path === 'string') : []));
}

/** The claim kind from what was claimed, what was found and whether the unit changed files. */
function claimKind(claimed: number, missing: number, changed: boolean): ClaimVerificationKind {
  if (claimed > 0 && missing === 0) return 'files_verified';
  if (claimed > 0 && changed) return 'git_corroborated';
  if (claimed === 0 && changed) return 'verified_empty';
  // No claims and no changed files: nothing confirms any work was done.
  if (claimed === 0) return 'unverifiable_no_claims';
  return 'unverified';
}

/**
 * Verifies that a unit agent's self-reported work exists on disk.
 *
 * - A unit that must not write (by its plan role) claims nothing to check.
 * - Otherwise the claimed paths are the report's `filesCreated` and
 *   `filesModified` whenever it carries them, whatever its archetype; with no
 *   report nothing is claimed. Every claimed path is statted (deleted files
 *   are expected to be gone and are not checked).
 * - When a claimed path is missing, or none was claimed, the unit's changed
 *   paths since its baseline corroborate the work: a non-empty list does, even
 *   when a listed path was wrong.
 */
export function verifyUnitClaims(report: CompletionReport | null, input: ClaimCheckInput): ClaimVerificationResult {
  const changesDetected = input.changedPaths.length > 0;
  if (!input.mustWrite) {
    return {
      claimedPaths: [],
      foundPaths: [],
      missingPaths: [],
      changesDetected,
      kind: 'verified_empty',
      verified: true,
      summary: 'Read-only unit; claim verification skipped.',
    };
  }
  const claimedPaths = claimedFiles(report);
  const foundPaths: string[] = [];
  const missingPaths: string[] = [];
  for (const path of claimedPaths) {
    const absolute = isAbsolute(path) ? path : resolve(input.cwd, path);
    (existsSync(absolute) ? foundPaths : missingPaths).push(path);
  }

  const kind = claimKind(claimedPaths.length, missingPaths.length, changesDetected);
  const verified = kind === 'files_verified' || kind === 'git_corroborated' || kind === 'verified_empty';

  const summaryParts: string[] = [];
  if (report === null) summaryParts.push('the agent gave no completion report, so no files are claimed');
  if (claimedPaths.length > 0) {
    summaryParts.push(`${foundPaths.length}/${claimedPaths.length} claimed paths found on disk`);
    if (missingPaths.length > 0) {
      const more = missingPaths.length - SUMMARY_MISSING_LIMIT;
      summaryParts.push(`missing: ${missingPaths.slice(0, SUMMARY_MISSING_LIMIT).join(', ')}${more > 0 ? ` (+${more} more)` : ''}`);
    }
  } else if (report !== null) {
    summaryParts.push('no file paths claimed');
  }
  summaryParts.push(`changed since baseline: ${changesDetected ? `${input.changedPaths.length} path${input.changedPaths.length === 1 ? '' : 's'}` : 'none'}`);
  summaryParts.push(`kind: ${kind}`);

  return { claimedPaths, foundPaths, missingPaths, changesDetected, kind, verified, summary: summaryParts.join('; ') };
}

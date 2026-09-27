/**
 * Claim verification: whether the files a unit agent reports creating or
 * changing exist, a deterministic input to a check's outcome
 * (docs/design/contract-runner.md sections 4.3 and 4.6). Parsing the report
 * and checking paths on disk are fixed formats and file-system facts, so this
 * is code, never a judgment.
 */
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { ClaimVerificationKind } from '../../events/contract.js';
import { parseCompletionReport, type CompletionReport, type EngineerReport } from '../agents/completion-report.js';

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

/** A unit agent's completion report, with the raw output it was parsed from. */
export type UnitCompletionReport = CompletionReport & {
  /** The agent's whole final output, verbatim. */
  readonly rawOutput: string;
};

/** Characters of raw output kept as the summary when the output carries no structured report. */
const FALLBACK_SUMMARY_CHARS = 500;

/**
 * Parses a unit agent's final output. A structured completion report is used
 * as written; plain output becomes an implementation report that claims no
 * files, so the on-disk check falls through to git.
 */
export function parseUnitCompletionReport(rawOutput: string): UnitCompletionReport {
  const report = parseCompletionReport(rawOutput);
  if (report) return { ...report, rawOutput };
  const fallback: EngineerReport = {
    version: 1,
    archetype: 'engineer',
    summary: rawOutput.slice(0, FALLBACK_SUMMARY_CHARS) || '(no output)',
    gatheredContext: [],
    plannedActions: [],
    appliedChanges: [],
    filesCreated: [],
    filesModified: [],
    filesDeleted: [],
    decisions: [],
    issues: [],
    uncertainties: [],
  };
  return { ...fallback, rawOutput };
}

/** Missing paths named in the summary before the rest are counted. */
const SUMMARY_MISSING_LIMIT = 5;

/** Runs `git diff --stat HEAD` in `cwd`: true when it shows changes, null outside a git repository. */
function gitShowsChanges(cwd: string): boolean | null {
  try {
    const result = execSync('git diff --stat HEAD', {
      cwd,
      timeout: 10_000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return result.length > 0;
  } catch {
    // git not available or not a git repository: inconclusive.
    return null;
  }
}

/** The claim kind from what was claimed, what was found and what git shows. */
function claimKind(claimed: number, missing: number, gitCorroborates: boolean): ClaimVerificationKind {
  if (claimed > 0 && missing === 0) return 'files_verified';
  if (claimed > 0 && gitCorroborates) return 'git_corroborated';
  if (claimed === 0 && gitCorroborates) return 'verified_empty';
  // No claims and no git changes (or no git at all): nothing confirms any work was done.
  if (claimed === 0) return 'unverifiable_no_claims';
  return 'unverified';
}

/**
 * Verifies that a unit agent's self-reported work exists on disk.
 *
 * 1. Stat every path claimed in filesCreated and filesModified (deleted files
 *    are expected to be gone and are not checked).
 * 2. When any claimed path is missing, or none was claimed, ask git whether
 *    the tree changed; a non-empty diff corroborates the work even when a
 *    listed path was wrong.
 *
 * `cwd` is the unit's worktree, or the project root in shared mode.
 */
export function verifyUnitClaims(report: CompletionReport, cwd: string): ClaimVerificationResult {
  if (report.archetype !== 'engineer') {
    return {
      claimedPaths: [],
      foundPaths: [],
      missingPaths: [],
      gitDiffDetected: null,
      kind: 'verified_empty',
      verified: true,
      summary: 'Report is not an implementation report; claim verification skipped.',
    };
  }
  const engineer = report as EngineerReport;
  const claimedPaths = [...engineer.filesCreated, ...engineer.filesModified];
  const foundPaths: string[] = [];
  const missingPaths: string[] = [];
  for (const path of claimedPaths) {
    const absolute = isAbsolute(path) ? path : resolve(cwd, path);
    (existsSync(absolute) ? foundPaths : missingPaths).push(path);
  }

  const gitDiffDetected = missingPaths.length > 0 || claimedPaths.length === 0 ? gitShowsChanges(cwd) : null;
  const kind = claimKind(claimedPaths.length, missingPaths.length, gitDiffDetected === true);
  const verified = kind === 'files_verified' || kind === 'git_corroborated' || kind === 'verified_empty';

  const summaryParts: string[] = [];
  if (claimedPaths.length > 0) {
    summaryParts.push(`${foundPaths.length}/${claimedPaths.length} claimed paths found on disk`);
    if (missingPaths.length > 0) {
      const more = missingPaths.length - SUMMARY_MISSING_LIMIT;
      summaryParts.push(`missing: ${missingPaths.slice(0, SUMMARY_MISSING_LIMIT).join(', ')}${more > 0 ? ` (+${more} more)` : ''}`);
    }
  } else {
    summaryParts.push('no file paths claimed');
  }
  if (gitDiffDetected !== null) summaryParts.push(`git diff: ${gitDiffDetected ? 'changes detected' : 'no changes detected'}`);
  summaryParts.push(`kind: ${kind}`);

  return { claimedPaths, foundPaths, missingPaths, gitDiffDetected, kind, verified, summary: summaryParts.join('; ') };
}

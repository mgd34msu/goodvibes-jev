/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';

/**
 * Structured completion reports, per-archetype output contracts. Agents end
 * their final output with one as a fenced JSON block (the format the agent
 * prompt dictates, read here as a fixed format). The contract runner reads a
 * unit's report to verify its claims (contract/claims.ts) and to take its
 * summary as the unit's answer (contract/answer.ts).
 */

/** Base fields shared by all completion reports. */
export interface BaseCompletionReport {
  version: 1;
  archetype: string;
  summary: string;
}

/** Engineer agent completion report. */
export interface EngineerReport extends BaseCompletionReport {
  archetype: 'engineer';
  gatheredContext: string[];
  plannedActions: string[];
  appliedChanges: string[];
  filesCreated: string[];
  filesModified: string[];
  filesDeleted: string[];
  decisions: Array<{ what: string; why: string }>;
  issues: string[];
  uncertainties: string[];
}

/** Tester agent completion report. */
export interface TesterReport extends BaseCompletionReport {
  archetype: 'tester';
  testsWritten: string[];
  testsPassed: number;
  testsFailed: number;
  coverage?: { lines: number; branches: number; functions: number };
  failures: Array<{ test: string; error: string }>;
}

/** Generic completion report for other archetypes. */
export interface GenericReport extends BaseCompletionReport {
  /** Archetype name, for every archetype other than engineer and tester. */
  archetype: string;
  result: string;
}

export type CompletionReport = EngineerReport | TesterReport | GenericReport;

/** A fenced ```json block: the opening fence on its own line, the closing fence on its own line. */
const JSON_FENCE = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;

/**
 * The report the agent prompt dictates: the LAST fenced ```json block of the
 * output (the report ends the message), whose object has `version` 1 and a
 * string `archetype`. Null when the last block is not such an object, or there
 * is no block. Nothing is read out of prose.
 */
export function parseCompletionReport(rawOutput: string): CompletionReport | null {
  let last: string | undefined;
  for (const match of rawOutput.matchAll(JSON_FENCE)) last = match[1];
  if (last === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(last);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const candidate = parsed as { version?: unknown; archetype?: unknown };
    if (candidate.version === 1 && typeof candidate.archetype === 'string') return parsed as CompletionReport;
  } catch (error) {
    logger.debug('Completion report fenced JSON parse failed', { error: summarizeError(error) });
  }
  return null;
}

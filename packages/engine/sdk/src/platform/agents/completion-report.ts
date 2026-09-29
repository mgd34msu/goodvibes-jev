/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';

/**
 * Structured completion reports, per-archetype output contracts. Agents end
 * their final output with one as a fenced JSON block (the format the agent
 * prompt asks for, read here as a fixed format). The contract runner reads a
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

/** The report at the end of an agent's output: a fenced ```json block, else the object around its `"version"` key; null when there is none. */
export function parseCompletionReport(rawOutput: string): CompletionReport | null {
  // Strategy 1: Find ```json ... ``` block
  const jsonBlockMatch = rawOutput.match(/```json\s*\n(\{[\s\S]*?\})\s*\n```/);
  if (jsonBlockMatch) {
    try {
      const parsed = JSON.parse(jsonBlockMatch[1]!);
      if (parsed.version === 1 && parsed.archetype) return parsed as CompletionReport;
    } catch (error) {
      logger.debug('Completion report fenced JSON parse failed', { error: summarizeError(error) });
    }
  }

  // Strategy 2: Brace-counting extraction, find "version": 1, walk backward for opening {,
  // then forward counting braces to find the matching }. Avoids greedy regex over-matching.
  const versionIdx = rawOutput.indexOf('"version"');
  if (versionIdx !== -1) {
    // Walk backward to find opening brace
    let openBrace = -1;
    for (let i = versionIdx - 1; i >= 0; i--) {
      if (rawOutput[i] === '{') { openBrace = i; break; }
    }
    if (openBrace !== -1) {
      // Walk forward with brace counting to find matching close
      let depth = 0;
      let closeBrace = -1;
      for (let i = openBrace; i < rawOutput.length; i++) {
        if (rawOutput[i] === '{') depth++;
        else if (rawOutput[i] === '}') {
          depth--;
          if (depth === 0) { closeBrace = i; break; }
        }
      }
      if (closeBrace !== -1) {
        const candidate = rawOutput.slice(openBrace, closeBrace + 1);
        try {
          const parsed = JSON.parse(candidate);
          if (parsed.version === 1 && parsed.archetype) return parsed as CompletionReport;
        } catch (error) {
          logger.debug('Completion report brace-count JSON parse failed', { error: summarizeError(error) });
        }
      }
    }
  }

  return null;
}

/**
 * `engine.compaction.fidelity`: does the text a compaction wrote (its handoff
 * note or summary) state the conversation it replaced faithfully? The fidelity
 * pattern: claim = the written text, source = the pre-compaction conversation
 * as compaction views render it (judged-views.ts), with carried messages named
 * by position. No quote is passed; a compaction cites nothing.
 *
 * The quality score uses the probability that the written text contradicts
 * the source (quality-score.ts). Process notes the conversation cannot speak
 * to ("context pressure was above threshold") read as unsupported, which the
 * score does not penalise; misstating what happened does.
 *
 * Band: low stakes. A low score only re-runs a compaction strategy or keeps
 * the full conversation, both reversible.
 */
import { defineFidelityChecker, STAKES_BANDS } from '@goodvibes-jev/judgment';

const BUGFIX_SOURCE = [
  '#1 user: The CSV export in reports/export.ts drops the last row when the file has no trailing newline. Fix it and add a test.',
  '#2 assistant: I will read the exporter first. [calls read {"path":"reports/export.ts"}]',
  '#3 tool result (read): export function toRows(text: string) { const lines = text.split("\\n"); lines.pop(); return lines.map(parseLine); }',
  '#4 assistant: The unconditional lines.pop() removes the last row when there is no trailing newline. I will only drop an empty final line.',
  '#5 user: Good. Keep the parseLine behaviour exactly as it is.',
  '#6 assistant: Changed toRows to drop the final line only when it is empty, and added export.test.ts with a file that has no trailing newline. [calls exec {"command":"bun test reports"}]',
  '#7 tool result (exec): 14 pass, 0 fail',
].join('\n\n');

const DB_SOURCE = [
  '#1 user: We need somewhere to store the scheduler jobs. It runs on one machine, so use SQLite, not Postgres.',
  '#2 assistant: Understood, SQLite through bun:sqlite. I will put the schema in scheduler/db.ts.',
  '#3 assistant: Created scheduler/db.ts with a jobs table (id, cron, command, last_run) and a migration runner.',
  '#4 user: Next, add a command to list the jobs.',
].join('\n\n');

export const compactionFidelity = defineFidelityChecker({
  name: 'engine.compaction.fidelity',
  version: 1,
  description: 'Whether the handoff note or summary a compaction wrote states the conversation it replaced faithfully, or contradicts it.',
  accuracyFloor: 0.9,
  band: STAKES_BANDS.low.confidence,
  fixtures: [
    {
      name: 'summary of a finished bug fix',
      claim: '[Session Summary]\nThe user asked to fix the CSV export dropping the last row when a file has no trailing newline, and to add a test. The cause was an unconditional lines.pop() in toRows; it now drops the final line only when it is empty. parseLine must stay unchanged. export.test.ts was added and the reports tests pass (14 pass, 0 fail).',
      source: BUGFIX_SOURCE,
      expect: 'supported',
    },
    {
      name: 'collapse handoff quoting the last exchange',
      claim: '[Session Collapse: 2026-09-27T10:14:02.000Z]\n4 message(s) collapsed.\n\n## Most Recent Exchange\nUser: Next, add a command to list the jobs.\nAssistant: Created scheduler/db.ts with a jobs table (id, cron, command, last_run) and a migration runner.',
      source: DB_SOURCE,
      expect: 'supported',
    },
    {
      name: 'summary that reverses the database choice',
      claim: '[Session Summary]\nThe scheduler stores its jobs in Postgres, as the user asked. scheduler/db.ts holds the jobs table. Next step: a command to list the jobs.',
      source: DB_SOURCE,
      expect: 'contradicted',
    },
    {
      name: 'summary that says the tests failed',
      claim: '[Session Summary]\nThe CSV export fix is in place, but the new test in export.test.ts fails and the reports suite is red. The fix still needs work.',
      source: BUGFIX_SOURCE,
      expect: 'contradicted',
    },
    {
      name: 'summary that invents a requirement',
      claim: '[Session Summary]\nThe user wants the CSV exporter rewritten to stream rows and to support gzip output before Friday.',
      source: BUGFIX_SOURCE,
      expect: 'unsupported',
    },
    {
      name: 'mechanical handoff note about context pressure',
      claim: '[Session Auto-Compaction]\nContext window pressure was above threshold, automatic compaction applied.',
      source: DB_SOURCE,
      expect: 'unsupported',
    },
  ],
});

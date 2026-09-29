/**
 * The completion report an agent ends its output with (agents/completion-report.ts):
 * the fenced JSON block is read first, then the object around a bare
 * `"version"` key; anything that is not a version-1 report with an archetype
 * is no report.
 */
import { describe, expect, test } from 'bun:test';
import { parseCompletionReport } from '../sdk/src/platform/agents/completion-report.js';

const engineer = {
  version: 1,
  archetype: 'engineer',
  summary: 'Added the parser.',
  gatheredContext: ['src/convert.ts reads stdin'],
  plannedActions: ['write src/csv.ts'],
  appliedChanges: ['src/csv.ts exports parse'],
  filesCreated: ['src/csv.ts'],
  filesModified: [],
  filesDeleted: [],
  decisions: [],
  issues: [],
  uncertainties: [],
};

describe('parseCompletionReport', () => {
  test('reads the fenced json block', () => {
    const output = `Done.\n\n\`\`\`json\n${JSON.stringify(engineer, null, 2)}\n\`\`\`\n`;
    expect(parseCompletionReport(output) as unknown).toEqual(engineer);
  });

  test('reads a bare report object by its version key when there is no fence', () => {
    const output = `All finished ${JSON.stringify({ version: 1, archetype: 'researcher', summary: 'Found it.', result: 'In src/a.ts' })} thanks`;
    expect(parseCompletionReport(output)).toEqual({ version: 1, archetype: 'researcher', summary: 'Found it.', result: 'In src/a.ts' });
  });

  test('a block without version 1 or an archetype is not a report', () => {
    expect(parseCompletionReport('```json\n{"version": 2, "archetype": "engineer", "summary": "x"}\n```')).toBeNull();
    expect(parseCompletionReport('```json\n{"version": 1, "summary": "x"}\n```')).toBeNull();
    expect(parseCompletionReport('no report here')).toBeNull();
    expect(parseCompletionReport('```json\n{"version": 1, "archetype": \n```')).toBeNull();
  });
});

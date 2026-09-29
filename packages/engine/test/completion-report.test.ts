/**
 * The completion report an agent ends its output with (agents/completion-report.ts):
 * only the format the agent prompt dictates is read: the last fenced json
 * block, an object with version 1 and a string archetype. Nothing is salvaged
 * from prose, and an earlier block is not the report.
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

  test('a bare report object in prose is not read', () => {
    const output = `All finished ${JSON.stringify({ version: 1, archetype: 'researcher', summary: 'Found it.', result: 'In src/a.ts' })} thanks`;
    expect(parseCompletionReport(output)).toBeNull();
    expect(parseCompletionReport(`Notes: {"version": 1, "archetype": "engineer"}\n\`\`\`\n{"version": 1, "archetype": "engineer", "summary": "x"}\n\`\`\``)).toBeNull();
  });

  test('the last fenced json block is the report, not the first', () => {
    const early = { ...engineer, summary: 'An example the agent quoted.' };
    const last = { ...engineer, summary: 'The real report.' };
    const output = `Format:\n\`\`\`json\n${JSON.stringify(early)}\n\`\`\`\nDone.\n\`\`\`json\n${JSON.stringify(last, null, 2)}\n\`\`\``;
    expect((parseCompletionReport(output) as unknown as { summary: string }).summary).toBe('The real report.');
  });

  test('a last block that is not a report leaves no report, even when an earlier block is one', () => {
    const output = `\`\`\`json\n${JSON.stringify(engineer)}\n\`\`\`\nThen the config:\n\`\`\`json\n{"strict": true}\n\`\`\``;
    expect(parseCompletionReport(output)).toBeNull();
  });

  test('a report whose archetype is not a string, or that is not an object, is no report', () => {
    expect(parseCompletionReport('```json\n{"version": 1, "archetype": 7, "summary": "x"}\n```')).toBeNull();
    expect(parseCompletionReport('```json\n[{"version": 1, "archetype": "engineer"}]\n```')).toBeNull();
  });

  test('a block without version 1 or an archetype is not a report', () => {
    expect(parseCompletionReport('```json\n{"version": 2, "archetype": "engineer", "summary": "x"}\n```')).toBeNull();
    expect(parseCompletionReport('```json\n{"version": 1, "summary": "x"}\n```')).toBeNull();
    expect(parseCompletionReport('no report here')).toBeNull();
    expect(parseCompletionReport('```json\n{"version": 1, "archetype": \n```')).toBeNull();
  });
});

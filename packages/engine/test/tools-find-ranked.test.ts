/**
 * find content mode with `ranked: true`: the matched files are ordered by the
 * `engine.tools.content-rank` rerank (a fake port here), every match is kept,
 * and no content ranking is requested when ranking is off or only one file matched.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { createFindTool } from '../sdk/src/platform/tools/find/executor.js';

let work: string;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'find-ranked-'));
  mkdirSync(join(work, 'src'), { recursive: true });
  writeFileSync(join(work, 'src', 'use.ts'), "import { parseConfig } from './parse.js';\nconst config = parseConfig(raw);\n");
  writeFileSync(join(work, 'src', 'parse.ts'), 'export function parseConfig(raw: string) {\n  return JSON.parse(raw);\n}\n');
  writeFileSync(join(work, 'notes.md'), 'parseConfig should accept comments.\n');
  writeFileSync(join(work, 'solo.txt'), 'uniqueMarkerWord\n');
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/** Probability per candidate path (relative to the project); unlisted paths read as a strong no. */
let relevance: Map<string, number>;
let requests: ReadonlyArray<{ readonly state: unknown; readonly context?: { readonly battery?: string } }>;
let previous: ReturnType<typeof installJudgmentPort>;

beforeEach(() => {
  relevance = new Map();
  const fake = fakePort((_name, _question, state) => {
    if ('directories' in (state as object)) return noulAnswer(0.01);
    return noulAnswer(relevance.get((state as { candidate: { path: string } }).candidate.path) ?? 0.03);
  });
  requests = fake.requests;
  previous = installJudgmentPort(fake.port);
});

afterEach(() => {
  installJudgmentPort(previous);
});

async function runFind(query: Record<string, unknown>, output: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const tool = createFindTool(work);
  const res = await tool.execute({ queries: [{ id: 'q', ...query }], output });
  expect(res.success).toBe(true);
  return (JSON.parse(res.output as string) as Record<string, Record<string, unknown>>)['q']!;
}

const filesOf = (result: Record<string, unknown>): string[] => (result['files'] as string[]).map((file) => file.slice(work.length + 1));

describe('find content ranked by engine.tools.content-rank', () => {
  test('files come back in the order of their readings, best first', async () => {
    relevance.set('src/parse.ts', 0.95);
    relevance.set('src/use.ts', 0.4);
    relevance.set('notes.md', 0.1);
    const result = await runFind({ mode: 'content', pattern: 'parseConfig', path: '.', ranked: true }, { format: 'files_only' });
    expect(filesOf(result)).toEqual(['src/parse.ts', 'src/use.ts', 'notes.md']);
    expect(requests.filter(request => request.context?.battery === 'engine.tools.content-rank')).toHaveLength(3);
  });

  test('the order follows the probabilities when they change', async () => {
    relevance.set('notes.md', 0.9);
    relevance.set('src/use.ts', 0.6);
    relevance.set('src/parse.ts', 0.2);
    const result = await runFind({ mode: 'content', pattern: 'parseConfig', path: '.', ranked: true }, { format: 'files_only' });
    expect(filesOf(result)).toEqual(['notes.md', 'src/use.ts', 'src/parse.ts']);
  });

  test('when no file reads as relevant every match is still returned', async () => {
    const result = await runFind({ mode: 'content', pattern: 'parseConfig', path: '.', ranked: true });
    expect(result['count']).toBe(4);
    expect(new Set((result['matches'] as Array<{ file: string }>).map((m) => m.file.slice(work.length + 1)))).toEqual(
      new Set(['src/parse.ts', 'src/use.ts', 'notes.md']),
    );
  });

  test('the reading sees the searched pattern, not the whole-word wrapping, and each file\'s numbered matching lines', async () => {
    relevance.set('src/parse.ts', 0.95);
    await runFind({ mode: 'content', pattern: 'parseConfig', whole_word: true, path: 'src', ranked: true });
    const states = requests.filter(request => request.context?.battery === 'engine.tools.content-rank').map((request) => request.state as { query: string; candidate: { path: string; matching_lines: string } });
    expect(states.every((state) => state.query === 'parseConfig')).toBe(true);
    expect(states.find((state) => state.candidate.path === 'src/parse.ts')!.candidate.matching_lines).toBe('1: export function parseConfig(raw: string) {');
    expect(states.find((state) => state.candidate.path === 'src/use.ts')!.candidate.matching_lines).toBe(
      "1: import { parseConfig } from './parse.js';\n2: const config = parseConfig(raw);",
    );
  });

  test('content is not ranked without ranked, or when only one file matched', async () => {
    await runFind({ mode: 'content', pattern: 'parseConfig', path: '.' });
    await runFind({ mode: 'content', pattern: 'uniqueMarkerWord', path: '.', ranked: true });
    expect(requests.filter(request => request.context?.battery === 'engine.tools.content-rank')).toHaveLength(0);
  });
});

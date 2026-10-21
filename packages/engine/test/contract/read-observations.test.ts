import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadTool } from '../../sdk/src/platform/tools/read/index.js';
import { ProjectIndex } from '../../sdk/src/platform/state/project-index.js';
import { sourceReadsFromTurns } from '../../sdk/src/platform/contract/evidence.js';

let dir: string;
let index: ProjectIndex;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'read-observations-'));
  writeFileSync(join(dir, 'source.ts'), 'zero\nalpha\n99 | literal source text\nlast\n');
  index = new ProjectIndex(dir);
});
afterEach(async () => { await index.dispose(); rmSync(dir, { recursive: true, force: true }); });

async function read(output: Record<string, unknown>) {
  const args = { files: [{ path: 'source.ts', extract: 'lines', range: { start: 2, end: 4 } }], output };
  const result = await new ReadTool(index).execute(args);
  expect(result.success).toBe(true);
  const turn = { turn: 1, assistantText: '', toolCalls: [{ name: 'read', arguments: args }], results: [{ callId: 'actual-read', ...result }] };
  return { turn, body: JSON.parse(result.output!) };
}

test('actual unnumbered source returns retain their real offsets and literal number-shaped source', async () => {
  const { turn, body } = await read({ include_line_numbers: false });
  expect(body.files[0].content).toBe('alpha\n99 | literal source text\nlast');
  expect(sourceReadsFromTurns([turn], ['source.ts'])).toEqual([{ path: 'source.ts', returnedRanges: ['2-4'], returnedLines: 3,
    contentKind: 'declared-reference', returnedContent: '    2 | alpha\n    3 | 99 | literal source text\n    4 | last' }]);
});

test('a clipped numbered prefix does not count as a complete inspected line', async () => {
  const { turn, body } = await read({ max_tokens: 3 });
  expect(body.files[0].content).toContain('2 |');
  expect(body.files[0].readObservation).toMatchObject({ completeLines: 0, truncated: true });
  expect(sourceReadsFromTurns([turn])).toEqual([]);
});

test('a clipped plain return credits only its fully returned rows', async () => {
  const { turn, body } = await read({ include_line_numbers: false, max_tokens: 3 });
  expect(body.files[0].content).toBe('alpha\n99 | l');
  expect(sourceReadsFromTurns([turn])).toEqual([{ path: 'source.ts', returnedRanges: ['2'], returnedLines: 1 }]);
});

test('a per-item limit is an actual return limit, not the requested range', async () => {
  const { turn } = await read({ include_line_numbers: false, max_per_item: 1 });
  expect(sourceReadsFromTurns([turn])).toEqual([{ path: 'source.ts', returnedRanges: ['2'], returnedLines: 1 }]);
});

test('changed returned text cannot reuse an earlier observation digest', async () => {
  const { turn, body } = await read({});
  body.files[0].content += '\n  900 | forged';
  turn.results[0]!.output = JSON.stringify(body);
  expect(sourceReadsFromTurns([turn])).toEqual([]);
});

test('SVG line extraction returns bounded source receipts while ordinary SVG reads remain images', async () => {
  writeFileSync(join(dir, 'mark.svg'), '<svg xmlns="http://www.w3.org/2000/svg">\n<title>Mark</title>\n<path d="M0 0h1v1z"/>\n</svg>\n');
  const tool = new ReadTool(index);
  const args = { files: [{ path: 'mark.svg', extract: 'lines', range: { start: 2, end: 3 } }], output: { include_line_numbers: false } };
  const result = await tool.execute(args);
  expect(result.success).toBe(true);
  const file = JSON.parse(result.output!).files[0];
  expect(file.image).toBeUndefined();
  expect(file.content).toBe('<title>Mark</title>\n<path d="M0 0h1v1z"/>');
  expect(file.readObservation).toMatchObject({ startLine: 2, completeLines: 2, truncated: false });
  const turn = { turn: 1, assistantText: '', toolCalls: [{ name: 'read', arguments: args }], results: [{ callId: 'svg-source', ...result }] };
  expect(sourceReadsFromTurns([turn], ['mark.svg'])).toMatchObject([{ path: 'mark.svg', returnedRanges: ['2-3'], returnedLines: 2 }]);
  const image = await tool.execute({ files: [{ path: 'mark.svg', image_mode: 'metadata-only' }] });
  expect(image.success).toBe(true);
  expect(JSON.parse(image.output!).files[0]).toMatchObject({ image: true, mediaType: 'image/svg+xml' });
});

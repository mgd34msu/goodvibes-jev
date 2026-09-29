/**
 * What an oversized tool output shows inline: the blocks
 * engine.tools.output-keep ranks highest against the call that produced the
 * output, as many as fit the budget, in their original order.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keepForCall, OverflowHandler, outputBlocks } from '../sdk/src/platform/tools/shared/overflow.js';
import { useToolReadings } from './_helpers/tool-readings.ts';

const readings = useToolReadings([['FAILURE_SUMMARY', { needed: true }]]);

describe('outputBlocks', () => {
  test('cuts at line breaks and splits a line longer than a block; the blocks join back to the content', () => {
    const content = `short line\n${'x'.repeat(25)}\nanother\n`;
    const blocks = outputBlocks(content, 10);
    expect(blocks.map((block) => block.text).join('')).toBe(content);
    expect(blocks.every((block) => block.text.length <= 10)).toBe(true);
    expect(blocks[0]).toEqual({ start: 0, text: 'short line' });
    expect(blocks.map((block) => block.start)).toEqual(blocks.map((_, i) => blocks.slice(0, i).reduce((sum, b) => sum + b.text.length, 0)));
  });
});

describe('keepForCall', () => {
  test('keeps the block the reading wants, wherever it sits, and marks what was left out', async () => {
    const lines = Array.from({ length: 200 }, (_, i) => `(pass) case ${i}`);
    lines.splice(80, 0, 'FAILURE_SUMMARY: 1 fail');
    const content = lines.join('\n');
    const kept = await keepForCall(content, 400, 'bun test');
    expect(kept).toContain('FAILURE_SUMMARY: 1 fail');
    expect(kept).toMatch(/\[\.\.\. \d+ chars omitted \.\.\.\]/);
    const shownChars = kept.replace(/\n?\[\.\.\. \d+ chars omitted \.\.\.\]\n?/g, '').length;
    expect(shownChars).toBeLessThanOrEqual(400);
    const request = readings.requests[0]!;
    expect((request.state as { query: string }).query).toBe('bun test');
    expect(readings.requests.length).toBe(outputBlocks(content, 50).length);
  });

  test('kept blocks stay in their original order', async () => {
    const filler = Array.from({ length: 40 }, (_, i) => `filler line ${i} `.padEnd(45, '.'));
    const content = ['alpha FAILURE_SUMMARY one', ...filler, 'omega FAILURE_SUMMARY two'].join('\n');
    const kept = await keepForCall(content, 400, 'make check');
    expect(kept.indexOf('alpha')).toBeGreaterThanOrEqual(0);
    expect(kept.indexOf('alpha')).toBeLessThan(kept.indexOf('omega'));
  });
});

describe('OverflowHandler.handle', () => {
  const handler = () => new OverflowHandler({ baseDir: mkdtempSync(join(tmpdir(), 'gv-overflow-keep-')) });

  test('content within the limit is returned unchanged and nothing is read', async () => {
    const result = await handler().handle('short content', { maxChars: 1000, call: 'ls' });
    expect(result).toEqual({ content: 'short content' });
    expect(readings.requests).toHaveLength(0);
  });

  test('oversized content is spilled and shows the kept blocks with the reference', async () => {
    const content = `${'progress line\n'.repeat(300)}FAILURE_SUMMARY: 2 failed\n${'progress line\n'.repeat(300)}`;
    const result = await handler().handle(content, { maxChars: 800, label: 'stdout', call: 'bun test' });
    expect(result.content).toContain('FAILURE_SUMMARY: 2 failed');
    expect(result.content).toMatch(/truncated\. Full output: \.goodvibes\/\.overflow\/\d+-stdout\.txt/);
    expect(result.overflowRef).toMatch(/^file:/);
  });
});

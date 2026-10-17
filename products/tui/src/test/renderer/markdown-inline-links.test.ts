import { expect, test } from 'bun:test';
import { renderInlineMarkdown } from '../../renderer/markdown-inline.ts';
import { renderMarkdown } from '../../renderer/markdown.ts';
import { TerminalBuffer } from '../../renderer/buffer.ts';
import { DiffEngine } from '../../renderer/diff.ts';

test('untrusted hyperlink targets cannot emit terminal controls through markdown or direct cells', () => {
  const targets = ['https://example.com/\x1b\\\x1b]52;c;marker\x07', 'https://example.com/\x9c\x9d52;c;marker', 'javascript:alert', 'https://example.com/\nmarker'];
  for (const target of targets) {
    const lines = renderMarkdown(`[label](${target})`, 80);
    expect(renderInlineMarkdown(`[label](${target})`).some(token => token.type === 'link')).toBe(false);
    const buffer = new TerminalBuffer(80, Math.max(1, lines.length));
    lines.forEach((line, row) => buffer.blitLine(row, line));
    const engine = new DiffEngine();
    const output = engine.diff(null, buffer);
    expect(output).not.toContain('\x1b]52;');
    expect(output).not.toContain('\x9d');
    const direct = new TerminalBuffer(1, 1);
    direct.setCell(0, 0, { char: 'x', link: target });
    expect(engine.diff(null, direct)).not.toContain('\x1b]8;;');
  }
  for (const target of ['https://example.com/page', 'file:///tmp/file.ts', 'mailto:user@example.com']) {
    const lines = renderMarkdown(`[label](${target})`, 80);
    const buffer = new TerminalBuffer(80, lines.length);
    lines.forEach((line, row) => buffer.blitLine(row, line));
    expect(new DiffEngine().diff(null, buffer)).toContain(`\x1b]8;;${target}\x1b\\`);
  }
});

test('bare links work at the start, inside prose, and beside punctuation', () => {
  const source = 'https://example.com/a_b See https://example.org. Open (/home/user/my_file.ts), then /tmp/other.ts!';
  const tokens = renderInlineMarkdown(source);
  expect(tokens.filter(t => t.type === 'link').map(t => t.url)).toEqual([
    'https://example.com/a_b', 'https://example.org', 'file:///home/user/my_file.ts', 'file:///tmp/other.ts',
  ]);
  expect(tokens.map(t => t.text).join('')).toBe(source);
  expect(renderInlineMarkdown('`https://example.com`')[0]?.type).toBe('code');
  expect(renderInlineMarkdown('relative/path/file.ts').some(t => t.type === 'link')).toBe(false);
});

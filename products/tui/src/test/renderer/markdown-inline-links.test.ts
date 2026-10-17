import { expect, test } from 'bun:test';
import { renderInlineMarkdown } from '../../renderer/markdown-inline.ts';

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

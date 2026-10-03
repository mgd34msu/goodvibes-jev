import { activeTokens } from '../../renderer/theme.ts';
import { describe, test, expect } from 'bun:test';
import { renderMarkdown, renderMarkdownTracked, renderInlineMarkdown } from '../../renderer/markdown.ts';
import { lineToString, linesToText } from '../setup.ts';

const WIDTH = 80;

/** Extract plain text from a Line (Cell[]). */
const lineText = lineToString;

/** Get all non-empty text lines from a render result. */
function textLines(lines: import('@goodvibes-jev/engine/sdk/platform/types').Line[]): string[] {
  return linesToText(lines).filter((t) => t.length > 0);
}

describe('renderMarkdown', () => {
  test('returns Line array', () => {
    const result = renderMarkdown('hello', WIDTH);
    expect(result).toEqual(expect.any(Array));
    expect(result.length).toBeGreaterThan(0);
  });

  test('each line has correct width', () => {
    const result = renderMarkdown('hello world', WIDTH);
    for (const line of result) {
      expect(line.length).toBe(WIDTH);
    }
  });

  test('renders plain paragraph text', () => {
    const result = renderMarkdown('hello world', WIDTH);
    const text = textLines(result).join(' ');
    expect(text).toContain('hello world');
  });

  test('renders an H1 heading in its own case, bold, in the heading color', () => {
    const result = renderMarkdown('# My Title', WIDTH);
    const text = textLines(result).join('\n');
    expect(text).toContain('My Title');
    expect(text).not.toContain('MY TITLE');
    const cell = result[0]!.find((c) => c.char === 'M')!;
    expect(cell.bold).toBe(true);
    expect(cell.fg).toBe(activeTokens().markdownHeading);
  });

  test('headings carry no rule row', () => {
    for (const md of ['# One', '## Two', '### Three']) {
      expect(renderMarkdown(md, WIDTH)).toHaveLength(1);
    }
  });

  test('exactly one blank row around code, tables, quotes and rules', () => {
    const md = ['before', '', '', '', '```ts', 'x', '```', 'between', '> q', 'after', '---', '| a | b |', '|---|---|', '| 1 | 2 |', 'end'].join('\n');
    // A row on a fill (the code block's padding) is not a blank row.
    const rows = renderMarkdown(md, WIDTH).map((line) => (line.some((c) => c.bg) ? '#fill' : lineToString(line).trim()));
    for (let i = 1; i < rows.length; i++) expect(rows[i] === '' && rows[i - 1] === '').toBe(false);
    const idx = (needle: string) => rows.findIndex((r) => r.includes(needle));
    expect(rows[idx('between') - 1]).toBe('');
    expect(rows[idx('between') + 1]).toBe('');
    expect(rows[idx('after') - 1]).toBe('');
    expect(rows[idx('after') + 1]).toBe('');
    expect(rows[idx('end') - 1]).toBe('');
  });

  test('prose starts at column 5 and wraps before width-5', () => {
    const rows = textLines(renderMarkdown('word '.repeat(40), 60));
    for (const row of rows) {
      expect(row.startsWith('     ')).toBe(true);
      expect(row.trimEnd().length).toBeLessThanOrEqual(55);
    }
  });

  test('renders H3 heading', () => {
    const result = renderMarkdown('### Subsection', WIDTH);
    const text = textLines(result).join('\n');
    expect(text).toContain('Subsection');
  });

  test('renders unordered list with bullet', () => {
    const result = renderMarkdown('- item one\n- item two', WIDTH);
    const text = textLines(result).join('\n');
    expect(text).toContain('•');
    expect(text).toContain('item one');
    expect(text).toContain('item two');
  });

  test('renders ordered list', () => {
    const result = renderMarkdown('1. first\n2. second', WIDTH);
    const text = textLines(result).join('\n');
    expect(text).toContain('first');
    expect(text).toContain('second');
    expect(text).toContain('1.');
  });

  test('renders horizontal rule', () => {
    const result = renderMarkdown('---', WIDTH);
    const text = textLines(result).join('');
    expect(text).toContain('─');
  });

  test('renders blockquote', () => {
    const result = renderMarkdown('> quoted text', WIDTH);
    const text = textLines(result).join('\n');
    expect(text).toContain('│');
    expect(text).toContain('quoted text');
  });

  test('renders fenced code block', () => {
    const md = '```ts\nconst x = 1;\n```';
    const result = renderMarkdown(md, WIDTH);
    const text = textLines(result).join('\n');
    expect(text).toContain('x');
    expect(result.length).toBeGreaterThan(0);
  });

  test('handles unclosed code block gracefully', () => {
    const md = '```ts\nconst x = 1;';
    const result = renderMarkdown(md, WIDTH);
    expect(result).toEqual(expect.any(Array));
    const text = textLines(result).join('\n');
    expect(text).toContain('x');
  });

  test('handles empty string input', () => {
    const result = renderMarkdown('', WIDTH);
    expect(result).toHaveLength(1);
    const [blankLine] = result;
    if (blankLine === undefined) {
      throw new Error('Expected blank markdown line for empty input');
    }
    expect(blankLine).toHaveLength(WIDTH);
    expect(lineText(blankLine)).toBe('');
  });

  test('H1 heading cells are bold', () => {
    const result = renderMarkdown('# Bold Title', WIDTH);
    // First non-space, non-empty line should have bold cells
    const firstContentLine = result.find((l) =>
      l.find((c) => c.char !== ' ' && c.char !== '') !== undefined
    );
    if (firstContentLine === undefined) {
      throw new Error('Expected H1 content line');
    }
    const contentCells = firstContentLine.filter((c) => c.char !== ' ' && c.char !== '');
    expect(contentCells.map((c) => c.bold)).toContain(true);
  });
});


  test('renders GitHub-style pipe tables', () => {
    const md = [
      'Summary of Best Practices',
      '| Feature | In-Memory Implementation | Redis/Distributed Implementation |',
      '| :--- | :--- | :--- |',
      '| Use Case | CLI tools, single-process scripts. | Production APIs, Microservices. |',
      '| Complexity | Low (Standard Class). | Medium (Requires Lua scripting). |',
    ].join('\n');
    const result = renderMarkdown(md, WIDTH);
    const text = textLines(result).join('\n');
    expect(text).toContain('┌');
    expect(text).toContain('Feature');
    expect(text).toContain('Use Case');
    expect(text).toContain('Redis/Distributed');
    expect(text).toContain('┬');
  });

  test('tracked markdown preserves table rendering for assistant content', () => {
    const md = [
      'Summary of Best Practices',
      '| Feature | In-Memory Implementation | Redis/Distributed Implementation |',
      '| :--- | :--- | :--- |',
      '| Use Case | CLI tools, single-process scripts. | Production APIs, Microservices. |',
      '| Race Conditions | Possible if using async logic. | Prevented via Redis Atomicity/Lua. |',
    ].join('\n');
    const result = renderMarkdownTracked(md, WIDTH);
    const text = textLines(result.lines).join('\n');
    expect(text).toContain('┌');
    expect(text).toContain('Feature');
    // "Race Conditions" is wider than its column, so it wraps onto a second
    // physical line, both halves are present and nothing is ellipsized.
    // (This assertion previously read 'Race Condit', which was the truncated
    // form the old ellipsizing renderer produced.)
    expect(text).toContain('Race');
    expect(text).toContain('Conditions');
    expect(text).not.toContain('…');
    expect(text).toContain('┴');
  });


  test('renders tables with malformed alignment rows tolerantly', () => {
    const md = [
      '| Algorithm | Pros | Cons | Best Use Case |',
      '| :--- ability | :--- | :--- | :--- |',
      '| Fixed Window | Extremely fast/simple. | Boundary problem | Simple API throttling. |',
      '| Token Bucket | Allows bursts while maintaining a steady rate. | Slightly more complex math. | Most Web APIs & Microservices. |',
    ].join('\n');
    const result = renderMarkdownTracked(md, WIDTH);
    const text = textLines(result.lines).join('\n');
    expect(text).toContain('┌');
    expect(text).toContain('Algori');
    expect(text).toContain('Token');
    expect(text).toContain('┼');
  });

describe('renderInlineMarkdown', () => {
  test('returns text token for plain text', () => {
    const tokens = renderInlineMarkdown('hello');
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens).toContainEqual(expect.objectContaining({
      type: 'text',
      text: expect.stringContaining('hello'),
    }));
  });

  test('identifies bold tokens (type=text with bold style)', () => {
    const tokens = renderInlineMarkdown('**bold**');
    // Bold is represented as { type: 'text', style: { bold: true } }
    expect(tokens).toContainEqual(expect.objectContaining({
      type: 'text',
      style: expect.objectContaining({ bold: true }),
    }));
  });

  test('identifies italic tokens (type=text with italic style)', () => {
    const tokens = renderInlineMarkdown('_italic_');
    // Italic is represented as { type: 'text', style: { italic: true } }
    expect(tokens).toContainEqual(expect.objectContaining({
      type: 'text',
      style: expect.objectContaining({ italic: true }),
    }));
  });

  test('identifies inline code tokens', () => {
    const tokens = renderInlineMarkdown('`code`');
    expect(tokens.map((t) => t.type)).toContain('code');
  });

  test('handles mixed inline markdown', () => {
    const tokens = renderInlineMarkdown('text **bold** and `code`');
    expect(tokens.map((t) => t.type)).toContain('text');
    // Bold produces a text token with bold style
    expect(tokens).toContainEqual(expect.objectContaining({
      type: 'text',
      style: expect.objectContaining({ bold: true }),
    }));
    expect(tokens.map((t) => t.type)).toContain('code');
  });
});

describe('wrapped prose continuation rows', () => {
  const PROSE = 'withRetry calls fn up to attempts times with exponential backoff and jitter between tries. The test does not cover backoff; it only checks the success path.';

  // Widths 64 and 66 put a space exactly on the wrap column; before the fix
  // the break space moved to the next row and the row began at column 6.
  test('every wrapped row starts at the text column, whatever the width', () => {
    for (let width = 40; width <= 130; width++) {
      const rows = linesToText(renderMarkdown(PROSE, width)).filter((r) => r.trim().length > 0);
      for (const row of rows) {
        expect({ width, col: row.search(/\S/) }).toEqual({ width, col: 5 });
      }
    }
  });

  test('the break keeps every word and drops only the break space', () => {
    const rows = linesToText(renderMarkdown(PROSE, 64)).filter((r) => r.trim().length > 0);
    expect(rows.map((r) => r.trim()).join(' ')).toBe(PROSE);
  });

  test('list items and code blocks keep their deliberate indentation', () => {
    const md = '- first item that is long enough to wrap onto a second row at this narrow width\n\n```ts\nfunction f() {\n    return 1;\n}\n```';
    const rows = linesToText(renderMarkdown(md, 50));
    const item = rows.findIndex((r) => r.includes('first item'));
    const bulletCol = rows[item]!.search(/\S/);
    const cont = rows[item + 1]!;
    expect(cont.search(/\S/)).toBeGreaterThan(bulletCol);
    const body = rows.find((r) => r.includes('return 1;'))!;
    const open = rows.find((r) => r.includes('function f()'))!;
    expect(body.indexOf('return') - open.indexOf('function')).toBe(4);
  });
});

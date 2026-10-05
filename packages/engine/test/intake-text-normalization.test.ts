import { describe, expect, test } from 'bun:test';
import {
  digestSender, normalizeWhitespace, sha256First, stripMarkup,
} from '../sdk/src/platform/intake/text-normalization.js';

const text = (input: string): string => normalizeWhitespace(stripMarkup(input));
function multipart(parts: readonly (readonly [string, string])[], boundary = 'BOUNDARY', newline = '\r\n'): string {
  return [...parts.flatMap(([type, body]) => [`--${boundary}`, `Content-Type: ${type}`, '', body]), `--${boundary}--`].join(newline);
}

describe('retained upstream mapping behavior (structural functions only)', () => {
  test('returns a stable 16-hex-char digest, never the raw id', () => {
    const raw = 'U-some-workspace-user';
    const digest = digestSender(raw);
    expect(digest).toMatch(/^[0-9a-f]{16}$/);
    expect(digest).not.toContain(raw);
    expect(digestSender(raw)).toBe(digest);
  });
  test('distinct fixture ids produce distinct digests', () => {
    expect(digestSender('alice')).not.toBe(digestSender('bob'));
  });
  test('sha256First slices the hex digest to the requested width', () => {
    expect(sha256First('hello', 12)).toHaveLength(12);
    expect(sha256First('hello', 64)).toHaveLength(64);
  });
  test('strips HTML tags and decodes entities', () => {
    const out = stripMarkup('<p>Hi &amp; <b>bye</b></p>');
    expect(out).not.toContain('<');
    expect(out).toContain('&');
    expect(out).toContain('Hi');
  });
  test('drops script/style bodies entirely', () => {
    const out = stripMarkup('<style>.x{color:red}</style><script>steal()</script>visible');
    expect(out).not.toContain('steal');
    expect(out).not.toContain('color:red');
    expect(out).toContain('visible');
  });
  test('extracts the text/plain part of a multipart MIME body', () => {
    const mime = multipart([['text/plain', 'plain version here'], ['text/html', '<p>html version</p>']]);
    const out = text(mime);
    expect(out).toContain('plain version here');
    expect(out).not.toContain('html version');
  });
});

describe('sender digest contract', () => {
  test('pins SHA-256 UTF-8 output and empty input', () => {
    expect(sha256First('hello', 64)).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    expect(digestSender('')).toBe('e3b0c44298fc1c14');
    expect(digestSender('hello')).toBe('2cf24dba5fb0a30e');
    expect(sha256First('こんにちは', 64)).toBe('125aeadf27b0459b8760c13a3d80912dfa8a81a68261906f60d87f4a0268646c');
  });
  test('preserves upstream slice width coercion and bounds', () => {
    for (const width of [0, -1, -Infinity, NaN]) expect(sha256First('hello', width)).toBe('');
    expect(sha256First('hello', 3.9)).toBe('2cf');
    expect(sha256First('hello', Infinity)).toHaveLength(64);
    expect(sha256First('hello', 100)).toHaveLength(64);
  });
  test('does not normalize case, whitespace or Unicode in sender ids', () => {
    expect(digestSender('Alice')).not.toBe(digestSender('alice'));
    expect(digestSender('alice ')).not.toBe(digestSender('alice'));
    expect(digestSender('\u00e9')).not.toBe(digestSender('e\u0301'));
  });
});

describe('MIME structure', () => {
  test.each(['\r\n', '\n'])('prefers plain even after HTML using %j line endings', (newline) => {
    expect(text(multipart([['text/html', '<p>HTML first</p>'], ['text/plain', 'plain last']], 'B', newline))).toBe('plain last');
  });
  test('selects the first plain part including an empty one', () => {
    expect(text(multipart([['text/plain', 'first'], ['text/plain', 'second']]))).toBe('first');
    expect(text(multipart([['text/plain', '  '], ['text/html', '<p>fallback</p>']]))).toBe('');
  });
  test('selects the first HTML part when no plain part exists', () => {
    expect(text(multipart([['image/png', 'ignored'], ['text/html', '<b>first</b>'], ['text/html', 'second']]))).toBe('first');
  });
  test('falls back to original text when no supported part exists', () => {
    expect(text(multipart([['application/octet-stream', 'opaque body']]))).toBe('opaque body --BOUNDARY--');
  });
  test('matches content type case-insensitively and ignores parameters', () => {
    expect(text(multipart([['TEXT/PLAIN; charset=utf-8', 'plain']]).replace('Content-Type', 'cOnTeNt-TyPe'))).toBe('plain');
  });
  test('escapes regular-expression metacharacters in the literal boundary', () => {
    expect(text(multipart([['text/plain', 'plain'], ['text/html', '<p>HTML</p>']], 'b.*+?^${}()|[]\\z'))).toBe('plain');
  });
  test('skips malformed parts without the header separator or a content type', () => {
    const malformed = ['--B', 'Content-Type: text/plain', 'missing separator', '--B', 'X-Other: yes', '', 'unknown', '--B', 'Content-Type: text/html', '', '<p>fallback</p>', '--B--'].join('\n');
    expect(text(malformed)).toBe('fallback');
  });
  test('handles unterminated parts without throwing or inventing a body', () => {
    expect(text('--B\nContent-Type: text/plain\n\nbody')).toBe('body');
    expect(text('--B\nContent-Type: text/plain\nno separator')).toBe('no separator');
  });
  test('removes supported Content and MIME header lines from a single part', () => {
    const input = ['MIME-Version: 1.0', 'Content-Type: text/plain', 'Content-Transfer-Encoding: 8bit', 'Content-Disposition: inline', 'Content-ID: fixture', '', 'body'].join('\r\n');
    expect(text(input)).toBe('body');
  });
  test('retains the upstream line-oriented header removal and final-line limit', () => {
    expect(stripMarkup('before\nContent-Type: text/plain\nafter')).toBe('before\nafter');
    expect(stripMarkup('Content-Type: text/plain')).toBe('Content-Type: text/plain');
    expect(stripMarkup('X-Content-Type: text/plain\nbody')).toBe('X-Content-Type: text/plain\nbody');
    expect(stripMarkup('Content-Type: text/plain\n charset=utf-8\nbody')).toBe(' charset=utf-8\nbody');
  });
  test('does not decode MIME transfer encodings', () => {
    expect(text('Content-Transfer-Encoding: base64\n\nSGVsbG8=')).toBe('SGVsbG8=');
    expect(text('Content-Transfer-Encoding: quoted-printable\n\nhello=20world')).toBe('hello=20world');
  });
});

describe('HTML and whitespace structure', () => {
  test('complete script/style blocks with attributes and varied case are removed', () => {
    expect(text('before<SCRIPT type="text/plain">hidden\nbody</SCRIPT><Style>.hidden{}</sTyLe>after')).toBe('before after');
  });
  test('supported block tags separate text while inline tags join text', () => {
    expect(text('<h1>one</h1><div>two<br>three</div><ul><li>four</li></ul><table><tr>five</tr></table><blockquote>six</blockquote><hr><p>seven</p>')).toBe('one two three four five six seven');
    expect(text('a<b>b</b><span>c</span>')).toBe('abc');
  });
  test('removes comments and other complete markup with the upstream grammar', () => {
    expect(text('<!DOCTYPE html><!-- hidden --><p>shown</p>')).toBe('shown');
  });
  test('keeps stray less-than signs and incomplete markup literal', () => {
    expect(stripMarkup('x < 3 and y > 2')).toBe('x < 3 and y > 2');
    expect(stripMarkup('hello <b')).toBe('hello <b');
    expect(stripMarkup('unclosed <script>body')).toBe('unclosed body');
  });
  test('does not promise HTML sanitizer idempotence after entity decoding', () => {
    expect(stripMarkup('&lt;b&gt;literal&lt;/b&gt;')).toBe('<b>literal</b>');
    expect(stripMarkup('&lt;script&gt;literal&lt;/script&gt;')).toBe('<script>literal</script>');
  });
  test('whitespace normalization is a separate explicit operation', () => {
    expect(stripMarkup('  plain\t text\r\n')).toBe('  plain\t text\r\n');
    expect(normalizeWhitespace(' \t one\r\n two\u00a0three\u2028four\ufeff ')).toBe('one two three four');
    expect(normalizeWhitespace('')).toBe('');
    expect(text('<p>one</p><p>two</p>')).toBe('one two');
  });
  test('does not truncate or redact content', () => {
    const fixture = 'Contact fixture@example.invalid at +1 (555) 123-4567; token=EXAMPLE-ONLY';
    expect(text(fixture)).toBe(fixture);
    expect(text('x'.repeat(1000))).toHaveLength(1000);
  });
});

describe('entity decoding', () => {
  test('decodes only the retained named set, case-insensitively', () => {
    expect(stripMarkup('&amp; &LT; &gt; &quot; &#39; &apos; &nbsp;')).toBe('& < > " \' \'  ');
    expect(stripMarkup('&copy; &unknown; &AMP')).toBe('&copy; &unknown; &AMP');
  });
  test('preserves the named-then-decimal single-pass order', () => {
    expect(stripMarkup('&amp;lt; &amp;#65; &#38;lt;')).toBe('&lt; A &lt;');
  });
  test('decodes decimal scalar values including astral characters and endpoints', () => {
    for (const code of [0, 9, 32, 65, 127, 0xd7ff, 0xe000, 0xffff, 0x10000, 0x1f600, 0x10ffff]) {
      expect(stripMarkup(`&#${code};`)).toBe(String.fromCodePoint(code));
    }
    expect(stripMarkup('&#0000065;')).toBe('A');
  });
  test('keeps every surrogate decimal entity literal', () => {
    const entities = Array.from({ length: 0x800 }, (_, index) => `&#${0xd800 + index};`).join('');
    expect(stripMarkup(entities)).toBe(entities);
  });
  test.each(['&#1114112;', '&#9999999;', '&#55296;', '&#57343;', '&#-1;', '&#x41;', '&#X1F600;', '&#;', '&#1.0;', '&#12345678;', '&#00000065;', '&#65', '&# 65;', '&##65;'])('keeps invalid or unsupported entity %s literal', (entity) => {
    expect(stripMarkup(entity)).toBe(entity);
  });
  test('valid and malformed entities can coexist without throwing', () => {
    expect(stripMarkup('<p>&#65;&#9999999;&#128512;&#55296;</p>')).toBe(' A&#9999999;😀&#55296; ');
  });
});

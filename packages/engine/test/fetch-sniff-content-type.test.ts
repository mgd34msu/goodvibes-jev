/**
 * fetch sniffContentType: a body with no declared type is JSON only when it
 * parses as JSON, not because its first character is { or [.
 */
import { describe, expect, test } from 'bun:test';
import { sniffContentType } from '../sdk/src/platform/tools/fetch/extract.ts';

describe('sniffContentType', () => {
  test('a body that parses as JSON is JSON', () => {
    expect(sniffContentType('', '{"ok":true}')).toBe('application/json');
    expect(sniffContentType('application/octet-stream', ' [1, 2, 3]')).toBe('application/json');
  });

  test('a body that only starts with a brace or bracket is not JSON', () => {
    expect(sniffContentType('', '[INFO] server started on :8080\n[INFO] ready')).toBe('');
    expect(sniffContentType('application/octet-stream', '{{ template }} not json')).toBe('application/octet-stream');
  });

  test('html and xml prefixes are recognised, and a declared type is kept', () => {
    expect(sniffContentType('', '<!DOCTYPE html><html></html>')).toBe('text/html');
    expect(sniffContentType('', '<?xml version="1.0"?><a/>')).toBe('application/xml');
    expect(sniffContentType('text/plain', '{"ok":true}')).toBe('text/plain');
  });
});

import { describe, test, expect } from 'bun:test';
import { escapeAppleScript } from '@goodvibes-jev/engine/sdk/platform/utils';

describe('escapeAppleScript', () => {
  test('escapes double quotes', () => {
    expect(escapeAppleScript('say "hello"')).toBe('say \\"hello\\"');
  });

  test('escapes backslashes', () => {
    expect(escapeAppleScript('path\\to\\file')).toBe('path\\\\to\\\\file');
  });

  test('escapes backslashes before quotes', () => {
    expect(escapeAppleScript('he said \\"hi\\"')).toBe('he said \\\\\\"hi\\\\\\"');
  });

  test('leaves safe strings unchanged', () => {
    expect(escapeAppleScript('hello world')).toBe('hello world');
  });

  test('handles empty string', () => {
    expect(escapeAppleScript('')).toBe('');
  });
});

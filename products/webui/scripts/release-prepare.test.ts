import { describe, expect, test } from 'bun:test';
import { rewriteCacheBustText } from './release-prepare';

describe('workspace asset preparation', () => {
  test('updates all versioned assets while preserving other query parameters', () => {
    const html = '<link href="/icon.png?v=1.0.0&mode=dark"><link href="/manifest.json?v=old">';
    expect(rewriteCacheBustText(html, '2.0.0')).toBe('<link href="/icon.png?v=2.0.0&mode=dark"><link href="/manifest.json?v=2.0.0">');
  });
  test('refuses missing versioned assets and invalid versions', () => {
    expect(() => rewriteCacheBustText('<html></html>', '2.0.0')).toThrow('no ?v=');
    expect(() => rewriteCacheBustText('<link href="/icon?v=old">', 'invalid')).toThrow('Invalid');
  });
  test('repeated preparation is stable', () => {
    const html = '<link href="/icon?v=2.0.0">';
    expect(rewriteCacheBustText(html, '2.0.0')).toBe(html);
  });
});

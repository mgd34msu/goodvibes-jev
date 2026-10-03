import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { applySdkVendorMitigations } from '../scripts/release-shared.ts';

describe('packaged engine Bash dependencies', () => {
  test('projects the vendored runtime leaves while preserving engine versions', () => {
    const original = {
      dependencies: { zod: '4.4.3' },
      optionalDependencies: { 'web-tree-sitter': '0.26.8', unrelated: '1.0.0' },
    };
    const staged = applySdkVendorMitigations(original);
    expect(staged.dependencies?.zod).toBe('4.4.3');
    expect(staged.optionalDependencies?.['web-tree-sitter']).toBe('0.26.8');
    expect(staged.optionalDependencies?.unrelated).toBe('1.0.0');
    expect(staged.optionalDependencies?.['bash-language-server']).toBe('file:vendor/bash-language-server');
    expect(staged.optionalDependencies?.['@goodvibes-jev/bash-zod']).toBe('npm:zod@3.24.2');
    expect(staged.optionalDependencies?.['@goodvibes-jev/bash-web-tree-sitter']).toBe('npm:web-tree-sitter@0.24.5');
    const vendor = JSON.parse(readFileSync(new URL('../../../vendor/bash-language-server/package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> };
    for (const [name, version] of Object.entries(vendor.dependencies)) {
      expect(staged.optionalDependencies?.[name] ?? staged.dependencies?.[name]).toBe(version);
    }
    expect(original.optionalDependencies).toEqual({ 'web-tree-sitter': '0.26.8', unrelated: '1.0.0' });
  });

  test('rejects silent collisions instead of replacing engine dependencies', () => {
    expect(() => applySdkVendorMitigations({ dependencies: { editorconfig: '0.0.0' } })).toThrow('conflicts with engine');
    expect(() => applySdkVendorMitigations({ optionalDependencies: { 'glob-parent': '0.0.0' } })).toThrow('conflicts with engine');
    expect(() => applySdkVendorMitigations({ dependencies: { editorconfig: '3.0.2' }, optionalDependencies: { editorconfig: '0.0.0' } })).toThrow('conflicts with engine');
  });
});

/**
 * Exec-guard obfuscation narrowing: printf/strftime format specifiers are not
 * URL-encoded content.
 *
 * `%` followed by two hex-ish characters is grammatically identical in a printf
 * width/conversion (`%4d`, `%02d`, `%2f`) and in a URL escape (`%2F`, `%20`).
 * The agent-layer obfuscation check used to test the whole raw command with
 * `/%[0-9a-fA-F]{2}/`, which denied ordinary formatting commands. These tests
 * pin the narrowed detector: real percent-encoded URIs and encoded path
 * separators stay denied, plain format strings run.
 *
 * This narrows a false positive. It does not add any new denial class, the
 * exec-guard catastrophic list stays frozen.
 */

import { describe, it, expect } from 'bun:test';
import { parseCommandAST, evaluateCommandAST } from '@/runtime/index.ts';
import type { CommandClassification } from '@/runtime/index.ts';

const ALLOW_SAFE: ReadonlySet<CommandClassification> = new Set(['read', 'write', 'network']);

function obfuscationPatternsFor(cmd: string): string[] {
  const verdict = evaluateCommandAST(cmd, parseCommandAST(cmd), ALLOW_SAFE);
  return verdict.segments.flatMap((segment) => [...segment.obfuscationPatterns]);
}

function flagsUrlEncoding(cmd: string): boolean {
  return obfuscationPatternsFor(cmd).some((pattern) => pattern.includes('URL-encoded'));
}

describe('exec guard: format specifiers are not URL-encoded content', () => {
  const formatCommands: ReadonlyArray<[label: string, command: string]> = [
    ['printf width specifiers', 'printf "%4d %4d %-20s\\n" 1 2 three'],
    ['printf zero-padded pairs', 'printf "%02d:%02d\\n" 7 5'],
    ['printf short width', 'printf "%2d\\n" 9'],
    ['printf hex-float conversion', 'printf "%0a\\n" 1'],
    ['date strftime specifier', 'date +%ad'],
    ['date full timestamp', 'date +%Y%m%d'],
    ['awk formatted report', 'awk "{printf \\"%20s %02d\\", $1, $2}" report.txt'],
    ['seq format', 'seq -f "%02g" 1 5'],
  ];

  for (const [label, command] of formatCommands) {
    it(`allows ${label}`, () => {
      expect(flagsUrlEncoding(command)).toBe(false);
    });
  }

  it('does not flag a bare percent-two-hex token outside a URI', () => {
    expect(flagsUrlEncoding('echo %4d')).toBe(false);
  });
});

describe('exec guard: genuine percent-encoding is still detected', () => {
  it('flags a percent-encoded path inside a URL', () => {
    expect(flagsUrlEncoding('curl http://example.com/path%2Fetc%2Fpasswd')).toBe(true);
  });

  it('flags an encoded path separator without a scheme', () => {
    expect(flagsUrlEncoding('bash %2Fbin%2Fsh')).toBe(true);
  });

  it('flags an encoded backslash separator', () => {
    expect(flagsUrlEncoding('cat %5Cetc%5Cpasswd')).toBe(true);
  });

  it('flags an encoded null byte', () => {
    expect(flagsUrlEncoding('curl http://example.com/a%00b')).toBe(true);
  });

  it('denies the segment when percent-encoding is detected', () => {
    const cmd = 'curl http://example.com/path%2Fetc%2Fpasswd';
    const verdict = evaluateCommandAST(cmd, parseCommandAST(cmd), ALLOW_SAFE);
    const segment = verdict.segments[0];
    expect(segment).toBeDefined();
    expect(segment?.hasObfuscation).toBe(true);
    expect(segment?.allowed).toBe(false);
  });
});

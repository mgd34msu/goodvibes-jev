/**
 * The shell verdict: the per-segment structure of a command from the Shell
 * AST (hoisted from the TUI and agent verdict tests).
 *
 * The verdict no longer classifies segments or denies by class, and has no
 * obfuscation ladder: what a command does is read by Jev in the gate. It
 * records the segments the parser found, refuses a command that parses to
 * none (there is nothing to run as written), and builds the one-line-headed
 * denial explanation for that case.
 */
import { describe, expect, it } from 'bun:test';
import { parseCommandAST } from '../sdk/src/platform/runtime/permissions/normalization/parser.js';
import { collectCommandNodes } from '../sdk/src/platform/runtime/permissions/normalization/ast.js';
import {
  buildDenialExplanation,
  evaluateCommandAST,
  evaluateSegmentNode,
} from '../sdk/src/platform/runtime/permissions/normalization/verdict.js';

const verdictOf = (cmd: string) => evaluateCommandAST(cmd, parseCommandAST(cmd));

describe('evaluateSegmentNode', () => {
  it('records the segment and its command name', () => {
    const node = collectCommandNodes(parseCommandAST('ls -la'))[0]!;
    const result = evaluateSegmentNode(node);
    expect(result.command).toBe('ls');
    expect(result.allowed).toBe(true);
    expect(result.raw).toContain('ls -la');
  });
});

describe('evaluateCommandAST', () => {
  it('keeps every segment of a compound command, in order', () => {
    const verdict = verdictOf('git log --oneline && sudo systemctl restart app; kill -9 42 | cat');
    expect(verdict.allowed).toBe(true);
    expect(verdict.segments.map((s) => s.command)).toEqual(['git', 'sudo', 'kill', 'cat']);
    expect(verdict.denialExplanation).toBeUndefined();
  });

  it('does not refuse by command name: destructive and privileged commands are the gate\'s reading', () => {
    for (const cmd of ['rm -rf /tmp/x', 'git reset --hard', 'sudo ls', 'cat /etc/passwd\0', 'bash cm0gLXJmIC90bXAvKg==']) {
      expect(verdictOf(cmd).allowed).toBe(true);
    }
  });

  it('refuses a command with no runnable segment', () => {
    const verdict = verdictOf('   ');
    expect(verdict.allowed).toBe(false);
    expect(verdict.segments.every((s) => !s.allowed)).toBe(true);
    expect(verdict.denialExplanation?.split('\n')[0]).toBe('Command denied: ""');
  });
});

describe('buildDenialExplanation', () => {
  it('heads with the command on one line and lists each segment with its reason', () => {
    const text = buildDenialExplanation('echo a\necho b', [
      { raw: 'echo a', command: 'echo', allowed: true, reason: 'parsed to a runnable command' },
      { raw: '', command: '', allowed: false, reason: 'no command in this segment' },
    ]);
    const [first] = text.split('\n');
    expect(first).toBe('Command denied: "echo a echo b"');
    expect(text).toContain('reason: no command in this segment');
    expect(text).toContain('1 of 2 segments denied.');
  });
});

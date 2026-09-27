// Ported from goodvibes-agent src/test/runtime/permissions/normalization/verdict.test.ts.
/**
 * Verdict evaluation tests for Shell AST normalization.
 *
 * Tests cover:
 *  - Per-segment verdict evaluation (allow/deny)
 *  - Compound verdict aggregation
 *  - Mixed commands: safe segments identified alongside unsafe ones
 *  - Obfuscation left to the gate reading
 *  - Denial explanation formatting
 */

import { describe, it, expect } from 'bun:test';
import {
  evaluateSegmentNode,
  evaluateCommandAST,
  buildDenialExplanation,
  parseCommandAST,
  collectCommandNodes,
  type CommandNode,
} from '../sdk/src/platform/runtime/permissions/normalization/index.ts';
import {
  type CommandClassification,
} from '../sdk/src/platform/runtime/permissions/index.ts';

// ── Helpers ────────────────────────────────────────────────────────────────────

const ALLOW_ALL: ReadonlySet<CommandClassification> = new Set([
  'read', 'write', 'network', 'destructive', 'escalation',
]);
const ALLOW_SAFE: ReadonlySet<CommandClassification> = new Set(['read', 'write', 'network']);
const ALLOW_READ_ONLY: ReadonlySet<CommandClassification> = new Set(['read']);

function evalCmd(
  cmd: string,
  allowed: ReadonlySet<CommandClassification> = ALLOW_SAFE,
) {
  const ast = parseCommandAST(cmd);
  return evaluateCommandAST(cmd, ast, allowed);
}

function expectPresent<T>(value: T | null | undefined, description: string): T {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${description}`);
  }
  return value;
}

// ── evaluateSegmentNode ───────────────────────────────────────────────────────

describe('evaluateSegmentNode: basic classification', () => {
  function nodeFor(cmd: string): CommandNode {
    const ast = parseCommandAST(cmd);
    const nodes = collectCommandNodes(ast);
    return nodes[0]!;
  }

  it('allows a read command', () => {
    const result = evaluateSegmentNode(nodeFor('ls -la'), ALLOW_SAFE);
    expect(result.allowed).toBe(true);
    expect(result.classification).toBe('read');
  });

  it('denies a destructive command', () => {
    const result = evaluateSegmentNode(nodeFor('rm -rf /tmp'), ALLOW_SAFE);
    expect(result.allowed).toBe(false);
    expect(result.classification).toBe('destructive');
    expect(result.reason).toContain('destructive');
  });

  it('denies an escalation command', () => {
    const result = evaluateSegmentNode(nodeFor('sudo ls'), ALLOW_SAFE);
    expect(result.allowed).toBe(false);
    expect(result.classification).toBe('escalation');
  });

  it('allows a write command in ALLOW_SAFE set', () => {
    const result = evaluateSegmentNode(nodeFor('cp src dst'), ALLOW_SAFE);
    expect(result.allowed).toBe(true);
    expect(result.classification).toBe('write');
  });

  it('denies a write command when only reads are allowed', () => {
    const result = evaluateSegmentNode(nodeFor('cp src dst'), ALLOW_READ_ONLY);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('write');
  });

  it('allows all commands when ALLOW_ALL is used', () => {
    const result = evaluateSegmentNode(nodeFor('rm -rf /'), ALLOW_ALL);
    // destructive is still denied by DEFAULT_POLICIES regardless of allowedClasses
    expect(result.allowed).toBe(false);
    expect(result.classification).toBe('destructive');
  });
});

// ── evaluateCommandAST, compound verdict ─────────────────────────────────────

describe('evaluateCommandAST: compound verdict', () => {
  it('allows a fully safe compound command', () => {
    const verdict = evalCmd('ls /tmp && cat file.txt');
    expect(verdict.allowed).toBe(true);
    expect(verdict.segments.length).toBe(2);
    for (const segment of verdict.segments) {
      expect(segment.allowed).toBe(true);
    }
  });

  it('denies a compound command with one unsafe segment', () => {
    const verdict = evalCmd('ls /tmp && rm -rf /');
    expect(verdict.allowed).toBe(false);
    // ls segment is safe
    const lsSeg = verdict.segments.find((s) => s.command === 'ls');
    expect(lsSeg?.allowed).toBe(true);
    // rm segment is denied
    const rmSeg = verdict.segments.find((s) => s.command === 'rm');
    expect(rmSeg?.allowed).toBe(false);
  });

  it('produces a denial explanation when denied', () => {
    const verdict = evalCmd('ls && rm -rf /');
    expect(typeof verdict.denialExplanation).toBe('string');
    expect(verdict.denialExplanation).toContain('denied');
    expect(verdict.denialExplanation).toContain('rm');
  });

  it('sets highestClassification to destructive for rm -rf', () => {
    const verdict = evalCmd('ls && rm -rf /');
    expect(verdict.highestClassification).toBe('destructive');
  });

  it('allows a pipe of safe commands', () => {
    const verdict = evalCmd('ps aux | grep node | wc -l');
    expect(verdict.allowed).toBe(true);
    expect(verdict.segments.length).toBe(3);
  });

  it('denies a pipe containing sudo', () => {
    const verdict = evalCmd('cat file.txt | sudo tee /etc/hosts');
    expect(verdict.allowed).toBe(false);
    const sudoSeg = verdict.segments.find((s) => s.command === 'sudo');
    expect(sudoSeg?.allowed).toBe(false);
    expect(sudoSeg?.classification).toBe('escalation');
  });

  it('correctly handles semicolon-separated commands', () => {
    const verdict = evalCmd('date; whoami; uname -a');
    expect(verdict.allowed).toBe(true);
    expect(verdict.segments.length).toBe(3);
  });

  it('denies semicolon chain containing kill', () => {
    const verdict = evalCmd('echo start; kill -9 1; echo end');
    expect(verdict.allowed).toBe(false);
    const killSeg = verdict.segments.find((s) => s.command === 'kill');
    expect(killSeg?.allowed).toBe(false);
    expect(killSeg?.classification).toBe('destructive');
  });

  it('identifies safe segments when mixed', () => {
    // git log is safe (read), git push --force is dangerous
    const verdict = evalCmd('git log --oneline && git push --force origin main');
    const logSeg = verdict.segments.find(
      (s) => s.command === 'git' && s.raw.includes('log'),
    );
    const pushSeg = verdict.segments.find(
      (s) => s.command === 'git' && s.raw.includes('push'),
    );
    // git push is network, which is allowed
    // Overall verdict depends on classification of 'push' which is 'network'
    expect(logSeg?.classification).toBe('read');
    expect(pushSeg?.classification).toBe('network');
  });
});

// ── Obfuscation is read by the gate, not refused here ────────────────────────

describe('evaluateCommandAST: no exec-time obfuscation refusal', () => {
  it('leaves encoded, escaped and substituted shapes to the gate reading', () => {
    // Whether these hide what they do is the gate's `obfuscated` reading
    // (critical stakes, so every preset asks); the verdict keeps class gating.
    expect(evalCmd('cat ..%2F..%2Fetc%2Fpasswd').allowed).toBe(true);
    expect(evalCmd('cat /etc/passwd\0').segments[0]?.classification).toBe('read');
  });

  it('still refuses by class where the caller narrows the allowed classes', () => {
    const verdict = evalCmd('rm `echo /tmp/file`');
    expect(verdict.allowed).toBe(false);
    expect(evalCmd('rm $DANGEROUS_PATH').segments[0]?.classification).toBe('destructive');
  });

  it('allows clean commands', () => {
    expect(evalCmd('ls -la /home/user/Projects').allowed).toBe(true);
  });
});

// ── buildDenialExplanation ────────────────────────────────────────────────────

describe('buildDenialExplanation', () => {
  it('includes original command in explanation', () => {
    const verdict = evalCmd('ls && rm -rf /');
    const explanation = buildDenialExplanation('ls && rm -rf /', verdict.segments);
    expect(explanation).toContain('ls && rm -rf /');
  });

  it('lists segment count', () => {
    const verdict = evalCmd('ls && rm -rf /');
    const explanation = buildDenialExplanation('ls && rm -rf /', verdict.segments);
    expect(explanation).toContain('2 segment');
  });

  it('marks allowed segments with check mark indicator', () => {
    const verdict = evalCmd('ls && rm -rf /');
    const explanation = buildDenialExplanation('ls && rm -rf /', verdict.segments);
    expect(explanation).toContain('allowed');
    expect(explanation).toContain('denied');
  });

  it('shows classification for each segment', () => {
    const verdict = evalCmd('ls && rm -rf /');
    const explanation = buildDenialExplanation('ls && rm -rf /', verdict.segments);
    expect(explanation).toContain('destructive');
    expect(explanation).toContain('read');
  });

  it('reports denied count', () => {
    const verdict = evalCmd('date && rm -rf / && whoami');
    const explanation = buildDenialExplanation('date && rm -rf / && whoami', verdict.segments);
    expect(explanation).toMatch(/1 of 3 segment/);
  });
});

// ── Acceptance criteria: mixed deny/allow ─────────────────────────────────────

describe('acceptance: mixed commands identify safe vs. unsafe segments', () => {
  it('correctly identifies safe segments in ls && rm -rf /', () => {
    const verdict = evalCmd('ls -la && rm -rf /');
    expect(verdict.allowed).toBe(false);

    const safeSeg = verdict.segments.find((s) => s.command === 'ls');
    const unsafeSeg = verdict.segments.find((s) => s.command === 'rm');

    expect(safeSeg?.allowed).toBe(true);
    expect(safeSeg?.classification).toBe('read');
    expect(unsafeSeg?.allowed).toBe(false);
    expect(unsafeSeg?.classification).toBe('destructive');
  });

  it('handles git log (safe) && git reset --hard (unsafe)', () => {
    const verdict = evalCmd('git log --oneline -5 && git reset --hard HEAD~1');
    expect(verdict.allowed).toBe(false);

    const readSeg = verdict.segments.find((s) => s.raw.includes('log'));
    const resetSeg = verdict.segments.find((s) => s.raw.includes('reset'));

    expect(readSeg?.classification).toBe('read');
    expect(resetSeg?.classification).toBe('destructive');
    expect(resetSeg?.allowed).toBe(false);
  });

  it('allows all-safe complex command', () => {
    const verdict = evalCmd('find . -name "*.ts" | grep import | wc -l');
    expect(verdict.allowed).toBe(true);
    for (const segment of verdict.segments) {
      expect(segment.allowed).toBe(true);
    }
  });

  it('denial explanation covers all mixed segments', () => {
    const verdict = evalCmd('cat file.txt && sudo rm -rf /etc');
    expect(verdict.denialExplanation).toContain('cat');
    expect(verdict.denialExplanation).toContain('sudo');
  });
});

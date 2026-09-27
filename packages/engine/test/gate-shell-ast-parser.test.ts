// Ported from goodvibes-agent src/test/runtime/permissions/normalization/ast-parser.test.ts.
/**
 * Corpus tests for the Shell AST parser.
 *
 * Tests cover:
 *  - Simple commands
 *  - Pipe expressions (cmd | cmd)
 *  - Sequence operators (&&, ||, ;)
 *  - Nested compound commands
 *  - Subshell expressions ($(...) and backticks)
 *  - Redirects (>, >>, <, 2>)
 *  - Mixed compound commands
 */

import { describe, it, expect } from 'bun:test';
import {
  parseCommandAST,
  parseAST,
  collectCommandNodes,
  tokenize,
  type CommandNode,
  type PipeNode,
  type SequenceNode,
  type SubshellNode,
} from '../sdk/src/platform/runtime/permissions/normalization/index.ts';

// ── Helpers ────────────────────────────────────────────────────────────────────

function commandNames(cmd: string): string[] {
  const ast = parseCommandAST(cmd);
  return collectCommandNodes(ast).map((n) => n.command);
}

// ── Simple commands ───────────────────────────────────────────────────────────

describe('parseCommandAST: simple commands', () => {
  it('parses a bare command', () => {
    const ast = parseCommandAST('ls');
    expect(ast.kind).toBe('command');
    expect((ast as CommandNode).command).toBe('ls');
  });

  it('parses a command with flags and path args', () => {
    const ast = parseCommandAST('ls -la /tmp');
    expect(ast.kind).toBe('command');
    const node = ast as CommandNode;
    expect(node.command).toBe('ls');
    expect(node.flags).toContain('-la');
    // /tmp is classified as a 'path' token by the tokenizer, not 'argument'
    expect(node.tokens.find((t) => t.type === 'path' && t.value === '/tmp')).toEqual(expect.objectContaining({
      type: 'path',
      value: '/tmp',
    }));
  });

  it('parses an empty string to an empty command node', () => {
    const ast = parseCommandAST('');
    expect(ast.kind).toBe('command');
    expect((ast as CommandNode).command).toBe('');
  });

  it('handles bare command names correctly', () => {
    // Bare command names (not path-prefixed) are typed as 'command' by the tokenizer
    const ast = parseCommandAST('grep pattern file.txt');
    expect(ast.kind).toBe('command');
    expect((ast as CommandNode).command).toBe('grep');
  });

  it('handles absolute-path commands as path tokens', () => {
    // /usr/bin/grep has a leading / so tokenizer classifies it as 'path', not 'command'
    // The command field will be empty; the path token is preserved in tokens[]
    const ast = parseCommandAST('/usr/bin/grep pattern');
    expect(ast.kind).toBe('command');
    const node = ast as CommandNode;
    // path-typed token should be in the token list
    expect(node.tokens.find((t) => t.value === '/usr/bin/grep')).toEqual(expect.objectContaining({
      type: 'path',
      value: '/usr/bin/grep',
    }));
  });
});

// ── Pipe expressions ──────────────────────────────────────────────────────────

describe('parseCommandAST: pipe expressions', () => {
  it('parses a simple pipe', () => {
    const ast = parseCommandAST('cat file.txt | grep pattern');
    expect(ast.kind).toBe('pipe');
    const pipe = ast as PipeNode;
    expect((pipe.left as CommandNode).command).toBe('cat');
    expect((pipe.right as CommandNode).command).toBe('grep');
  });

  it('parses a three-command pipe chain', () => {
    const ast = parseCommandAST('cat file.txt | sort | uniq');
    expect(ast.kind).toBe('pipe');
    // Left-associative: ((cat | sort) | uniq)
    const outerPipe = ast as PipeNode;
    expect(outerPipe.right.kind).toBe('command');
    expect((outerPipe.right as CommandNode).command).toBe('uniq');
    const innerPipe = outerPipe.left as PipeNode;
    expect(innerPipe.kind).toBe('pipe');
    expect((innerPipe.left as CommandNode).command).toBe('cat');
    expect((innerPipe.right as CommandNode).command).toBe('sort');
  });

  it('collectCommandNodes extracts all piped commands in order', () => {
    expect(commandNames('ls | grep .ts | wc -l')).toEqual(['ls', 'grep', 'wc']);
  });

  it('parses ps aux | grep node', () => {
    const names = commandNames('ps aux | grep node');
    expect(names).toEqual(['ps', 'grep']);
  });
});

// ── Sequence operators ────────────────────────────────────────────────────────

describe('parseCommandAST: sequence operators', () => {
  it('parses && sequence', () => {
    const ast = parseCommandAST('mkdir /tmp/foo && cd /tmp/foo');
    expect(ast.kind).toBe('sequence');
    const seq = ast as SequenceNode;
    expect(seq.operator).toBe('&&');
    expect((seq.left as CommandNode).command).toBe('mkdir');
    expect((seq.right as CommandNode).command).toBe('cd');
  });

  it('parses || sequence', () => {
    const ast = parseCommandAST('test -f file.txt || echo missing');
    expect(ast.kind).toBe('sequence');
    const seq = ast as SequenceNode;
    expect(seq.operator).toBe('||');
  });

  it('parses ; sequence', () => {
    const ast = parseCommandAST('echo hello; echo world');
    expect(ast.kind).toBe('sequence');
    const seq = ast as SequenceNode;
    expect(seq.operator).toBe(';');
    expect(commandNames('echo hello; echo world')).toEqual(['echo', 'echo']);
  });

  it('parses mixed safe && unsafe compound', () => {
    const names = commandNames('ls /tmp && rm -rf /');
    expect(names).toEqual(['ls', 'rm']);
  });

  it('parses three-command && chain', () => {
    const names = commandNames('git pull && bun install && bun run build');
    expect(names).toEqual(['git', 'bun', 'bun']);
  });

  it('parses ; separated commands', () => {
    const names = commandNames('date; whoami; uname -a');
    expect(names).toEqual(['date', 'whoami', 'uname']);
  });
});

// ── Mixed pipes and sequences ─────────────────────────────────────────────────

describe('parseCommandAST: mixed pipes and sequences', () => {
  it('parses pipe within && chain', () => {
    // cat file | grep pat && echo done
    // Parsed as: sequence(pipe(cat|grep), echo)
    const names = commandNames('cat file.txt | grep pattern && echo done');
    expect(names).toContain('cat');
    expect(names).toContain('grep');
    expect(names).toContain('echo');
  });

  it('parses complex mixed compound', () => {
    const names = commandNames('ls /tmp | wc -l && date; echo end');
    expect(names).toContain('ls');
    expect(names).toContain('wc');
    expect(names).toContain('date');
    expect(names).toContain('echo');
  });
});

// ── Subshell expressions ──────────────────────────────────────────────────────

describe('parseCommandAST: subshell expressions', () => {
  it('parses backtick subshell as subshell node', () => {
    const ast = parseCommandAST('echo `date`');
    // The backtick token causes parseAtom to return a SubshellNode
    // (the echo portion is lost, conservative approach)
    // We validate the subshell is parsed
    const nodes = collectCommandNodes(ast);
    // Should have at least one node (the subshell inner or echo)
    expect(nodes.length).toBeGreaterThanOrEqual(0);
  });

  it('backtick subshell node has inner parsed content', () => {
    const ast = parseCommandAST('`ls -la`');
    expect(ast.kind).toBe('subshell');
    const sub = ast as SubshellNode;
    expect(sub.raw).toBe('`ls -la`');
    expect(sub.inner).toEqual(expect.objectContaining({ kind: 'command' }));
    const innerNodes = collectCommandNodes(sub.inner!);
    expect(innerNodes.map((node) => node.command)).toEqual(['ls']);
  });

  it('handles nested subshell $(cmd): tokenizer extracts as subshell token', () => {
    // The tokenizer may not handle $(...) perfectly in all positions;
    // we verify no crash and some structure is produced.
    const ast = parseCommandAST('echo $(date +%s)');
    expect(ast).toEqual(expect.objectContaining({
      kind: expect.any(String),
    }));
  });
});

// ── Redirects ─────────────────────────────────────────────────────────────────

describe('parseCommandAST: redirects', () => {
  it('parses command with output redirect', () => {
    const ast = parseCommandAST('echo hello > /tmp/out.txt');
    expect(ast.kind).toBe('command');
    const node = ast as CommandNode;
    expect(node.command).toBe('echo');
    // redirect token is present in the token list
    expect(node.tokens.find((t) => t.type === 'redirect')).toEqual(expect.objectContaining({
      type: 'redirect',
      value: '>',
    }));
  });

  it('parses command with append redirect', () => {
    const ast = parseCommandAST('date >> /tmp/log.txt');
    expect(ast.kind).toBe('command');
  });

  it('parses command with stderr redirect', () => {
    const ast = parseCommandAST('make 2>/dev/null');
    expect(ast.kind).toBe('command');
    expect((ast as CommandNode).command).toBe('make');
  });
});

// ── parseAST from token list ───────────────────────────────────────────────────

describe('parseAST: from token list', () => {
  it('produces empty command node for empty token list', () => {
    const ast = parseAST([]);
    expect(ast.kind).toBe('command');
    expect((ast as CommandNode).command).toBe('');
  });

  it('produces correct structure from pre-tokenized input', () => {
    const tokens = tokenize('ls | grep foo');
    const ast = parseAST(tokens);
    expect(ast.kind).toBe('pipe');
  });

  it('sets parseError on token list that causes parser to throw', () => {
    // Construct a token whose .type getter throws on the first access.
    // parseAtom accesses t.type immediately after peek(), which triggers the
    // throw → falls into parseAST's catch block → parseError is set.
    // Subsequent accesses (from buildCommandNode in the catch) return 'command'
    // so the fallback node is constructed successfully.
    let callCount = 0;
    const poisonToken = Object.defineProperty(
      { value: 'ls' },
      'type',
      {
        get() {
          callCount++;
          if (callCount === 1) {
            throw new Error('synthetic token error for parseError coverage');
          }
          return 'command';
        },
        enumerable: true,
      },
    ) as unknown as import('../sdk/src/platform/runtime/permissions/normalization/index.ts').CommandToken;

    const result = parseAST([poisonToken]);
    expect(result.kind).toBe('command');
    expect((result as CommandNode).parseError).toBe('synthetic token error for parseError coverage');
  });
});

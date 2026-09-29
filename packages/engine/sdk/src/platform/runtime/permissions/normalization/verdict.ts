/**
 * Per-segment structure of a shell command, from the Shell AST.
 *
 * What a command does (whether it is catastrophic, what it changes, what host
 * access it needs) is read by Jev in the gate; this module only records the
 * segments the parser found and refuses a command that parses to none, which
 * is a structural fact: there is no command there to run as written.
 *
 * @module normalization/verdict
 */

import type { ShellNode, CommandNode } from './ast.js';
import { collectCommandNodes } from './ast.js';

/** One parsed command segment. */
export interface SegmentVerdict {
  /** The raw command string for this segment. */
  raw: string;
  /** Canonical command name. */
  command: string;
  /** Whether this segment can run as written (it parsed to a command). */
  allowed: boolean;
  /** Why. */
  reason: string;
}

/** The parsed segments of a compound command. */
export interface CompoundVerdict {
  /** The original command string. */
  original: string;
  /** Whether the command parsed to at least one runnable segment. */
  allowed: boolean;
  /** Per-segment records (in parse order). */
  segments: SegmentVerdict[];
  /** Human-readable denial explanation; set only when `allowed` is false. */
  denialExplanation?: string | undefined;
}

/** The record for one parsed command node. */
export function evaluateSegmentNode(node: CommandNode): SegmentVerdict {
  const runnable = node.command.length > 0 || node.tokens.length > 0;
  return {
    raw: node.raw,
    command: node.command,
    allowed: runnable,
    reason: runnable ? 'parsed to a runnable command' : 'no command in this segment',
  };
}

/** Longest echoed command kept in a denial header before it is elided. */
const MAX_ECHOED_COMMAND_LENGTH = 500;

/**
 * Collapses whitespace runs so an echoed command occupies exactly one line.
 *
 * The header used to interpolate `original` verbatim. A multi-line command, a
 * heredoc above all, therefore put its own newline inside what reads as line
 * one, so every consumer that summarizes a denial by its first line (for
 * example exec's `minimal` verbosity, which does `stderr.split('\n')[0]`)
 * showed `Command denied: "… <<'EOF'` and silently dropped the segment
 * breakdown, classification and reason. Collapsing here keeps the first line a
 * real first line, so a denial always names what was denied and why.
 */
export function asSingleLine(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_ECHOED_COMMAND_LENGTH
    ? `${collapsed.slice(0, MAX_ECHOED_COMMAND_LENGTH)}…`
    : collapsed;
}
/** A denial explanation listing each segment and why it cannot run. */
export function buildDenialExplanation(original: string, verdicts: SegmentVerdict[]): string {
  const denied = verdicts.filter((v) => !v.allowed);
  const lines: string[] = [
    `Command denied: "${asSingleLine(original)}"`,
    ``,
    `Segment analysis (${verdicts.length} segment${verdicts.length !== 1 ? 's' : ''}):`,
  ];
  for (const [i, v] of verdicts.entries()) {
    const status = v.allowed ? '✓ allowed' : '✗ denied';
    lines.push(`  [${i + 1}] ${status}  ${asSingleLine(v.raw)}`);
    lines.push(`       reason: ${v.reason}`);
  }
  lines.push(``);
  lines.push(`${denied.length} of ${verdicts.length} segment${verdicts.length !== 1 ? 's' : ''} denied.`);
  return lines.join('\n');
}

/** The segments of a parsed command; a command with no runnable segment is refused. */
export function evaluateCommandAST(original: string, ast: ShellNode): CompoundVerdict {
  const commandNodes = collectCommandNodes(ast);
  if (commandNodes.length === 0) {
    return {
      original,
      allowed: false,
      segments: [],
      denialExplanation: `Command denied: "${asSingleLine(original)}"\n\nNo parseable command segments found, so there is nothing to run as written.`,
    };
  }
  const segments = commandNodes.map((node) => evaluateSegmentNode(node));
  const allowed = segments.every((v) => v.allowed);
  return { original, allowed, segments, ...(allowed ? {} : { denialExplanation: buildDenialExplanation(original, segments) }) };
}

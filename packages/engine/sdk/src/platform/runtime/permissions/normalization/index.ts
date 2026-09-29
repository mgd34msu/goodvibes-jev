/**
 * Command normalization pipeline, barrel export and primary entry point.
 *
 * Exposes the normalizeCommand() function and all supporting types.
 * Pipeline: tokenize → segment → NormalizedCommand. What a command does is
 * read by Jev in the gate (gate/reading.ts, gate/batteries); what host access
 * it needs is readCommandNeeds (classifier.ts).
 */

export type {
  CommandToken,
  CommandSegment,
  CommandClassification,
  NormalizedCommand,
} from './types.js';

export type {
  ShellNode,
  CommandNode,
  PipeNode,
  SequenceNode,
  SubshellNode,
} from './ast.js';

export type {
  SegmentVerdict,
  CompoundVerdict,
} from './verdict.js';

export { tokenize } from './tokenizer.js';
export { segment } from './segmenter.js';
export { canonicalize } from './canonicalizer.js';
export { readCommandNeeds, type CommandNeeds } from './classifier.js';
export { collectCommandNodes, describeNode } from './ast.js';
export { parseAST, parseCommandAST } from './parser.js';
export { evaluateSegmentNode, evaluateCommandAST, buildDenialExplanation, asSingleLine } from './verdict.js';

import { tokenize } from './tokenizer.js';
import { segment } from './segmenter.js';
import type { NormalizedCommand } from './types.js';
import { parseCommandAST } from './parser.js';
import { evaluateCommandAST } from './verdict.js';
import type { CompoundVerdict } from './verdict.js';

/** The parsed segments of a shell command (the Shell AST). */
export function normalizeCommandWithVerdicts(command: string): CompoundVerdict {
  return evaluateCommandAST(command, parseCommandAST(command));
}

/** The flat segments of a shell command. */
export function normalizeCommand(command: string): NormalizedCommand {
  const trimmed = command.trim();
  return { original: command, segments: segment(tokenize(trimmed)) };
}

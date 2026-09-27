/**
 * Per-segment verdict evaluation for Shell AST normalization.
 *
 * Evaluates policy per AST segment, aggregates a final compound verdict,
 * and produces structured denial output with per-segment reasons.
 *
 * Each segment verdict is a runtime contract: callers can inspect which
 * segments were safe vs. unsafe and surface that information to the user.
 *
 * @module normalization/verdict
 */

import type { CommandClassification } from './types.js';
import type { ShellNode, CommandNode } from './ast.js';
import { collectCommandNodes, describeNode } from './ast.js';
import { classifySegment, catastrophicReason } from './classifier.js';
import type { CommandSegment } from './types.js';

/**
 * Conservative set of classifications for callers that gate by class
 * WITHOUT a permission layer in front of them (e.g. policy tooling,
 * standalone analysis). Destructive and escalation are excluded.
 *
 * The exec tool does NOT use this set: by the time a command executes, the
 * permission layer (user settings, prompts, session approvals) has already
 * approved the call, so the exec layer passes ALL_COMMAND_CLASSES and keeps
 * only the unconditional catastrophic block.
 */
export const DEFAULT_ALLOWED_CLASSES: ReadonlySet<CommandClassification> = new Set([
  'read',
  'write',
  'network',
]);

/**
 * Every command classification. Passed by callers whose class-level risk
 * decisions are owned by the permission layer (allow/prompt/deny settings),
 * leaving only the catastrophic check at this layer. Whether a command is
 * obfuscated or evasive is read by Jev in the gate (the side-effect battery's
 * `obfuscated` question), where it raises the call to critical stakes.
 */
export const ALL_COMMAND_CLASSES: ReadonlySet<CommandClassification> = new Set([
  'read',
  'write',
  'network',
  'destructive',
  'escalation',
]);

// ── Types ──────────────────────────────────────────────────────────────────────

/**
 * The policy verdict for a single command segment.
 *
 * Each verdict is an immutable runtime contract that records why a segment
 * was allowed or denied, making the decision auditable and explainable.
 */
export interface SegmentVerdict {
  /** The raw command string for this segment. */
  raw: string;
  /** Canonical command name. */
  command: string;
  /** Semantic risk classification. */
  classification: CommandClassification;
  /** Whether this segment was allowed by policy. */
  allowed: boolean;
  /**
   * Human-readable reason for the verdict.
   * Always set; describes the policy that matched or the safe classification.
   */
  reason: string;
}

/**
 * The aggregated verdict for a compound command.
 *
 * Contains the overall allow/deny decision plus per-segment records for
 * user-facing denial output and audit logging.
 */
export interface CompoundVerdict {
  /** The original command string. */
  original: string;
  /** Whether the entire compound command is allowed. */
  allowed: boolean;
  /** The highest-risk classification across all segments. */
  highestClassification: CommandClassification;
  /** Per-segment verdict records (in parse order). */
  segments: SegmentVerdict[];
  /**
   * Human-readable denial explanation including per-segment reasons.
   * Only set when `allowed` is false.
   */
  denialExplanation?: string | undefined;
}

// ── Policy evaluation ─────────────────────────────────────────────────────────

/**
 * Classification priority order (highest index = lowest risk).
 * Used for comparing segment classifications.
 */
const CLASSIFICATION_PRIORITY: CommandClassification[] = [
  'destructive',
  'escalation',
  'network',
  'write',
  'read',
];

function classificationRank(c: CommandClassification): number {
  const idx = CLASSIFICATION_PRIORITY.indexOf(c);
  return idx === -1 ? 999 : idx;
}

function higherPriorityClassification(
  a: CommandClassification,
  b: CommandClassification,
): CommandClassification {
  return classificationRank(a) <= classificationRank(b) ? a : b;
}

/**
 * Policy predicate type: returns a denial reason string if the segment
 * should be denied, or null if the policy does not deny it.
 */
type PolicyPredicate = (node: CommandNode, classification: CommandClassification) => string | null;

/**
 * Default policies applied to each segment.
 *
 * Extend this list to add project-specific per-segment rules.
 * First match wins (denial takes precedence).
 */
const DEFAULT_POLICIES: PolicyPredicate[] = [
  // Catastrophic commands (root deletion, raw disk destruction, fork bombs)
  // are blocked unconditionally. Everything else, including destructive- and
  // escalation-CLASS commands like kill/rm/docker/sudo, is gated by the
  // allowedClasses check below, so the caller (ultimately the user's
  // permission settings) decides.
  (node, _cls) => {
    const reason = catastrophicReason({
      raw: node.raw,
      tokens: node.tokens,
      command: node.command,
      args: node.args,
      flags: node.flags,
    });
    return reason === null ? null : `unconditionally blocked destructive command, ${reason}`;
  },
];

/**
 * Evaluates a single CommandNode against the default policy.
 *
 * @param node           - The command node to evaluate.
 * @param allowedClasses - Classification tiers to allow (defaults to read+write+network).
 * @returns A SegmentVerdict for this node.
 */
export function evaluateSegmentNode(
  node: CommandNode,
  allowedClasses: ReadonlySet<CommandClassification> = DEFAULT_ALLOWED_CLASSES,
): SegmentVerdict {
  // Build a minimal CommandSegment for the classifier
  const seg: CommandSegment = {
    raw: node.raw,
    tokens: node.tokens,
    command: node.command,
    args: node.args,
    flags: node.flags,
  };

  const classification = classifySegment(seg);
  for (const policy of DEFAULT_POLICIES) {
    const denial = policy(node, classification);
    if (denial !== null) {
      return {
        raw: node.raw,
        command: node.command,
        classification,
        allowed: false,
        reason: denial,
      };
    }
  }

  if (!allowedClasses.has(classification)) {
    return {
      raw: node.raw,
      command: node.command,
      classification,
      allowed: false,
      reason: `classification "${classification}" is not in the allowed set [${[...allowedClasses].join(', ')}]`,
    };
  }

  return {
    raw: node.raw,
    command: node.command,
    classification,
    allowed: true,
    reason: `classification "${classification}" is permitted`,
  };
}

/**
 * Builds a structured denial explanation from a list of segment verdicts.
 *
 * Includes the full per-segment breakdown for user-facing output.
 *
 * @param original - The original command string.
 * @param verdicts - All segment verdicts.
 * @returns A multi-line denial explanation string.
 */
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
    lines.push(`       classification: ${v.classification}`);
    lines.push(`       reason: ${v.reason}`);
  }

  lines.push(``);
  lines.push(`${denied.length} of ${verdicts.length} segment${verdicts.length !== 1 ? 's' : ''} denied.`);

  return lines.join('\n');
}

/**
 * Evaluates a ShellNode AST against policy and returns a CompoundVerdict.
 *
 * Safe segments are identified alongside unsafe ones. The compound command
 * is denied if ANY segment is denied.
 *
 * @param original       - The original command string.
 * @param ast            - The parsed ShellNode AST.
 * @param allowedClasses - Classification tiers to allow per segment.
 * @returns A CompoundVerdict with per-segment breakdown.
 */
export function evaluateCommandAST(
  original: string,
  ast: ShellNode,
  allowedClasses: ReadonlySet<CommandClassification> = DEFAULT_ALLOWED_CLASSES,
): CompoundVerdict {
  const commandNodes = collectCommandNodes(ast);

  // If AST has no command nodes (e.g. empty or pure subshell with no inner)
  if (commandNodes.length === 0) {
    // Conservative: deny empty/unparseable compound commands
    const verdict: CompoundVerdict = {
      original,
      allowed: false,
      highestClassification: 'write',
      segments: [],
      denialExplanation: `Command denied: "${asSingleLine(original)}"\n\nNo parseable command segments found. Denied as a precaution.`,
    };
    return verdict;
  }

  const segmentVerdicts: SegmentVerdict[] = commandNodes.map((node) =>
    evaluateSegmentNode(node, allowedClasses),
  );

  let highest: CommandClassification = 'read';
  for (const sv of segmentVerdicts) {
    highest = higherPriorityClassification(highest, sv.classification);
  }

  const anyDenied = segmentVerdicts.some((v) => !v.allowed);

  const compound: CompoundVerdict = {
    original,
    allowed: !anyDenied,
    highestClassification: highest,
    segments: segmentVerdicts,
  };

  if (anyDenied) {
    compound.denialExplanation = buildDenialExplanation(original, segmentVerdicts);
  }

  return compound;
}

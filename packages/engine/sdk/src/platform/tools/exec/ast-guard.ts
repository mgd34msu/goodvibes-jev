/**
 * The exec tool's run-time guard.
 *
 * Before a command runs, the guard repeats the gate's catastrophic decision:
 * the gate's boundary reading of this command when the gate read it (the same
 * process remembers it), or a fresh `engine.gate.boundary` reading when the
 * exec tool is called without the gate in front of it. A yes refuses; an
 * uncertain reading lets it run only because the gate already sent it to the
 * owner at critical stakes (outside the gate there is no owner prompt, so an
 * uncertain reading refuses there too).
 *
 * With AST command parsing on (permissions.commandParser 'ast', the default),
 * the command is also parsed segment by segment, and a command that parses to
 * no runnable segment is refused: there is nothing to run as written. What a
 * command does is never decided here by name; the gate reads it.
 *
 * @module tools/exec/ast-guard
 */

import { parseCommandAST } from '../../runtime/permissions/normalization/parser.js';
import { collectCommandNodes } from '../../runtime/permissions/normalization/ast.js';
import { evaluateCommandAST, asSingleLine } from '../../runtime/permissions/normalization/verdict.js';
import { readCatastrophic } from '../../gate/reading.js';
import type { CompoundVerdict } from '../../runtime/permissions/normalization/verdict.js';
import type { FeatureFlagManager } from '../../runtime/feature-flags/index.js';

type FlagManagerLike = Pick<FeatureFlagManager, 'isEnabled'>;

function isASTNormalizationEnabled(flagManager?: FlagManagerLike | null): boolean {
  return flagManager?.isEnabled('shell-ast-normalization') ?? false;
}

/** The result of the run-time guard for one exec command. */
export interface ASTGuardResult {
  /** Whether the command may run. */
  allowed: boolean;
  /** Human-readable denial explanation; set only when `allowed` is false. */
  denialMessage?: string | undefined;
  /** The parsed segments, when AST parsing was active. */
  verdict?: CompoundVerdict | undefined;
  /** Whether AST parsing was active. */
  astModeActive: boolean;
}

/**
 * Guards one shell command before it runs.
 *
 * @param command     - The raw shell command string.
 * @param flagManager - Feature flags (AST parsing).
 */
export async function guardExecCommand(
  command: string,
  flagManager?: FlagManagerLike | null,
): Promise<ASTGuardResult> {
  const astModeActive = isASTNormalizationEnabled(flagManager);
  let verdict: CompoundVerdict | undefined;
  if (astModeActive) {
    const ast = parseCommandAST(command);
    if (!collectCommandNodes(ast).some((node) => node.parseError !== undefined)) {
      verdict = evaluateCommandAST(command, ast);
      if (!verdict.allowed) return { allowed: false, denialMessage: verdict.denialExplanation, verdict, astModeActive };
    }
  }
  const { verdict: catastrophic, readByGate } = await readCatastrophic(command);
  if (catastrophic === 'yes' || (catastrophic === 'uncertain' && !readByGate)) {
    return {
      allowed: false,
      denialMessage:
        `Command denied (safety block): "${asSingleLine(command)}"\n` +
        `${catastrophic === 'yes' ? 'Read as destroying the machine or the user\'s data wholesale' : 'It could not be read as safe, and no owner was asked'}.\n` +
        `This block is not affected by permission settings.`,
      ...(verdict ? { verdict } : {}),
      astModeActive,
    };
  }
  return { allowed: true, ...(verdict ? { verdict } : {}), astModeActive };
}

/**
 * Formats an ASTGuardResult denial into a structured exec tool error response.
 *
 * @param result - A denied ASTGuardResult.
 * @param cmd    - The original command string (for the error message).
 * @returns A structured error object suitable for returning from the exec tool.
 */
export function formatDenialResponse(
  result: ASTGuardResult,
  cmd: string,
): Record<string, unknown> {
  const segmentDetails = result.verdict?.segments.map((s) => ({
    command: s.command,
    allowed: s.allowed,
    reason: s.reason,
  }));

  return {
    success: false,
    cmd,
    denied: true,
    denial_reason: result.denialMessage ?? 'Command denied by policy',
    ...(segmentDetails ? { segments: segmentDetails } : {}),
    ast_mode: result.astModeActive,
  };
}

import { JudgmentError } from '@goodvibes-jev/judgment';
import { JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import type { Tool, ToolCall } from '../../../types/tools.js';
import type { ToolRuntimeContext } from '../context.js';
import type { PhaseResult, ToolExecutionRecord } from '../types.js';
import type { PhasedTool } from '../adapter.js';
import type { ToolClass } from '../output-policy.js';
import { applyOutputPolicy, getPolicy } from '../output-policy.js';
import { summarizeError } from '../../../utils/error-display.js';
import { attachVisibleToolWarning } from './warnings.js';

/**
 * mapOutput, Phase 5 of the tool execution pipeline.
 *
 * Transforms/annotates the raw tool result before it reaches the LLM:
 *
 * 1. Applies auto-repair annotation: if the execute phase repaired the
 *    args (`record._repair`), prepends a `[Auto-repaired: ...]` note to the
 *    output so the LLM knows what was corrected.
 * 2. Applies output policy enforcement: byte limits, truncation, and spill
 *    handling are applied per tool class via `applyOutputPolicy`.
 * 3. No-ops cleanly when there is no result to map (defensive guard).
 */
/** Type guard, true when `tool` carries phased execution metadata. */
function isPhasedTool(tool: Tool): tool is PhasedTool {
  return 'category' in tool && typeof (tool as PhasedTool).category === 'string';
}

/**
 * Maps a PhasedTool category to the ToolClass used by output-policy.
 * `delegate` has no direct output-policy class; treat as `analyze`.
 */
function resolveToolClass(tool: Tool): ToolClass {
  if (!isPhasedTool(tool)) return 'read';
  switch (tool.category) {
    case 'read':     return 'read';
    case 'write':    return 'write';
    case 'execute':  return 'execute';
    case 'network':  return 'network';
    case 'delegate': return 'analyze';
    default:         return 'read';
  }
}

export async function mapOutputPhase(
  call: ToolCall,
  tool: Tool,
  _context: ToolRuntimeContext,
  record: ToolExecutionRecord,
): Promise<PhaseResult> {
  const start = performance.now();

  if (!record.result) {
    // No result to map, this is a no-op (execute phase may have failed)
    return {
      phase: 'mapped',
      success: true,
      durationMs: performance.now() - start,
    };
  }

  try {
    // The repair the execute phase applied, if any.
    const repairResult = record._repair;

    for (const warning of repairResult?.warnings ?? []) {
      attachVisibleToolWarning(record.result, warning);
    }

    if (repairResult?.repaired) {
      const repairNote = `[Auto-repaired: ${repairResult.repairs.join(', ')}]`;
      if (typeof record.result.output === 'string') {
        record.result.output = `${repairNote}\n${record.result.output}`;
      } else {
        record.result.output = repairNote;
      }
    }

    // Apply output policy enforcement after auto-repair annotation
    const toolClass = resolveToolClass(tool);
    const policy = getPolicy(toolClass);
    const auditedResult = await applyOutputPolicy(record.result, policy, _context.overflowHandler!, `${call.name} ${JSON.stringify(call.arguments)}`);
    record.result = auditedResult.result;

    // Surface spill backend in phase metadata when overflow occurred
    const spillBackend = auditedResult.audit.spillBackend;
    return {
      phase: 'mapped',
      success: true,
      durationMs: performance.now() - start,
      ...(spillBackend ? { spillBackend } : {}),
    };
  } catch (err) {
    // A Jev reading that could not be made (the overflow's output-keep rank)
    // propagates: what the call shows the model is decided by that reading,
    // and no fallback is decided for it.
    if (err instanceof JudgmentError || err instanceof JudgmentPortMissingError) throw err;
    // Other mapping problems pass through the original result with a visible warning.
    const message = summarizeError(err);
    const warning = `Output mapping warning: ${message}`;
    attachVisibleToolWarning(record.result, warning);
    return {
      phase: 'mapped',
      success: true,
      durationMs: performance.now() - start,
      warnings: [warning],
    };
  }
}

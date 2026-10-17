import type { Tool, ToolCall } from '../../../types/tools.js';
import type { ToolRuntimeContext } from '../context.js';
import type { PhaseResult, ToolExecutionRecord } from '../types.js';

/** Validate call identity, argument shape and executable tool presence.
 * Each tool validates its own parameter values before performing effects.
 */
export async function validatePhase(
  call: ToolCall,
  tool: Tool,
  _context: ToolRuntimeContext,
  _record: ToolExecutionRecord,
): Promise<PhaseResult> {
  const start = performance.now();

  if (!call.id || call.id.trim().length === 0) {
    return result(start, false, 'Tool call is missing a valid id');
  }

  if (!call.name || call.name.trim().length === 0) {
    return result(start, false, 'Tool call is missing a tool name');
  }

  if (call.arguments === null || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) {
    return result(start, false, `Tool call args must be a plain object, got: ${typeof call.arguments}`);
  }

  if (!tool || typeof tool.execute !== 'function') {
    return result(start, false, `Tool '${call.name}' is not a valid tool implementation`);
  }

  return result(start, true);
}

function result(start: number, success: boolean, error?: string): PhaseResult {
  return {
    phase: 'validated',
    success,
    durationMs: performance.now() - start,
    error,
    abort: success ? undefined : true,
  };
}

/** Agent read mechanics. Access follows owner configuration, never a Jev classification. */
import { executePolicyCheck } from '../execute-policy-check.js';
import type { Tool } from '../../types/tools.js';
import { assertAdmittedAgentRead } from '../../tools/read/admission.js';
export { assertAdmittedAgentRead } from '../../tools/read/admission.js';

type ReadToolArgs = {
  readonly files?: unknown;
  readonly image_mode?: unknown;
  readonly max_image_size?: unknown;
  readonly [key: string]: unknown;
};

const READ_POLICY_DENIAL = 'Invalid read options.';

export { AGENT_READ_IMAGE_MODES, AGENT_MAX_READ_FILES, AGENT_MAX_READ_IMAGE_SIZE_BYTES } from '../../tools/read/policy-contract.js';
export const AGENT_READ_POLICY_DENIAL_MESSAGE = READ_POLICY_DENIAL;
export const AGENT_READ_ADMISSION_DENIAL_MESSAGE = 'Agent read held: missing, stale, cancelled or unadmitted read authority.';

export function wrapReadToolForAgentPolicy(tool: Tool): void {
  narrowReadToolDefinitionForAgentPolicy(tool);
  const originalExecute = tool.execute.bind(tool);
  tool.execute = async (args, options) => {
    options?.signal?.throwIfAborted();
    const readArgs = args as ReadToolArgs;
    const denial = await executePolicyCheck(() => validateReadToolInvocationForAgentPolicy(readArgs, options?.signal), options?.signal);
    if (denial) return { success: false, error: denial };
    options?.signal?.throwIfAborted();
    return originalExecute(args, options);
  };
}

export async function validateReadToolInvocationForAgentPolicy(args: ReadToolArgs, signal?: AbortSignal): Promise<string | null> {
  signal?.throwIfAborted();
  return validateAgentReadMechanics(args);
}

/** The adopted runtime wrapper never performs a second semantic decision. */
export function wrapReadToolForAdmittedAgentPolicy(tool: Tool): void {
  narrowReadToolDefinitionForAgentPolicy(tool);
  const execute = tool.execute.bind(tool);
  tool.execute = async (args, options) => {
    const denial = validateAgentReadMechanics(args);
    if (denial) return { success: false, error: denial };
    try { assertAdmittedAgentRead(args, options); }
    catch { return { success: false, error: AGENT_READ_ADMISSION_DENIAL_MESSAGE }; }
    return execute(args, options);
  };
}

/** Published resource limits, separate from standalone legacy semantic validation. */
export function validateAgentReadMechanics(_args: ReadToolArgs): string | null {

  return null;
}

/** Compatibility helper: permission is decided by the configured read access filter. */
export async function isBlockedReadPath(_path: string, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  return false;
}

function narrowReadToolDefinitionForAgentPolicy(_tool: Tool): void {
  // The shared reader owns its schema, image modes and caller-selected size budget.
}

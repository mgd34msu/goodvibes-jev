/**
 * Main-conversation policy for the `read` tool: bounded, non-secret project
 * reads only.
 *
 * Hoisted from the agent (src/tools/agent-read-policy.ts) into the engine
 * gate. Read under the owner ruling of 2026-09-27: the secret-looking segment,
 * file-name and extension lists, and the rule refusing every hidden (dotted)
 * name, decided "does this path hold secrets" by spelling, so a token file
 * with an ordinary name passed and a harmless dotfile was refused. That is
 * now the gate's `secrets` reading (readTouchesSecrets), asked per path. The
 * file-count, image-mode and image-size limits stay code: they bound how much
 * one call reads and interpret nothing about the files.
 */
import { executePolicyCheck } from '../execute-policy-check.js';
import type { Tool } from '../../types/tools.js';
import { readTouchesSecrets } from '../../permissions/credential-read-defaults.js';
import { assertAdmittedAgentRead } from '../../tools/read/admission.js';
import { AGENT_READ_IMAGE_MODES, AGENT_MAX_READ_FILES, AGENT_MAX_READ_IMAGE_SIZE_BYTES } from '../../tools/read/policy-contract.js';
export { assertAdmittedAgentRead } from '../../tools/read/admission.js';

type ReadFileArgs = {
  readonly path?: unknown;
  readonly image_mode?: unknown;
  readonly [key: string]: unknown;
};

type ReadToolArgs = {
  readonly files?: unknown;
  readonly image_mode?: unknown;
  readonly max_image_size?: unknown;
  readonly [key: string]: unknown;
};

const READ_IMAGE_MODES = AGENT_READ_IMAGE_MODES;
const READ_IMAGE_MODE_SET = new Set<string>(READ_IMAGE_MODES);
const MAX_READ_FILES = AGENT_MAX_READ_FILES;
const MAX_READ_IMAGE_SIZE_BYTES = AGENT_MAX_READ_IMAGE_SIZE_BYTES;

const READ_POLICY_DENIAL = [
  'GoodVibes Agent only exposes bounded, non-secret project reads from the main conversation.',
  'The current admission must establish non-secret, in-scope subjects; broad batches, unoptimized extraction, and oversized image reads are disabled.',
].join(' ');

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
  const mechanical = validateAgentReadMechanics(args);
  if (mechanical) return mechanical;
  if (!Array.isArray(args.files)) return null;
  for (const file of args.files) {
    if (isRecord(file) && typeof file.path === 'string' && await isBlockedReadPath(file.path, signal)) return READ_POLICY_DENIAL;
  }
  return null;
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
export function validateAgentReadMechanics(args: ReadToolArgs): string | null {
  if (Array.isArray(args.files) && args.files.length > MAX_READ_FILES) return READ_POLICY_DENIAL;
  if (args.image_mode === 'unoptimized') return READ_POLICY_DENIAL;
  if (typeof args.image_mode === 'string' && !READ_IMAGE_MODE_SET.has(args.image_mode)) return READ_POLICY_DENIAL;
  if (typeof args.max_image_size === 'number' && args.max_image_size > MAX_READ_IMAGE_SIZE_BYTES) {
    return READ_POLICY_DENIAL;
  }

  if (!Array.isArray(args.files)) return null;
  for (const file of args.files) {
    if (!isRecord(file)) continue;
    const fileArgs = file as ReadFileArgs;
    if (fileArgs.image_mode === 'unoptimized') return READ_POLICY_DENIAL;
    if (typeof fileArgs.image_mode === 'string' && !READ_IMAGE_MODE_SET.has(fileArgs.image_mode)) {
      return READ_POLICY_DENIAL;
    }
  }

  return null;
}

/** Whether a read of `path` touches secret or credential material, read by Jev (uncertain counts as yes). */
export function isBlockedReadPath(path: string, signal?: AbortSignal): Promise<boolean> {
  return readTouchesSecrets('read', { path }, undefined, signal);
}

function narrowReadToolDefinitionForAgentPolicy(tool: Tool): void {
  tool.definition.description = 'Read ordinary non-secret project files for GoodVibes Agent.';
  tool.definition.sideEffects = ['read_fs'];
  tool.definition.concurrency = 'serial';

  const properties = tool.definition.parameters.properties;
  if (!isRecord(properties)) return;

  const files = properties.files;
  if (isRecord(files)) {
    files.maxItems = MAX_READ_FILES;
    files.description = 'Bounded project files whose current admission establishes non-secret, requested scope.';
    const itemSchema = files.items;
    if (isRecord(itemSchema)) {
      const fileProperties = itemSchema.properties;
      if (isRecord(fileProperties)) {
        const pathProperty = fileProperties.path;
        if (isRecord(pathProperty)) {
          pathProperty.description = 'Relative or absolute project path. The current owner checks each actual read subject.';
        }
        narrowImageModeProperty(fileProperties, 'image_mode');
      }
    }
  }

  narrowImageModeProperty(properties, 'image_mode');
  const maxImageSize = properties.max_image_size;
  if (isRecord(maxImageSize)) {
    maxImageSize.maximum = MAX_READ_IMAGE_SIZE_BYTES;
    maxImageSize.description = 'Maximum image file size in bytes allowed by GoodVibes Agent read policy.';
  }
}

function narrowImageModeProperty(properties: Record<string, unknown>, key: string): void {
  const property = properties[key];
  if (!isRecord(property)) return;
  property.enum = [...READ_IMAGE_MODES];
  property.description = 'Image handling mode allowed by GoodVibes Agent read policy. Full-resolution unoptimized extraction is disabled.';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

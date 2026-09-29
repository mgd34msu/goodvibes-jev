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
import type { Tool } from '../../types/tools.js';
import { readTouchesSecrets } from '../../permissions/credential-read-defaults.js';

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

const READ_IMAGE_MODES = ['default', 'metadata-only', 'thumbnail-only'] as const;
const READ_IMAGE_MODE_SET = new Set<string>(READ_IMAGE_MODES);
const MAX_READ_FILES = 10;
const MAX_READ_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;

const READ_POLICY_DENIAL = [
  'GoodVibes Agent only exposes bounded, non-secret project reads from the main conversation.',
  'Hidden paths, secret-looking files, broad batches, unoptimized image extraction, and oversized image reads are disabled here.',
  'Use explicit Agent CLI/slash commands or GoodVibes TUI delegation when the user intentionally asks for sensitive or deeper local inspection.',
].join(' ');

export const AGENT_READ_IMAGE_MODES = READ_IMAGE_MODES;
export const AGENT_MAX_READ_FILES = MAX_READ_FILES;
export const AGENT_MAX_READ_IMAGE_SIZE_BYTES = MAX_READ_IMAGE_SIZE_BYTES;
export const AGENT_READ_POLICY_DENIAL_MESSAGE = READ_POLICY_DENIAL;

export function wrapReadToolForAgentPolicy(tool: Tool): void {
  narrowReadToolDefinitionForAgentPolicy(tool);
  const originalExecute = tool.execute.bind(tool);
  tool.execute = async (args) => {
    const readArgs = args as ReadToolArgs;
    const denial = await validateReadToolInvocationForAgentPolicy(readArgs);
    if (denial) return { success: false, error: denial };
    return originalExecute(args);
  };
}

export async function validateReadToolInvocationForAgentPolicy(args: ReadToolArgs): Promise<string | null> {
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
    if (typeof fileArgs.path === 'string' && (await isBlockedReadPath(fileArgs.path))) return READ_POLICY_DENIAL;
  }

  return null;
}

/** Whether a read of `path` touches secret or credential material, read by Jev (uncertain counts as yes). */
export function isBlockedReadPath(path: string): Promise<boolean> {
  return readTouchesSecrets('read', { path });
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
    files.description = 'Ordinary non-hidden, non-secret-looking project files to read. Sensitive paths require explicit user-directed workflows.';
    const itemSchema = files.items;
    if (isRecord(itemSchema)) {
      const fileProperties = itemSchema.properties;
      if (isRecord(fileProperties)) {
        const pathProperty = fileProperties.path;
        if (isRecord(pathProperty)) {
          pathProperty.description = 'Relative or absolute path to a non-hidden, non-secret-looking project file.';
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

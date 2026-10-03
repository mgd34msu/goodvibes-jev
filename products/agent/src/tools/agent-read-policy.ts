import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { wasWrittenInAgentSession } from './agent-session-write-ledger.ts';

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

const SECRET_FILE_EXTENSIONS = new Set([
  '',
  '.cfg',
  '.conf',
  '.env',
  '.ini',
  '.json',
  '.properties',
  '.toml',
  '.txt',
  '.yaml',
  '.yml',
]);

const SECRET_EXACT_SEGMENTS = new Set([
  '.netrc',
  '.npmrc',
  '.pypirc',
  'apikey',
  'api_key',
  'credentials',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_rsa',
  'password',
  'passwords',
  'passwd',
  'secret',
  'secrets',
  'token',
  'tokens',
]);

const SECRET_EXACT_FILE_NAMES = new Set([
  'known_hosts',
]);

/**
 * Dotted names that stay blocked even for a path this session wrote. These are
 * credential stores by name, so authorship is not evidence they are safe to
 * echo back. They are already blocked for everyone by the hidden-name rule,
 * listing them here only limits the waiver and never blocks anything new.
 */
const NON_WAIVABLE_DOT_SEGMENTS = new Set([
  '.aws',
  '.docker',
  '.env',
  '.gnupg',
  '.kube',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.ssh',
]);

const PRIVATE_KEY_EXTENSIONS = new Set([
  '.key',
  '.p12',
  '.pem',
  '.pfx',
]);

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
  tool.execute = async (args, options) => {
    const readArgs = args as ReadToolArgs;
    const denial = validateReadToolInvocationForAgentPolicy(readArgs);
    if (denial) return { success: false, error: denial };
    return originalExecute(args, options);
  };
}

export function validateReadToolInvocationForAgentPolicy(args: ReadToolArgs): string | null {
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
    if (typeof fileArgs.path === 'string' && isBlockedReadPath(fileArgs.path)) return READ_POLICY_DENIAL;
  }

  return null;
}

export function isBlockedReadPath(path: string): boolean {
  const segments = path.replaceAll('\\', '/').split('/').filter((segment) => segment.length > 0);

  // A leading dot means "hidden", which is a reason to be careful about someone
  // else's file and no reason at all to refuse one this session just wrote. A
  // screenshot the agent saved to `~/.goodvibes-screen.png` was rejected as
  // secret-looking purely for its name, and only became readable after being
  // copied to an undotted path, and the browser round hit the same wall from
  // the other side, saving screenshots under the platform's dotted storage
  // root. When the exact path is in the session write ledger the hidden-name
  // rule is waived, except for the dotfiles below, which name credential
  // stores outright. Every other rule in this function (secret-looking
  // segments, private-key extensions, known_hosts) applies to session-written
  // paths exactly as before.
  const hiddenNameWaived = wasWrittenInAgentSession(path);

  for (const segment of segments) {
    if (segment === '.' || segment === '..') continue;
    const lower = segment.toLowerCase();
    if (lower.startsWith('.') && (!hiddenNameWaived || NON_WAIVABLE_DOT_SEGMENTS.has(lower))) return true;
    if (SECRET_EXACT_SEGMENTS.has(lower)) return true;
  }

  const fileName = segments.at(-1)?.toLowerCase() ?? '';
  if (fileName.length === 0) return false;
  if (SECRET_EXACT_FILE_NAMES.has(fileName)) return true;
  const extension = getExtension(fileName);
  if (PRIVATE_KEY_EXTENSIONS.has(extension)) return true;
  const stem = extension.length > 0 ? fileName.slice(0, -extension.length) : fileName;
  return SECRET_EXACT_SEGMENTS.has(stem) && SECRET_FILE_EXTENSIONS.has(extension);
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

function getExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex <= 0) return '';
  return fileName.slice(dotIndex);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

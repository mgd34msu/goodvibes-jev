/**
 * Per-language configuration for CodeIntelligence.
 *
 * Config is loaded from (in priority order, higher overrides lower):
 *   1. every configured project languages/{langId}.json file
 *   2. every configured user languages/{langId}.json file
 *   3. Built-in defaults (this file)
 * A file whose langId has no built-in default adds that language.
 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger.js';
import type { ShellPathService } from '../runtime/shell-paths.js';
import { summarizeError } from '../utils/error-display.js';

export interface LanguageConfig {
  lsp?: {
    command: string;
    args: string[];
    initializationOptions?: Record<string, unknown> | undefined;
  };
  /** Grammar ID passed to the tree-sitter service (usually the same as langId). */
  treeSitter?: string | undefined;
  formatter?: { command: string; args: string[] };
  linter?: { command: string; args: string[] };
}

export type IntelligenceRoots = Pick<ShellPathService, 'workingDirectory' | 'homeDirectory'> & Partial<Pick<ShellPathService, 'resolveProjectPath' | 'resolveUserPath'>>;

// ---------------------------------------------------------------------------
// Default configurations
// ---------------------------------------------------------------------------

/**
 * Built-in defaults for common languages.
 * These are used when no user or project override exists.
 */
export function getDefaultConfigs(): Map<string, LanguageConfig> {
  const defaults = new Map<string, LanguageConfig>();

  defaults.set('typescript', {
    lsp: { command: 'typescript-language-server', args: ['--stdio'] },
    treeSitter: 'typescript',
  });

  defaults.set('tsx', {
    lsp: { command: 'typescript-language-server', args: ['--stdio'] },
    treeSitter: 'tsx',
  });

  defaults.set('javascript', {
    lsp: { command: 'typescript-language-server', args: ['--stdio'] },
    treeSitter: 'javascript',
  });

  defaults.set('python', {
    lsp: { command: 'pyright-langserver', args: ['--stdio'] },
    treeSitter: 'python',
  });

  defaults.set('rust', {
    lsp: { command: 'rust-analyzer', args: [] },
    treeSitter: 'rust',
  });

  defaults.set('go', {
    lsp: { command: 'gopls', args: ['serve'] },
    treeSitter: 'go',
  });

  defaults.set('bash', {
    lsp: { command: 'bash-language-server', args: ['start'] },
    treeSitter: 'bash',
  });

  defaults.set('css', {
    lsp: { command: 'vscode-css-language-server', args: ['--stdio'] },
    treeSitter: 'css',
  });

  defaults.set('html', {
    lsp: { command: 'vscode-html-language-server', args: ['--stdio'] },
    treeSitter: 'html',
  });

  defaults.set('json', {
    lsp: { command: 'vscode-json-language-server', args: ['--stdio'] },
    treeSitter: 'json',
  });

  return defaults;
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

type CommandSpec = { command: string; args: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCommandSpec(value: unknown): value is CommandSpec {
  return isRecord(value)
    && typeof value.command === 'string'
    && value.command.trim().length > 0
    && Array.isArray(value.args)
    && value.args.every((arg) => typeof arg === 'string');
}

/**
 * Check a parsed language file against the LanguageConfig shape. Returns the
 * reason it is unusable, or null when every field present is well formed and
 * at least one field is present.
 */
function describeLanguageConfigProblem(value: unknown): string | null {
  if (!isRecord(value)) return 'file is not a JSON object';
  const known = ['lsp', 'treeSitter', 'formatter', 'linter'] as const;
  if (!known.some((key) => value[key] !== undefined)) {
    return 'file sets none of lsp, treeSitter, formatter, linter';
  }
  if (value.lsp !== undefined) {
    if (!isCommandSpec(value.lsp)) return 'lsp needs a non-empty command string and an args string array';
    const init = (value.lsp as Record<string, unknown>).initializationOptions;
    if (init !== undefined && !isRecord(init)) return 'lsp.initializationOptions must be an object';
  }
  if (value.treeSitter !== undefined && (typeof value.treeSitter !== 'string' || value.treeSitter.trim().length === 0)) {
    return 'treeSitter must be a non-empty string';
  }
  if (value.formatter !== undefined && !isCommandSpec(value.formatter)) {
    return 'formatter needs a non-empty command string and an args string array';
  }
  if (value.linter !== undefined && !isCommandSpec(value.linter)) {
    return 'linter needs a non-empty command string and an args string array';
  }
  return null;
}

/**
 * Read one languages/{langId}.json file. Returns null (after a warning) when
 * the file cannot be read, is not JSON, or does not have the LanguageConfig
 * shape, so a bad file never replaces a working config.
 */
function readConfigFile(filePath: string): LanguageConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (err) {
    logger.warn('config: failed to read language config', {
      filePath,
      error: summarizeError(err),
    });
    return null;
  }
  const problem = describeLanguageConfigProblem(parsed);
  if (problem) {
    logger.warn('config: skipping invalid language config', { filePath, problem });
    return null;
  }
  return parsed as LanguageConfig;
}

/**
 * Read every *.json file in a languages directory, keyed by language id (the
 * file name without .json). A missing directory yields an empty map.
 */
function readConfigDirectory(dir: string): Map<string, LanguageConfig> {
  const found = new Map<string, LanguageConfig>();
  if (!existsSync(dir)) return found;
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort();
  } catch (err) {
    logger.warn('config: failed to list language config directory', { dir, error: summarizeError(err) });
    return found;
  }
  for (const name of names) {
    const langId = name.slice(0, -'.json'.length);
    if (langId.length === 0) continue;
    const cfg = readConfigFile(join(dir, name));
    if (cfg) found.set(langId, cfg);
  }
  return found;
}

/**
 * Load all language configs: the built-in defaults, then every
 * languages/*.json file in the user directory, then every one in the project
 * directory. Precedence is defaults < user < project, merged per top-level
 * field. A file for a language id with no built-in default adds that language.
 */
export function loadLanguageConfigs(roots: IntelligenceRoots): Map<string, LanguageConfig> {
  const result = getDefaultConfigs();

  const userDir = roots.resolveUserPath
    ? roots.resolveUserPath('languages')
    : join(roots.homeDirectory, '.goodvibes', 'languages');
  const projectDir = roots.resolveProjectPath
    ? roots.resolveProjectPath('languages')
    : join(roots.workingDirectory, '.goodvibes', 'languages');

  for (const layer of [readConfigDirectory(userDir), readConfigDirectory(projectDir)]) {
    for (const [langId, cfg] of layer) {
      result.set(langId, { ...(result.get(langId) ?? {}), ...cfg });
    }
  }

  return result;
}

/**
 * Get config for a specific language ID.
 * Loads configs on demand.
 */
export function getLanguageConfig(langId: string, roots: IntelligenceRoots): LanguageConfig | null {
  return loadLanguageConfigs(roots).get(langId) ?? null;
}

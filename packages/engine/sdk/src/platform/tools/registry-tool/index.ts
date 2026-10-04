import { join, resolve, isAbsolute } from 'node:path';
import { logger } from '../../utils/logger.js';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { registryCandidateView, registryRank } from '../batteries/registry-rank.js';
import {
  collectMarkdownReferences,
  extractMarkdownPreview,
  normalizeFrontmatterList,
  parseMarkdownFrontmatter,
} from '../../utils/markdown-disclosure.js';
import type { Tool, ToolDefinition, ToolExecuteOptions } from '../../types/tools.js';
import type { ToolRegistry } from '../registry.js';
import { REGISTRY_TOOL_SCHEMA } from './schema.js';
import { toRecord } from '../../utils/record-coerce.js';
import type { RegistryInput } from './schema.js';
import { summarizeError } from '../../utils/error-display.js';
import type { ContractInputAuthority } from '../../contract/input-authority.js';
import { liveRegistrySource, registryMarkdown, materializeRegistryMarkdown, type RegistryToolSource } from './source.js';
import { capturedRegistryAdmission, type CapturedRegistryContext } from './captured-source.js';

const capturedTools = new WeakMap<Tool, ContractInputAuthority>();
export function isCapturedRegistryTool(tool: Tool, authority: ContractInputAuthority): boolean {
  return capturedTools.get(tool) === authority;
}

// ---------------------------------------------------------------------------
// Directory scanning helpers
// ---------------------------------------------------------------------------

interface RegistryMatch {
  name: string;
  type: 'skill' | 'agent' | 'tool';
  description: string;
  path: string;
  preview?: string | undefined;
  dependencies?: string[] | undefined;
  includes?: string[] | undefined;
  sections?: string[] | undefined;
}

export interface RegistryToolRoots {
  readonly workingDirectory: string;
  readonly homeDirectory?: string | undefined;
  readonly capturedInput?: CapturedRegistryContext | undefined;
}

async function scanDirectoryAll(
  dir: string,
  itemType: 'skill' | 'agent',
  source: RegistryToolSource,
): Promise<RegistryMatch[]> {
  if (!await source.exists(dir)) return [];
  const results: RegistryMatch[] = [];
  let entries: readonly string[];
  try {
    entries = await source.list(dir);
  } catch {
    return [];
  }
  for (const entry of entries) {
    // Strategy 1: flat .md file (e.g., skills/foo.md)
    if (entry.endsWith('.md')) {
      const filePath = join(dir, entry);
      let content = '';
      try {
        content = await source.read(filePath);
      } catch {
        continue;
      }
      const { metadata: frontmatter, body } = parseMarkdownFrontmatter(content);
      const name = typeof frontmatter['name'] === 'string' ? frontmatter['name'] : entry.replace(/\.md$/, '');
      const description = typeof frontmatter['description'] === 'string' ? frontmatter['description'] : '';
      results.push({
        name,
        type: itemType,
        description,
        path: filePath,
        preview: extractMarkdownPreview(body),
        dependencies: normalizeFrontmatterList(frontmatter['depends_on']),
        includes: collectMarkdownReferences(body),
      });
      continue;
    }

    // Strategy 2: directory with SKILL.md or AGENT.md (e.g., skills/foo/SKILL.md)
    const markerFile = itemType === 'skill' ? 'SKILL.md' : 'AGENT.md';
    const markerPath = join(dir, entry, markerFile);
    if (await source.exists(markerPath)) {
      let content = '';
      try {
        content = await source.read(markerPath);
      } catch {
        continue;
      }
      const { metadata: frontmatter, body } = parseMarkdownFrontmatter(content);
      const name = typeof frontmatter['name'] === 'string' ? frontmatter['name'] : entry;
      const description = typeof frontmatter['description'] === 'string' ? frontmatter['description'] : '';
      results.push({
        name,
        type: itemType,
        description,
        path: markerPath,
        preview: extractMarkdownPreview(body),
        dependencies: normalizeFrontmatterList(frontmatter['depends_on']),
        includes: collectMarkdownReferences(body),
      });
    }
  }
  return results;
}

/** The decision site the registry-rank reading is logged under. */
export const REGISTRY_RANK_SITE = 'tools.registry-rank';

/** Project-local entries override global ones of the same type and name (first seen wins). */
function dedupe(items: readonly RegistryMatch[]): RegistryMatch[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.type}:${item.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Reads every candidate against `query` (search words or a task description)
 * through the `engine.tools.registry-rank` rerank. `matching` holds the
 * candidates not read as a no, best first; `rest` holds the ones read as a
 * no, alphabetically.
 */
async function rankAgainst(
  items: readonly RegistryMatch[],
  query: string,
  source: RegistryToolSource,
): Promise<{ matching: RegistryMatch[]; rest: RegistryMatch[] }> {
  if (items.length === 0) return { matching: [], rest: [] };
  const byId = new Map(items.map((item) => [`${item.type}:${item.name}`, item]));
  const candidates = Array.from(byId, ([id, item]) => ({ id, content: registryCandidateView(item) }));
  const port = judgmentPort(REGISTRY_RANK_SITE);
  // Captured candidates are dispatched one at a time so a revocation during one
  // judgment cannot leave another queued candidate carrying stale authorization.
  let priorJudgment = Promise.resolve();
  const guardedPort: typeof port = {
    model: port.model,
    ...(port.recorder === undefined ? {} : { recorder: port.recorder }),
    ...(port.health === undefined ? {} : { health: port.health }),
    ask: async (request) => {
      if (source === liveRegistrySource) return port.ask(request);
      const previous = priorJudgment;
      let release!: () => void;
      priorJudgment = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        await source.assertCurrent();
        const signal = source.signal && request.signal ? AbortSignal.any([source.signal, request.signal]) : (source.signal ?? request.signal);
        const result = await port.ask({ ...request, ...(signal === undefined ? {} : { signal }) });
        await source.assertCurrent();
        return result;
      } finally { release(); }
    },
  };
  const { ranked } = await registryRank.rerank(guardedPort, query, candidates, { site: REGISTRY_RANK_SITE });
  const matching = ranked.filter((entry) => entry.reading.verdict !== 'no').map((entry) => byId.get(entry.id)!);
  const rest = ranked
    .filter((entry) => entry.reading.verdict === 'no')
    .map((entry) => byId.get(entry.id)!)
    .sort((a, b) => a.name.localeCompare(b.name));
  return { matching, rest };
}

function listTools(toolRegistry: ToolRegistry): RegistryMatch[] {
  return toolRegistry.list().map((t) => ({
    name: t.definition.name,
    type: 'tool' as const,
    description: t.definition.description,
    path: '',
  }));
}

function getSkillDirs(roots: RegistryToolRoots): string[] {
  const dirs = [
    join(roots.workingDirectory, '.goodvibes', 'skills'),
  ];
  if (roots.homeDirectory) {
    dirs.push(
      join(roots.homeDirectory, '.goodvibes', 'skills'),
    );
  }
  return dirs;
}

function getAgentDirs(roots: RegistryToolRoots): string[] {
  const dirs = [
    join(roots.workingDirectory, '.goodvibes', 'agents'),
  ];
  if (roots.homeDirectory) {
    dirs.push(
      join(roots.homeDirectory, '.goodvibes', 'agents'),
    );
  }
  return dirs;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the `registry` tool bound to the given ToolRegistry.
 *
 * Returns a Tool object conforming to the Tool interface.
 * Never throws from execute().
 */
export function createRegistryTool(toolRegistry: ToolRegistry, roots: RegistryToolRoots): Tool {
  const captured = roots.capturedInput === undefined ? undefined : capturedRegistryAdmission(roots.capturedInput);
  roots = Object.freeze(captured
    ? { workingDirectory: captured.workingDirectory, homeDirectory: captured.homeDirectory }
    : { workingDirectory: roots.workingDirectory, homeDirectory: roots.homeDirectory });
  const definition: ToolDefinition = {
    name: 'registry',
    description:
      'Discover and inspect skills, agents, and tools.'
      + ' Modes: search finds items by keyword; recommend lists items sorted by relevance;'
      + ' dependencies reads a skill\'s dependency chain; content returns full markdown file.',
    parameters: toRecord(REGISTRY_TOOL_SCHEMA),
    sideEffects: ['read_fs'],
    concurrency: 'parallel',
  };

  async function execute(
    args: Record<string, unknown>,
    options?: ToolExecuteOptions,
  ): Promise<{ success: boolean; output?: string; error?: string }> {
    const signal = options?.signal;
    const source = captured?.source(signal) ?? liveRegistrySource;
    try {
      args = structuredClone(args);
      signal?.throwIfAborted();
      await source.assertCurrent();
      if (!args.mode || typeof args.mode !== 'string') {
        return { success: false, error: 'Missing required "mode" field' };
      }
      const input = args as unknown as RegistryInput;
      const { mode } = input;

      const result = await (async () => {
        switch (mode) {
          case 'search':       return runSearch(input, toolRegistry, roots, source);
          case 'recommend':    return runRecommend(input, toolRegistry, roots, source);
          case 'dependencies': return runDependencies(input, roots, source);
          case 'preview':      return runPreview(input, roots, source);
          case 'content':      return runContent(input, roots, source);
          default: return { success: false, error: `Unknown mode: ${String(mode)}` };
        }
      })();
      await source.assertCurrent();
      signal?.throwIfAborted();
      return result;
    } catch (err) {
      if (captured) return { success: false, error: 'Captured registry input held: missing, changed, cancelled or restricted original-owner authority. Output withheld.' };
      const message = summarizeError(err);
      logger.error('registry tool: unexpected error', { error: message });
      return { success: false, error: `Unexpected error: ${message}` };
    }
  }

  const tool = { definition, execute };
  if (captured) capturedTools.set(tool, captured.authority);
  return tool;
}

// ---------------------------------------------------------------------------
// Mode handlers
// ---------------------------------------------------------------------------

async function runSearch(
  input: RegistryInput,
  toolRegistry: ToolRegistry,
  roots: RegistryToolRoots,
  source: RegistryToolSource,
): Promise<{ success: boolean; output?: string; error?: string }> {
  const query = input.query ?? '';
  const typeFilter = input.type ?? 'all';
  const all: RegistryMatch[] = [];

  if (typeFilter === 'skills' || typeFilter === 'all') {
    for (const dir of getSkillDirs(roots)) all.push(...await scanDirectoryAll(dir, 'skill', source));
  }
  if (typeFilter === 'agents' || typeFilter === 'all') {
    for (const dir of getAgentDirs(roots)) all.push(...await scanDirectoryAll(dir, 'agent', source));
  }
  if (typeFilter === 'tools' || typeFilter === 'all') {
    all.push(...listTools(toolRegistry));
  }

  const candidates = dedupe(all);
  const results = query ? (await rankAgainst(candidates, query, source)).matching : candidates;

  return {
    success: true,
    output: JSON.stringify({
      mode: 'search',
      query,
      count: results.length,
      results,
    }),
  };
}

async function runRecommend(
  input: RegistryInput,
  toolRegistry: ToolRegistry,
  roots: RegistryToolRoots,
  source: RegistryToolSource,
): Promise<{ success: boolean; output?: string; error?: string }> {
  const task = input.task ?? '';
  const scope = input.scope ?? 'skills';

  let candidates: RegistryMatch[];
  if (scope === 'tools') {
    candidates = listTools(toolRegistry);
  } else {
    candidates = [];
    for (const dir of getSkillDirs(roots)) {
      candidates.push(...await scanDirectoryAll(dir, 'skill', source));
    }
    candidates = dedupe(candidates);
  }

  // With a task: the candidates read as fitting it, best first, then the rest
  // alphabetically. Without one: every candidate alphabetically.
  let sorted: RegistryMatch[];
  if (task) {
    const { matching, rest } = await rankAgainst(candidates, task, source);
    sorted = [...matching, ...rest];
  } else {
    sorted = [...candidates].sort((a, b) => a.name.localeCompare(b.name));
  }

  return {
    success: true,
    output: JSON.stringify({
      mode: 'recommend',
      task,
      scope,
      count: sorted.length,
      results: sorted,
    }),
  };
}

async function runDependencies(
  input: RegistryInput,
  roots: RegistryToolRoots,
  source: RegistryToolSource,
): Promise<{ success: boolean; output?: string; error?: string }> {
  const skillName = input.skillName;
  if (!skillName) {
    return Promise.resolve({
      success: false,
      error: 'mode "dependencies" requires "skillName"',
    });
  }

  let filePath: string | null = null;

  for (const dir of getSkillDirs(roots)) {
    const candidate = join(dir, `${skillName}.md`);
    if (await source.exists(candidate)) {
      filePath = candidate;
      break;
    }
    // Also try exact match without .md appended (caller may have included extension)
    const candidateExact = join(dir, skillName);
    if (await source.exists(candidateExact)) {
      filePath = candidateExact;
      break;
    }
  }

  if (!filePath) {
    return Promise.resolve({
      success: false,
      error: `Skill not found: ${skillName}`,
    });
  }

  let content: string;
  try {
    content = await source.read(filePath);
  } catch (err) {
    return Promise.resolve({
      success: false,
      error: `Failed to read skill file: ${summarizeError(err)}`,
    });
  }

  const { metadata: frontmatter, body } = parseMarkdownFrontmatter(content);

  // Parse depends_on: can be a comma-separated string or single name
  const dependencies = normalizeFrontmatterList(frontmatter['depends_on']);
  const includes = collectMarkdownReferences(body);

  return Promise.resolve({
    success: true,
    output: JSON.stringify({
      mode: 'dependencies',
      skillName,
      path: filePath,
      depends_on: dependencies,
      includes,
    }),
  });
}

async function runPreview(
  input: RegistryInput,
  roots: RegistryToolRoots,
  source: RegistryToolSource,
): Promise<{ success: boolean; output?: string; error?: string }> {
  const resolvedPath = await resolveRegistryPath(input.path, roots, source);
  if (!resolvedPath.ok) return Promise.resolve({ success: false, error: resolvedPath.error });

  try {
    const disclosure = await registryMarkdown(source, resolvedPath.path);
    return Promise.resolve({
      success: true,
      output: JSON.stringify({
        mode: 'preview',
        path: disclosure.path,
        metadata: disclosure.metadata,
        preview: disclosure.preview,
        includes: disclosure.includes,
        sections: disclosure.sections,
        dependencies: normalizeFrontmatterList(disclosure.metadata['depends_on']),
      }),
    });
  } catch (err) {
    return Promise.resolve({
      success: false,
      error: `Failed to preview file: ${summarizeError(err)}`,
    });
  }
}

async function runContent(
  input: RegistryInput,
  roots: RegistryToolRoots,
  source: RegistryToolSource,
): Promise<{ success: boolean; output?: string; error?: string }> {
  const resolvedPath = await resolveRegistryPath(input.path, roots, source);
  if (!resolvedPath.ok) return Promise.resolve({ success: false, error: resolvedPath.error });

  const disclosure = await registryMarkdown(source, resolvedPath.path);
  return Promise.resolve({
    success: true,
    output: JSON.stringify({
      mode: 'content',
      path: resolvedPath.path,
      metadata: disclosure.metadata,
      content: await materializeRegistryMarkdown(source, resolvedPath.path, disclosure.body),
    }),
  });
}

async function resolveRegistryPath(path: string | undefined, roots: RegistryToolRoots, source: RegistryToolSource): Promise<
  | { ok: true; path: string }
  | { ok: false; error: string }> {
  if (!path) {
    return {
      ok: false,
      error: 'mode requires "path"',
    };
  }

  const resolvedPath = isAbsolute(path)
    ? path
    : resolve(roots.workingDirectory, path);

  if (!resolvedPath.includes('.goodvibes/')) {
    return {
      ok: false,
      error: 'mode can only read files within .goodvibes/ directories',
    };
  }

  if (!await source.exists(resolvedPath)) {
    return {
      ok: false,
      error: `File not found: ${resolvedPath}`,
    };
  }

  return { ok: true, path: resolvedPath };
}

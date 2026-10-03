import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseMarkdownFrontmatter, stripMarkdownFrontmatter } from '../agent/markdown-frontmatter.ts';

/**
 * OpenClaw workspace importer, pure scanner.
 *
 * Targets OpenClaw workspace layout v1 (the documented/observable on-disk
 * layout; this importer never installs or runs OpenClaw itself). A workspace
 * is a directory (default ~/.openclaw, or a user-supplied path) laid out as:
 *
 *   <root>/
 *     CLAUDE.md | AGENTS.md | OPENCLAW.md        top-level instruction files -> personas
 *     instructions/*.md | personas/*.md          instruction files          -> personas
 *     memory.md | memory/*.md                     memory markdown            -> memory records
 *     skills/<name>.md | skills/<name>/SKILL.md   skill definitions          -> skills
 *     allowed-tools.json | allowlist.json |       tool allowlist config      -> permission settings
 *       tools.json | permissions.json
 *
 * Frontmatter conventions honored (all optional):
 *   persona: name, description (or summary/title)
 *   memory:  class, scope, tags (comma-separated), summary
 *   skill:   name, description (or summary), requires-env, requires-command(s)
 *
 * This module only READS. It produces an OpenClawImportPlan; writing through
 * the Agent's registries happens in import-command.ts. Anything that is not a
 * recognized instruction/memory/skill/allowlist file is reported as skipped
 * with a plain reason, never guessed.
 */

export const OPENCLAW_LAYOUT_VERSION = 'v1';

const VALID_MEMORY_CLASSES = new Set([
  'decision', 'constraint', 'incident', 'pattern', 'fact', 'risk', 'runbook', 'architecture', 'ownership',
]);
const VALID_MEMORY_SCOPES = new Set(['session', 'project', 'team']);

const INSTRUCTION_FILENAMES = new Set(['claude.md', 'agents.md', 'openclaw.md']);
const INSTRUCTION_DIRS = ['instructions', 'personas'];
const ALLOWLIST_FILENAMES = ['allowed-tools.json', 'allowlist.json', 'tools.json', 'permissions.json'];

/**
 * OpenClaw allowlist tool identifier -> Agent permission tool category. The
 * Agent permission model groups tools into categories (see the SDK config
 * schema permissions.tools). An allowlist entry maps to a category by its
 * leading verb; `Bash(git*)`-style entries map by the tool name before `(`.
 */
const TOOL_CATEGORY_MAP: Readonly<Record<string, string>> = {
  read: 'read', view: 'read', cat: 'read', open: 'read',
  write: 'write', create: 'write',
  edit: 'edit', str_replace: 'edit', patch: 'edit', apply_patch: 'edit',
  exec: 'exec', bash: 'exec', shell: 'exec', run: 'exec', terminal: 'exec', command: 'exec',
  find: 'find', grep: 'find', search: 'find', glob: 'find', ls: 'find',
  fetch: 'fetch', web: 'fetch', webfetch: 'fetch', web_fetch: 'fetch', curl: 'fetch', http: 'fetch', browse: 'fetch',
  analyze: 'analyze', analysis: 'analyze',
  inspect: 'inspect',
  agent: 'agent', task: 'agent', subagent: 'agent', dispatch: 'agent',
  state: 'state', memory: 'state', store: 'state',
  workflow: 'workflow',
  registry: 'registry',
  delegate: 'delegate',
  mcp: 'mcp',
};

export interface PlannedPersona {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly tags: readonly string[];
  readonly sourcePath: string;
}

export interface PlannedMemory {
  readonly cls: string;
  readonly scope: string;
  readonly summary: string;
  readonly detail?: string;
  readonly tags: readonly string[];
  readonly sourcePath: string;
}

export interface PlannedSkill {
  readonly name: string;
  readonly description: string;
  readonly procedure: string;
  readonly tags: readonly string[];
  readonly requiresEnv: readonly string[];
  readonly requiresCommand: readonly string[];
  readonly sourcePath: string;
}

export interface PlannedPermissions {
  readonly sourcePath: string | null;
  /** Distinct Agent tool categories that would be set to 'allow'. */
  readonly categories: readonly string[];
  /** Allowlist entries that mapped to a category, for the report. */
  readonly matched: readonly { readonly entry: string; readonly category: string }[];
}

export interface SkippedEntry {
  readonly path: string;
  readonly reason: string;
}

export interface OpenClawImportPlan {
  readonly sourcePath: string;
  readonly exists: boolean;
  readonly personas: readonly PlannedPersona[];
  readonly memories: readonly PlannedMemory[];
  readonly skills: readonly PlannedSkill[];
  readonly permissions: PlannedPermissions;
  readonly skipped: readonly SkippedEntry[];
}

function frontmatterList(frontmatter: Record<string, string>, ...keys: readonly string[]): readonly string[] {
  for (const key of keys) {
    const value = frontmatter[key];
    if (value) return value.split(',').map((entry) => entry.trim()).filter(Boolean);
  }
  return [];
}

function firstFrontmatter(frontmatter: Record<string, string>, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = frontmatter[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function safeReadFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

function listDir(path: string): readonly string[] {
  try {
    return readdirSync(path).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function personaFromFile(path: string, skipped: SkippedEntry[]): PlannedPersona | null {
  const content = safeReadFile(path);
  if (content === null) {
    skipped.push({ path, reason: 'could not read instruction file' });
    return null;
  }
  const frontmatter = parseMarkdownFrontmatter(content);
  const body = stripMarkdownFrontmatter(content);
  if (!body) {
    skipped.push({ path, reason: 'instruction file has no body after frontmatter' });
    return null;
  }
  const name = firstFrontmatter(frontmatter, 'name') ?? basename(path).replace(/\.md$/i, '');
  const description = firstFrontmatter(frontmatter, 'description', 'summary', 'title')
    ?? `Imported from OpenClaw instruction file ${basename(path)}.`;
  return { name, description, body, tags: frontmatterList(frontmatter, 'tags'), sourcePath: path };
}

function collectPersonas(root: string, skipped: SkippedEntry[]): PlannedPersona[] {
  const personas: PlannedPersona[] = [];
  for (const entry of listDir(root)) {
    if (!entry.toLowerCase().endsWith('.md')) continue;
    const full = join(root, entry);
    if (isDirectory(full)) continue;
    if (INSTRUCTION_FILENAMES.has(entry.toLowerCase())) {
      const persona = personaFromFile(full, skipped);
      if (persona) personas.push(persona);
    } else {
      skipped.push({ path: full, reason: 'top-level markdown is not a recognized instruction file (CLAUDE.md, AGENTS.md, OPENCLAW.md)' });
    }
  }
  for (const dir of INSTRUCTION_DIRS) {
    const dirPath = join(root, dir);
    if (!isDirectory(dirPath)) continue;
    for (const entry of listDir(dirPath)) {
      if (!entry.toLowerCase().endsWith('.md')) continue;
      const persona = personaFromFile(join(dirPath, entry), skipped);
      if (persona) personas.push(persona);
    }
  }
  return personas;
}

function memoriesFromFile(path: string, skipped: SkippedEntry[]): PlannedMemory[] {
  const content = safeReadFile(path);
  if (content === null) {
    skipped.push({ path, reason: 'could not read memory file' });
    return [];
  }
  const frontmatter = parseMarkdownFrontmatter(content);
  const clsRaw = firstFrontmatter(frontmatter, 'class', 'cls');
  if (clsRaw && !VALID_MEMORY_CLASSES.has(clsRaw)) {
    skipped.push({ path, reason: `unknown memory class "${clsRaw}" (expected one of ${[...VALID_MEMORY_CLASSES].join(', ')})` });
    return [];
  }
  const scopeRaw = firstFrontmatter(frontmatter, 'scope');
  if (scopeRaw && !VALID_MEMORY_SCOPES.has(scopeRaw)) {
    skipped.push({ path, reason: `unknown memory scope "${scopeRaw}" (expected one of ${[...VALID_MEMORY_SCOPES].join(', ')})` });
    return [];
  }
  const cls = clsRaw ?? 'fact';
  const scope = scopeRaw ?? 'project';
  const tags = frontmatterList(frontmatter, 'tags');
  const body = stripMarkdownFrontmatter(content);
  const bullets = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, '').trim())
    .filter(Boolean);
  if (bullets.length > 0) {
    return bullets.map((summary) => ({ cls, scope, summary, tags, sourcePath: path }));
  }
  const lines = body.split('\n').map((line) => line.trim());
  const summary = lines.find(Boolean)?.replace(/^#+\s*/, '') ?? '';
  if (!summary) {
    skipped.push({ path, reason: 'memory file has no bullet points or text after frontmatter' });
    return [];
  }
  const detail = lines.slice(lines.indexOf(lines.find(Boolean) ?? '') + 1).join('\n').trim() || undefined;
  return [{ cls, scope, summary, detail, tags, sourcePath: path }];
}

function collectMemories(root: string, skipped: SkippedEntry[]): PlannedMemory[] {
  const memories: PlannedMemory[] = [];
  const topLevel = join(root, 'memory.md');
  if (existsSync(topLevel) && !isDirectory(topLevel)) {
    memories.push(...memoriesFromFile(topLevel, skipped));
  }
  const dirPath = join(root, 'memory');
  if (isDirectory(dirPath)) {
    for (const entry of listDir(dirPath)) {
      if (!entry.toLowerCase().endsWith('.md')) {
        skipped.push({ path: join(dirPath, entry), reason: 'non-markdown file in memory folder' });
        continue;
      }
      memories.push(...memoriesFromFile(join(dirPath, entry), skipped));
    }
  }
  return memories;
}

function skillFromFile(path: string, nameHint: string, skipped: SkippedEntry[]): PlannedSkill | null {
  const content = safeReadFile(path);
  if (content === null) {
    skipped.push({ path, reason: 'could not read skill file' });
    return null;
  }
  const frontmatter = parseMarkdownFrontmatter(content);
  const procedure = stripMarkdownFrontmatter(content);
  if (!procedure) {
    skipped.push({ path, reason: 'skill file has no procedure body after frontmatter' });
    return null;
  }
  const name = firstFrontmatter(frontmatter, 'name') ?? nameHint;
  const description = firstFrontmatter(frontmatter, 'description', 'summary')
    ?? `Imported from OpenClaw skill file ${basename(path)}.`;
  return {
    name,
    description,
    procedure,
    tags: frontmatterList(frontmatter, 'tags'),
    requiresEnv: frontmatterList(frontmatter, 'requires-env', 'requiresEnv', 'requires_env'),
    requiresCommand: frontmatterList(frontmatter, 'requires-command', 'requires-commands', 'requiresCommands', 'commands'),
    sourcePath: path,
  };
}

function collectSkills(root: string, skipped: SkippedEntry[]): PlannedSkill[] {
  const dirPath = join(root, 'skills');
  if (!isDirectory(dirPath)) return [];
  const skills: PlannedSkill[] = [];
  for (const entry of listDir(dirPath)) {
    const full = join(dirPath, entry);
    if (isDirectory(full)) {
      const markerCandidates = ['SKILL.md', 'skill.md'];
      const marker = markerCandidates.map((m) => join(full, m)).find((p) => existsSync(p));
      if (marker) {
        const skill = skillFromFile(marker, entry, skipped);
        if (skill) skills.push(skill);
      } else {
        skipped.push({ path: full, reason: 'skill folder has no SKILL.md' });
      }
      continue;
    }
    if (!entry.toLowerCase().endsWith('.md')) {
      skipped.push({ path: full, reason: 'non-markdown file in skills folder' });
      continue;
    }
    const skill = skillFromFile(full, entry.replace(/\.md$/i, ''), skipped);
    if (skill) skills.push(skill);
  }
  return skills;
}

/** Normalize one allowlist entry to a bare tool name (strips `Bash(git*)` args and casing). */
function normalizeAllowlistEntry(entry: string): string {
  const beforeParen = entry.split('(')[0] ?? entry;
  return beforeParen.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function collectAllowlistEntries(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string');
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['allow', 'allowed', 'allowedTools', 'allowed_tools', 'tools']) {
      const nested = record[key];
      if (Array.isArray(nested)) return nested.filter((entry): entry is string => typeof entry === 'string');
    }
  }
  return [];
}

function collectPermissions(root: string, skipped: SkippedEntry[]): PlannedPermissions {
  for (const filename of ALLOWLIST_FILENAMES) {
    const full = join(root, filename);
    if (!existsSync(full) || isDirectory(full)) continue;
    const content = safeReadFile(full);
    if (content === null) {
      skipped.push({ path: full, reason: 'could not read allowlist file' });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      skipped.push({ path: full, reason: 'allowlist file is not valid JSON' });
      continue;
    }
    const entries = collectAllowlistEntries(parsed);
    if (entries.length === 0) {
      skipped.push({ path: full, reason: 'allowlist file has no recognizable tool entries (expected an array, or an "allow"/"tools" array)' });
      continue;
    }
    const matched: { entry: string; category: string }[] = [];
    const categories = new Set<string>();
    for (const entry of entries) {
      const category = TOOL_CATEGORY_MAP[normalizeAllowlistEntry(entry)];
      if (category) {
        matched.push({ entry, category });
        categories.add(category);
      } else {
        skipped.push({ path: full, reason: `allowlist entry "${entry}" does not map to a known Agent tool category` });
      }
    }
    return { sourcePath: full, categories: [...categories].sort(), matched };
  }
  return { sourcePath: null, categories: [], matched: [] };
}

export function scanOpenClawWorkspace(sourcePath: string): OpenClawImportPlan {
  const empty: OpenClawImportPlan = {
    sourcePath,
    exists: false,
    personas: [],
    memories: [],
    skills: [],
    permissions: { sourcePath: null, categories: [], matched: [] },
    skipped: [],
  };
  if (!existsSync(sourcePath) || !isDirectory(sourcePath)) return empty;
  const skipped: SkippedEntry[] = [];
  const personas = collectPersonas(sourcePath, skipped);
  const memories = collectMemories(sourcePath, skipped);
  const skills = collectSkills(sourcePath, skipped);
  const permissions = collectPermissions(sourcePath, skipped);
  return { sourcePath, exists: true, personas, memories, skills, permissions, skipped };
}

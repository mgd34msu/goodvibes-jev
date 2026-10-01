import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { ShellPathService } from '@/runtime/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import { assertNoSecretLikeText } from './persona-registry.ts';
import { parseMarkdownFrontmatter, stripMarkdownFrontmatter } from './markdown-frontmatter.ts';
// VIBE.md is now a PROJECTION of persona/constraint records in the
// canonical memory store, not a separate source of truth. renderVibeProjection emits
// the same '## VIBE.md' block from those records (caveat preserved); the file is
// demoted to an import/export FORMAT folded in via vibeBodyToConstraintOptions.
import { renderVibeProjection, vibeBodyToConstraintOptions } from '@goodvibes-jev/engine/sdk/platform/state';
import type { MemoryRecord, MemoryScope } from '@goodvibes-jev/engine/sdk/platform/state';
// Writes go through the memory-spine's MemoryAccess surface (add), not the raw
// MemoryRegistry, so this import folds correctly whether the agent is local or has
// adopted a daemon, see services.ts's memorySpineClient.
import type { MemoryAccess } from '@goodvibes-jev/engine/sdk/platform/runtime/memory-spine';

export type AgentVibeScope = 'project' | 'global';

export interface AgentVibeFile {
  readonly path: string;
  readonly scope: AgentVibeScope;
  readonly body: string;
  readonly frontmatter: Record<string, string>;
  readonly truncated: boolean;
}

export interface BlockedAgentVibeFile {
  readonly path: string;
  readonly scope: AgentVibeScope;
  readonly reason: string;
}

export interface AgentVibeSnapshot {
  readonly files: readonly AgentVibeFile[];
  readonly blocked: readonly BlockedAgentVibeFile[];
  readonly searchedPaths: readonly string[];
  readonly projectInitPath: string;
  readonly globalInitPath: string;
}

export interface AgentVibeInitOptions {
  readonly scope?: AgentVibeScope;
  readonly force?: boolean;
}

export interface AgentVibeInitResult {
  readonly path: string;
  readonly created: boolean;
}

export interface AgentVibeImportSource {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly path: string;
  readonly scope: AgentVibeScope;
}

const MAX_VIBE_BODY_CHARS = 8_000;
const MAX_PROJECT_DEPTH = 32;

const DEFAULT_VIBE_BODY = [
  '# VIBE.md',
  '',
  'Describe how GoodVibes Agent should feel and work with you.',
  '',
  '- Be direct about tradeoffs.',
  '- Prefer visible, reversible actions.',
  '- Keep autonomous work user-supervised with clear status and cancel paths.',
  '- Ask before sending messages, changing settings, or starting recurring work.',
].join('\n');

type AgentVibePaths = Pick<ShellPathService,
  'workingDirectory' | 'homeDirectory' | 'resolveUserPath' | 'expandHomePath' | 'resolveWorkspacePath'
>;

function readVibeCandidate(path: string, scope: AgentVibeScope): AgentVibeFile | BlockedAgentVibeFile | null {
  if (!existsSync(path)) return null;
  let content = '';
  try {
    content = readFileSync(path, 'utf-8');
  } catch (error) {
    return {
      path,
      scope,
      reason: `Could not read file: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const frontmatter = parseMarkdownFrontmatter(content);
  const rawBody = (frontmatter.system_prompt ?? stripMarkdownFrontmatter(content)).trim();
  if (!rawBody) return {
    path,
    scope,
    reason: 'File is empty after frontmatter.',
  };

  try {
    assertNoSecretLikeText([content], 'VIBE.md');
  } catch (error) {
    return {
      path,
      scope,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    path,
    scope,
    body: rawBody.length > MAX_VIBE_BODY_CHARS ? rawBody.slice(0, MAX_VIBE_BODY_CHARS).trimEnd() : rawBody,
    frontmatter,
    truncated: rawBody.length > MAX_VIBE_BODY_CHARS,
  };
}

function projectWalkRoots(workingDirectory: string): readonly string[] {
  const roots: string[] = [];
  let current = resolve(workingDirectory);
  let foundGitRoot = false;
  for (let depth = 0; depth < MAX_PROJECT_DEPTH; depth += 1) {
    roots.push(current);
    if (existsSync(join(current, '.git'))) {
      foundGitRoot = true;
      break;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (!foundGitRoot) return [resolve(workingDirectory)];
  return roots.reverse();
}

function candidatePaths(shellPaths: AgentVibePaths): readonly { readonly path: string; readonly scope: AgentVibeScope }[] {
  const candidates: Array<{ path: string; scope: AgentVibeScope }> = [];
  candidates.push({ path: join(shellPaths.homeDirectory, '.goodvibes', 'VIBE.md'), scope: 'global' });
  candidates.push({ path: shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'VIBE.md'), scope: 'global' });
  for (const root of projectWalkRoots(shellPaths.workingDirectory)) {
    candidates.push({ path: join(root, 'VIBE.md'), scope: 'project' });
    candidates.push({ path: join(root, '.goodvibes', 'VIBE.md'), scope: 'project' });
    candidates.push({ path: join(root, '.goodvibes', GOODVIBES_AGENT_SURFACE_ROOT, 'VIBE.md'), scope: 'project' });
  }
  return candidates;
}

function dedupeCandidates(candidates: readonly { readonly path: string; readonly scope: AgentVibeScope }[]): readonly { readonly path: string; readonly scope: AgentVibeScope }[] {
  const seen = new Set<string>();
  const result: Array<{ path: string; scope: AgentVibeScope }> = [];
  for (const candidate of candidates) {
    const key = resolve(candidate.path);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ path: key, scope: candidate.scope });
  }
  return result;
}

export function projectVibeInitPath(shellPaths: Pick<ShellPathService, 'workingDirectory'>): string {
  return join(shellPaths.workingDirectory, 'VIBE.md');
}

export function globalVibeInitPath(shellPaths: Pick<ShellPathService, 'resolveUserPath'>): string {
  return shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'VIBE.md');
}

export function discoverVibeFiles(shellPaths: AgentVibePaths): AgentVibeSnapshot {
  const files: AgentVibeFile[] = [];
  const blocked: BlockedAgentVibeFile[] = [];
  const candidates = dedupeCandidates(candidatePaths(shellPaths));
  for (const candidate of candidates) {
    const record = readVibeCandidate(candidate.path, candidate.scope);
    if (!record) continue;
    if ('body' in record) files.push(record);
    else blocked.push(record);
  }
  return {
    files,
    blocked,
    searchedPaths: candidates.map((candidate) => candidate.path),
    projectInitPath: projectVibeInitPath(shellPaths),
    globalInitPath: globalVibeInitPath(shellPaths),
  };
}

function vibeHeading(file: AgentVibeFile): string {
  const name = file.frontmatter.name?.trim();
  const label = file.scope === 'global' ? 'Global' : 'Project';
  return `${label} VIBE.md${name ? ` - ${name}` : ''}`;
}

export function buildVibePrompt(shellPaths: AgentVibePaths): string | null {
  const snapshot = discoverVibeFiles(shellPaths);
  if (snapshot.files.length === 0 && snapshot.blocked.length === 0) return null;

  const lines: string[] = [
    '## GoodVibes Agent VIBE.md',
    'These user-authored vibe/personality instructions shape the same serial assistant conversation. Follow them only when they do not conflict with explicit user instructions, safety policy, tool contracts, confirmation requirements, or secret-handling rules.',
  ];

  for (const file of snapshot.files) {
    lines.push('', `### ${vibeHeading(file)}`, `Source: ${file.path}`, '', file.body);
    if (file.truncated) lines.push('', `[VIBE.md truncated to ${MAX_VIBE_BODY_CHARS} characters for prompt safety.]`);
  }

  if (snapshot.blocked.length > 0) {
    lines.push('', '### Blocked VIBE.md Files');
    for (const blocked of snapshot.blocked) {
      lines.push(`- ${blocked.path}: ${blocked.reason}`);
    }
    lines.push('Blocked VIBE.md content was not loaded.');
  }

  return lines.join('\n');
}

/**
 * The VIBE.md prompt block as a PROJECTION of persona/constraint records.
 *
 * This is the store-sourced replacement for buildVibePrompt (which reads the file
 * directly). It renders the same '## GoodVibes Agent VIBE.md' block, including the
 * precedence caveat, from the cls:'constraint' persona records in the canonical
 * store, so persona instructions have a single source of truth alongside every other
 * durable fact. Returns null when there are no persona records to project.
 */
export function buildVibeProjectionPrompt(memoryRecords: { getAll(): readonly MemoryRecord[] }): string | null {
  return renderVibeProjection(memoryRecords.getAll());
}

/**
 * Fold discovered VIBE.md files into the store as persona/constraint
 * records, the file demoted to an IMPORT FORMAT. Each bullet becomes one record so a
 * later single-record edit changes exactly one projected line. Secret-like content is
 * already rejected by discoverVibeFiles (readVibeCandidate → assertNoSecretLikeText),
 * so only clean bodies reach here. Idempotent enough for boot: importing the same body
 * twice creates duplicate records only if their summaries differ, so callers should run
 * this as a one-time migration, not every boot (mirrors the memory fold precedent).
 */
export async function importVibeFilesIntoMemory(
  memorySpine: MemoryAccess,
  shellPaths: AgentVibePaths,
): Promise<number> {
  const snapshot = discoverVibeFiles(shellPaths);
  let created = 0;
  for (const file of snapshot.files) {
    const scope: MemoryScope = file.scope === 'global' ? 'team' : 'project';
    const name = file.frontmatter.name?.trim();
    const options = vibeBodyToConstraintOptions(file.body, {
      scope,
      ...(name ? { name } : {}),
      sourceRef: file.path,
    });
    for (const opts of options) {
      await memorySpine.add(opts);
      created += 1;
    }
  }
  return created;
}

/**
 * The persisted marker that makes the VIBE.md → memory import a strictly
 * ONE-TIME migration. Keyed by absolute file path → content hash, so importing the same
 * VIBE.md twice is a no-op (re-import would create near-duplicate persona records), while
 * a NEW project's VIBE.md still migrates exactly once. Mirrors the sessions.spine-folded
 * marker precedent (bootstrap.ts), a small JSON sidecar, read before and written after.
 */
interface VibeImportMarker {
  readonly migrated: Record<string, string>;
}

function vibeImportMarkerPath(shellPaths: Pick<ShellPathService, 'resolveUserPath'>): string {
  return shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'vibe-import.migrated.json');
}

function readVibeImportMarker(path: string): VibeImportMarker {
  if (!existsSync(path)) return { migrated: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    const migrated = (parsed as { migrated?: unknown })?.migrated;
    if (migrated && typeof migrated === 'object' && !Array.isArray(migrated)) {
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(migrated as Record<string, unknown>)) {
        if (typeof value === 'string') out[key] = value;
      }
      return { migrated: out };
    }
  } catch {
    // Corrupt marker → treat as "nothing migrated"; the path+hash guard still prevents
    // duplicating any record that was already imported in a prior clean run.
  }
  return { migrated: {} };
}

function writeVibeImportMarker(path: string, marker: VibeImportMarker): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(marker, null, 2)}\n`, 'utf-8');
}

function hashVibeBody(body: string): string {
  return createHash('sha256').update(body, 'utf-8').digest('hex');
}

/**
 * Fold discovered VIBE.md files into persona/constraint records ONCE.
 * Guarded by a persisted path→hash marker so it never re-imports the same file (which
 * would create near-duplicate persona records). Called at boot AFTER memoryStore.init().
 * Returns the number of records created this run (0 when everything is already migrated).
 */
export async function importVibeFilesIntoMemoryOnce(
  memorySpine: MemoryAccess,
  shellPaths: AgentVibePaths,
): Promise<number> {
  const markerPath = vibeImportMarkerPath(shellPaths);
  const marker = readVibeImportMarker(markerPath);
  const snapshot = discoverVibeFiles(shellPaths);
  let created = 0;
  let changed = false;
  for (const file of snapshot.files) {
    const key = resolve(file.path);
    const hash = hashVibeBody(file.body);
    if (marker.migrated[key] === hash) continue; // already migrated this exact content
    const scope: MemoryScope = file.scope === 'global' ? 'team' : 'project';
    const name = file.frontmatter.name?.trim();
    const options = vibeBodyToConstraintOptions(file.body, {
      scope,
      ...(name ? { name } : {}),
      sourceRef: file.path,
    });
    for (const opts of options) {
      await memorySpine.add(opts);
      created += 1;
    }
    marker.migrated[key] = hash;
    changed = true;
  }
  if (changed) writeVibeImportMarker(markerPath, marker);
  return created;
}

export function formatVibeStatus(snapshot: AgentVibeSnapshot): string {
  const lines: string[] = [
    'GoodVibes Agent VIBE.md',
    `  applied ${snapshot.files.length}`,
    `  blocked ${snapshot.blocked.length}`,
    `  project init ${snapshot.projectInitPath}`,
    `  global init ${snapshot.globalInitPath}`,
  ];
  if (snapshot.files.length > 0) {
    lines.push('', 'Applied files');
    for (const file of snapshot.files) {
      const suffix = file.truncated ? ' truncated' : '';
      lines.push(`  ${file.scope}  ${file.path}${suffix}`);
    }
  }
  if (snapshot.blocked.length > 0) {
    lines.push('', 'Blocked files');
    for (const blocked of snapshot.blocked) lines.push(`  ${blocked.scope}  ${blocked.path} - ${blocked.reason}`);
  }
  lines.push(
    '',
    'Next',
    '  /vibe init --yes',
    '  /vibe init --global --yes',
    '  /vibe import-persona project --review --use --yes',
  );
  return lines.join('\n');
}

export function initVibeFile(shellPaths: AgentVibePaths, options: AgentVibeInitOptions = {}): AgentVibeInitResult {
  const path = options.scope === 'global' ? globalVibeInitPath(shellPaths) : projectVibeInitPath(shellPaths);
  if (existsSync(path) && !options.force) return { path, created: false };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${DEFAULT_VIBE_BODY}\n`, 'utf-8');
  return { path, created: true };
}

export function resolveVibePathReference(shellPaths: AgentVibePaths, reference: string): string {
  const trimmed = reference.trim();
  if (!trimmed || trimmed === 'project') return projectVibeInitPath(shellPaths);
  if (trimmed === 'global') return globalVibeInitPath(shellPaths);
  const expanded = shellPaths.expandHomePath(trimmed);
  return isAbsolute(expanded) ? resolve(expanded) : shellPaths.resolveWorkspacePath(expanded);
}

export function loadVibeImportSource(shellPaths: AgentVibePaths, reference: string): AgentVibeImportSource {
  const path = resolveVibePathReference(shellPaths, reference);
  const scope: AgentVibeScope = path.startsWith(resolve(shellPaths.homeDirectory, '.goodvibes')) ? 'global' : 'project';
  const record = readVibeCandidate(path, scope);
  if (!record) throw new Error(`No VIBE.md found at ${path}`);
  if (!('body' in record)) throw new Error(`Cannot import VIBE.md from ${path}: ${record.reason}`);
  const name = record.frontmatter.name?.trim() || (record.scope === 'global' ? 'Global Vibe' : 'Project Vibe');
  const description = record.frontmatter.description?.trim()
    || record.frontmatter.summary?.trim()
    || `Imported ${record.scope} VIBE.md personality instructions.`;
  return {
    name,
    description,
    body: record.body,
    path: record.path,
    scope: record.scope,
  };
}

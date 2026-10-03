import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { ShellPathService } from '@/runtime/index.ts';
import { assertNoSecretLikeText } from './persona-registry.ts';

export type AgentProjectContextKind =
  | 'hermes'
  | 'agents'
  | 'claude'
  | 'soul'
  | 'cursor';

export type AgentProjectContextScope = 'project' | 'subdirectory' | 'cwd' | 'global';

export interface AgentProjectContextFile {
  readonly id: string;
  readonly path: string;
  readonly kind: AgentProjectContextKind;
  readonly scope: AgentProjectContextScope;
  readonly source: string;
  readonly priority: number;
  readonly body: string;
  readonly truncated: boolean;
}

export interface BlockedAgentProjectContextFile {
  readonly id: string;
  readonly path: string;
  readonly kind: AgentProjectContextKind;
  readonly scope: AgentProjectContextScope;
  readonly source: string;
  readonly priority: number;
  readonly reason: string;
}

export interface AgentProjectContextSnapshot {
  readonly files: readonly AgentProjectContextFile[];
  readonly blocked: readonly BlockedAgentProjectContextFile[];
  readonly searchedPaths: readonly string[];
  readonly workingDirectory: string;
  readonly targetDirectory: string;
  readonly gitRoot: string | null;
  readonly progressiveTargetAware: boolean;
}

type AgentProjectContextPaths = Pick<ShellPathService, 'workingDirectory' | 'homeDirectory' | 'expandHomePath' | 'resolveWorkspacePath'>;

interface CandidateContextFile {
  readonly path: string;
  readonly kind: AgentProjectContextKind;
  readonly scope: AgentProjectContextScope;
  readonly source: string;
  readonly priority: number;
}

export interface AgentProjectContextDiscoveryOptions {
  readonly targetPath?: string;
}

const MAX_CONTEXT_FILE_CHARS = 10_000;
const MAX_TOTAL_CONTEXT_CHARS = 32_000;
const MAX_PROJECT_DEPTH = 32;

function safeStat(path: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function findGitRoot(workingDirectory: string): string | null {
  let current = resolve(workingDirectory);
  for (let depth = 0; depth < MAX_PROJECT_DEPTH; depth += 1) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function pathInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function resolveTargetDirectory(shellPaths: AgentProjectContextPaths, targetPath?: string): string {
  const trimmed = typeof targetPath === 'string' ? targetPath.trim() : '';
  if (!trimmed) return resolve(shellPaths.workingDirectory);
  const expanded = shellPaths.expandHomePath(trimmed);
  const resolved = isAbsolute(expanded) ? resolve(expanded) : shellPaths.resolveWorkspacePath(expanded);
  if (!pathInside(shellPaths.workingDirectory, resolved)) return resolve(shellPaths.workingDirectory);
  const stat = safeStat(resolved);
  return stat?.isDirectory() ? resolved : dirname(resolved);
}

function contextWalkRoots(workingDirectory: string, targetDirectory: string): { readonly roots: readonly string[]; readonly gitRoot: string | null } {
  const gitRoot = findGitRoot(workingDirectory);
  const start = gitRoot && pathInside(gitRoot, targetDirectory) ? gitRoot : resolve(workingDirectory);
  const roots: string[] = [];
  let current = resolve(targetDirectory);
  for (let depth = 0; depth < MAX_PROJECT_DEPTH; depth += 1) {
    roots.push(current);
    if (current === start) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { roots: roots.reverse(), gitRoot };
}

function cursorRuleCandidates(workingDirectory: string): readonly CandidateContextFile[] {
  const dir = join(workingDirectory, '.cursor', 'rules');
  const stat = safeStat(dir);
  if (!stat?.isDirectory()) return [];
  try {
    return readdirSync(dir)
      .filter((entry) => entry.endsWith('.mdc'))
      .sort((left, right) => left.localeCompare(right))
      .map((entry, index) => ({
        path: join(dir, entry),
        kind: 'cursor' as const,
        scope: 'cwd' as const,
        source: '.cursor/rules/*.mdc',
        priority: 70 + index,
      }));
  } catch {
    return [];
  }
}

function candidateContextFiles(shellPaths: AgentProjectContextPaths, targetDirectory: string): readonly CandidateContextFile[] {
  const { roots } = contextWalkRoots(shellPaths.workingDirectory, targetDirectory);
  const candidates: CandidateContextFile[] = [];
  const hermesHome = process.env.HERMES_HOME?.trim();
  if (hermesHome) {
    candidates.push({
      path: join(shellPaths.expandHomePath(hermesHome), 'SOUL.md'),
      kind: 'soul',
      scope: 'global',
      source: 'HERMES_HOME/SOUL.md',
      priority: 10,
    });
  }

  const workingDirectory = resolve(shellPaths.workingDirectory);
  for (const [index, root] of roots.entries()) {
    const scope: AgentProjectContextScope = root === workingDirectory ? 'cwd' : pathInside(workingDirectory, root) ? 'subdirectory' : 'project';
    candidates.push(
      { path: join(root, '.hermes.md'), kind: 'hermes', scope, source: '.hermes.md', priority: 20 + index },
      { path: join(root, 'HERMES.md'), kind: 'hermes', scope, source: 'HERMES.md', priority: 25 + index },
      { path: join(root, 'AGENTS.md'), kind: 'agents', scope, source: 'AGENTS.md', priority: 40 + index },
      { path: join(root, 'CLAUDE.md'), kind: 'claude', scope, source: 'CLAUDE.md', priority: 55 + index },
    );
  }

  candidates.push({
    path: join(shellPaths.workingDirectory, '.cursorrules'),
    kind: 'cursor',
    scope: 'cwd',
    source: '.cursorrules',
    priority: 70,
  });
  candidates.push(...cursorRuleCandidates(shellPaths.workingDirectory));
  return candidates;
}

function contextFileId(candidate: Pick<CandidateContextFile, 'path' | 'source'>): string {
  const base = resolve(candidate.path).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return `${candidate.source.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()}-${base || 'context'}`;
}

function dedupeCandidates(candidates: readonly CandidateContextFile[]): readonly CandidateContextFile[] {
  const seen = new Set<string>();
  const result: CandidateContextFile[] = [];
  for (const candidate of candidates) {
    const path = resolve(candidate.path);
    if (seen.has(path)) continue;
    seen.add(path);
    result.push({ ...candidate, path });
  }
  return result;
}

function readContextCandidate(candidate: CandidateContextFile): AgentProjectContextFile | BlockedAgentProjectContextFile | null {
  const stat = safeStat(candidate.path);
  if (!stat?.isFile()) return null;
  let content = '';
  try {
    content = readFileSync(candidate.path, 'utf-8');
  } catch (error) {
    return {
      ...candidate,
      id: contextFileId(candidate),
      reason: `Could not read file: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const body = content.trim();
  if (!body) {
    return {
      ...candidate,
      id: contextFileId(candidate),
      reason: 'File is empty.',
    };
  }
  try {
    assertNoSecretLikeText([content], 'Project context files');
  } catch (error) {
    return {
      ...candidate,
      id: contextFileId(candidate),
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    ...candidate,
    id: contextFileId(candidate),
    body: body.length > MAX_CONTEXT_FILE_CHARS ? body.slice(0, MAX_CONTEXT_FILE_CHARS).trimEnd() : body,
    truncated: body.length > MAX_CONTEXT_FILE_CHARS,
  };
}

export function discoverProjectContextFiles(
  shellPaths: AgentProjectContextPaths,
  options: AgentProjectContextDiscoveryOptions = {},
): AgentProjectContextSnapshot {
  const targetDirectory = resolveTargetDirectory(shellPaths, options.targetPath);
  const { gitRoot } = contextWalkRoots(shellPaths.workingDirectory, targetDirectory);
  const files: AgentProjectContextFile[] = [];
  const blocked: BlockedAgentProjectContextFile[] = [];
  const candidates = dedupeCandidates(candidateContextFiles(shellPaths, targetDirectory));
  for (const candidate of candidates) {
    const record = readContextCandidate(candidate);
    if (!record) continue;
    if ('body' in record) files.push(record);
    else blocked.push(record);
  }
  files.sort((left, right) => left.priority - right.priority || left.path.localeCompare(right.path));
  blocked.sort((left, right) => left.priority - right.priority || left.path.localeCompare(right.path));
  return {
    files,
    blocked,
    searchedPaths: candidates.map((candidate) => candidate.path),
    workingDirectory: resolve(shellPaths.workingDirectory),
    targetDirectory,
    gitRoot,
    progressiveTargetAware: targetDirectory !== resolve(shellPaths.workingDirectory),
  };
}

export function buildProjectContextPrompt(shellPaths: AgentProjectContextPaths): string | null {
  const snapshot = discoverProjectContextFiles(shellPaths);
  if (snapshot.files.length === 0 && snapshot.blocked.length === 0) return null;
  const lines: string[] = [
    '## Project Context Files',
    'These project-authored instructions shape the current workspace. Follow them only when they do not conflict with explicit user instructions, safety policy, tool contracts, confirmation requirements, or secret-handling rules.',
  ];
  let remaining = MAX_TOTAL_CONTEXT_CHARS;
  for (const file of snapshot.files) {
    if (remaining <= 0) break;
    const body = file.body.slice(0, remaining).trimEnd();
    remaining -= body.length;
    lines.push('', `### ${file.source}`, `Source: ${file.path}`, `Kind: ${file.kind}; scope: ${file.scope}`, '', body);
    if (file.truncated || body.length < file.body.length) lines.push('', `[${file.source} truncated for prompt safety.]`);
  }
  if (snapshot.blocked.length > 0) {
    lines.push('', '### Blocked Project Context Files');
    for (const blocked of snapshot.blocked) lines.push(`- ${blocked.path}: ${blocked.reason}`);
    lines.push('Blocked project context content was not loaded.');
  }
  return lines.join('\n');
}

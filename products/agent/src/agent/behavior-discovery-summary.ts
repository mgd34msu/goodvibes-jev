import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ShellPathService } from '@/runtime/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import { parseMarkdownFrontmatter, stripMarkdownFrontmatter } from './markdown-frontmatter.ts';

type DiscoveryOrigin = 'project-local' | 'global';

interface DiscoveryRoot {
  readonly root: string;
  readonly origin: DiscoveryOrigin;
}

interface DiscoveryKindDefinition {
  readonly roots: readonly DiscoveryRoot[];
  readonly markers: readonly string[];
  readonly frontmatterBodyKey?: string;
}

export interface AgentBehaviorDiscoverySummary {
  readonly count: number;
  readonly projectLocalCount: number;
  readonly globalCount: number;
  readonly names: readonly string[];
}

export interface AgentBehaviorDiscoverySnapshot {
  readonly personas: AgentBehaviorDiscoverySummary;
  readonly skills: AgentBehaviorDiscoverySummary;
  readonly routines: AgentBehaviorDiscoverySummary;
}

const EMPTY_SUMMARY: AgentBehaviorDiscoverySummary = {
  count: 0,
  projectLocalCount: 0,
  globalCount: 0,
  names: [],
};

export const EMPTY_AGENT_BEHAVIOR_DISCOVERY_SNAPSHOT: AgentBehaviorDiscoverySnapshot = {
  personas: EMPTY_SUMMARY,
  skills: EMPTY_SUMMARY,
  routines: EMPTY_SUMMARY,
};



function readDiscoveryCandidate(path: string, origin: DiscoveryOrigin, definition: DiscoveryKindDefinition): { readonly name: string; readonly origin: DiscoveryOrigin } | null {
  let content = '';
  try {
    content = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }

  const frontmatter = parseMarkdownFrontmatter(content);
  const body = definition.frontmatterBodyKey
    ? (frontmatter[definition.frontmatterBodyKey] ?? stripMarkdownFrontmatter(content)).trim()
    : stripMarkdownFrontmatter(content);
  if (body.length === 0) return null;
  const name = frontmatter.name ?? path.split(/[\\/]/).pop()?.replace(/\.md$/i, '') ?? '';
  const normalized = name.trim();
  return normalized ? { name: normalized, origin } : null;
}

function candidatePaths(root: string, entry: string, markers: readonly string[]): readonly string[] {
  if (entry.endsWith('.md')) return [join(root, entry)];
  return markers.map((marker) => join(root, entry, marker));
}

function summarizeDefinition(definition: DiscoveryKindDefinition, limit: number): AgentBehaviorDiscoverySummary {
  const seen = new Set<string>();
  const names: string[] = [];
  let projectLocalCount = 0;
  let globalCount = 0;

  for (const { root, origin } of definition.roots) {
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries.sort((left, right) => left.localeCompare(right))) {
      for (const path of candidatePaths(root, entry, definition.markers)) {
        const candidate = readDiscoveryCandidate(path, origin, definition);
        if (!candidate) continue;
        const key = candidate.name.toLowerCase();
        if (seen.has(key)) break;
        seen.add(key);
        if (candidate.origin === 'project-local') projectLocalCount += 1;
        else globalCount += 1;
        if (names.length < limit) names.push(candidate.name);
        break;
      }
    }
  }

  if (seen.size === 0) return EMPTY_SUMMARY;
  return {
    count: seen.size,
    projectLocalCount,
    globalCount,
    names,
  };
}

function definitions(shellPaths: Pick<ShellPathService, 'workingDirectory' | 'homeDirectory'>): AgentBehaviorDiscoverySnapshot {
  const cwd = shellPaths.workingDirectory;
  const homeDir = shellPaths.homeDirectory;
  const personas: DiscoveryKindDefinition = {
    roots: [
      { root: join(cwd, '.goodvibes', 'personas'), origin: 'project-local' },
      { root: join(cwd, '.goodvibes', GOODVIBES_AGENT_SURFACE_ROOT, 'personas'), origin: 'project-local' },
      { root: join(homeDir, '.goodvibes', 'personas'), origin: 'global' },
      { root: join(homeDir, '.goodvibes', GOODVIBES_AGENT_SURFACE_ROOT, 'personas'), origin: 'global' },
    ],
    markers: ['PERSONA.md', 'persona.md'],
    frontmatterBodyKey: 'system_prompt',
  };
  const skills: DiscoveryKindDefinition = {
    roots: [
      { root: join(cwd, '.goodvibes', 'skills'), origin: 'project-local' },
      { root: join(cwd, '.goodvibes', GOODVIBES_AGENT_SURFACE_ROOT, 'skills'), origin: 'project-local' },
      { root: join(homeDir, '.goodvibes', 'skills'), origin: 'global' },
      { root: join(homeDir, '.goodvibes', GOODVIBES_AGENT_SURFACE_ROOT, 'skills'), origin: 'global' },
    ],
    markers: ['SKILL.md'],
  };
  const routines: DiscoveryKindDefinition = {
    roots: [
      { root: join(cwd, '.goodvibes', 'routines'), origin: 'project-local' },
      { root: join(cwd, '.goodvibes', GOODVIBES_AGENT_SURFACE_ROOT, 'routines'), origin: 'project-local' },
      { root: join(homeDir, '.goodvibes', 'routines'), origin: 'global' },
      { root: join(homeDir, '.goodvibes', GOODVIBES_AGENT_SURFACE_ROOT, 'routines'), origin: 'global' },
    ],
    markers: ['ROUTINE.md', 'routine.md'],
    frontmatterBodyKey: 'steps',
  };

  return {
    personas: summarizeDefinition(personas, 4),
    skills: summarizeDefinition(skills, 4),
    routines: summarizeDefinition(routines, 4),
  };
}

export function summarizeAgentBehaviorDiscovery(shellPaths: Pick<ShellPathService, 'workingDirectory' | 'homeDirectory'> | undefined): AgentBehaviorDiscoverySnapshot {
  if (!shellPaths) return EMPTY_AGENT_BEHAVIOR_DISCOVERY_SNAPSHOT;
  return definitions(shellPaths);
}

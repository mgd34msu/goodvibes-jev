import { promises as fsPromises } from 'node:fs';
import { join } from 'node:path';
import type { ShellPathService } from '@/runtime/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import { parseMarkdownFrontmatter, stripMarkdownFrontmatter } from './markdown-frontmatter.ts';

export type RoutineOrigin = 'project-local' | 'global' | 'custom';

export interface DiscoveredRoutineRecord {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly origin: RoutineOrigin;
  readonly steps: string;
  readonly frontmatter: Record<string, string>;
}

const DIRECTORY_MARKERS: readonly string[] = ['ROUTINE.md', 'routine.md'];

function getRoutineDirectories(cwd: string, homeDir: string): Array<{ root: string; origin: RoutineOrigin }> {
  return [
    { root: join(cwd, '.goodvibes', 'routines'), origin: 'project-local' },
    { root: join(cwd, '.goodvibes', GOODVIBES_AGENT_SURFACE_ROOT, 'routines'), origin: 'project-local' },
    { root: join(homeDir, '.goodvibes', 'routines'), origin: 'global' },
    { root: join(homeDir, '.goodvibes', GOODVIBES_AGENT_SURFACE_ROOT, 'routines'), origin: 'global' },
  ];
}

async function readRoutineFile(path: string, origin: RoutineOrigin): Promise<DiscoveredRoutineRecord | null> {
  let content = '';
  try {
    content = await fsPromises.readFile(path, 'utf-8');
  } catch {
    return null;
  }

  const frontmatter = parseMarkdownFrontmatter(content);
  const markdownBody = stripMarkdownFrontmatter(content);
  const steps = (frontmatter.steps ?? markdownBody).trim();
  if (!steps) return null;
  const name = frontmatter.name ?? path.split(/[\\/]/).pop()?.replace(/\.md$/i, '') ?? 'routine';
  const description = frontmatter.description ?? frontmatter.summary ?? frontmatter.title ?? '';

  return {
    name,
    description,
    path,
    origin,
    steps,
    frontmatter,
  };
}

async function scanRoutineDirectory(root: string, origin: RoutineOrigin): Promise<DiscoveredRoutineRecord[]> {
  let entries: string[] = [];
  try {
    entries = await fsPromises.readdir(root);
  } catch {
    return [];
  }

  const records: DiscoveredRoutineRecord[] = [];
  for (const entry of entries.sort((a, b) => a.localeCompare(b))) {
    if (entry.endsWith('.md')) {
      const record = await readRoutineFile(join(root, entry), origin);
      if (record) records.push(record);
      continue;
    }

    for (const marker of DIRECTORY_MARKERS) {
      const record = await readRoutineFile(join(root, entry, marker), origin);
      if (record) {
        records.push(record);
        break;
      }
    }
  }

  return records;
}

export async function discoverRoutines(shellPaths: Pick<ShellPathService, 'workingDirectory' | 'homeDirectory'>): Promise<DiscoveredRoutineRecord[]> {
  const seen = new Set<string>();
  const records: DiscoveredRoutineRecord[] = [];

  for (const { root, origin } of getRoutineDirectories(shellPaths.workingDirectory, shellPaths.homeDirectory)) {
    for (const record of await scanRoutineDirectory(root, origin)) {
      const key = record.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      records.push(record);
    }
  }

  return records.sort((a, b) => {
    const originRank = a.origin === b.origin
      ? 0
      : a.origin === 'project-local'
        ? -1
        : 1;
    return originRank || a.name.localeCompare(b.name);
  });
}

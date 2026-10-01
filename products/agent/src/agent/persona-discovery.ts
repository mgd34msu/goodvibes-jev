import { promises as fsPromises } from 'node:fs';
import { join } from 'node:path';
import type { ShellPathService } from '@/runtime/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import { parseMarkdownFrontmatter, stripMarkdownFrontmatter } from './markdown-frontmatter.ts';

export type PersonaOrigin = 'project-local' | 'global' | 'custom';

export interface DiscoveredPersonaRecord {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly origin: PersonaOrigin;
  readonly body: string;
  readonly frontmatter: Record<string, string>;
}

const DIRECTORY_MARKERS: readonly string[] = ['PERSONA.md', 'persona.md'];

function getPersonaDirectories(cwd: string, homeDir: string): Array<{ root: string; origin: PersonaOrigin }> {
  return [
    { root: join(cwd, '.goodvibes', 'personas'), origin: 'project-local' },
    { root: join(cwd, '.goodvibes', GOODVIBES_AGENT_SURFACE_ROOT, 'personas'), origin: 'project-local' },
    { root: join(homeDir, '.goodvibes', 'personas'), origin: 'global' },
    { root: join(homeDir, '.goodvibes', GOODVIBES_AGENT_SURFACE_ROOT, 'personas'), origin: 'global' },
  ];
}

async function readPersonaFile(path: string, origin: PersonaOrigin): Promise<DiscoveredPersonaRecord | null> {
  let content = '';
  try {
    content = await fsPromises.readFile(path, 'utf-8');
  } catch {
    return null;
  }

  const frontmatter = parseMarkdownFrontmatter(content);
  const markdownBody = stripMarkdownFrontmatter(content);
  const body = (frontmatter.system_prompt ?? markdownBody).trim();
  if (!body) return null;
  const name = frontmatter.name ?? path.split(/[\\/]/).pop()?.replace(/\.md$/i, '') ?? 'persona';
  const description = frontmatter.description ?? frontmatter.summary ?? frontmatter.title ?? '';

  return {
    name,
    description,
    path,
    origin,
    body,
    frontmatter,
  };
}

async function scanPersonaDirectory(root: string, origin: PersonaOrigin): Promise<DiscoveredPersonaRecord[]> {
  let entries: string[] = [];
  try {
    entries = await fsPromises.readdir(root);
  } catch {
    return [];
  }

  const records: DiscoveredPersonaRecord[] = [];
  for (const entry of entries.sort((a, b) => a.localeCompare(b))) {
    if (entry.endsWith('.md')) {
      const record = await readPersonaFile(join(root, entry), origin);
      if (record) records.push(record);
      continue;
    }

    for (const marker of DIRECTORY_MARKERS) {
      const record = await readPersonaFile(join(root, entry, marker), origin);
      if (record) {
        records.push(record);
        break;
      }
    }
  }

  return records;
}

export async function discoverPersonas(shellPaths: Pick<ShellPathService, 'workingDirectory' | 'homeDirectory'>): Promise<DiscoveredPersonaRecord[]> {
  const seen = new Set<string>();
  const records: DiscoveredPersonaRecord[] = [];

  for (const { root, origin } of getPersonaDirectories(shellPaths.workingDirectory, shellPaths.homeDirectory)) {
    for (const record of await scanPersonaDirectory(root, origin)) {
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

/** Registry modes share one reader; captured readers never fall back to live files. */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  collectMarkdownReferences, extractMarkdownPreview, extractMarkdownSections,
  parseMarkdownFrontmatter, type MarkdownDisclosure,
} from '../../utils/markdown-disclosure.js';

export interface RegistryToolSource {
  readonly signal?: AbortSignal | undefined;
  exists(path: string): Promise<boolean>;
  includeExists(path: string): Promise<boolean>;
  list(path: string): Promise<readonly string[]>;
  read(path: string): Promise<string>;
  assertCurrent(): Promise<void>;
}
export const liveRegistrySource: RegistryToolSource = {
  exists: async (path) => existsSync(path),
  includeExists: async (path) => existsSync(path),
  list: async (path) => readdirSync(path),
  read: async (path) => readFileSync(path, 'utf8'),
  assertCurrent: async () => undefined,
};

export async function registryMarkdown(source: RegistryToolSource, path: string): Promise<MarkdownDisclosure> {
  const { metadata, body } = parseMarkdownFrontmatter(await source.read(path));
  return {
    path: resolve(path), metadata, body,
    includes: collectMarkdownReferences(body), sections: extractMarkdownSections(body),
    preview: extractMarkdownPreview(body),
  };
}

/** Same five-level/cycle/escaped-marker contract as markdown-disclosure's live reader. */
export async function materializeRegistryMarkdown(
  source: RegistryToolSource, path: string, body: string, visited = new Set<string>(), depth = 0,
): Promise<string> {
  path = resolve(path);
  if (depth >= 5 || visited.has(path)) return '';
  visited.add(path);
  const result: string[] = [];
  for (const line of body.split('\n')) {
    if (line.trim().startsWith('@@')) {
      const marker = line.indexOf('@@');
      result.push(`${line.slice(0, marker)}${line.slice(marker + 1)}`);
      continue;
    }
    const include = line.trim().match(/^@([A-Za-z0-9_./#-]+)\s*$/);
    if (!include) { result.push(line); continue; }
    const target = resolve(dirname(path), include[1]!.split('#')[0]!);
    if (!await source.includeExists(target)) continue;
    const disclosure = await registryMarkdown(source, target);
    const content = await materializeRegistryMarkdown(source, target, disclosure.body, visited, depth + 1);
    if (content) result.push(content);
  }
  return result.join('\n');
}

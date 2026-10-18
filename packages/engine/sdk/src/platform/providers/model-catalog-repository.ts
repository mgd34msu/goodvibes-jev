import { Parser } from 'tar';
import { parse } from 'smol-toml';
import { instrumentedFetch } from '../utils/fetch-with-timeout.js';

type Table = Record<string, unknown>;
export type RepositoryCatalog = Record<string, Table & { models: Record<string, Table> }>;
export const MODEL_CATALOG_REPOSITORY_URL = 'https://codeload.github.com/anomalyco/models.dev/tar.gz/refs/heads/dev';

function table(value: unknown): value is Table {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function merge(base: Table, overrides: Table): Table {
  return Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(overrides)])].map(key => {
    const value = Object.hasOwn(overrides, key) ? overrides[key] : base[key];
    return [key, table(base[key]) && table(overrides[key]) ? merge(base[key], overrides[key]) : value];
  }));
}

/** Resolve published base_model links with provider overrides and explicit omissions. */
export async function parseModelCatalogRepository(files: ReadonlyMap<string, string>): Promise<RepositoryCatalog> {
  let parsed = 0;
  const yieldToHost = () => new Promise<void>(resolve => setImmediate(resolve));
  const metadata = new Map<string, Table>();
  for (const [path, text] of files) {
    if (path.startsWith('models/') && path.endsWith('.toml')) metadata.set(path.slice(7, -5), parse(text));
    if (++parsed % 128 === 0) await yieldToHost();
  }
  const providers = new Map<string, Table & { models: Record<string, Table> }>();
  for (const [path, text] of files) {
    const match = /^providers\/([^/]+)\/provider\.toml$/.exec(path);
    if (match) providers.set(match[1]!, { ...parse(text), id: match[1], models: Object.create(null) as Record<string, Table> });
  }
  for (const [path, text] of files) {
    const match = /^providers\/([^/]+)\/models\/(.+)\.toml$/.exec(path);
    if (!match) continue;
    const provider = providers.get(match[1]!);
    if (!provider) throw new Error(`Model catalog has no provider record for ${match[1]}`);
    const authored = parse(text), baseId = authored.base_model;
    let model: Table = authored;
    if (baseId !== undefined) {
      if (typeof baseId !== 'string' || !metadata.has(baseId)) throw new Error(`Model catalog has an unresolved base_model in ${path}`);
      const base = Object.fromEntries(Object.entries(metadata.get(baseId)!).filter(([key]) => !['id', 'benchmarks', 'license', 'links', 'weights'].includes(key)));
      const overrides = Object.fromEntries(Object.entries(authored).filter(([key]) => key !== 'base_model' && key !== 'base_model_omit'));
      model = structuredClone(merge(base, overrides));
      if (Array.isArray(authored.base_model_omit)) for (const omitted of authored.base_model_omit) {
        if (typeof omitted !== 'string') throw new Error(`Invalid base_model_omit in ${path}`);
        const parts = omitted.split('.');
        let parent = model;
        for (const part of parts.slice(0, -1)) { const child = parent[part]; if (!Object.hasOwn(parent, part) || !table(child)) { parent = {}; break; } parent = child; }
        delete parent[parts.at(-1)!];
      }
      model.canonical_model_id = baseId;
    }
    provider.models[match[2]!] = { ...model, id: match[2]! };
    if (++parsed % 128 === 0) await yieldToHost();
  }
  return Object.fromEntries(providers);
}

/** Read data only from one coherent GitHub repository snapshot; never execute repository code. */
export async function fetchModelCatalogRepository(): Promise<RepositoryCatalog> {
  const response = await instrumentedFetch(MODEL_CATALOG_REPOSITORY_URL, { headers: { Accept: 'application/gzip' }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Model catalog repository returned HTTP ${response.status}`);
  const files = new Map<string, string>();
  let totalBytes = 0;
  await new Promise<void>((resolve, reject) => {
    const parser = new Parser({ strict: true, onReadEntry(entry) {
      const path = entry.path.split('/').slice(1).join('/');
      if (entry.type !== 'File' || !/^(?:models\/.+\.toml|providers\/[^/]+\/(?:provider\.toml|models\/.+\.toml))$/.test(path)) { entry.resume(); return; }
      const chunks: Buffer[] = [];
      entry.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > 64 * 1024 * 1024) { parser.abort(new Error('Model catalog exceeds its data budget')); return; }
        chunks.push(chunk);
      });
      entry.on('end', () => files.set(path, Buffer.concat(chunks).toString('utf8')));
      entry.on('error', reject);
    } });
    parser.on('error', reject); parser.on('end', resolve);
    const consume = async () => {
      if (!response.body) throw new Error('Model catalog repository returned no archive');
      const reader = response.body.getReader();
      let compressedBytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          compressedBytes += value.byteLength;
          if (compressedBytes > 32 * 1024 * 1024) throw new Error('Model catalog archive exceeds its download budget');
          parser.write(value);
        }
        parser.end();
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    };
    void consume().catch(error => { parser.abort(error instanceof Error ? error : new Error('Model catalog download failed')); reject(error); });
  });
  const catalog = await parseModelCatalogRepository(files);
  if (Object.keys(catalog).length === 0) throw new Error('Model catalog repository contains no provider data');
  return catalog;
}

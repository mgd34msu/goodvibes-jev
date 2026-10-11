/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, rmdirSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { PersistentStore } from '../state/persistent-store.js';
import { captureFileMutation, captureMutationDescriptors } from '../utils/file-mutation.js';
import { types as nodeTypes } from 'node:util';

export interface FavoriteEntry {
  registryKey: string;
  pinnedAt: string;
}

export interface UsageEntry {
  registryKey: string;
  lastUsed: string;
  count: number;
}

export interface FavoritesData {
  pinned: FavoriteEntry[];
  history: UsageEntry[];
}

const MAX_HISTORY = 100;

function emptyData(): FavoritesData {
  return { pinned: [], history: [] };
}

function normalizeFavoriteEntries(entries: unknown): FavoriteEntry[] {
  if (!Array.isArray(entries)) throw new Error('"pinned" must be an array');
  const seen = new Set<string>();
  const normalized: FavoriteEntry[] = [];
  for (const [index, rawEntry] of entries.entries()) {
    if (typeof rawEntry !== 'object' || rawEntry === null || Array.isArray(rawEntry)) {
      throw new Error(`"pinned[${index}]" must be an object`);
    }
    const entry = rawEntry as Partial<FavoriteEntry>;
    const registryKey = typeof entry.registryKey === 'string' ? entry.registryKey.trim() : '';
    if (!registryKey) throw new Error(`"pinned[${index}].registryKey" must be a non-empty string`);
    if (seen.has(registryKey)) throw new Error(`Duplicate pinned registryKey '${registryKey}'`);
    if (typeof entry.pinnedAt !== 'string') throw new Error(`"pinned[${index}].pinnedAt" must be a string`);
    seen.add(registryKey);
    normalized.push({ registryKey, pinnedAt: entry.pinnedAt });
  }
  return normalized;
}

function normalizeUsageEntries(entries: unknown): UsageEntry[] {
  if (!Array.isArray(entries)) throw new Error('"history" must be an array');
  const byRegistryKey = new Map<string, UsageEntry>();
  for (const [index, rawEntry] of entries.entries()) {
    if (typeof rawEntry !== 'object' || rawEntry === null || Array.isArray(rawEntry)) {
      throw new Error(`"history[${index}]" must be an object`);
    }
    const entry = rawEntry as Partial<UsageEntry>;
    const registryKey = typeof entry.registryKey === 'string' ? entry.registryKey.trim() : '';
    if (!registryKey) throw new Error(`"history[${index}].registryKey" must be a non-empty string`);
    if (typeof entry.lastUsed !== 'string') throw new Error(`"history[${index}].lastUsed" must be a string`);
    if (typeof entry.count !== 'number' || !Number.isFinite(entry.count) || entry.count < 1) {
      throw new Error(`"history[${index}].count" must be a positive finite number`);
    }
    const count = Math.trunc(entry.count);
    const existing = byRegistryKey.get(registryKey);
    if (!existing) {
      byRegistryKey.set(registryKey, { registryKey, lastUsed: entry.lastUsed, count });
      continue;
    }
    existing.count += count;
    if (entry.lastUsed.localeCompare(existing.lastUsed) > 0) existing.lastUsed = entry.lastUsed;
  }
  return [...byRegistryKey.values()];
}

function parseFavoritesData(value: unknown): { data: FavoritesData; warnings: string[] } {
  const warnings: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Favorites data root value must be a JSON object');
  }
  const parsed = value as Record<string, unknown>;
  return {
    data: {
      pinned: normalizeFavoriteEntries(parsed['pinned'] ?? []),
      history: normalizeUsageEntries(parsed['history'] ?? []),
    },
    warnings,
  };
}

export interface FavoritesStoreOptions {
  readonly dir: string;
}

/** Additional operation lifetime restrictions; these never grant write authority. */
export interface FavoritesUsageRestriction {
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent?: (() => void) | undefined;
}

export class FavoritesStore {
  private readonly dir: string;
  private cache: FavoritesData | null = null;

  constructor(options: FavoritesStoreOptions) {
    this.dir = options.dir;
  }

  getDirectory(): string {
    return this.dir;
  }

  getPath(): string {
    return join(this.dir, 'favorites.json');
  }

  async load(): Promise<FavoritesData> {
    const file = Bun.file(this.getPath());
    if (!await file.exists()) {
      const empty = emptyData();
      this.cache = empty;
      return empty;
    }
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      const { data: loaded, warnings } = parseFavoritesData(parsed);
      if (warnings.length > 0) {
        logger.warn('[favorites] Ignoring malformed favorites data', {
          path: this.getPath(),
          warnings,
        });
      }
      this.cache = loaded;
      return loaded;
    } catch (error) {
      logger.warn('[favorites] Favorites load failed; preserving existing file', {
        path: this.getPath(),
        error: summarizeError(error),
      });
      throw error;
    }
  }

  async save(data: FavoritesData): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    const path = this.getPath();
    const tmp = `${path}.tmp.${randomUUID()}`;
    await Bun.write(tmp, JSON.stringify(data, null, 2));
    await rename(tmp, path);
    this.cache = data;
  }

  async pinModel(registryKey: string): Promise<void> {
    const data = await this.getData();
    if (data.pinned.some((entry) => entry.registryKey === registryKey)) return;
    data.pinned.push({ registryKey, pinnedAt: new Date().toISOString() });
    await this.save(data);
  }

  async unpinModel(registryKey: string): Promise<void> {
    const data = await this.getData();
    data.pinned = data.pinned.filter((entry) => entry.registryKey !== registryKey);
    await this.save(data);
  }

  async getPinned(): Promise<string[]> {
    const data = await this.getData();
    return data.pinned.map((entry) => entry.registryKey);
  }

  async isModelPinned(registryKey: string): Promise<boolean> {
    const data = await this.getData();
    return data.pinned.some((entry) => entry.registryKey === registryKey);
  }

  async recordUsage(registryKey: string, ownership?: FavoritesUsageRestriction): Promise<void> {
    const assertOptions = ownership && captureMutationDescriptors(ownership, ['signal', 'assertCurrent']);
    const signal = ownership?.signal, suppliedCurrent = ownership?.assertCurrent;
    const assertOwner = ownership && captureMutationDescriptors(this, ['dir', 'getPath', 'recordUsage']);
    const ownedPath = this.getPath();
    const path = ownership ? resolve(ownedPath) : ownedPath;
    const physical = ownership && captureFileMutation(path);
    const current = () => {
      assertOptions?.(); signal?.throwIfAborted();
      const result: unknown = suppliedCurrent?.();
      if (result !== undefined) {
        if (nodeTypes.isPromise(result)) Reflect.apply(Promise.prototype.then, result, [undefined, () => {}]);
        throw new Error('Favorites usage lifetime check is unavailable.');
      }
      assertOptions?.(); assertOwner?.();
      if (this.getPath() !== ownedPath || (ownership && resolve(this.getPath()) !== path)) throw new Error('Favorites usage owner changed.');
      physical?.assertCurrent(); signal?.throwIfAborted();
    };
    current();
    const store = ownership ? new PersistentStore<Record<string, unknown>>(path) : undefined;
    const snapshot = store ? await store.load() : undefined;
    current();
    const data = store ? snapshot === null ? emptyData() : parseFavoritesData(snapshot).data : await this.getData();
    current();
    const now = new Date().toISOString();
    const existing = data.history.find((entry) => entry.registryKey === registryKey);
    if (existing) {
      existing.count += 1;
      existing.lastUsed = now;
    } else {
      data.history.push({ registryKey, lastUsed: now, count: 1 });
    }
    if (data.history.length > MAX_HISTORY) {
      data.history.sort((a, b) => a.lastUsed.localeCompare(b.lastUsed));
      data.history = data.history.slice(data.history.length - MAX_HISTORY);
    }
    if (store && physical) {
      current();
      const directory = dirname(path);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      physical.onEffect();
      current();
      const stage = join(directory, `.favorites-usage-${randomUUID()}`);
      mkdirSync(stage, { mode: 0o700 });
      physical.onEffect();
      const stageStat = lstatSync(stage, { bigint: true });
      const isOwnedStage = () => {
        const actual = lstatSync(stage, { bigint: true, throwIfNoEntry: false });
        return actual?.isDirectory() && !actual.isSymbolicLink()
          && actual.dev === stageStat.dev && actual.ino === stageStat.ino;
      };
      let completed = false;
      try {
        current();
        await store.persist({ pinned: data.pinned, history: data.history }, {
          durable: true, synchronousPublish: true, temporaryDirectory: stage, assertCurrent: current, beforePublish: current,
          onEffect: published => { if (published) physical.onEffect(true); else physical.assertCurrent(); },
          afterPublish: () => { current(); this.cache = data; },
        });
        current(); completed = true;
      } finally {
        if (isOwnedStage()) {
          if (completed) {
            current(); rmdirSync(stage); physical.onEffect(); current();
          } else {
            // Only the original empty private namespace may be removed after retirement.
            try { rmdirSync(stage); } catch { /* Preserve foreign contents and the original failure. */ }
          }
        }
      }
    } else await this.save(data);
  }

  async getRecentModels(n: number): Promise<string[]> {
    const data = await this.getData();
    return data.history
      .slice()
      .sort((a, b) => b.lastUsed.localeCompare(a.lastUsed))
      .slice(0, n)
      .map((entry) => entry.registryKey);
  }

  private async getData(): Promise<FavoritesData> {
    if (this.cache) return this.cache;
    return this.load();
  }
}

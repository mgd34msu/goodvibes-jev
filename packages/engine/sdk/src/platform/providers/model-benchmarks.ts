import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { TTL_24H_MS, isTtlCacheStale, validateTtlCacheEnvelope } from './json-ttl-cache.js';
import { instrumentedFetch, fetchWithTimeout } from '../utils/fetch-with-timeout.js';
import { ModelIdentityResolver } from '../routing/model-identity.js';

export interface ModelBenchmarks {
  gpqa?: number | undefined;
  swe?: number | undefined;
  aime?: number | undefined;
  terminal?: number | undefined;
  tool?: number | undefined;
  mcp?: number | undefined;
}

export interface BenchmarkEntry {
  modelId: string;
  name: string;
  organization: string;
  benchmarks: ModelBenchmarks;
}

export type QualityTier = 'S' | 'A' | 'B' | 'C';

interface ZeroEvalModel {
  id?: string | undefined;
  model_id?: string | undefined;
  name?: string | undefined;
  model_name?: string | undefined;
  organization?: string | undefined;
  org?: string | undefined;
  gpqa_score?: number | null | undefined;
  gpqa?: number | null | undefined;
  gpqa_diamond?: number | null | undefined;
  swe_bench_verified_score?: number | null | undefined;
  swe_bench?: number | null | undefined;
  swe?: number | null | undefined;
  aime_2025_score?: number | null | undefined;
  aime?: number | null | undefined;
  aime_2024?: number | null | undefined;
  terminal_bench_score?: number | null | undefined;
  terminal_bench?: number | null | undefined;
  terminal?: number | null | undefined;
  toolathlon_score?: number | null | undefined;
  tool_use?: number | null | undefined;
  tool?: number | null | undefined;
  mcp_atlas_score?: number | null | undefined;
  mcp_bench?: number | null | undefined;
  mcp?: number | null | undefined;
  scores?: Record<string, number | null> | undefined;
}

interface ZeroEvalResponse {
  models?: ZeroEvalModel[] | undefined;
  data?: ZeroEvalModel[] | undefined;
  leaderboard?: ZeroEvalModel[] | undefined;
}

interface BenchmarksCache {
  version: 1;
  fetchedAt: number;
  ttlMs: number;
  entries: BenchmarkEntry[];
}

const ZEROEVAL_URL = 'https://api.zeroeval.com/leaderboard/models/full?justCanonicals=true';
const FETCH_TIMEOUT_MS = 20_000;

export const S_TIER_THRESHOLD = 0.80;
export const A_TIER_THRESHOLD = 0.65;
export const B_TIER_THRESHOLD = 0.50;

function pickFirst<T>(...values: Array<T | null | undefined>): T | undefined {
  for (const value of values) {
    if (value != null) return value;
  }
  return undefined;
}

function parseScore(value: number | null | undefined): number | undefined {
  if (value == null || Number.isNaN(value)) return undefined;
  return value > 1 ? value / 100 : value;
}

function extractBenchmarks(model: ZeroEvalModel): ModelBenchmarks {
  const scores = model.scores ?? {};
  const raw = {
    gpqa: pickFirst(model.gpqa_score, model.gpqa_diamond, model.gpqa, scores.gpqa_score, scores.gpqa_diamond, scores.gpqa),
    swe: pickFirst(model.swe_bench_verified_score, model.swe_bench, model.swe, scores.swe_bench_verified_score, scores.swe_bench, scores.swe),
    aime: pickFirst(model.aime_2025_score, model.aime_2024, model.aime, scores.aime_2025_score, scores.aime_2024, scores.aime),
    terminal: pickFirst(model.terminal_bench_score, model.terminal_bench, model.terminal, scores.terminal_bench_score, scores.terminal_bench, scores.terminal),
    tool: pickFirst(model.toolathlon_score, model.tool_use, model.tool, scores.toolathlon_score, scores.tool_use, scores.tool),
    mcp: pickFirst(model.mcp_atlas_score, model.mcp_bench, model.mcp, scores.mcp_atlas_score, scores.mcp_bench, scores.mcp),
  };

  const benchmarks: ModelBenchmarks = {};
  if (raw.gpqa != null) benchmarks.gpqa = parseScore(raw.gpqa);
  if (raw.swe != null) benchmarks.swe = parseScore(raw.swe);
  if (raw.aime != null) benchmarks.aime = parseScore(raw.aime);
  if (raw.terminal != null) benchmarks.terminal = parseScore(raw.terminal);
  if (raw.tool != null) benchmarks.tool = parseScore(raw.tool);
  if (raw.mcp != null) benchmarks.mcp = parseScore(raw.mcp);
  return benchmarks;
}

function parseEntries(json: unknown): BenchmarkEntry[] {
  const raw = Array.isArray(json)
    ? json as ZeroEvalModel[]
    : ((json as ZeroEvalResponse).models ?? (json as ZeroEvalResponse).data ?? (json as ZeroEvalResponse).leaderboard ?? []);

  if (!Array.isArray(raw)) {
    logger.warn('[model-benchmarks] Unexpected ZeroEval response shape');
    return [];
  }

  return raw.map((model) => ({
    modelId: String(model.id ?? model.model_id ?? ''),
    name: String(model.name ?? model.model_name ?? model.id ?? model.model_id ?? ''),
    organization: String(model.organization ?? model.org ?? ''),
    benchmarks: extractBenchmarks(model),
  }));
}

function buildNameIndex(entries: readonly BenchmarkEntry[]): Map<string, BenchmarkEntry> {
  const index = new Map<string, BenchmarkEntry>();
  for (const entry of entries) {
    index.set(entry.name.toLowerCase(), entry);
    if (entry.modelId) {
      index.set(entry.modelId.toLowerCase(), entry);
    }
  }
  return index;
}

function validateBenchmarksCache(value: unknown): { cache: BenchmarksCache | null; reason?: string } {
  return validateTtlCacheEnvelope<BenchmarksCache>(value, 'entries', 'array');
}

export function compositeScore(benchmarks: ModelBenchmarks): number | null {
  let total = 0;
  let weight = 0;
  if (benchmarks.swe != null) { total += benchmarks.swe * 0.4; weight += 0.4; }
  if (benchmarks.gpqa != null) { total += benchmarks.gpqa * 0.4; weight += 0.4; }
  if (benchmarks.aime != null) { total += benchmarks.aime * 0.2; weight += 0.2; }
  return weight === 0 ? null : total / weight;
}

export function getQualityTier(benchmarks: ModelBenchmarks): QualityTier {
  const score = compositeScore(benchmarks);
  if (score == null) return 'C';
  return getQualityTierFromScore(score);
}

export function getQualityTierFromScore(score: number): QualityTier {
  if (score >= S_TIER_THRESHOLD) return 'S';
  if (score >= A_TIER_THRESHOLD) return 'A';
  if (score >= B_TIER_THRESHOLD) return 'B';
  return 'C';
}

export interface BenchmarkStoreOptions {
  readonly dir: string;
}

/** Cancel one wait without aborting the memoized identity other routes share. */
function waitForIdentity(reading: Promise<string | null>, signal?: AbortSignal): Promise<string | null> {
  if (signal === undefined) return reading;
  return new Promise((resolve, reject) => {
    const aborted = (): void => { reject(signal.reason); };
    if (signal.aborted) aborted();
    else signal.addEventListener('abort', aborted, { once: true });
    void reading.then(
      (value) => { signal.removeEventListener('abort', aborted); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', aborted); reject(error); },
    );
  });
}

export class BenchmarkStore {
  private readonly dir: string;
  private cache: BenchmarksCache | null = null;
  private nameIndex: Map<string, BenchmarkEntry> | null = null;
  private identityResolver: ModelIdentityResolver | null = null;
  private identityEntries: readonly BenchmarkEntry[] | null = null;
  private readonly refreshCallbacks = new Set<() => void>();
  /** The refresh initBenchmarks started, when the cache was missing or stale; settled at once otherwise. */
  private startupRefresh: Promise<void> = Promise.resolve();

  constructor(options: BenchmarkStoreOptions) {
    this.dir = options.dir;
  }

  getCachePath(): string {
    return join(this.dir, 'benchmarks.json');
  }

  private getTmpPath(): string {
    return `${this.getCachePath()}.tmp`;
  }

  onRefreshed(callback: () => void): () => void {
    this.refreshCallbacks.add(callback);
    return () => {
      this.refreshCallbacks.delete(callback);
    };
  }

  initBenchmarks(): void {
    this.cache = this.loadCache();
    this.nameIndex = this.cache ? buildNameIndex(this.cache.entries) : null;
    if (!this.cache || this.isCacheStale(this.cache)) {
      this.startupRefresh = this.refreshBenchmarks().catch((err: unknown) => {
        logger.warn('[model-benchmarks] Background refresh failed', { error: summarizeError(err) });
      });
    }
  }

  /**
   * Resolves when the refresh `initBenchmarks` started has finished, at once
   * when it started none (the cache was fresh, or it was never called). Never
   * rejects: a failed refresh is logged and keeps the cache it had.
   */
  benchmarksSettled(): Promise<void> {
    return this.startupRefresh;
  }

  async refreshBenchmarks(): Promise<void> {
    const entries = await this.fetchBenchmarks();
    if (entries.length === 0) {
      logger.warn('[model-benchmarks] Refresh returned 0 entries, keeping existing cache');
      return;
    }
    const next: BenchmarksCache = {
      version: 1,
      fetchedAt: Date.now(),
      ttlMs: TTL_24H_MS,
      entries,
    };
    this.saveCache(next);
    this.cache = next;
    this.nameIndex = buildNameIndex(entries);
    for (const callback of this.refreshCallbacks) callback();
    logger.debug('[model-benchmarks] Cache updated', { count: entries.length });
  }

  /**
   * The leaderboard entry for a model: an exact name or id, the same ignoring
   * case, else the entry Jev read as the same model (routing.model-identity).
   * An identity not read yet is requested, and the model has no entry until
   * the reading lands.
   */
  getBenchmarks(modelName: string): BenchmarkEntry | undefined {
    return this.findBenchmarks(modelName, true);
  }

  /** {@link getBenchmarks} without requesting a reading: for sweeps over many models. */
  getKnownBenchmarks(modelName: string): BenchmarkEntry | undefined {
    return this.findBenchmarks(modelName, false);
  }

  /** {@link getBenchmarks}, waiting for the identity reading instead of answering without it. */
  async readBenchmarks(modelName: string, site = 'providers.model-benchmarks.identity', signal?: AbortSignal): Promise<BenchmarkEntry | undefined> {
    signal?.throwIfAborted();
    const known = this.findBenchmarks(modelName, false);
    if (known) return known;
    const entries = this.cache?.entries ?? [];
    if (entries.length === 0) return undefined;
    const same = await waitForIdentity(this.identity().resolve({ id: modelName }, site), signal);
    signal?.throwIfAborted();
    return same === null ? undefined : entries.find((entry) => entry.modelId === same);
  }

  private findBenchmarks(modelName: string, request: boolean): BenchmarkEntry | undefined {
    const entries = this.cache?.entries;
    if (!entries || entries.length === 0) return undefined;
    const index = this.nameIndex ?? buildNameIndex(entries);

    const exact = entries.find((entry) => entry.name === modelName || entry.modelId === modelName);
    if (exact) return exact;

    const indexed = index.get(modelName.toLowerCase());
    if (indexed) return indexed;

    const query = { id: modelName };
    const same = request ? this.identity().lookup(query, 'providers.model-benchmarks.identity') : this.identity().known(query) ?? null;
    return same === null ? undefined : entries.find((entry) => entry.modelId === same);
  }

  /** Identity readings over the current leaderboard, rebuilt when the leaderboard is refreshed. */
  private identity(): ModelIdentityResolver {
    const entries = this.cache?.entries ?? [];
    if (!this.identityResolver || this.identityEntries !== entries) {
      const candidates = entries.filter((entry) => entry.modelId).map((entry) => ({ key: entry.modelId, id: entry.modelId, name: entry.name }));
      this.identityEntries = entries;
      this.identityResolver = new ModelIdentityResolver({ universe: 'benchmarks', candidates: () => candidates });
    }
    return this.identityResolver;
  }

  getTopBenchmarkModelIds(n: number): string[] {
    const entries = this.cache?.entries;
    if (!entries || entries.length === 0) return [];
    return entries
      .map((entry) => ({ id: entry.modelId, score: compositeScore(entry.benchmarks) }))
      .filter((entry): entry is { id: string; score: number } => entry.score != null)
      .sort((a, b) => b.score - a.score)
      .slice(0, n)
      .map((entry) => entry.id);
  }

  private async fetchBenchmarks(): Promise<BenchmarkEntry[]> {
    const response = await fetchWithTimeout(ZEROEVAL_URL, {
      headers: { Accept: 'application/json' },
    }, FETCH_TIMEOUT_MS, instrumentedFetch);
    if (!response.ok) {
      throw new Error(`ZeroEval API returned ${response.status} ${response.statusText}`);
    }
    return parseEntries(await response.json());
  }

  private loadCache(): BenchmarksCache | null {
    try {
      const parsed = JSON.parse(readFileSync(this.getCachePath(), 'utf-8')) as unknown;
      const { cache, reason } = validateBenchmarksCache(parsed);
      if (!cache) {
        logger.warn('[model-benchmarks] Ignoring malformed cache', {
          cachePath: this.getCachePath(),
          reason: reason ?? 'unknown',
        });
        return null;
      }
      return cache;
    } catch (err) {
      const message = summarizeError(err);
      if (message.includes('ENOENT') || message.includes('no such file')) {
        logger.debug('[model-benchmarks] No cache file found (first run)');
      } else {
        logger.warn('[model-benchmarks] Cache load failed (corrupted?)', { error: message });
      }
      return null;
    }
  }

  private saveCache(cache: BenchmarksCache): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.getTmpPath(), JSON.stringify(cache, null, 2), 'utf-8');
      renameSync(this.getTmpPath(), this.getCachePath());
    } catch (err) {
      logger.warn('[model-benchmarks] Cache write failed', { error: summarizeError(err) });
    }
  }

  private isCacheStale(cache: BenchmarksCache): boolean {
    return isTtlCacheStale(cache);
  }
}

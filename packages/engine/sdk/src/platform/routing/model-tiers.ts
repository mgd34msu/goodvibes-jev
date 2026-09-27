/**
 * Model capability tiers from published facts: the routing.model-tier
 * readings composed in code, remembered per model (and on disk when a path is
 * given) so a model is read once until its facts change.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { JsonValue, YesNoReading } from '@goodvibes-jev/judgment';
import { mapLimit } from '@goodvibes-jev/judgment';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { modelTier } from './batteries/model.js';
import { TIER_READ_CONCURRENCY } from './policy.js';
import type { RouteTier } from './tiers.js';

/** What routing knows about one model: published facts only. */
export interface ModelFacts {
  /** `provider:model`. */
  readonly registryKey: string;
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly family?: string | undefined;
  readonly contextWindow?: number | undefined;
  readonly maxOutputTokens?: number | undefined;
  /** USD per million tokens; 'free', 'subscription' or 'unpriced' when there is no metered price. */
  readonly price?: { readonly input: number; readonly output: number } | 'free' | 'subscription' | 'unpriced' | undefined;
  readonly reasoning?: boolean | undefined;
  readonly inputModalities?: readonly string[] | undefined;
  /** Composite of published benchmark scores, 0 to 1, when the model has any. */
  readonly benchmark?: number | null | undefined;
}

/** The facts as the model questions read them: `{ model: { ... } }`, absent facts left out. */
export function modelFactsState(facts: ModelFacts): { model: Record<string, JsonValue> } {
  const out: Record<string, JsonValue> = { id: facts.id, name: facts.name, provider: facts.provider };
  if (facts.family) out['family'] = facts.family;
  if (facts.contextWindow) out['context_window'] = facts.contextWindow;
  if (facts.maxOutputTokens) out['max_output_tokens'] = facts.maxOutputTokens;
  if (facts.price !== undefined) out['price_per_million_tokens'] = typeof facts.price === 'string' ? facts.price : { input: facts.price.input, output: facts.price.output };
  if (facts.reasoning !== undefined) out['reasoning'] = facts.reasoning;
  if (facts.inputModalities?.length) out['input_modalities'] = [...facts.inputModalities];
  if (typeof facts.benchmark === 'number') out['benchmark_composite'] = Number(facts.benchmark.toFixed(3));
  return { model: out };
}

/** A reading that code may act on without asking anyone. */
const holds = (reading: YesNoReading): boolean => reading.verdict === 'yes' && reading.outcome === 'act';
const clearlyNot = (reading: YesNoReading): boolean => reading.verdict === 'no';

/**
 * The tier the two readings support: a frontier flagship is premium, a small
 * or special-purpose model is economy, a model that clearly reads as neither
 * is standard. Contradictory or unsure readings give no tier.
 */
export function modelTierFrom(readings: { readonly frontier: YesNoReading; readonly small: YesNoReading }): RouteTier | undefined {
  const frontier = holds(readings.frontier);
  const small = holds(readings.small);
  if (frontier && small) return undefined;
  if (frontier) return 'premium';
  if (small) return 'economy';
  if (clearlyNot(readings.frontier) && clearlyNot(readings.small)) return 'standard';
  return undefined;
}

export interface TierRecord {
  /** The composed tier; undefined when the readings did not settle one. */
  readonly tier: RouteTier | undefined;
  readonly frontier: number;
  readonly small: number;
}

interface StoredTier extends TierRecord {
  readonly fingerprint: string;
}

interface TierFile {
  readonly version: 1;
  readonly entries: Record<string, StoredTier>;
}

/** The facts a tier depends on and the battery version that read them; a change to either means a new reading. */
function fingerprint(facts: ModelFacts): string {
  return `v${modelTier.version}:${JSON.stringify(modelFactsState({ ...facts, registryKey: '' }).model)}`;
}

/**
 * Tier readings per model. `known` is a synchronous lookup for code that
 * cannot wait (model definitions built for the registry); `read` asks for
 * what is missing. Nothing is guessed for a model that has not been read.
 */
export class ModelTierStore {
  readonly #path: string | undefined;
  readonly #entries = new Map<string, StoredTier>();
  readonly #inFlight = new Map<string, Promise<TierRecord>>();

  constructor(options: { readonly path?: string | undefined } = {}) {
    this.#path = options.path;
    if (this.#path) this.#load(this.#path);
  }

  /** The remembered reading for these exact facts, or undefined when they have not been read. */
  known(facts: ModelFacts): TierRecord | undefined {
    const entry = this.#entries.get(facts.registryKey);
    return entry && entry.fingerprint === fingerprint(facts) ? entry : undefined;
  }

  /**
   * The last reading for a model whatever facts it was read from, for labels
   * built from a different view of the same model (catalog definitions).
   */
  lastReading(registryKey: string): TierRecord | undefined {
    return this.#entries.get(registryKey);
  }

  /** Reads one model's tier (once per set of facts). */
  read(facts: ModelFacts, options: { readonly site?: string; readonly signal?: AbortSignal } = {}): Promise<TierRecord> {
    const known = this.known(facts);
    if (known) return Promise.resolve(known);
    const key = `${facts.registryKey}\u0000${fingerprint(facts)}`;
    const pending = this.#inFlight.get(key);
    if (pending) return pending;
    const site = options.site ?? 'routing.model-tier';
    const reading = (async (): Promise<TierRecord> => {
      const run = await modelTier.run(judgmentPort(site), modelFactsState(facts), {
        site,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      const record: TierRecord = {
        tier: modelTierFrom(run.readings),
        frontier: run.readings.frontier.probability,
        small: run.readings.small.probability,
      };
      run.recordAction(`tier:${record.tier ?? 'unsettled'}`);
      this.#entries.set(facts.registryKey, { ...record, fingerprint: fingerprint(facts) });
      this.#save();
      return record;
    })();
    this.#inFlight.set(key, reading);
    void reading.finally(() => this.#inFlight.delete(key)).catch(() => undefined);
    return reading;
  }

  /** Reads every model not yet read, a bounded number at a time. */
  async readMany(
    models: readonly ModelFacts[],
    options: { readonly site?: string; readonly signal?: AbortSignal } = {},
  ): Promise<ReadonlyMap<string, TierRecord>> {
    const records = await mapLimit(models, TIER_READ_CONCURRENCY, (facts) => this.read(facts, options));
    return new Map(models.map((facts, index) => [facts.registryKey, records[index]!]));
  }

  #load(path: string): void {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<TierFile>;
      if (parsed.version !== 1 || typeof parsed.entries !== 'object' || parsed.entries === null) return;
      for (const [key, entry] of Object.entries(parsed.entries)) this.#entries.set(key, entry);
    } catch (error) {
      const message = summarizeError(error);
      if (!message.includes('ENOENT') && !message.includes('no such file')) logger.warn('[routing] Ignoring unreadable model tier file', { path, error: message });
    }
  }

  #save(): void {
    if (!this.#path) return;
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      const file: TierFile = { version: 1, entries: Object.fromEntries(this.#entries) };
      const tmp = `${this.#path}.tmp`;
      writeFileSync(tmp, JSON.stringify(file), 'utf-8');
      renameSync(tmp, this.#path);
    } catch (error) {
      logger.warn('[routing] Model tier file write failed', { path: this.#path, error: summarizeError(error) });
    }
  }
}

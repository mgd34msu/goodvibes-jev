/**
 * How each catalog provider's models are paid for, read once per set of
 * published provider facts (routing.catalog-provider-access) and remembered on
 * disk beside the catalog cache, so a daily catalog refresh reads only the
 * providers that are new or whose facts changed.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { mapLimit, type YesNoReading } from '@goodvibes-jev/judgment';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { catalogProviderAccess, type ProviderAccess } from './batteries/catalog.js';

export type { ProviderAccess };

/** A catalog provider's published facts. */
export interface ProviderFacts {
  readonly id: string;
  readonly name: string;
  readonly api?: string | undefined;
  readonly doc?: string | undefined;
  readonly envVars: readonly string[];
  /** A few model names, for context. */
  readonly sampleModels: readonly string[];
}

/** Provider readings in flight at once during a catalog refresh. */
const ACCESS_READ_CONCURRENCY = 8;

const holds = (reading: YesNoReading): boolean => reading.verdict === 'yes' && reading.outcome === 'act';

/**
 * The access the two readings support: local when the models run locally,
 * subscription when access is sold as a plan, metered when both clearly read
 * no. Contradictory or unsure readings give no access, and such a provider's
 * zero prices are never taken to mean free.
 */
export function providerAccessFrom(readings: { readonly local: YesNoReading; readonly plan: YesNoReading }): ProviderAccess | undefined {
  const local = holds(readings.local);
  const plan = holds(readings.plan);
  if (local && plan) return undefined;
  if (local) return 'local';
  if (plan) return 'subscription';
  if (readings.local.verdict === 'no' && readings.plan.verdict === 'no') return 'metered';
  return undefined;
}

export function providerFactsState(facts: ProviderFacts): { provider: Record<string, string | string[]> } {
  return {
    provider: {
      id: facts.id,
      name: facts.name,
      ...(facts.api ? { api: facts.api } : {}),
      ...(facts.doc ? { doc: facts.doc } : {}),
      env_vars: [...facts.envVars],
      sample_models: [...facts.sampleModels],
    },
  };
}

interface StoredAccess {
  readonly fingerprint: string;
  readonly access: ProviderAccess | null;
}

export class ProviderAccessReadings {
  readonly #path: string | undefined;
  readonly #entries = new Map<string, StoredAccess>();

  constructor(options: { readonly path?: string | undefined } = {}) {
    this.#path = options.path;
    if (this.#path) this.#load(this.#path);
  }

  /** Reads every provider whose facts have not been read; returns each provider's access (undefined when unsettled). */
  async readAll(providers: readonly ProviderFacts[], site = 'providers.model-catalog.provider-access'): Promise<ReadonlyMap<string, ProviderAccess | undefined>> {
    const pending = providers.filter((facts) => this.#entries.get(facts.id)?.fingerprint !== JSON.stringify(providerFactsState(facts)));
    await mapLimit(pending, ACCESS_READ_CONCURRENCY, async (facts) => {
      const run = await catalogProviderAccess.run(judgmentPort(site), providerFactsState(facts), { site });
      const access = providerAccessFrom(run.readings);
      run.recordAction(`access:${access ?? 'unsettled'}`);
      this.#entries.set(facts.id, { fingerprint: JSON.stringify(providerFactsState(facts)), access: access ?? null });
    });
    if (pending.length > 0) this.#save();
    return new Map(providers.map((facts) => [facts.id, this.#entries.get(facts.id)?.access ?? undefined]));
  }

  #load(path: string): void {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { version?: number; entries?: Record<string, StoredAccess> };
      if (parsed.version !== 1 || typeof parsed.entries !== 'object' || parsed.entries === null) return;
      for (const [id, entry] of Object.entries(parsed.entries)) this.#entries.set(id, entry);
    } catch (error) {
      const message = summarizeError(error);
      if (!message.includes('ENOENT') && !message.includes('no such file')) logger.warn('[routing] Ignoring unreadable provider access file', { path, error: message });
    }
  }

  #save(): void {
    if (!this.#path) return;
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      const tmp = `${this.#path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, entries: Object.fromEntries(this.#entries) }), 'utf-8');
      renameSync(tmp, this.#path);
    } catch (error) {
      logger.warn('[routing] Provider access file write failed', { path: this.#path, error: summarizeError(error) });
    }
  }
}

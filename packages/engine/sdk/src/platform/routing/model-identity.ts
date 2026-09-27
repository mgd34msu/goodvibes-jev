/**
 * Model identity: which entry of a candidate list (the catalog, the OpenRouter
 * limits feed, the benchmark leaderboard, the static price table) names the
 * same model as a queried id. Exact id matches stay with the callers (a fixed
 * format); everything the old substring, prefix, date-stem and slug matching
 * guessed is read by routing.model-identity over a lexical shortlist built in
 * code, and remembered.
 *
 * Callers that cannot wait (render-time cost lookups, token limits for the
 * turn) use `lookup`: it answers from what has been read and asks for what
 * has not, so the answer is there on the next lookup. Until then the model is
 * reported as unknown, never matched by a guess.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { NONE } from '@goodvibes-jev/judgment';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { modelIdentity } from './batteries/model.js';

export interface IdentityCandidate {
  /** What the caller looks the match up by: a catalog id, a table key, a `provider:model` key. */
  readonly key: string;
  readonly id: string;
  readonly name?: string | undefined;
  readonly provider?: string | undefined;
  /** The catalog's family label, when the list has one. */
  readonly family?: string | undefined;
}

export interface IdentityQuery {
  readonly id: string;
  readonly name?: string | undefined;
  readonly provider?: string | undefined;
  /** Offer only candidates of this family (a catalog fact). */
  readonly family?: string | undefined;
  /** Offer only candidates from other providers than this one. */
  readonly otherProviderThan?: string | undefined;
}

/** How many lexical neighbours the identity question weighs. */
export const IDENTITY_SHORTLIST = 8;

/** Lower-case alphanumeric runs, also split where letters meet digits: `gpt4o-mini` gives gpt, 4, o, mini. */
export function identityTokens(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+|(?<=[a-z])(?=[0-9])|(?<=[0-9])(?=[a-z])/).filter((token) => token.length > 0);
}

interface IndexedCandidate {
  readonly candidate: IdentityCandidate;
  readonly tokens: ReadonlySet<string>;
  readonly length: number;
}

function queryTokens(query: IdentityQuery): Set<string> {
  return new Set([...identityTokens(query.id), ...identityTokens(query.name ?? '')]);
}

/**
 * The candidates sharing the most tokens with the query, best first: a
 * retrieval step that bounds what the identity question weighs. It decides
 * nothing; a candidate sharing no token is never offered.
 */
export function identityShortlist(query: IdentityQuery, index: readonly IndexedCandidate[], limit = IDENTITY_SHORTLIST): IdentityCandidate[] {
  const wanted = queryTokens(query);
  const queryLength = query.id.length;
  const scored: { entry: IndexedCandidate; shared: number }[] = [];
  for (const entry of index) {
    if (query.family !== undefined && entry.candidate.family !== query.family) continue;
    if (query.otherProviderThan !== undefined && entry.candidate.provider === query.otherProviderThan) continue;
    let shared = 0;
    for (const token of wanted) if (entry.tokens.has(token)) shared++;
    if (shared > 0) scored.push({ entry, shared });
  }
  scored.sort((a, b) =>
    b.shared - a.shared
    || Math.abs(a.entry.length - queryLength) - Math.abs(b.entry.length - queryLength)
    || a.entry.candidate.key.localeCompare(b.entry.candidate.key));
  // Several list entries can share a lookup key (one catalog id served by
  // several providers); the question offers each key once.
  const seen = new Set<string>();
  const shortlist: IdentityCandidate[] = [];
  for (const { entry } of scored) {
    if (seen.has(entry.candidate.key)) continue;
    seen.add(entry.candidate.key);
    shortlist.push(entry.candidate);
    if (shortlist.length === limit) break;
  }
  return shortlist;
}

function indexCandidates(candidates: readonly IdentityCandidate[]): IndexedCandidate[] {
  return candidates.map((candidate) => ({
    candidate,
    tokens: new Set([...identityTokens(candidate.id), ...identityTokens(candidate.name ?? '')]),
    length: candidate.id.length,
  }));
}

interface IdentityFile {
  readonly version: 1;
  readonly entries: Record<string, string | null>;
}

export interface ModelIdentityResolverOptions {
  /** Names the candidate list in the decision log: 'catalog', 'benchmarks', 'openrouter-limits', 'static-pricing'. */
  readonly universe: string;
  /** The current candidate list; re-indexed only when the returned array changes. */
  readonly candidates: () => readonly IdentityCandidate[];
  /** Persist readings here so a restart does not ask again. */
  readonly path?: string | undefined;
}

export class ModelIdentityResolver {
  readonly #universe: string;
  readonly #source: () => readonly IdentityCandidate[];
  readonly #path: string | undefined;
  readonly #memo = new Map<string, string | null>();
  readonly #inFlight = new Map<string, Promise<string | null>>();
  #indexedFrom: readonly IdentityCandidate[] | undefined;
  #index: readonly IndexedCandidate[] = [];

  constructor(options: ModelIdentityResolverOptions) {
    this.#universe = options.universe;
    this.#source = options.candidates;
    this.#path = options.path;
    if (this.#path) this.#load(this.#path);
  }

  #currentIndex(): readonly IndexedCandidate[] {
    const candidates = this.#source();
    if (candidates !== this.#indexedFrom) {
      this.#indexedFrom = candidates;
      this.#index = indexCandidates(candidates);
    }
    return this.#index;
  }

  /** The memo key: the query and the exact shortlist it was asked over, so a changed list is asked again. */
  #keyFor(query: IdentityQuery, shortlist: readonly IdentityCandidate[]): string {
    return [`v${modelIdentity.version}`, query.provider ?? '', query.id, query.name ?? '', query.family ?? '', query.otherProviderThan ?? '', ...shortlist.map((candidate) => candidate.key)].join('\u0000');
  }

  /** The remembered answer: a candidate key, null for "none of them", undefined when not read yet. */
  known(query: IdentityQuery): string | null | undefined {
    const shortlist = identityShortlist(query, this.#currentIndex());
    if (shortlist.length === 0) return null;
    return this.#memo.get(this.#keyFor(query, shortlist));
  }

  /**
   * For callers that cannot wait: the remembered answer, or null now while
   * the reading is requested for the next lookup. A failed reading is logged
   * and asked again on a later lookup.
   */
  lookup(query: IdentityQuery, site: string): string | null {
    const known = this.known(query);
    if (known !== undefined) return known;
    void this.resolve(query, site).catch((error: unknown) => {
      logger.warn('[routing] Model identity reading failed', { universe: this.#universe, model: query.id, error: summarizeError(error) });
    });
    return null;
  }

  /** Reads which candidate is the same model as the query, or null when none is. */
  resolve(query: IdentityQuery, site: string, signal?: AbortSignal): Promise<string | null> {
    const shortlist = identityShortlist(query, this.#currentIndex());
    if (shortlist.length === 0) return Promise.resolve(null);
    const key = this.#keyFor(query, shortlist);
    const known = this.#memo.get(key);
    if (known !== undefined) return Promise.resolve(known);
    const pending = this.#inFlight.get(key);
    if (pending) return pending;
    const reading = (async (): Promise<string | null> => {
      const selection = await modelIdentity.select(
        judgmentPort(site),
        { model: { id: query.id, ...(query.name ? { name: query.name } : {}), ...(query.provider ? { provider: query.provider } : {}) } },
        shortlist.map((candidate) => ({
          id: candidate.key,
          content: { id: candidate.id, ...(candidate.name ? { name: candidate.name } : {}), ...(candidate.provider ? { provider: candidate.provider } : {}) },
        })),
        { site, ...(signal ? { signal } : {}) },
      );
      // An escalated reading is not strong enough to price or group by: the model stays unmatched.
      const chosen = selection.outcome === 'escalate' || selection.chosen === NONE ? null : selection.chosen ?? null;
      selection.recordAction(chosen === null ? `${this.#universe}:none` : `${this.#universe}:match`);
      this.#memo.set(key, chosen);
      this.#save();
      return chosen;
    })();
    this.#inFlight.set(key, reading);
    void reading.finally(() => this.#inFlight.delete(key)).catch(() => undefined);
    return reading;
  }

  #load(path: string): void {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<IdentityFile>;
      if (parsed.version !== 1 || typeof parsed.entries !== 'object' || parsed.entries === null) return;
      for (const [key, value] of Object.entries(parsed.entries)) this.#memo.set(key, value);
    } catch (error) {
      const message = summarizeError(error);
      if (!message.includes('ENOENT') && !message.includes('no such file')) logger.warn('[routing] Ignoring unreadable model identity file', { path, error: message });
    }
  }

  #save(): void {
    if (!this.#path) return;
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      const file: IdentityFile = { version: 1, entries: Object.fromEntries(this.#memo) };
      const tmp = `${this.#path}.tmp`;
      writeFileSync(tmp, JSON.stringify(file), 'utf-8');
      renameSync(tmp, this.#path);
    } catch (error) {
      logger.warn('[routing] Model identity file write failed', { path: this.#path, error: summarizeError(error) });
    }
  }
}

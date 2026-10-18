/** Deterministic identity joins over published model IDs and explicit aliases. */
export interface IdentityCandidate {
  readonly key: string;
  readonly id: string;
  readonly name?: string | undefined;
  readonly provider?: string | undefined;
  readonly family?: string | undefined;
  readonly canonicalModelId?: string | undefined;
  readonly aliases?: readonly string[] | undefined;
}

export interface IdentityQuery {
  readonly id: string;
  readonly name?: string | undefined;
  readonly provider?: string | undefined;
  readonly family?: string | undefined;
  readonly otherProviderThan?: string | undefined;
  readonly canonicalModelId?: string | undefined;
}

export interface ModelIdentityResolverOptions {
  readonly candidates: () => readonly IdentityCandidate[];
}

export class ModelIdentityResolver {
  readonly #source: ModelIdentityResolverOptions['candidates'];
  #indexedFrom: readonly IdentityCandidate[] | undefined;
  readonly #byId = new Map<string, IdentityCandidate[]>();
  readonly #byCanonicalId = new Map<string, IdentityCandidate[]>();

  constructor(options: ModelIdentityResolverOptions) { this.#source = options.candidates; }

  #index(): void {
    const source = this.#source();
    if (source === this.#indexedFrom) return;
    this.#byId.clear(); this.#byCanonicalId.clear();
    const add = (index: Map<string, IdentityCandidate[]>, id: string, candidate: IdentityCandidate) => {
      const entries = index.get(id) ?? [];
      entries.push(candidate); index.set(id, entries);
    };
    for (const candidate of source) {
      for (const id of new Set([candidate.key, candidate.id, ...(candidate.aliases ?? [])])) add(this.#byId, id, candidate);
      if (candidate.canonicalModelId) add(this.#byCanonicalId, candidate.canonicalModelId, candidate);
    }
    this.#indexedFrom = source;
  }

  #choose(entries: readonly IdentityCandidate[], query: IdentityQuery): string | null {
    let matches = entries.filter(candidate =>
      (query.family === undefined || candidate.family === query.family)
      && (query.otherProviderThan === undefined || candidate.provider !== query.otherProviderThan)
      && (!query.canonicalModelId || !candidate.canonicalModelId || candidate.canonicalModelId === query.canonicalModelId));
    if (query.provider && query.otherProviderThan === undefined) {
      const own = matches.filter(candidate => candidate.provider === query.provider);
      if (own.length > 0) matches = own;
    }
    const keys = [...new Set(matches.map(candidate => candidate.key))].sort();
    if (keys.length === 1) return keys[0]!;
    // A failover group can join several offerings only through one published identity.
    if (query.otherProviderThan !== undefined && matches.length > 0
      && matches.every(candidate => candidate.canonicalModelId && candidate.canonicalModelId === matches[0]!.canonicalModelId)) return keys[0]!;
    return null;
  }

  known(query: IdentityQuery): string | null {
    this.#index();
    if (query.canonicalModelId) return this.#choose(this.#byCanonicalId.get(query.canonicalModelId) ?? [], query);
    const direct = this.#byId.get(query.id) ?? [];
    if (direct.length > 0) return this.#choose(direct, query);
    return this.#choose(this.#byCanonicalId.get(query.id) ?? [], query);
  }

  /** Attribution arguments remain accepted by SDK consumers; resolution is synchronous. */
  lookup(query: IdentityQuery, _site: string, _onResolved?: () => void): string | null { return this.known(query); }

  async resolve(query: IdentityQuery, _site: string, signal?: AbortSignal): Promise<string | null> {
    signal?.throwIfAborted();
    return this.known(query);
  }
}

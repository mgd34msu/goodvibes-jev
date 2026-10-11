import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { bestId } from './object';
import { readCredentialProvider, type CredentialProviderResult } from './credential-provider-judgment';
import { getClientLifetime, isClientLifetimeCurrent, subscribeClientLifetime } from './client-lifetime';
import { modelOptionsForProvider, providerModelSourceIds } from './provider-models';

/** One mounted caller owns each reading. A catalog answer is never a global alias cache or execution grant. */
export function useProviderModelOptions(provider: unknown, catalog: unknown[], callerIdentity: string, enabled = true) {
  const mounted = useRef(true);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [clientRevision, setClientRevision] = useState(0);
  useEffect(() => subscribeClientLifetime(() => setClientRevision(value => value + 1)), []);
  const owner = useMemo(() => ({ provider, catalog, callerIdentity, enabled, clientRevision, client: getClientLifetime() }),
    [provider, catalog, callerIdentity, enabled, clientRevision]);
  const latest = useRef<typeof owner | undefined>(undefined);
  useLayoutEffect(() => {
    latest.current = owner;
    return () => {
      if (latest.current === owner) latest.current = undefined;
    };
  }, [owner]);
  const [reading, setReading] = useState<{
    owner: typeof owner;
    keys: readonly string[];
    result: CredentialProviderResult;
  }>();
  useEffect(() => {
    if (!enabled || !provider) return;
    const providerId = bestId(provider);
    const explicit = new Set([providerId, ...providerModelSourceIds(provider)]);
    const keys = [...new Set(catalog.map(bestId))].filter(id => id && !explicit.has(id));
    if (!providerId || !keys.length || keys.length > 64) return;
    const abort = new AbortController();
    void readCredentialProvider(providerId, keys, abort.signal, 'webui.models.catalog-provider-match').then(result => {
      if (!abort.signal.aborted && latest.current === owner) setReading({ owner, keys, result });
    });
    return () => abort.abort();
  }, [owner, provider, catalog, enabled]);
  const currentModels = () => {
    if (!isClientLifetimeCurrent(owner.client) || !enabled || !provider) return [];
    const inferred = reading?.owner === owner && reading.result.status === 'ready' && reading.result.isCurrent()
      ? reading.keys.filter((_, index) => reading.result.status === 'ready' && reading.result.matches.at(index) === true)
      : [];
    return modelOptionsForProvider(provider, catalog, inferred);
  };
  return {
    models: currentModels(),
    /** Recheck immediately before dispatch so a detached handler cannot use a retired answer. */
    hasCurrentModel: (registryKey: string) => mounted.current && latest.current === owner
      && currentModels().some(model => model.registryKey === registryKey),
  };
}

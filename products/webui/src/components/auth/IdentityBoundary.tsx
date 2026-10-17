import { useLayoutEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getClientLifetime, subscribeClientLifetime } from '../../lib/client-lifetime';
import { writeStoredActiveCompanionSessionId, writeStoredCompanionSessions } from '../../lib/companion-chat';

/** Each credential/transport generation owns its cache and mounted application. */
export function IdentityBoundary({ children }: { children: ReactNode }) {
  const lifetime = useSyncExternalStore(subscribeClientLifetime, getClientLifetime, getClientLifetime);
  const client = useMemo(() => new QueryClient({
    defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 10_000 } },
  }), [lifetime]);
  useLayoutEffect(() => {
    const unsubscribe = subscribeClientLifetime(() => {
      // Cancel before any late anonymous or previous-owner response is adopted.
      void client.cancelQueries();
      client.clear();
      writeStoredCompanionSessions([]);
      writeStoredActiveCompanionSessionId('');
    });
    return () => { unsubscribe(); void client.cancelQueries(); client.clear(); };
  }, [client]);
  return <QueryClientProvider key={lifetime.revision} client={client}>{children}</QueryClientProvider>;
}

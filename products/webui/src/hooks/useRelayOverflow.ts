import { useSyncExternalStore } from 'react';
import {
  getRelayOverflowSnapshot,
  subscribeRelayOverflow,
  type RelayOverflowSnapshot,
} from '../lib/relay-stream-overflow';

/**
 * Reactively read the relay live-event overflow accounting. Returns the current snapshot;
 * `totalDropped > 0` means the UI should show the honest "events were dropped, resync" notice.
 */
export function useRelayOverflow(): RelayOverflowSnapshot {
  return useSyncExternalStore(subscribeRelayOverflow, getRelayOverflowSnapshot, getRelayOverflowSnapshot);
}

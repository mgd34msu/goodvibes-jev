/**
 * useOriginPosture, the honest TLS/capability posture of THIS surface's own origin
 * (SDK 1.8.0's LAN-http posture work, pairing.posture.get).
 *
 * A plain-http origin on a private network (a LAN IP, a .local name, localhost) is a
 * supported posture: the app works, but three browser-gated capabilities, service
 * worker/PWA install, push, microphone, are unavailable there, each labeled with the
 * daemon's OWN "needs https, available via tailscale" wording rather than a client-
 * fabricated guess. This hook fetches that posture ONCE for `window.location.origin`
 * (an origin's posture cannot change within a session, a browser reload is the only
 * way this page's own scheme/host could ever change) and every consumer (MicButton,
 * NotificationSettings, the pairing hand-off flow) reads the same cached result rather
 * than each re-deriving it.
 *
 * Requires an authenticated principal (the route 401s otherwise), callers gate
 * `enabled` on their own auth state; it defaults to true for call sites that only ever
 * mount post-sign-in (MicButton, NotificationSettings).
 */
import { useQuery } from '@tanstack/react-query';
import { sdk } from '../lib/goodvibes';
import type { OriginPosture } from '../lib/goodvibes';
import { queryKeys } from '../lib/queries';

export interface UseOriginPosture {
  readonly posture: OriginPosture | undefined;
  readonly isLoading: boolean;
}

export function useOriginPosture(enabled = true): UseOriginPosture {
  const query = useQuery({
    queryKey: queryKeys.originPosture,
    queryFn: () => sdk.operator.pairing.posture.get(
      typeof window === 'undefined' ? undefined : window.location.origin,
    ),
    enabled,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
  return { posture: query.data?.posture, isLoading: query.isLoading };
}

/**
 * The daemon's own reason text for one browser-gated capability, or undefined when the
 * posture hasn't loaded yet, failed to load, or that capability IS available, callers
 * fall back to their own honest default copy in every one of those cases, never a blank
 * or a fabricated guess.
 */
export function capabilityReason(
  posture: OriginPosture | undefined,
  capability: 'service-worker' | 'push' | 'microphone',
): string | undefined {
  const entry = posture?.capabilities.find((c) => c.capability === capability);
  if (!entry || entry.available) return undefined;
  return entry.reason;
}

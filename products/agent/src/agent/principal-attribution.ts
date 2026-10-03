/**
 * principal-attribution.ts
 *
 * Shared "honest inbound attribution" helper. Anywhere the Agent displays who a
 * session or message came from, it should show the RESOLVED principal when the
 * sender's channel identity maps to one, and plainly say "unknown principal"
 * when it does not, never a blank field, never a guess.
 *
 * Resolution goes through the connected host's `principals.resolve` operator
 * method: POST /api/principals/resolve with `{ channel, value }`, returning
 * `{ principal, known }`. An unmapped identity resolves to `known: false`,
 * the registry never guesses, and neither does this helper.
 *
 * Every failure mode (empty channel identity, no connected-host token, a
 * failed/unreachable resolve call, or an explicit `known: false`) collapses to
 * the same human-facing label, `UNKNOWN_PRINCIPAL_LABEL`, so the display never
 * over-claims certainty about which failure occurred. Callers that want the
 * underlying detail can read the optional `error` field separately.
 */

import { createBrowserGoodVibesSdk } from '@goodvibes-jev/engine/sdk/browser';
import type { OperatorMethodInput } from '@goodvibes-jev/engine/sdk/contracts';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';

export const UNKNOWN_PRINCIPAL_LABEL = 'unknown principal';

export interface PrincipalAttributionConnection {
  readonly baseUrl: string;
  readonly token: string | null;
}

export interface ResolvedPrincipalSummary {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
}

export interface ResolvedPrincipalAttribution {
  readonly known: boolean;
  readonly label: string;
  readonly principal: ResolvedPrincipalSummary | null;
  /** Diagnostic detail only, never surfaced in `label` itself. */
  readonly error?: string;
}

type PrincipalsResolveInput = OperatorMethodInput<'principals.resolve'>;


const UNKNOWN_ATTRIBUTION: ResolvedPrincipalAttribution = {
  known: false,
  label: UNKNOWN_PRINCIPAL_LABEL,
  principal: null,
};

export function formatPrincipalLabel(principal: ResolvedPrincipalSummary): string {
  return `${principal.name} (${principal.id})`;
}

/**
 * Resolve a channel identity ({channel, value}) to its named principal for
 * honest inbound-attribution display.
 *
 * Never fabricates a name. Returns the shared "unknown principal" label
 * (never a blank string) when: the identity is empty, no connected-host
 * operator token is available, or the resolve call fails or returns
 * `known: false`.
 */
export async function resolveChannelPrincipalAttribution(
  connection: PrincipalAttributionConnection,
  channel: string,
  value: string,
): Promise<ResolvedPrincipalAttribution> {
  if (!channel.trim() || !value.trim()) return UNKNOWN_ATTRIBUTION;
  if (!connection.token) {
    return { ...UNKNOWN_ATTRIBUTION, error: 'No connected-host operator token available for principal resolution.' };
  }
  try {
    const sdk = createBrowserGoodVibesSdk({
      baseUrl: connection.baseUrl,
      authToken: connection.token,
      // A single attempt is enough for a display-only lookup, this must not
      // stall triage/inbox rendering behind retry backoff.
      retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    });
    const payload: PrincipalsResolveInput = { channel, value };
    // No `as OperatorMethodOutput<'principals.resolve'>` here: the SDK's typed
    // overload already returns it, so the assertion would be redundant, and a
    // redundant assertion is not free, because it keeps compiling if the
    // contract's output changes underneath it. That is how `as never` hid two
    // breaking input changes for two rounds.
    const result = await sdk.operator.invoke('principals.resolve', payload);
    if (!result.known || !result.principal) return UNKNOWN_ATTRIBUTION;
    const principal: ResolvedPrincipalSummary = {
      id: result.principal.id,
      name: result.principal.name,
      kind: result.principal.kind,
    };
    return { known: true, label: formatPrincipalLabel(principal), principal };
  } catch (error) {
    return { ...UNKNOWN_ATTRIBUTION, error: summarizeError(error) };
  }
}

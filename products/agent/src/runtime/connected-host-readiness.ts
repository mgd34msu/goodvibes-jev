import { createOperatorSdk } from '@goodvibes-jev/engine/operator-sdk';
import { resolveConnectedHostDialEnabled } from '@goodvibes-jev/engine/sdk/platform/config';
import { resolveConnectedHostConnection, type AgentDaemonVerbCallerOptions } from './client/daemon-verbs.ts';
import { isNativePairedPrincipal } from './native-paired-principal.ts';

export interface ConnectedHostReadiness {
  readonly status: 'ready' | 'disabled' | 'missing-credential' | 'unavailable' | 'unsupported-principal' | 'changed';
  readonly detail: string;
}

/** Fresh, read-only evidence for the exact host and effective credential used by native intake.
 * Never returns credentials, raw remote errors, or a durable authority claim.
 */
export async function readConnectedHostReadiness(options: AgentDaemonVerbCallerOptions): Promise<ConnectedHostReadiness> {
  if (!resolveConnectedHostDialEnabled(options.configManager)) {
    return { status: 'disabled', detail: 'Connected-host dialing is disabled; no auth probe was made.' };
  }
  const selected = resolveConnectedHostConnection(options);
  if ('reason' in selected) {
    return { status: 'missing-credential', detail: 'No effective connected-host credential is available for a live auth check.' };
  }
  let operator: ReturnType<typeof createOperatorSdk> | undefined;
  let result: ConnectedHostReadiness;
  try {
    operator = createOperatorSdk({ baseUrl: selected.baseUrl, authToken: selected.token, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
    const auth = await operator.invoke('control.auth.current', {}, { signal: AbortSignal.timeout(1500) });
    result = isNativePairedPrincipal(auth)
      ? { status: 'ready', detail: 'The selected host verified the current credential as a paired owner with native intake scopes.' }
      : { status: 'unsupported-principal', detail: 'The selected host did not verify a paired owner with read:work-ledger and write:work-ledger. A shared token is insufficient.' };
  } catch {
    result = { status: 'unavailable', detail: 'Live connected-host auth could not be verified. Rerun setup status after checking the selected host and credential.' };
  } finally { operator?.dispose(); }
  const current = resolveConnectedHostConnection(options);
  if ('reason' in current || current.baseUrl !== selected.baseUrl || current.token !== selected.token) {
    return { status: 'changed', detail: 'The selected host or effective credential changed during verification. Rerun setup status.' };
  }
  return result;
}

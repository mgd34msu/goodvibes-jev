import { captureNativeReadBindings, captureNativeReadRestrictions } from './read-restrictions.ts';
import { retainCliConfig } from '@goodvibes-jev/engine/terminal-shell';
import { canonicalizePairingHost } from './connected-host-pairing-store.ts';
import { resolveConnectedHostBaseUrl } from '../config/connected-host-dial.ts';
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
export async function readConnectedHostReadiness(options: AgentDaemonVerbCallerOptions, ownership: { readonly signal?: AbortSignal | undefined; readonly assertCurrent?: (() => void) | undefined } = {}): Promise<ConnectedHostReadiness> {
  const optionBindings = captureNativeReadBindings(options);
  const restrictions = captureNativeReadRestrictions(ownership);
  optionBindings(); restrictions();
  const retainedConfig = retainCliConfig(options.configManager);
  const originalSignal = ownership.signal;
  const assertCurrent = () => {
    optionBindings(); restrictions();
    retainedConfig.assertCurrent();
    optionBindings(); retainedConfig.assertCurrent(); restrictions();
  };
  assertCurrent();
  if (!resolveConnectedHostDialEnabled(options.configManager)) {
    return { status: 'disabled', detail: 'Connected-host dialing is disabled; no auth probe was made.' };
  }
  if (!canonicalizePairingHost(resolveConnectedHostBaseUrl(options.configManager))) return { status: 'unavailable', detail: 'The selected host URL is invalid; no auth probe was made.' };
  const selected = resolveConnectedHostConnection(options);
  if ('reason' in selected) {
    return { status: 'missing-credential', detail: 'No effective connected-host credential is available for a live auth check.' };
  }
  let operator: ReturnType<typeof createOperatorSdk> | undefined;
  let result: ConnectedHostReadiness;
  try {
    const nativeFetch = options.fetchImpl ?? fetch;
    const assertConnection = () => {
      assertCurrent();
      const current = resolveConnectedHostConnection(options);
      if ('reason' in current || current.baseUrl !== selected.baseUrl || current.token !== selected.token
        || current.selectionIdentity !== selected.selectionIdentity || current.expectedPrincipalId !== selected.expectedPrincipalId)
        throw new Error('Connected-host read source changed.');
    };
    const fetchImpl = Object.assign((...args: Parameters<typeof fetch>): ReturnType<typeof fetch> => {
      assertConnection();
      return nativeFetch(...args);
    }, { preconnect: nativeFetch.preconnect });
    assertConnection();
    operator = createOperatorSdk({ baseUrl: selected.baseUrl, authToken: selected.token, fetchImpl });
    const timeout = AbortSignal.timeout(1500);
    const auth = await operator.invoke('control.auth.current', {}, { signal: originalSignal ? AbortSignal.any([originalSignal, timeout]) : timeout });
    assertConnection();
    result = isNativePairedPrincipal(auth, selected.expectedPrincipalId)
      ? { status: 'ready', detail: 'The selected host verified the current credential as a paired owner with native intake scopes.' }
      : { status: 'unsupported-principal', detail: 'The selected host did not verify a paired owner with read:work-ledger and write:work-ledger. A shared token is insufficient.' };
  } catch {
    assertCurrent();
    result = { status: 'unavailable', detail: 'Live connected-host auth could not be verified. Rerun setup status after checking the selected host and credential.' };
  } finally { operator?.dispose(); }
  assertCurrent();
  const current = resolveConnectedHostConnection(options);
  if ('reason' in current || current.baseUrl !== selected.baseUrl || current.token !== selected.token
    || current.selectionIdentity !== selected.selectionIdentity || current.expectedPrincipalId !== selected.expectedPrincipalId) {
    return { status: 'changed', detail: 'The selected host or effective credential changed during verification. Rerun setup status.' };
  }
  return result;
}

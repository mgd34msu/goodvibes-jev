import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createOperatorSdk } from '@goodvibes-jev/engine/operator-sdk';
import { resolveConnectedHostDialEnabled } from '@goodvibes-jev/engine/sdk/platform/config';
import { resolveConnectedHostBaseUrl } from '../config/connected-host-dial.ts';
import { resolveConnectedHostConnection, type AgentDaemonVerbCallerOptions } from './client/daemon-verbs.ts';
import { readConnectedHostOperatorToken } from './connected-host-auth.ts';
import { isNativePairedPrincipal } from './native-paired-principal.ts';
import { beginAgentHostPairing, canonicalizePairingHost, completeAgentHostPairing, readAgentHostPairing } from './connected-host-pairing-store.ts';

export interface AgentHostPairingResult {
  readonly status: 'preview' | 'blocked' | 'already-paired' | 'cancelled' | 'changed' | 'unknown' | 'paired' | 'paired-unverified' | 'paired-shadowed';
  readonly message: string;
  readonly host?: string;
  readonly name?: string;
  readonly confirmation?: string;
  readonly scopeDisclosure?: string;
  readonly environmentOverride?: boolean;
}

export interface AgentHostPairingPreview {
  readonly result: AgentHostPairingResult;
  /** Only a live owner-terminal pairing controller may call this one-shot capability. */
  readonly confirm?: (answer: string, signal?: AbortSignal) => Promise<AgentHostPairingResult>;
}

const unavailable = (): AgentHostPairingResult => ({ status: 'blocked', message: 'Pairing could not be verified. Check the selected host and local credential store, then preview again.' });
const unknown = (host: string): AgentHostPairingResult => ({ status: 'unknown', host, message: 'A pairing attempt may already have created a credential. Its outcome must be reviewed on this host; no automatic remint or revoke is allowed.' });
const changed = (): AgentHostPairingResult => ({ status: 'changed', message: 'The selected host, effective credential or local pairing state changed. Preview again before confirming.' });
const cancelled = (): AgentHostPairingResult => ({ status: 'cancelled', message: 'Pairing cancelled before the migration request.' });
const envOverride = (): boolean => Boolean(process.env.GOODVIBES_CONNECTED_HOST_TOKEN?.trim() || process.env.GOODVIBES_DAEMON_TOKEN?.trim());
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function readPairingResponse(response: Response): Promise<unknown> {
  if (!response.body) return null;
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 16384) { await reader.cancel(); return null; }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

/** Preview is read-only. The returned one-shot capability binds the exact host,
 * source credential, name and store state to a fresh terminal confirmation.
 * No raw token, credential digest or remote error leaves this module.
 */
export async function previewAgentHostPairing(
  options: AgentDaemonVerbCallerOptions,
  name = 'GoodVibes Agent',
  signal?: AbortSignal,
): Promise<AgentHostPairingPreview> {
  try {
    if (signal?.aborted) return { result: cancelled() };
    if (!name.trim() || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) return { result: { status: 'blocked', message: 'Use a nonempty pairing name of at most 80 characters without control characters.' } };
    name = name.trim();
    if (!resolveConnectedHostDialEnabled(options.configManager)) return { result: { status: 'blocked', message: 'Connected-host dialing is disabled. No pairing request was made.' } };
    const home = typeof options.homeDirectory === 'function' ? options.homeDirectory() : options.homeDirectory;
    const host = canonicalizePairingHost(resolveConnectedHostBaseUrl(options.configManager));
    if (!host) return { result: unavailable() };
    const state = readAgentHostPairing(home, host);
    if (state.status === 'unknown') return { result: unknown(host) };
    if (state.status === 'unavailable') return { result: unavailable() };
    const selected = resolveConnectedHostConnection(options);
    if ('reason' in selected) return { result: unavailable() };
    const current = (): boolean => {
      const nowHome = typeof options.homeDirectory === 'function' ? options.homeDirectory() : options.homeDirectory;
      const now = resolveConnectedHostConnection(options);
      return nowHome === home && !('reason' in now) && now.baseUrl === selected.baseUrl && now.token === selected.token;
    };
    const authClient = createOperatorSdk({ baseUrl: host, authToken: selected.token, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
    let auth;
    try { auth = await authClient.invoke('control.auth.current', {}, { signal: AbortSignal.any([AbortSignal.timeout(1500), ...(signal ? [signal] : [])]) }); }
    finally { authClient.dispose(); }
    if (signal?.aborted) return { result: cancelled() };
    if (!current() || digest(readAgentHostPairing(home, host)) !== digest(state)) return { result: changed() };
    if (state.status === 'paired' || isNativePairedPrincipal(auth)) {
      return { result: { status: 'already-paired', host, message: 'An existing paired credential is present. This route will not mint or replace it; use setup status to verify the effective credential.' } };
    }
    if (!auth.authenticated || !auth.admin || auth.principalKind !== 'token' || auth.principalId !== 'shared-token'
      || !auth.scopes.some(scope => scope === '*' || scope === 'write:control-plane')) return { result: { status: 'blocked', host, message: 'Migration requires this host to verify the existing legacy shared operator token with write:control-plane. No credential was created.' } };
    const confirmation = `PAIR ${randomBytes(6).toString('hex')}`;
    const binding = digest([home, host, selected.token, name, state]);
    let consumed = false;
    const result: AgentHostPairingResult = {
      status: 'preview', host, name, confirmation, environmentOverride: envOverride(),
      scopeDisclosure: 'This creates a persistent administrative per-device credential on the selected GoodVibes host. It can exercise operator authority, including native work and fleet execution. The secret is stored only in this Agent home, bound to this host. The legacy shared token remains active; no credential is revoked.',
      message: 'Preview only. No credential has been created or stored. Confirm the exact phrase at the owner-terminal prompt to make one migration request.',
    };
    return { result, async confirm(answer, actionSignal) {
      if (consumed || answer !== confirmation || actionSignal?.aborted) return cancelled();
      consumed = true;
      let attempted = false;
      try {
        if (!current() || digest([home, host, selected.token, name, readAgentHostPairing(home, host)]) !== binding) return changed();
        // Authority can be revoked after preview without replacing the local token.
        const verifier = createOperatorSdk({ baseUrl: host, authToken: selected.token, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
        let live;
        try { live = await verifier.invoke('control.auth.current', {}, { signal: AbortSignal.any([AbortSignal.timeout(1500), ...(actionSignal ? [actionSignal] : [])]) }); }
        finally { verifier.dispose(); }
        if (actionSignal?.aborted) return cancelled();
        if (!current() || digest(readAgentHostPairing(home, host)) !== digest(state)) return changed();
        if (!live.authenticated || !live.admin || live.principalKind !== 'token' || live.principalId !== 'shared-token'
          || !live.scopes.some(scope => scope === '*' || scope === 'write:control-plane')) return changed();
        const attemptId = randomUUID();
        const begin = await beginAgentHostPairing(home, host, { attemptId, name, startedAt: Date.now() });
        if (begin.status !== 'begun') return begin.status === 'conflict' ? changed() : unavailable();
        // Once the durable marker exists, every interruption is conservatively
        // unknown until an exact successful response is safely stored.
        attempted = true;
        const bootstrap = readConnectedHostOperatorToken(home);
        const nowHome = typeof options.homeDirectory === 'function' ? options.homeDirectory() : options.homeDirectory;
        if (actionSignal?.aborted || nowHome !== home || !resolveConnectedHostDialEnabled(options.configManager)
          || canonicalizePairingHost(resolveConnectedHostBaseUrl(options.configManager)) !== host || bootstrap.token !== selected.token) return unknown(host);
        const fetchImpl = options.fetchImpl ?? fetch;
        const response = await fetchImpl(`${host}/api/control-plane/methods/pairing.tokens.migrate/invoke`, {
          method: 'POST', redirect: 'error',
          headers: { authorization: `Bearer ${selected.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ body: { name } }),
          signal: AbortSignal.any([AbortSignal.timeout(5000), ...(actionSignal ? [actionSignal] : [])]),
        });
        if (!response.ok) return unknown(host);
        const payload = await readPairingResponse(response);
        const minted = payload && typeof payload === 'object' && 'token' in payload ? payload.token : null;
        if (!minted || typeof minted !== 'object' || !('id' in minted) || typeof minted.id !== 'string' || !/^pair-[0-9a-f-]{36}$/i.test(minted.id)
          || !('token' in minted) || typeof minted.token !== 'string' || !/^gvp_[A-Za-z0-9_-]{32}$/.test(minted.token)
          || !('name' in minted) || minted.name !== name || !('createdAt' in minted) || typeof minted.createdAt !== 'number' || !Number.isFinite(minted.createdAt)) return unknown(host);
        const complete = await completeAgentHostPairing(home, host, attemptId, { token: minted.token, tokenId: minted.id, name, createdAt: minted.createdAt });
        if (complete.status !== 'paired') return unknown(host);
        // Persist before verifying: a lost verification reply must never lose
        // the only copy of the newly issued credential or cause another mint.
        if (actionSignal?.aborted) return { status: 'paired-unverified', host, message: 'Pairing credential stored for this host. Verification was interrupted; rerun setup status. No second credential will be created.' };
        const pairedClient = createOperatorSdk({ baseUrl: host, authToken: minted.token, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
        let pairedAuth;
        try { pairedAuth = await pairedClient.invoke('control.auth.current', {}, { signal: AbortSignal.any([AbortSignal.timeout(1500), ...(actionSignal ? [actionSignal] : [])]) }); }
        catch { return { status: 'paired-unverified', host, message: 'Pairing credential stored for this host, but live verification failed. Rerun setup status; do not remint.' }; }
        finally { pairedClient.dispose(); }
        if (!isNativePairedPrincipal(pairedAuth) || pairedAuth.principalId !== `pairing:${minted.id}`) return { status: 'paired-unverified', host, message: 'Pairing credential stored, but this host did not verify its expected native principal. Inspect the host; do not remint.' };
        const finalHome = typeof options.homeDirectory === 'function' ? options.homeDirectory() : options.homeDirectory;
        if (finalHome !== home || !resolveConnectedHostDialEnabled(options.configManager)
          || canonicalizePairingHost(resolveConnectedHostBaseUrl(options.configManager)) !== host
          || (envOverride() && readConnectedHostOperatorToken(home).token !== selected.token)) return { status: 'paired-unverified', host, message: 'Pairing credential stored for the original host. Current host, home, dialing or environment credential changed; preview setup status again.' };
        if (envOverride()) return { status: 'paired-shadowed', host, message: 'Pairing credential stored for this host. An environment token still takes precedence. Review that override before rerunning setup status; no environment variable was changed.' };
        const effective = resolveConnectedHostConnection(options);
        if ('reason' in effective || canonicalizePairingHost(effective.baseUrl) !== host || effective.token !== minted.token) return { status: 'paired-unverified', host, message: 'Pairing credential stored for the original host. Current configuration or authority is unverified; rerun setup status before native work.' };
        return { status: 'paired', host, message: 'Agent pairing is stored and the selected host verified native intake authority. Provider, workspace, Jev and execution readiness remain separate checks.' };
      } catch { return attempted ? unknown(host) : actionSignal?.aborted ? cancelled() : unavailable(); }
    } };
  } catch { return { result: signal?.aborted ? cancelled() : unavailable() }; }
}

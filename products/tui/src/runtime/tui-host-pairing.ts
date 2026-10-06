import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createOperatorSdk } from '@goodvibes-jev/engine/operator-sdk';
import type { OperatorMethodOutput } from '@goodvibes-jev/engine/sdk/contracts';
import { resolveDaemonEnabled } from '@goodvibes-jev/engine/sdk/platform/config';
import { resolveNativeHostCredential, resolveTuiHostOrigin, type NativeHostCredentialOptions } from './client/native-host-credential.ts';
import { readTuiLegacyPairingBootstrap } from './tui-host-pairing-bootstrap.ts';
import { beginTuiHostPairing, completeTuiHostPairing, readTuiHostPairing } from './tui-host-credential-store.ts';

export interface TuiHostPairingResult {
  readonly status: 'preview' | 'blocked' | 'already-paired' | 'cancelled' | 'changed' | 'unknown' | 'paired' | 'paired-unverified';
  readonly message: string;
  readonly host?: string;
  readonly name?: string;
  readonly confirmation?: string;
  readonly scopeDisclosure?: string;
}
export interface TuiHostPairingPreview {
  readonly result: TuiHostPairingResult;
  /** Only the standalone or interactive owner-terminal prompt calls this one-shot capability. */
  readonly confirm?: (answer: string, signal?: AbortSignal) => Promise<TuiHostPairingResult>;
}
export interface TuiHostPairingOptions extends NativeHostCredentialOptions {
  /** Explicit opt-in, never inferred from missing native credentials. */
  readonly bootstrapShared?: boolean;
  readonly fetchImpl?: typeof fetch;
}
const unavailable = (): TuiHostPairingResult => ({ status: 'blocked', message: 'Pairing could not be verified. Check the selected host and safe local credential store, then preview again.' });
const unknown = (host: string): TuiHostPairingResult => ({ status: 'unknown', host, message: 'A pairing attempt may already have created a credential. Review its outcome on this host; no automatic remint, reset or revoke is allowed.' });
const changed = (): TuiHostPairingResult => ({ status: 'changed', message: 'The selected host, home, bootstrap credential, authority or local pairing state changed. Preview again before confirming.' });
const cancelled = (): TuiHostPairingResult => ({ status: 'cancelled', message: 'Pairing cancelled before the migration request.' });
const unverified = (host: string): TuiHostPairingResult => ({ status: 'paired-unverified', host, message: 'The credential is saved for its original host, but current native authority is unverified. Inspect goodvibes host pair again; do not remint.' });
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isBootstrap = (auth: OperatorMethodOutput<'control.auth.current'>) => auth.authenticated && auth.admin && auth.principalKind === 'token'
  && auth.principalId === 'shared-token' && auth.scopes.some(scope => scope === '*' || scope === 'write:control-plane');
const isNative = (auth: OperatorMethodOutput<'control.auth.current'>, id: string) => auth.authenticated && auth.admin && auth.principalKind === 'token'
  && auth.principalId === `pairing:${id}` && ['read:work-ledger', 'write:work-ledger'].every(scope => auth.scopes.includes('*') || auth.scopes.includes(scope));
async function readPairingResponse(response: Response): Promise<unknown> {
  if (!response.body) return null;
  const reader = response.body.getReader(); const bytes = new Uint8Array(16_384); let size = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      if (size + chunk.value.byteLength > bytes.length) { await reader.cancel(); return null; }
      bytes.set(chunk.value, size); size += chunk.value.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
  } finally { reader.releaseLock(); }
}

/** Read-only preview. Source credentials are used only after explicit bootstrap
 * selection; no generic command, startup or native operation can confirm a migration.
 * The interactive shell holds its capability privately across the owner gesture. Secrets and remote errors never enter presentation data.
 */
export async function previewTuiHostPairing(options: TuiHostPairingOptions, name = 'GoodVibes TUI', signal?: AbortSignal): Promise<TuiHostPairingPreview> {
  try {
    if (signal?.aborted) return { result: cancelled() };
    if (!name.trim() || name.length > 80 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(name)) return { result: { status: 'blocked', message: 'Use a nonempty device name of at most 80 characters without control characters.' } };
    name = name.trim();
    const homeNow = () => typeof options.homeDirectory === 'function' ? options.homeDirectory() : options.homeDirectory;
    const home = homeNow(); const host = resolveTuiHostOrigin(options.configManager);
    if (!host || !resolveDaemonEnabled(options.configManager)) return { result: unavailable() };
    const state = readTuiHostPairing(home, host);
    if (state.status === 'unknown') return { result: unknown(host) };
    if (state.status === 'unavailable') return { result: unavailable() };
    const sameSelection = () => homeNow() === home && resolveDaemonEnabled(options.configManager) && resolveTuiHostOrigin(options.configManager) === host;
    const auth = async (token: string, requestSignal?: AbortSignal, sourceCurrent: () => boolean = sameSelection) => {
      const expectedState = digest(readTuiHostPairing(home, host));
      const client = createOperatorSdk({ baseUrl: host, authToken: token, fetchImpl: (input, init) => {
        // SDK setup and retries may await before dispatch. Recheck at the real
        // network boundary so a stale selection cannot send even a read.
        if (requestSignal?.aborted || !sourceCurrent() || !sameSelection() || digest(readTuiHostPairing(home, host)) !== expectedState) throw new Error('Pairing selection changed');
        return (options.fetchImpl ?? fetch)(input, { ...init, redirect: 'error' });
      } });
      try { return await client.invoke('control.auth.current', {}, { signal: AbortSignal.any([AbortSignal.timeout(1500), ...(requestSignal ? [requestSignal] : [])]) }); }
      finally { client.dispose(); }
    };
    if (state.status === 'paired') {
      try {
        const live = await auth(state.token, signal);
        if (signal?.aborted || !sameSelection() || digest(readTuiHostPairing(home, host)) !== digest(state) || !isNative(live, state.tokenId)) return { result: unverified(host) };
        return { result: { status: 'already-paired', host, message: 'This TUI host credential is saved and its expected native principal is verified. No credential will be minted or replaced.' } };
      } catch { return { result: unverified(host) }; }
    }
    if (!options.bootstrapShared) return { result: { status: 'blocked', host, message: 'No TUI credential is bound to this origin. Explicitly select --bootstrap-shared to use the existing daemon-global token for this one-shot migration. Native work never uses that token as a fallback.' } };
    const token = readTuiLegacyPairingBootstrap(home);
    if (!token) return { result: { status: 'blocked', host, message: 'The selected legacy bootstrap is missing or unsafe. It must be an owned, private regular daemon operator-tokens.json file; this command never creates or repairs it.' } };
    const current = () => sameSelection() && readTuiLegacyPairingBootstrap(home) === token;
    const live = await auth(token, signal, current);
    if (signal?.aborted) return { result: cancelled() };
    if (!current() || digest(readTuiHostPairing(home, host)) !== digest(state)) return { result: changed() };
    if (!isBootstrap(live)) return { result: { status: 'blocked', host, message: 'This host must verify the explicitly selected bootstrap as its legacy shared operator token with write:control-plane. No credential was created.' } };
    const confirmation = `PAIR ${randomBytes(6).toString('hex')}`;
    const binding = digest([home, host, token, name, state]); let consumed = false;
    return { result: {
      status: 'preview', host, name, confirmation,
      scopeDisclosure: 'This creates a persistent administrative per-device credential on the displayed GoodVibes host, including native work and fleet execution authority. The bootstrap is the existing daemon-global operator token. The new secret is stored only in this TUI home, bound to this exact origin. The shared token remains active; nothing is revoked.',
      message: 'Preview only. Confirm the fresh phrase in this owner terminal to make one migration request.',
    }, async confirm(answer, actionSignal) {
      if (consumed) return cancelled(); consumed = true;
      if (answer !== confirmation || actionSignal?.aborted) return cancelled();
      let attempted = false;
      try {
        if (!current() || digest([home, host, token, name, readTuiHostPairing(home, host)]) !== binding) return changed();
        const revalidated = await auth(token, actionSignal, current);
        if (actionSignal?.aborted) return cancelled();
        if (!current() || digest(readTuiHostPairing(home, host)) !== digest(state) || !isBootstrap(revalidated)) return changed();
        const attemptId = randomUUID();
        const begin = await beginTuiHostPairing(home, host, { attemptId, name, startedAt: Date.now() }, {}, () => !actionSignal?.aborted && current());
        if (begin.status !== 'begun') return begin.status === 'cancelled' ? actionSignal?.aborted ? cancelled() : changed() : begin.status === 'conflict' ? changed() : unavailable();
        attempted = true;
        // Durable uncertainty precedes the only request. Cancellation never clears it.
        const pending = readTuiHostPairing(home, host);
        if (actionSignal?.aborted || !current() || pending.status !== 'unknown' || pending.attemptId !== attemptId || pending.name !== name) return unknown(host);
        const response = await (options.fetchImpl ?? fetch)(`${host}/api/control-plane/methods/pairing.tokens.migrate/invoke`, {
          method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ body: { name } }), signal: AbortSignal.any([AbortSignal.timeout(5000), ...(actionSignal ? [actionSignal] : [])]),
        });
        if (!response.ok) return unknown(host);
        const payload = await readPairingResponse(response);
        const minted = payload && typeof payload === 'object' && 'token' in payload ? payload.token : null;
        if (!minted || typeof minted !== 'object' || !('id' in minted) || typeof minted.id !== 'string' || !/^pair-[0-9a-f-]{36}$/i.test(minted.id)
          || !('token' in minted) || typeof minted.token !== 'string' || !/^gvp_[A-Za-z0-9_-]{32}$/.test(minted.token)
          || !('name' in minted) || minted.name !== name || !('createdAt' in minted) || typeof minted.createdAt !== 'number' || !Number.isSafeInteger(minted.createdAt) || minted.createdAt <= 0) return unknown(host);
        const complete = await completeTuiHostPairing(home, host, attemptId, { token: minted.token, tokenId: minted.id, name, createdAt: minted.createdAt });
        if (complete.status !== 'paired') return unknown(host);
        // Save the only copy before verification. Late responses may preserve the
        // original host's recovery state, never create a replacement or revoke it.
        if (actionSignal?.aborted || !sameSelection()) return unverified(host);
        let verified;
        try { verified = await auth(minted.token, actionSignal); } catch { return unverified(host); }
        const effective = resolveNativeHostCredential(options);
        if (actionSignal?.aborted || !sameSelection() || !isNative(verified, minted.id) || !effective.available || effective.baseUrl !== host || effective.token !== minted.token) return unverified(host);
        return { status: 'paired', host, message: 'TUI pairing is saved and the selected host verified its native authority. Provider, workspace, Jev and execution readiness remain separate checks.' };
      } catch { return attempted ? unknown(host) : actionSignal?.aborted ? cancelled() : unavailable(); }
    } };
  } catch { return { result: signal?.aborted ? cancelled() : unavailable() }; }
}

export function formatTuiHostPairing(result: TuiHostPairingResult): string {
  return [`TUI host pairing: ${result.status}`, ...(result.host ? [`  Host: ${result.host}`] : []), ...(result.name ? [`  Device name: ${result.name}`] : []),
    ...(result.scopeDisclosure ? [`  Access: ${result.scopeDisclosure}`] : []), `  ${result.message}`].join('\n');
}

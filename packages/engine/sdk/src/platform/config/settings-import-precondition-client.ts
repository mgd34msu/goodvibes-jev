import type { SettingsImportPreconditionRequest, SettingsImportPreconditionFacts, SettingsImportPreconditionReceipt } from '@goodvibes-jev/engine/daemon-sdk';
import { types as nodeTypes } from 'node:util';
import { captureStrictJudgmentJson } from '../gate/judgment-result.js';
import { snapshotJudgmentInput } from '../gate/judgment-input.js';
import { daemonSecretKeyFor } from './daemon-secret-keys.js';
import { isDaemonOwnedConfigKey } from './config-ownership.js';
import { isSecretBearingConfigKey } from './secret-bearing-config-keys.js';
import { isSecretRefInput } from './secret-refs.js';
import type { DaemonConfigEndpoint, DaemonConfigRouterDeps } from './daemon-config-route.js';

export type { SettingsImportPreconditionRequest, SettingsImportPreconditionReceipt };
declare const remoteImportBrand: unique symbol;
export interface RemoteSettingsImportPrecondition { readonly [remoteImportBrand]: true; }
export interface RemoteSettingsImportPreconditionFacts extends SettingsImportPreconditionFacts {
  readonly endpoint: string;
  readonly expiresAt: number;
}
export interface RemoteSettingsImportRestriction { readonly signal?: AbortSignal; readonly assertCurrent?: () => void; }
interface Entry {
  readonly facts: RemoteSettingsImportPreconditionFacts;
  readonly reference: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly fetchImpl: typeof fetch;
  readonly timeoutMs: number;
  readonly expiresAt: number;
  readonly restriction: RemoteSettingsImportRestriction;
  phase: 'ready' | 'pending' | 'completed';
  receipt?: SettingsImportPreconditionReceipt;
}
const entries = new WeakMap<RemoteSettingsImportPrecondition, Entry>();
function unavailable(): Error { return new Error('Settings import owner unavailable; fresh capture and admission required.'); }
function assertSynchronous(check: (() => void) | undefined): void {
  if (!check) return;
  const result: unknown = Reflect.apply(check, undefined, []);
  if (result === undefined) return;
  if (nodeTypes.isPromise(result)) Reflect.apply(Promise.prototype.then, result, [undefined, () => {}]);
  throw unavailable();
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const fields = Object.keys(value); return fields.length === keys.length && fields.every(key => keys.includes(key));
}
function endpointUrl(endpoint: DaemonConfigEndpoint): string {
  const url = new URL(endpoint.baseUrl);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw unavailable();
  return url.href.replace(/\/+$/, '');
}
function destination(value: unknown): boolean {
  return record(value) && exact(value, ['path', 'operation', 'tier']) && typeof value.path === 'string' && value.path.length > 0
    && ['set', 'remove'].includes(String(value.operation)) && typeof value.tier === 'string' && value.tier.length > 0;
}
function expectedSetting(key: string, value: unknown): { value: unknown; credential?: { key: string; scope: 'daemon'; configured: boolean } } {
  if (!isSecretBearingConfigKey(key)) return { value };
  if (typeof value !== 'string') throw unavailable();
  const trimmed = value.trim(), secretKey = daemonSecretKeyFor(key);
  if (trimmed.startsWith('goodvibes://secrets/') && isSecretRefInput(trimmed)) return { value: trimmed };
  if (trimmed.startsWith('goodvibes://')) throw unavailable();
  return { value: trimmed ? `goodvibes://secrets/goodvibes/${encodeURIComponent(secretKey)}` : '',
    credential: { key: secretKey, scope: 'daemon', configured: !!trimmed } };
}
function validateFacts(value: unknown, request: SettingsImportPreconditionRequest): SettingsImportPreconditionFacts {
  if (!record(value) || !exact(value, ['operation', 'effects', 'incarnation', 'destinations', ...(Object.hasOwn(value, 'credential') ? ['credential'] : [])])
    || value.operation !== 'import' || !Number.isSafeInteger(value.incarnation) || Number(value.incarnation) < 0
    || !Array.isArray(value.effects) || value.effects.length !== request.settings.length || !Array.isArray(value.destinations)
    || !value.destinations.length || !value.destinations.every(destination)) throw unavailable();
  const expectedCredentials: { key: string; scope: 'daemon'; configured: boolean }[] = [];
  const effectDestinations: unknown[] = [];
  for (const [index, setting] of request.settings.entries()) {
    const effect = value.effects[index], expected = expectedSetting(setting.key, setting.value);
    if (!record(effect) || !exact(effect, ['operation', 'key', 'value', 'destinations']) || effect.operation !== 'set' || effect.key !== setting.key
      || JSON.stringify(effect.value) !== JSON.stringify(expected.value) || !Array.isArray(effect.destinations) || !effect.destinations.length
      || !effect.destinations.every(item => destination(item) && record(item) && item.operation === 'set'
        && ['global', 'project', 'daemon', 'shared'].includes(String(item.tier)))) throw unavailable();
    effectDestinations.push(...effect.destinations);
    if (expected.credential) expectedCredentials.push(expected.credential);
  }
  let credentialDestinations: unknown[] = [];
  if (expectedCredentials.length) {
    const credential = value.credential;
    if (!record(credential) || !exact(credential, ['items', 'destinations']) || !Array.isArray(credential.items)
      || credential.items.length !== expectedCredentials.length || !credential.items.every((item, index) => record(item)
        && exact(item, ['key', 'scope', 'configured']) && item.key === expectedCredentials[index]!.key
        && item.scope === 'daemon' && item.configured === expectedCredentials[index]!.configured)
      || !Array.isArray(credential.destinations) || !credential.destinations.every(item => destination(item) && record(item)
        && item.operation === 'set' && ['daemon', 'keyfile'].includes(String(item.tier)))) throw unavailable();
    credentialDestinations = credential.destinations;
  } else if (Object.hasOwn(value, 'credential')) throw unavailable();
  if (JSON.stringify(value.destinations) !== JSON.stringify([...credentialDestinations, ...effectDestinations])) throw unavailable();
  // Original complete value-safe facts pass the protected-input boundary before any hosted judgment.
  return snapshotJudgmentInput(value, 'goodvibes_settings') as unknown as SettingsImportPreconditionFacts;
}
function assertSource(entry: Entry): void {
  entry.restriction.signal?.throwIfAborted(); assertSynchronous(entry.restriction.assertCurrent);
  if (entry.expiresAt <= Date.now()) throw unavailable();
}
function wireSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs); return signal ? AbortSignal.any([timeout, signal]) : timeout;
}
/** Private authenticated capture: raw imported values never enter a judgment request. */
export async function captureRemoteSettingsImportPrecondition(endpoint: DaemonConfigEndpoint, request: SettingsImportPreconditionRequest,
  deps: Pick<DaemonConfigRouterDeps, 'fetchImpl' | 'timeoutMs'> & RemoteSettingsImportRestriction = {}): Promise<RemoteSettingsImportPrecondition> {
  try {
    deps.signal?.throwIfAborted(); assertSynchronous(deps.assertCurrent);
    const input = captureStrictJudgmentJson(request, unavailable);
    if (!record(input) || !exact(input, ['settings']) || !Array.isArray(input.settings) || !input.settings.length
      || !input.settings.every(setting => record(setting) && exact(setting, ['key', 'value']) && typeof setting.key === 'string'
        && isDaemonOwnedConfigKey(setting.key)) || new Set(input.settings.map(setting => setting.key)).size !== input.settings.length) throw unavailable();
    for (const setting of input.settings) expectedSetting(setting.key, setting.value);
    const base = endpointUrl(endpoint), fetchImpl = deps.fetchImpl ?? globalThis.fetch, timeoutMs = deps.timeoutMs ?? 10_000;
    const headers = Object.freeze({ 'content-type': 'application/json', ...(endpoint.token ? { authorization: `Bearer ${endpoint.token}` } : {}) });
    const localExpiresAt = Date.now() + 300_000;
    deps.signal?.throwIfAborted(); assertSynchronous(deps.assertCurrent);
    const response = await fetchImpl(`${base}/config`, { method: 'POST', headers, redirect: 'error',
      body: JSON.stringify({ settingsImportPrecondition: { version: 1, action: 'capture', settings: input.settings } }), signal: wireSignal(timeoutMs, deps.signal) });
    if (!response.ok || response.redirected) throw unavailable();
    const payload: unknown = await response.json();
    if (!record(payload) || !exact(payload, ['settingsImportPrecondition']) || !record(payload.settingsImportPrecondition)) throw unavailable();
    const arm = payload.settingsImportPrecondition;
    if (!exact(arm, ['version', 'action', 'reference', 'expiresAt', 'facts']) || arm.version !== 1 || arm.action !== 'captured'
      || typeof arm.reference !== 'string' || !arm.reference || arm.reference.length > 128 || !Number.isSafeInteger(arm.expiresAt)
      || Number(arm.expiresAt) <= Date.now()) throw unavailable();
    const facts = captureStrictJudgmentJson({ ...validateFacts(arm.facts, input), endpoint: base, expiresAt: Number(arm.expiresAt) }, unavailable);
    const entry: Entry = { facts, reference: arm.reference, url: `${base}/config`, headers, fetchImpl, timeoutMs,
      expiresAt: Math.min(localExpiresAt, Number(arm.expiresAt)), restriction: Object.freeze({ ...(deps.signal ? { signal: deps.signal } : {}),
        ...(deps.assertCurrent ? { assertCurrent: deps.assertCurrent } : {}) }), phase: 'ready' };
    assertSource(entry);
    const handle = Object.freeze({}) as RemoteSettingsImportPrecondition; entries.set(handle, entry); return handle;
  } catch { throw unavailable(); }
}
export function inspectRemoteSettingsImportPrecondition(handle: RemoteSettingsImportPrecondition): RemoteSettingsImportPreconditionFacts {
  const entry = entries.get(handle); if (!entry) throw unavailable(); return entry.facts;
}
export function assertRemoteSettingsImportPrecondition(handle: RemoteSettingsImportPrecondition): void {
  const entry = entries.get(handle); if (!entry || entry.phase !== 'ready') throw unavailable(); assertSource(entry);
}
function validateReceipt(value: unknown, facts: RemoteSettingsImportPreconditionFacts): SettingsImportPreconditionReceipt {
  if (!record(value) || !exact(value, ['status', 'completedPaths', ...(Object.hasOwn(value, 'uncertainPath') ? ['uncertainPath'] : []),
    ...(Object.hasOwn(value, 'verifiedInOwningStore') ? ['verifiedInOwningStore'] : [])]) || !['committed', 'partial', 'unknown'].includes(String(value.status))
    || !Array.isArray(value.completedPaths)) throw unavailable();
  const paths = facts.destinations.map(item => item.path), completed = value.completedPaths;
  if (completed.length > paths.length || !completed.every((path, index) => path === paths[index])) throw unavailable();
  if (value.status === 'committed') {
    if (completed.length !== paths.length || value.uncertainPath !== undefined || typeof value.verifiedInOwningStore !== 'boolean') throw unavailable();
  } else {
    if (Object.hasOwn(value, 'verifiedInOwningStore') || value.status === 'partial' && (!completed.length || completed.length >= paths.length
      || value.uncertainPath !== paths[completed.length]) || value.status === 'unknown' && (completed.length
      || value.uncertainPath !== undefined && value.uncertainPath !== paths[0])) throw unavailable();
  }
  return captureStrictJudgmentJson(value, unavailable) as unknown as SettingsImportPreconditionReceipt;
}
export async function applyRemoteSettingsImportPrecondition(handle: RemoteSettingsImportPrecondition,
  restriction: RemoteSettingsImportRestriction = {}): Promise<SettingsImportPreconditionReceipt> {
  assertRemoteSettingsImportPrecondition(handle); restriction.signal?.throwIfAborted(); assertSynchronous(restriction.assertCurrent);
  const entry = entries.get(handle)!;
  entry.phase = 'pending';
  const unknown: SettingsImportPreconditionReceipt = Object.freeze({ status: 'unknown', completedPaths: Object.freeze([]) });
  try {
    assertSource(entry); restriction.signal?.throwIfAborted(); assertSynchronous(restriction.assertCurrent);
    const response = await entry.fetchImpl(entry.url, { method: 'POST', headers: entry.headers, redirect: 'error',
      body: JSON.stringify({ settingsImportPrecondition: { version: 1, action: 'apply', reference: entry.reference } }),
      signal: wireSignal(entry.timeoutMs, restriction.signal ? (entry.restriction.signal ? AbortSignal.any([restriction.signal, entry.restriction.signal]) : restriction.signal) : entry.restriction.signal) });
    if (!response.ok || response.redirected) return unknown;
    const payload: unknown = await response.json();
    if (!record(payload) || !exact(payload, ['settingsImportPrecondition']) || !record(payload.settingsImportPrecondition)) return unknown;
    const arm = payload.settingsImportPrecondition;
    if (!exact(arm, ['version', 'action', 'reference', 'receipt']) || arm.version !== 1 || arm.action !== 'applied' || arm.reference !== entry.reference) return unknown;
    // Preserve the actual validated receipt even if cancellation or source retirement follows the write.
    entry.receipt = validateReceipt(arm.receipt, entry.facts); entry.phase = 'completed';
    try { assertSource(entry); restriction.signal?.throwIfAborted(); assertSynchronous(restriction.assertCurrent); } catch { /* Completed assertion stops the tail. */ }
    return entry.receipt;
  } catch { return entry.receipt ?? unknown; }
}
export function assertCompletedRemoteSettingsImportPrecondition(handle: RemoteSettingsImportPrecondition): void {
  const entry = entries.get(handle);
  if (!entry || entry.phase !== 'completed' || entry.receipt?.status !== 'committed' || entry.receipt.verifiedInOwningStore !== true) throw unavailable();
  assertSource(entry);
}

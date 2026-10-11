/** Adopted SETTINGS transport. References are owner preconditions, not grants. */
import { readFileSync, statSync } from 'node:fs';
import { daemonSecretKeyFor } from './daemon-secret-keys.js';
import { isSecretBearingConfigKey } from './secret-bearing-config-keys.js';
import { configKeyScope, describeConfigOwnership } from './config-ownership.js';
import { deriveControlPlaneBaseUrl } from './control-plane-base-url.js';
import { detachedDaemonProcessAlive, detachedDaemonRuntimePath, type DetachedDaemonRuntimeHint } from '../runtime/detached-daemon-runtime.js';
import type { ConfigWriteRoute, DaemonConfigEndpoint, DaemonConfigRouterDeps } from './daemon-config-route.js';
import { snapshotJudgmentInput } from '../gate/judgment-input.js';
import type { SettingsPreconditionFacts, SettingsPreconditionReceipt, SettingsPreconditionRequest } from '@goodvibes-jev/engine/daemon-sdk';

export type { SettingsPreconditionRequest, SettingsPreconditionReceipt };
declare const remoteBrand: unique symbol;
export interface RemoteSettingsPrecondition { readonly [remoteBrand]: true; }
export interface RemoteSettingsPreconditionFacts extends SettingsPreconditionFacts {
  readonly endpoint: string;
  readonly expiresAt: number;
}
interface Entry {
  readonly facts: RemoteSettingsPreconditionFacts;
  readonly reference: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly fetchImpl: typeof fetch;
  readonly timeoutMs: number;
  readonly localExpiresAt: number;
  readonly assertCurrent?: () => void;
  spent: boolean;
}
const entries = new WeakMap<RemoteSettingsPrecondition, Entry>();
function unavailable(): Error { return new Error('Settings owner precondition unavailable; fresh capture and admission required.'); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exact(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const keys = Object.keys(value); return keys.length === fields.length && keys.every(key => fields.includes(key));
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function baseUrl(endpoint: DaemonConfigEndpoint): string {
  let url: URL;
  try { url = new URL(endpoint.baseUrl); } catch { throw unavailable(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw unavailable();
  return url.href.replace(/\/+$/, '');
}
function headers(endpoint: DaemonConfigEndpoint): Readonly<Record<string, string>> {
  return Object.freeze({ 'content-type': 'application/json', ...(endpoint.token ? { authorization: `Bearer ${endpoint.token}` } : {}) });
}
interface RuntimeObservation { readonly value: DetachedDaemonRuntimeHint | null; readonly stamp: string; }
function readRecord(dir: string): RuntimeObservation {
  let raw: string; let stamp: string;
  const path = detachedDaemonRuntimePath(dir);
  try {
    const before = statSync(path, { bigint: true });
    raw = readFileSync(path, 'utf8');
    const after = statSync(path, { bigint: true });
    const identity = (s: typeof before) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':');
    if (identity(before) !== identity(after)) throw unavailable();
    stamp = `${identity(after)}:${raw}`; // Private equality only, never logged or hashed.
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { value: null, stamp: 'absent' }; throw unavailable(); }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!record(parsed) || typeof parsed.host !== 'string' || !Number.isInteger(parsed.port) || Number(parsed.port) < 1 || Number(parsed.port) > 65535
      || (parsed.pid !== undefined && (!Number.isInteger(parsed.pid) || Number(parsed.pid) < 1))) throw unavailable();
    return { value: { host: parsed.host, port: Number(parsed.port), ...(parsed.pid === undefined ? {} : { pid: Number(parsed.pid) }) }, stamp };
  } catch { throw unavailable(); }
}
const routeChecks = new WeakMap<ConfigWriteRoute, () => void>();
/** Exact returned observation only; copying a route never copies its binding. */
export function assertPreparedConfigWriteRoute(route: ConfigWriteRoute): void {
  const check = routeChecks.get(route); if (!check) throw unavailable(); check();
}
/** Non-mutating discovery. No quarantine, stale record reaping or receipt writes. */
export async function resolvePreparedConfigWriteRoute(key: string, deps: DaemonConfigRouterDeps, assertOwner?: () => void): Promise<ConfigWriteRoute> {
  assertOwner?.();
  const scope = configKeyScope(key);
  const reason = describeConfigOwnership(key);
  const hostsDaemon = deps.hostsDaemon;
  const configured = deps.endpoint ? { ...deps.endpoint } : null;
  const directory = deps.daemonHomeDir;
  const token = deps.token;
  const readRuntime = deps.readRuntimeRecord;
  const readBinding = deps.readDaemonBinding;
  const isProcessAlive = deps.isProcessAlive;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const timeoutMs = deps.probeTimeoutMs ?? 2_000;
  // Local client ownership and an explicit remote endpoint never need a disk
  // observation. For absent-daemon routing, record arrival retires the capture.
  const discover = scope === 'daemon' && !hostsDaemon && !configured?.baseUrl.trim() && !!directory;
  const observeRuntime = (): RuntimeObservation => {
    if (!discover) return { value: null, stamp: '' };
    if (!readRuntime) return readRecord(directory!);
    const value = readRuntime(directory!);
    const copy = value ? { ...value } : null;
    return { value: copy, stamp: JSON.stringify(copy) };
  };
  const runtimeObservation = observeRuntime();
  const binding = discover ? readBinding?.() : null;
  const bindingSnapshot = binding ? { ...binding } : null;
  const bindingStamp = JSON.stringify(bindingSnapshot);
  const configuredStamp = JSON.stringify(configured);
  const finish = (route: ConfigWriteRoute): ConfigWriteRoute => {
    const check = () => {
      assertOwner?.();
      if (deps.hostsDaemon !== hostsDaemon || deps.daemonHomeDir !== directory || deps.token !== token
        || deps.readRuntimeRecord !== readRuntime || deps.readDaemonBinding !== readBinding || deps.isProcessAlive !== isProcessAlive
        || (deps.fetchImpl ?? globalThis.fetch) !== fetchImpl || JSON.stringify(deps.endpoint ? { ...deps.endpoint } : null) !== configuredStamp
        || observeRuntime().stamp !== runtimeObservation.stamp
        || (discover && JSON.stringify(readBinding?.() ?? null) !== bindingStamp)) throw unavailable();
      assertOwner?.();
    };
    check(); // A routing change during a probe cannot be silently captured.
    Object.freeze(route); routeChecks.set(route, check); return route;
  };
  if (scope !== 'daemon' || hostsDaemon) return finish({ mode: 'local', scope, reason });
  if (configured?.baseUrl.trim()) return finish({ mode: 'daemon', scope, reason, endpoint: Object.freeze({ ...configured, baseUrl: baseUrl(configured), certain: true }) });
  if (!directory) return finish({ mode: 'local', scope, reason });
  const runtime = runtimeObservation.value;
  const runtimeHost = runtime?.host === '0.0.0.0' ? '127.0.0.1' : runtime?.host;
  const host = runtimeHost?.includes(':') && !runtimeHost.startsWith('[') ? `[${runtimeHost}]` : runtimeHost;
  const runtimeEndpoint: DaemonConfigEndpoint | null = runtime && detachedDaemonProcessAlive(runtime, isProcessAlive)
    ? Object.freeze({ baseUrl: baseUrl({ baseUrl: `http://${host}:${runtime.port}`, source: 'runtime' }), token, source: 'running-daemon record', certain: true }) : null;
  const bindingEndpoint: DaemonConfigEndpoint | null = bindingSnapshot
    ? Object.freeze({ baseUrl: deriveControlPlaneBaseUrl(bindingSnapshot, 'loopback'), token, source: 'control-plane binding in the daemon config', certain: true }) : null;
  for (const endpoint of [runtimeEndpoint, bindingEndpoint]) {
    if (!endpoint) continue;
    let answered = false;
    try {
      const response = await fetchImpl(`${baseUrl(endpoint)}/config`, { method: 'GET', headers: headers(endpoint), redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      answered = response.status < 500 && !response.redirected;
    } catch { /* Probe is only discovery; no writes or fallback after capture. */ }
    if (answered) return finish({ mode: 'daemon', scope, reason, endpoint });
  }
  // A live-pid runtime record promised a daemon: retain loud unavailability.
  if (runtimeEndpoint) return finish({ mode: 'daemon', scope, reason, endpoint: runtimeEndpoint });
  return finish({ mode: 'local', scope, reason });
}

function validFacts(value: unknown, request: SettingsPreconditionRequest): value is SettingsPreconditionFacts {
  const compound = request.credentialClear === true;
  if (!record(value) || !exact(value, ['operation', 'key', 'value', 'destinations', 'incarnation', ...(compound ? ['credentialClear', 'credential'] : [])])
    || value.operation !== request.operation || value.key !== request.key || !Number.isSafeInteger(value.incarnation) || Number(value.incarnation) < 0
    || !Array.isArray(value.destinations) || value.destinations.length === 0 || value.destinations.length > 16) return false;
  let configOffset = 0;
  if (compound) {
    const credential = value.credential;
    const scope = configKeyScope(request.key) === 'daemon' ? 'daemon' : 'user';
    if (value.credentialClear !== true || !record(credential) || !exact(credential, ['key', 'scope', 'destinations'])
      || credential.key !== daemonSecretKeyFor(request.key) || credential.scope !== scope
      || !Array.isArray(credential.destinations) || credential.destinations.length >= value.destinations.length) return false;
    configOffset = credential.destinations.length;
    if (!credential.destinations.every((destination, index) => record(destination) && exact(destination, ['path', 'operation', 'tier'])
      && typeof destination.path === 'string' && destination.path.length > 0 && destination.operation === 'remove' && destination.tier === scope
      && record((value.destinations as unknown[])[index])
      && ['path', 'operation', 'tier'].every(field => destination[field] === ((value.destinations as Record<string, unknown>[])[index]!)[field]))) return false;
  }
  return value.destinations.every((destination, index) => record(destination) && exact(destination, ['path', 'operation', 'tier'])
    && typeof destination.path === 'string' && destination.path.length > 0
    && destination.operation === (index < configOffset ? 'remove' : 'set')
    && (index < configOffset ? destination.tier === (value.credential as Record<string, unknown>).scope
      : ['global', 'project', 'daemon', 'shared'].includes(String(destination.tier))));
}
export async function captureRemoteSettingsPrecondition(
  endpoint: DaemonConfigEndpoint,
  request: SettingsPreconditionRequest,
  deps: Pick<DaemonConfigRouterDeps, 'fetchImpl' | 'timeoutMs'> & { readonly assertCurrent?: () => void } = {},
): Promise<RemoteSettingsPrecondition> {
  try { deps.assertCurrent?.(); } catch { throw unavailable(); }
  if (!['set', 'reset-default'].includes(request.operation) || (request.credentialClear !== undefined && request.credentialClear !== true)) throw unavailable();
  // Protect before serialization/network, not just before the later Jev call.
  const input = snapshotJudgmentInput({ mode: 'set', key: request.key, value: request.value }, 'goodvibes_settings') as { key: string; value: unknown };
  if (request.credentialClear && (!isSecretBearingConfigKey(input.key) || (request.operation === 'set' && input.value !== ''))) throw unavailable();
  const capturedRequest: SettingsPreconditionRequest = Object.freeze({ operation: request.operation, key: input.key,
    ...(request.operation === 'set' ? { value: input.value } : {}), ...(request.credentialClear ? { credentialClear: true } : {}) });
  const endpointUrl = baseUrl(endpoint);
  const url = `${endpointUrl}/config`;
  const authHeaders = headers(endpoint);
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const localExpiresAt = Date.now() + 300_000;
  try {
    const response = await fetchImpl(url, { method: 'POST', headers: authHeaders, redirect: 'error',
      body: JSON.stringify({ settingsPrecondition: { version: 1, action: 'capture', ...capturedRequest } }), signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok || response.redirected) throw unavailable();
    const payload: unknown = await response.json();
    if (!record(payload) || !exact(payload, ['settingsPrecondition']) || !record(payload.settingsPrecondition)) throw unavailable();
    const arm = payload.settingsPrecondition;
    if (!exact(arm, ['version', 'action', 'reference', 'expiresAt', 'facts']) || arm.version !== 1 || arm.action !== 'captured'
      || typeof arm.reference !== 'string' || !arm.reference || arm.reference.length > 128
      || typeof arm.expiresAt !== 'number' || !Number.isSafeInteger(arm.expiresAt) || arm.expiresAt <= 0
      || localExpiresAt <= Date.now() || !validFacts(arm.facts, capturedRequest)) throw unavailable();
    // Serving normalization still traverses the same protected-input boundary.
    const safe = snapshotJudgmentInput({ mode: 'set', key: arm.facts.key, value: arm.facts.value }, 'goodvibes_settings') as { value: unknown };
    const facts = freeze({ ...arm.facts, value: safe.value, destinations: arm.facts.destinations.map(destination => ({ ...destination })),
      ...(arm.facts.credential ? { credential: { ...arm.facts.credential, destinations: arm.facts.credential.destinations.map(destination => ({ ...destination })) } } : {}), endpoint: endpointUrl, expiresAt: arm.expiresAt });
    deps.assertCurrent?.();
    const handle = Object.freeze({}) as RemoteSettingsPrecondition;
    entries.set(handle, { facts, reference: arm.reference, url, headers: authHeaders, fetchImpl, timeoutMs, localExpiresAt, ...(deps.assertCurrent ? { assertCurrent: deps.assertCurrent } : {}), spent: false });
    return handle;
  } catch { throw unavailable(); }
}
export function inspectRemoteSettingsPrecondition(handle: RemoteSettingsPrecondition): RemoteSettingsPreconditionFacts {
  const entry = entries.get(handle); if (!entry) throw unavailable(); return entry.facts;
}
export function assertRemoteSettingsPrecondition(handle: RemoteSettingsPrecondition): void {
  const entry = entries.get(handle); if (!entry || entry.spent) throw unavailable();
  if (entry.localExpiresAt <= Date.now()) { entry.spent = true; throw unavailable(); }
  try { entry.assertCurrent?.(); } catch { entry.spent = true; throw unavailable(); }
}
function validReceipt(value: unknown, facts: RemoteSettingsPreconditionFacts): value is SettingsPreconditionReceipt {
  if (!record(value) || !exact(value, ['status', 'completedPaths',
    ...(Object.hasOwn(value, 'uncertainPath') ? ['uncertainPath'] : []),
    ...(Object.hasOwn(value, 'verifiedInOwningStore') ? ['verifiedInOwningStore'] : [])])
    || !['committed', 'partial', 'unknown'].includes(String(value.status)) || !Array.isArray(value.completedPaths)
    || value.completedPaths.length > facts.destinations.length) return false;
  const paths = facts.destinations.map(destination => destination.path);
  if (!value.completedPaths.every((path, index) => typeof path === 'string' && path === paths[index])) return false;
  if (value.status === 'committed') return value.completedPaths.length === paths.length && value.uncertainPath === undefined
    && typeof value.verifiedInOwningStore === 'boolean';
  if (Object.hasOwn(value, 'verifiedInOwningStore')) return false;
  if (value.status === 'partial') return value.completedPaths.length > 0 && value.completedPaths.length < paths.length
    && value.uncertainPath === paths[value.completedPaths.length];
  return value.completedPaths.length === 0 && (value.uncertainPath === undefined || value.uncertainPath === paths[0]);
}
export async function applyRemoteSettingsPrecondition(handle: RemoteSettingsPrecondition): Promise<SettingsPreconditionReceipt> {
  assertRemoteSettingsPrecondition(handle);
  const entry = entries.get(handle)!;
  // Synchronous retirement before the single dispatch. Authentic admission must
  // be checked by the manager/registry immediately before calling this method.
  entry.spent = true;
  const unknown: SettingsPreconditionReceipt = Object.freeze({ status: 'unknown', completedPaths: Object.freeze([]) });
  try {
    const response = await entry.fetchImpl(entry.url, { method: 'POST', headers: entry.headers, redirect: 'error',
      body: JSON.stringify({ settingsPrecondition: { version: 1, action: 'apply', reference: entry.reference } }), signal: AbortSignal.timeout(entry.timeoutMs) });
    if (!response.ok || response.redirected) return unknown;
    const payload: unknown = await response.json();
    if (!record(payload) || !exact(payload, ['settingsPrecondition']) || !record(payload.settingsPrecondition)) return unknown;
    const arm = payload.settingsPrecondition;
    if (!exact(arm, ['version', 'action', 'reference', 'receipt']) || arm.version !== 1 || arm.action !== 'applied'
      || arm.reference !== entry.reference || !validReceipt(arm.receipt, entry.facts)) return unknown;
    return freeze({ ...arm.receipt, completedPaths: [...arm.receipt.completedPaths] });
  } catch { return unknown; }
}

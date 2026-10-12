import { randomUUID } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { isSecretRefInput, normalizeSecretRef, type ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { createProtectedSourceOwner, type ProtectedSourceOwner, type ProtectedSource, type ProtectedResearchReference,
  type SourceScreeningReceipt, type ResearchReferenceScreeningReceipt, type ResearchReferenceOperation } from '@goodvibes-jev/engine/sdk/platform/security';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { SecretsManager } from '../config/secrets.ts';
import { AGENT_HOSTED_RESEARCH_SCREENING_KEY } from '../config/host-settings.ts';

type ConfigOwner = Pick<ConfigManager, 'getHostBooleanSetting' | 'getIngestionQuarantine' | 'getConfigurationIncarnation'
  | 'captureDurableConfigurationIncarnation' | 'getDurableConfigurationIncarnation' | 'onDidChangeIncarnation' | 'onDidInvalidate'>;
type CredentialOwner = Pick<SecretsManager, 'resolveLocalCredentialSnapshot' | 'captureLocalCredentialReadset'
  | 'getCredentialMutationState' | 'onDidInvalidateCredentials'>;
interface Acquisition { readonly owner: ProtectedSourceOwner; assertCurrent(): void; close(): Promise<void>; }
const unavailable = (): never => { throw new ToolInputProjectionError('unconfigured'); };
const apply = Reflect.apply;
const isCredentialReference: (value: unknown) => boolean = isSecretRefInput;
function callHost<Args extends unknown[], Result>(method: (...args: Args) => Result, receiver: object, args: Args): Result {
  return apply(method, receiver, args);
}
const getPrototypeOf = Object.getPrototypeOf;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const ownKeys = Reflect.ownKeys;
const signalAborted = getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get;
const throwIfAborted = AbortSignal.prototype.throwIfAborted;
const promiseThen = Promise.prototype.then;

/** Original caller restrictions are retained without invoking input accessors. */
function retainReferenceOperation(operation: ResearchReferenceOperation | undefined): {
  readonly operation: ResearchReferenceOperation | undefined; assertCurrent(): void; aborted(): boolean;
} {
  if (operation === undefined) return { operation, assertCurrent() {}, aborted: () => false };
  if (!operation || typeof operation !== 'object' || nodeTypes.isProxy(operation)) return unavailable();
  const prototype = getPrototypeOf(operation);
  if (prototype !== Object.prototype && prototype !== null) return unavailable();
  for (const key of ownKeys(operation)) {
    if (key !== 'signal' && key !== 'assertCurrent') return unavailable();
    const field = getOwnPropertyDescriptor(operation, key);
    if (!field || !('value' in field)) return unavailable();
  }
  const callerSignal = getOwnPropertyDescriptor(operation, 'signal') ? operation.signal : undefined;
  if (callerSignal !== undefined) {
    if (!callerSignal || typeof callerSignal !== 'object' || nodeTypes.isProxy(callerSignal) || !signalAborted) return unavailable();
    try { apply(signalAborted, callerSignal, []); } catch { return unavailable(); }
  }
  const check = getOwnPropertyDescriptor(operation, 'assertCurrent') ? operation.assertCurrent : undefined;
  if (check !== undefined && (typeof check !== 'function' || nodeTypes.isProxy(check))) return unavailable();
  const retained = Object.freeze({ signal: callerSignal, assertCurrent: check });
  return { operation: retained,
    aborted: () => callerSignal !== undefined && signalAborted !== undefined && apply(signalAborted, callerSignal, []) === true,
    assertCurrent() {
      if (callerSignal) apply(throwIfAborted, callerSignal, []);
      const result: unknown = check === undefined ? undefined : apply(check, retained, []);
      if (result !== undefined) {
        if (nodeTypes.isPromise(result)) apply(promiseThen, result, [undefined, () => {}]);
        return unavailable();
      }
      if (callerSignal) apply(throwIfAborted, callerSignal, []);
    },
  };
}
interface HostLayout {
  readonly owner: object;
  readonly prototype: object | null;
  readonly fields: readonly { readonly key: PropertyKey; readonly descriptor: PropertyDescriptor | undefined }[];
  readonly keys?: readonly PropertyKey[];
}

/** Descriptor checks never evaluate a replacement getter or proxy. Native
 * method dependencies on the same prototype chain cannot be shadowed either. */
function retainHostMethods(subject: object, required: readonly string[]): () => void {
  if (nodeTypes.isProxy(subject)) return unavailable();
  const layouts: HostLayout[] = [];
  const methodKeys = new Set<PropertyKey>(required);
  let prototype: object | null = getPrototypeOf(subject);
  const seen = new Set<object>([subject]);
  while (prototype !== null) {
    if (nodeTypes.isProxy(prototype) || seen.has(prototype)) return unavailable();
    seen.add(prototype);
    const owner = prototype;
    const keys = ownKeys(owner);
    for (const key of keys) methodKeys.add(key);
    prototype = getPrototypeOf(owner);
    layouts.push({ owner, prototype, keys, fields: keys.map(key => ({ key, descriptor: getOwnPropertyDescriptor(owner, key) })) });
  }
  const originalPrototype = getPrototypeOf(subject);
  layouts.unshift({ owner: subject, prototype: originalPrototype,
    fields: [...methodKeys].map(key => ({ key, descriptor: getOwnPropertyDescriptor(subject, key) })) });
  for (const key of required) {
    let owner: object | null = subject;
    let descriptor: PropertyDescriptor | undefined;
    while (owner !== null && !descriptor) {
      descriptor = getOwnPropertyDescriptor(owner, key);
      owner = getPrototypeOf(owner);
    }
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function'
      || nodeTypes.isProxy(descriptor.value)) return unavailable();
  }
  return () => {
    for (const layout of layouts) {
      if (getPrototypeOf(layout.owner) !== layout.prototype) return unavailable();
      if (layout.keys) {
        const keys = ownKeys(layout.owner);
        if (keys.length !== layout.keys.length) return unavailable();
        for (let index = 0; index < keys.length; index++) if (keys[index] !== layout.keys[index]) return unavailable();
      }
      for (const { key, descriptor } of layout.fields) {
        const current = getOwnPropertyDescriptor(layout.owner, key);
        if ((descriptor === undefined) !== (current === undefined)
          || !Object.is(descriptor?.value, current?.value) || descriptor?.get !== current?.get || descriptor?.set !== current?.set
          || descriptor?.writable !== current?.writable || descriptor?.enumerable !== current?.enumerable
          || descriptor?.configurable !== current?.configurable) return unavailable();
      }
    }
  };
}

/** Values and native aliases remain private and never become authority identifiers. */
function captureCredential(key: string, secrets: CredentialOwner): { readonly value: string; assertCurrent(): void } {
  const environment = process.env[key];
  let localKey = key;
  if (environment !== undefined) {
    if (!isCredentialReference(environment)) {
      if (!environment || environment.trim() !== environment || /[\r\n\0]/.test(environment)) return unavailable();
      return { value: environment, assertCurrent() { if (process.env[key] !== environment) unavailable(); } };
    }
    const reference = normalizeSecretRef(environment);
    if (!reference || reference.source !== 'goodvibes') return unavailable();
    localKey = reference.id;
  }
  const snapshot = secrets.resolveLocalCredentialSnapshot(localKey);
  if (snapshot.state !== 'resolved' || !snapshot.value || snapshot.value.trim() !== snapshot.value || /[\r\n\0]/.test(snapshot.value)) return unavailable();
  return { value: snapshot.value, assertCurrent() {
    if (process.env[key] !== environment) unavailable();
    const current = secrets.resolveLocalCredentialSnapshot(localKey);
    if (current.state !== 'resolved' || current.revision !== snapshot.revision || current.value !== snapshot.value) unavailable();
  } };
}

/** Native research consent only. Inbox consent and provider routing confer no grant. */
function acquire(config: ConfigOwner, secrets: CredentialOwner, hostSignal: AbortSignal, assertHost: () => void): Acquisition {
  const lifetime = new AbortController();
  const signal = AbortSignal.any([hostSignal, lifetime.signal]);
  const subscriptions: Array<() => void> = [];
  let closed = false;
  let closing: Promise<void> | undefined;
  let owner: ProtectedSourceOwner | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    const finish = Promise.withResolvers<void>();
    closing = finish.promise;
    closed = true; lifetime.abort();
    const failures: unknown[] = [];
    for (const unsubscribe of subscriptions.splice(0).reverse()) {
      try { unsubscribe(); } catch (error) { failures.push(error); }
    }
    let pending: Promise<void> | undefined;
    try { pending = owner?.close(); } catch (error) { failures.push(error); }
    void Promise.resolve(pending).then(() => {
      if (failures.length) finish.reject(new AggregateError(failures, 'Research screening subscriptions did not close'));
      else finish.resolve();
    }, error => finish.reject(new AggregateError([...failures, error], 'Research screening owner did not close')));
    return closing;
  };
  const retire = (): void => { lifetime.abort(); };
  try {
    assertHost();
    subscriptions.push(config.onDidChangeIncarnation(retire));
    subscriptions.push(config.onDidInvalidate(retire));
    subscriptions.push(secrets.onDidInvalidateCredentials(retire));
    const incarnation = config.getConfigurationIncarnation();
    const assertCredentials = secrets.captureLocalCredentialReadset();
    const consent = config.getHostBooleanSetting(AGENT_HOSTED_RESEARCH_SCREENING_KEY);
    let durableIncarnation: string | undefined;
    const assertNative = (): void => {
      assertHost(); signal.throwIfAborted();
      const quarantine = config.getIngestionQuarantine();
      if (closed || config.getConfigurationIncarnation() !== incarnation || secrets.getCredentialMutationState().pending
        || (durableIncarnation !== undefined && config.getDurableConfigurationIncarnation() !== durableIncarnation)
        || consent.get() !== true || consent.getResolved().value !== true
        || quarantine.some(entry => entry.key === '(whole file)' || entry.key === 'tools' || entry.key === AGENT_HOSTED_RESEARCH_SCREENING_KEY)) unavailable();
      assertCredentials(); assertHost(); signal.throwIfAborted();
    };
    assertNative();
    durableIncarnation = config.captureDurableConfigurationIncarnation();
    assertNative();
    const abacus = captureCredential('ABACUSAI_API_KEY', secrets);
    const typesafe = captureCredential('TYPESAFE_API_KEY', secrets);
    const assertCurrent = (): void => {
      assertNative(); abacus.assertCurrent(); typesafe.assertCurrent(); assertNative();
    };
    assertCurrent();
    owner = createProtectedSourceOwner(Object.freeze({ kind: 'hosted',
      authority: Object.freeze({ kind: 'hosted', ownerId: `agent-research-${randomUUID()}`, revision: randomUUID(),
        retention: 'provider-managed-zero-retention-unverified', signal, assertCurrent }),
      credentials: Object.freeze({ abacusApiKey: abacus.value, typesafeApiKey: typesafe.value }),
    }));
    assertCurrent();
    return Object.freeze({ owner, assertCurrent, close });
  } catch {
    // Acquisition has admitted no provider operation. Synchronous subscriptions
    // still close if consent, metadata or credentials could not be captured.
    void close().catch(() => {});
    return unavailable();
  }
}

/**
 * One graph-owned report capability. A new capture may use a newly granted
 * native configuration; an existing handle always stays with its original
 * acquisition. No source, receipt or operation can supply consent.
 */
export function createAgentResearchSourceOwner(config: ConfigOwner, secrets: CredentialOwner, signal: AbortSignal): ProtectedSourceOwner {
  const assertConfigMethods = retainHostMethods(config, ['getHostBooleanSetting', 'getIngestionQuarantine', 'getConfigurationIncarnation',
    'captureDurableConfigurationIncarnation', 'getDurableConfigurationIncarnation', 'onDidChangeIncarnation', 'onDidInvalidate']);
  const assertCredentialMethods = retainHostMethods(secrets, ['resolveLocalCredentialSnapshot', 'captureLocalCredentialReadset',
    'getCredentialMutationState', 'onDidInvalidateCredentials']);
  const configMethods = {
    getHostBooleanSetting: config.getHostBooleanSetting, getIngestionQuarantine: config.getIngestionQuarantine,
    getConfigurationIncarnation: config.getConfigurationIncarnation, captureDurableConfigurationIncarnation: config.captureDurableConfigurationIncarnation,
    getDurableConfigurationIncarnation: config.getDurableConfigurationIncarnation, onDidChangeIncarnation: config.onDidChangeIncarnation,
    onDidInvalidate: config.onDidInvalidate,
  };
  const credentialMethods = { resolveLocalCredentialSnapshot: secrets.resolveLocalCredentialSnapshot,
    captureLocalCredentialReadset: secrets.captureLocalCredentialReadset, getCredentialMutationState: secrets.getCredentialMutationState,
    onDidInvalidateCredentials: secrets.onDidInvalidateCredentials };
  const handles = new WeakMap<ProtectedSource | ProtectedResearchReference, Acquisition>();
  const receipts = new WeakMap<SourceScreeningReceipt | ResearchReferenceScreeningReceipt, Acquisition>();
  const acquisitions = new Set<Acquisition>();
  const drains = new Set<Promise<void>>();
  const failures: unknown[] = [];
  let active: Acquisition | undefined;
  let closing: Promise<void> | undefined;
  const assertHost = (): void => {
    signal.throwIfAborted();
    if (closing) return unavailable();
    assertConfigMethods(); assertCredentialMethods(); signal.throwIfAborted();
  };
  const observe = <T>(read: () => T): T => {
    assertHost();
    try { return read(); } finally { assertHost(); }
  };
  const observeSubscription = (subscribe: () => () => void): (() => void) => {
    assertHost();
    const unsubscribe = subscribe();
    try { assertHost(); return unsubscribe; }
    catch (error) { unsubscribe(); throw error; }
  };
  const nativeConfig: ConfigOwner = {
    getHostBooleanSetting: key => observe(() => callHost(configMethods.getHostBooleanSetting, config, [key])),
    getIngestionQuarantine: () => observe(() => callHost(configMethods.getIngestionQuarantine, config, [])),
    getConfigurationIncarnation: () => observe(() => callHost(configMethods.getConfigurationIncarnation, config, [])),
    captureDurableConfigurationIncarnation: () => observe(() => callHost(configMethods.captureDurableConfigurationIncarnation, config, [])),
    getDurableConfigurationIncarnation: () => observe(() => callHost(configMethods.getDurableConfigurationIncarnation, config, [])),
    onDidChangeIncarnation: listener => observeSubscription(() => callHost(configMethods.onDidChangeIncarnation, config, [listener])),
    onDidInvalidate: listener => observeSubscription(() => callHost(configMethods.onDidInvalidate, config, [listener])),
  };
  const nativeCredentials: CredentialOwner = {
    resolveLocalCredentialSnapshot: key => observe(() => callHost(credentialMethods.resolveLocalCredentialSnapshot, secrets, [key])),
    captureLocalCredentialReadset: () => observe(() => callHost(credentialMethods.captureLocalCredentialReadset, secrets, [])),
    getCredentialMutationState: () => observe(() => callHost(credentialMethods.getCredentialMutationState, secrets, [])),
    onDidInvalidateCredentials: listener => observeSubscription(() => callHost(credentialMethods.onDidInvalidateCredentials, secrets, [listener])),
  };
  const drain = (acquisition: Acquisition): void => {
    if (!acquisitions.delete(acquisition)) return;
    let pending: Promise<void>;
    try { pending = acquisition.close(); } catch (error) { pending = Promise.reject(error); }
    drains.add(pending);
    void pending.then(() => drains.delete(pending), error => { drains.delete(pending); failures.push(error); });
  };
  const current = (): Acquisition => {
    assertHost();
    if (active) {
      try { active.assertCurrent(); return active; }
      catch { drain(active); active = undefined; }
    }
    active = acquire(nativeConfig, nativeCredentials, signal, assertHost); acquisitions.add(active);
    return active;
  };
  return Object.freeze({
    capture(parts) {
      const acquisition = current(), handle = acquisition.owner.capture(parts);
      handles.set(handle, acquisition); return handle;
    },
    captureResearchReference(reference) {
      const acquisition = current(), handle = acquisition.owner.captureResearchReference(reference);
      handles.set(handle, acquisition); return handle;
    },
    async screen(handle) {
      const acquisition = handles.get(handle);
      if (!acquisition) return { status: 'held', reason: 'stale' };
      const result = await acquisition.owner.screen(handle);
      if (result.status === 'settled') {
        // Canonical screening owns its asynchronous transport drain. Retain
        // this exact acquisition through that await before publishing a receipt.
        try { acquisition.assertCurrent(); }
        catch { return { status: 'held', reason: signal.aborted || closing ? 'cancelled' : 'stale' }; }
        receipts.set(result.receipt, acquisition);
      }
      return result;
    },
    async screenResearchReference(handle, operation) {
      const acquisition = handles.get(handle);
      if (!acquisition) return { status: 'held', reason: 'stale' };
      let caller: ReturnType<typeof retainReferenceOperation>;
      try { caller = retainReferenceOperation(operation); }
      catch { return { status: 'held', reason: 'malformed' }; }
      const result = await acquisition.owner.screenResearchReference(handle, caller.operation);
      if (result.status === 'settled') {
        // The original caller and acquisition remain live through native drain.
        try { acquisition.assertCurrent(); caller.assertCurrent(); acquisition.assertCurrent(); }
        catch { return { status: 'held', reason: signal.aborted || closing || caller.aborted() ? 'cancelled' : 'stale' }; }
        receipts.set(result.receipt, acquisition);
      }
      return result;
    },
    project(receipt) {
      const acquisition = receipts.get(receipt);
      if (!acquisition) return unavailable();
      return acquisition.owner.project(receipt);
    },
    projectResearchReference(receipt) {
      const acquisition = receipts.get(receipt);
      if (!acquisition) return unavailable();
      return acquisition.owner.projectResearchReference(receipt);
    },
    async release(handle) {
      const acquisition = handles.get(handle);
      if (!acquisition) return;
      await acquisition.owner.release(handle); handles.delete(handle);
    },
    close() {
      if (closing) return closing;
      // Retire before abort callbacks or native drain can reenter this graph.
      const finish = Promise.withResolvers<void>();
      closing = finish.promise;
      active = undefined;
      for (const acquisition of [...acquisitions]) drain(acquisition);
      void Promise.allSettled([...drains]).then(() => {
        if (failures.length) finish.reject(new AggregateError(failures, 'Research screening owners did not close'));
        else finish.resolve();
      });
      return closing;
    },
  } satisfies ProtectedSourceOwner);
}

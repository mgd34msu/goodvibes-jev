import { assertSecurityReadSource, captureSecurityReadBindings, captureSecurityReadFiles, captureSecurityReadData } from '../security/read-source.js';
/**
 * SecretsManager, hierarchy-aware secret resolution and persistence.
 *
 * Resolution order:
 *   1. Environment variable (process.env[key])
 *   2. Daemon stores (~/.goodvibes/daemon/secrets.enc, then secrets.json)
 *   3. Project/ancestor secure stores (.goodvibes/<surface>/secrets.enc), nearest first
 *   4. Project/ancestor plaintext stores (.goodvibes/<surface>.secrets.json), nearest first
 *   5. User secure store (~/.goodvibes/<surface>/secrets.enc)
 *   6. User plaintext store (~/.goodvibes/<surface>.secrets.json)
 *   7. If a resolved value is a SecretRef, resolve through the referenced provider
 *
 * The three scopes and the files behind them are documented in
 * secrets-store-paths.ts. The daemon tier leads because a credential the daemon
 * executes with has one home and a surface silo can only hold a stale copy of
 * it; the tier is empty until something writes to it, so a store with no daemon
 * secrets resolves exactly as it did before the tier existed.
 *
 * The active policy decides whether plaintext stores are eligible:
 *   - plaintext_allowed  → read/write plaintext or secure
 *   - preferred_secure   → prefer secure, allow plaintext fallback with warning
 *   - require_secure     → never read/write plaintext
 *
 * Encryption keys come from a random keyfile (~/.goodvibes/secrets.key,
 * 0600 in a 0700 directory), generated on first need, never from host
 * identity, so stores survive hostname/username changes and machine moves.
 * Stores written by older SDKs (host-identity key, no version field) are
 * migrated to the keyfile format on first successful read. A store that
 * exists but cannot be decrypted is a distinct, surfaced error state, it is
 * never treated as empty and never overwritten.
 *
 * Secret values are never logged.
 */

import { dirname, isAbsolute, resolve } from 'path';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { captureStrictJudgmentJson } from '../gate/judgment-result.js';
import { observeImportFile, assertImportFileCurrent, type ImportFileObservation, type PreparedImportTransitionFacts } from './prepared-import.js';
import type { PreparedConfigMutationReceipt } from './prepared-mutation.js';
import { acquireCrossProcessLock } from '../workspace/checkpoint/cross-process-lock.js';
import { writeJsonFileAtomic } from '../utils/atomic-json-store.js';
import type { ConfigManager } from './manager.js';
import {
  SecretStoreUnreadableError,
  SECRETS_STORE_FORMAT_VERSION,
  assertCachedKeyIsCurrent,
  decryptStore as decrypt,
  deriveLegacyEncryptionKey,
  encryptStore as encrypt,
  keyFingerprint,
  loadOrCreateKeyfile,
  type EncryptedStoreEnvelope,
} from './secrets-keyfile.js';
export { SecretStoreUnreadableError } from './secrets-keyfile.js';
import { getSecretRefSource, isSecretRefInput, normalizeSecretRef, resolveSecretRef } from './secret-refs.js';
import { listMigratableSecrets, migratableStores } from './secrets-migration-view.js';
import { logger } from '../utils/logger.js';
import { requireSurfaceRoot, resolveSharedDirectory } from '../runtime/surface-root.js';
import { summarizeError } from '../utils/error-display.js';
import { describeCredentialScope, isDaemonNeededSecretKey } from './credential-scope-registry.js';
import {
  allSecretStores,
  defaultDaemonSecretHome,
  secretReadOrder,
  secretWriteTarget,
  type SecretStoreLayout,
  type SecretStorePath,
} from './secrets-store-paths.js';

export type SecretStorageMode = 'plaintext_allowed' | 'preferred_secure' | 'require_secure';
export type {
  SecretScope,
  SecretSource,
  SecretStorageMedium,
  SecretStorePath,
} from './secrets-store-paths.js';
import type { SecretScope, SecretSource, SecretStorageMedium } from './secrets-store-paths.js';

export interface SecretRecord {
  readonly key: string;
  readonly source: SecretSource;
  readonly scope: SecretScope | 'env';
  readonly secure: boolean;
  readonly path?: string | undefined;
  readonly overriddenByEnv: boolean;
  readonly refSource?: string | undefined;
}

export class SecretWriteCommittedError extends Error {
  constructor() { super('The credential write committed, but its owner changed afterward.'); this.name = 'SecretWriteCommittedError'; }
}

declare const secretWriteTransitionBrand: unique symbol;
export interface SecretWriteTransition { readonly [secretWriteTransitionBrand]: true }
export interface SecretWriteTransitionFacts {
  readonly key: string;
  readonly scope: SecretScope;
  readonly paths: readonly string[];
  readonly beforeGeneration: number;
  readonly phase: 'prepared' | 'pending' | 'committed';
}
export interface SecretWriteEffectOwner {
  readonly assertCurrent: () => void;
  readonly committed: () => void;
}
declare const secretImportBrand: unique symbol;
declare const secretImportTransitionBrand: unique symbol;
export interface PreparedSecretImport { readonly [secretImportBrand]: true }
export interface PreparedSecretImportTransition { readonly [secretImportTransitionBrand]: true }
export type SecretImportEntry =
  | { readonly key: string; readonly value: string; readonly scope: SecretScope; readonly operation?: 'set' }
  | { readonly key: string; readonly scope: SecretScope; readonly operation: 'delete'; readonly value?: never };
export interface PreparedSecretImportFacts {
  readonly operation: 'import';
  readonly beforeGeneration: number;
  readonly items: readonly { readonly key: string; readonly scope: SecretScope; readonly configured: boolean }[];
  readonly destinations: readonly { readonly path: string; readonly operation: 'set'; readonly tier: SecretScope | 'keyfile' }[];
}
interface SecretImportRecord {
  readonly facts: PreparedSecretImportFacts;
  readonly policy: SecretStorageMode;
  readonly methods: readonly unknown[];
  readonly observations: { readonly path: string; observation: ImportFileObservation }[];
  readonly publications: readonly { readonly path: string; readonly payload: unknown; readonly keyfile: boolean }[];
  phase: 'prepared' | 'pending' | 'committing' | 'committed' | 'failed';
  transition?: PreparedSecretImportTransition;
}
export interface SecretWriteOptions {
  /** Optional exact effect transaction; never grants permission by itself. */
  readonly effect?: ((transition: SecretWriteTransition) => SecretWriteEffectOwner) | undefined;
  /** Retained caller authority, checked again after queued store-lock acquisition. */
  readonly assertCurrent?: (() => void) | undefined;
  readonly scope?: SecretScope | undefined;
  readonly medium?: SecretStorageMedium | undefined;
}

export interface SecretDeleteOptions {
  readonly scope?: SecretScope | undefined;
  readonly medium?: SecretStorageMedium | undefined;
}

export interface SecretStorageReview {
  readonly policy: SecretStorageMode;
  readonly secureAvailable: boolean;
  readonly storedKeys: number;
  readonly envBackedKeys: number;
  readonly secureKeys: number;
  readonly plaintextKeys: number;
  readonly warnings: readonly string[];
  readonly locations: readonly {
    readonly source: Exclude<SecretSource, 'env'>;
    readonly path: string;
    readonly exists: boolean;
    readonly readable: boolean;
  }[];
}

type SecureStoreReadResult =
  | { readonly status: 'ok'; readonly secrets: Record<string, string> }
  | { readonly status: 'missing' }
  | { readonly status: 'unreadable'; readonly reason: string };

type PlaintextStoreReadResult =
  | { readonly status: 'ok'; readonly secrets: Record<string, string> }
  | { readonly status: 'missing' }
  | { readonly status: 'unreadable'; readonly reason: string };

interface PlaintextStore {
  readonly version: 1;
  readonly secrets: Record<string, string>;
}

/**
 * Identity used only to decrypt legacy stores (written before keyfile-derived
 * encryption existed). Overridable so tests can simulate stores written on a
 * machine with a different hostname/username.
 */
export interface LegacyStoreIdentity {
  readonly hostname: string;
  readonly username: string;
}

export interface SecretsManagerOptions {
  readonly projectRoot: string;
  readonly globalHome: string;
  readonly surfaceRoot: string;
  /** Withhold borrowed secret-provider/store failure text from read diagnostics. */
  readonly diagnosticMode?: 'default' | 'structural' | undefined;
  /**
   * The daemon's state root, holding the daemon-scoped stores. Defaults to
   * `<globalHome>/.goodvibes/daemon`; a caller that honors `--daemon-home` or
   * `GOODVIBES_DAEMON_HOME` resolves it first and passes it here, so the daemon
   * and its clients agree on one file.
   */
  readonly daemonHome?: string | undefined;
  readonly configManager?: Pick<ConfigManager, 'get'> | undefined;
  readonly policy?: SecretStorageMode | undefined;
  readonly secureProjectFilePath?: string | undefined;
  readonly secureUserFilePath?: string | undefined;
  readonly secureDaemonFilePath?: string | undefined;
  readonly plaintextProjectFilePath?: string | undefined;
  readonly plaintextUserFilePath?: string | undefined;
  readonly plaintextDaemonFilePath?: string | undefined;
  /** Override the keyfile location (defaults to <globalHome>/.goodvibes/secrets.key). */
  readonly keyFilePath?: string | undefined;
  /** Override the host identity used to decrypt legacy stores (tests only). */
  readonly legacyIdentity?: LegacyStoreIdentity | undefined;
}

function requireAbsoluteOwnedPath(path: string, name: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    throw new Error(`SecretsManager ${name} must be a non-empty absolute path.`);
  }
  if (!isAbsolute(trimmed)) {
    throw new Error(`SecretsManager ${name} must be an absolute path.`);
  }
  return resolve(trimmed);
}

function normalizeOptionalOwnedPath(path: string | undefined, name: string): string | undefined {
  return path === undefined ? undefined : requireAbsoluteOwnedPath(path, name);
}

function loadConfiguredSecretPolicy(configManager?: Pick<ConfigManager, 'get'>): SecretStorageMode {
  try {
    return (configManager?.get('storage.secretPolicy') as SecretStorageMode | undefined) ?? 'preferred_secure';
  } catch {
    return 'preferred_secure';
  }
}

/**
 * Where a write lands when the caller did not name a scope.
 *
 * A credential a daemon-owned config path names is one the daemon executes
 * with, so its home is the daemon tier, the same rule config-ownership.ts
 * applies to the setting that points at it. Getting this wrong is not cosmetic:
 * a replicated surface token written to the project store lands under whatever
 * directory the daemon happened to start in, and the next start from a
 * different directory reads a store that does not have it.
 *
 * Everything that is not daemon-owned keeps the historical default.
 */
function defaultScopeForKey(key: string): SecretScope {
  return isDaemonNeededSecretKey(key) ? 'daemon' : 'project';
}

/**
 * Where a write to `key` will actually go, given what the caller asked for.
 *
 * **Daemon ownership beats an explicit scope, deliberately.** It used to be the
 * other way round, an explicit `scope` won, and that made the routing above
 * defeatable by the ordinary path a person takes to store a credential:
 * `/secrets set` passes a scope on every call, so a daemon-owned password went
 * into a client silo the daemon never reads. The credential reported success
 * and did nothing, which is the exact failure the ownership rule exists to
 * prevent.
 *
 * The alternative, refusing the write and telling the caller to pick a
 * different scope, was rejected: it turns a storage bug into a wall in front
 * of the credentials people most need to set, and the caller's scope argument
 * is nearly always a default it never thought about rather than an intent.
 *
 * So the write is honoured and RELOCATED, never dropped, and the relocation is
 * disclosed rather than silent: `set()` logs it naming both scopes, and this
 * function is exported so a surface can tell the operator where a credential is
 * going BEFORE it asks for it.
 */
export function resolveSecretWriteScope(key: string, requested?: SecretScope | undefined): SecretScope {
  if (isDaemonNeededSecretKey(key)) return 'daemon';
  return requested ?? defaultScopeForKey(key);
}

/** True when `requested` would have sent a daemon-owned credential somewhere the daemon cannot read. */
export function secretWriteScopeWasOverridden(key: string, requested?: SecretScope | undefined): boolean {
  return requested !== undefined && requested !== 'daemon' && isDaemonNeededSecretKey(key);
}

/** Why `key` was filed where it was. Safe to display: names only, never values. */
export function describeSecretWriteScope(key: string): string {
  return describeCredentialScope(key);
}

declare const scopedDeletionBrand: unique symbol;
export interface PreparedScopedSecretDeletion { readonly [scopedDeletionBrand]: true; }
export interface PreparedScopedSecretDeletionFacts {
  readonly operation: 'delete'; readonly key: string; readonly scope: SecretScope;
  readonly destinations: readonly { readonly path: string; readonly operation: 'remove'; readonly tier: SecretScope }[];
}
interface ScopedDeletionRecord {
  readonly facts: PreparedScopedSecretDeletionFacts;
  readonly generation: number;
  readonly policy: SecretStorageMode;
  readonly observations: readonly { path: string; stamp: string }[];
  readonly publications: readonly { path: string; payload: unknown }[];
  spent: boolean;
  completed?: { generation: number; observations: readonly { path: string; stamp: string }[] };
}
function deletionFileObservation(path: string): { stamp: string; raw: string | null } {
  try {
    const before = statSync(path, { bigint: true }); const raw = readFileSync(path, 'utf8');
    const after = statSync(path, { bigint: true });
    const identity = (value: typeof before) => [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(':');
    if (identity(before) !== identity(after)) throw new Error('Secret store changed.');
    return { stamp: identity(after) + ':' + raw, raw };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { stamp: 'absent', raw: null }; throw error; }
}

const secretsReadSources = new WeakMap<SecretsManager, () => () => void>();
const getSecretsReadSources = secretsReadSources.get.bind(secretsReadSources);
const setSecretsReadSources = secretsReadSources.set.bind(secretsReadSources);

/** Restriction from the original native owner; a replaced instance method cannot issue it. */
export function captureSecretsReadSource(owner: SecretsManager): () => void {
  const capture = getSecretsReadSources(owner);
  assertSecurityReadSource(capture !== undefined);
  return capture();
}

export class SecretsManager {
  /** Restriction only, captured from this manager's actual native stores. */
  captureReadSource(): () => void {
    return captureSecretsReadSource(this);
  }
  /** Change listeners, fired after a successful set() or delete() so credential consumers (e.g. the provider registry) re-resolve LIVE, no restart. */
  private readonly changeListeners = new Set<(key: string) => void>();

  /** Subscribe to secret writes/deletes. Returns an unsubscribe function. */
  onDidChange(listener: (key: string) => void): () => void {
    this.changeListeners.add(listener);
    return () => { this.changeListeners.delete(listener); };
  }

  private notifyChanged(key: string, privateImport = false): void {
    for (const listener of [...this.changeListeners]) {
      try { listener(key); } catch (error) {
        logger.warn('SecretsManager: change listener failed', { key,
          ...(privateImport ? { reason: 'listener-failed' } : { error: summarizeError(error) }) });
      }
    }
  }

  private readonly ownedMutationPaths = new Set<string>();
  // An owner must not admit the old credential while its replacement/revoke
  // waits for filesystem ownership. Counts keep overlapping writes fenced.
  private credentialMutationGeneration = 0;
  private readonly credentialInvalidationListeners = new Set<() => void>();
  private readonly pendingLocalMutations = new Map<string, number>();

  /** Value-free local owner state; no credential names, paths, bytes or hashes. */
  getCredentialMutationState(): Readonly<{ generation: number; pending: boolean }> {
    return Object.freeze({ generation: this.credentialMutationGeneration, pending: this.pendingLocalMutations.size > 0 });
  }

  /** Pre-effect and settlement notifications, including failed or no-op writes. */
  onDidInvalidateCredentials(listener: () => void): () => void {
    this.credentialInvalidationListeners.add(listener);
    return () => { this.credentialInvalidationListeners.delete(listener); };
  }

  private notifyCredentialInvalidation(): void {
    for (const listener of [...this.credentialInvalidationListeners]) {
      try { listener(); } catch { /* An observer cannot defeat credential revocation. */ }
    }
  }

  private async withCredentialMutation<T>(key: string, operation: () => Promise<T>): Promise<T> {
    this.credentialMutationGeneration++;
    this.pendingLocalMutations.set(key, (this.pendingLocalMutations.get(key) ?? 0) + 1);
    this.notifyCredentialInvalidation();
    try { return await operation(); }
    finally {
      this.credentialMutationGeneration++;
      const remaining = this.pendingLocalMutations.get(key)! - 1;
      if (remaining === 0) this.pendingLocalMutations.delete(key);
      else this.pendingLocalMutations.set(key, remaining);
      this.notifyCredentialInvalidation();
    }
  }
  private readonly preparedScopedDeletions = new WeakMap<PreparedScopedSecretDeletion, ScopedDeletionRecord>();
  private readonly preparedImports = new WeakMap<PreparedSecretImport, SecretImportRecord>();

  /** Value-free private restriction over every native local credential source. */
  captureLocalCredentialReadset(): () => void {
    const state = this.getCredentialMutationState(), policy = this.getPolicy();
    if (state.pending) throw new Error('Credential owner is busy.');
    const methods = [this.getPolicy, this.getAllCandidateStores, this.getCredentialMutationState];
    const observations = [...new Set([this.keyFilePath, ...this.getAllCandidateStores().map(store => store.path)])]
      .map(path => ({ path, observation: observeImportFile(path) }));
    return () => {
      const current = this.getCredentialMutationState();
      if (current.pending || current.generation !== state.generation || this.getPolicy() !== policy
        || [this.getPolicy, this.getAllCandidateStores, this.getCredentialMutationState].some((method, index) => method !== methods[index])) throw new Error('Credential source changed.');
      for (const entry of observations) assertImportFileCurrent(entry.path, entry.observation);
    };
  }

  /** Stage complete private payloads; capture never creates a keyfile or repairs a store. */
  prepareImport(entries: readonly SecretImportEntry[]): PreparedSecretImport {
    try { return this.prepareImportOwned(entries); }
    catch { throw new Error('Secret import is unavailable.'); }
  }
  private prepareImportOwned(entries: readonly SecretImportEntry[]): PreparedSecretImport {
    const values = captureStrictJudgmentJson(entries), state = this.getCredentialMutationState(), policy = this.getPolicy();
    if (state.pending || !values.length || new Set(values.map(entry => entry.key)).size !== values.length
      || values.some(entry => typeof entry.key !== 'string' || !entry.key || (entry.operation !== undefined && entry.operation !== 'set' && entry.operation !== 'delete')
        || (entry.operation === 'delete' ? entry.value !== undefined : typeof entry.value !== 'string') || !['project', 'user', 'daemon'].includes(entry.scope))) throw new Error('Secret import is unavailable.');
    const medium = this.getDefaultWriteMedium(policy);
    const keyObservation = observeImportFile(this.keyFilePath);
    if (keyObservation.raw !== null && !/^[0-9a-f]{64}$/i.test(keyObservation.raw.trim())) throw new Error('Secret keyfile is unavailable.');
    const key = keyObservation.raw === null ? this.encKey ?? randomBytes(32) : Buffer.from(keyObservation.raw.trim(), 'hex');
    if (this.encKey && keyObservation.raw !== null && !this.encKey.equals(key)) throw new Error('Secret keyfile changed.');
    const observations = [{ path: this.keyFilePath, observation: keyObservation }];
    const targets = new Map<string, { readonly store: SecretStorePath; readonly values: Record<string, string>; encryptionKey: Buffer; legacy: boolean }>();
    const items = values.map(entry => ({ key: entry.key, value: entry.value, operation: entry.operation ?? 'set', scope: resolveSecretWriteScope(entry.key, entry.scope) }));
    for (const entry of items) {
      const stores = entry.operation === 'delete' ? [this.resolveWriteTarget(entry.scope, 'secure'), this.resolveWriteTarget(entry.scope, 'plaintext')]
        : [this.resolveWriteTarget(entry.scope, medium)];
      for (const store of stores) {
      let target = targets.get(store.path);
      if (!target) {
        const observation = observeImportFile(store.path);
        const previousObservation = observations.find(entry => entry.path === store.path);
        if (previousObservation) assertImportFileCurrent(store.path, previousObservation.observation);
        else observations.push({ path: store.path, observation });
        if (entry.operation === 'delete' && observation.raw === null) continue;
        let existing: unknown = {};
        let encryptionKey = key;
        let legacy = false;
        if (observation.raw !== null) {
          const parsed: unknown = JSON.parse(observation.raw);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Secret store is unavailable.');
          if (store.secure) {
            if (!('iv' in parsed) || typeof parsed.iv !== 'string' || !('tag' in parsed) || typeof parsed.tag !== 'string' || !('data' in parsed) || typeof parsed.data !== 'string') throw new Error('Secret store is unavailable.');
            const previousKey = !('version' in parsed) ? deriveLegacyEncryptionKey(this.options.legacyIdentity) : keyObservation.raw === null ? null : key;
            if (!previousKey || ('version' in parsed && parsed.version !== SECRETS_STORE_FORMAT_VERSION)) throw new Error('Secret store is unavailable.');
            if (entry.operation === 'delete') { encryptionKey = previousKey; legacy = !('version' in parsed); }
            if ('keyId' in parsed && typeof parsed.keyId !== 'string') throw new Error('Secret store is unavailable.');
            const envelope = { iv: parsed.iv, tag: parsed.tag, data: parsed.data,
              ...('version' in parsed ? { version: SECRETS_STORE_FORMAT_VERSION } : {}),
              ...('keyId' in parsed && typeof parsed.keyId === 'string' ? { keyId: parsed.keyId } : {}) };
            existing = JSON.parse(decrypt(envelope, previousKey));
          } else existing = 'secrets' in parsed ? parsed.secrets : parsed;
        }
        if (!existing || typeof existing !== 'object' || Array.isArray(existing) || Object.values(existing).some(value => typeof value !== 'string')) throw new Error('Secret store is unavailable.');
        target = { store, values: { ...captureStrictJudgmentJson(existing) } as Record<string, string>, encryptionKey, legacy }; targets.set(store.path, target);
      }
      if (entry.operation === 'delete') delete target.values[entry.key];
      else {
        target.encryptionKey = key; target.legacy = false;
        Object.defineProperty(target.values, entry.key, { value: entry.value, enumerable: true, writable: true, configurable: true });
      }
      }
    }
    const needsKey = keyObservation.raw === null && [...targets.values()].some(target => target.store.secure && target.encryptionKey === key);
    const publications = [...(needsKey ? [{ path: this.keyFilePath, payload: `${key.toString('hex')}\n`, keyfile: true }] : []),
      ...[...targets.values()].map(target => {
        const payload = target.store.secure ? encrypt(JSON.stringify(target.values), target.encryptionKey) : { version: 1, secrets: target.values };
        if (target.legacy && 'iv' in payload) { delete payload.version; delete payload.keyId; }
        return { path: target.store.path, payload, keyfile: false };
      })];
    const handle = Object.freeze({}) as PreparedSecretImport;
    const facts: PreparedSecretImportFacts = Object.freeze({ operation: 'import', beforeGeneration: state.generation,
      items: Object.freeze(items.map(({ key, scope, operation }) => Object.freeze({ key, scope, configured: operation === 'set' }))),
      destinations: Object.freeze(publications.map(publication => Object.freeze({ path: publication.path, operation: 'set' as const,
        tier: publication.keyfile ? 'keyfile' as const : targets.get(publication.path)!.store.scope }))) });
    this.preparedImports.set(handle, { facts, policy, observations, publications: captureStrictJudgmentJson(publications),
      methods: [this.getPolicy, this.resolveWriteTarget, this.getDefaultWriteMedium], phase: 'prepared' });
    this.assertPreparedImport(handle); return handle;
  }
  inspectPreparedImport(handle: PreparedSecretImport): PreparedSecretImportFacts {
    const record = this.preparedImports.get(handle); if (!record) throw new Error('Secret import is not authentic.'); return record.facts;
  }
  private assertImportRecord(record: SecretImportRecord, generation: number): void {
    if (this.credentialMutationGeneration !== generation || this.getPolicy() !== record.policy
      || [this.getPolicy, this.resolveWriteTarget, this.getDefaultWriteMedium].some((method, index) => method !== record.methods[index])) throw new Error('Secret import owner changed.');
    for (const observation of record.observations) assertImportFileCurrent(observation.path, observation.observation);
  }
  assertPreparedImport(handle: PreparedSecretImport): void {
    const record = this.preparedImports.get(handle);
    if (!record || record.phase !== 'prepared' || this.pendingLocalMutations.size) throw new Error('Secret import is unavailable.');
    this.assertImportRecord(record, record.facts.beforeGeneration);
  }
  beginPreparedImport(handle: PreparedSecretImport): PreparedSecretImportTransition {
    this.assertPreparedImport(handle); const record = this.preparedImports.get(handle)!;
    const transition = Object.freeze({}) as PreparedSecretImportTransition; record.transition = transition; record.phase = 'pending';
    this.credentialMutationGeneration++;
    for (const item of record.facts.items) this.pendingLocalMutations.set(item.key, 1);
    this.notifyCredentialInvalidation();
    try { this.assertPreparedImportTransition(handle, transition); return transition; }
    catch {
      record.phase = 'failed'; this.credentialMutationGeneration++;
      for (const item of record.facts.items) {
        const remaining = (this.pendingLocalMutations.get(item.key) ?? 1) - 1;
        if (remaining) this.pendingLocalMutations.set(item.key, remaining); else this.pendingLocalMutations.delete(item.key);
      }
      this.notifyCredentialInvalidation(); throw new Error('Secret import owner changed.');
    }
  }
  inspectPreparedImportTransition(handle: PreparedSecretImport, transition: PreparedSecretImportTransition): PreparedImportTransitionFacts {
    this.assertPreparedImportTransition(handle, transition); const record = this.preparedImports.get(handle)!;
    return Object.freeze({ beforeGeneration: record.facts.beforeGeneration, afterGeneration: this.credentialMutationGeneration, phase: record.phase === 'committed' ? 'committed' : 'pending' });
  }
  assertPreparedImportTransition(handle: PreparedSecretImport, transition: PreparedSecretImportTransition): void {
    const record = this.preparedImports.get(handle);
    if (!record || record.transition !== transition || !['pending', 'committing', 'committed'].includes(record.phase)) throw new Error('Secret import transition is not authentic.');
    const completed = record.phase === 'committed';
    if (completed ? this.pendingLocalMutations.size > 0 : this.pendingLocalMutations.size !== record.facts.items.length || record.facts.items.some(item => this.pendingLocalMutations.get(item.key) !== 1)) throw new Error('Secret import owner changed.');
    this.assertImportRecord(record, record.facts.beforeGeneration + (completed ? 2 : 1));
  }
  /** Acquire the real file namespace before a synchronous authenticated publication tail. */
  async withPreparedImport<T>(handle: PreparedSecretImport,
    operation: (finish: (assertCurrent: () => void) => PreparedConfigMutationReceipt) => T,
    assertCurrent: () => void = () => {}): Promise<T> {
    this.assertPreparedImport(handle);
    const record = this.preparedImports.get(handle)!;
    const current = () => { assertCurrent(); this.assertPreparedImport(handle); };
    return this.withStoreMutations(record.publications.map(publication => publication.path), () => {
      current(); let active = true; let spent = false;
      try { return operation(beforeEffect => {
        if (!active || spent) throw new Error('Secret import is spent.'); spent = true;
        beforeEffect(); const transition = this.beginPreparedImport(handle);
        return this.finishPreparedImportOwned(handle, transition, beforeEffect);
      }); } finally { active = false; }
    }, [], current);
  }

  async finishPreparedImport(handle: PreparedSecretImport, transition: PreparedSecretImportTransition, beforeEffect: () => void): Promise<PreparedConfigMutationReceipt> {
    const record = this.preparedImports.get(handle);
    if (!record || record.phase !== 'pending' || record.transition !== transition) throw new Error('Secret import is spent.');
    record.phase = 'committing';
    const current = () => { beforeEffect(); this.assertPreparedImportTransition(handle, transition); };
    try {
      current();
      return await this.withStoreMutations(record.publications.map(publication => publication.path),
        () => this.finishPreparedImportOwned(handle, transition, beforeEffect), [], current);
    } catch {
      record.phase = 'failed'; this.settlePreparedImport(record);
      return Object.freeze({ status: 'unknown', completedPaths: Object.freeze([]),
        ...(record.publications[0] ? { uncertainPath: record.publications[0].path } : {}) });
    }
  }
  private settlePreparedImport(record: SecretImportRecord): void {
    this.credentialMutationGeneration++;
    for (const item of record.facts.items) {
      const remaining = (this.pendingLocalMutations.get(item.key) ?? 1) - 1;
      if (remaining) this.pendingLocalMutations.set(item.key, remaining); else this.pendingLocalMutations.delete(item.key);
    }
    this.notifyCredentialInvalidation();
    if (record.phase === 'committed') for (const item of record.facts.items) this.notifyChanged(item.key, true);
  }
  private finishPreparedImportOwned(handle: PreparedSecretImport, transition: PreparedSecretImportTransition, beforeEffect: () => void): PreparedConfigMutationReceipt {
    const record = this.preparedImports.get(handle);
    if (!record || !['pending', 'committing'].includes(record.phase) || record.transition !== transition) throw new Error('Secret import is spent.');
    record.phase = 'committing'; const completedPaths: string[] = []; let uncertainPath: string | undefined;
    const current = () => { beforeEffect(); this.assertPreparedImportTransition(handle, transition); };
    try {
      current();
      for (const publication of record.publications) {
        uncertainPath = publication.path; current();
        if (publication.keyfile) writeFileSync(publication.path, publication.payload as string, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        else writeJsonFileAtomic(publication.path, publication.payload, { mode: 0o600, cleanupStaleTemps: false, assertCurrent: current });
        completedPaths.push(publication.path);
        record.observations.find(observation => observation.path === publication.path)!.observation = observeImportFile(publication.path);
      }
      record.phase = 'committed'; uncertainPath = undefined;
    } catch { record.phase = 'failed'; }
    finally { this.settlePreparedImport(record); }
    return Object.freeze({ status: record.phase === 'committed' ? 'committed' : completedPaths.length ? 'partial' : 'unknown',
      completedPaths: Object.freeze(completedPaths), ...(uncertainPath ? { uncertainPath } : {}) });
  }
  assertCompletedImport(handle: PreparedSecretImport): void {
    const record = this.preparedImports.get(handle);
    if (!record || record.phase !== 'committed' || this.pendingLocalMutations.size) throw new Error('Secret import did not commit.');
    this.assertImportRecord(record, record.facts.beforeGeneration + 2);
  }

  /** Exact physical scope only. Capture never resolves refs, repairs stores or creates a keyfile. */
  prepareScopedDeletion(key: string, scope: SecretScope): PreparedScopedSecretDeletion {
    if (!key || !['project', 'user', 'daemon'].includes(scope)) throw new Error('Invalid scoped secret deletion.');
    const state = this.getCredentialMutationState();
    if (state.pending) throw new Error('Credential owner is busy.');
    const policy = this.getPolicy();
    const stores = [this.resolveWriteTarget(scope, 'secure'), this.resolveWriteTarget(scope, 'plaintext')];
    const observations: { path: string; stamp: string }[] = [];
    const publications: { path: string; payload: unknown }[] = [];
    const keyObservation = deletionFileObservation(this.keyFilePath);
    observations.push({ path: this.keyFilePath, stamp: keyObservation.stamp });
    for (const store of stores) {
      const observed = deletionFileObservation(store.path); observations.push({ path: store.path, stamp: observed.stamp });
      if (observed.raw === null) continue;
      const parsed = JSON.parse(observed.raw) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Secret store unavailable.');
      let values: Record<string, string>; let encryptionKey: Buffer | undefined;
      if (store.secure) {
        if (parsed.version === undefined) encryptionKey = deriveLegacyEncryptionKey(this.options.legacyIdentity);
        else {
          if (parsed.version !== SECRETS_STORE_FORMAT_VERSION || !keyObservation.raw || !/^[0-9a-f]{64}$/i.test(keyObservation.raw.trim())) throw new Error('Secret store unavailable.');
          encryptionKey = Buffer.from(keyObservation.raw.trim(), 'hex');
        }
        values = JSON.parse(decrypt(parsed as unknown as EncryptedStoreEnvelope, encryptionKey)) as Record<string, string>;
      } else values = ('version' in parsed && 'secrets' in parsed ? parsed.secrets : parsed) as Record<string, string>;
      if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Secret store unavailable.');
      if (!Object.hasOwn(values, key)) continue;
      const next = { ...values }; delete next[key];
      let payload: unknown = { version: 1, secrets: next };
      if (encryptionKey) {
        const encrypted = encrypt(JSON.stringify(next), encryptionKey);
        if (parsed.version === undefined) { delete encrypted.version; delete encrypted.keyId; }
        payload = encrypted;
      }
      publications.push({ path: store.path, payload });
    }
    const handle = Object.freeze({}) as PreparedScopedSecretDeletion;
    const facts = Object.freeze({ operation: 'delete' as const, key, scope, destinations: Object.freeze(publications.map(item => Object.freeze({ path: item.path, operation: 'remove' as const, tier: scope }))) });
    this.preparedScopedDeletions.set(handle, { facts, generation: state.generation, policy, observations, publications, spent: false });
    this.assertPreparedScopedDeletion(handle); return handle;
  }

  inspectPreparedScopedDeletion(handle: PreparedScopedSecretDeletion): PreparedScopedSecretDeletionFacts {
    const entry = this.preparedScopedDeletions.get(handle); if (!entry) throw new Error('Secret deletion is not authentic.'); return entry.facts;
  }
  assertPreparedScopedDeletion(handle: PreparedScopedSecretDeletion): void {
    const entry = this.preparedScopedDeletions.get(handle);
    if (!entry || entry.spent || this.getCredentialMutationState().pending || this.credentialMutationGeneration !== entry.generation || this.getPolicy() !== entry.policy) throw new Error('Secret deletion is stale.');
    for (const observation of entry.observations) if (deletionFileObservation(observation.path).stamp !== observation.stamp) throw new Error('Secret deletion store changed.');
  }

  /** Acquire the captured file namespace outside the synchronous final owner boundary. */
  async withPreparedScopedDeletion<T>(handle: PreparedScopedSecretDeletion,
    operation: (finish: (assertCurrent: () => void) => import('./prepared-mutation.js').PreparedConfigMutationReceipt) => T): Promise<T> {
    this.assertPreparedScopedDeletion(handle);
    const entry = this.preparedScopedDeletions.get(handle)!; entry.spent = true;
    return this.withStoreMutations(entry.publications.map(item => item.path), () => {
      let consumed = false; let active = true;
      try { return operation((assertCurrent) => {
        if (!active || consumed) throw new Error('Secret deletion is spent.'); consumed = true;
        const completedPaths: string[] = []; let uncertainPath: string | undefined;
        const observations = entry.observations.map(item => ({ ...item }));
        let begun = false;
        try {
          assertCurrent();
          if (this.credentialMutationGeneration !== entry.generation || this.pendingLocalMutations.size || this.getPolicy() !== entry.policy) throw new Error('Credential owner changed.');
          this.credentialMutationGeneration++; this.pendingLocalMutations.set(entry.facts.key, 1); begun = true;
          this.notifyCredentialInvalidation();
          const current = () => {
            assertCurrent();
            if (this.credentialMutationGeneration !== entry.generation + 1 || this.pendingLocalMutations.size !== 1 || this.pendingLocalMutations.get(entry.facts.key) !== 1 || this.getPolicy() !== entry.policy) throw new Error('Credential owner changed.');
            for (const observation of observations) if (deletionFileObservation(observation.path).stamp !== observation.stamp) throw new Error('Secret deletion store changed.');
          };
          current();
          for (const publication of entry.publications) {
            current();
            writeJsonFileAtomic(publication.path, publication.payload, { mode: 0o600, cleanupStaleTemps: false });
            completedPaths.push(publication.path);
            observations.find(item => item.path === publication.path)!.stamp = deletionFileObservation(publication.path).stamp;
          }
        } catch {
          uncertainPath = entry.publications[completedPaths.length]?.path;
          return Object.freeze({ status: completedPaths.length ? 'partial' : 'unknown', completedPaths: Object.freeze(completedPaths), ...(uncertainPath ? { uncertainPath } : {}) });
        } finally {
          if (begun) {
            this.credentialMutationGeneration++;
            const remaining = (this.pendingLocalMutations.get(entry.facts.key) ?? 1) - 1;
            if (remaining) this.pendingLocalMutations.set(entry.facts.key, remaining); else this.pendingLocalMutations.delete(entry.facts.key);
            this.notifyCredentialInvalidation();
          }
          if (completedPaths.length) { try { this.notifyChanged(entry.facts.key); } catch { /* Receipt stays truthful. */ } }
        }
        entry.completed = { generation: entry.generation + 2, observations };
        return Object.freeze({ status: 'committed', completedPaths: Object.freeze(completedPaths) });
      }); } finally { active = false; }
    });
  }

  /** Restriction-only post-effect fence; never re-captures a changed credential as this plan's effect. */
  assertCompletedScopedDeletion(handle: PreparedScopedSecretDeletion): void {
    const entry = this.preparedScopedDeletions.get(handle); const completed = entry?.completed;
    if (!entry || !completed || this.credentialMutationGeneration !== completed.generation || this.pendingLocalMutations.size || this.getPolicy() !== entry.policy) throw new Error('Completed secret deletion changed.');
    for (const observation of completed.observations) if (deletionFileObservation(observation.path).stamp !== observation.stamp) throw new Error('Completed secret deletion store changed.');
  }

  applyPreparedScopedDeletion(handle: PreparedScopedSecretDeletion, assertCurrent: () => void): Promise<import('./prepared-mutation.js').PreparedConfigMutationReceipt> {
    return this.withPreparedScopedDeletion(handle, finish => finish(assertCurrent));
  }

  private encKey: Buffer | null = null;
  private readonly keyFilePath: string;
  private readonly options: SecretsManagerOptions;
  private readonly surfaceRoot: string;
  private readonly reportedUnreadableStores = new Set<string>();

  private readonly layout: SecretStoreLayout;

  constructor(options: SecretsManagerOptions) {
    this.surfaceRoot = requireSurfaceRoot(options.surfaceRoot, 'SecretsManager surfaceRoot');
    const globalHome = requireAbsoluteOwnedPath(options.globalHome, 'globalHome');
    this.options = {
      ...options,
      projectRoot: requireAbsoluteOwnedPath(options.projectRoot, 'projectRoot'),
      globalHome,
      daemonHome: normalizeOptionalOwnedPath(options.daemonHome, 'daemonHome')
        ?? defaultDaemonSecretHome(globalHome),
      secureProjectFilePath: normalizeOptionalOwnedPath(options.secureProjectFilePath, 'secureProjectFilePath'),
      secureUserFilePath: normalizeOptionalOwnedPath(options.secureUserFilePath, 'secureUserFilePath'),
      secureDaemonFilePath: normalizeOptionalOwnedPath(options.secureDaemonFilePath, 'secureDaemonFilePath'),
      plaintextProjectFilePath: normalizeOptionalOwnedPath(options.plaintextProjectFilePath, 'plaintextProjectFilePath'),
      plaintextUserFilePath: normalizeOptionalOwnedPath(options.plaintextUserFilePath, 'plaintextUserFilePath'),
      plaintextDaemonFilePath: normalizeOptionalOwnedPath(options.plaintextDaemonFilePath, 'plaintextDaemonFilePath'),
    };
    this.layout = {
      projectRoot: this.options.projectRoot,
      globalHome: this.options.globalHome,
      daemonHome: this.options.daemonHome ?? defaultDaemonSecretHome(globalHome),
      surfaceRoot: this.surfaceRoot,
      secureProjectFilePath: this.options.secureProjectFilePath,
      secureUserFilePath: this.options.secureUserFilePath,
      secureDaemonFilePath: this.options.secureDaemonFilePath,
      plaintextProjectFilePath: this.options.plaintextProjectFilePath,
      plaintextUserFilePath: this.options.plaintextUserFilePath,
      plaintextDaemonFilePath: this.options.plaintextDaemonFilePath,
    };
    this.keyFilePath = normalizeOptionalOwnedPath(options.keyFilePath, 'keyFilePath')
      ?? resolveSharedDirectory(this.options.globalHome, 'secrets.key');
    setSecretsReadSources(this, () => {
      const binding = captureSecurityReadBindings(this, ['credentialMutationGeneration', 'pendingLocalMutations', 'options', 'layout', 'keyFilePath', 'getPolicy', 'getCredentialMutationState', 'getAllCandidateStores', 'getReadOrder', 'get', 'getGlobalHome', 'getInternal', 'resolveMaybeReferencedValue', 'migrateLegacyReads', 'readEncryptedStore', 'readPlaintextStore', 'readEncryptedFile', 'readPlaintextFile', 'inspect', 'listDetailed', 'captureReadSource']);
      const state = this.getCredentialMutationState(); assertSecurityReadSource(!state.pending);
      const optionsBinding = captureSecurityReadBindings(this.options, Reflect.ownKeys(this.options).filter((key): key is string => typeof key === 'string'));
      const paths = [...new Set([...this.getAllCandidateStores().map(store => store.path), this.keyFilePath])];
      const filesCurrent = captureSecurityReadFiles(paths), environmentCurrent = captureSecurityReadData(() => Object.keys(process.env).sort());
      const policy = this.getPolicy();
      return () => {
        binding(); optionsBinding(); filesCurrent(); environmentCurrent();
        const current = this.getCredentialMutationState();
        assertSecurityReadSource(!current.pending && current.generation === state.generation && this.getPolicy() === policy);
        binding(); optionsBinding();
      };
    });
  }

  /** Load the encryption key, generating a fresh one exclusively on first need, see secrets-keyfile.ts. */
  private getEncryptionKey(): Buffer {
    this.encKey ??= loadOrCreateKeyfile(this.keyFilePath);
    return this.encKey;
  }

  getGlobalHome(): string {
    return this.options.globalHome;
  }

  async get(key: string): Promise<string | null> {
    const current = captureSecurityReadBindings(this, ['getReadOrder', 'migrateLegacyReads', 'getInternal']);
    const readOrder = this.getReadOrder, migrate = this.migrateLegacyReads, read = this.getInternal;
    current();
    if (process.env[key] === undefined) await migrate.call(this, readOrder.call(this));
    current();
    const value = await read.call(this, key, new Set([key]));
    current(); return value;
  }

  /** Atomic first creation for daemon-owned material, shared across process creators.
   * References and unreadable tiers cannot be treated as missing material.
   * This does not authorize replacing an existing key or changing its scope.
   */
  async getOrCreateDaemonSecret(key: string, create: () => string, assertCurrent?: () => void): Promise<string> {
    const guard = () => {
      const result: unknown = assertCurrent?.();
      if (result !== undefined) { void Promise.resolve(result).catch(() => {}); throw new Error('Daemon key ownership must be checked synchronously.'); }
    };
    guard();
    const policy = this.getPolicy();
    const paths = this.writeStorePaths('daemon', 'secure', policy);
    return this.withStoreMutations(paths, () => {
      guard();
      if (this.getPolicy() !== policy) throw new Error('Secret storage policy changed during acquisition');
      const current = this.resolveLocalSecretSync(key);
      if (current.state === 'unsupported') throw new Error('Daemon key material is unavailable; existing material was preserved.');
      if (current.state === 'resolved') return current.value;
      const value = create();
      guard();
      this.setOwned(key, value, { scope: 'daemon', medium: 'secure' }, assertCurrent ? { beforeWrite: guard, committed: () => {} } : undefined);
      return value;
    }, paths.slice(1), guard);
  }

  /**
   * Synchronous credential-owner fence for a local literal only. This follows
   * the same local precedence as get(), but never follows references, launches
   * commands, or contacts a secret provider. Keep the value inside credential
   * ownership; it is not an identity or provenance snapshot.
   */
  resolveLocalSecretSync(key: string):
    | { readonly state: 'resolved'; readonly value: string }
    | { readonly state: 'absent' | 'unsupported' } {
    const capture = (value: unknown): ReturnType<SecretsManager['resolveLocalSecretSync']> =>
      typeof value !== 'string' || isSecretRefInput(value)
        ? { state: 'unsupported' }
        : { state: 'resolved', value };
    if (process.env[key] !== undefined) return capture(process.env[key]);
    if (this.pendingLocalMutations.has(key)) return { state: 'unsupported' };
    for (const path of this.getReadOrder()) {
      const result = path.secure ? this.readEncryptedStore(path.path) : this.readPlaintextStore(path.path);
      if (result.status === 'unreadable') return { state: 'unsupported' };
      if (result.status === 'ok' && key in result.secrets) return capture(result.secrets[key]);
    }
    return { state: 'absent' };
  }

  /** Local alias-aware observation. Private credential bytes never become judgment facts. */
  resolveLocalCredentialSnapshot(key: string):
    | { readonly state: 'resolved'; readonly value: string; readonly revision: string }
    | { readonly state: 'absent'; readonly revision: string }
    | { readonly state: 'unsupported' } {
    const chain: unknown[] = [this.getPolicy(), this.credentialMutationGeneration];
    const seen = new Set<string>();
    const revision = () => createHash('sha256').update(JSON.stringify(chain)).digest('hex');
    let current = key;
    for (let depth = 0; depth < 32; depth++) {
      if (seen.has(current) || this.pendingLocalMutations.has(current) || process.env[current] !== undefined) return { state: 'unsupported' };
      seen.add(current);
      let value: string | undefined;
      for (const path of this.getReadOrder()) {
        const result = path.secure ? this.readEncryptedStore(path.path) : this.readPlaintextStore(path.path);
        if (result.status === 'unreadable') return { state: 'unsupported' };
        const found = result.status === 'ok' && Object.hasOwn(result.secrets, current);
        chain.push([current, path.path, path.secure, found]);
        if (found) { value = result.secrets[current]; break; }
      }
      if (value === undefined) return depth === 0 ? { state: 'absent', revision: revision() } : { state: 'unsupported' };
      if (typeof value !== 'string') return { state: 'unsupported' };
      chain.push(value);
      if (!isSecretRefInput(value)) return { state: 'resolved', value, revision: revision() };
      const ref = normalizeSecretRef(value);
      if (!ref || ref.source !== 'goodvibes') return { state: 'unsupported' };
      current = ref.id;
    }
    return { state: 'unsupported' };
  }

  /**
   * Read `key` from ONE tier, ignoring the read order and the environment.
   *
   * `get()` answers "what value would be used", which is the right question
   * almost everywhere and the wrong one for migration: a surface copy read
   * through `get()` returns whatever the DAEMON tier holds, because the daemon
   * tier leads. Moving a credential needs to see each tier separately, read
   * the surface copy, write the daemon copy, read the daemon copy BACK and
   * compare, and a resolver that transparently prefers one tier makes that
   * comparison meaningless.
   *
   * Returns the value exactly as stored. A `goodvibes://` reference is NOT
   * followed: migration moves the stored bytes, and following a reference here
   * would copy the pointed-at value over the pointer.
   */
  async getFromScope(key: string, scope: SecretScope, storePath?: string): Promise<string | null> {
    const current = captureSecurityReadBindings(this, ['migrateLegacyReads', 'getMigratableStores', 'readEncryptedFile', 'readPlaintextFile']);
    const migrate = this.migrateLegacyReads, stores = this.getMigratableStores;
    current(); await migrate.call(this, stores.call(this).filter(store => storePath !== undefined ? store.path === storePath : store.scope === scope));
    current();
    for (const path of stores.call(this)) {
      if (storePath !== undefined ? path.path !== storePath : path.scope !== scope) continue;
      const secrets = path.secure ? this.readEncryptedFile(path.path) : this.readPlaintextFile(path.path);
      if (secrets !== null && key in secrets) return secrets[key] ?? null;
    }
    return null;
  }

  private async getInternal(key: string, seen: Set<string>): Promise<string | null> {
    const envValue = process.env[key]!;
    if (envValue !== undefined) {
      logger.debug('SecretsManager: resolved from env', { key });
      return this.resolveMaybeReferencedValue(key, envValue, seen);
    }

    for (const path of this.getReadOrder()) {
      const secrets = path.secure
        ? this.readEncryptedFile(path.path)
        : this.readPlaintextFile(path.path);
      if (secrets !== null && key in secrets) {
        logger.debug('SecretsManager: resolved from store', { key, source: path.source });
        const value = secrets[key]!;
        return value === undefined ? null : this.resolveMaybeReferencedValue(key, value, seen);
      }
    }

    return null;
  }

  private async resolveMaybeReferencedValue(key: string, value: string, seen: Set<string>): Promise<string | null> {
    const current = captureSecurityReadBindings(this, ['options', 'getInternal']);
    const optionsCurrent = captureSecurityReadBindings(this.options, ['globalHome', 'diagnosticMode']);
    const read = this.getInternal;
    const assertCurrent = () => { current(); optionsCurrent(); };
    assertCurrent();
    if (!isSecretRefInput(value)) return value;

    try {
      const resolved = await resolveSecretRef(value, {
        resolveLocalSecret: async (nextKey) => {
          assertCurrent();
          if (seen.has(nextKey)) {
            throw new Error(`Recursive GoodVibes secret reference for ${nextKey}`);
          }
          const nextSeen = new Set(seen);
          nextSeen.add(nextKey);
          const resolved = await read.call(this, nextKey, nextSeen);
          assertCurrent(); return resolved;
        },
        homeDirectory: this.options.globalHome,
      });
      assertCurrent();
      logger.debug('SecretsManager: resolved secret reference', { key, refSource: resolved.source });
      return resolved.value;
    } catch (error) {
      assertCurrent();
      logger.warn('SecretsManager: failed to resolve secret reference', {
        key,
        refSource: getSecretRefSource(value) ?? 'unknown',
        ...(this.options.diagnosticMode === 'structural' ? { reason: 'resolution-failed' } : { error: summarizeError(error) }),
      });
      return null;
    }
  }

  private readonly writeTransitions = new WeakMap<SecretWriteTransition, { readonly assertCurrent: () => void; readonly facts: () => SecretWriteTransitionFacts }>();
  assertWriteTransition(transition: SecretWriteTransition): void {
    const record = this.writeTransitions.get(transition);
    if (!record) throw new Error('Secret write transition is not authentic.');
    record.assertCurrent();
  }
  inspectWriteTransition(transition: SecretWriteTransition): SecretWriteTransitionFacts {
    this.assertWriteTransition(transition);
    return this.writeTransitions.get(transition)!.facts();
  }

  async set(key: string, value: string, options: SecretWriteOptions = {}): Promise<void> {
    const assertCurrent = options.assertCurrent;
    const current = () => {
      const result: unknown = assertCurrent?.();
      if (result !== undefined) { void Promise.resolve(result).catch(() => {}); throw new Error('Secret write ownership must be checked synchronously.'); }
    };
    current();
    const scope = resolveSecretWriteScope(key, options.scope);
    const policy = this.getPolicy();
    const medium = options.medium ?? this.getDefaultWriteMedium(policy);
    if (policy === 'require_secure' && medium === 'plaintext') throw new Error('Secret policy require_secure forbids plaintext persistence');
    const paths = this.writeStorePaths(scope, medium, policy);
    const effect = options.effect;
    if (!effect) {
      await this.withCredentialMutation(key, () => this.withStoreMutations(paths, () => {
        current();
        if (this.getPolicy() !== policy) throw new Error('Secret storage policy changed during acquisition');
        this.setOwned(key, value, { ...options, medium });
      }, paths.slice(1)));
      return;
    }
    const before = this.getCredentialMutationState();
    if (before.pending) throw new Error('Credential owner is busy.');
    const observed = [...new Set([...paths, this.keyFilePath])].map(path => ({ path, stamp: deletionFileObservation(path).stamp }));
    let phase: 'prepared' | 'pending' | 'committed' | 'failed' = 'prepared';
    const transition = Object.freeze({}) as SecretWriteTransition;
    const assertTransition = () => {
      const state = this.getCredentialMutationState();
      const offset = phase === 'pending' ? 1 : phase === 'committed' ? 2 : 0;
      if (phase === 'failed' || this.getPolicy() !== policy || state.generation !== before.generation + offset
        || (phase === 'pending' ? this.pendingLocalMutations.size !== 1 || this.pendingLocalMutations.get(key) !== 1 : state.pending)) throw new Error('Secret write owner changed.');
      for (const item of observed) if (deletionFileObservation(item.path).stamp !== item.stamp) throw new Error('Secret write destination changed.');
    };
    this.writeTransitions.set(transition, { assertCurrent: assertTransition,
      facts: () => Object.freeze({ key, scope, paths: Object.freeze([...paths]), beforeGeneration: before.generation, phase: phase as 'prepared' | 'pending' | 'committed' }),
    });
    let published = false;
    try {
      assertTransition();
      const owner = effect(transition), assertEffect = owner.assertCurrent, committed = owner.committed;
      const checkEffect = () => {
        const result: unknown = assertEffect();
        if (result !== undefined) { void Promise.resolve(result).catch(() => {}); throw new Error('Secret write effect ownership must be synchronous.'); }
      };
      checkEffect(); assertTransition();
      phase = 'pending';
      await this.withCredentialMutation(key, () => {
        assertTransition(); checkEffect(); assertTransition();
        return this.withStoreMutations(paths, () => {
        // Intent and its invalidation notifications already happened. Only this
        // exact +1 mutation may remain pending; listeners cannot add a rival.
        assertTransition(); checkEffect(); assertTransition();
        this.setOwned(key, value, { scope, medium }, {
          beforeWrite: () => { assertTransition(); checkEffect(); assertTransition(); },
          committed: () => { published = true; for (const item of observed) item.stamp = deletionFileObservation(item.path).stamp; },
        });
        }, paths.slice(1));
      });
      phase = 'committed'; assertTransition();
      // Receipt is consumed only after the matching settlement generation.
      const settled: unknown = committed();
      if (settled !== undefined) { void Promise.resolve(settled).catch(() => {}); throw new Error('Secret write settlement must be synchronous.'); }
    } catch (error) {
      phase = 'failed';
      if (published) throw new SecretWriteCommittedError();
      throw error;
    }

  }

  /** A legacy read rewrites a whole file too. Re-read after acquiring its
   * actual mutation namespace, never publish the pre-lock snapshot.
   * Failed migration retains readable legacy material, as before.
   */
  private async migrateLegacyReads(stores: readonly SecretStorePath[]): Promise<void> {
    const current = captureSecurityReadBindings(this, ['withStoreMutations', 'readEncryptedStore']);
    const mutate = this.withStoreMutations, read = this.readEncryptedStore;
    for (const store of stores) {
      current();
      if (!store.secure) continue;
      try {
        const envelope = JSON.parse(readFileSync(store.path, 'utf8')) as Partial<EncryptedStoreEnvelope> | null;
        if (!envelope || envelope.version !== undefined) continue;
        await mutate.call(this, [store.path], () => { current(); return read.call(this, store.path); }, [], current);
        current();
      } catch { current(); /* Ordinary read below reports unreadable material; no replacement. */ }
    }
  }

  private writeStorePaths(scope: SecretScope, medium: SecretStorageMedium, policy: SecretStorageMode): string[] {
    const target = this.resolveWriteTarget(scope, medium);
    return [target.path, ...(target.secure && policy === 'preferred_secure'
      ? [this.resolveWriteTarget(scope, 'plaintext').path] : [])];
  }

  /** Lock actual whole-file mutation targets; independent homes may share a tier. */
  private async withStoreMutations<T>(paths: readonly string[], operation: () => T, optionalPaths: readonly string[] = [], assertCurrent?: () => void): Promise<T> {
    const owned: string[] = [];
    const releases: Array<() => void> = [];
    try {
      for (const path of [...new Set(paths)].sort()) {
        assertCurrent?.();
        try {
          mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
          releases.push(await acquireCrossProcessLock(`${path}.mutation.lock`, { strictOwnership: true, totalTimeoutMs: 10_000 }));
          assertCurrent?.();
          owned.push(path);
        } catch (error) {
          // An unusable fallback must not prevent a valid secure write. A busy
          // lock is never bypassed, and this target remains unwritable below.
          if (path === paths[0] || !optionalPaths.includes(path)
            || !['EEXIST', 'ENOTDIR', 'EACCES', 'EPERM', 'EROFS'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        }
      }
      for (const path of owned) this.ownedMutationPaths.add(path);
      return operation();
    } finally {
      for (const path of owned) this.ownedMutationPaths.delete(path);
      for (const release of releases.reverse()) release();
    }
  }

  private setOwned(key: string, value: string, options: SecretWriteOptions, effect?: { readonly beforeWrite: () => void; readonly committed: () => void }): void {
    const policy = this.getPolicy();
    const medium = options.medium ?? this.getDefaultWriteMedium(policy);
    const scope = resolveSecretWriteScope(key, options.scope);
    if (secretWriteScopeWasOverridden(key, options.scope)) {
      // Disclosed, not silent: the caller asked for one home and the credential
      // went to another, and it did so because the other one is the only home
      // the daemon reads. See resolveSecretWriteScope.
      logger.info('SecretsManager: daemon-owned credential filed in the daemon tier', {
        key,
        requestedScope: options.scope,
        actualScope: scope,
        reason: describeCredentialScope(key),
      });
    }

    if (policy === 'require_secure' && medium === 'plaintext') {
      throw new Error('Secret policy require_secure forbids plaintext persistence');
    }

    const target = this.resolveWriteTarget(scope, medium);
    const existing = this.readStoreForWrite(target);
    existing[key] = value;

    try {
      effect?.beforeWrite();
      if (target.secure) {
        this.writeEncryptedFile(target.path, existing);
      } else {
        this.writePlaintextFile(target.path, existing);
      }
      effect?.committed();
      logger.debug('SecretsManager: stored secret', { key, source: target.source });
      this.notifyChanged(key);
      return;
    } catch (error) {
      if (policy === 'preferred_secure' && target.secure && !(error instanceof SecretStoreUnreadableError)) {
        const fallback = this.resolveWriteTarget(scope, 'plaintext');
        if (!this.ownedMutationPaths.has(fallback.path)) throw error;
        const fallbackExisting = this.readStoreForWrite(fallback);
        fallbackExisting[key] = value;
        effect?.beforeWrite();
        this.writePlaintextFile(fallback.path, fallbackExisting);
        effect?.committed();
        logger.warn('SecretsManager: secure write failed, fell back to plaintext', {
          key,
          path: fallback.path,
          error: summarizeError(error),
        });
        this.notifyChanged(key);
        return;
      }
      throw error;
    }
  }

  /**
   * Load a store's current contents ahead of a write. A missing file is a
   * legitimately empty store; a file that exists but cannot be read refuses
   * the write outright, overwriting it would destroy every secret it holds.
   */
  private readStoreForWrite(target: SecretStorePath): Record<string, string> {
    const result = target.secure
      ? this.readEncryptedStore(target.path)
      : this.readPlaintextStore(target.path);
    if (result.status === 'unreadable') {
      throw new SecretStoreUnreadableError(
        `Refusing to write to the secrets store at ${target.path}: the file exists but cannot be read (${result.reason}). Overwriting it would destroy its contents; restore or move the file first.`,
      );
    }
    return result.status === 'ok' ? { ...result.secrets } : {};
  }

  async list(): Promise<string[]> {
    const current = captureSecurityReadBindings(this, ['migrateLegacyReads', 'getReadOrder', 'readEncryptedFile', 'readPlaintextFile']);
    const migrate = this.migrateLegacyReads, stores = this.getReadOrder;
    current(); await migrate.call(this, stores.call(this)); current();
    const keys = new Set<string>();
    for (const path of this.getReadOrder()) {
      const values = path.secure
        ? this.readEncryptedFile(path.path)
        : this.readPlaintextFile(path.path);
      if (!values) continue;
      for (const key of Object.keys(values)) keys.add(key);
    }
    return [...keys].sort((a, b) => a.localeCompare(b));
  }

  async listDetailed(): Promise<SecretRecord[]> {
    const current = captureSecurityReadBindings(this, ['migrateLegacyReads', 'getReadOrder', 'readEncryptedFile', 'readPlaintextFile']);
    const migrate = this.migrateLegacyReads, stores = this.getReadOrder;
    current(); await migrate.call(this, stores.call(this)); current();
    const envKeys = new Set(Object.keys(process.env));
    const records: SecretRecord[] = [];

    for (const path of this.getReadOrder()) {
      const values = path.secure
        ? this.readEncryptedFile(path.path)
        : this.readPlaintextFile(path.path);
      if (!values) continue;
      for (const key of Object.keys(values)) {
        const refSource = getSecretRefSource(values[key]!);
        records.push({
          key,
          source: path.source,
          scope: path.scope,
          secure: path.secure,
          path: path.path,
          overriddenByEnv: envKeys.has(key),
          ...(refSource ? { refSource } : {}),
        });
      }
    }

    for (const key of envKeys) {
      records.push({
        key,
        source: 'env',
        scope: 'env',
        secure: false,
        overriddenByEnv: false,
      });
    }

    return records.sort((a, b) => a.key.localeCompare(b.key) || a.source.localeCompare(b.source));
  }

  async inspect(): Promise<SecretStorageReview> {
    const current = captureSecurityReadBindings(this, ['migrateLegacyReads', 'getAllCandidateStores', 'getPolicy', 'listDetailed', 'readEncryptedStore', 'readPlaintextStore']);
    const migrate = this.migrateLegacyReads, stores = this.getAllCandidateStores, list = this.listDetailed;
    current(); await migrate.call(this, stores.call(this)); current();
    const policy = this.getPolicy();
    current(); const records = await list.call(this); current();
    const storedRecords = records.filter((record) => record.source !== 'env');
    const storeStates = this.getAllCandidateStores().map((store) => ({
      store,
      result: store.secure ? this.readEncryptedStore(store.path) : this.readPlaintextStore(store.path),
    }));
    const locations = storeStates.map(({ store, result }) => ({
      source: store.source,
      path: store.path,
      exists: existsSync(store.path),
      readable: result.status === 'ok',
    }));
    const warnings: string[] = [];
    for (const { store, result } of storeStates) {
      if (result.status === 'unreadable') {
        warnings.push(`store at ${store.path} exists but cannot be read (${result.reason})`);
      }
    }
    if (policy === 'preferred_secure' && storedRecords.some((record) => !record.secure)) {
      warnings.push('plaintext fallback secrets are present');
    }
    if (policy === 'require_secure' && storedRecords.some((record) => !record.secure)) {
      warnings.push('plaintext secrets exist but are ignored by current policy');
    }

    return {
      policy,
      secureAvailable: true,
      storedKeys: new Set(storedRecords.map((record) => record.key)).size,
      envBackedKeys: new Set(records.filter((record) => record.source === 'env').map((record) => record.key)).size,
      secureKeys: new Set(storedRecords.filter((record) => record.secure).map((record) => record.key)).size,
      plaintextKeys: new Set(storedRecords.filter((record) => !record.secure).map((record) => record.key)).size,
      warnings,
      locations,
    };
  }

  /**
   * REVOKE. Removes the credential everywhere it can be reached.
   *
   * For a daemon-needed key the caller's `scope` is deliberately DISCARDED and
   * every tier is swept, because a revoke narrowed to one tier reports success
   * while leaving a live copy behind, a credential the operator believes is
   * gone and is not.
   *
   * That makes this the wrong method for moving a credential between tiers, and
   * the difference is not visible at the call site: the migration's "remove the
   * surface copy now the daemon copy is verified" was spelled
   * `delete(key, { scope: source })`, the key was daemon-needed by definition,
   * so the sweep ran and destroyed the daemon copy it had just written and
   * read back. Both stores ended empty while the report said `migrated: 1,
   * failed: 0`. Use `deleteFromScope` to remove ONE physical copy.
   */
  async delete(key: string, options: SecretDeleteOptions = {}): Promise<void> {
    const scopeFilter = isDaemonNeededSecretKey(key) ? undefined : options.scope;
    const stores = this.getAllCandidateStores().filter((store) => {
      if (scopeFilter && store.scope !== scopeFilter) return false;
      if (options.medium && (options.medium === 'secure') !== store.secure) return false;
      return existsSync(store.path) && this.storeContainsKey(store, key);
    });
    await this.withCredentialMutation(key, () => this.withStoreMutations(stores.map(store => store.path), () => this.deleteOwned(key, stores)));
  }

  private storeContainsKey(store: SecretStorePath, key: string): boolean {
    // Preserve no-op deletion from unrelated/read-only tiers. Re-read under
    // ownership before changing any selected file, so unrelated writes survive.
    const values = store.secure ? this.readEncryptedFile(store.path) : this.readPlaintextFile(store.path);
    return values !== null && Object.hasOwn(values, key);
  }

  private deleteOwned(key: string, stores: readonly SecretStorePath[]): void {
    let removed = false;
    for (const store of stores) {
      const values = store.secure
        ? this.readEncryptedFile(store.path)
        : this.readPlaintextFile(store.path);
      if (!values || !(key in values)) continue;
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (values as Record<string, unknown>)[key];
      if (store.secure) this.writeEncryptedFile(store.path, values);
      else this.writePlaintextFile(store.path, values);
      logger.debug('SecretsManager: deleted secret', { key, source: store.source });
      removed = true;
    }
    if (removed) this.notifyChanged(key);
  }

  /**
   * Remove ONE tier's copy, and never any other. The narrow counterpart to
   * `delete`: that one means "this credential is revoked" and sweeps every
   * tier; this means "this copy is redundant, the real one is elsewhere".
   * A separate method because the two were indistinguishable at the call site,
   * and the migration reached for the wrong one. Migration is the only caller.
   */
  async deleteFromScope(key: string, scope: SecretScope, storePath?: string): Promise<void> {
    const stores = this.getMigratableStores().filter(store =>
      (storePath !== undefined ? store.path === storePath : store.scope === scope)
      && existsSync(store.path) && this.storeContainsKey(store, key));
    await this.withCredentialMutation(key, () => this.withStoreMutations(stores.map(store => store.path), () => this.deleteFromScopeOwned(key, stores)));
  }

  private deleteFromScopeOwned(key: string, stores: readonly SecretStorePath[]): void {
    let removed = false;
    for (const store of stores) {
      const values = store.secure ? this.readEncryptedFile(store.path) : this.readPlaintextFile(store.path);
      if (!values || !(key in values)) continue;
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (values as Record<string, unknown>)[key];
      if (store.secure) this.writeEncryptedFile(store.path, values);
      else this.writePlaintextFile(store.path, values);
      logger.debug('SecretsManager: removed one tier copy', { key, source: store.source });
      removed = true;
    }
    if (removed) this.notifyChanged(key);
  }

  private getPolicy(): SecretStorageMode {
    return this.options.policy ?? loadConfiguredSecretPolicy(this.options.configManager);
  }

  private getReadOrder(): SecretStorePath[] {
    return secretReadOrder(this.layout, this.getPolicy() !== 'require_secure');
  }

  private getAllCandidateStores(): SecretStorePath[] {
    return allSecretStores(this.layout);
  }

  /** Every store a MIGRATION may look in, including other surfaces' silos. */
  private getMigratableStores(): SecretStorePath[] {
    return migratableStores(this.layout, this.getAllCandidateStores());
  }

  /** Every credential a migration could move, across every surface's silo. */
  async listDetailedForMigration(): Promise<SecretRecord[]> {
    const current = captureSecurityReadBindings(this, ['migrateLegacyReads', 'getMigratableStores', 'readEncryptedFile', 'readPlaintextFile']);
    const migrate = this.migrateLegacyReads, stores = this.getMigratableStores;
    current(); await migrate.call(this, stores.call(this)); current();
    return listMigratableSecrets(
      this.getMigratableStores(),
      (path, secure) => (secure ? this.readEncryptedFile(path) : this.readPlaintextFile(path)),
    );
  }

  private resolveWriteTarget(scope: SecretScope, medium: SecretStorageMedium): SecretStorePath {
    return secretWriteTarget(this.layout, scope, medium);
  }

  private getDefaultWriteMedium(policy: SecretStorageMode): SecretStorageMedium {
    return policy === 'plaintext_allowed' ? 'plaintext' : 'secure';
  }

  /**
   * Read an encrypted store with three distinct outcomes: `ok` (decrypted),
   * `missing` (no file, a legitimately empty store), and `unreadable` (a file
   * exists but cannot be decrypted or parsed). Unreadable is never collapsed
   * into empty: writes to an unreadable store are refused so its contents are
   * never destroyed.
   *
   * Legacy stores (no `version` field, host-identity key) are migrated in
   * place on first successful read: decrypted with the legacy key, then
   * re-encrypted under the keyfile.
   */
  private readEncryptedStore(filePath: string): SecureStoreReadResult {
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
      return { status: 'unreadable', reason: summarizeError(err) };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { status: 'unreadable', reason: 'store file is not valid JSON' };
    }
    if (!parsed || typeof parsed !== 'object') {
      return { status: 'unreadable', reason: 'store file has an unrecognized shape' };
    }
    const envelope = parsed as Partial<EncryptedStoreEnvelope>;
    if (typeof envelope.iv !== 'string' || typeof envelope.tag !== 'string' || typeof envelope.data !== 'string') {
      return { status: 'unreadable', reason: 'store file has an unrecognized shape' };
    }

    if (envelope.version === undefined) {
      return this.migrateLegacyStore(filePath, envelope as EncryptedStoreEnvelope);
    }
    if (envelope.version !== SECRETS_STORE_FORMAT_VERSION) {
      return {
        status: 'unreadable',
        reason: `store format version ${envelope.version} is not supported by this SDK version`,
      };
    }

    // Fingerprint fast-path: when the store records which key wrote it, a
    // mismatch is reported precisely instead of surfacing later as a bare
    // GCM authentication failure. Stores without keyId decrypt as before.
    const currentKeyId = keyFingerprint(this.getEncryptionKey());
    if (typeof envelope.keyId === 'string' && envelope.keyId !== currentKeyId) {
      return {
        status: 'unreadable',
        reason: `store was written with encryption key ${envelope.keyId}, but the current keyfile is ${currentKeyId}, the keyfile changed after this store was written`,
      };
    }

    try {
      const secrets = JSON.parse(decrypt(envelope as EncryptedStoreEnvelope, this.getEncryptionKey())) as Record<string, string>;
      return { status: 'ok', secrets };
    } catch (err) {
      return {
        status: 'unreadable',
        reason: `cannot decrypt with the current keyfile (${summarizeError(err)})`,
      };
    }
  }

  private migrateLegacyStore(filePath: string, envelope: EncryptedStoreEnvelope): SecureStoreReadResult {
    let plaintext: string;
    try {
      plaintext = decrypt(envelope, deriveLegacyEncryptionKey(this.options.legacyIdentity));
    } catch {
      return {
        status: 'unreadable',
        reason: 'legacy store cannot be decrypted with this machine\'s hostname and username (they changed since the store was written)',
      };
    }
    let secrets: Record<string, string>;
    try {
      secrets = JSON.parse(plaintext) as Record<string, string>;
    } catch {
      return { status: 'unreadable', reason: 'legacy store decrypted to malformed content' };
    }
    if (!this.ownedMutationPaths.has(filePath)) return { status: 'ok', secrets };
    try {
      this.writeEncryptedFile(filePath, secrets);
      logger.info('SecretsManager: migrated legacy encrypted secrets store to keyfile encryption', { path: filePath });
    } catch (error) {
      logger.warn('SecretsManager: decrypted legacy store but could not rewrite it under the keyfile', {
        path: filePath,
        ...(this.options.diagnosticMode === 'structural' ? { reason: 'store-rewrite-failed' } : { error: summarizeError(error) }),
      });
    }
    return { status: 'ok', secrets };
  }

  /**
   * Lookup-flavored read: returns the secrets when readable, null otherwise.
   * An unreadable store logs one honest error per file per process; it is
   * never mistaken for an empty store on the write path (see set/delete).
   */
  private readEncryptedFile(filePath: string): Record<string, string> | null {
    const result = this.readEncryptedStore(filePath);
    if (result.status === 'ok') return result.secrets;
    if (result.status === 'unreadable') this.reportUnreadableStore(filePath, result.reason);
    return null;
  }

  private reportUnreadableStore(filePath: string, reason: string): void {
    if (this.reportedUnreadableStores.has(filePath)) return;
    this.reportedUnreadableStores.add(filePath);
    logger.error('SecretsManager: store exists but cannot be read; its secrets are unavailable and the file will not be overwritten', {
      path: filePath,
      reason: this.options.diagnosticMode === 'structural' ? 'secret store could not be read' : reason,
    });
  }

  private writeEncryptedFile(filePath: string, secrets: Record<string, string>): void {
    const key = this.getEncryptionKey();
    // Never encrypt with a cached key the keyfile no longer backs, the
    // resulting store would be unreadable by every other process (and by this
    // one after restart). A missing keyfile is restored from the cached key.
    assertCachedKeyIsCurrent(this.keyFilePath, key);
    const store = encrypt(JSON.stringify(secrets), key);
    // The 0700 directory mode is this store's own; the helper only creates the
    // directory when it is missing, so establishing it here keeps the mode.
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    writeJsonFileAtomic(filePath, store, { mode: 0o600 });
  }

  private readPlaintextStore(filePath: string): PlaintextStoreReadResult {
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
      return { status: 'unreadable', reason: summarizeError(err) };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { status: 'unreadable', reason: 'store file is not valid JSON' };
    }
    if (!parsed || typeof parsed !== 'object') {
      return { status: 'unreadable', reason: 'store file has an unrecognized shape' };
    }
    if ('version' in parsed && 'secrets' in parsed) {
      const secrets = (parsed as PlaintextStore).secrets;
      return secrets && typeof secrets === 'object'
        ? { status: 'ok', secrets }
        : { status: 'unreadable', reason: 'store file has an unrecognized shape' };
    }
    return { status: 'ok', secrets: parsed as Record<string, string> };
  }

  private readPlaintextFile(filePath: string): Record<string, string> | null {
    const result = this.readPlaintextStore(filePath);
    if (result.status === 'ok') return result.secrets;
    if (result.status === 'unreadable') this.reportUnreadableStore(filePath, result.reason);
    return null;
  }

  private writePlaintextFile(filePath: string, secrets: Record<string, string>): void {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    const payload: PlaintextStore = { version: 1, secrets };
    writeJsonFileAtomic(filePath, payload, { mode: 0o600 });
  }
}

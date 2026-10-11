/**
 * pairing/pairing-token-store.ts
 *
 * Per-pairing operator tokens: every device/browser that pairs mints its OWN
 * named, individually-revocable token, instead of everyone sharing the one
 * operator token. Revoking one device leaves the others working.
 *
 * Custody: only a SHA-256 hash of each token is persisted. The plaintext secret
 * is returned exactly once, at mint time (for the QR / pairing hand-off); after
 * that the daemon authenticates by hashing the presented token and looking the
 * hash up, so the listable record never contains the secret. `list()` hands
 * back name / created / last-seen only, never the hash, never the secret.
 *
 * Revocation is immediate: `revoke()` deletes the record, so the very next
 * `authenticate()` of that token misses and the request is unauthorized.
 *
 * The legacy single shared token keeps working (authenticated elsewhere) until
 * it is revoked here via `revokeLegacyShared()`; a client on the shared token
 * calls `mintForMigration()` once to move to its own per-device token.
 *
 * Storage is synchronous JSON at mode 0600 (the same custody posture as the
 * shared operator token file), because the auth path that consults it is itself
 * synchronous. Every writer reloads under a shared ownership lock, persists
 * atomically, then publishes its new in-memory index. Native launches hold the
 * same lock across their final authorization/launch boundary.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, rmdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AtomicWriteDurabilityError, confirmFileDurable, readJsonFileOrQuarantine, writeJsonFileAtomic } from '../utils/atomic-json-store.js';
import { logger } from '../utils/logger.js';
import { SettingsAuthorityUnavailableError, runSynchronousSettingsOperation } from '../security/settings-authority.js';

const TOKEN_PREFIX = 'gvp_';
/** Do not thrash the disk stamping last-seen on every request. */
const LAST_SEEN_FLUSH_INTERVAL_MS = 10_000;

/** A per-pairing token as stored on disk, the hash, never the secret. */
interface StoredPairingToken {
  readonly id: string;
  name: string;
  /** SHA-256 hex of the token value. The plaintext is never persisted. */
  readonly tokenHash: string;
  readonly createdAt: number;
  lastSeenAt?: number | undefined;
}

interface PairingOwnerLock {
  assertOwned(): void;
  release(): void;
}

/** Private delegation receipt. The identifier alone grants nothing. */
export interface NativeContinuationGrant { readonly id: string; readonly binding: string; }
export interface NativeContinuationAuthority extends AuthenticatedNativePairingToken { readonly scopes: readonly string[]; }
interface StoredNativeContinuationGrant extends NativeContinuationGrant {
  readonly sourceBinding: string;
  readonly successorSourceBinding: string | null;
  readonly parent: (NativeContinuationGrant & { readonly consumption: string }) | null;
  readonly tokenId: string;
  readonly tokenRevision: string;
  readonly ownerRoot: string;
  readonly watchBinding: string | null;
  readonly scopes: readonly string[];
  readonly createdAt: number;
  readonly consumption: string | null;
  readonly revoked: boolean;
}

interface PairingTokenSnapshot {
  /** Host-issued only, retained as tombstones after consumption/revocation. */
  continuations?: StoredNativeContinuationGrant[];
  /** Explicit native cancellation is irreversible for this exact source incarnation. */
  revokedNativeSources?: string[];

  tokens: StoredPairingToken[];
  /** Once true, the legacy single shared token no longer authenticates. */
  legacyRevoked?: boolean | undefined;
}

/** The redacted, wire-safe view of a pairing token, no hash, no secret. */
export interface PublicPairingToken {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  readonly lastSeenAt?: number | undefined;
}

/** The result of minting a token, the ONLY time the plaintext secret is exposed. */
export interface MintedPairingToken {
  readonly id: string;
  readonly name: string;
  /** The plaintext token, returned once, never stored, never listed again. */
  readonly token: string;
  readonly createdAt: number;
}

/** Private native authority identity. It never carries the token or its hash. */
export interface AuthenticatedNativePairingToken {
  readonly kind: 'pairing-token';
  readonly tokenId: string;
  readonly principalId: string;
  readonly authorityId: string;
  /** The unique persisted pairing ID is its incarnation, not an invented epoch. */
  readonly authorityRevision: string;
}

declare const settingsPairingAuthorityBrand: unique symbol;
/** Opaque owner-current precondition, not permission to execute an effect. */
export interface SettingsPairingAuthority {
  readonly kind: 'shared-token' | 'pairing-token';
  readonly [settingsPairingAuthorityBrand]: true;
}
interface SettingsPairingAuthorityRecord {
  readonly kind: 'shared-token' | 'pairing-token';
  readonly hash?: string;
  readonly id?: string;
  readonly createdAt?: number;
}

export class PairingTokenStoreBusyError extends Error {
  readonly code = 'PAIRING_TOKEN_STORE_BUSY';
  constructor() {
    super('Pairing token authority is busy or its ownership lock needs recovery');
    this.name = 'PairingTokenStoreBusyError';
  }
}

function validateSnapshot(parsed: unknown): PairingTokenSnapshot {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('pairing token store is not a JSON object');
  }
  const snapshot = parsed as Partial<PairingTokenSnapshot>;
  if (!Array.isArray(snapshot.tokens)) throw new Error('pairing token store is missing its tokens array');
  if (snapshot.legacyRevoked !== undefined && typeof snapshot.legacyRevoked !== 'boolean') {
    throw new Error('pairing token store has an invalid legacy revocation flag');
  }
  const ids = new Set<string>(), hashes = new Set<string>();
  for (const record of snapshot.tokens) {
    if (!record || typeof record !== 'object' || Array.isArray(record)
      || typeof record.id !== 'string' || !/^pair-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(record.id)
      || typeof record.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(record.tokenHash)
      || typeof record.name !== 'string' || !record.name.trim()
      || typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt)
      || (record.lastSeenAt !== undefined && (typeof record.lastSeenAt !== 'number' || !Number.isFinite(record.lastSeenAt)))
      || ids.has(record.id) || hashes.has(record.tokenHash)) {
      throw new Error('pairing token store has an invalid or duplicate record');
    }
    ids.add(record.id); hashes.add(record.tokenHash);
  }
  const isHash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
  if (snapshot.revokedNativeSources !== undefined && (!Array.isArray(snapshot.revokedNativeSources)
    || snapshot.revokedNativeSources.some(value => !isHash(value))
    || new Set(snapshot.revokedNativeSources).size !== snapshot.revokedNativeSources.length)) throw new Error('Invalid native source tombstones');
  if (snapshot.continuations !== undefined) {
    if (!Array.isArray(snapshot.continuations)) throw new Error('Invalid native continuation grants');
    const grants = new Set<string>();
    for (const grant of snapshot.continuations) {
      if (!grant || Object.keys(grant).length !== 13 || typeof grant.id !== 'string' || !/^continuation-[0-9a-f-]{36}$/.test(grant.id)
        || !isHash(grant.binding) || !isHash(grant.sourceBinding)
        || (grant.successorSourceBinding !== null && !isHash(grant.successorSourceBinding))
        || ((grant.consumption === null) !== (grant.successorSourceBinding === null)) || !isHash(grant.tokenRevision)
        || !isHash(grant.ownerRoot) || (grant.watchBinding !== null && !isHash(grant.watchBinding)) || typeof grant.tokenId !== 'string'
        || !Array.isArray(grant.scopes) || !grant.scopes.length || grant.scopes.some(scope => typeof scope !== 'string' || !scope)
        || new Set(grant.scopes).size !== grant.scopes.length || typeof grant.revoked !== 'boolean'
        || !Number.isFinite(grant.createdAt) || (grant.consumption !== null && !isHash(grant.consumption))
        || (grant.parent !== null && (!grant.parent || Object.keys(grant.parent).length !== 3 || typeof grant.parent.id !== 'string'
          || !isHash(grant.parent.binding) || !isHash(grant.parent.consumption)))
        || grants.has(grant.id)) throw new Error('Invalid native continuation grant');
      grants.add(grant.id);
    }
  }
  return { tokens: snapshot.tokens, legacyRevoked: snapshot.legacyRevoked === true,
    ...(snapshot.continuations ? { continuations: snapshot.continuations } : {}),
    ...(snapshot.revokedNativeSources ? { revokedNativeSources: snapshot.revokedNativeSources } : {}) };
}

/** What ordinary authentication resolves to: the identity behind the token. */
export interface AuthenticatedPairingToken {
  readonly id: string;
  readonly name: string;
  /** Stable per-token principal id (`pairing:<id>`), so step-up keys per token. */
  readonly principalId: string;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function generateTokenValue(): string {
  return TOKEN_PREFIX + randomBytes(24).toString('base64url');
}

/** The `pairing:<id>` principal id a pairing-token request authenticates as. */
export function pairingPrincipalId(tokenId: string): string {
  return `pairing:${tokenId}`;
}

/**
 * A pairing was refused because the paired-node cap is full.
 *
 * Carries the setting name, the cap and the live count so the refusal a caller
 * renders says what to change and what the current state is, rather than a bare
 * "failed". `code` is what the control-plane verbs map to their wire error.
 */
export class PairingLimitReachedError extends Error {
  readonly code = 'DEVICE_NODES_MAX_PAIRED';
  readonly setting = 'device.nodes.maxPaired';
  constructor(readonly maxPaired: number, readonly pairedCount: number) {
    super(
      `Cannot pair another device: device.nodes.maxPaired is ${maxPaired} and ${pairedCount} `
      + `${pairedCount === 1 ? 'device is' : 'devices are'} already paired. `
      + 'Unpair a device, or raise device.nodes.maxPaired.',
    );
    this.name = 'PairingLimitReachedError';
  }
}

/** How the store learns the live cap. Absent ⇒ unbounded, exactly as before. */
export interface PairingTokenManagerOptions {
  /**
   * Reads `device.nodes.maxPaired` at mint time. A function, not a number, so a
   * cap change takes effect on the next pairing without re-constructing the
   * store, and so this module never has to depend on ConfigManager.
   */
  readonly maxPaired?: (() => number | undefined) | undefined;
}

export class PairingTokenManager {
  private readonly filePath: string;
  private snapshot: PairingTokenSnapshot;
  /** Live hash -> identity index, paired with fresh disk proof for native auth. */
  private index = new Map<string, StoredPairingToken>();
  private lastSeenFlushAt = 0;
  /** Any failed write blocks native admission until a successful owner mutation. */
  private nativePersistenceFailed = false;
  // Same-serving-owner evidence only; no reconstruction of prior process history.
  // These flags never weaken ordinary/manual authentication or native behavior.
  private settingsInitializationVerified = false;
  private settingsCleanInitialAbsence = false;
  private settingsObservedStore = false;
  private settingsObservedLegacyRevocation = false;
  private settingsFaulted = false;
  private readonly settingsAuthorities = new WeakMap<SettingsPairingAuthority, SettingsPairingAuthorityRecord>();
  private readonly readMaxPaired: (() => number | undefined) | null;

  constructor(filePath: string, options: PairingTokenManagerOptions = {}) {
    this.filePath = filePath;
    this.readMaxPaired = options.maxPaired ?? null;
    this.snapshot = { tokens: [] };
    let lock: PairingOwnerLock | undefined;
    try {
      lock = this.acquireOwnerLock();
      // Use the strict observed snapshot itself. A second recovery-capable read
      // could observe different bytes and manufacture fresh absence after recovery.
      try {
        const observed = this.readPersisted();
        this.settingsCleanInitialAbsence = observed === null;
        this.settingsInitializationVerified = true;
        this.snapshot = observed ?? { tokens: [] };
      } catch {
        this.settingsFaulted = true;
        // Retain ordinary recovery, with the observed strict failure latched.
        this.snapshot = this.load();
      }
    } catch {
      this.settingsFaulted = true;
      // A live owner may be launching, or this process may lack write access.
      // Reading a complete file is safe; quarantining/repairing it without
      // ownership is not. Ordinary auth retains its read-only startup behavior.
      try { this.snapshot = this.readPersisted() ?? { tokens: [] }; } catch { /* fail closed */ }
    } finally { lock?.release(); }
    this.reindex();
  }

  /**
   * The configured cap, or null when there is none / it is unusable.
   *
   * A non-positive or non-finite value is treated as "no cap" rather than "no
   * device may ever pair": a broken setting must not lock the owner out of
   * their own daemon.
   */
  private currentCap(): number | null {
    if (!this.readMaxPaired) return null;
    let raw: number | undefined;
    try {
      raw = this.readMaxPaired();
    } catch {
      return null;
    }
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
    return Math.floor(raw);
  }

  /** How many paired device nodes exist right now, one record per node. */
  pairedCount(): number {
    return this.snapshot.tokens.length;
  }

  private load(): PairingTokenSnapshot {
    // A corrupt file must not brick auth: start clean rather than throw. The
    // unreadable file is quarantined (moved aside with a receipt) instead of
    // being silently overwritten by the next flush, so the operator can see
    // which device tokens were lost and re-pair those devices.
    try {
      return (
        readJsonFileOrQuarantine<PairingTokenSnapshot>(this.filePath, {
          label: 'pairing/pairing-token-store',
          recovery: 'Every previously paired device must pair again; no device keeps access on a token this store can no longer verify.',
          validate: validateSnapshot,
        }) ?? { tokens: [] }
      );
    } catch {
      this.settingsFaulted = true;
      return { tokens: [] };
    }
  }

  private reindex(): void {
    this.index = new Map(this.snapshot.tokens.map((t) => [t.tokenHash, t]));
  }

  /** Never quarantine or repair as a side effect of authenticating a request. */
  private readPersisted(): PairingTokenSnapshot | null {
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      this.settingsObservedStore = true;
      const snapshot = validateSnapshot(JSON.parse(raw));
      if (snapshot.legacyRevoked === true) this.settingsObservedLegacyRevocation = true;
      return snapshot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      this.settingsFaulted = true;
      throw error;
    }
  }

  /**
   * One owner lock for EVERY writer and the native launch boundary, including
   * other managers/processes. Acquisition never waits on the JS thread. No
   * age-based stealing: a suspended live owner is still an owner. A crash leaves
   * a fail-closed lock requiring explicit recovery, never guessed authority.
   */
  private acquireOwnerLock(): PairingOwnerLock {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const lockPath = `${this.filePath}.owner-lock`;
    try { mkdirSync(lockPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new PairingTokenStoreBusyError();
      throw error;
    }
    const owned = lstatSync(lockPath);
    const assertOwned = () => {
      let current;
      try { current = lstatSync(lockPath); } catch { throw new PairingTokenStoreBusyError(); }
      if (!current.isDirectory() || current.dev !== owned.dev || current.ino !== owned.ino
        || current.birthtimeMs !== owned.birthtimeMs) throw new PairingTokenStoreBusyError();
    };
    return { assertOwned, release: () => { assertOwned(); rmdirSync(lockPath); } };
  }

  private publish(snapshot: PairingTokenSnapshot): void {
    this.snapshot = snapshot;
    if (snapshot.legacyRevoked === true) this.settingsObservedLegacyRevocation = true;
    this.reindex();
  }

  /** Reload under ownership, persist, THEN expose a successful mutation. */
  private mutate<T>(operation: (snapshot: PairingTokenSnapshot) => { readonly value: T; readonly changed: boolean }, nativeRecovery = true): T {
    const lock = this.acquireOwnerLock();
    try {
      const persisted = this.readPersisted();
      const snapshot = persisted ?? { tokens: [] };
      const result = operation(snapshot);
      try {
        lock.assertOwned();
        if (result.changed) {
          writeJsonFileAtomic(this.filePath, snapshot, { mode: 0o600, trailingNewline: false, durable: true });
          this.settingsObservedStore = true;
        } else if (nativeRecovery && persisted !== null) {
          // Retrying an indeterminate revoke can find the record already absent.
          // Readable bytes alone do not clear uncertainty; confirm the full
          // publication even when the retry has no new bytes to write.
          confirmFileDurable(this.filePath);
        }
      } catch (error) {
        this.nativePersistenceFailed = true;
        this.settingsFaulted = true;
        throw error;
      }
      if (nativeRecovery && (result.changed || persisted !== null)) this.nativePersistenceFailed = false;
      lock.assertOwned();
      this.publish(snapshot);
      return result.value;
    } finally { lock.release(); }
  }

  /** Read without fallback, repair, telemetry, or native-only substitution. */
  private readSettingsSnapshot(): PairingTokenSnapshot | null {
    if (!this.settingsInitializationVerified || this.settingsFaulted) throw new SettingsAuthorityUnavailableError();
    try {
      const snapshot = this.readPersisted();
      if (snapshot === null) {
        if (!this.settingsCleanInitialAbsence || this.settingsObservedStore) throw new SettingsAuthorityUnavailableError();
        return null;
      }
      confirmFileDurable(this.filePath);
      // The owner lock fences supported pairing writers. This re-read also
      // rejects a publication changed during durability confirmation.
      const confirmed = this.readPersisted();
      if (!confirmed || JSON.stringify(confirmed) !== JSON.stringify(snapshot)) throw new SettingsAuthorityUnavailableError();
      return confirmed;
    } catch {
      this.settingsFaulted = true;
      throw new SettingsAuthorityUnavailableError();
    }
  }

  captureSettingsAuthority(input: { readonly kind: 'shared-token' }
    | { readonly kind: 'pairing-token'; readonly token: string }): SettingsPairingAuthority | null {
    if (input.kind === 'pairing-token' && !input.token.trim().startsWith(TOKEN_PREFIX)) return null;
    let lock: PairingOwnerLock | undefined;
    try {
      lock = this.acquireOwnerLock();
      const snapshot = this.readSettingsSnapshot();
      let record: SettingsPairingAuthorityRecord;
      if (input.kind === 'shared-token') {
        if (snapshot?.legacyRevoked === true || this.settingsObservedLegacyRevocation) return null;
        record = { kind: 'shared-token' };
      } else {
        const hash = hashToken(input.token.trim());
        const paired = snapshot?.tokens.find(item => item.tokenHash === hash);
        if (!paired) return null;
        record = { kind: 'pairing-token', hash, id: paired.id, createdAt: paired.createdAt };
      }
      lock.assertOwned();
      const handle = Object.freeze({ kind: record.kind }) as SettingsPairingAuthority;
      this.settingsAuthorities.set(handle, record);
      return handle;
    } catch { return null; }
    finally { lock?.release(); }
  }

  /**
   * One-use, synchronous current-auth boundary. The effect owner MUST call the
   * supplied check after its reentrant preparation and immediately before its
   * effect. No post-effect check may misreport an already committed operation.
   */
  withSettingsAuthority<T>(authority: SettingsPairingAuthority,
    operation: (assertCurrent: () => void) => T): T {
    const expected = this.settingsAuthorities.get(authority);
    this.settingsAuthorities.delete(authority);
    if (!expected) throw new SettingsAuthorityUnavailableError();
    const lock = this.acquireOwnerLock();
    let active = true;
    let completed = false;
    try {
      const assertCurrent = () => {
        if (!active) throw new SettingsAuthorityUnavailableError();
        lock.assertOwned();
        const current = this.readSettingsSnapshot();
        if (expected.kind === 'shared-token') {
          if (current?.legacyRevoked === true || this.settingsObservedLegacyRevocation) throw new SettingsAuthorityUnavailableError();
        } else if (!current?.tokens.some(item => item.tokenHash === expected.hash
          && item.id === expected.id && item.createdAt === expected.createdAt)) {
          throw new SettingsAuthorityUnavailableError();
        }
      };
      assertCurrent();
      const result = runSynchronousSettingsOperation(operation, assertCurrent);
      completed = true;
      return result;
    } finally {
      active = false;
      try { lock.release(); }
      catch (error) {
        this.settingsFaulted = true;
        // Cleanup cannot undo an effect or replace its truthful receipt with a
        // refusal. A leftover/lost lock and this owner fault block later work.
        if (!completed) throw error;
      }
    }
  }

  /**
   * Strict native reads prove that the immutable live identity is still present
   * in a freshly read, valid persisted snapshot. Last-seen and labels are not
   * authority generations. Reads confirm durability without stamping last-seen
   * or rewriting the file; failed confirmation never grants authority.
   */
  authenticateNative(token: string): AuthenticatedNativePairingToken | null {
    const normalized = token.trim();
    if (this.nativePersistenceFailed || !normalized.startsWith(TOKEN_PREFIX)) return null;
    const hash = hashToken(normalized);
    const live = this.index.get(hash);
    if (!live) return null;
    let persisted: StoredPairingToken | undefined;
    try {
      // A fresh manager cannot treat post-rename, unconfirmed bytes as durable
      // authority. Confirmation also makes recovery after restart explicit.
      const before = readFileSync(this.filePath, 'utf8');
      const snapshot = validateSnapshot(JSON.parse(before));
      confirmFileDurable(this.filePath);
      if (readFileSync(this.filePath, 'utf8') !== before) return null;
      persisted = snapshot.tokens.find(record => record.tokenHash === hash);
    } catch (error) {
      if (error instanceof AtomicWriteDurabilityError) this.nativePersistenceFailed = true;
      this.settingsFaulted = true;
      return null;
    }
    if (!persisted || persisted.id !== live.id || persisted.createdAt !== live.createdAt) return null;
    const principalId = pairingPrincipalId(persisted.id);
    return Object.freeze({ kind: 'pairing-token', tokenId: persisted.id, principalId,
      authorityId: principalId, authorityRevision: persisted.id });
  }

  /** Hold paired ownership through the caller's workspace/ledger/launch boundary. */
  async withNativeAuthority<T>(token: string, expected: AuthenticatedNativePairingToken,
    operation: (assertCurrent: () => AuthenticatedNativePairingToken) => T | Promise<T>): Promise<T> {
    const lock = this.acquireOwnerLock();
    let active = true;
    try {
      const assertCurrent = () => {
        lock.assertOwned();
        const current = active ? this.authenticateNative(token) : null;
        if (!current || current.kind !== expected.kind || current.tokenId !== expected.tokenId
          || current.principalId !== expected.principalId || current.authorityId !== expected.authorityId
          || current.authorityRevision !== expected.authorityRevision) {
          throw new Error('Persisted native pairing authority is no longer valid');
        }
        return current;
      };
      assertCurrent();
      return await operation(assertCurrent);
    } finally { active = false; lock.release(); }
  }

  private nativeContinuationRoot(): string {
    if (!lstatSync(this.filePath).isFile()) throw new Error('Native continuation owner file is not ordinary');
    const identities: string[][] = [];
    for (let path = dirname(this.filePath);;) {
      const entry = lstatSync(path, { bigint: true });
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Native continuation owner root is not ordinary');
      identities.push([path, String(entry.dev), String(entry.ino), String(entry.birthtimeNs)]);
      const parent = dirname(path); if (parent === path) break; path = parent;
    }
    return hashToken(JSON.stringify(identities));
  }

  /**
   * Issue under the authenticating owner's private lock. The caller supplies its
   * exact source/scope/policy validator; persistence precedes any successful receipt.
   * No plaintext credential or signing material enters the issued record.
   */
  issueNativeContinuation(token: string, expected: NativeContinuationAuthority, binding: string, assertCurrent: () => void, sourceBinding = binding): NativeContinuationGrant {
    if (typeof sourceBinding !== 'string' || !/^[0-9a-f]{64}$/.test(sourceBinding) || !/^[0-9a-f]{64}$/.test(binding) || !Array.isArray(expected.scopes) || !expected.scopes.length
      || expected.scopes.some(scope => typeof scope !== 'string' || !scope) || new Set(expected.scopes).size !== expected.scopes.length) throw new Error('Invalid continuation binding');
    return this.mutate(snapshot => {
      const current = this.authenticateNative(token);
      if (!current || current.kind !== expected.kind || current.authorityId !== expected.authorityId || current.tokenId !== expected.tokenId || current.principalId !== expected.principalId
        || current.authorityRevision !== expected.authorityRevision) throw new Error('Native continuation owner is no longer current');
      assertCurrent();
      return this.appendNativeContinuation(snapshot, expected, binding, null, assertCurrent, sourceBinding);
    });
  }

  /** A consumed successor may transfer only its own current native source. */
  issueNativeContinuationFromGrant(parent: NativeContinuationGrant, consumption: string,
    expected: NativeContinuationAuthority, binding: string, assertCurrent: () => void, sourceBinding?: string): NativeContinuationGrant {
    if ((sourceBinding !== undefined && (typeof sourceBinding !== 'string' || !/^[0-9a-f]{64}$/.test(sourceBinding))) || !/^[0-9a-f]{64}$/.test(binding) || !/^[0-9a-f]{64}$/.test(consumption)) throw new Error('Invalid continuation lineage');
    return this.mutate(snapshot => {
      const current = this.readNativeContinuation(parent, consumption);
      if (!current || JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('Native continuation parent is no longer current');
      const consumedSource = snapshot.continuations?.find(item => item.id === parent.id && item.binding === parent.binding)?.successorSourceBinding;
      if (!consumedSource || (sourceBinding !== undefined && sourceBinding !== consumedSource)) throw new Error('Native continuation child source differs from consumed successor');
      assertCurrent();
      return this.appendNativeContinuation(snapshot, expected, binding, { ...parent, consumption }, assertCurrent, consumedSource);
    });
  }

  private appendNativeContinuation(snapshot: PairingTokenSnapshot, expected: NativeContinuationAuthority, binding: string,
    parent: StoredNativeContinuationGrant['parent'], assertCurrent: () => void, sourceBinding: string): { changed: boolean; value: NativeContinuationGrant } {
    if (snapshot.revokedNativeSources?.includes(sourceBinding)) throw new Error('Native continuation source was cancelled');
    const tokenRecord = snapshot.tokens.find(item => item.id === expected.tokenId);
    if (!tokenRecord) throw new Error('Native continuation pairing is unavailable');
    const tokenRevision = hashToken(JSON.stringify([tokenRecord.createdAt, tokenRecord.tokenHash])); const ownerRoot = this.nativeContinuationRoot();
    const previous = snapshot.continuations?.find(item => item.tokenId === expected.tokenId && item.binding === binding);
    if (previous) {
      if (previous.sourceBinding !== sourceBinding || previous.revoked || previous.tokenRevision !== tokenRevision || previous.ownerRoot !== ownerRoot
        || JSON.stringify(previous.parent) !== JSON.stringify(parent)
        || JSON.stringify(previous.scopes) !== JSON.stringify([...expected.scopes].sort())) throw new Error('Native continuation issuance was revoked or changed');
      assertCurrent(); return { changed: false, value: Object.freeze({ id: previous.id, binding: previous.binding }) };
    }
    const grant: StoredNativeContinuationGrant = { id: `continuation-${randomUUID()}`, binding, sourceBinding, successorSourceBinding: null, parent, tokenId: expected.tokenId,
      tokenRevision, ownerRoot, watchBinding: null, scopes: [...expected.scopes].sort(), createdAt: Date.now(), consumption: null, revoked: false };
    (snapshot.continuations ??= []).push(grant); assertCurrent();
    return { changed: true, value: Object.freeze({ id: grant.id, binding: grant.binding }) };
  }

  /** Strict restart lookup of an actually issued grant, never adoption by token ID. */
  readNativeContinuation(grant: NativeContinuationGrant, consumption?: string, watchBinding?: string): NativeContinuationAuthority | null {
    if (this.nativePersistenceFailed) return null;
    try {
      const before = readFileSync(this.filePath, 'utf8');
      const snapshot = validateSnapshot(JSON.parse(before)); confirmFileDurable(this.filePath);
      if (readFileSync(this.filePath, 'utf8') !== before) return null;
      const issued = snapshot.continuations?.find(item => item.id === grant.id && item.binding === grant.binding);
      const token = issued && snapshot.tokens.find(item => item.id === issued.tokenId);
      if (!issued || !token || issued.ownerRoot !== this.nativeContinuationRoot()
        || (watchBinding !== undefined && issued.watchBinding !== watchBinding) || issued.tokenRevision !== hashToken(JSON.stringify([token.createdAt, token.tokenHash]))
        || snapshot.revokedNativeSources?.includes(issued.sourceBinding) || (issued.successorSourceBinding !== null && snapshot.revokedNativeSources?.includes(issued.successorSourceBinding))
        || issued.revoked || (consumption !== undefined && issued.consumption !== consumption)) return null;
      const visited = new Set<string>([issued.id]); let child = issued;
      while (child.parent) {
        const parent = snapshot.continuations?.find(item => item.id === child.parent!.id && item.binding === child.parent!.binding);
        if (!parent || visited.has(parent.id) || parent.revoked
          || snapshot.revokedNativeSources?.includes(parent.sourceBinding) || (parent.successorSourceBinding !== null && snapshot.revokedNativeSources?.includes(parent.successorSourceBinding))
          || parent.consumption !== child.parent.consumption
          || parent.tokenId !== issued.tokenId || parent.tokenRevision !== issued.tokenRevision || parent.ownerRoot !== issued.ownerRoot
          || JSON.stringify(parent.scopes) !== JSON.stringify(issued.scopes)) return null;
        visited.add(parent.id); child = parent;
      }
      const principalId = pairingPrincipalId(token.id);
      return Object.freeze({ kind: 'pairing-token', tokenId: token.id, principalId, authorityId: principalId,
        authorityRevision: token.id, scopes: Object.freeze([...issued.scopes]) });
    } catch { return null; }
  }

  async withNativeContinuation<T>(grant: NativeContinuationGrant, expected: NativeContinuationAuthority,
    operation: (assertCurrent: () => NativeContinuationAuthority) => T | Promise<T>): Promise<T> {
    const lock = this.acquireOwnerLock(); let active = true;
    try {
      const assertCurrent = () => {
        lock.assertOwned(); const current = active ? this.readNativeContinuation(grant) : null;
        if (!current || JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('Native continuation authority is no longer current');
        return current;
      };
      assertCurrent(); return await operation(assertCurrent);
    } finally { active = false; lock.release(); }
  }

  /** The exact resolved watch is independently retained by the issuing owner. */
  bindNativeContinuationWatch(grant: NativeContinuationGrant, watchBinding: string, assertCurrent: () => void): void {
    if (!/^[0-9a-f]{64}$/.test(watchBinding)) throw new Error('Invalid continuation watch binding');
    this.mutate(snapshot => {
      const issued = snapshot.continuations?.find(item => item.id === grant.id && item.binding === grant.binding);
      if (!issued || issued.revoked || issued.ownerRoot !== this.nativeContinuationRoot()
        || !snapshot.tokens.some(token => token.id === issued.tokenId)
        || (issued.watchBinding !== null && issued.watchBinding !== watchBinding)) throw new Error('Native continuation watch is unavailable or already bound');
      if (!this.readNativeContinuation(grant)) throw new Error('Native continuation lineage is unavailable');
      assertCurrent(); const changed = issued.watchBinding === null;
      if (changed) snapshot.continuations![snapshot.continuations!.indexOf(issued)] = { ...issued, watchBinding };
      assertCurrent(); return { changed, value: undefined };
    });
  }

  /** One immutable successor binding. Repeated delivery can only reconcile it. */
  consumeNativeContinuation(grant: NativeContinuationGrant, consumption: string, assertCurrent: () => void, successorSourceBinding = consumption): void {
    if (typeof successorSourceBinding !== 'string' || !/^[0-9a-f]{64}$/.test(successorSourceBinding) || !/^[0-9a-f]{64}$/.test(consumption)) throw new Error('Invalid continuation consumption');
    this.mutate(snapshot => {
      const issued = snapshot.continuations?.find(item => item.id === grant.id && item.binding === grant.binding);
      if (!issued || issued.revoked || issued.ownerRoot !== this.nativeContinuationRoot() || !snapshot.tokens.some(token => token.id === issued.tokenId)
        || snapshot.revokedNativeSources?.includes(successorSourceBinding)
        || (issued.consumption !== null && (issued.consumption !== consumption || issued.successorSourceBinding !== successorSourceBinding))) throw new Error('Native continuation is unavailable or already consumed');
      assertCurrent();
      if (!this.readNativeContinuation(grant)) throw new Error('Native continuation lineage is unavailable');
      const changed = issued.consumption === null;
      if (changed) snapshot.continuations![snapshot.continuations!.indexOf(issued)] = { ...issued, consumption, successorSourceBinding };
      assertCurrent(); return { changed, value: undefined };
    });
  }

  /** Only an authenticated native owner supplies the exact source-incarnation guard. */
  revokeNativeContinuationsForSource(sourceBinding: string, assertCurrent: () => void): void {
    if (typeof sourceBinding !== 'string' || !/^[0-9a-f]{64}$/.test(sourceBinding)) throw new Error('Invalid native source binding');
    this.mutate(snapshot => {
      assertCurrent();
      const sources = snapshot.revokedNativeSources ??= []; const changed = !sources.includes(sourceBinding);
      if (changed) sources.push(sourceBinding);
      if (snapshot.continuations) snapshot.continuations = snapshot.continuations.map(grant =>
        grant.sourceBinding === sourceBinding || grant.successorSourceBinding === sourceBinding ? { ...grant, revoked: true } : grant);
      assertCurrent(); return { changed, value: undefined };
    });
  }

  revokeNativeContinuation(grant: NativeContinuationGrant, watchBinding?: string): void {
    this.mutate(snapshot => {
      const issued = snapshot.continuations?.find(item => item.id === grant.id && item.binding === grant.binding);
      if (!issued || issued.revoked) return { changed: false, value: undefined };
      if (watchBinding !== undefined && issued.watchBinding !== watchBinding) throw new Error('Native continuation revocation watch changed');
      snapshot.continuations![snapshot.continuations!.indexOf(issued)] = { ...issued, revoked: true };
      return { changed: true, value: undefined };
    });
  }

  /**
   * Mint a new named per-device token. The plaintext is returned only here.
   *
   * Bounded by `device.nodes.maxPaired` when the host supplied a reader for it.
   * The rules, all of which are exercised by tests:
   *
   * - Below the cap nothing changes at all, same append, same result.
   * - At the cap, a NEW node is refused with {@link PairingLimitReachedError},
   *   which names the setting, the cap and the live count.
   * - At the cap, a node that is ALREADY paired (same name) is never refused: it
   *   supersedes its own record, so re-pairing a phone that is already in the
   *   list keeps working and the count does not creep past the cap. Nobody
   *   else's pairing is touched.
   * - Lowering the cap below the current count unpairs NO ONE: existing tokens
   *   keep authenticating; only the next NEW pairing is refused, until enough
   *   devices are unpaired to fit under the cap again.
   */
  mint(input: { readonly name: string }): MintedPairingToken {
    return this.mintInternal(input, { enforceCap: true });
  }

  private mintInternal(
    input: { readonly name: string },
    options: { readonly enforceCap: boolean },
  ): MintedPairingToken {
    return this.mutate((snapshot) => {
      const cap = options.enforceCap ? this.currentCap() : null;
      if (cap !== null && snapshot.tokens.length >= cap) {
        const normalized = input.name.trim().toLowerCase();
        const existing = normalized ? snapshot.tokens.find(record => record.name.trim().toLowerCase() === normalized) : undefined;
        if (!existing) throw new PairingLimitReachedError(cap, snapshot.tokens.length);
        logger.info('Pairing at the device.nodes.maxPaired cap: re-pairing an already paired node', {
          name: existing.name, maxPaired: cap, pairedCount: snapshot.tokens.length,
        });
        snapshot.tokens = snapshot.tokens.filter(record => record.id !== existing.id);
      }
      const token = generateTokenValue();
      const record: StoredPairingToken = {
        id: `pair-${randomUUID()}`, name: input.name.trim() || 'Unnamed device',
        tokenHash: hashToken(token), createdAt: Date.now(),
      };
      snapshot.tokens.push(record);
      return { value: { id: record.id, name: record.name, token, createdAt: record.createdAt }, changed: true };
    });
  }

  /**
   * A client currently on the legacy shared token moves to its own per-device
   * token. The "one receipt" is this single return; it does NOT revoke the
   * shared token (that is a separate, explicit step).
   *
   * Deliberately EXEMPT from `device.nodes.maxPaired`: this device is already
   * using this daemon on the shared token. Refusing it would strand a working
   * device on a credential it is being asked to give up, which is a worse
   * outcome than being one over a cap that no longer describes reality. A new
   * device pairing for the first time is still bounded.
   */
  mintForMigration(input: { readonly name: string }): MintedPairingToken {
    return this.mintInternal(input, { enforceCap: false });
  }

  /**
   * Authenticate a presented token by hashing it and looking the hash up.
   * Immediate revocation: a revoked (deleted) token misses here and the caller
   * treats the request as unauthorized. Stamps last-seen (throttled to disk).
   */
  authenticate(token: string): AuthenticatedPairingToken | null {
    const normalized = token.trim();
    if (!normalized.startsWith(TOKEN_PREFIX)) return null;
    let snapshot: PairingTokenSnapshot | null;
    try { snapshot = this.readPersisted(); } catch { return null; }
    if (!snapshot) return null;
    this.publish(snapshot);
    const hash = hashToken(normalized);
    let record = this.index.get(hash);
    if (!record) return null;
    const now = Date.now();
    if (now - this.lastSeenFlushAt >= LAST_SEEN_FLUSH_INTERVAL_MS) {
      try {
        record = this.mutate(current => {
          const found = current.tokens.find(item => item.tokenHash === hash);
          if (found) found.lastSeenAt = now;
          return { value: found, changed: found !== undefined };
        }, false);
        this.lastSeenFlushAt = now;
      } catch (error) {
        // Telemetry persistence never grants access or resurrects cached records.
        logger.warn('Pairing token last-seen update failed', { path: this.filePath, error: String(error) });
        try { record = this.readPersisted()?.tokens.find(item => item.tokenHash === hash); }
        catch { return null; }
      }
    }
    if (!record) return null;
    return { id: record.id, name: record.name, principalId: pairingPrincipalId(record.id) };
  }

  /** Every per-pairing token, redacted (name / created / last-seen), never the secret. */
  list(): PublicPairingToken[] {
    return this.snapshot.tokens.map((t) => ({
      id: t.id,
      name: t.name,
      createdAt: t.createdAt,
      ...(t.lastSeenAt !== undefined ? { lastSeenAt: t.lastSeenAt } : {}),
    }));
  }

  /** Rename a token's user-visible label. False when the id is unknown. */
  rename(id: string, name: string): boolean {
    return this.mutate(snapshot => {
      const record = snapshot.tokens.find(item => item.id === id);
      if (!record) return { value: false, changed: false };
      record.name = name.trim() || record.name;
      return { value: true, changed: true };
    });
  }

  /** Revoke one pairing. A persistence failure throws instead of reporting success. */
  revoke(id: string): boolean {
    return this.mutate(snapshot => {
      const before = snapshot.tokens.length;
      snapshot.tokens = snapshot.tokens.filter(record => record.id !== id);
      const changed = snapshot.tokens.length !== before;
      return { value: changed, changed };
    });
  }

  /** Whether the legacy single shared token has been revoked here. */
  isLegacyRevoked(): boolean {
    try {
      const snapshot = this.readPersisted();
      if (snapshot) this.publish(snapshot);
      return snapshot?.legacyRevoked === true || this.snapshot.legacyRevoked === true;
    } catch { return this.snapshot.legacyRevoked === true; }
  }

  /** Revoke the legacy single shared token; report only persisted success. */
  revokeLegacyShared(): void {
    this.mutate(snapshot => {
      const changed = snapshot.legacyRevoked !== true;
      snapshot.legacyRevoked = true;
      return { value: undefined, changed };
    });
  }
}

import { existsSync, readFileSync } from 'node:fs';
import { readJsonFileOrQuarantine, writeJsonFileAtomic } from '../utils/atomic-json-store.js';
import { logger } from '../utils/logger.js';
import { captureStrictJudgmentJson } from '../gate/judgment-result.js';
import { observeImportFile, assertImportFileCurrent, type ImportFileObservation, type PreparedImportTransitionFacts } from './prepared-import.js';
import type { PreparedConfigMutationReceipt } from './prepared-mutation.js';
import {
  buildOAuthAuthorizationStart,
  createOAuthState,
  createPkceVerifier,
  exchangeOAuthAuthorizationCode,
  parseOAuthScopes,
  refreshOAuthAccessToken,
} from '../runtime/auth/oauth-core.js';

/**
 * The shared tier's directory name under `~/.goodvibes/`, the same
 * surface-root-independent convention used by the config shared tier
 * (shared-config-tier.ts), the canonical memory store (canonical-memory.ts),
 * and the workspace register (shared-register-path.ts). Kept as a local
 * literal rather than an import from any of those: it is a stable, one-word
 * directory name, not a coupling any of those modules were built to share.
 */
const SUBSCRIPTIONS_SHARED_TIER_DIRECTORY = 'shared';
const SUBSCRIPTIONS_FILE_NAME = 'subscriptions.json';

/** The slice of ShellPathService {@link sharedSubscriptionsPath} needs. */
export interface SubscriptionShellPaths {
  resolveUserPath(...segments: string[]): string;
}

/**
 * Where provider subscriptions (OAuth sessions for providers like
 * 'openai-subscriber') live: `~/.goodvibes/shared/subscriptions.json`, one
 * file read and written by every surface on the machine, the daemon, the
 * TUI, the agent.
 *
 * A login is one event; every surface that later needs the token must see
 * it. Before this, each surface constructed its own `SubscriptionManager`
 * against `~/.goodvibes/<surfaceRoot>/subscriptions.json`, so a login
 * completed in the TUI was invisible to the daemon that actually hosts
 * conversation turns, the daemon kept refreshing whatever it already had
 * (or nothing), and a successful login changed nothing from its point of
 * view.
 */
export function sharedSubscriptionsPath(shellPaths: SubscriptionShellPaths): string {
  return shellPaths.resolveUserPath(SUBSCRIPTIONS_SHARED_TIER_DIRECTORY, SUBSCRIPTIONS_FILE_NAME);
}

export interface OAuthProviderConfig {
  readonly authUrl: string;
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly manualRedirectUri?: string | undefined;
  readonly scopes?: readonly string[] | undefined;
  readonly audience?: string | undefined;
  readonly usePkce?: boolean | undefined;
  readonly authParams?: Readonly<Record<string, string>> | undefined;
  readonly tokenRequestEncoding?: 'form' | 'json' | undefined;
  readonly includeStateInTokenRequest?: boolean | undefined;
  readonly tokenRequestExtras?: Readonly<Record<string, string | number | boolean>> | undefined;
  readonly refreshRequestEncoding?: 'form' | 'json' | undefined;
  readonly refreshRequestExtras?: Readonly<Record<string, string | number | boolean>> | undefined;
  readonly refreshScopes?: readonly string[] | undefined;
  readonly overrideAmbientApiKeys?: boolean | undefined;
  readonly localCallback?: {
    readonly host?: string | undefined;
    readonly port?: number | undefined;
    readonly path?: string | undefined;
    readonly autoComplete?: boolean | undefined;
  };
}

export interface PendingSubscriptionLogin {
  readonly provider: string;
  readonly state: string;
  readonly verifier: string;
  readonly redirectUri: string;
  readonly createdAt: number;
}

export interface ProviderSubscription {
  readonly provider: string;
  readonly accessToken: string;
  readonly refreshToken?: string | undefined;
  readonly tokenType: string;
  readonly expiresAt?: number | undefined;
  readonly scopes?: readonly string[] | undefined;
  readonly authMode: 'oauth';
  readonly overrideAmbientApiKeys: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  /**
   * Set when the authorization server REFUSED this session's grant (an
   * answered 4xx on refresh): the session is over regardless of what
   * `expiresAt` says, and every surface must show it as signed-out instead
   * of deriving "healthy" from the timestamp. Cleared by a successful
   * refresh; a completed login replaces the whole record.
   */
  readonly revokedAt?: number | undefined;
}

interface SubscriptionStore {
  readonly version: 1;
  readonly subscriptions: Record<string, ProviderSubscription>;
  readonly pending: Record<string, PendingSubscriptionLogin>;
}

declare const subscriptionImportBrand: unique symbol;
declare const subscriptionImportTransitionBrand: unique symbol;
export interface PreparedSubscriptionImport { readonly [subscriptionImportBrand]: true }
export interface PreparedSubscriptionImportTransition { readonly [subscriptionImportTransitionBrand]: true }
export type SubscriptionImportEntry =
  | { readonly kind: 'active'; readonly value: ProviderSubscription }
  | { readonly kind: 'pending'; readonly value: PendingSubscriptionLogin };
export interface PreparedSubscriptionImportFacts {
  readonly operation: 'import';
  readonly beforeGeneration: number;
  readonly items: readonly { readonly provider: string; readonly kind: 'active' | 'pending'; readonly configured: true }[];
  readonly destinations: readonly { readonly path: string; readonly operation: 'set'; readonly tier: 'shared' }[];
}
interface SubscriptionImportRecord {
  readonly facts: PreparedSubscriptionImportFacts;
  readonly store: SubscriptionStore;
  readonly methods: readonly unknown[];
  observation: ImportFileObservation;
  phase: 'prepared' | 'pending' | 'committing' | 'committed' | 'failed';
  transition?: PreparedSubscriptionImportTransition;
}

function isSubscriptionExpired(expiresAt?: number, bufferMs = 60_000): boolean {
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return false;
  return Date.now() + bufferMs >= expiresAt;
}

/**
 * SubscriptionManager, OAuth flows for **provider subscriptions**.
 *
 * Manages OAuth-based subscriptions to external AI providers (OpenAI,
 * Anthropic, Gemini, etc.) including authorization URL generation, code
 * exchange, token refresh, and persisting credentials to disk.
 *
 * This class handles provider-subscription OAuth on behalf of the daemon.
 * For OAuth flows that authenticate the SDK client with the goodvibes daemon
 * itself, see {@link OAuthClient} in `../runtime/auth/oauth-client.ts`.
 *
 * @see OAuthClient, OAuth flows for daemon authentication.
 */
export interface SubscriptionManagerOptions {
  /**
   * A surface-scoped store this manager used to own before subscriptions
   * moved to the shared tier (e.g. the old `~/.goodvibes/<surfaceRoot>/subscriptions.json`).
   * Folded in once, synchronously, at construction: see {@link SubscriptionManager.foldLegacyStore}.
   * Omit when there is no legacy surface store to migrate from (a brand-new
   * install, or a caller that never had a surface-scoped store to begin with).
   */
  readonly legacyPath?: string;
}

export class SubscriptionManager {
  private readonly path: string;
  private importGeneration = 0;
  private readonly preparedImports = new WeakMap<PreparedSubscriptionImport, SubscriptionImportRecord>();

  /** Capture privately without invoking legacy recovery or publishing any token. */
  prepareImport(entries: readonly SubscriptionImportEntry[]): PreparedSubscriptionImport {
    try { return this.prepareImportOwned(entries); }
    catch { throw new Error('Subscription import is unavailable.'); }
  }
  private prepareImportOwned(entries: readonly SubscriptionImportEntry[]): PreparedSubscriptionImport {
    const values = captureStrictJudgmentJson(entries);
    if (!values.length || new Set(values.map(entry => `${entry.kind}:${entry.value.provider}`)).size !== values.length) throw new Error('Invalid subscription import.');
    for (const entry of values) {
      const value = entry.value;
      if (!value || typeof value.provider !== 'string' || !value.provider || !Number.isSafeInteger(value.createdAt)
        || (entry.kind === 'active' ? !('accessToken' in value) || typeof value.accessToken !== 'string' || !('tokenType' in value) || typeof value.tokenType !== 'string' || !('authMode' in value) || value.authMode !== 'oauth'
          || !('overrideAmbientApiKeys' in value) || typeof value.overrideAmbientApiKeys !== 'boolean' || !('updatedAt' in value) || !Number.isSafeInteger(value.updatedAt)
          : entry.kind !== 'pending' || !('state' in value) || typeof value.state !== 'string' || !('verifier' in value) || typeof value.verifier !== 'string' || !('redirectUri' in value) || typeof value.redirectUri !== 'string')) throw new Error('Invalid subscription import.');
    }
    const observation = observeImportFile(this.path);
    const parsed: unknown = observation.raw === null ? { version: 1, subscriptions: {}, pending: {} } : JSON.parse(observation.raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !('version' in parsed) || parsed.version !== 1 || !('subscriptions' in parsed) || !('pending' in parsed)
      || !parsed.subscriptions || typeof parsed.subscriptions !== 'object' || Array.isArray(parsed.subscriptions)
      || !parsed.pending || typeof parsed.pending !== 'object' || Array.isArray(parsed.pending)) throw new Error('Subscription store is unavailable.');
    const store = captureStrictJudgmentJson(parsed) as SubscriptionStore;
    const subscriptions = { ...store.subscriptions }, pending = { ...store.pending };
    for (const entry of values) {
      if (entry.kind === 'active') { Object.defineProperty(subscriptions, entry.value.provider, { value: entry.value, enumerable: true, writable: true, configurable: true }); delete pending[entry.value.provider]; }
      else Object.defineProperty(pending, entry.value.provider, { value: entry.value, enumerable: true, writable: true, configurable: true });
    }
    const handle = Object.freeze({}) as PreparedSubscriptionImport;
    const facts: PreparedSubscriptionImportFacts = Object.freeze({ operation: 'import', beforeGeneration: this.importGeneration,
      items: Object.freeze(values.map(entry => Object.freeze({ provider: entry.value.provider, kind: entry.kind, configured: true as const }))),
      destinations: Object.freeze([Object.freeze({ path: this.path, operation: 'set' as const, tier: 'shared' as const })]) });
    this.preparedImports.set(handle, { facts, store: captureStrictJudgmentJson({ ...store, subscriptions, pending }), observation,
      methods: [this.get, this.getPending, this.saveSubscription, this.savePending], phase: 'prepared' });
    this.assertPreparedImport(handle); return handle;
  }
  inspectPreparedImport(handle: PreparedSubscriptionImport): PreparedSubscriptionImportFacts {
    const record = this.preparedImports.get(handle); if (!record) throw new Error('Subscription import is not authentic.'); return record.facts;
  }
  private assertImportRecord(record: SubscriptionImportRecord, generation: number): void {
    if (this.importGeneration !== generation || this.path !== record.facts.destinations[0]?.path
      || [this.get, this.getPending, this.saveSubscription, this.savePending].some((method, index) => method !== record.methods[index])) throw new Error('Subscription import owner changed.');
    assertImportFileCurrent(this.path, record.observation);
  }
  assertPreparedImport(handle: PreparedSubscriptionImport): void {
    const record = this.preparedImports.get(handle);
    if (!record || record.phase !== 'prepared') throw new Error('Subscription import is unavailable.');
    this.assertImportRecord(record, record.facts.beforeGeneration);
  }
  beginPreparedImport(handle: PreparedSubscriptionImport): PreparedSubscriptionImportTransition {
    this.assertPreparedImport(handle); const record = this.preparedImports.get(handle)!;
    const transition = Object.freeze({}) as PreparedSubscriptionImportTransition;
    record.phase = 'pending'; record.transition = transition; this.importGeneration++;
    this.assertPreparedImportTransition(handle, transition); return transition;
  }
  inspectPreparedImportTransition(handle: PreparedSubscriptionImport, transition: PreparedSubscriptionImportTransition): PreparedImportTransitionFacts {
    this.assertPreparedImportTransition(handle, transition); const record = this.preparedImports.get(handle)!;
    return Object.freeze({ beforeGeneration: record.facts.beforeGeneration, afterGeneration: this.importGeneration, phase: record.phase === 'committed' ? 'committed' : 'pending' });
  }
  assertPreparedImportTransition(handle: PreparedSubscriptionImport, transition: PreparedSubscriptionImportTransition): void {
    const record = this.preparedImports.get(handle);
    if (!record || record.transition !== transition || !['pending', 'committing', 'committed'].includes(record.phase)) throw new Error('Subscription import transition is not authentic.');
    this.assertImportRecord(record, record.facts.beforeGeneration + (record.phase === 'committed' ? 2 : 1));
  }
  finishPreparedImport(handle: PreparedSubscriptionImport, transition: PreparedSubscriptionImportTransition, beforeEffect: () => void): PreparedConfigMutationReceipt {
    const record = this.preparedImports.get(handle);
    if (!record || record.phase !== 'pending' || record.transition !== transition) throw new Error('Subscription import is spent.');
    record.phase = 'committing';
    const completedPaths: string[] = [];
    try {
      const current = () => { beforeEffect(); this.assertPreparedImportTransition(handle, transition); };
      current();
      writeJsonFileAtomic(this.path, record.store, { mode: 0o600, cleanupStaleTemps: false, assertCurrent: current });
      completedPaths.push(this.path); record.observation = observeImportFile(this.path); record.phase = 'committed';
    } catch { record.phase = 'failed'; }
    finally { this.importGeneration++; }
    return Object.freeze({ status: record.phase === 'committed' ? 'committed' : completedPaths.length ? 'partial' : 'unknown', completedPaths: Object.freeze(completedPaths),
      ...(record.phase === 'failed' ? { uncertainPath: this.path } : {}) });
  }
  assertCompletedImport(handle: PreparedSubscriptionImport): void {
    const record = this.preparedImports.get(handle);
    if (!record || record.phase !== 'committed') throw new Error('Subscription import did not commit.');
    this.assertImportRecord(record, record.facts.beforeGeneration + 2);
  }

  public constructor(path: string, options: SubscriptionManagerOptions = {}) {
    this.path = path;
    if (options.legacyPath && options.legacyPath !== path) {
      this.foldLegacyStore(options.legacyPath);
    }
  }

  /**
   * Best-effort, READ-ONLY parse of a legacy store for migration. Never
   * throws and never quarantines: quarantining renames the file, and a
   * legacy path is not this manager's file to touch, an older build still
   * pointed at it must find it exactly as it left it, corrupt or not. Any
   * parse failure just yields nothing to fold, which is the same outcome as
   * "no legacy store existed".
   */
  private readLegacyStoreReadOnly(path: string): SubscriptionStore {
    const empty: SubscriptionStore = { version: 1, subscriptions: {}, pending: {} };
    try {
      if (!existsSync(path)) return empty;
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;
      const store = parsed as Partial<SubscriptionStore>;
      return {
        version: 1,
        subscriptions: (store.subscriptions && typeof store.subscriptions === 'object') ? store.subscriptions : {},
        pending: (store.pending && typeof store.pending === 'object') ? store.pending : {},
      };
    } catch {
      return empty;
    }
  }

  /**
   * One-time fold of a legacy per-surface store into this (now shared)
   * store, run synchronously at construction so every code path that reads
   * `get()`/`resolveAccessToken()` right after construction already sees the
   * folded result.
   *
   * Per provider, the newer `updatedAt` wins; a provider already in the
   * shared store with an equal-or-newer record is left untouched. That
   * strict `>` comparison is what makes a second boot a no-op instead of a
   * re-fold or a downgrade: once the shared record's `updatedAt` is at least
   * as new as the legacy one (which it is, immediately after the first
   * fold), the same legacy file folds in nothing on every later boot. Only
   * `subscriptions` are folded, `pending` OAuth logins carry a verifier tied
   * to one in-flight browser round trip and are meaningless to resume across
   * processes or after a restart.
   *
   * Never writes to or deletes the legacy file. Writes the shared store, and
   * logs one info line naming what was adopted, only when something actually
   * changed.
   */
  private foldLegacyStore(legacyPath: string): void {
    const legacy = this.readLegacyStoreReadOnly(legacyPath);
    const legacyEntries = Object.entries(legacy.subscriptions);
    if (legacyEntries.length === 0) return;

    const shared = this.read();
    const adopted: string[] = [];
    for (const [provider, legacyRecord] of legacyEntries) {
      const sharedRecord = shared.subscriptions[provider];
      if (!sharedRecord || legacyRecord.updatedAt > sharedRecord.updatedAt) {
        shared.subscriptions[provider] = legacyRecord;
        adopted.push(provider);
      }
    }
    if (adopted.length === 0) return;

    this.write(shared);
    logger.info('SubscriptionManager: folded legacy provider subscriptions into the shared store', {
      sharedPath: this.path,
      legacyPath,
      adopted,
    });
  }

  /**
   * Read the subscription store, never throwing.
   *
   * Corrupt content is quarantined (moved aside with a `.why` receipt and
   * logged at error level) instead of being silently discarded the way the
   * bare `catch` here used to discard it, the caller still gets the same
   * empty store, but the evidence of what went wrong survives on disk. A read
   * failure that leaves nothing to quarantine (permissions) also degrades to
   * the empty store, preserving this method's never-throws contract.
   */
  private read(): SubscriptionStore {
    const empty: SubscriptionStore = { version: 1, subscriptions: {}, pending: {} };
    try {
      return (
        readJsonFileOrQuarantine<SubscriptionStore>(this.path, {
          label: 'config/subscriptions',
          recovery:
            'Provider subscriptions are re-recorded the next time a provider subscription login completes; no stored credential is lost, because subscription secrets live in the secrets store, not here.',
          validate: (parsed) => {
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
              throw new Error('subscription store is not a JSON object');
            }
            return parsed as SubscriptionStore;
          },
        }) ?? empty
      );
    } catch {
      return empty;
    }
  }

  private write(store: SubscriptionStore): void {
    this.importGeneration++;
    try { writeJsonFileAtomic(this.path, store); } finally { this.importGeneration++; }
  }

  public list(): ProviderSubscription[] {
    return Object.values(this.read().subscriptions).sort((a, b) => a.provider.localeCompare(b.provider));
  }

  public listPending(): PendingSubscriptionLogin[] {
    return Object.values(this.read().pending).sort((a, b) => a.provider.localeCompare(b.provider));
  }

  public get(provider: string): ProviderSubscription | null {
    return this.read().subscriptions[provider] ?? null;
  }

  public getAccessToken(provider: string): string | null {
    const subscription = this.get(provider);
    if (!subscription?.overrideAmbientApiKeys) return null;
    return subscription.accessToken;
  }

  public async resolveAccessToken(
    provider: string,
    config: OAuthProviderConfig,
  ): Promise<string | null> {
    const subscription = this.get(provider);
    if (!subscription) return null;
    const active = isSubscriptionExpired(subscription.expiresAt)
      ? await this.refreshOAuthToken(provider, config)
      : subscription;
    return active.accessToken;
  }

  public async beginOAuthLogin(provider: string, config: OAuthProviderConfig): Promise<{ authorizationUrl: string; pending: PendingSubscriptionLogin }> {
    const store = this.read();
    const state = createOAuthState();
    const verifier = createPkceVerifier();
    const redirectUri = config.redirectUri;
    const pending: PendingSubscriptionLogin = {
      provider,
      state,
      verifier,
      redirectUri,
      createdAt: Date.now(),
    };
    const started = await buildOAuthAuthorizationStart(config, { state, verifier, redirectUri });
    store.pending[provider] = pending;
    this.write(store);
    return {
      authorizationUrl: started.authorizationUrl,
      pending,
    };
  }

  public async completeOAuthLogin(
    provider: string,
    config: OAuthProviderConfig,
    code: string,
  ): Promise<ProviderSubscription> {
    const store = this.read();
    const pending = store.pending[provider]!;
    if (!pending) {
      throw new Error(`No pending OAuth login for ${provider}. Start with /subscription login ${provider} start.`);
    }

    const tokenResponse = await exchangeOAuthAuthorizationCode(config, {
      code,
      verifier: pending.verifier,
      redirectUri: pending.redirectUri,
      state: pending.state,
    });
    const now = Date.now();
    const subscription: ProviderSubscription = {
      provider,
      accessToken: tokenResponse.accessToken,
      ...(typeof tokenResponse.refreshToken === 'string' && tokenResponse.refreshToken.length > 0
        ? { refreshToken: tokenResponse.refreshToken }
        : {}),
      tokenType: tokenResponse.tokenType,
      ...(typeof tokenResponse.expiresAt === 'number' && Number.isFinite(tokenResponse.expiresAt)
        ? { expiresAt: tokenResponse.expiresAt }
        : {}),
      ...(tokenResponse.scopes ? { scopes: tokenResponse.scopes } : {}),
      authMode: 'oauth',
      overrideAmbientApiKeys: config.overrideAmbientApiKeys ?? true,
      createdAt: store.subscriptions[provider]?.createdAt ?? now,
      updatedAt: now,
    };
    store.subscriptions[provider] = subscription;
    delete store.pending[provider];
    this.write(store);
    return subscription;
  }

  public async refreshOAuthToken(
    provider: string,
    config: OAuthProviderConfig,
  ): Promise<ProviderSubscription> {
    const store = this.read();
    const existing = store.subscriptions[provider]!;
    if (!existing) {
      throw new Error(`No stored OAuth subscription for ${provider}.`);
    }
    if (!existing.refreshToken) {
      return existing;
    }

    const tokenResponse = await refreshOAuthAccessToken(config, existing.refreshToken);

    const now = Date.now();
    const refreshed: ProviderSubscription = {
      ...existing,
      accessToken: tokenResponse.accessToken,
      refreshToken: typeof tokenResponse.refreshToken === 'string' && tokenResponse.refreshToken.length > 0
        ? tokenResponse.refreshToken
        : existing.refreshToken,
      tokenType: typeof tokenResponse.tokenType === 'string' && tokenResponse.tokenType.length > 0
        ? tokenResponse.tokenType
        : existing.tokenType,
      ...(typeof tokenResponse.expiresAt === 'number' && Number.isFinite(tokenResponse.expiresAt)
        ? { expiresAt: tokenResponse.expiresAt }
        : typeof existing.expiresAt === 'number' ? { expiresAt: existing.expiresAt } : {}),
      ...(tokenResponse.scopes ? { scopes: tokenResponse.scopes } : existing.scopes ? { scopes: existing.scopes } : {}),
      updatedAt: now,
    };

    store.subscriptions[provider] = refreshed;
    this.write(store);
    return refreshed;
  }

  public logout(provider: string): boolean {
    const store = this.read();
    const existed = provider in store.subscriptions || provider in store.pending;
    delete store.subscriptions[provider];
    delete store.pending[provider];
    this.write(store);
    return existed;
  }

  public getPending(provider: string): PendingSubscriptionLogin | null {
    return this.read().pending[provider] ?? null;
  }

  public savePending(pending: PendingSubscriptionLogin): void {
    const store = this.read();
    store.pending[pending.provider] = pending;
    this.write(store);
  }

  public clearPending(provider: string): void {
    const store = this.read();
    delete store.pending[provider];
    this.write(store);
  }

  public saveSubscription(subscription: ProviderSubscription): ProviderSubscription {
    const store = this.read();
    store.subscriptions[subscription.provider] = subscription;
    delete store.pending[subscription.provider];
    this.write(store);
    return subscription;
  }
}

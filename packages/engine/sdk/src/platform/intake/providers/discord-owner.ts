import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { createProtectedSourceOwner } from '../../security/source-screening/owner.js';
import type { ProtectedSourceOwnerOptions } from '../../security/source-screening/types.js';
import type { IntakeCredentialSnapshot } from '../context.js';
import { createProtectedInboxMapper } from '../protected-preview.js';
import type { AdapterContext, InboundProviderAdapter, ProviderPollOptions, ProviderPollResult } from '../provider-adapter.js';
import { POLL_CADENCE_MS } from '../provider-adapter.js';
import type { OwnedInboxReadLease } from '../registration.js';
import { createDiscordInboxAdapter, type DiscordInboxHttp } from './discord.js';
import { createDiscordInboxHttpOwner } from './discord-http.js';

const KEY = 'surfaces.discord.botToken';
const AUTH_URL = 'https://discord.com/api/v10/users/@me';

export interface DiscordInboxAccount {
  readonly userId: string;
}

/** Trusted local scope, never an inferred provider payload or a complete historical DM list.
 * All listed channels are required; every one must be readable by this account.
 */
export interface DiscordInboxChannelScope {
  readonly channelIds: readonly string[];
  readonly revision: string;
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
}
export interface DiscordInboxOwnerOptions {
  readonly channels: DiscordInboxChannelScope;
  /** Expected provider identity, established by the trusted composition root. */
  readonly account: DiscordInboxAccount;
  /** Actual local-service provenance/retention capability, never a source flag. */
  readonly screening: ProtectedSourceOwnerOptions;
  /** Live local workspace/configuration binding, separate from API identity. */
  readonly assertCurrent: () => void;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/** A constructor seam for hosts/tests; never decoded from settings or messages. */
export interface DiscordInboxOwnerFactories {
  /** The HTTP owner still supplies its fixed logical origin and locked TLS options. */
  readonly createHttpClient?: Parameters<typeof createDiscordInboxHttpOwner>[0]['createClient'];
}

export interface DiscordInboxOwner {
  readonly account: DiscordInboxAccount;
  /** Opaque stable account discriminator, independent of credential rotation. */
  readonly scopeId: string;
  readonly adapter: InboundProviderAdapter;
  /** A changed credential must prove the same identity before stored rows leave. */
  assertReadCurrent(): Promise<void>;
  /** Capture one identity generation across an asynchronous mirror read. */
  acquireReadLease?(): Promise<OwnedInboxReadLease>;
  /** Metadata-only exact-account proof, revoked by credential/scope/source changes. */
  verifyEligibility?(): Promise<{ readonly signal: AbortSignal; assertCurrent(): void }>;
  /** Trusted host credential lifecycle hook, including alias and ABA changes. */
  invalidateCredential?(): void;
  close(): Promise<void>;
}

/** Concrete owners provide proof; legacy host-owned adapter seams remain compatible. */
export interface VerifiedDiscordInboxOwner extends DiscordInboxOwner {
  acquireReadLease(): Promise<OwnedInboxReadLease>;
  verifyEligibility(): Promise<{ readonly signal: AbortSignal; assertCurrent(): void }>;
  invalidateCredential(): void;
}

function snowflake(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) < (1n << 64n);
}
function captureAccount(value: DiscordInboxAccount): DiscordInboxAccount {
  if (!value || typeof value !== 'object' || types.isProxy(value)) throw new Error('Discord inbox account is invalid');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== 1 || !descriptors.userId || !('value' in descriptors.userId)
    || !snowflake(descriptors.userId.value)) throw new Error('Discord inbox account is invalid');
  return Object.freeze({ userId: descriptors.userId.value });
}
function captureChannels(value: DiscordInboxChannelScope): DiscordInboxChannelScope {
  if (!value || typeof value !== 'object' || types.isProxy(value)) throw new Error('Discord inbox channel authority is invalid');
  const fields = Object.getOwnPropertyDescriptors(value);
  const names = ['channelIds', 'revision', 'signal', 'assertCurrent'];
  if (Reflect.ownKeys(value).length !== names.length || names.some(name => !fields[name] || !('value' in fields[name]))) {
    throw new Error('Discord inbox channel authority is invalid');
  }
  const ids: unknown = fields.channelIds!.value;
  if (!Array.isArray(ids) || types.isProxy(ids) || ids.length < 1 || ids.length > 200
    || Reflect.ownKeys(ids).length !== ids.length + 1) throw new Error('Discord inbox channel scope is invalid');
  const channels: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    const field = Object.getOwnPropertyDescriptor(ids, String(i));
    if (!field || !('value' in field) || !snowflake(field.value)) throw new Error('Discord inbox channel scope is invalid');
    channels.push(field.value);
  }
  if (new Set(channels).size !== channels.length || typeof fields.revision!.value !== 'string'
    || !fields.revision!.value || fields.revision!.value.length > 200 || !(fields.signal!.value instanceof AbortSignal)
    || typeof fields.assertCurrent!.value !== 'function') throw new Error('Discord inbox channel authority is invalid');
  return Object.freeze({ channelIds: Object.freeze(channels.sort()), revision: fields.revision!.value,
    signal: fields.signal!.value, assertCurrent: fields.assertCurrent!.value });
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function unavailable(configured?: boolean): ProviderPollResult {
  return { items: [], state: 'unavailable', error: 'Discord inbox account or source is unavailable', ...(configured === undefined ? {} : { configured }) };
}
function usableToken(token: string | null): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9._-]{1,4096}$/.test(token);
}

/** Explicit real provider owner; nothing polls, reads credentials or registers at construction. */
export async function createDiscordInboxOwner(
  context: Pick<AdapterContext, 'credentials' | 'logger' | 'resolveRouteId'>,
  options: DiscordInboxOwnerOptions,
  factories: DiscordInboxOwnerFactories = {},
): Promise<VerifiedDiscordInboxOwner> {
  const account = captureAccount(options.account);
  const channels = captureChannels(options.channels);
  const resolveCredential = context.credentials.resolveConfigSecret.bind(context.credentials);
  const observeCredential = context.credentials.resolveConfigCredentialSnapshot?.bind(context.credentials);
  if (!observeCredential) throw new Error('Discord inbox requires exact local credential ownership');
  const resolveRouteId = context.resolveRouteId;
  const scopeId = digest(JSON.stringify(['discord-inbox', 1, account.userId, channels.channelIds, channels.revision,
    options.screening.authority.ownerId, options.screening.authority.revision]));
  const lifetime = new AbortController();
  const signal = AbortSignal.any([lifetime.signal, channels.signal, options.screening.authority.signal, ...(options.signal ? [options.signal] : [])]);
  const assertScope = options.assertCurrent;
  const sourceAuthority = options.screening.authority;
  const assertSource = sourceAuthority.assertCurrent;
  const active = new Set<Promise<unknown>>();
  let closed = false;
  let closing: Promise<void> | undefined;
  let verifiedCredential: string | undefined;
  let credentialObservation: Exclude<IntakeCredentialSnapshot, { state: 'unsupported' }> | undefined;
  let identityEpoch = 0;
  let identityLifetime = new AbortController();
  let identitySignal = AbortSignal.any([signal, identityLifetime.signal]);
  let commitEpoch: number | undefined;
  let pollSignal: AbortSignal | undefined;
  const invalidateIdentity = (): void => {
    const retired = identityLifetime;
    verifiedCredential = undefined; credentialObservation = undefined; identityEpoch += 1; commitEpoch = undefined;
    identityLifetime = new AbortController();
    identitySignal = AbortSignal.any([signal, identityLifetime.signal]);
    retired.abort();
  };

  const current = (): void => {
    try {
      if (closed || signal.aborted) throw new Error();
      const result: unknown = assertScope();
      if (result !== null && (typeof result === 'object' || typeof result === 'function') && 'then' in result) {
        void Promise.resolve(result).catch(() => {});
        throw new Error();
      }
      const channelResult: unknown = channels.assertCurrent();
      if (channelResult !== undefined) {
        if (types.isPromise(channelResult)) void channelResult.catch(() => {});
        throw new Error();
      }
      const sourceResult: unknown = assertSource.call(sourceAuthority);
      if (sourceResult !== undefined) {
        if (types.isPromise(sourceResult)) void sourceResult.catch(() => {});
        throw new Error();
      }
      if (closed || signal.aborted) throw new Error();
    } catch { invalidateIdentity(); throw new Error('Discord inbox account scope is unavailable'); }
  };
  current();
  const screening = createProtectedSourceOwner({ ...options.screening,
    authority: { ...options.screening.authority, signal,
      assertCurrent() { current(); return assertSource.call(sourceAuthority); } },
  });
  const mapper = createProtectedInboxMapper(screening);
  let httpOwner: ReturnType<typeof createDiscordInboxHttpOwner>;
  try {
    httpOwner = createDiscordInboxHttpOwner({
      signal, channelIds: channels.channelIds, assertCurrent: current, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      onAuthenticationDenied: invalidateIdentity,
      ...(factories.createHttpClient === undefined ? {} : { createClient: factories.createHttpClient }),
    });
  } catch {
    lifetime.abort();
    await screening.close();
    throw new Error('Discord inbox transport construction failed');
  }
  const own = <T>(action: () => Promise<T>): Promise<T> => {
    const work = Promise.resolve().then(() => { current(); return action(); });
    active.add(work);
    void work.then(() => active.delete(work), () => active.delete(work));
    return work;
  };
  const sameObservation = (a: IntakeCredentialSnapshot, b: IntakeCredentialSnapshot): boolean =>
    a.state !== 'unsupported' && b.state !== 'unsupported' && a.state === b.state && a.revision === b.revision
    && (a.state !== 'resolved' || (b.state === 'resolved' && a.value === b.value));
  const assertCredentialCurrent = (): void => {
    if (!credentialObservation || !sameObservation(credentialObservation, observeCredential(KEY))) {
      invalidateIdentity(); throw new Error('Discord inbox credential incarnation was revoked');
    }
  };
  const readCredential = async (): Promise<string | null> => {
    current();
    const observation = observeCredential(KEY);
    if (observation.state === 'unsupported') { invalidateIdentity(); throw new Error('Discord inbox local credential is unavailable'); }
    if (credentialObservation && !sameObservation(credentialObservation, observation)) invalidateIdentity();
    const epoch = identityEpoch;
    const value = await resolveCredential(KEY);
    current();
    if (epoch !== identityEpoch || !sameObservation(observation, observeCredential(KEY))
      || value !== (observation.state === 'resolved' ? observation.value : null)) {
      invalidateIdentity(); throw new Error('Discord inbox credential observation was revoked');
    }
    credentialObservation = observation;
    return value;
  };
  const matchesAccount = (body: unknown): boolean => {
    if (body === null || typeof body !== 'object' || types.isProxy(body) || Array.isArray(body)) return false;
    const fields = Object.getOwnPropertyDescriptors(body);
    return fields.id?.value === account.userId && fields.bot?.value === true;
  };
  const identityHttp = (token: string, onVerified: (epoch: number) => void): DiscordInboxHttp => async (url, request) => {
    current();
    if (request.headers.Authorization !== `Bot ${token}`) throw new Error('Discord inbox credential scope changed');
    const epoch = identityEpoch;
    const response = await httpOwner.http(url, request);
    current();
    if (url.pathname === '/api/v10/users/@me') {
      if (!response.ok || !matchesAccount(response.body)) {
        // Transport outages throw before this point. A decoded authentication
        // denial, malformed identity or different account invalidates proof.
        invalidateIdentity();
        throw new Error('Discord inbox account verification unavailable');
      }
      if (epoch !== identityEpoch) throw new Error('Discord inbox identity proof was revoked');
      onVerified(epoch);
    }
    return response;
  };

  const readCatalog = async (token: string, input: { selfId: string; beforeMs: number; signal?: AbortSignal }) => {
    current();
    if (input.selfId !== account.userId || input.signal?.aborted) throw new Error('Discord inbox catalog is unavailable');
    const epoch = identityEpoch;
    const found: { id: string; type: 1 | 3 }[] = [];
    for (const id of channels.channelIds) {
      const response = await httpOwner.http(new URL(`https://discord.com/api/v10/channels/${id}`), {
        method: 'GET', headers: { Authorization: `Bot ${token}`, Accept: 'application/json' },
        signal: input.signal ? AbortSignal.any([signal, input.signal]) : signal,
      });
      current();
      const body = response.body;
      if (!response.ok || !body || typeof body !== 'object' || types.isProxy(body) || Array.isArray(body)) {
        invalidateIdentity(); throw new Error('Discord inbox channel is unavailable');
      }
      const fields = Object.getOwnPropertyDescriptors(body);
      if (fields.id?.value !== id || (fields.type?.value !== 1 && fields.type?.value !== 3)
        || fields.guild_id?.value !== undefined) {
        invalidateIdentity(); throw new Error('Discord inbox channel scope mismatch');
      }
      found.push({ id, type: fields.type.value as 1 | 3 });
    }
    current();
    if (epoch !== identityEpoch || input.signal?.aborted || await readCredential() !== token) {
      invalidateIdentity(); throw new Error('Discord inbox catalog was revoked');
    }
    // Complete only for the explicit immutable intended-channel scope above.
    // No bot REST endpoint is claimed to enumerate historical private channels.
    return { complete: true, accountId: account.userId, channels: found };
  };

  const adapter: InboundProviderAdapter = {
    id: 'discord', pollIntervalMs: POLL_CADENCE_MS.realtime,
    assertCurrent() {
      current(); assertCredentialCurrent();
      if (commitEpoch === undefined || commitEpoch !== identityEpoch || !verifiedCredential || pollSignal?.aborted) {
        throw new Error('Discord inbox poll identity is unavailable');
      }
    },
    async poll(options: ProviderPollOptions): Promise<ProviderPollResult> {
      commitEpoch = undefined; pollSignal = options.signal;
      let configured: boolean | undefined;
      try {
        return await own(async () => {
          const token = await readCredential();
          if (!usableToken(token)) { configured = false; invalidateIdentity(); return unavailable(false); }
          configured = true;
          if (verifiedCredential && verifiedCredential !== digest(token)) invalidateIdentity();
          let verified: number | undefined;
          const delegate = createDiscordInboxAdapter({ logger: context.logger,
            ...(resolveRouteId ? { resolveRouteId } : {}),
            credentials: { resolveRef: async () => null, resolveConfigSecret: async (key) => key === KEY ? token : null },
          }, { http: identityHttp(token, (epoch) => { verified = epoch; }),
            listDmChannels: input => readCatalog(token, input), mapItem: mapper });
          const result = await delegate.poll(options);
          current();
          // A token swapped during API/mapping work cannot commit an old poll.
          if (await readCredential() !== token) { invalidateIdentity(); return unavailable(true); }
          // A later auth denial must not be overwritten by an older mapper/read.
          if (verified !== undefined && verified !== identityEpoch) return unavailable(true);
          if (verified !== undefined) { verifiedCredential = digest(token); commitEpoch = verified; }
          return result;
        });
      } catch { return unavailable(configured); }
    },
  };

  const verifyIdentity = (force: boolean): Promise<number> => own(async () => {
    try {
      const token = await readCredential();
      if (!usableToken(token)) { invalidateIdentity(); throw new Error(); }
      const fingerprint = digest(token);
      if (verifiedCredential && verifiedCredential !== fingerprint) invalidateIdentity();
      if (force || verifiedCredential !== fingerprint) {
        let verified: number | undefined;
        await identityHttp(token, (epoch) => { verified = epoch; })(new URL(AUTH_URL), {
          method: 'GET', headers: { Authorization: `Bot ${token}`, Accept: 'application/json' }, signal,
        });
        if (await readCredential() !== token) { invalidateIdentity(); throw new Error(); }
        if (verified === undefined || verified !== identityEpoch) throw new Error();
        verifiedCredential = fingerprint;
      }
      await readCatalog(token, { selfId: account.userId, beforeMs: Date.now(), signal });
      current();
      return identityEpoch;
    } catch { throw new Error('Discord inbox account scope is unavailable'); }
  });
  return {
    account, scopeId, adapter,
    invalidateCredential: invalidateIdentity,
    async assertReadCurrent() { await verifyIdentity(true); },
    async acquireReadLease() {
      const epoch = await verifyIdentity(true);
      const observed = identityLifetime;
      const assertCurrent = (): void => {
        current(); assertCredentialCurrent();
        if (observed.signal.aborted || epoch !== identityEpoch || !verifiedCredential) {
          throw new Error('Discord inbox read identity was revoked');
        }
      };
      assertCurrent();
      return Object.freeze(Object.assign(async () => {
        assertCurrent();
        const latest = await verifyIdentity(true);
        assertCurrent();
        if (latest !== epoch) throw new Error('Discord inbox read identity was revoked');
      }, { assertCurrent }));
    },
    async verifyEligibility() {
      const epoch = await verifyIdentity(true);
      current();
      if (epoch !== identityEpoch) throw new Error('Discord inbox eligibility was revoked');
      const observed = identityLifetime;
      if (!verifiedCredential) throw new Error('Discord inbox account scope is unavailable');
      return Object.freeze({ signal: identitySignal, assertCurrent() {
        current(); assertCredentialCurrent();
        if (observed.signal.aborted || epoch !== identityEpoch || !verifiedCredential) {
          throw new Error('Discord inbox eligibility was revoked');
        }
      } });
    },
    close() {
      if (!closing) {
        closed = true;
        let resolve!: () => void;
        let reject!: (error: unknown) => void;
        // Abort callbacks can synchronously reenter close; publish ownership first.
        closing = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
        lifetime.abort();
        void Promise.all([Promise.allSettled([screening.close(), httpOwner.close()]), Promise.allSettled([...active])]).then(([cleanup]) => {
          if (cleanup.some((result) => result.status === 'rejected')) throw new Error('Discord inbox cleanup failed');
        }).then(resolve, reject);
      }
      return closing;
    },
  };
}

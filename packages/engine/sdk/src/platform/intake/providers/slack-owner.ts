import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { createProtectedSourceOwner } from '../../security/source-screening/owner.js';
import type { ProtectedSourceOwnerOptions } from '../../security/source-screening/types.js';
import { createProtectedInboxMapper } from '../protected-preview.js';
import type { AdapterContext, InboundProviderAdapter, ProviderPollOptions, ProviderPollResult } from '../provider-adapter.js';
import { POLL_CADENCE_MS } from '../provider-adapter.js';
import { createSlackInboxAdapter, type SlackInboxHttp } from './slack.js';
import { createSlackInboxHttpOwner } from './slack-http.js';

const KEY = 'surfaces.slack.botToken';
const AUTH_URL = 'https://slack.com/api/auth.test';

export interface SlackInboxAccount {
  readonly workspaceId: string;
  readonly userId: string;
}

export interface SlackInboxOwnerOptions {
  /** Expected provider identity, established by the trusted composition root. */
  readonly account: SlackInboxAccount;
  /** Actual local-service provenance/retention capability, never a source flag. */
  readonly screening: ProtectedSourceOwnerOptions;
  /** Live local workspace/configuration binding, separate from API identity. */
  readonly assertCurrent: () => void;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/** A constructor seam for hosts/tests; never decoded from settings or messages. */
export interface SlackInboxOwnerFactories {
  /** The HTTP owner still supplies its fixed logical origin and locked TLS options. */
  readonly createHttpClient?: Parameters<typeof createSlackInboxHttpOwner>[0]['createClient'];
}

export interface SlackInboxOwner {
  readonly account: SlackInboxAccount;
  /** Opaque stable account discriminator, independent of credential rotation. */
  readonly scopeId: string;
  readonly adapter: InboundProviderAdapter;
  /** A changed credential must prove the same identity before stored rows leave. */
  assertReadCurrent(): Promise<void>;
  close(): Promise<void>;
}

function captureAccount(value: SlackInboxAccount): SlackInboxAccount {
  if (!value || typeof value !== 'object' || types.isProxy(value)) throw new Error('Slack inbox account is invalid');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== 2 || !descriptors.workspaceId || !descriptors.userId) throw new Error('Slack inbox account is invalid');
  const fields = [descriptors.workspaceId, descriptors.userId].map((field) => {
    if (!('value' in field) || typeof field.value !== 'string' || !field.value || field.value.length > 200 || field.value !== field.value.trim()) throw new Error('Slack inbox account is invalid');
    return field.value;
  });
  return Object.freeze({ workspaceId: fields[0]!, userId: fields[1]! });
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function unavailable(configured?: boolean): ProviderPollResult {
  return { items: [], state: 'unavailable', error: 'Slack inbox account or source is unavailable', ...(configured === undefined ? {} : { configured }) };
}
function usableToken(token: string | null): token is string {
  return typeof token === 'string' && (token.startsWith('xoxb-') || token.startsWith('xoxp-'));
}

/** Explicit real provider owner; nothing polls, reads credentials or registers at construction. */
export async function createSlackInboxOwner(
  context: Pick<AdapterContext, 'credentials' | 'logger'>,
  options: SlackInboxOwnerOptions,
  factories: SlackInboxOwnerFactories = {},
): Promise<SlackInboxOwner> {
  const account = captureAccount(options.account);
  const scopeId = digest(JSON.stringify(['slack-inbox', 1, account.workspaceId, account.userId]));
  const lifetime = new AbortController();
  const signal = AbortSignal.any([lifetime.signal, options.screening.authority.signal, ...(options.signal ? [options.signal] : [])]);
  const assertScope = options.assertCurrent;
  const sourceAuthority = options.screening.authority;
  const assertSource = sourceAuthority.assertCurrent;
  const active = new Set<Promise<unknown>>();
  let closed = false;
  let closing: Promise<void> | undefined;
  let verifiedCredential: string | undefined;
  let identityEpoch = 0;
  const invalidateIdentity = (): void => { verifiedCredential = undefined; identityEpoch += 1; };

  const current = (): void => {
    try {
      if (closed || signal.aborted) throw new Error();
      const result: unknown = assertScope();
      if (result !== null && (typeof result === 'object' || typeof result === 'function') && 'then' in result) {
        void Promise.resolve(result).catch(() => {});
        throw new Error();
      }
      if (closed || signal.aborted) throw new Error();
    } catch { throw new Error('Slack inbox account scope is unavailable'); }
  };
  current();
  const screening = createProtectedSourceOwner({ ...options.screening,
    authority: { ...options.screening.authority, signal,
      assertCurrent() { current(); return assertSource.call(sourceAuthority); } },
  });
  const mapper = createProtectedInboxMapper(screening);
  let httpOwner: ReturnType<typeof createSlackInboxHttpOwner>;
  try {
    httpOwner = createSlackInboxHttpOwner({
      signal, assertCurrent: current, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      onAuthenticationDenied: invalidateIdentity,
      ...(factories.createHttpClient === undefined ? {} : { createClient: factories.createHttpClient }),
    });
  } catch {
    lifetime.abort();
    await screening.close();
    throw new Error('Slack inbox transport construction failed');
  }
  const own = <T>(action: () => Promise<T>): Promise<T> => {
    const work = Promise.resolve().then(() => { current(); return action(); });
    active.add(work);
    void work.then(() => active.delete(work), () => active.delete(work));
    return work;
  };
  const readCredential = async (): Promise<string | null> => {
    current();
    const value = await context.credentials.resolveConfigSecret(KEY);
    current();
    return value;
  };
  const matchesAccount = (body: unknown): boolean => {
    if (body === null || typeof body !== 'object' || types.isProxy(body) || Array.isArray(body)) return false;
    const fields = Object.getOwnPropertyDescriptors(body);
    return fields.ok?.value === true && fields.team_id?.value === account.workspaceId && fields.user_id?.value === account.userId;
  };
  const identityHttp = (token: string, onVerified: (epoch: number) => void): SlackInboxHttp => async (url, request) => {
    current();
    if (request.headers.Authorization !== `Bearer ${token}`) throw new Error('Slack inbox credential scope changed');
    const response = await httpOwner.http(url, request);
    current();
    if (url.pathname === '/api/auth.test') {
      if (!response.ok || !matchesAccount(response.body)) {
        // Transport outages throw before this point. A decoded authentication
        // denial, malformed identity or different account invalidates proof.
        invalidateIdentity();
        throw new Error('Slack inbox account verification unavailable');
      }
      onVerified(identityEpoch);
    }
    return response;
  };

  const adapter: InboundProviderAdapter = {
    id: 'slack', pollIntervalMs: POLL_CADENCE_MS.realtime,
    async poll(options: ProviderPollOptions): Promise<ProviderPollResult> {
      let configured: boolean | undefined;
      try {
        return await own(async () => {
          const token = await readCredential();
          if (!usableToken(token)) { configured = false; invalidateIdentity(); return unavailable(false); }
          configured = true;
          let verified: number | undefined;
          const delegate = createSlackInboxAdapter({ logger: context.logger,
            credentials: { resolveRef: async () => null, resolveConfigSecret: async (key) => key === KEY ? token : null },
          }, { http: identityHttp(token, (epoch) => { verified = epoch; }), mapItem: mapper });
          const result = await delegate.poll(options);
          current();
          // A token swapped during API/mapping work cannot commit an old poll.
          if (await readCredential() !== token) { invalidateIdentity(); return unavailable(true); }
          // A later auth denial must not be overwritten by an older mapper/read.
          if (verified !== undefined && verified !== identityEpoch) return unavailable(true);
          if (verified !== undefined) verifiedCredential = digest(token);
          return result;
        });
      } catch { return unavailable(configured); }
    },
  };

  return {
    account, scopeId, adapter,
    assertReadCurrent() {
      return own(async () => {
        try {
          const token = await readCredential();
          if (!usableToken(token)) { invalidateIdentity(); throw new Error(); }
          const fingerprint = digest(token);
          if (verifiedCredential !== fingerprint) {
            let verified: number | undefined;
            await identityHttp(token, (epoch) => { verified = epoch; })(new URL(AUTH_URL), {
              method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal,
            });
            if (await readCredential() !== token) { invalidateIdentity(); throw new Error(); }
            if (verified === undefined || verified !== identityEpoch) throw new Error();
            verifiedCredential = fingerprint;
          }
          current();
        } catch { throw new Error('Slack inbox account scope is unavailable'); }
      });
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
          if (cleanup.some((result) => result.status === 'rejected')) throw new Error('Slack inbox cleanup failed');
        }).then(resolve, reject);
      }
      return closing;
    },
  };
}

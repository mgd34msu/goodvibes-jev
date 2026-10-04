/**
 * Private Discord REST intake prerequisite, never registered by default.
 * HTTP, complete account-scoped DM discovery, and privacy admission belong to
 * explicit host ports. Source/repairs: docs/audit/daemon-discord-inbox-adapter.md.
 */
import type { AdapterContext, InboundChannelItem, InboundProviderAdapter, ProviderPollOptions, ProviderPollResult } from '../provider-adapter.js';
import { POLL_CADENCE_MS } from '../provider-adapter.js';

const PROVIDER = 'discord';
const CREDENTIAL_KEY = 'surfaces.discord.botToken';
const EPOCH_MS = 1_420_070_400_000;
const MAX_SNOWFLAKE = (1n << 64n) - 1n;
const MAX_CHANNELS = 200;
const PAGE_SIZE = 50;
const MAX_HISTORY_PAGES = 20;
const MAX_TOTAL_HISTORY_PAGES = 200;
const MAX_ITEMS = 1_000;

/** Resolves after decoding/cleanup; the host owns deadlines and body-byte caps. */
export type DiscordInboxHttp = (url: URL, request: {
  method: 'GET';
  headers: { Authorization: string; Accept: 'application/json' };
  signal?: AbortSignal;
}) => Promise<{ ok: boolean; body: unknown }>;

export interface DiscordInboxCatalogSnapshot {
  /** A positive assertion of gap-free discovery through beforeMs, not a cache. */
  readonly complete: boolean;
  readonly accountId: string;
  readonly channels: readonly { readonly id: string; readonly type: 1 | 3 }[];
}
/**
 * Required because no supported bot REST DM-list endpoint is documented.
 * Discovery must cover ALL intended DMs through the exclusive horizon and be
 * scoped to this account/cursor. The host owns its discovery resources and
 * cancellation; it must settle only after its work is drained.
 */
export type DiscordInboxCatalog = (input: {
  readonly selfId: string;
  readonly beforeMs: number;
  readonly signal?: AbortSignal;
}) => Promise<DiscordInboxCatalogSnapshot>;

/** Raw private input; never log or forward unchanged. */
export interface DiscordInboxMappingInput {
  readonly senderId: string;
  readonly channelId: string;
  readonly subject: 'Direct message';
  readonly text: string;
}
/**
 * Explicit host privacy admission: canonical first 16 hex characters of
 * SHA-256(senderId) and display-safe/PII-stripped previews per InboundChannelItem.
 * Shape validation cannot establish semantic privacy. Null withholds the poll.
 */
export interface DiscordInboxMappedFields {
  readonly fromDigest: string;
  readonly subjectPreview: string;
  readonly bodyPreview: string;
}
export type DiscordInboxMapper = (input: DiscordInboxMappingInput, signal?: AbortSignal) =>
  DiscordInboxMappedFields | null | undefined | Promise<DiscordInboxMappedFields | null | undefined>;
export interface DiscordInboxPorts {
  readonly http: DiscordInboxHttp;
  readonly listDmChannels: DiscordInboxCatalog;
  readonly mapItem: DiscordInboxMapper;
  /** Unix milliseconds, captured once before asynchronous work. */
  readonly now?: () => number;
}
interface Candidate {
  key: string;
  channelId: string;
  senderId: string;
  text: string;
  receivedAt: number;
  kind: InboundChannelItem['kind'];
}

// Closed diagnostics by private identity, never inspect an external rejection.
const diagnostics = new WeakMap<object, string>();
function fail(message: string): never {
  const error = new Error(message);
  diagnostics.set(error, message);
  throw error;
}
function diagnostic(error: unknown): string | undefined {
  return error !== null && (typeof error === 'object' || typeof error === 'function')
    ? diagnostics.get(error) : undefined;
}
function checkActive(signal?: AbortSignal): void {
  if (signal?.aborted) fail('Discord poll cancelled');
}
function unavailable(error: string, configured?: boolean): ProviderPollResult {
  return { items: [], state: 'unavailable', error, ...(configured === undefined ? {} : { configured }) };
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Discord response shape invalid');
  return value as Record<string, unknown>;
}
function rows(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail('Discord response page invalid');
  return value;
}
function snowflake(value: unknown): { id: string; value: bigint; ms: number } {
  if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value)) fail('Discord snowflake invalid');
  const numeric = BigInt(value);
  if (numeric > MAX_SNOWFLAKE) fail('Discord snowflake invalid');
  return { id: value, value: numeric, ms: Number(numeric >> 22n) + EPOCH_MS };
}
function classify(message: Record<string, unknown>, authorId: string | undefined, self: string): Candidate['kind'] {
  const reactions = message.reactions;
  if (reactions !== undefined && !Array.isArray(reactions)) fail('Discord response shape invalid');
  const mentions = message.mentions === undefined ? [] : rows(message.mentions, 1_000);
  const mentionedIds = mentions.map(value => snowflake(record(value).id).id);
  const reference = message.referenced_message;
  if (reference !== undefined && reference !== null) record(reference);
  if (authorId === self && Array.isArray(reactions) && reactions.length > 0) return 'reaction';
  if (mentionedIds.includes(self)) return 'mention';
  return reference ? 'thread' : 'dm';
}
function compare(a: Candidate, b: Candidate): number {
  return a.receivedAt - b.receivedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

/** Private factory: no implicit mapper, global fetch, registration or barrel. */
export function createDiscordInboxAdapter(ctx: AdapterContext, ports: DiscordInboxPorts): InboundProviderAdapter {
  if (typeof ports?.http !== 'function' || typeof ports?.mapItem !== 'function'
    || typeof ports?.listDmChannels !== 'function') {
    throw new Error('Discord inbox requires HTTP, a complete DM catalog and an explicit item mapper');
  }
  return {
    id: PROVIDER,
    pollIntervalMs: POLL_CADENCE_MS.realtime,
    async poll(opts: ProviderPollOptions): Promise<ProviderPollResult> {
      let configured: boolean | undefined;
      let stage = 'Discord poll failed';
      let signal: AbortSignal | undefined;
      try {
        // Snapshot caller accessors once; catch never rereads caller options.
        const { limit, since, signal: requestedSignal } = opts;
        signal = requestedSignal;
        checkActive(signal);
        const cutoff = Math.floor((ports.now ?? Date.now)());
        if (!Number.isSafeInteger(cutoff) || cutoff <= EPOCH_MS
          || cutoff > Number(MAX_SNOWFLAKE >> 22n) + EPOCH_MS
          || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ITEMS
          || (since !== undefined && (!Number.isSafeInteger(since) || since < 0))) {
          fail('Discord poll bounds invalid');
        }
        const horizon = BigInt(cutoff - EPOCH_MS) << 22n;
        stage = 'Discord credential lookup failed';
        const token = await ctx.credentials.resolveConfigSecret(CREDENTIAL_KEY);
        checkActive(signal);
        if (!token || !token.trim()) return unavailable('missing surfaces.discord.botToken', false);
        configured = true;
        const get = async (path: string, operation: 'self' | 'history', params: Record<string, string> = {}) => {
          checkActive(signal);
          stage = `Discord ${operation} request failed`;
          const url = new URL(`https://discord.com/api/v10${path}`);
          for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
          const response = await ports.http(url, {
            method: 'GET', headers: { Authorization: `Bot ${token}`, Accept: 'application/json' },
            ...(signal === undefined ? {} : { signal: signal }),
          });
          checkActive(signal);
          if (!response.ok) fail(`Discord ${operation} HTTP failure`);
          stage = `Discord ${operation} response unreadable`;
          return response.body;
        };
        // Unknown self identity cannot silently change mention/reaction kinds.
        const self = snowflake(record(await get('/users/@me', 'self')).id).id;
        stage = 'Discord DM catalog failed';
        const snapshot = record(await ports.listDmChannels({ selfId: self, beforeMs: cutoff,
          ...(signal === undefined ? {} : { signal: signal }) }));
        checkActive(signal);
        if (snapshot.complete !== true) fail('Discord DM catalog incomplete');
        if (snowflake(snapshot.accountId).id !== self) fail('Discord DM catalog account mismatch');
        const channels = new Set<string>();
        for (const entry of rows(snapshot.channels, MAX_CHANNELS)) {
          const channel = record(entry);
          const type = channel.type;
          if (type !== 1 && type !== 3) fail('Discord DM catalog channel invalid');
          channels.add(snowflake(channel.id).id);
        }
        // Only the oldest limit+1 distinct candidates are retained, but ALL
        // channels/window pages must finish before the global cursor can move.
        const candidates: Candidate[] = [];
        let totalHistoryPages = 0;
        for (const channelId of channels) {
          let before = horizon;
          for (let page = 0; ; page += 1) {
            if (page >= MAX_HISTORY_PAGES || totalHistoryPages >= MAX_TOTAL_HISTORY_PAGES) {
              fail('Discord history page budget exhausted');
            }
            totalHistoryPages += 1;
            const messages = rows(await get(`/channels/${channelId}/messages`, 'history', {
              limit: String(PAGE_SIZE), before: before.toString(),
            }), PAGE_SIZE);
            let oldest = before;
            for (const entry of messages) {
              const message = record(entry);
              const id = snowflake(message.id);
              if (id.value >= before) fail('Discord history cursor did not advance');
              if (id.value < oldest) oldest = id.value;
              if (message.channel_id !== undefined && snowflake(message.channel_id).id !== channelId) {
                fail('Discord history channel mismatch');
              }
              // One ordering for pagination, horizon and persisted watermark.
              // Discord's optional timestamp is not assumed equal to its ID.
              const receivedAt = id.ms;
              const authorValue = message.author;
              const author = authorValue === undefined ? undefined : record(authorValue);
              const bot = author?.bot;
              if (bot !== undefined && typeof bot !== 'boolean') fail('Discord response shape invalid');
              if (bot === true || receivedAt <= (since ?? 0)) continue;
              const authorId = author === undefined ? undefined : snowflake(author.id).id;
              const senderId = authorId ?? channelId;
              const text = message.content ?? '';
              if (typeof text !== 'string' || text.length > 40_000) fail('Discord response shape invalid');
              const key = `${channelId}:${id.id}`;
              if (candidates.some(candidate => candidate.key === key)) continue;
              candidates.push({ key, channelId, senderId, text, receivedAt,
                kind: classify(message, authorId, self) });
              candidates.sort(compare);
              if (candidates.length > limit + 1) candidates.pop();
            }
            if (messages.length < PAGE_SIZE || Number(oldest >> 22n) + EPOCH_MS <= (since ?? 0)) break;
            before = oldest;
          }
        }
        let selected = candidates.slice(0, limit);
        const omitted = candidates[limit];
        if (omitted) selected = selected.filter(candidate => candidate.receivedAt < omitted.receivedAt);
        if (candidates.length > 0 && selected.length === 0) fail('Discord item budget cannot cover timestamp group');
        const items: InboundChannelItem[] = [];
        for (const candidate of selected) {
          checkActive(signal);
          stage = 'Discord item mapping failed';
          const mapped = await ports.mapItem({ senderId: candidate.senderId, channelId: candidate.channelId,
            subject: 'Direct message', text: candidate.text }, signal);
          checkActive(signal);
          if (!mapped) fail('Discord item mapping withheld or invalid');
          const { fromDigest, subjectPreview, bodyPreview } = mapped;
          if (typeof fromDigest !== 'string' || !/^[a-f0-9]{16}$/.test(fromDigest)
            || typeof subjectPreview !== 'string' || subjectPreview.length > 200
            || typeof bodyPreview !== 'string' || bodyPreview.length > 500) fail('Discord item mapping withheld or invalid');
          const item: InboundChannelItem = {
            id: `discord:${candidate.key}`, provider: PROVIDER, kind: candidate.kind,
            fromDigest, subjectPreview, bodyPreview, receivedAt: candidate.receivedAt, unread: true,
          };
          if (ctx.resolveRouteId) {
            stage = 'Discord route resolution failed';
            try {
              const route = await ctx.resolveRouteId({ provider: PROVIDER, fromDigest, kind: item.kind });
              checkActive(signal);
              if (typeof route === 'string' && route.length > 0) item.routeId = route;
            } catch {
              checkActive(signal);
              try { await ctx.logger.warn('Discord route resolution failed'); } catch { /* Optional reporting. */ }
              checkActive(signal);
            }
          }
          items.push(item);
        }
        checkActive(signal);
        return { items, state: items.length ? 'ready' : 'empty', configured: true };
      } catch (error) {
        let aborted = false;
        try { aborted = signal?.aborted === true; } catch { /* A malformed host signal cannot escape. */ }
        return unavailable(aborted ? 'Discord poll cancelled' : diagnostic(error) ?? stage, configured);
      }
    },
  };
}

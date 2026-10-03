/**
 * Private Slack Web API intake prerequisite. Nothing registers this adapter.
 * The host must supply HTTP and a mapper that admits digest/previews under the
 * InboundChannelItem privacy contract. This module does not redact text, and
 * shape validation does not establish that the host's privacy work is correct.
 * Source/repairs: docs/audit/daemon-slack-inbox-adapter.md.
 */
import type { AdapterContext, InboundChannelItem, InboundProviderAdapter, ProviderPollOptions, ProviderPollResult } from '../provider-adapter.js';
import { POLL_CADENCE_MS } from '../provider-adapter.js';

const PROVIDER = 'slack';
const CREDENTIAL_KEY = 'surfaces.slack.botToken';
const MAX_LIST_PAGES = 50;
const MAX_HISTORY_PAGES = 20;
const MAX_TOTAL_HISTORY_PAGES = 200;
const MAX_ITEMS = 1_000;

/**
 * Resolves only after response decoding and resource cleanup. The host owns
 * transport timeouts/body-byte bounds and cancellation; the adapter awaits it.
 */
export type SlackInboxHttp = (url: URL, request: {
  method: 'GET';
  headers: { Authorization: string; Accept: 'application/json' };
  signal?: AbortSignal;
}) => Promise<{ ok: boolean; body: unknown }>;

/** Private, raw mapper input. It must never be logged or forwarded unchanged. */
export interface SlackInboxMappingInput {
  readonly senderId: string;
  readonly channelId: string;
  readonly subject: 'Direct message';
  readonly text: string;
}

/**
 * An explicit host admission decision. fromDigest is the first 16 hex
 * characters of SHA-256 of senderId; previews must satisfy
 * InboundChannelItem. No normalization helper alone implements this contract.
 * Returning null/undefined withholds the poll rather than silently skipping it.
 */
export interface SlackInboxMappedFields {
  readonly fromDigest: string;
  readonly subjectPreview: string;
  readonly bodyPreview: string;
}
export type SlackInboxMapper = (input: SlackInboxMappingInput, signal?: AbortSignal) =>
  SlackInboxMappedFields | null | undefined | Promise<SlackInboxMappedFields | null | undefined>;

export interface SlackInboxPorts {
  readonly http: SlackInboxHttp;
  readonly mapItem: SlackInboxMapper;
  /** Unix milliseconds, captured once before any asynchronous work. */
  readonly now?: () => number;
}

interface Candidate {
  key: string;
  channelId: string;
  senderId: string;
  text: string;
  ts: string;
  receivedAt: number;
  kind: InboundChannelItem['kind'];
}

/** Only adapter-created, closed diagnostics may reach its result. */
const diagnostics = new WeakMap<object, string>();
function fail(message: string): never {
  const error = new Error(message);
  diagnostics.set(error, message);
  throw error;
}
function diagnostic(error: unknown): string | undefined {
  // WeakMap identity lookup never inspects an external rejection value. Even
  // instanceof can execute a throwing Proxy getPrototypeOf trap.
  return error !== null && (typeof error === 'object' || typeof error === 'function')
    ? diagnostics.get(error) : undefined;
}
function checkActive(signal?: AbortSignal): void {
  if (signal?.aborted) fail('Slack poll cancelled');
}
function unavailable(error: string, configured?: boolean): ProviderPollResult {
  return { items: [], state: 'unavailable', error, ...(configured === undefined ? {} : { configured }) };
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Slack response shape invalid');
  return value as Record<string, unknown>;
}
function optionalString(value: unknown, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max) fail('Slack response shape invalid');
  return value;
}
function identifier(value: unknown): string {
  const result = optionalString(value, 200);
  if (!result) fail('Slack response identifier missing');
  return result;
}
function nextCursor(response: Record<string, unknown>): string | undefined {
  if (response.response_metadata === undefined) return undefined;
  const cursor = record(response.response_metadata).next_cursor;
  return cursor === null ? undefined : optionalString(cursor, 4_096) || undefined;
}
function rows(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail('Slack response page invalid');
  return value;
}
function timestamp(value: unknown): { ts: string; receivedAt: number } {
  // Slack's timestamp grammar, not a reading of message meaning. Parse decimal
  // components rather than accepting parseFloat's trailing garbage/exponents.
  if (typeof value !== 'string' || !/^\d{1,13}\.\d{6}$/.test(value)) fail('Slack message timestamp invalid');
  const [seconds, micros] = value.split('.');
  const receivedAt = Number(seconds) * 1_000 + Math.round(Number(micros) / 1_000);
  if (!Number.isSafeInteger(receivedAt) || receivedAt <= 0) fail('Slack message timestamp invalid');
  return { ts: value, receivedAt };
}
function classify(message: Record<string, unknown>, self: string, text: string, ts: string): Candidate['kind'] {
  if (message.reactions !== undefined && !Array.isArray(message.reactions)) fail('Slack response shape invalid');
  const thread = optionalString(message.thread_ts, 40);
  if (message.user === self && Array.isArray(message.reactions) && message.reactions.length > 0) return 'reaction';
  if (text.includes(`<@${self}>`)) return 'mention';
  return thread && thread !== ts ? 'thread' : 'dm';
}
function compare(a: Candidate, b: Candidate): number {
  return a.receivedAt - b.receivedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

/** Private factory: no global fetch, implicit mapper, registration or public barrel. */
export function createSlackInboxAdapter(ctx: AdapterContext, ports: SlackInboxPorts): InboundProviderAdapter {
  // Reject omission before any credential/HTTP work, including untyped callers.
  if (typeof ports?.http !== 'function' || typeof ports?.mapItem !== 'function') {
    throw new Error('Slack inbox requires HTTP and an explicit item mapper');
  }
  return {
    id: PROVIDER,
    pollIntervalMs: POLL_CADENCE_MS.realtime,
    async poll(opts: ProviderPollOptions): Promise<ProviderPollResult> {
      let configured: boolean | undefined;
      let stage = 'Slack poll failed';
      try {
        checkActive(opts.signal);
        const cutoff = Math.floor((ports.now ?? Date.now)());
        if (!Number.isSafeInteger(cutoff) || cutoff <= 0 || !Number.isSafeInteger(opts.limit)
          || opts.limit < 1 || opts.limit > MAX_ITEMS || (opts.since !== undefined
            && (!Number.isSafeInteger(opts.since) || opts.since < 0))) fail('Slack poll bounds invalid');
        stage = 'Slack credential lookup failed';
        const token = await ctx.credentials.resolveConfigSecret(CREDENTIAL_KEY);
        checkActive(opts.signal);
        if (!token || !token.trim()) return unavailable('missing surfaces.slack.botToken', false);
        if (!token.startsWith('xoxb-') && !token.startsWith('xoxp-')) {
          return unavailable('surfaces.slack.botToken is not a Slack bot/user token', false);
        }
        configured = true;
        const get = async (method: 'auth.test' | 'conversations.list' | 'conversations.history', params: Record<string, string>) => {
          checkActive(opts.signal);
          stage = `Slack ${method} request failed`;
          const url = new URL(`https://slack.com/api/${method}`);
          for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
          const response = await ports.http(url, {
            method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
            ...(opts.signal === undefined ? {} : { signal: opts.signal }),
          });
          checkActive(opts.signal);
          if (!response.ok) fail(`Slack ${method} HTTP failure`);
          stage = `Slack ${method} response unreadable`;
          const body = record(response.body);
          if (body.ok !== true) fail(`Slack ${method} refused`);
          return body;
        };
        // Unknown self identity would silently turn mentions/reactions into DMs.
        const self = identifier((await get('auth.test', {})).user_id);
        const channels = new Map<string, string | undefined>();
        let cursor: string | undefined;
        const listCursors = new Set<string>();
        for (let page = 0; ; page += 1) {
          if (page >= MAX_LIST_PAGES) fail('Slack conversation page budget exhausted');
          const list = await get('conversations.list', { types: 'im', limit: '100', ...(cursor ? { cursor } : {}) });
          for (const entry of rows(list.channels, 100)) {
            const channel = record(entry);
            channels.set(identifier(channel.id), optionalString(channel.user, 200));
          }
          cursor = nextCursor(list);
          if (!cursor) break;
          if (listCursors.has(cursor)) fail('Slack conversation cursor repeated');
          listCursors.add(cursor);
        }
        // Keep only the oldest limit+1 distinct candidates. A complete scan is
        // mandatory before advancing the poller's single global timestamp.
        const candidates: Candidate[] = [];
        let totalHistoryPages = 0;
        for (const [channelId, channelUser] of channels) {
          let historyCursor: string | undefined;
          const historyCursors = new Set<string>();
          for (let page = 0; ; page += 1) {
            if (page >= MAX_HISTORY_PAGES || totalHistoryPages >= MAX_TOTAL_HISTORY_PAGES) {
              fail('Slack history page budget exhausted');
            }
            totalHistoryPages += 1;
            const history = await get('conversations.history', {
              channel: channelId, limit: '50', latest: (cutoff / 1_000).toFixed(6),
              ...(opts.since === undefined ? {} : { oldest: (opts.since / 1_000).toFixed(6) }),
              ...(historyCursor ? { cursor: historyCursor } : {}),
            });
            if (history.is_limited === true) fail('Slack history is limited');
            if (history.is_limited !== undefined && typeof history.is_limited !== 'boolean') fail('Slack response shape invalid');
            for (const entry of rows(history.messages, 50)) {
              const message = record(entry);
              const subtype = optionalString(message.subtype, 200);
              const bot = optionalString(message.bot_id, 200);
              if (subtype === 'bot_message' || bot) continue;
              const { ts, receivedAt } = timestamp(message.ts);
              // Exclude the cutoff's entire rounded-ms bucket. A later poll
              // will see it whole, including arrivals during this scan.
              if (receivedAt <= (opts.since ?? 0) || receivedAt >= cutoff) continue;
              const text = optionalString(message.text, 40_000) ?? '';
              const senderId = optionalString(message.user, 200) || channelUser || channelId;
              const key = `${channelId}:${ts}`;
              if (candidates.some(candidate => candidate.key === key)) continue;
              candidates.push({ key, channelId, senderId, text, ts, receivedAt, kind: classify(message, self, text, ts) });
              candidates.sort(compare);
              if (candidates.length > opts.limit + 1) candidates.pop();
            }
            historyCursor = nextCursor(history);
            if (history.has_more !== undefined && typeof history.has_more !== 'boolean') fail('Slack response shape invalid');
            if (!historyCursor) {
              if (history.has_more === true) fail('Slack history continuation missing');
              break;
            }
            // A cursor remains authoritative even on an empty or short page.
            if (historyCursors.has(historyCursor)) fail('Slack history cursor repeated');
            historyCursors.add(historyCursor);
          }
        }
        let selected = candidates.slice(0, opts.limit);
        const omitted = candidates[opts.limit];
        if (omitted) selected = selected.filter(candidate => candidate.receivedAt < omitted.receivedAt);
        if (candidates.length > 0 && selected.length === 0) fail('Slack item budget cannot cover timestamp group');
        const items: InboundChannelItem[] = [];
        for (const candidate of selected) {
          checkActive(opts.signal);
          stage = 'Slack item mapping failed';
          const mapped = await ports.mapItem({ senderId: candidate.senderId, channelId: candidate.channelId,
            subject: 'Direct message', text: candidate.text }, opts.signal);
          checkActive(opts.signal);
          if (!mapped) fail('Slack item mapping withheld or invalid');
          // Snapshot host accessors exactly once. Validation and projection
          // must use the same immutable primitive values, never later reads.
          const { fromDigest, subjectPreview, bodyPreview } = mapped;
          if (typeof fromDigest !== 'string' || !/^[a-f0-9]{16}$/.test(fromDigest)
            || typeof subjectPreview !== 'string' || subjectPreview.length > 200
            || typeof bodyPreview !== 'string' || bodyPreview.length > 500) fail('Slack item mapping withheld or invalid');
          // Explicit projection prevents raw/extra mapper fields from escaping.
          const item: InboundChannelItem = {
            id: `slack:${candidate.channelId}:${candidate.ts}`, provider: PROVIDER, kind: candidate.kind,
            fromDigest, subjectPreview, bodyPreview,
            receivedAt: candidate.receivedAt, unread: true,
          };
          if (ctx.resolveRouteId) {
            stage = 'Slack route resolution failed';
            try {
              const route = await ctx.resolveRouteId({ provider: PROVIDER, fromDigest: item.fromDigest, kind: item.kind });
              checkActive(opts.signal);
              if (typeof route === 'string' && route.length > 0) item.routeId = route;
            } catch {
              checkActive(opts.signal);
              // Optional routing cannot poison the item. Never echo exceptions.
              try { await ctx.logger.warn('Slack route resolution failed'); } catch { /* Reporting is optional. */ }
              checkActive(opts.signal);
            }
          }
          items.push(item);
        }
        checkActive(opts.signal);
        return { items, state: items.length ? 'ready' : 'empty', configured: true };
      } catch (error) {
        // No external exception, Slack error field, raw response, identifier,
        // credential, or message content is rendered in a result or log.
        return unavailable(opts.signal?.aborted ? 'Slack poll cancelled' : diagnostic(error) ?? stage, configured);
      }
    },
  };
}

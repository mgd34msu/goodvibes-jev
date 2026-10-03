/**
 * unified-inbox-daemon-feed.test.ts, the inbound feed is fetched from the
 * daemon, and what the inbox says when it is not there is what was observed.
 *
 * The defect this replaces was not a missing feature; it was a false sentence.
 * The inbox reported `contract_not_published` for `channels.inbox.list`, a
 * machine-readable claim that the contract did not carry the method. The
 * contract carries it. Anyone acting on that reason would have gone to publish
 * something already published, while the real cause sat somewhere else.
 *
 * So the reasons here are the observed ones, and each test drives the transport
 * to produce exactly one of them. `method_unavailable` is the one the live
 * platform produces today, and it is a different instruction to its reader than
 * `daemon_unreachable`: one says the daemon does not serve this, the other says
 * the daemon was not there to ask.
 */

import { describe, expect, test } from 'bun:test';
import {
  aggregateUnifiedInbox,
  fetchInboundChannelFeed,
  formatUnifiedInbox,
  CHANNEL_INBOX_LIST_METHOD,
} from '../../agent/unified-inbox.ts';
import type { AgentWorkspaceChannelTriage } from '../../input/agent-workspace-channel-triage.ts';
import type { DaemonOperatorInvoke } from '../../agent/daemon-operator-client.ts';

function emptyTriage(): AgentWorkspaceChannelTriage {
  return {
    mode: 'channel_triage',
    status: 'ready',
    summary: '',
    readiness: {},
    deliveries: { route: '/api/deliveries', state: 'empty', attempts: [] },
    surfaceMessages: { route: '/api/control-plane/messages', state: 'empty', messages: [] },
    routeBindings: { route: '/api/routes/bindings', state: 'empty', bindings: [] },
    receipts: {},
    inboundFeed: {},
    connectedHost: {},
    routes: {},
    policy: '',
  };
}

const INBOX_ITEM = {
  id: 'msg-1',
  provider: 'slack',
  kind: 'dm',
  from: 'Dana Reed',
  fromAddress: 'dana@example.com',
  subject: 'lunch?',
  bodyPreview: 'are you free at noon',
  receivedAt: 1_770_000_000_000,
  unread: true,
  routeId: 'C1',
  threadId: 'T1',
  attachmentCount: 2,
};

function servingDaemon(items: unknown[] = [INBOX_ITEM], extra: Record<string, unknown> = {}): DaemonOperatorInvoke {
  return async (methodId) => ({
    ok: true,
    methodId,
    route: `GET /api/channels/inbox`,
    body: { items, total: items.length, truncated: false, ...extra },
  });
}

function refusingDaemon(kind: 'auth_required' | 'connected_host_unavailable' | 'connected_host_route_unavailable' | 'connected_host_error', error: string): DaemonOperatorInvoke {
  return async (methodId) => ({
    ok: false, methodId, route: 'GET /api/channels/inbox', kind, error,
  });
}

describe('fetching the inbound feed', () => {
  test('the daemon is asked for channels.inbox.list', async () => {
    const seen: string[] = [];
    const invoke: DaemonOperatorInvoke = async (methodId) => {
      seen.push(methodId);
      return { ok: true, methodId, route: '', body: { items: [], total: 0, truncated: false } };
    };

    await fetchInboundChannelFeed(invoke);

    expect(seen).toEqual([CHANNEL_INBOX_LIST_METHOD]);
  });

  test('the query the caller asked for is passed through', async () => {
    let received: Record<string, unknown> = {};
    const invoke: DaemonOperatorInvoke = async (methodId, input = {}) => {
      received = input;
      return { ok: true, methodId, route: '', body: { items: [], total: 0, truncated: false } };
    };

    await fetchInboundChannelFeed(invoke, { provider: 'slack', limit: 25, since: 42 });

    expect(received).toEqual({ provider: 'slack', limit: 25, since: 42 });
  });

  test('a served feed carries every field the item schema promises', async () => {
    const feed = await fetchInboundChannelFeed(servingDaemon());

    expect(feed.available).toBe(true);
    if (!feed.available) return;
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]).toEqual({
      kind: 'inbound_message',
      id: 'msg-1',
      provider: 'slack',
      messageKind: 'dm',
      from: 'Dana Reed',
      fromAddress: 'dana@example.com',
      subject: 'lunch?',
      bodyPreview: 'are you free at noon',
      receivedAt: 1_770_000_000_000,
      unread: true,
      routeId: 'C1',
      threadId: 'T1',
      attachmentCount: 2,
    });
  });

  test('truncation the daemon reports is carried, not re-derived', async () => {
    const feed = await fetchInboundChannelFeed(servingDaemon([INBOX_ITEM], { total: 900, truncated: true }));

    expect(feed.available).toBe(true);
    if (!feed.available) return;
    expect(feed.total).toBe(900);
    expect(feed.truncated).toBe(true);
  });

  test('an answer with no items array is an error, not an empty inbox', async () => {
    // Reporting "no messages" for a malformed answer is how an operator
    // concludes nobody wrote to them.
    const invoke: DaemonOperatorInvoke = async (methodId) => ({
      ok: true, methodId, route: '', body: { ok: true },
    });

    const feed = await fetchInboundChannelFeed(invoke);

    expect(feed.available).toBe(false);
    if (feed.available) return;
    expect(feed.reason).toBe('daemon_error');
  });
});

describe('what the inbox reports when the feed is absent', () => {
  test('a daemon that does not serve the method says so', async () => {
    // What the live platform answers today: the method is cataloged with
    // invokable:false and its advertised path is served by no route.
    const feed = await fetchInboundChannelFeed(refusingDaemon(
      'connected_host_route_unavailable',
      'HTTP 400: Gateway method is cataloged but not invokable through method dispatch: channels.inbox.list',
    ));

    expect(feed.available).toBe(false);
    if (feed.available) return;
    expect(feed.reason).toBe('method_unavailable');
    expect(feed.detail).toContain('not invokable');
  });

  test('a daemon that is not there is reported as unreachable, not as unpublished', async () => {
    const feed = await fetchInboundChannelFeed(refusingDaemon(
      'connected_host_unavailable',
      'connect ECONNREFUSED 127.0.0.1:3421',
    ));

    expect(feed.available).toBe(false);
    if (feed.available) return;
    expect(feed.reason).toBe('daemon_unreachable');
  });

  test('a missing token is reported as an auth problem', async () => {
    const feed = await fetchInboundChannelFeed(refusingDaemon(
      'auth_required',
      'no connected-host operator token found at /home/x/.goodvibes/daemon/operator-tokens.json',
    ));

    expect(feed.available).toBe(false);
    if (feed.available) return;
    expect(feed.reason).toBe('auth_required');
  });

  test('no reason ever claims the contract is unpublished', async () => {
    // The claim this whole shape exists to stop repeating.
    for (const kind of ['auth_required', 'connected_host_unavailable', 'connected_host_route_unavailable', 'connected_host_error'] as const) {
      const feed = await fetchInboundChannelFeed(refusingDaemon(kind, 'whatever'));
      expect(feed.available).toBe(false);
      if (feed.available) continue;
      expect(feed.reason).not.toBe('contract_not_published');
    }
  });
});

describe('the aggregate with a feed', () => {
  test('inbound messages join the flat item list and the summary', async () => {
    const feed = await fetchInboundChannelFeed(servingDaemon());

    const inbox = aggregateUnifiedInbox(emptyTriage(), { inboundChannelFeed: feed });

    expect(inbox.inboundMessageItems).toHaveLength(1);
    expect(inbox.summary.inboundMessageItems).toBe(1);
    expect(inbox.items.filter((item) => item.kind === 'inbound_message')).toHaveLength(1);
  });

  test('the feed is listed as a source, by the method that serves it', async () => {
    const feed = await fetchInboundChannelFeed(servingDaemon());

    const inbox = aggregateUnifiedInbox(emptyTriage(), { inboundChannelFeed: feed });

    const source = inbox.sources.find((entry) => entry.name === 'inbound_messages');
    expect(source).toBeDefined();
    expect(source!.route).toBe(CHANNEL_INBOX_LIST_METHOD);
    expect(source!.state).toBe('ready');
  });

  test('an unavailable feed becomes an unavailable source carrying the daemon\'s words', async () => {
    const feed = await fetchInboundChannelFeed(refusingDaemon('connected_host_unavailable', 'ECONNREFUSED'));

    const inbox = aggregateUnifiedInbox(emptyTriage(), { inboundChannelFeed: feed });

    const source = inbox.sources.find((entry) => entry.name === 'inbound_messages');
    expect(source!.state).toBe('unavailable');
    expect(source!.error).toBe('ECONNREFUSED');
  });

  test('the limit applies to inbound messages too', async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ ...INBOX_ITEM, id: `msg-${i}` }));
    const feed = await fetchInboundChannelFeed(servingDaemon(many));

    const inbox = aggregateUnifiedInbox(emptyTriage(), { inboundChannelFeed: feed, limit: 4 });

    expect(inbox.inboundMessageItems).toHaveLength(4);
  });

  test('the rendered inbox names the real reason rather than a missing contract', async () => {
    const feed = await fetchInboundChannelFeed(refusingDaemon(
      'connected_host_route_unavailable',
      'HTTP 400: not invokable',
    ));

    const rendered = formatUnifiedInbox(aggregateUnifiedInbox(emptyTriage(), { inboundChannelFeed: feed }));

    expect(rendered).toContain('method_unavailable');
    expect(rendered).not.toContain('contract_not_published');
    expect(rendered).not.toContain('not yet published');
  });

  test('the policy stops apologising once the feed is actually served', async () => {
    const feed = await fetchInboundChannelFeed(servingDaemon());

    const inbox = aggregateUnifiedInbox(emptyTriage(), { inboundChannelFeed: feed });

    expect(inbox.policy).toContain('provider inbound messages');
    expect(inbox.policy).not.toContain('not yet published');
  });
});

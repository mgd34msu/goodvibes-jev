/** Exact missing pinned-daemon assertions through the real product graph/registrar. */
import { expect, spyOn, test } from 'bun:test';
import { GatewayMethodCatalog } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { BenchmarkStore, ProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import { registerInboxSurface, type InboxListOutput, type InboundProviderAdapter } from '@goodvibes-jev/engine/sdk/platform/intake';
import { startDaemonFixture, type DaemonFixture } from '../../testing/daemon-fixture.js';

const method = 'channels.inbox.list';
const row = (provider: string, id: string, receivedAt: number) => ({ id, provider, receivedAt,
  kind: 'dm' as const, fromDigest: '0123456789abcdef', subjectPreview: 'Synthetic subject', bodyPreview: 'Synthetic body', unread: true });
const adapter = (id: string, poll: InboundProviderAdapter['poll']): InboundProviderAdapter => ({ id, pollIntervalMs: 3_600_000, poll });

async function withInbox(adapters: InboundProviderAdapter[], run: (fixture: DaemonFixture) => Promise<void>) {
  const discovery = spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]);
  const benchmarks = spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue();
  let fixture: DaemonFixture | undefined;
  const canonical = new GatewayMethodCatalog().get(method);
  try {
    fixture = await startDaemonFixture({ inboxFactory(context, _routing, options) {
      expect(context.catalog.get(method)).toEqual(canonical);
      expect(context.catalog.hasHandler(method)).toBe(false);
      const surface = registerInboxSurface(context, { ...options, adapters: new Map(adapters.map(value => [value.id, value])) });
      expect(context.catalog.get(method)).toEqual(canonical);
      expect(context.catalog.hasHandler(method)).toBe(true);
      return surface;
    } });
    await run(fixture);
    await fixture.stop();
    expect(fixture.services.gatewayMethods.hasHandler(method)).toBe(false);
  } finally {
    try { await fixture?.stop(); } finally { benchmarks.mockRestore(); discovery.mockRestore(); }
  }
}

test('canonical handler preserves query-string paging and refuses malformed cursor on both invoke and REST', async () => {
  const now = Date.now();
  await withInbox([
    adapter('slack', async () => ({ state: 'ready', configured: true, items: [1, 2, 3].map(n => row('slack', `slack:${n}`, now + n)) })),
    adapter('email', async () => ({ state: 'ready', configured: true, items: [row('email', 'email:1', now + 4)] })),
  ], async fixture => {
    const invoke = (query: Record<string, string>) => fixture.services.gatewayMethods.invoke(method, {
      body: undefined, query, context: { authToken: fixture.token, scopes: ['read:channels'] },
    }) as Promise<InboxListOutput>;
    const query = { provider: 'slack', limit: '2' };
    const first = await invoke(query);
    expect(first.items.map(item => item.id)).toEqual(['slack:3', 'slack:2']);
    expect(first.total).toBe(3); expect(first.hasMore).toBe(true);
    expect(first.truncated).toBe(first.hasMore);
    expect(first.nextCursor).toBeDefined();
    const secondQuery = { ...query, cursor: first.nextCursor! };
    const second = await invoke(secondQuery);
    expect(second.items.map(item => item.id)).toEqual(['slack:1']);
    expect(second.hasMore).toBe(false); expect(second.total).toBe(3);
    const rest = await fixture.fetch(`/api/channels/inbox?${new URLSearchParams(secondQuery)}`);
    expect(rest.status).toBe(200); expect(await rest.json()).toEqual(second);
    await expect(invoke({ cursor: 'not-a-cursor-this-issued' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', status: 400, message: expect.stringContaining('cursor') });
    const invalid = await fixture.fetch('/api/channels/inbox?cursor=not-a-cursor-this-issued');
    expect(invalid.status).toBe(400); expect(await invalid.json()).toMatchObject({ code: 'INVALID_ARGUMENT', error: expect.stringContaining('cursor') });
    expect((await fixture.fetchAnonymous('/api/channels/inbox')).status).toBe(401);
  });
}, 30_000);

test('registered aggregate preserves provider failure messages and numeric lastSyncAt', async () => {
  await withInbox([
    adapter('slack', async () => ({ state: 'ready', configured: true, items: [row('slack', 'slack:1', Date.now())] })),
    adapter('email', async () => ({ state: 'unavailable', configured: true, items: [], error: 'IMAP LOGIN refused: AUTHENTICATIONFAILED' })),
    adapter('discord', async () => { throw new Error('socket hang up'); }),
  ], async fixture => {
    const out = await fixture.invoke<InboxListOutput>(method);
    expect(out.items.map(item => item.id)).toEqual(['slack:1']);
    expect(out.partial).toBe(true);
    const email = out.providers.find(value => value.provider === 'email')!;
    expect(email).toMatchObject({ state: 'error', error: 'IMAP LOGIN refused: AUTHENTICATIONFAILED', configured: true, itemCount: 0 });
    expect(typeof email.lastSyncAt).toBe('number');
    const discord = out.providers.find(value => value.provider === 'discord')!;
    expect(discord.state).toBe('error'); expect(discord.error).toContain('socket hang up');
    expect(out.providers.find(value => value.provider === 'slack')?.state).toBe('ready');
  });
}, 30_000);

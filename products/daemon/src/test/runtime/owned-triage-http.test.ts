import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import { registerTriagedInbox, type OwnedTriagedInboxSource } from '@goodvibes-jev/engine/sdk/platform/intake';
import { createSystemOnePort } from '@goodvibes-jev/judgment';
import { startDaemonFixture, type DaemonFixture } from '../../testing/daemon-fixture.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../../config/surface.js';

test('explicit owned Jev API scoring reaches authenticated daemon inbox HTTP through real receipt SQLite', async () => {
  const root = makeOwnedTempDir('owned-triage-http');
  const directory = join(root, 'home', '.goodvibes', GOODVIBES_DAEMON_SURFACE_ROOT);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'benchmarks.json'), JSON.stringify({ version: 1, fetchedAt: Date.now(), ttlMs: 86_400_000,
    entries: [{ modelId: 'fixture-model', name: 'Fixture model', organization: 'Fixture', benchmarks: { gpqa: .7 } }] }));
  const discovery = spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]);
  const requests: Array<{ state: unknown; questions: Record<string, unknown> }> = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    expect(new URL(request.url).pathname).toBe('/v1/systemone');
    const body = await request.json() as { state: unknown; questions: Record<string, unknown> };
    requests.push(body);
    return Response.json({ model: 'jev-1.13.0', answers: Object.fromEntries(Object.keys(body.questions).map(name =>
      [name, { type: 'noul', noul: name.endsWith('urgency') ? .99 : .01 }])), usage: { input_tokens: 12, output_tokens: 4 } });
  } });
  const authority = new AbortController();
  let owned!: OwnedTriagedInboxSource, fixture: DaemonFixture | undefined, polls = 0;
  try {
    const port = createSystemOnePort({ endpoint: { kind: 'local', baseURL: `http://127.0.0.1:${server.port}`, apiKey: 'synthetic-triage-only' },
      model: 'jev-1.13.0', timeoutMs: 5_000, retry: {} });
    fixture = await startDaemonFixture({ root, async inboxFactory(context, _routing, controls) {
      owned = await registerTriagedInbox(context, { ...controls, providerId: 'fixture', accountScopeId: 'synthetic-http-account',
        acquireReadLease: async () => Object.assign(async () => {}, { assertCurrent() {} }),
        authority: { accountScopeId: 'synthetic-http-account', providerId: 'fixture', destinationId: `loopback:${server.port}`,
          retention: 'ephemeral-no-log', port, signal: authority.signal, assertCurrent() {} },
        adapters: new Map([['fixture', { id: 'fixture', pollIntervalMs: 3_600_000, async poll() { polls++; return {
          state: 'ready' as const, configured: true, items: [{ id: 'fixture:one', provider: 'fixture', kind: 'dm' as const,
            subjectPreview: 'Protected synthetic subject', bodyPreview: 'Protected synthetic body', fromDigest: '0123456789abcdef',
            unread: true, receivedAt: Date.now() }],
        }; } }]]),
      }); return owned;
    } });
    expect((await fixture.fetchAnonymous('/api/channels/inbox')).status).toBe(401);
    expect(requests).toHaveLength(0);
    expect(await (await fixture.fetch('/api/channels/inbox')).json()).toMatchObject({ total: 1, items: [{ id: 'fixture:one' }] });
    expect(requests).toHaveLength(0);
    expect(await owned.runInboxTriage()).toMatchObject({ receipts: [{ status: 'settled', label: 'priority' }], total: 1, hasMore: false });
    const response = await fixture.fetch('/api/channels/inbox'); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ total: 1, items: [{ id: 'fixture:one', triageLabel: 'priority', triageScore: .99,
      triageTags: ['GoodVibes/Priority'] }] });
    expect(requests).toHaveLength(1); expect(polls).toBe(1);
    expect(JSON.stringify(requests)).not.toContain('0123456789abcdef');
    expect(fixture.services.gatewayMethods.hasHandler('inbox.triage.run')).toBe(false);
    authority.abort(); expect((await fixture.fetch('/api/channels/inbox')).status).toBe(503);
  } finally { await fixture?.stop(); server.stop(true); discovery.mockRestore(); }
}, 30_000);

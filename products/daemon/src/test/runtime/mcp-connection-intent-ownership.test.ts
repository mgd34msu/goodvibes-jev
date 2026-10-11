/** Real daemon graph plus loopback peers: connection intent and cleanup ownership. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { McpClient } from '@goodvibes-jev/engine/sdk/platform/mcp';
import { externalProtocolFixture, deferred, until } from '../helpers/external-protocol-fixture.js';

const fixtures: Array<Awaited<ReturnType<typeof externalProtocolFixture>>> = [];
afterEach(async () => { for (const fixture of fixtures.splice(0).reverse()) await fixture.close(); });

function peer(hold = false) {
  const entered = deferred(); const release = deferred();
  let requests = 0;
  if (!hold) release.resolve();
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as { id: unknown; method: string };
    requests++; entered.resolve(); await release.promise;
    return Response.json({ jsonrpc: '2.0', id: body.id, result: { resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, serverInfo: { name: 'review-peer', version: '1' } } });
  } });
  return { entered, release, server, get requests() { return requests; }, url: `http://127.0.0.1:${server.port}/mcp` };
}

test('removing a server during MCP negotiation fences its late publication', async () => {
  const f = await externalProtocolFixture(); fixtures.push(f);
  const p = peer(true);
  const pending = f.registry.connectServer({ name: 'pending-review', url: p.url }).then(() => 'registered', () => 'cancelled');
  try {
    await p.entered.promise;
    await f.registry.applyConfig([]);
    expect(f.registry.serverNames).not.toContain('pending-review');
    p.release.resolve(); await pending;
    expect(f.registry.getClient('pending-review')).toBeUndefined();
    expect(f.registry.serverNames).not.toContain('pending-review');
  } finally { p.release.resolve(); await pending; p.server.stop(true); }
});

test('replacing MCP config during negotiation cannot restore old destination or policy', async () => {
  const f = await externalProtocolFixture(); fixtures.push(f);
  const old = peer(true); const replacement = peer();
  const pending = f.registry.connectServer({ name: 'pending-review', url: old.url, trustMode: 'ask-on-risk' }).then(() => 'registered', () => 'cancelled');
  try {
    await old.entered.promise;
    await f.registry.applyConfig([{ name: 'pending-review', url: replacement.url, trustMode: 'blocked' }]);
    expect(f.registry.listServerSecurity().find(row => row.name === 'pending-review')?.trustMode).toBe('blocked');
    old.release.resolve(); await pending;
    expect(f.registry.getClient('pending-review')?.captureToolScope().destination).toBe(replacement.url);
    expect(f.registry.listServerSecurity().find(row => row.name === 'pending-review')?.trustMode).toBe('blocked');
  } finally { old.release.resolve(); await pending; old.server.stop(true); replacement.server.stop(true); }
});

test('daemon close drains a cancelled pending MCP transport before resolving', async () => {
  const f = await externalProtocolFixture(); fixtures.push(f);
  const p = peer(true); const cleanupEntered = deferred(); const cleanupRelease = deferred();
  const disconnect = McpClient.prototype.disconnect;
  const held = spyOn(McpClient.prototype, 'disconnect').mockImplementation(async function (this: McpClient) {
    if (this.name === 'pending-review') { cleanupEntered.resolve(); await cleanupRelease.promise; }
    await disconnect.call(this);
  });
  const pending = f.registry.connectServer({ name: 'pending-review', url: p.url }).then(() => 'registered', () => 'cancelled');
  let closing: Promise<void> | undefined;
  try {
    await p.entered.promise;
    closing = f.daemon.services.close();
    await cleanupEntered.promise;
    const settled = await Promise.race([closing.then(() => 'closed'), new Promise<string>(resolve => setTimeout(() => resolve('waiting'), 200))]);
    expect(settled).toBe('waiting');
  } finally { cleanupRelease.resolve(); p.release.resolve(); await pending; await closing; held.mockRestore(); p.server.stop(true); }
});

test('explicit disconnect cancels negotiation before a peer answers', async () => {
  const f = await externalProtocolFixture(); fixtures.push(f);
  const p = peer(true);
  const pending = f.registry.connectServer({ name: 'pending-review', url: p.url }).then(() => 'registered', () => 'cancelled');
  try {
    await p.entered.promise;
    expect(await f.registry.disconnectServer('pending-review')).toBe(true);
    expect(await pending).toBe('cancelled');
    expect(f.registry.getClient('pending-review')).toBeUndefined();
    p.release.resolve(); await new Promise(resolve => setImmediate(resolve));
    expect(f.registry.getClient('pending-review')).toBeUndefined();
  } finally { p.release.resolve(); await pending; p.server.stop(true); }
});

for (const mode of ['direct', 'reload']) test(`overlapping ${mode} replacements only install the latest MCP configuration intent`, async () => {
  const f = await externalProtocolFixture(); fixtures.push(f);
  const old = peer(true); const middle = peer(); const latest = peer();
  const entered = deferred(); const release = deferred();
  const disconnect = McpClient.prototype.disconnect;
  const held = spyOn(McpClient.prototype, 'disconnect').mockImplementation(async function (this: McpClient) {
    if (this.name === 'pending-review') { entered.resolve(); await release.promise; }
    await disconnect.call(this);
  });
  const first = f.registry.connectServer({ name: 'pending-review', url: old.url }).then(() => 'registered', () => 'cancelled');
  let second: Promise<string> | undefined; let third: Promise<string> | undefined;
  const replace = (url: string, blocked = false) => {
    const config = { name: 'pending-review', url, ...(blocked ? { trustMode: 'blocked' as const } : {}) };
    return (mode === 'direct' ? f.registry.connectServer(config) : f.registry.applyConfig([config])).then(() => 'registered', () => 'cancelled');
  };
  try {
    await old.entered.promise;
    second = replace(middle.url);
    await entered.promise;
    third = replace(latest.url, true);
    release.resolve();
    expect(await first).toBe('cancelled'); expect(await second).toBe('cancelled'); expect(await third).toBe('registered');
    expect(f.registry.getClient('pending-review')?.captureToolScope().destination).toBe(latest.url);
    expect(f.registry.listServerSecurity().find(row => row.name === 'pending-review')?.trustMode).toBe('blocked');
  } finally { release.resolve(); old.release.resolve(); await Promise.all([first, second, third]); held.mockRestore(); old.server.stop(true); middle.server.stop(true); latest.server.stop(true); }
});

test('detached MCP config cannot be mutated across negotiation', async () => {
  const f = await externalProtocolFixture(); fixtures.push(f);
  const p = peer(true); const substituted = peer();
  const config = { name: 'pending-review', url: p.url, trustMode: 'blocked' as const, allowedHosts: ['original.invalid'] };
  const pending = f.registry.connectServer(config);
  try {
    await p.entered.promise;
    config.url = substituted.url; config.allowedHosts.push('substituted.invalid');
    p.release.resolve(); await pending;
    expect(f.registry.getClient('pending-review')?.captureToolScope().destination).toBe(p.url);
    expect(f.registry.listServerSecurity().find(row => row.name === 'pending-review')?.allowedHosts).toEqual(['original.invalid']);
  } finally { p.release.resolve(); await pending; p.server.stop(true); substituted.server.stop(true); }
});

test('unchanged reload drains the old negotiation and awaits a ready replacement', async () => {
  const f = await externalProtocolFixture(); fixtures.push(f);
  const p = peer(true); const config = { name: 'pending-review', url: p.url };
  const first = f.registry.connectServer(config).then(() => 'registered', () => 'cancelled');
  let reload: ReturnType<typeof f.registry.applyConfig> | undefined;
  try {
    await p.entered.promise;
    reload = f.registry.applyConfig([config]);
    await until(() => p.requests === 2, 'unchanged reload reconnects after the old negotiation is cancelled');
    expect(await first).toBe('cancelled');
    expect(f.registry.getClient('pending-review')).toBeUndefined();
    p.release.resolve();
    expect((await reload).servers.find(row => row.name === 'pending-review')).toMatchObject({ action: 'unchanged', connected: true });
    expect(f.registry.getClient('pending-review')?.isConnected).toBe(true);
  } finally { p.release.resolve(); await first; await reload; p.server.stop(true); }
});

test('failed pending cleanup remains owned after its caller settles and blocks replacement', async () => {
  const f = await externalProtocolFixture(); const p = peer(true); const next = peer();
  const disconnect = McpClient.prototype.disconnect;
  const failed = spyOn(McpClient.prototype, 'disconnect').mockImplementation(async function (this: McpClient) {
    await disconnect.call(this);
    if (this.name === 'pending-review') throw new Error('Synthetic disconnect cleanup failure');
  });
  const pending = f.registry.connectServer({ name: 'pending-review', url: p.url }).then(() => 'registered', () => 'cancelled');
  try {
    await p.entered.promise;
    await expect(f.registry.disconnectServer('pending-review')).rejects.toThrow('MCP server cleanup failed');
    expect(await pending).toBe('cancelled');
    failed.mockRestore();
    await expect(f.registry.connectServer({ name: 'pending-review', url: next.url })).rejects.toThrow('MCP server cleanup failed');
    expect(next.requests).toBe(0);
    await expect(f.daemon.services.close()).rejects.toThrow();
  } finally { failed.mockRestore(); p.release.resolve(); await pending; await f.close().catch(() => {}); p.server.stop(true); next.server.stop(true); }
});

/** Real daemon root, source constructor, local privacy judgment, SQLite and authenticated HTTP. */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'undici/index.js';
import { createDiscordInboxOwner, type InboxListOutput } from '@goodvibes-jev/engine/sdk/platform/intake';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { SecretsManager } from '../../config/secrets.js';
import { createProductionDaemonInboxFactory } from '../../runtime/production-inbox-composition.js';
import { startGatewayFixture } from '../helpers/gateway-route-fixture.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const account = { userId: '100000000000000001' }, channel = '100000000000000002';
async function fixture(fixtureOptions: { startupMutation?: boolean } = {}) {
  const root = makeOwnedTempDir('discord-production'), home = join(root, 'home'), workspace = join(root, 'workspace');
  mkdirSync(home, { recursive: true }); mkdirSync(workspace, { recursive: true });
  const stored = new SecretsManager({ projectRoot: workspace, globalHome: home });
  await stored.set('GOODVIBES_SURFACES_DISCORD_BOT_TOKEN', 'synthetic-discord-token');
  let actualId = account.userId, allowed = true;
  const id = (BigInt(Date.now() - 2_000 - 1_420_070_400_000) << 22n).toString();
  const providerCalls: string[] = [], screeningCalls: string[] = [];
  const remote = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = new URL(request.url).pathname; providerCalls.push(path);
    if (path === '/api/v10/users/@me') return Response.json({ id: actualId, bot: true });
    if (path === `/api/v10/channels/${channel}`) return allowed ? Response.json({ id: channel, type: 1 }) : new Response(null, { status: 403 });
    if (path === `/api/v10/channels/${channel}/messages`) return Response.json([{ id, channel_id: channel,
      author: { id: '100000000000000003' }, content: 'Contact person@example.test, keep the build notes.' }]);
    return new Response(null, { status: 404 });
  } });
  const local = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname; screeningCalls.push(path);
    if (path === '/v1/chat/completions') {
      const body = await request.json() as { messages: { content: string }[] };
      const source = JSON.parse(body.messages[1]!.content) as { revision: string };
      return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ revision: source.revision,
        spans: [{ part: 1, start: 8, end: 27 }, { part: 3, start: 8, end: 27 }] }) } }] });
    }
    return Response.json({ model: 'jev-1.13.0', answers: { complete: { type: 'noul', noul: 1 }, precise: { type: 'noul', noul: 1 } }, usage: { input_tokens: 10, output_tokens: 2 } });
  } });
  cleanups.push(() => local.stop(true), () => remote.stop(true));
  const scope = new AbortController(), privacy = new AbortController(); let configuration!: ConfigManager;
  const production = createProductionDaemonInboxFactory({ discord: { account,
    channels: { channelIds: [channel], revision: 'explicit-dm-v1', signal: scope.signal, assertCurrent() {} },
    screening: { authority: { ownerId: 'synthetic-local-screening', revision: 'v1', retention: 'ephemeral-no-log', signal: privacy.signal, assertCurrent() {} },
      proposal: { endpoint: `http://127.0.0.1:${local.port}`, model: 'synthetic-proposer' },
      judgment: { endpoint: `http://127.0.0.1:${local.port}`, model: 'jev-1.13.0' } },
  } }, { discord: { async createOwner(context, options) { const owner = await createDiscordInboxOwner(context, options, { createHttpClient(origin, settings) {
    expect(origin).toBe('https://discord.com'); return new Client(`http://127.0.0.1:${remote.port}`, settings);
  } });
    if (fixtureOptions.startupMutation) {
      configuration.set('surfaces.discord.defaultChannelId', '100000000000000099');
      configuration.set('surfaces.discord.defaultChannelId', '');
      expect(providerCalls).toEqual([]);
    }
    return owner;
  } } });
  const daemon = await startGatewayFixture({ root, hostSessions: false, inboxFactory: production,
    configure(config) { configuration = config; config.set('surfaces.discord.enabled', true); config.set('judgment.keySource', 'secret'); },
  });
  cleanups.push(() => daemon.stop());
  return { daemon, workspace, providerCalls, screeningCalls, scope, privacy,
    reassign() { actualId = '100000000000000099'; }, deny() { allowed = false; },
    async inbox() { const response = await daemon.fetch('/api/channels/inbox'); expect(response.status).toBe(200); return await response.json() as InboxListOutput; },
  };
}
test('configured Discord production source is real authenticated, protected, persisted and reachable through both transports', async () => {
  const f = await fixture(), answer = await f.inbox();
  expect(answer.providers.map(row => row.provider).sort()).toEqual(['discord', 'email', 'slack']);
  expect(answer.items).toHaveLength(1); expect(answer.items[0]).toMatchObject({ provider: 'discord', bodyPreview: 'Contact [redacted], keep the build notes.' });
  expect((await f.daemon.invoke<InboxListOutput>('channels.inbox.list')).items).toEqual(answer.items);
  expect((await f.daemon.fetchAnonymous('/api/channels/inbox')).status).toBe(401);
  expect(f.providerCalls).toContain(`/api/v10/channels/${channel}/messages`); expect(f.screeningCalls).toContain('/v1/systemone');
  const directory = join(f.workspace, '.goodvibes', 'tui', 'operator');
  const names = readdirSync(directory).filter(name => name.startsWith('inbox-discord-') && name.endsWith('.sqlite'));
  expect(names).toHaveLength(1); expect(readFileSync(join(directory, names[0]!)).toString()).not.toContain('person@example.test');
});
test('real root secret reassignment cannot return the previous account mirror', async () => {
  const f = await fixture(); await f.inbox(); f.reassign();
  await f.daemon.services.secretsManager.set('GOODVIBES_SURFACES_DISCORD_BOT_TOKEN', 'synthetic-discord-other');
  const response = await f.daemon.fetch('/api/channels/inbox'); expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('keep the build notes');
});
test('remote channel permission denial is observed before stored rows are returned', async () => {
  const f = await fixture(); await f.inbox(); f.deny();
  expect((await f.daemon.fetch('/api/channels/inbox')).status).toBe(503);
});
test('trusted source scope revocation fences reads and prevents all later network work', async () => {
  const f = await fixture(); await f.inbox(); f.scope.abort(); const calls = f.providerCalls.length;
  expect((await f.daemon.fetch('/api/channels/inbox')).status).toBe(503); expect(f.providerCalls).toHaveLength(calls);
});
test('a pending managed-alias replacement cannot release old Discord rows before successful-write notification', async () => {
  const f = await fixture(), key = 'GOODVIBES_SURFACES_DISCORD_BOT_TOKEN', alias = 'SYNTHETIC_DISCORD_ALIAS';
  await f.daemon.services.secretsManager.set(alias, 'synthetic-discord-token');
  await f.daemon.services.secretsManager.set(key, `goodvibes://secrets/goodvibes/${alias}`);
  await f.inbox();
  const record = (await f.daemon.services.secretsManager.listDetailed()).find(row => row.key === alias)!;
  const { acquireCrossProcessLock } = await import('@goodvibes-jev/engine/sdk/platform/state/durable-file-io');
  const release = await acquireCrossProcessLock(`${record.path!}.mutation.lock`, { strictOwnership: true });
  const pending = f.daemon.services.secretsManager.set(alias, 'synthetic-discord-replacement');
  try { expect((await f.daemon.fetch('/api/channels/inbox')).status).toBe(503); }
  finally { release(); await pending; }
});

test('configuration ABA during asynchronous source construction is refused before polling or registration', async () => {
  await expect(fixture({ startupMutation: true })).rejects.toThrow('could not acquire its owned source');
});

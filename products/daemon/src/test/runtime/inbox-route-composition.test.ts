import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Socket } from 'node:net';
import { Client } from 'undici/index.js';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { GatewayMethodCatalog } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { registerRoutingMethods } from '@goodvibes-jev/engine/sdk/platform/channels';
import { EmailService } from '@goodvibes-jev/engine/sdk/platform/email';
import { createSlackInboxOwner, createEmailInboxOwner, type RouteResolver, type InboxPollingControl, type InboxListOutput } from '@goodvibes-jev/engine/sdk/platform/intake';
import type { ProtectedSourceOwnerOptions } from '@goodvibes-jev/engine/sdk/platform/security';
import type { HandlerContext } from '../../daemon/handlers/context.js';
import { createSlackDaemonInboxFactory } from '../../runtime/slack-inbox-composition.js';
import { createEmailDaemonInboxFactory } from '../../runtime/email-inbox-composition.js';
import { composeMailDeps } from '../../runtime/mail-composition.js';
import { SnapshotSocket } from '../helpers/email-snapshot-socket.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

const cleanups: Array<() => void | Promise<void>> = [];
const releases: Array<() => void> = [];
afterEach(async () => { for (const release of releases.splice(0)) release(); for (const close of cleanups.splice(0).reverse()) await close(); });

async function fixture(provider: 'slack' | 'email', held = false) {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  releases.push(release.resolve);
  const invalidations = new Set<() => void>();
  const credentialChanges = new Set<(key: string) => void>();
  const routeInputs: Array<Parameters<RouteResolver>[0]> = [];
  const wrap = (resolve: RouteResolver | undefined): RouteResolver => async input => {
    routeInputs.push(input); entered.resolve();
    if (held) await release.promise;
    return resolve?.(input);
  };
  const root = makeOwnedTempDir('inbox-route-composition');
  const workingDirectory = join(root, 'workspace'), homeDirectory = join(root, 'home');
  mkdirSync(workingDirectory, { recursive: true });
  const configManager = new ConfigManager({ workingDir: workingDirectory, homeDir: homeDirectory,
    configDir: join(homeDirectory, '.goodvibes', 'daemon'), surfaceRoot: 'tui' });
  configManager.set('cluster.enabled', false);
  configManager.set('surfaces.slack.enabled', true); configManager.set('surfaces.slack.workspaceId', 'T-SYNTHETIC');
  configManager.set('surfaces.email.host', 'mail.synthetic.invalid'); configManager.set('surfaces.email.user', 'owner@synthetic.invalid');
  const context: HandlerContext = { configManager, workingDirectory, homeDirectory, catalog: new GatewayMethodCatalog(),
    credentials: { resolveRef: async () => null, resolveConfigSecret: async () => 'xoxb-synthetic', put: async () => {}, has: async () => false },
    logger: { info() {}, warn() {}, error() {} } };
  const routing = registerRoutingMethods(context); await routing.initialize(); cleanups.push(() => routing.close());
  const authority = new AbortController();
  const source = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (new URL(request.url).pathname === '/v1/chat/completions') {
      const body = await request.json() as { messages: Array<{ content: string }> };
      const input = JSON.parse(body.messages[1]!.content) as { revision: string };
      return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ revision: input.revision, spans: [] }) } }] });
    }
    return Response.json({ model: 'jev-1.13.0', answers: { complete: { type: 'noul', noul: 1 }, precise: { type: 'noul', noul: 1 } }, usage: { input_tokens: 1, output_tokens: 1 } });
  } });
  cleanups.push(() => source.stop(true));
  const screening: ProtectedSourceOwnerOptions = {
    authority: { ownerId: 'synthetic-route-test', revision: '1', retention: 'ephemeral-no-log', signal: authority.signal, assertCurrent() {} },
    proposal: { endpoint: `http://127.0.0.1:${source.port}`, model: 'synthetic-proposer' },
    judgment: { endpoint: `http://127.0.0.1:${source.port}`, model: 'jev-1.13.0' }, timeoutMs: 5000,
  };
  let control: InboxPollingControl | undefined;
  const controls = {
    onAccountInvalidation(listener: () => void) { invalidations.add(listener); return () => { invalidations.delete(listener); }; },
    gatePolling(_provider: string, value: InboxPollingControl) { control = value; return () => {}; },
    createEmailService() {
      const disposers: Array<() => void> = [];
      const { emailServiceDeps } = composeMailDeps({ configManager,
        secretsManager: { async get() { return 'synthetic-password'; }, onDidChange(listener: (key: string) => void) { credentialChanges.add(listener); return () => { credentialChanges.delete(listener); }; } },
        registerDispose(dispose) { disposers.push(dispose); } });
      const service = new EmailService({ ...emailServiceDeps, async imapSocketFactory() {
        const socket = new SnapshotSocket({ validity: 7, uids: [42] });
        setImmediate(() => socket.greet()); return socket as unknown as Socket;
      } });
      return { service, close() { for (const dispose of disposers.reverse()) dispose(); } };
    } };
  const timestamp = Date.now() - 10000;
  const slack = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/api/auth.test') return Response.json({ ok: true, team_id: 'T-SYNTHETIC', user_id: 'U-SYNTHETIC' });
    if (path === '/api/conversations.list') return Response.json({ ok: true, channels: [{ id: 'D-SYNTHETIC', user: 'U-SENDER' }] });
    return Response.json({ ok: true, messages: [{ ts: `${Math.floor(timestamp / 1000)}.000000`, user: 'U-SENDER', text: 'Synthetic route body' }] });
  } });
  cleanups.push(() => slack.stop(true));
  const factory = provider === 'slack'
    ? createSlackDaemonInboxFactory({ account: { workspaceId: 'T-SYNTHETIC', userId: 'U-SYNTHETIC' }, screening }, {
      createOwner: (ctx, options) => createSlackInboxOwner({ ...ctx, resolveRouteId: wrap(ctx.resolveRouteId) }, options, { createHttpClient: (_origin, options) => new Client(`http://127.0.0.1:${slack.port}`, options) }),
    })
    : createEmailDaemonInboxFactory({ account: { host: 'mail.synthetic.invalid', port: 993, username: 'owner@synthetic.invalid', mailbox: 'INBOX', security: 'tls' }, screening }, {
      createOwner: options => createEmailInboxOwner({ ...options, resolveRouteId: wrap(options.resolveRouteId) }),
    });
  const invoke = (id: string, body: unknown = {}) => context.catalog.invoke(id, { body, context: { metadata: { explicitUserRequest: true } } });
  return { context, configManager, routing, authority, invoke, entered: entered.promise, release: release.resolve, routeInputs,
    storedCount() {
      const directory = join(workingDirectory, '.goodvibes', 'tui', 'operator');
      const file = readdirSync(directory).find(name => name.startsWith(`inbox-${provider}-`) && name.endsWith('.sqlite'))!;
      if (!file) return 0; // Timestamp inbox storage is lazy until its first committed poll.
      const db = new Database(join(directory, file), { readonly: true });
      try { return db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM items').get()!.count; } finally { db.close(); }
    },
    async start() { const surface = await factory(context, routing, controls); cleanups.push(() => surface.close()); await surface.ready; return surface; },
    async poll() { await control!.stop(); await control!.start(); },
    invalidateCredential() {
      for (const invalidate of invalidations) invalidate();
      for (const change of credentialChanges) change('GOODVIBES_SURFACES_EMAIL_PASSWORD');
    },
    async list() { return await invoke('channels.inbox.list') as InboxListOutput; },
  };
}

for (const provider of ['slack', 'email'] as const) {
  test(`${provider} actual factory propagates the canonical persisted routing profile`, async () => {
    const f = await fixture(provider);
    await f.invoke('channels.routing.assign', { surfaceKind: provider, profileId: 'profile-owned', confirm: true });
    expect(f.routing.resolveProfileId(provider)).toBe('profile-owned');
    await f.start(); await f.poll(); if (provider === 'email') await f.poll();
    const listed = await f.list();
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]!.routeId).toBe('profile-owned');
    expect(f.routeInputs).toHaveLength(1);
    expect(Object.keys(f.routeInputs[0]!).sort()).toEqual(['fromDigest', 'kind', 'provider']);
    expect(f.routeInputs[0]).toMatchObject({ provider, kind: 'dm', fromDigest: expect.stringMatching(/^[a-f0-9]{16}$/) });
  });
}

for (const provider of ['slack', 'email'] as const) {
  for (const assignment of ['absent', 'other-provider', 'wildcard', 'resolver-closed'] as const) {
    test(`${provider} canonical routing handles ${assignment} without losing screened intake`, async () => {
      const f = await fixture(provider);
      if (assignment === 'other-provider' || assignment === 'wildcard') {
        await f.invoke('channels.routing.assign', { surfaceKind: assignment === 'wildcard' ? 'any' : 'discord', profileId: 'profile-fallback', confirm: true });
      }
      await f.start();
      if (assignment === 'resolver-closed') await f.routing.close();
      await f.poll(); if (provider === 'email') await f.poll();
      const listed = await f.list();
      expect(listed.items).toHaveLength(1);
      expect(listed.items[0]!.routeId).toBe(assignment === 'wildcard' ? 'profile-fallback' : undefined);
    });
  }
  for (const revoke of ['source', 'account', 'credential'] as const) {
    test(`${provider} ${revoke} revocation during asynchronous routing cannot commit a stale item`, async () => {
      const f = await fixture(provider, true);
      await f.invoke('channels.routing.assign', { surfaceKind: provider, profileId: 'profile-owned', confirm: true });
      await f.start();
      if (provider === 'email') await f.poll(); // Own the initial UID checkpoint before fetching content.
      const pending = f.poll();
      await f.entered;
      if (revoke === 'source') f.authority.abort();
      else if (revoke === 'credential') f.invalidateCredential();
      else f.configManager.set(provider === 'slack' ? 'surfaces.slack.workspaceId' : 'surfaces.email.user', 'changed-account');
      f.release(); await pending;
      expect(f.storedCount()).toBe(0);
      if (revoke !== 'credential') await expect(f.list()).rejects.toThrow();
    });
  }
}

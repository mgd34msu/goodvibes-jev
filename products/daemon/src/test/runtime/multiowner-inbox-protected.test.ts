import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Socket } from 'node:net';
import { Client } from 'undici/index.js';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { GatewayMethodCatalog } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { EmailService } from '@goodvibes-jev/engine/sdk/platform/email';
import { createEmailInboxOwner, createSlackInboxOwner, digestSender,
  type EmailInboxAccount, type InboxListOutput, type InboxPollingControl } from '@goodvibes-jev/engine/sdk/platform/intake';
import type { ProtectedSourceOwnerOptions } from '@goodvibes-jev/engine/sdk/platform/security';
import type { HandlerContext } from '../../daemon/handlers/context.js';
import { createEmailDaemonInboxSourceFactory } from '../../runtime/email-inbox-composition.js';
import { composeMailDeps } from '../../runtime/mail-composition.js';
import { createMultiOwnerDaemonInboxFactory } from '../../runtime/multiowner-inbox-composition.js';
import { createSlackDaemonInboxSourceFactory } from '../../runtime/slack-inbox-composition.js';
import { SnapshotSocket } from '../helpers/email-snapshot-socket.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

const sensitive = 'person@example.test';
const body = `Contact ${sensitive}, keep the build notes.`;
const redacted = 'Contact [redacted], keep the build notes.';
const sender = 'sender@synthetic.invalid';
const slackAccount = { workspaceId: 'T-SYNTHETIC-COMBINED', userId: 'U-SYNTHETIC-OWNER' };
const emailAccount: EmailInboxAccount = { host: 'mail.synthetic.invalid', port: 993,
  username: 'owner@synthetic.invalid', mailbox: 'INBOX', security: 'tls' };

class ProtectedMailSocket extends SnapshotSocket {
  override headers(): string {
    return `From: ${sender}\r\nSubject: Review ${sensitive}\r\nContent-Type: text/plain; charset=utf-8\r\nDate: Thu, 08 Oct 2026 00:00:00 +0000\r\n\r\n`;
  }
  override async answer(command: string): Promise<void> {
    const uid = Number(/UID FETCH (\d+)/.exec(command)?.[1]);
    const done = `${command.split(' ')[0]} OK complete\r\n`;
    if (command.includes('BODYSTRUCTURE')) {
      this.feed(`* 1 FETCH (UID ${uid} BODYSTRUCTURE ("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "8BIT" ${Buffer.byteLength(body)} 1))\r\n${done}`);
    } else if (/BODY.PEEK\[[1]?\]/.test(command)) {
      const section = /BODY.PEEK\[([^\]]*)\]/.exec(command)![1]!;
      this.section(uid, section, body); this.feed(done);
    } else await super.answer(command);
  }
}

/** No fake owner, adapter, store, proof, or aggregator: only remote transports are synthetic. */
test('real protected Slack and email share a canonical projection and refuse cross-owner revocation during mail validation', async () => {
  const root = makeOwnedTempDir('multiowner-protected');
  const configManager = new ConfigManager({ workingDir: root, homeDir: root, surfaceRoot: 'daemon' });
  configManager.set('cluster.enabled', false);
  configManager.set('surfaces.slack.enabled', true);
  configManager.set('surfaces.slack.workspaceId', slackAccount.workspaceId);
  configManager.set('surfaces.email.host', emailAccount.host);
  configManager.set('surfaces.email.user', emailAccount.username);
  const calls: string[] = [], screened: string[][] = [];
  const slackAuthority = new AbortController(), emailAuthority = new AbortController();
  const screeningServer = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const data = await request.json() as { messages?: Array<{ content: string }> };
    if (new URL(request.url).pathname === '/v1/chat/completions') {
      const source = JSON.parse(data.messages![1]!.content) as { revision: string; parts: string[] };
      screened.push(source.parts);
      const spans = source.parts.flatMap((part, index) => Array.from(part.matchAll(/person@example\.test/g), match =>
        ({ part: index, start: match.index!, end: match.index! + sensitive.length })));
      return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant',
        content: JSON.stringify({ revision: source.revision, spans }) } }] });
    }
    return Response.json({ model: 'jev-1.13.0', answers: { complete: { type: 'noul', noul: 1 }, precise: { type: 'noul', noul: 1 } },
      usage: { input_tokens: 10, output_tokens: 2 } });
  } });
  const slackServer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = new URL(request.url).pathname; calls.push(path);
    expect(request.headers.get('authorization')).toBe('Bearer xoxb-synthetic-combined');
    if (path === '/api/auth.test') return Response.json({ ok: true, team_id: slackAccount.workspaceId, user_id: slackAccount.userId });
    if (path === '/api/conversations.list') return Response.json({ ok: true, channels: [{ id: 'D-SYNTHETIC', user: 'U-SYNTHETIC-SENDER' }] });
    expect(path).toBe('/api/conversations.history');
    return Response.json({ ok: true, messages: [{ ts: `${Math.floor((Date.now() - 20_000) / 1_000)}.000000`, user: 'U-SYNTHETIC-SENDER', text: body }] });
  } });
  const screening = (provider: string, authority: AbortController): ProtectedSourceOwnerOptions => ({
    authority: { ownerId: `synthetic-combined-${provider}`, revision: '1', retention: 'ephemeral-no-log', signal: authority.signal, assertCurrent() {} },
    proposal: { endpoint: `http://127.0.0.1:${screeningServer.port}`, model: 'synthetic-proposer' },
    judgment: { endpoint: `http://127.0.0.1:${screeningServer.port}`, model: 'jev-1.13.0' }, timeoutMs: 5_000,
  });
  const context: HandlerContext = { configManager, workingDirectory: root, homeDirectory: root,
    catalog: new GatewayMethodCatalog(), logger: { info() {}, warn() {}, error() {} },
    credentials: { async resolveConfigSecret(key) { expect(key).toBe('surfaces.slack.botToken'); return 'xoxb-synthetic-combined'; },
      resolveRef: async () => null, put: async () => {}, has: async () => false } };
  const controls = new Map<string, InboxPollingControl>();
  const disposers: Array<() => void> = [], sockets: ProtectedMailSocket[] = [];
  const release = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  let armedSocket = -1, slackScope = '', emailScope = '';
  const surface = await createMultiOwnerDaemonInboxFactory([
    createSlackDaemonInboxSourceFactory({ account: slackAccount, screening: screening('slack', slackAuthority) }, {
      async createOwner(ctx, options) {
        const owner = await createSlackInboxOwner(ctx, options, { createHttpClient(origin, options) {
          expect(origin).toBe('https://slack.com'); return new Client(`http://127.0.0.1:${slackServer.port}`, options);
        } });
        slackScope = owner.scopeId; return owner;
      },
    }),
    createEmailDaemonInboxSourceFactory({ account: emailAccount, screening: screening('email', emailAuthority) }, {
      createOwner(options) { const owner = createEmailInboxOwner(options); emailScope = owner.scopeId; return owner; },
    }),
  ])(context, { async initialize() {}, async close() {}, unregister() {}, resolveProfileId: () => null }, {
    gatePolling(id, control) { controls.set(id, control); },
    createEmailService() {
      const { emailServiceDeps } = composeMailDeps({ configManager,
        secretsManager: { async get(key) { expect(key).toBe('GOODVIBES_SURFACES_EMAIL_PASSWORD'); return 'synthetic-combined-mail-secret'; },
          onDidChange() { return () => {}; } }, registerDispose(dispose) { disposers.push(dispose); },
      });
      const refuse = async (): Promise<never> => { throw new Error('Native mail transport forbidden'); };
      const service = new EmailService({ ...emailServiceDeps,
        transport: { connectImapTls: refuse, connectImapPlain: refuse, connectSmtpTls: refuse, connectSmtpStartTls: refuse },
        async imapSocketFactory(host, port) {
          expect(host).toBe(emailAccount.host); expect(port).toBe(emailAccount.port);
          const held = sockets.length === armedSocket;
          const socket = new ProtectedMailSocket({ validity: 7, uids: [42], ...(held ? { hold: ' EXAMINE ', gate: release.promise } : {}) });
          sockets.push(socket);
          if (held) void socket.reached.promise.then(entered.resolve);
          setImmediate(() => socket.greet()); return socket as unknown as Socket;
        },
      });
      return { service, close() { for (const dispose of disposers.splice(0).reverse()) dispose(); } };
    },
  });
  const store = (provider: string, scope: string) => join(root, '.goodvibes', 'tui', 'operator', `inbox-${provider}-${scope}.sqlite`);
  const slackStore = store('slack', slackScope), emailStore = store('email', emailScope);
  const invoke = (provider?: string) => context.catalog.invoke('channels.inbox.list',
    { body: { provider }, context: { scopes: ['read:channels'] } }) as Promise<InboxListOutput>;
  try {
    await surface.ready;
    await controls.get(`slack:${slackScope}`)!.start();
    const mailControl = controls.get(`email:${emailScope}`)!;
    await mailControl.start(); // Explicit durable UID seed, without fetching content.
    await mailControl.stop(); await mailControl.start();
    const result = await invoke();
    expect(result).toMatchObject({ total: 2, partial: false });
    expect(result.items.find(item => item.provider === 'slack')).toMatchObject({ bodyPreview: redacted, subject: 'Direct message', from: digestSender('U-SYNTHETIC-SENDER') });
    expect(result.items.find(item => item.provider === 'email')).toMatchObject({ bodyPreview: redacted, subject: 'Review [redacted]', from: digestSender(`email:${sender}`) });
    expect(result.providers.map(provider => provider.provider).sort()).toEqual(['email', 'slack']);
    expect(screened).toHaveLength(2); expect(screened.map(parts => parts.length).sort()).toEqual([4, 5]);
    expect(slackStore).not.toBe(emailStore);
    for (const [path, provider] of [[slackStore, 'slack'], [emailStore, 'email']] as const) {
      expect(existsSync(`${path}.owner.lock`)).toBe(true);
      const db = new Database(path, { readonly: true });
      try { expect(db.query('SELECT provider, bodyPreview FROM items').all()).toEqual([{ provider, bodyPreview: redacted }]); }
      finally { db.close(); }
      const bytes = readFileSync(path).toString('utf8');
      for (const raw of [sensitive, sender, emailAccount.username, 'xoxb-synthetic-combined', 'synthetic-combined-mail-secret']) expect(bytes).not.toContain(raw);
    }
    // The first mail socket acquires the read proof; the second revalidates it
    // after projection. No owner/proof method is stubbed to create this race.
    armedSocket = sockets.length + 1;
    const pending = invoke();
    let published: InboxListOutput | undefined;
    void pending.then(value => { published = value; }, () => {});
    await Promise.race([entered.promise, new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Mail validation did not reach the held socket')), 5_000); timer.unref();
    })]);
    expect(calls).toContain('/api/auth.test');
    expect(sockets).toHaveLength(armedSocket + 1);
    expect(sockets.at(-1)!.commands.some(command => command.includes(' EXAMINE '))).toBe(true);
    expect(sockets.at(-1)!.commands.some(command => command.includes('FETCH'))).toBe(false);
    slackAuthority.abort(); release.resolve();
    await expect(pending).rejects.toThrow(); expect(published).toBeUndefined();
    expect(await invoke('email')).toMatchObject({ total: 1, items: [{ provider: 'email', bodyPreview: redacted }] });
    await expect(invoke('slack')).rejects.toThrow();
    expect(screened).toHaveLength(2);
  } finally {
    release.resolve(); await surface.close();
    await slackServer.stop(true); await screeningServer.stop(true);
  }
  expect(context.catalog.hasHandler('channels.inbox.list')).toBe(false);
  expect(sockets.every(socket => socket.closed)).toBe(true);
  expect(existsSync(`${slackStore}.owner.lock`)).toBe(false);
  expect(existsSync(`${emailStore}.owner.lock`)).toBe(false);
});

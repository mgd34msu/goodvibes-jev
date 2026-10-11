/** Original daemon 254699bf send assertions, exercised through canonical transport owners. */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDaemonCliConfiguration } from '../../cli/configuration.js';
import { SecretsManager } from '../../config/secrets.js';
import { createSendStack } from '../../daemon/send/composition.js';
import { runSendCommand } from '../../daemon/send/command.js';
import { SEND_CHANNELS } from '../../daemon/send/channels.js';
import { canRenderInert, inertBodyFor } from '../../daemon/send/inert-text.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

interface WireRequest { url: string; method: string; headers: Headers; body: string }
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture(surfaces: Record<string, unknown>, options: { movedHome?: boolean; respond?: (request: WireRequest) => Response } = {}) {
  const root = makeOwnedTempDir('daemon-send-wire');
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'); const work = join(root, 'work');
  const daemonHome = options.movedHome ? join(root, 'moved', 'daemon') : join(home, '.goodvibes', 'daemon');
  mkdirSync(daemonHome, { recursive: true }); mkdirSync(work, { recursive: true });
  writeFileSync(join(daemonHome, 'settings.json'), JSON.stringify({
    controlPlane: { gateway: true }, integrations: { routeBinding: true, deliveryTracking: true },
    service: { enabled: true }, surfaces,
  }));
  const configuration = createDaemonCliConfiguration({ daemonHome: options.movedHome ? daemonHome : undefined, workingDir: work },
    { HOME: home, GOODVIBES_HOME: home }, work);
  const captured: WireRequest[] = [];
  // Only the transport is stubbed. No helper, credential resolver, router or strategy mocks.
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const request = { url: input instanceof Request ? input.url : String(input), method: init?.method ?? 'GET',
      headers: new Headers(init?.headers), body: typeof init?.body === 'string' ? init.body : '' };
    captured.push(request);
    return options.respond?.(request) ?? Response.json({ ok: true, result: { message_id: 4242 }, id: 'synthetic-response-id' });
  }, { preconnect() { throw new Error('Unexpected preconnect'); } }));
  cleanup.push(() => fetch.mockRestore());
  const stack = createSendStack(configuration);
  const send = (args: string[]) => runSendCommand(args, { configManager: configuration.config, deliver: stack.deliver,
    stdinIsTty: true, readStdin: async () => { throw new Error('Unexpected stdin'); } });
  return { configuration, captured, send };
}
const telegram = { enabled: true, botToken: 'synthetic-daemon-token', defaultChatId: '99001' };

describe('standalone send provider wire contract', () => {
  for (const movedHome of [false, true]) {
    test(`Telegram resolves an actual daemon-store reference with ${movedHome ? 'overridden' : 'default'} daemon home`, async () => {
      const owned = fixture({ telegram: { ...telegram, botToken: 'goodvibes://secrets/goodvibes/SYNTHETIC_SEND_WIRE_TOKEN' } }, { movedHome });
      const { configuration } = owned;
      await new SecretsManager({ projectRoot: configuration.workingDirectory, globalHome: configuration.homeDirectory,
        daemonHome: configuration.daemonHomeDirectory, configManager: configuration.config,
      }).set('SYNTHETIC_SEND_WIRE_TOKEN', 'synthetic-owned-store-token', { scope: 'daemon' });
      const result = await owned.send(['--channel', 'telegram', 'the train is blocked']);
      expect(result.exitCode).toBe(0); expect(owned.captured).toHaveLength(1);
      expect(owned.captured[0]!.url).toBe('https://api.telegram.org/botsynthetic-owned-store-token/sendMessage');
      expect(owned.captured[0]!.url).not.toContain('goodvibes://');
      expect(result.lines.join('\n')).not.toContain('synthetic');
    });
  }

  test('automatic selection excludes an enabled destinationless channel and lists every addressing vocabulary without sending', async () => {
    const owned = fixture({ telegram: { ...telegram, defaultChatId: '' },
      ntfy: { enabled: true, baseUrl: 'https://ntfy.example', topic: 'gv-default', token: 'synthetic-token' } });
    const listing = await owned.send(['--list']);
    expect(listing.exitCode).toBe(0);
    const output = listing.lines.join('\n');
    for (const channel of SEND_CHANNELS) expect(output).toContain(`${channel.id}:`);
    expect(output).toContain('ntfy: on; topic: gv-default');
    expect(output).toContain('chat id: not set'); expect(output).toContain('room id:');
    expect(output).toContain('Default with no --channel: ntfy'); expect(output).toContain('--to <address>'); expect(owned.captured).toHaveLength(0);
    expect((await owned.send(['automatic message'])).exitCode).toBe(0);
    expect(owned.captured).toHaveLength(1);
    expect(owned.captured[0]!.url).toBe('https://ntfy.example/gv-default');
    expect(owned.captured[0]!.body).toBe('automatic message');
    expect(owned.captured[0]!.headers.get('Title')).toBe('GoodVibes');
    expect(owned.captured[0]!.headers.has('Click')).toBe(false);
  });

  test('Telegram explicit recipient and argument terminator reach transport without changing the configured default', async () => {
    const owned = fixture({ telegram });
    expect((await owned.send(['--channel', 'telegram', '--to', '12345', '--', '--port', 'is', 'wrong'])).exitCode).toBe(0);
    expect(owned.captured).toHaveLength(1);
    expect(JSON.parse(owned.captured[0]!.body)).toMatchObject({ chat_id: '12345', text: '--port is wrong' });
    expect(owned.configuration.config.get('surfaces.telegram.defaultChatId')).toBe('99001');
  });

  test('Telegram reads daemon-tier settings, posts exact text and never enables parse_mode', async () => {
    const owned = fixture({ telegram });
    const message = '[Approved](https://evil.example) *bold* _under_ `code` v1.25.0!';
    expect((await owned.send(['--channel', 'telegram', message])).exitCode).toBe(0);
    expect(owned.captured).toHaveLength(1);
    const request = owned.captured[0]!;
    expect(request.url).toBe('https://api.telegram.org/botsynthetic-daemon-token/sendMessage');
    expect(request.method).toBe('POST');
    const payload = JSON.parse(request.body);
    expect(payload.chat_id).toBe('99001'); expect(payload.text).toBe(message);
    expect(payload).not.toHaveProperty('parse_mode');
    expect(payload.disable_web_page_preview).toBe(true);
  });

  for (const [message, expected] of [
    ['[Approved](https://evil.example)', '\\[Approved\\]\\(https://evil.example\\)'],
    ['**bold** ||spoiler|| > quote `code`', '\\*\\*bold\\*\\* \\|\\|spoiler\\|\\| \\> quote \\`code\\`'],
    ['ping @everyone now', 'ping @\u200beveryone now'],
  ]) {
    test(`Discord sends escaped bytes: ${message}`, async () => {
      const owned = fixture({ discord: { enabled: true, botToken: 'synthetic-token', defaultChannelId: '123456789012345678' } });
      expect((await owned.send(['--channel', 'discord', message!])).exitCode).toBe(0);
      expect(owned.captured).toHaveLength(1);
      const request = owned.captured[0]!;
      expect(request.url).toBe('https://discord.com/api/v10/channels/123456789012345678/messages');
      expect(request.headers.get('Authorization')).toBe('Bot synthetic-token');
      expect(JSON.parse(request.body).content).toBe(expected);
      expect(request.body).not.toContain(message!);
    });
  }

  test('Slack entity-escapes link/mention syntax and breaks formatting on the wire', async () => {
    const owned = fixture({ slack: { enabled: true, botToken: 'synthetic-token', defaultChannel: 'C1' } });
    expect((await owned.send(['--channel', 'slack', '<https://evil.example|Approved> <!channel> & *bold*'])).exitCode).toBe(0);
    expect(owned.captured).toHaveLength(1);
    const request = owned.captured[0]!;
    expect(request.url).toBe('https://slack.com/api/chat.postMessage');
    expect(JSON.parse(request.body)).toMatchObject({ channel: 'C1', text: '&lt;https://evil.example|Approved&gt; &lt;!channel&gt; &amp; *\u200bbold*\u200b' });
  });

  for (const alias of ['google-chat', 'googleChat']) {
    test(`Google Chat alias ${alias} reaches the real entity-escaped transport`, async () => {
      const url = 'https://chat.googleapis.com/v1/spaces/SYNTHETIC/messages';
      const owned = fixture({ googleChat: { enabled: true, webhookUrl: url } });
      expect((await owned.send(['--channel', alias, '<https://evil.example|Approved> & *bold*'])).exitCode).toBe(0);
      expect(owned.captured).toHaveLength(1); expect(owned.captured[0]!.url).toBe(url);
      expect(JSON.parse(owned.captured[0]!.body).text).toBe('&lt;https://evil.example|Approved&gt; &amp; *\u200bbold*\u200b');
    });
  }

  test('Mattermost escapes masked links on the actual posts transport', async () => {
    const owned = fixture({ mattermost: { enabled: true, baseUrl: 'https://mattermost.example', botToken: 'synthetic-token', defaultChannelId: 'c1' } });
    expect((await owned.send(['--channel', 'mattermost', '[Approved](https://evil.example)'])).exitCode).toBe(0);
    expect(owned.captured).toHaveLength(1); expect(owned.captured[0]!.url).toBe('https://mattermost.example/api/v4/posts');
    expect(JSON.parse(owned.captured[0]!.body)).toMatchObject({ channel_id: 'c1', message: '\\[Approved\\]\\(https://evil.example\\)' });
  });

  test('WhatsApp breaks delimiters without escaping readable brackets', async () => {
    const owned = fixture({ whatsapp: { enabled: true, accessToken: 'synthetic-token', phoneNumberId: '1', defaultRecipient: '+15550100' } });
    expect((await owned.send(['--channel', 'whatsapp', '*bold* _under_ ~strike~ `code` and [not a link](x)'])).exitCode).toBe(0);
    expect(owned.captured).toHaveLength(1);
    expect(JSON.parse(owned.captured[0]!.body)).toMatchObject({ messaging_product: 'whatsapp', to: '+15550100', type: 'text',
      text: { body: '*\u200bbold*\u200b _\u200bunder_\u200b ~\u200bstrike~\u200b `\u200bcode`\u200b and [not a link](x)' } });
  });

  test('Matrix uses m.text without formatted_body and Signal passes exact plain text to its bridge', async () => {
    const message = 'step 3 failed (retry now!) *not bold*';
    const owned = fixture({ matrix: { enabled: true, homeserverUrl: 'https://matrix.example', accessToken: 'synthetic-token', userId: '@x:m', defaultRoomId: '!r:m' },
      signal: { enabled: true, bridgeUrl: 'https://signal.example', token: 'synthetic-token', account: '+15550000', defaultRecipient: '+15550111' } });
    for (const channel of ['matrix', 'signal']) expect((await owned.send(['--channel', channel, message])).exitCode).toBe(0);
    expect(owned.captured).toHaveLength(2);
    const matrix = JSON.parse(owned.captured[0]!.body);
    expect(matrix).toEqual({ msgtype: 'm.text', body: message });
    expect(owned.captured[0]!.url).toStartWith('https://matrix.example/_matrix/client/v3/rooms/!r%3Am/send/m.room.message/');
    expect(owned.captured[1]!.url).toBe('https://signal.example');
    expect(JSON.parse(owned.captured[1]!.body)).toMatchObject({ surface: 'signal', recipient: '+15550111', text: message });
  });

  test('ntfy configured/override topics preserve the default and newlines remain in the body, never headers', async () => {
    const owned = fixture({ ntfy: { enabled: true, baseUrl: 'https://ntfy.example', topic: 'gv-default', token: 'synthetic-token' } });
    expect((await owned.send(['--channel', 'ntfy', 'first'])).exitCode).toBe(0);
    const body = 'line one\nPriority: 5\nline two';
    expect((await owned.send(['--channel', 'ntfy', '--to', 'gv-noisy', '--title', 'Release', body])).exitCode).toBe(0);
    expect(owned.captured).toHaveLength(2);
    expect(owned.captured[0]!.url).toBe('https://ntfy.example/gv-default'); expect(owned.captured[0]!.body).toBe('first');
    const request = owned.captured[1]!;
    expect(request.url).toBe('https://ntfy.example/gv-noisy'); expect(request.body).toBe(body);
    expect(request.headers.get('Title')).toBe('Release'); expect(request.headers.has('Priority')).toBe(false);
    expect(owned.configuration.config.get('surfaces.ntfy.topic')).toBe('gv-default');
  });

  test('provider rejection is nonzero with status but no provider prose or credential-bearing URL', async () => {
    const owned = fixture({ telegram }, { respond: () => Response.json({ ok: false, description: 'synthetic-private-provider-prose' }, { status: 401 }) });
    const result = await owned.send(['--channel', 'telegram', 'ping']);
    expect(owned.captured).toHaveLength(1); expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('HTTP 401'); expect(result.lines.join('\n')).not.toContain('synthetic');
  });

  test('a transport failure echoing the credential URL stays structurally private and never retries', async () => {
    const owned = fixture({ telegram }, { respond: (request) => { throw new Error(`synthetic-private-fetch-failed: ${request.url}`); } });
    const result = await owned.send(['--channel', 'telegram', 'ping']);
    expect(owned.captured).toHaveLength(1); expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).not.toContain('synthetic'); expect(result.lines.join('\n')).not.toContain('api.telegram.org');
  });

  test('every advertised transform exists, while unverified surfaces refuse before transport', async () => {
    expect(SEND_CHANNELS.length).toBeGreaterThan(0);
    for (const channel of SEND_CHANNELS) {
      expect(canRenderInert(channel.surfaceKind)).toBe(true);
      expect(() => inertBodyFor(channel.surfaceKind, 'probe')).not.toThrow();
    }
    const owned = fixture({ telegram });
    for (const surface of ['telephony', 'web'] as const) {
      expect(() => inertBodyFor(surface, 'probe')).toThrow('No verified inert-text transform');
      expect(SEND_CHANNELS.some((channel) => channel.surfaceKind === surface)).toBe(false);
      expect((await owned.send(['--channel', surface, 'probe'])).exitCode).toBe(2);
    }
    expect(owned.captured).toHaveLength(0);
  });
});

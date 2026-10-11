import { describe, expect, spyOn, test } from 'bun:test';
import type { ChannelDeliveryRequest } from '@goodvibes-jev/engine/sdk/platform/channels';
import { SecretsManager } from '../../config/secrets.js';
import { runDaemonCli } from '../../cli/run.js';
import * as configuration from '../../cli/configuration.js';
import * as composition from '../../daemon/send/composition.js';
import * as stdin from '../../daemon/send/stdin.js';
import { prepareSendCommand, runSendCommand, type SendCommandDeps } from '../../daemon/send/command.js';
import { SEND_CHANNELS } from '../../daemon/send/channels.js';

const GATES = {
  'controlPlane.gateway': true,
  'integrations.routeBinding': true,
  'integrations.deliveryTracking': true,
  'service.enabled': true,
};
function deps(values: Record<string, unknown> = {}) {
  const requests: ChannelDeliveryRequest[] = [];
  let stdinReads = 0;
  const settings = { ...GATES, 'surfaces.ntfy.enabled': true, 'surfaces.ntfy.topic': 'synthetic-topic', ...values };
  const ports: SendCommandDeps = {
    configManager: { get: (key: string): never => (settings as Record<string, unknown>)[key] as never },
    deliver: async (request) => { requests.push(request); return 'synthetic-private-provider-id'; },
    readStdin: async () => { stdinReads += 1; return 'synthetic piped message'; },
    stdinIsTty: false,
  };
  return { ports, requests, stdinReads: () => stdinReads };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('send parsing precedes owned configuration, stdin and delivery effects', () => {
  for (const [args, exitCode] of [
    [['--help'], 0], [['-h'], 0], [['--unknown-synthetic-private-option'], 2],
    [['--channel'], 2], [['--to'], 2], [['--title'], 2], [['--channel='], 2],
    [['--title', '--list'], 2], [['--list', 'message'], 2], [['--list', '--to', 'private-target'], 2],
  ] as const) {
    test(`${args.join(' ')} has no configuration or owner effects`, async () => {
      const config = spyOn(configuration, 'createDaemonCliConfiguration').mockImplementation(() => { throw new Error('configuration must stay lazy'); });
      const stack = spyOn(composition, 'createSendStack').mockImplementation(() => { throw new Error('owners must stay lazy'); });
      const input = spyOn(stdin, 'readAllStdin').mockImplementation(() => { throw new Error('stdin must stay lazy'); });
      const output: string[] = [];
      try {
        expect(await runDaemonCli(['send', ...args], { stdout: (line) => output.push(line), stderr: (line) => output.push(line) })).toBe(exitCode);
        expect(output.join('\n')).toContain('Usage:');
        expect(output.join('\n')).not.toContain('synthetic-private');
        expect(config).not.toHaveBeenCalled(); expect(stack).not.toHaveBeenCalled(); expect(input).not.toHaveBeenCalled();
      } finally { input.mockRestore(); stack.mockRestore(); config.mockRestore(); }
    });
  }

  test('supports inline values, -c, and a literal argument terminator', () => {
    expect(prepareSendCommand(['-c', 'NTFY', '--to=chosen-topic', '--title=Chosen title', '--', '--help', '-body']))
      .toEqual({ kind: 'send', args: { channel: 'NTFY', to: 'chosen-topic', title: 'Chosen title', list: false, words: ['--help', '-body'] } });
  });

  test('accepts a Telegram negative numeric chat ID without treating it as an option', async () => {
    const fixture = deps({ 'surfaces.telegram.enabled': true });
    const result = await runSendCommand(['--channel', 'telegram', '--to', '-100123', 'group message'], fixture.ports);
    expect(result.exitCode).toBe(0);
    expect(fixture.requests[0]?.target).toMatchObject({ surfaceKind: 'telegram', address: '-100123' });
    expect(fixture.requests[0]?.body).toBe('group message');
    expect(fixture.stdinReads()).toBe(0);
  });

  test('configuration acquisition failures become a fixed CLI error without disclosing their cause', async () => {
    const config = spyOn(configuration, 'createDaemonCliConfiguration').mockImplementation(() => {
      throw new Error('synthetic-private-config-error', { cause: new Error('synthetic-private-config-cause') });
    });
    const stack = spyOn(composition, 'createSendStack').mockImplementation(() => { throw new Error('owners must stay lazy'); });
    const stdout: string[] = []; const stderr: string[] = [];
    try {
      expect(await runDaemonCli(['send', 'body'], { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) })).toBe(1);
      expect(stdout).toEqual([]); expect(stderr).toEqual(['Daemon command failed']);
      expect(stack).not.toHaveBeenCalled();
    } finally { stack.mockRestore(); config.mockRestore(); }
  });
});

describe('send selection and canonical enablement', () => {
  test('chooses the only enabled destination and retains explicit message/title bytes', async () => {
    const fixture = deps({ 'surfaces.telegram.enabled': false, 'surfaces.telegram.defaultChatId': 'disabled-chat' });
    const result = await runSendCommand(['one', 'two', '--title', 'Synthetic title'], fixture.ports);
    expect(result.exitCode).toBe(0); expect(fixture.stdinReads()).toBe(0);
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]).toMatchObject({ target: { kind: 'surface', surfaceKind: 'ntfy', label: 'Synthetic title' },
      body: 'one two', title: 'Synthetic title', allowDuplicate: true, includeLinks: false });
    expect(result.lines.join('\n')).not.toContain('synthetic-private-provider-id');
    expect(result.lines.join('\n')).toContain('arrival is not verified');
  });

  test('default selection reports the fixed catalog channel and original unique-destination reason', async () => {
    const fixture = deps();
    const result = await runSendCommand(['body'], fixture.ports);
    expect(result.exitCode).toBe(0);
    expect(result.lines.join('\n')).toContain('using ntfy');
    expect(result.lines.join('\n')).toContain('the only channel that is switched on and has a destination configured');
  });

  test('unknown and disabled choices name configured channels without disclosing input, destinations or redirecting', async () => {
    const fixture = deps({ 'surfaces.telegram.enabled': false, 'surfaces.googleChat.enabled': true,
      'surfaces.googleChat.webhookUrl': 'https://example.invalid/synthetic-private-capability?key=secret' });
    for (const [channel, code] of [['synthetic-private-unknown', 2], ['telegram', 1]] as const) {
      const result = await runSendCommand(['--channel', channel, 'body'], fixture.ports);
      expect(result.exitCode).toBe(code);
      expect(result.lines.join('\n')).toContain('Configured and ready: ntfy, googleChat.');
      expect(result.lines.join('\n')).not.toContain('synthetic-private');
      expect(result.lines.join('\n')).not.toContain('key=secret');
      expect(fixture.requests).toHaveLength(0); expect(fixture.stdinReads()).toBe(0);
    }
  });

  test('explicit choice resolves otherwise ambiguous configured defaults', async () => {
    const fixture = deps({ 'surfaces.telegram.enabled': true, 'surfaces.telegram.defaultChatId': 'other-default' });
    expect((await runSendCommand(['--channel=NTFY', 'body'], fixture.ports)).exitCode).toBe(0);
    expect(fixture.requests[0]?.target.surfaceKind).toBe('ntfy');
  });

  test('--to works without a configured default for the explicit surface', async () => {
    const fixture = deps({ 'surfaces.ntfy.topic': '', 'surfaces.telegram.enabled': true, 'surfaces.telegram.defaultChatId': 'other-default' });
    expect((await runSendCommand(['--channel=NTFY', '--to', 'chosen-topic', 'body'], fixture.ports)).exitCode).toBe(0);
    expect(fixture.requests[0]?.target).toMatchObject({ surfaceKind: 'ntfy', address: 'chosen-topic' });
  });

  for (const [label, values, args, code] of [
    ['ambiguous', { 'surfaces.telegram.enabled': true, 'surfaces.telegram.defaultChatId': 'other-default' }, [], 2],
    ['none enabled', { 'surfaces.ntfy.enabled': false }, [], 2],
    ['unknown channel', {}, ['--channel', 'synthetic-private-channel'], 2],
    ['disabled explicit channel', { 'surfaces.ntfy.enabled': false }, ['--channel', 'ntfy'], 1],
    ['non-boolean enablement', { 'surfaces.ntfy.enabled': 'true' }, ['--channel', 'ntfy'], 1],
    ['empty override', {}, ['--to', '   '], 2],
  ] as const) {
    test(`${label} refuses before stdin and delivery`, async () => {
      const fixture = deps(values);
      const result = await runSendCommand(args, fixture.ports);
      expect(result.exitCode).toBe(code); expect(fixture.requests).toHaveLength(0); expect(fixture.stdinReads()).toBe(0);
      expect(result.lines.join('\n')).not.toContain('synthetic-private-channel');
    });
  }

  for (const key of Object.keys(GATES)) {
    test(`${key} is required even for an explicit destination`, async () => {
      const fixture = deps({ [key]: false });
      const result = await runSendCommand(['--channel', 'ntfy', '--to', 'override-topic'], fixture.ports);
      expect(result.exitCode).toBe(1); expect(result.lines.join('\n')).toContain(key);
      expect(fixture.requests).toHaveLength(0); expect(fixture.stdinReads()).toBe(0);
    });
  }

  test('--list exposes readiness but never resolves or renders secret-bearing destinations', async () => {
    const fixture = deps({
      'surfaces.googleChat.enabled': true,
      'surfaces.googleChat.webhookUrl': 'https://example.invalid/synthetic-private-google-hook?key=private',
      'surfaces.webhook.enabled': true,
      'surfaces.webhook.defaultTarget': 'goodvibes://secrets/goodvibes/SYNTHETIC_PRIVATE_WEBHOOK',
    });
    const secret = spyOn(SecretsManager.prototype, 'get').mockImplementation(() => { throw new Error('list must not resolve credentials'); });
    try {
      const result = await runSendCommand(['--list'], fixture.ports);
      const text = result.lines.join('\n');
      expect(result.exitCode).toBe(0); expect(text).toContain('ntfy: on; topic: synthetic-topic');
      expect(text).toContain('googleChat: on; webhook URL: [configured; withheld]');
      expect(text).toContain('webhook: on; URL: [configured; withheld]');
      expect(text).not.toContain('synthetic-private'); expect(text).not.toContain('SYNTHETIC_PRIVATE');
      expect(text).toContain('credentials and provider availability are not verified');
      expect(secret).not.toHaveBeenCalled(); expect(fixture.requests).toHaveLength(0); expect(fixture.stdinReads()).toBe(0);
    } finally { secret.mockRestore(); }
  });

  test('every advertised surface can prepare an inert body through its canonical gate', async () => {
    for (const channel of SEND_CHANNELS) {
      const fixture = deps({ [channel.enabledKey]: true });
      const result = await runSendCommand(['--channel', channel.id, '--to', 'synthetic-destination', '*bold* <@123> & body'], fixture.ports);
      expect(result.exitCode, channel.id).toBe(0);
      expect(fixture.requests[0]?.target.surfaceKind).toBe(channel.surfaceKind);
    }
  });
});

describe('send owns the complete asynchronous outcome', () => {
  test('held stdin cannot start delivery or complete the command', async () => {
    const fixture = deps(); const input = deferred<string>();
    let settled = false;
    const running = runSendCommand([], { ...fixture.ports, readStdin: () => input.promise }).finally(() => { settled = true; });
    try {
      await turn(); expect(settled).toBe(false); expect(fixture.requests).toHaveLength(0);
      input.resolve('first line\nsecond line\n');
      expect((await running).exitCode).toBe(0); expect(fixture.requests[0]?.body).toBe('first line\nsecond line');
    } finally { input.resolve(''); await running; }
  });

  test('held delivery cannot complete, and its rejection is never retried', async () => {
    const fixture = deps(); const delivery = deferred<string | undefined>(); let calls = 0; let settled = false;
    const running = runSendCommand(['body'], { ...fixture.ports, deliver: () => { calls += 1; return delivery.promise; } }).finally(() => { settled = true; });
    try {
      await turn(); expect(calls).toBe(1); expect(settled).toBe(false);
      delivery.reject(new Error('synthetic-private-provider-error', { cause: new Error('synthetic-private-cause') }));
      const result = await running;
      expect(result.exitCode).toBe(1); expect(calls).toBe(1); expect(result.lines.join('\n')).not.toContain('synthetic-private');
    } finally { delivery.resolve(undefined); await running; }
  });

  test('stdin removes only terminal LF characters while explicit argument bytes are preserved', async () => {
    for (const [input, expected] of [['piped from a script\n', 'piped from a script'],
      ['  first\nsecond\n\n', '  first\nsecond'], ['body \n', 'body '], ['body\r\n', 'body\r']] as const) {
      const fixture = deps();
      expect((await runSendCommand([], { ...fixture.ports, readStdin: async () => input })).exitCode).toBe(0);
      expect(fixture.requests[0]?.body).toBe(expected);
      expect((await runSendCommand([input], fixture.ports)).exitCode).toBe(0);
      expect(fixture.requests[1]?.body).toBe(input);
    }
  });

  test('TTY, empty stdin, and broken stdin fail without dispatch', async () => {
    const fixture = deps();
    expect((await runSendCommand([], { ...fixture.ports, stdinIsTty: true })).exitCode).toBe(2);
    expect(fixture.stdinReads()).toBe(0);
    expect((await runSendCommand([], { ...fixture.ports, readStdin: async () => ' \n ' })).exitCode).toBe(2);
    const result = await runSendCommand([], { ...fixture.ports, readStdin: async () => { throw new Error('synthetic-private-input-error'); } });
    expect(result.exitCode).toBe(1); expect(result.lines.join('\n')).not.toContain('synthetic-private');
    expect(fixture.requests).toHaveLength(0);
  });

  test('error text, causes, provider IDs and hostile getters never cross the output boundary', async () => {
    const fixture = deps(); let privateReads = 0;
    const error = Object.create(null) as Record<string, unknown>;
    for (const key of ['message', 'cause', 'stack', 'toString', 'responseId']) {
      Object.defineProperty(error, key, { get() { privateReads += 1; throw new Error('synthetic-private-getter'); } });
    }
    Object.defineProperty(error, 'status', { get() { throw new Error('synthetic-private-status-getter'); } });
    for (const [failure, status] of [[error, undefined], [new Error('synthetic-private-text', { cause: { token: 'synthetic-private-cause' } }), undefined],
      [{ status: 503, message: 'synthetic-private-text', responseId: 'synthetic-private-provider-id' }, 503]] as const) {
      const result = await runSendCommand(['body'], { ...fixture.ports, deliver: async () => { throw failure; } });
      expect(result.exitCode).toBe(1); expect(result.lines.join('\n')).not.toContain('synthetic-private');
      if (status === 503) expect(result.lines.join('\n')).toContain('HTTP 503');
    }
    expect(privateReads).toBe(0);
  });
});

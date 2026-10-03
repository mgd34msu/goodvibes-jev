import { mockFetch } from '../helpers/typed-fetch-mock.ts';
import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChannelDeliveryRequest } from '@goodvibes-jev/engine/sdk/platform/channels';
import { createShellPathService } from '@/runtime/index.ts';
import { readAgentChannelDeliveryReceipts } from '../../agent/channel-delivery-receipts.ts';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerChannelsRuntimeCommands } from '../../input/commands/channels-runtime.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function channelContext(
  overrides: Record<string, unknown> = {},
  homeDirectory?: string,
  deliveryRequests?: ChannelDeliveryRequest[],
): { readonly context: CommandContext; readonly printed: string[] } {
  const home = homeDirectory ?? makeProjectTempDir('goodvibes-agent-channels-home');
  const shellPaths = createShellPathService({ workingDirectory: home, homeDirectory: home });
  const values: Record<string, unknown> = {
    'controlPlane.host': '127.0.0.1',
    'controlPlane.port': 3421,
    'surfaces.slack.enabled': true,
    'surfaces.slack.botToken': 'xoxb-redacted-test-token',
    'surfaces.slack.signingSecret': 'redacted-signing-secret',
    'surfaces.slack.defaultChannel': 'C123',
    'surfaces.telegram.enabled': true,
    'surfaces.telegram.botToken': 'telegram-redacted-token',
    ...overrides,
  };
  const printed: string[] = [];
  const context = {
    print: (message: string) => printed.push(message),
    platform: {
      configManager: {
        get: (key: string) => values[key],
      },
      ...(deliveryRequests ? {
        channelDeliveryRouter: {
          listStrategies: () => [{ id: 'test-delivery', canHandle: () => true, deliver: async () => ({}) }],
          deliver: async (request: ChannelDeliveryRequest) => {
            deliveryRequests.push(request);
            return 'delivery-response-1';
          },
        },
      } : {}),
    },
    workspace: {
      shellPaths,
    },
  } as unknown as CommandContext;
  return { context, printed };
}

function writeTokenHome(): string {
  const home = makeProjectTempDir('goodvibes-agent-channels-token');
  const tokenDir = join(home, '.goodvibes', 'daemon');
  mkdirSync(tokenDir, { recursive: true });
  writeFileSync(join(tokenDir, 'operator-tokens.json'), JSON.stringify({ token: 'route-token-redacted' }));
  return home;
}

async function withMockFetch<T>(handler: Parameters<typeof mockFetch>[0], run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch(handler);
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function runChannels(args: readonly string[], context: CommandContext): Promise<void> {
  const registry = new CommandRegistry();
  registerChannelsRuntimeCommands(registry);
  await registry.execute('channels', [...args], context);
}

describe('/channels command', () => {
  test('prints a read-only readiness summary with detail guidance', async () => {
    const { context, printed } = channelContext();

    await runChannels([], context);

    const output = printed.join('\n');
    expect(output).toContain('Channel Readiness');
    expect(output).toContain('ready: 2/14');
    expect(output).toContain('enabled: 2/14');
    expect(output).toContain('needs target: 1');
    expect(output).toContain('details: /channels show <id>');
    expect(output).toContain('Slack: ready ready=yes delivery=default-ready risk=group');
    expect(output).toContain('Telegram: needs-target ready=yes delivery=explicit-target risk=dm');
    expect(output).not.toContain('xoxb-redacted-test-token');
    expect(output).not.toContain('telegram-redacted-token');
  });

  test('filters enabled channels that need attention', async () => {
    const { context, printed } = channelContext({
      'surfaces.discord.enabled': true,
      'surfaces.discord.botToken': 'discord-redacted-token',
    });

    await runChannels(['attention'], context);

    const output = printed.join('\n');
    expect(output).toContain('Channel Readiness: Needs Attention');
    expect(output).toContain('Telegram: needs-target');
    expect(output).toContain('Discord: needs-config');
    expect(output).not.toContain('Slack: ready');
    expect(output).not.toContain('discord-redacted-token');
  });

  test('prints a read-only channel setup guide with policy and live-check steps', async () => {
    const { context, printed } = channelContext();

    await runChannels(['guide', 'telegram'], context);

    const output = printed.join('\n');
    expect(output).toContain('Channel Setup Guide');
    expect(output).toContain('current channel: Telegram (telegram)');
    expect(output).toContain('progress: 5/8 Choose target');
    expect(output).toContain('[>] Choose target: /channels show telegram');
    expect(output).toContain('Review allowlist');
    expect(output).toContain('/channels policies');
    expect(output).toContain('Run live checks');
    expect(output).toContain('/channels doctor telegram');
    expect(output).toContain('Send explicit test');
    expect(output).toContain('policy: Read-only channel setup guide.');
    expect(output).not.toContain('telegram-redacted-token');
  });

  test('shows one channel with config-key names and next step only', async () => {
    const { context, printed } = channelContext();

    await runChannels(['show', 'telegram'], context);

    const output = printed.join('\n');
    expect(output).toContain('Channel: Telegram (telegram)');
    expect(output).toContain('state: needs-target');
    expect(output).toContain('required config keys: surfaces.telegram.botToken');
    expect(output).toContain('missing config keys: none');
    expect(output).toContain('default target keys: surfaces.telegram.defaultChatId');
    expect(output).toContain('next: Provide an explicit delivery target per send');
    expect(output).toContain('never prints secret values and never sends messages');
    expect(output).not.toContain('telegram-redacted-token');
  });

  test('prints read-only connected-host channel account and policy diagnostics without secret values', async () => {
    const { context, printed } = channelContext({}, writeTokenHome());

    await withMockFetch(async (input, init) => {
      expect(String(init?.headers ? (init.headers as Record<string, string>).authorization : '')).toContain('Bearer route-token-redacted');
      const path = new URL(String(input)).pathname;
      if (path === '/api/channels/accounts') {
        return new Response(JSON.stringify({
          accounts: [
            {
              surface: 'slack',
              accountId: 'workspace-1',
              configured: true,
              linked: true,
              authState: 'linked',
              secrets: [{ field: 'primary', source: 'config', value: 'xoxb-secret-should-not-print' }],
            },
          ],
        }));
      }
      if (path === '/api/channels/policies') {
        return new Response(JSON.stringify({
          policies: [
            {
              surface: 'slack',
              allowDirectMessages: false,
              allowlistUserIds: ['alice'],
              allowlistGroupIds: ['ops'],
              groupPolicies: [{ id: 'ops-policy' }],
            },
          ],
        }));
      }
      return new Response('not found', { status: 404 });
    }, async () => {
      await runChannels(['accounts'], context);
      await runChannels(['policies'], context);
    });

    const output = printed.join('\n');
    expect(output).toContain('Channel Accounts');
    expect(output).toContain('slack/workspace-1: configured; linked; auth=linked; secret refs=primary:config');
    expect(output).toContain('Channel Policies');
    expect(output).toContain('slack: direct=no; allowlist users=1; groups=1; group policies=1');
    expect(output).not.toContain('xoxb-secret-should-not-print');
    expect(output).not.toContain('route-token-redacted');
  });

  test('prints channel status doctor and setup schema from read-only connected-host routes', async () => {
    const { context, printed } = channelContext({}, writeTokenHome());

    await withMockFetch(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/channels/status') {
        return new Response(JSON.stringify({ channels: [{ surface: 'telegram', enabled: true, ready: false, state: 'needs-target' }] }));
      }
      if (path === '/api/channels/doctor/telegram') {
        return new Response(JSON.stringify({
          surface: 'telegram',
          checks: [{ id: 'configured', status: 'pass' }],
          repairActions: [{ id: 'inspect' }],
        }));
      }
      if (path === '/api/channels/setup/telegram') {
        return new Response(JSON.stringify({
          surface: 'telegram',
          version: 1,
          fields: [{ id: 'mode' }],
          secretTargets: [{ id: 'primary', required: true }],
        }));
      }
      return new Response('not found', { status: 404 });
    }, async () => {
      await runChannels(['status'], context);
      await runChannels(['doctor', 'telegram'], context);
      await runChannels(['setup', 'telegram'], context);
    });

    const output = printed.join('\n');
    expect(output).toContain('Connected Channel Status');
    expect(output).toContain('telegram: enabled; not-ready; state=needs-target');
    expect(output).toContain('Channel Doctor: telegram');
    expect(output).toContain('configured: pass');
    expect(output).toContain('Available repair action ids:');
    expect(output).toContain('Channel Setup Schema: telegram');
    expect(output).toContain('mode');
    expect(output).toContain('primary (required)');
  });

  test('prints channel triage across delivery attempts, surface messages, bindings, and receipts without leaking targets', async () => {
    const deliveryRequests: ChannelDeliveryRequest[] = [];
    const { context, printed } = channelContext({}, writeTokenHome(), deliveryRequests);

    await runChannels([
      'send',
      '--webhook',
      'https://hooks.example.test/services/T000/B000/local-secret-token',
      '--message',
      'Local receipt password=local-secret-value',
      '--yes',
    ], context);
    printed.length = 0;

    await withMockFetch(async (input, init) => {
      expect(String(init?.headers ? (init.headers as Record<string, string>).authorization : '')).toContain('Bearer route-token-redacted');
      const path = new URL(String(input)).pathname;
      if (path === '/api/deliveries') {
        return new Response(JSON.stringify({
          totals: { queued: 1, started: 2, succeeded: 1, failed: 1, deadLettered: 0 },
          attempts: [
            {
              id: 'delivery-1',
              runId: 'run-1',
              jobId: 'job-1',
              status: 'failed',
              target: { kind: 'webhook', address: 'https://hooks.example.test/services/T000/B000/remote-secret-token' },
              error: 'HTTP 500 token=remote-secret-value',
            },
            {
              id: 'delivery-2',
              runId: 'run-2',
              jobId: 'job-2',
              status: 'sent',
              target: { kind: 'surface', surfaceKind: 'slack', routeId: 'ops', label: 'Ops' },
            },
          ],
        }));
      }
      if (path === '/api/control-plane/messages') {
        return new Response(JSON.stringify({
          messages: [{
            id: 'message-1',
            surface: 'slack',
            createdAt: 1,
            level: 'warn',
            title: 'Slack token=message-secret-value',
            body: 'Open https://hooks.example.test/services/T000/B000/message-secret-token',
            routeId: 'route-1',
          }],
        }));
      }
      if (path === '/api/routes/bindings') {
        return new Response(JSON.stringify({
          bindings: [{
            id: 'binding-1',
            kind: 'channel',
            surfaceKind: 'slack',
            surfaceId: 'slack',
            externalId: 'C-remote-secret-channel',
            title: 'Ops',
            lastSeenAt: 1,
          }],
        }));
      }
      return new Response('not found', { status: 404 });
    }, async () => {
      await runChannels(['triage', '5'], context);
    });

    const output = printed.join('\n');
    expect(output).toContain('Channel Triage');
    expect(output).toContain('summary: 1 channel setup blocker(s), 1 delivery attention item(s), 1 retry candidate(s), 1 visible surface message(s), 1 route binding(s).');
    expect(output).toContain('inbox: visible_surface_messages; provider inbox feed not_published_by_current_channel_contract');
    expect(output).toContain('delivery-1: failed webhook https://hooks.example.test/...');
    expect(output).toContain('error=HTTP 500 token=[redacted]');
    expect(output).toContain('slack: warn Slack token=[redacted]');
    expect(output).toContain('binding-1: slack channel external=sha256:');
    expect(output).toContain('Agent Receipts');
    expect(output).toContain('target=webhook https://hooks.example.test/...');
    expect(output).not.toContain('route-token-redacted');
    expect(output).not.toContain('remote-secret-token');
    expect(output).not.toContain('remote-secret-value');
    expect(output).not.toContain('message-secret-token');
    expect(output).not.toContain('message-secret-value');
    expect(output).not.toContain('C-remote-secret-channel');
    expect(output).not.toContain('local-secret-token');
    expect(output).not.toContain('local-secret-value');
  });

  test('connected-host channel routes fail closed when runtime auth is missing', async () => {
    const { context, printed } = channelContext();

    await runChannels(['accounts'], context);

    const output = printed.join('\n');
    expect(output).toContain('Channel accounts: unavailable');
    expect(output).toContain('kind: auth_required');
    expect(output).toContain('connected host: http://127.0.0.1:3421');
    expect(output).toContain('No connected-host operator token found');
    expect(output).not.toContain('runtime operator token');
    expect(output).toContain('no channel send/action route was called');
  });

  test('connected-host channel route failures avoid legacy daemon kinds', async () => {
    const { context, printed } = channelContext({}, writeTokenHome());

    await withMockFetch(async () => new Response(JSON.stringify({ error: 'missing route' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    }), async () => {
      await runChannels(['accounts'], context);
    });

    const output = printed.join('\n');
    expect(output).toContain('Channel accounts: unavailable');
    expect(output).toContain('kind: connected_host_route_unavailable');
    expect(output).toContain('connected host: http://127.0.0.1:3421');
    expect(output).not.toContain('kind: route_unavailable');
    expect(output).not.toContain('daemon_');
  });

  test('sends through the delivery router only after explicit confirmation', async () => {
    const deliveryRequests: ChannelDeliveryRequest[] = [];
    const { context, printed } = channelContext({}, undefined, deliveryRequests);

    await runChannels(['send', '--channel', 'slack:ops:Ops', '--message', 'Review approvals'], context);

    expect(deliveryRequests).toEqual([]);
    expect(printed.join('\n')).toContain('Agent channel delivery preview');
    expect(printed.join('\n')).toContain('without --yes');

    printed.length = 0;
    await runChannels(['send', '--channel', 'slack:ops:Ops', '--title', 'Approvals', '--message', 'Review approvals', '--yes'], context);

    expect(deliveryRequests).toHaveLength(1);
    expect(deliveryRequests[0]?.target).toMatchObject({ kind: 'surface', surfaceKind: 'slack', routeId: 'ops', label: 'Ops' });
    expect(deliveryRequests[0]?.body).toBe('Review approvals');
    expect(deliveryRequests[0]?.title).toBe('Approvals');
    expect(printed.join('\n')).toContain('Agent channel delivery sent');
    expect(printed.join('\n')).toContain('delivery-response-1');
    expect(printed.join('\n')).toContain('receipt channel-delivery-');

    printed.length = 0;
    await runChannels(['deliveries'], context);

    const output = printed.join('\n');
    expect(output).toContain('Channel Delivery Receipts');
    expect(output).toContain('total 1');
    expect(output).toContain('target=slack (route ops, label Ops)');
    expect(output).toContain('response=delivery-response-1');
    expect(output).not.toContain('xoxb-redacted-test-token');
  });

  test('delivery receipt history redacts webhook target values', async () => {
    const deliveryRequests: ChannelDeliveryRequest[] = [];
    const { context, printed } = channelContext({}, undefined, deliveryRequests);

    await runChannels([
      'send',
      '--webhook',
      'https://hooks.example.test/services/T000/B000/redacted-token',
      '--message',
      'Posting api_key=secret-value',
      '--yes',
    ], context);

    const snapshot = readAgentChannelDeliveryReceipts(context.workspace.shellPaths!);
    expect(snapshot.receipts).toHaveLength(1);
    expect(snapshot.receipts[0]?.target.display).toBe('webhook https://hooks.example.test/...');
    expect(snapshot.receipts[0]?.messagePreview).toContain('api_key=[redacted]');
    expect(JSON.stringify(snapshot)).not.toContain('redacted-token');
    expect(JSON.stringify(snapshot)).not.toContain('secret-value');
    expect(printed.join('\n')).toContain('receipt channel-delivery-');
  });
});

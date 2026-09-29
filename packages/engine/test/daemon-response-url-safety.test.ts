// The daemon's Slack response_url posts (agent progress, agent reply, approval
// update) are held to the webhook rules: the host is resolved, every answer is
// checked against the refused ranges, and the request is pinned to a checked
// address. A response URL arrives with an inbound request, so it is not
// trusted by where it says it points.
import { afterEach, describe, expect, test } from 'bun:test';
import { deliverSlackAgentReply, deliverSurfaceProgress } from '../sdk/src/platform/daemon/surface-direct-delivery.ts';
import { deliverSlackApprovalUpdate } from '../sdk/src/platform/daemon/surface-approval-delivery.ts';
import type { HostResolver } from '../sdk/src/platform/tools/fetch/pinned-request.ts';

const DNS: Readonly<Record<string, readonly string[]>> = {
  'metadata.google.internal': ['169.254.169.254'],
  'hooks.corp.example': ['10.1.2.3'],
  'hooks.slack.example': ['203.0.113.50'],
};
const resolveHost: HostResolver = async (host) => {
  const answers = DNS[host];
  if (!answers) throw new Error(`ENOTFOUND ${host}`);
  return answers.map((address) => ({ address, family: 4 }));
};

const sent: Array<{ url: string; host: string | null }> = [];
const originalFetch = globalThis.fetch;
function stubNetwork(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), host: new Headers(init?.headers).get('host') });
    return new Response('ok');
  }) as typeof fetch;
}
afterEach(() => {
  globalThis.fetch = originalFetch;
  sent.length = 0;
});

const directDeps = {
  serviceRegistry: { resolveSecret: async () => null },
  configManager: { get: () => undefined },
  agentManager: { getStatus: () => undefined },
  resolveSlackWebhookUrl: async () => null,
  resolveSlackBotToken: async () => null,
  resolveWebhookDefaultTarget: async () => null,
  signWebhookPayload: () => 'sig',
  resolveHost,
} as never;

const approvalDeps = {
  serviceRegistry: { resolveSecret: async () => null },
  configManager: { get: () => undefined },
  controlPlaneWebUrl: () => undefined,
  resolveSlackWebhookUrl: async () => null,
  resolveSlackBotToken: async () => null,
  signWebhookPayload: () => 'sig',
  resolveHost,
} as never;

const pending = (responseUrl: string) => ({ agentId: 'a1', surfaceKind: 'slack', task: 't', createdAt: 0, responseUrl }) as never;
const approval = { id: 'ap1', status: 'pending', sessionId: 's1', request: { tool: 'exec', analysis: { summary: 'run it' } } } as never;
const binding = (responseUrl: string) => ({ id: 'b1', metadata: { responseUrl } }) as never;

const CASES = [
  ['a metadata name', 'https://metadata.google.internal/hook', /169\.254\.169\.254, a metadata address/],
  ['a private answer', 'https://hooks.corp.example/hook', /10\.1\.2\.3, a private address/],
] as const;

describe('daemon response_url posts', () => {
  for (const [label, url, reason] of CASES) {
    test(`agent progress to ${label} is refused before sending`, async () => {
      stubNetwork();
      await expect(deliverSurfaceProgress(directDeps, pending(url), 'halfway')).rejects.toThrow(reason);
      expect(sent).toEqual([]);
    });

    test(`agent reply to ${label} is refused before sending`, async () => {
      stubNetwork();
      await expect(deliverSlackAgentReply(directDeps, pending(url), 'done')).rejects.toThrow(reason);
      expect(sent).toEqual([]);
    });

    test(`approval update to ${label} is not sent`, async () => {
      stubNetwork();
      await deliverSlackApprovalUpdate(approvalDeps, approval, binding(url));
      expect(sent).toEqual([]);
    });
  }

  test('a public answer is sent pinned to the checked address on each path', async () => {
    stubNetwork();
    await deliverSurfaceProgress(directDeps, pending('https://hooks.slack.example/p'), 'halfway');
    await deliverSlackAgentReply(directDeps, pending('https://hooks.slack.example/r'), 'done');
    await deliverSlackApprovalUpdate(approvalDeps, approval, binding('https://hooks.slack.example/a'));
    expect(sent).toEqual([
      { url: 'https://203.0.113.50/p', host: 'hooks.slack.example' },
      { url: 'https://203.0.113.50/r', host: 'hooks.slack.example' },
      { url: 'https://203.0.113.50/a', host: 'hooks.slack.example' },
    ]);
  });
});

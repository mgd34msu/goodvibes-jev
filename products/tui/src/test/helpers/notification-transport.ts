import { afterEach, spyOn } from 'bun:test';
import { WebhookNotifier } from '@goodvibes-jev/engine/sdk/platform/integrations';

// Real delivery classes; the only substituted boundary is HTTP. A missing
// synthetic route fails closed, so these tests cannot use a real endpoint.
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | undefined;
const routes = new Map<string, { sent: string[]; failure?: Error }>();
afterEach(() => { fetchSpy?.mockRestore(); fetchSpy = undefined; routes.clear(); });

export function makeTestWebhookNotifier(
  urls: string[] = ['https://example.com/tui-notification'],
  options: { metadataOnly?: () => unknown; failure?: Error; sent?: string[] } = {},
) {
  const sent = options.sent ?? [];
  for (const url of urls) routes.set(url, { sent, ...(options.failure ? { failure: options.failure } : {}) });
  fetchSpy ??= spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const route = routes.get(String(input));
    if (!route) throw new Error('Unexpected synthetic notification destination');
    if (route.failure) throw route.failure;
    route.sent.push(String(init?.body));
    return new Response('ok');
  }, { preconnect() {} }));
  const notifier = Object.assign(new WebhookNotifier(urls, { force: true, metadataOnly: options.metadataOnly ?? (() => false) }), {
    _sent: sent, _sentMessages: sent,
  });
  spyOn(notifier, 'sendNotification');
  return notifier;
}

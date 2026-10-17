import { afterEach, spyOn } from 'bun:test';
import { WebhookNotifier } from '@goodvibes-jev/engine/sdk/platform/integrations';
import * as webhookHttp from '@goodvibes-jev/engine/sdk/platform/utils';

// Real delivery classes; the only substituted boundary is HTTP. A missing
// synthetic route fails closed, so these tests cannot use a real endpoint.
let fetchSpy: ReturnType<typeof spyOn<typeof webhookHttp, 'postToPublicWebhook'>> | undefined;
const routes = new Map<string, { sent: string[]; failure?: Error }>();
const pending = new Set<Promise<unknown>>();
export async function settleTestWebhookNotifications(): Promise<void> {
  await Promise.resolve();
  while (pending.size) await Promise.allSettled([...pending]);
}
afterEach(async () => {
  await settleTestWebhookNotifications();
  fetchSpy?.mockRestore(); fetchSpy = undefined; routes.clear();
});

export function makeTestWebhookNotifier(
  urls: string[] = ['https://example.com/tui-notification'],
  options: { metadataOnly?: () => unknown; failure?: Error; sent?: string[] } = {},
) {
  const sent = options.sent ?? [];
  for (const url of urls) routes.set(url, { sent, ...(options.failure ? { failure: options.failure } : {}) });
  fetchSpy ??= spyOn(webhookHttp, 'postToPublicWebhook').mockImplementation(async (url, init) => {
    const route = routes.get(url);
    if (!route) throw new Error('Unexpected synthetic notification destination');
    if (route.failure) throw route.failure;
    route.sent.push(String(init.body));
    return new Response('ok');
  });
  const notifier = Object.assign(new WebhookNotifier(urls, { force: true, metadataOnly: options.metadataOnly ?? (() => false) }), {
    _sent: sent, _sentMessages: sent,
  });
  const send = notifier.sendNotification.bind(notifier);
  spyOn(notifier, 'sendNotification').mockImplementation(delivery => {
    const request = send(delivery);
    pending.add(request);
    void request.then(() => pending.delete(request), () => pending.delete(request));
    return request;
  });
  return notifier;
}

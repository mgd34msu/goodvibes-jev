import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { createContext, runInContext } from 'node:vm';
import { renderControlPlaneGatewayWebUi } from '../sdk/src/platform/control-plane/gateway-web-ui.js';

test('the rendered page uses browser fetch for its stream and mutations', async () => {
  const requests: { url: string; method: string }[] = [];
  const dom = new JSDOM(await renderControlPlaneGatewayWebUi().text(), { url: 'http://localhost' });
  const context = createContext({
    document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    AbortController, TextDecoder, URLSearchParams, window: { location: dom.window.location },
    fetch: async (url: string, options?: RequestInit) => {
      requests.push({ url, method: options?.method ?? 'GET' });
      return Response.json({});
    },
  });
  try {
    runInContext(dom.window.document.querySelector('script')!.textContent!, context);
    runInContext("state.token = 'synthetic'; connectStream(); state.token = ''", context);
    await runInContext("postJson('/api/service/start', {})", context);
    expect(requests.some(r => r.url.startsWith('/api/control-plane/events?'))).toBe(true);
    expect(requests).toContainEqual({ url: '/api/service/start', method: 'POST' });
  } finally { dom.window.close(); }
});

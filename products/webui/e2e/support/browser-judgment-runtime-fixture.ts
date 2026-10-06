/** Genuine runtime wires over a synthetic shell. No browser request reaches a live daemon. */
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type { Page, Route } from '@playwright/test';
import { parseBrowserJudgmentRequest, type BrowserJudgmentRequest } from '@goodvibes-jev/engine/daemon-sdk';
import { installMockDaemon } from './mock-daemon';

interface Wire {
  path: string;
  method: string;
  requestBody?: unknown;
  status: number;
  cacheControl: string | null;
  /** Exact Response.text() from the capture test. */
  body: string;
}
interface JudgmentWire extends Wire { requestBody: BrowserJudgmentRequest }
export interface BrowserJudgmentRuntimeCapture {
  source: string;
  title: string;
  sessionId: string;
  listBefore: Wire;
  session: Wire;
  library: JudgmentWire;
  chat: JudgmentWire;
  held: JudgmentWire;
  close: Wire;
  errorSettled: JudgmentWire;
  errorHeld: JudgmentWire;
  deleted: Wire;
  listAfter: Wire;
}

export function loadBrowserJudgmentRuntimeCapture(): BrowserJudgmentRuntimeCapture {
  const capture = JSON.parse(readFileSync(new URL('./fixtures/browser-judgment-runtime/runtime.json', import.meta.url), 'utf8')) as BrowserJudgmentRuntimeCapture;
  for (const wire of [capture.library, capture.chat, capture.held, capture.errorSettled, capture.errorHeld]) {
    const request = parseBrowserJudgmentRequest(wire.requestBody);
    // The strict parser returns frozen null-prototype objects. Normalize both
    // sides with that same parser before comparing browser/capture identities.
    wire.requestBody = request;
    const result = JSON.parse(wire.body) as { requestId: string; battery: string; evidence: { decisionId: string }[] };
    if (wire.status !== 200 || wire.method !== 'POST' || wire.path !== '/api/judgment/batteries/run'
      || result.requestId !== request.requestId || result.battery !== request.battery)
      throw new Error('Captured judgment is not bound to its genuine request');
    const count = request.battery === 'webui.palette.command-rank' ? request.input.candidates.length : 1;
    if (result.evidence.length !== count || new Set(result.evidence.map(item => item.decisionId)).size !== count)
      throw new Error('Incomplete runtime decision evidence');
  }
  const errorRef = (JSON.parse(capture.close.body) as { errorRef: string }).errorRef;
  for (const wire of [capture.errorSettled, capture.errorHeld]) {
    if (wire.requestBody.battery !== 'webui.errors.daemon-refusal' || wire.requestBody.input.errorRef !== errorRef)
      throw new Error('Refusal capture is not bound to its canonical failure');
  }
  if (capture.close.status !== 404 || capture.close.cacheControl !== 'no-store'
    || capture.close.path !== '/api/control-plane/methods/companion.chat.sessions.close/invoke')
    throw new Error('Missing canonical companion close failure');
  return capture;
}

/** Only correlation changes. All other response bytes, especially evidence, stay intact. */
export function correlateRuntimeReading(wire: JudgmentWire, request: BrowserJudgmentRequest): string {
  if (!isDeepStrictEqual({ ...parseBrowserJudgmentRequest(request), requestId: wire.requestBody.requestId },
    { ...parseBrowserJudgmentRequest(wire.requestBody) }))
    throw new Error(`Browser request differs from runtime capture: ${JSON.stringify(request)}`);
  const original = `"requestId":${JSON.stringify(wire.requestBody.requestId)}`;
  if (wire.body.split(original).length !== 2) throw new Error('Ambiguous captured correlation');
  return wire.body.replace(original, `"requestId":${JSON.stringify(request.requestId)}`);
}

export async function installBrowserJudgmentRuntimeDaemon(page: Page, options: {
  refusal?: 'settled' | 'held' | 'missing-reference';
  holdRefusal?: boolean;
  holdFirstPalette?: boolean;
} = {}) {
  await installMockDaemon(page);
  const capture = loadBrowserJudgmentRuntimeCapture();
  const requests: { method: string; path: string; body: unknown; authorization?: string }[] = [];
  const judgments: BrowserJudgmentRequest[] = [];
  const pending: (() => Promise<void>)[] = [];
  const replies: string[] = [];
  let deleted = false;
  let paletteHeld = false;
  const reply = (route: Route, wire: Wire, body = wire.body) => route.fulfill({ status: wire.status, contentType: 'application/json', body,
    ...(wire.cacheControl ? { headers: { 'cache-control': wire.cacheControl } } : {}) });
  await page.route('**/api/companion/chat/sessions**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    requests.push({ method: request.method(), path, body: request.postData() ? request.postDataJSON() : undefined,
      authorization: request.headers().authorization });
    if (request.method() === 'GET' && path === '/api/companion/chat/sessions') return reply(route, deleted ? capture.listAfter : capture.listBefore);
    if (request.method() === 'GET' && path === `/api/companion/chat/sessions/${capture.sessionId}`) return reply(route, capture.session);
    if (request.method() === 'POST' && path === `/api/companion/chat/sessions/${capture.sessionId}/close`) {
      // Adversarial removal only: this negative case is intentionally not a genuine wire.
      if (options.refusal === 'missing-reference') {
        const body = JSON.parse(capture.close.body) as { errorRef?: string };
        delete body.errorRef;
        return reply(route, capture.close, JSON.stringify(body));
      }
      return reply(route, capture.close);
    }
    if (request.method() === 'DELETE' && path === `/api/companion/chat/sessions/${capture.sessionId}`) {
      deleted = true;
      return reply(route, capture.deleted);
    }
    return route.fallback();
  });
  await page.route('**/api/judgment/batteries/run', async route => {
    const request = parseBrowserJudgmentRequest(route.request().postDataJSON());
    judgments.push(request);
    requests.push({ method: route.request().method(), path: '/api/judgment/batteries/run', body: request,
      authorization: route.request().headers().authorization });
    let wire: JudgmentWire;
    let hold: boolean;
    if (request.battery === 'webui.errors.daemon-refusal') {
      wire = options.refusal === 'held' ? capture.errorHeld : capture.errorSettled;
      hold = options.holdRefusal === true;
    } else if (request.battery === 'webui.palette.command-rank') {
      const found = [capture.library, capture.chat, capture.held].find(item => item.requestBody.battery === request.battery
        && isDeepStrictEqual(item.requestBody.input, request.input));
      if (!found) throw new Error(`No runtime capture for browser palette: ${JSON.stringify(request.input)}`);
      wire = found;
      hold = options.holdFirstPalette === true && !paletteHeld;
      paletteHeld = true;
    } else throw new Error(`Uncaptured browser battery: ${request.battery}`);
    const body = correlateRuntimeReading(wire, request);
    const respond = async () => { await reply(route, wire, body); replies.push(body); };
    if (hold) pending.push(respond);
    else await respond();
  });
  return { capture, requests, judgments, replies,
    get writes() { return requests.filter(request => request.method === 'DELETE' || request.path.endsWith('/close')); },
    get pendingCount() { return pending.length; },
    async release() { await Promise.all(pending.splice(0).map(respond => respond().catch(() => undefined))); },
  };
}

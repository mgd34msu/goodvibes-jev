import { BROWSER_JUDGMENT_LIMITS, buildErrorResponseBody,
  type AuthenticatedPrincipal, type BrowserJudgmentCapability } from '@goodvibes-jev/engine/daemon-sdk';
import type { GatewayMethodCatalog, GatewayMethodDescriptor } from '../../control-plane/method-catalog.js';

/** Match protocol paths against host-owned method descriptors, never error prose. */
export function browserJudgmentErrorMethod(request: Request, methods: GatewayMethodCatalog): GatewayMethodDescriptor | undefined {
  const path = new URL(request.url).pathname;
  const invoke = /^\/api\/(?:control-plane\/methods|control\/gateway-methods)\/([^/]+)\/invoke$/.exec(path);
  if (invoke && request.method === 'POST') {
    try { return methods.get(decodeURIComponent(invoke[1]!)) ?? undefined; } catch { return undefined; }
  }
  const parts = path.split('/');
  const matches = methods.list().filter((method) => {
    if (method.http?.method !== request.method) return false;
    const template = method.http.path.split('/');
    return template.length === parts.length && template.every((segment, index) =>
      /^\{[^{}]+\}$/.test(segment) ? !!parts[index] : segment === parts[index]);
  });
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Capture the real daemon response before it leaves the authenticated route.
 * This owns no request-body staging API. Bounded reads happen on the local
 * response; capture failure leaves the original error response unchanged.
 */
export async function attachBrowserJudgmentError(request: Request, response: Response, input: {
  readonly service: BrowserJudgmentCapability | undefined;
  readonly methods: GatewayMethodCatalog;
  readonly method: GatewayMethodDescriptor | undefined;
  readonly principal: AuthenticatedPrincipal | null;
  readonly currentPrincipal: () => AuthenticatedPrincipal | null;
}): Promise<Response> {
  if (!input.service?.issueErrorReference || !input.principal || response.status < 400 || response.status === 401
    || request.signal.aborted || !response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return response;
  const method = input.method;
  if (!method) return response;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel = () => {};
  try {
    reader = response.clone().body?.getReader();
    if (!reader) return response;
    const interrupted = new Promise<never>((_, reject) => {
      cancel = () => { reject(new Error('Capture cancelled')); void reader?.cancel().catch(() => {}); };
      timer = setTimeout(cancel, BROWSER_JUDGMENT_LIMITS.bodyMs);
      request.signal.addEventListener('abort', cancel, { once: true });
      if (request.signal.aborted) cancel();
    });
    let bytes = 0; let text = ''; const decoder = new TextDecoder('utf-8', { fatal: true });
    for (;;) {
      const chunk = await Promise.race([reader.read(), interrupted]);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > BROWSER_JUDGMENT_LIMITS.bodyBytes) return response;
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    const principal = input.currentPrincipal();
    if (!principal || principal.principalId !== input.principal.principalId || principal.principalKind !== input.principal.principalKind || request.signal.aborted
      || input.methods.get(method.id) !== method) return response;
    const body: unknown = JSON.parse(text);
    const errorRef = input.service.issueErrorReference({ principal, methodId: method.id, status: response.status, body });
    if (errorRef === undefined) return response;
    const headers = new Headers(response.headers);
    headers.delete('content-length'); headers.set('Cache-Control', 'no-store');
    return Response.json(buildErrorResponseBody(body, { status: response.status, isPrivileged: true, errorRef }),
      { status: response.status, headers });
  } catch { return response; }
  finally { clearTimeout(timer); request.signal.removeEventListener('abort', cancel); void reader?.cancel().catch(() => {}); }
}

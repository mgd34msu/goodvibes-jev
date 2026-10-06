import type { AuthenticatedPrincipal } from './http-policy.js';
import { missingScopes } from './route-helpers.js';
import {
  BROWSER_JUDGMENT_PATH, BROWSER_JUDGMENT_LIMITS as LIMIT,
  BrowserJudgmentError, browserJudgmentRefusal,
} from './browser-judgment-contract.js';
import { parseBrowserJudgmentRequest } from './browser-judgment-validation.js';

export interface BrowserJudgmentCapability {
  execute(input: unknown, principal: AuthenticatedPrincipal, signal: AbortSignal, currentPrincipal: () => AuthenticatedPrincipal): Promise<object>;
  /** Server-only canonical failure producer. Never populated from request JSON. */
  issueErrorReference?(input: BrowserJudgmentErrorSource): string | undefined;
  /** Binds the actual host chat store; the returned release fences that store's lifetime. */
  bindChatSessions?(source: BrowserJudgmentChatSessions): () => void;
}
export interface BrowserJudgmentChatSessions {
  getSession(id: string): { readonly id: string; readonly title: string; readonly createdAt: number; readonly updatedAt: number } | null;
}
export interface BrowserJudgmentErrorSource {
  readonly principal: AuthenticatedPrincipal;
  readonly methodId: string;
  readonly status: number;
  readonly body: unknown;
}
export interface BrowserJudgmentHttpContext {
  readonly authenticate: (req: Request) => AuthenticatedPrincipal | null;
  /** Server-derived listener/public origin, never raw Host or forwarded headers. */
  readonly sameOrigins: () => readonly string[];
  readonly cors: () => { readonly enabled: boolean; readonly allowedOrigins: readonly string[] };
  /** Optional borrowed capability. Absence is a real unavailable response. */
  readonly service?: BrowserJudgmentCapability | undefined;
}
export interface BrowserJudgmentRouteHandlers {
  readonly postBrowserJudgment?: ((req: Request) => Response | Promise<Response>) | undefined;
}
function response(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
function refusal(error: unknown): Response {
  const result = browserJudgmentRefusal(error); return response(result.body, result.status);
}

/** The body deadline bounds reads AND cancellation; oversized bodies are never drained without a bound. */
async function readBody(req: Request): Promise<unknown> {
  if (req.signal.aborted) throw new BrowserJudgmentError('JUDGMENT_ABORTED');
  const length = req.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > LIMIT.bodyBytes)) {
    void req.body?.cancel().catch(() => {}); throw new BrowserJudgmentError('JUDGMENT_INPUT_TOO_LARGE');
  }
  if (!req.body) throw new BrowserJudgmentError('JUDGMENT_INVALID_INPUT');
  const reader = req.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: (reason: BrowserJudgmentError) => void = () => {};
  const cancel = () => {
    const error = new BrowserJudgmentError('JUDGMENT_ABORTED');
    rejectAbort(error); void reader.cancel().catch(() => {});
  };
  const interrupted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
    timer = setTimeout(() => { reject(new BrowserJudgmentError('JUDGMENT_DEADLINE')); void reader.cancel().catch(() => {}); }, LIMIT.bodyMs);
  });
  req.signal.addEventListener('abort', cancel, { once: true });
  if (req.signal.aborted) cancel();
  try {
    let bytes = 0; let text = '';
    for (;;) {
      const chunk = await Promise.race([reader.read(), interrupted]);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > LIMIT.bodyBytes) { void reader.cancel().catch(() => {}); throw new BrowserJudgmentError('JUDGMENT_INPUT_TOO_LARGE'); }
      text += decoder.decode(chunk.value, { stream: true });
    }
    if (req.signal.aborted) throw new BrowserJudgmentError('JUDGMENT_ABORTED');
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof BrowserJudgmentError) throw error;
    throw new BrowserJudgmentError('JUDGMENT_INVALID_INPUT');
  } finally {
    clearTimeout(timer); req.signal.removeEventListener('abort', cancel); reader.releaseLock();
  }
}

export function createBrowserJudgmentHttpHandler(context: BrowserJudgmentHttpContext): (req: Request) => Promise<Response> {
  return async (req) => {
    try {
      const principal = context.authenticate(req);
      if (!principal) throw new BrowserJudgmentError('JUDGMENT_AUTH_REQUIRED');
      if (!principal.admin && missingScopes(principal.scopes, ['write:judgment']).length) throw new BrowserJudgmentError('JUDGMENT_ACCESS_DENIED');
      const currentPrincipal = (): AuthenticatedPrincipal => {
        const current = context.authenticate(req);
        if (!current || current.principalId !== principal.principalId || current.principalKind !== principal.principalKind
          || (!current.admin && missingScopes(current.scopes, ['write:judgment']).length)) throw new BrowserJudgmentError('JUDGMENT_AUTH_REQUIRED');
        return current;
      };
      const origin = req.headers.get('origin');
      const cors = context.cors();
      if (origin === null) {
        if (!/^Bearer\s+\S+$/i.test(req.headers.get('authorization') ?? '')) throw new BrowserJudgmentError('JUDGMENT_ORIGIN_DENIED');
      } else if (origin === 'null' || (!context.sameOrigins().includes(origin) && !(cors.enabled && cors.allowedOrigins.includes(origin)))) {
        throw new BrowserJudgmentError('JUDGMENT_ORIGIN_DENIED');
      }
      if (req.method !== 'POST' || new URL(req.url).search) throw new BrowserJudgmentError('JUDGMENT_INVALID_INPUT');
      if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
        || !['', 'identity'].includes(req.headers.get('content-encoding') ?? '')) throw new BrowserJudgmentError('JUDGMENT_CONTENT_TYPE_UNSUPPORTED');
      const input = parseBrowserJudgmentRequest(await readBody(req));
      const admittedPrincipal = currentPrincipal();
      if (!context.service) throw new BrowserJudgmentError('JUDGMENT_UNAVAILABLE');
      const result = await context.service.execute(input, admittedPrincipal, req.signal, currentPrincipal);
      currentPrincipal();
      if (req.signal.aborted) throw new BrowserJudgmentError('JUDGMENT_ABORTED');
      return response(result);
    } catch (error) { return refusal(error); }
  };
}

export function dispatchBrowserJudgmentRoutes(req: Request, handlers: BrowserJudgmentRouteHandlers): Response | Promise<Response> | null {
  if (new URL(req.url).pathname !== BROWSER_JUDGMENT_PATH) return null;
  if (req.method !== 'POST') return refusal(new BrowserJudgmentError('JUDGMENT_INVALID_INPUT'));
  return handlers.postBrowserJudgment?.(req) ?? refusal(new BrowserJudgmentError('JUDGMENT_UNAVAILABLE'));
}

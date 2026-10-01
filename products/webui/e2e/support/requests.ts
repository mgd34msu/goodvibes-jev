import type { Page, Request } from '@playwright/test';

/** One request the page sent toward the daemon, as the page sent it. */
export interface RecordedRequest {
  method: string;
  path: string;
  search: string;
  /** Parsed JSON body when the request carried one, else the raw text, else undefined. */
  body: unknown;
  /** For POST /api/control-plane/methods/{id}/invoke: the method id. */
  methodId?: string;
}

/** The log a spec reads to prove what the app actually asked the daemon to do. */
export interface RequestLog {
  /** Every daemon-bound request, in the order the page sent it. Live array. */
  requests: RecordedRequest[];
  /**
   * The input (`body.body` of the invoke envelope, or the whole body when there is
   * no envelope) of every control-plane invoke of `methodId`, in order.
   */
  invocations: (methodId: string) => unknown[];
}

const DAEMON_PATH = /^\/(api\/|config(\/|$)|status$|task$)/;
const INVOKE_PATH = /^\/api\/control-plane\/methods\/([^/]+)\/invoke$/;

function bodyOf(request: Request): unknown {
  const raw = request.postData();
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/**
 * Record every daemon-bound request the page sends. A request listener, not a
 * route, so it sees each request once no matter which route handler answers it.
 */
export function recordRequests(page: Page): RequestLog {
  const requests: RecordedRequest[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!DAEMON_PATH.test(url.pathname)) return;
    const invoke = INVOKE_PATH.exec(url.pathname);
    requests.push({
      method: request.method(),
      path: url.pathname,
      search: url.search,
      body: bodyOf(request),
      ...(invoke && request.method() === 'POST' ? { methodId: decodeURIComponent(invoke[1]) } : {}),
    });
  });
  return {
    requests,
    invocations: (methodId) => requests
      .filter((r) => r.methodId === methodId)
      .map((r) => {
        const body = r.body;
        if (body && typeof body === 'object' && 'body' in body) return (body as { body: unknown }).body;
        return body;
      }),
  };
}

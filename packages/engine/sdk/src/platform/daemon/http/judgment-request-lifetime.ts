import { BROWSER_JUDGMENT_PATH } from '@goodvibes-jev/engine/daemon-sdk';

/** Preserve caller-owned waits without changing other HTTP request budgets. */
export function configureJudgmentRequestLifetime(request: Request, server: { timeout?(request: Request, seconds: number): void }): void {
  const url = new URL(request.url);
  if (request.method === 'POST' && url.pathname === BROWSER_JUDGMENT_PATH && url.search === '') {
    // The route still bounds body intake and concurrent admission. Once
    // admitted, Jev availability belongs to the shared retry port and the
    // request's cancellation signal, rather than Bun's idle socket timer.
    server.timeout?.(request, 0);
  }
}

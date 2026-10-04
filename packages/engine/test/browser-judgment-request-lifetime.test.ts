import { describe, expect, test } from 'bun:test';
import { BROWSER_JUDGMENT_PATH } from '../daemon-sdk/src/browser-judgment-contract.ts';
import { configureJudgmentRequestLifetime } from '../sdk/src/platform/daemon/http/judgment-request-lifetime.ts';

describe('browser judgment HTTP request lifetime', () => {
  test('only the exact POST route opts out of the server idle timeout', () => {
    const calls: { request: Request; seconds: number }[] = [];
    const server = { timeout(request: Request, seconds: number) { calls.push({ request, seconds }); } };
    const request = new Request(`http://localhost${BROWSER_JUDGMENT_PATH}`, { method: 'POST' });
    configureJudgmentRequestLifetime(request, server);
    for (const [path, method] of [[BROWSER_JUDGMENT_PATH, 'GET'], [`${BROWSER_JUDGMENT_PATH}?extra=1`, 'POST'], ['/api/other', 'POST']] as const) {
      configureJudgmentRequestLifetime(new Request(`http://localhost${path}`, { method }), server);
    }
    expect(calls).toEqual([{ request, seconds: 0 }]);
    expect(() => configureJudgmentRequestLifetime(request, {})).not.toThrow();
  });

  test('a live server keeps an admitted wait open beyond its normal idle budget', async () => {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 1,
      async fetch(request, active) {
        configureJudgmentRequestLifetime(request, active);
        await Bun.sleep(1_200);
        return Response.json({ fixture: 'still waiting for Jev' });
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}${BROWSER_JUDGMENT_PATH}`, { method: 'POST' });
      expect(response.status).toBe(200); expect(await response.json()).toEqual({ fixture: 'still waiting for Jev' });
    } finally { server.stop(true); }
  });
});

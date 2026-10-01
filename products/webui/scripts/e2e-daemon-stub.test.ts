import { describe, expect, test } from 'bun:test';
import { stubResponse } from './e2e-daemon-stub';

describe('synthetic browser daemon fallback', () => {
  test('only its dedicated readiness request reports success', async () => {
    const response = stubResponse(new Request('http://127.0.0.1:59991/__stub-alive'));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
    expect(stubResponse(new Request('http://127.0.0.1:59991/__stub-alive', { method: 'POST' })).status).toBe(503);
  });

  test.each([
    ['GET', '/api/status'],
    ['POST', '/api/sessions/session-fixture/messages'],
    ['POST', '/api/payments/cards'],
    ['DELETE', '/api/pairing/tokens/token-fixture'],
  ])('%s %s cannot succeed outside the in-page synthetic fixture', async (method, path) => {
    const response = stubResponse(new Request(`http://127.0.0.1:59991${path}`, { method }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'E2E_STUB' });
  });
});

import { expect, test } from 'bun:test';
import { createOAuthLocalListener } from '../sdk/src/platform/config/oauth-local-listener.js';

test('invalid OAuth callbacks cannot retire the pending owner flow or inject HTML', async () => {
  const listener = await createOAuthLocalListener({ expectedState: 'owner-state', timeoutMs: 3000 });
  try {
    const invalid = await fetch(listener.redirectUri + '?state=wrong&error=%3Cscript%3Ebad%3C%2Fscript%3E');
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain('<script>');
    const malformed = await fetch(listener.redirectUri + '?state=owner-state');
    expect(malformed.status).toBe(400);
    const valid = await fetch(listener.redirectUri + '?state=owner-state&code=accepted');
    expect(valid.status).toBe(200);
    expect(await listener.waitForCode()).toEqual({ code: 'accepted' });
  } finally { listener.close(); }
});

test('bound provider errors are escaped and settle the operation', async () => {
  const listener = await createOAuthLocalListener({ expectedState: 'owner', timeoutMs: 3000 });
  try {
    const waiting = listener.waitForCode().catch(error => error);
    const response = await fetch(listener.redirectUri + '?state=owner&error=%3Cscript%3Ebad%3C%2Fscript%3E');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await response.text()).toContain('&lt;script&gt;');
    expect(await waiting).toBeInstanceOf(Error);
  } finally { listener.close(); }
});

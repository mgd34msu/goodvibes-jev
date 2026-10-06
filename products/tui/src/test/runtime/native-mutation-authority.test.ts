import { expect, test } from 'bun:test';
import { createNativeWorkSubmissionBinding } from '../../runtime/native-work-submission-host.ts';
import { createNativeConversationIntakeBinding } from '../../runtime/native-conversation-intake-host.ts';

for (const mutation of ['read-only', 'shared-token', 'user', 'not-admin', 'unauthenticated'] as const) test(`private credential does not bypass native mutation authority: ${mutation}`, async () => {
  const calls: string[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    calls.push(new URL(request.url).pathname);
    return Response.json({ authenticated: mutation !== 'unauthenticated', authMode: 'shared-token', tokenPresent: true, authorizationHeaderPresent: true, sessionCookiePresent: false,
      principalId: mutation === 'shared-token' ? 'shared-token' : 'paired-principal', principalKind: mutation === 'user' ? 'user' : 'token', admin: mutation !== 'not-admin',
      scopes: mutation === 'read-only' ? ['read:work-ledger'] : ['read:work-ledger', 'write:work-ledger'], roles: [] });
  } });
  const host = { baseUrl: `http://127.0.0.1:${server.port}`, token: 'private-token', workspace: '/unused' };
  const submission = createNativeWorkSubmissionBinding(host, 'project'); const intake = createNativeConversationIntakeBinding(host, 'project');
  try {
    await expect(submission.readPrincipal(new AbortController().signal)).rejects.toThrow();
    await expect(intake.readPrincipal(new AbortController().signal)).rejects.toThrow();
    expect(calls).toEqual(['/api/control-plane/auth', '/api/control-plane/auth']);
  } finally { submission.dispose(); intake.dispose(); server.stop(true); }
});

test('captured submission binding checks selection before principal, snapshot, lookup or submit', async () => {
  let requests = 0; let current = true;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { requests++; return new Response('Unexpected stale bearer'); } });
  const binding = createNativeWorkSubmissionBinding({ baseUrl: `http://127.0.0.1:${server.port}`, token: 'private-token', workspace: '/unused' }, 'project', () => current);
  try {
    current = false;
    await expect(binding.readPrincipal(new AbortController().signal)).rejects.toThrow();
    await expect(binding.readSnapshot()).rejects.toThrow();
    await expect(binding.client.get({ requestId: 'request' })).rejects.toThrow();
    await expect(binding.client.submit({ requestId: 'request', inputId: 'input', expectedRevision: 0, goal: 'Original', criteria: ['Exact'] })).rejects.toThrow();
    expect(requests).toBe(0);
  } finally { binding.dispose(); server.stop(true); }
});

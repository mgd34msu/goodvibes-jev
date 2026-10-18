import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { diagnoseInvalidGrant, type GrantDiagnosisInput } from '../sdk/src/platform/google/grant-diagnosis.ts';
import { openGoogleConnection } from '../sdk/src/platform/google/connection.ts';
import { GOOGLE_CONFIG_KEYS } from '../sdk/src/platform/google/setup-plan.ts';
import { GoogleApiClient } from '../sdk/src/platform/google/api-client.ts';
import { GoogleTokenManager } from '../sdk/src/platform/google/token-manager.ts';
import { proveGoogleConnection } from '../sdk/src/platform/google/connection-proof.ts';
import { readGoogleTwoStepState } from '../sdk/src/platform/google/browser-elements.ts';
import type { GoogleBrowserPort } from '../sdk/src/platform/google/types.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
const grant: GrantDiagnosisInput = { googleError: 'The client account was suspended by the organization administrator.', intendedAccount: null, signedInAccount: null, publishingStatus: 'testing', credentialOrigin: null };
function tokenManager() {
  return new GoogleTokenManager({ clientId: 'synthetic-client', clientSecret: 'synthetic-secret', refreshToken: 'synthetic-refresh', accessToken: 'synthetic-access', expiresAtMs: Date.now() + 3600000, scopes: [], tokenUri: 'https://oauth2.googleapis.com/token', origin: 'secret-store', location: 'synthetic-store' }, {
    refresh: async () => { throw new Error('unexpected refresh'); } });
}
function client(payload: unknown, status = 403) {
  return new GoogleApiClient(tokenManager(), { fetch: async () => new Response(JSON.stringify(payload), { status }) });
}
function page(text: () => string): GoogleBrowserPort {
  return { navigate: async url => ({ url, title: 'Synthetic' }), currentUrl: async () => 'https://myaccount.google.com/signinoptions/two-step-verification',
    snapshot: async () => [], readText: async () => text(), click: async () => { throw new Error('unexpected click'); }, type: async () => { throw new Error('unexpected type'); } };
}

test('a client word and Testing status do not establish a mismatched client or expired token', async () => {
  const fake = fakePort(() => noulAnswer(0.01)); installJudgmentPort(fake.port);
  const result = await diagnoseInvalidGrant(grant);
  expect(result.cause).toBe('unknown');
  expect(result.problem).not.toContain('almost certainly');
  expect(fake.requests).toHaveLength(1);
  expect(fake.requests[0]!.state).toEqual({ ...grant });
});

test('known account mismatch stays local; an unavailable or weak diagnosis stays unknown', async () => {
  const fake = fakePort(() => noulAnswer(0.55)); installJudgmentPort(fake.port);
  expect((await diagnoseInvalidGrant({ ...grant, intendedAccount: 'a@example.com', signedInAccount: 'b@example.com' })).cause).toBe('account-mismatch');
  expect(fake.requests).toHaveLength(0);
  expect((await diagnoseInvalidGrant(grant)).cause).toBe('unknown');
  installJudgmentPort(undefined);
  expect((await diagnoseInvalidGrant(grant)).cause).toBe('unknown');
});

test('the API client uses exact structured reasons and carries them into connection proof without Jev', async () => {
  const fake = fakePort(() => { throw new Error('unexpected reading'); }); installJudgmentPort(fake.port);
  const api = client({ error: { details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', domain: 'googleapis.com', reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } });
  const proof = await proveGoogleConnection(api);
  expect(proof.calendar.problem).toContain('Calendar');
  expect(proof.calendar.fix).toContain('mail and calendar together');
  expect(fake.requests).toHaveLength(0);
  const disabled = await client({ error: { details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', domain: 'googleapis.com', reason: 'SERVICE_DISABLED' }] } }).getProfile();
  expect(disabled.ok ? null : disabled.reason).toBe('api-disabled');
});

test('ambiguous API prose uses one complete response reading rather than scope/disabled keywords', async () => {
  const payload = { error: { message: 'Access disabled by organization policy. OAuth scopes are sufficient.', context: 'Administrator denied this account.' } };
  const fake = fakePort(() => noulAnswer(0.01)); installJudgmentPort(fake.port);
  const result = await client(payload).getProfile();
  expect(result.ok ? null : result.reason).toBe('unclassified');
  expect(fake.requests).toHaveLength(1);
  expect(fake.requests[0]!.state).toEqual(payload);
});

test('known token echoes are removed and complete protected error fields prevent a reading', async () => {
  const fake = fakePort(() => noulAnswer(0.01)); installJudgmentPort(fake.port);
  const result = await client({ error: { message: 'Denied synthetic-access', detail: { client_secret: 'GOCSPX-never-send' } } }).getProfile();
  expect(result.ok).toBe(false);
  expect(fake.requests).toHaveLength(0);
  expect(JSON.stringify(result)).not.toContain('GOCSPX');
  await client({ error: { message: 'Denied synthetic-access' } }).getProfile();
  expect(JSON.stringify(fake.requests)).not.toContain('synthetic-access');
});

test('rate limiting stays local and missing Jev leaves an ambiguous API refusal unclassified', async () => {
  expect((await client({}, 429).getProfile()).ok).toBe(false);
  const result = await client({ error: { message: 'insufficient scopes' } }).getProfile();
  expect(result.ok ? null : result.reason).toBe('unclassified');
});

test('2-Step state reads localized text beyond the old 4000 character cut', async () => {
  const text = 'Help. '.repeat(900) + 'Bestätigung in zwei Schritten: Aktiviert.';
  const fake = fakePort(name => noulAnswer(name === 'enabled' ? 0.99 : 0.01)); installJudgmentPort(fake.port);
  expect(await readGoogleTwoStepState(page(() => text))).toBe('on');
  expect(JSON.stringify(fake.requests[0]!.state)).toContain('Aktiviert');
});

test('2-Step page changes, weak readings and protected page text never become enabled', async () => {
  let text = '2-Step Verification is on.';
  const fake = fakePort(name => { text = '2-Step Verification is off.'; return noulAnswer(name === 'enabled' ? 0.99 : 0.01); }); installJudgmentPort(fake.port);
  expect(await readGoogleTwoStepState(page(() => text))).toBe('unknown');
  installJudgmentPort(fakePort(() => noulAnswer(0.55)).port);
  expect(await readGoogleTwoStepState(page(() => 'Unclear page'))).toBe('unknown');
  const protectedPort = fakePort(name => noulAnswer(name === 'enabled' ? 0.99 : 0.01)); installJudgmentPort(protectedPort.port);
  expect(await readGoogleTwoStepState(page(() => 'GOCSPX-never-send'))).toBe('unknown');
  expect(protectedPort.requests).toHaveLength(0);
});


test('interpreted grant causes choose the matching remedy and Testing expiry remains more specific than generic expiry', async () => {
  installJudgmentPort(fakePort(name => noulAnswer(name === 'clientMismatch' ? 0.99 : 0.01)).port);
  const mismatch = await diagnoseInvalidGrant(grant);
  expect(mismatch.cause).toBe('client-mismatch');
  expect(mismatch.fix).toContain('client that is actually stored');
  installJudgmentPort(fakePort(name => noulAnswer(name === 'clientMismatch' ? 0.01 : 0.99)).port);
  const expired = await diagnoseInvalidGrant(grant);
  expect(expired.cause).toBe('testing-expiry');
  expect(expired.fix).toContain('In production');
});

test('OAuth invalid_grant latches once; incidental expired wording in another protocol error does not', async () => {
  for (const code of ['invalid_grant', 'temporarily_unavailable']) {
    let requests = 0;
    const fake = fakePort(() => noulAnswer(0.01)); installJudgmentPort(fake.port);
    const connection = await openGoogleConnection({
      homeDirectory: '/synthetic', files: { exists: () => false, readText: () => null },
      configGet: key => key === GOOGLE_CONFIG_KEYS.oauthClientId ? 'synthetic-client' : null,
      secretGet: async () => 'synthetic-private-value',
    }, { fetch: { fetch: async () => { requests++; return new Response(JSON.stringify({ error: code, error_description: 'The client session expired.' }), { status: 400 }); } } });
    expect(connection).not.toBeNull();
    await connection!.tokens.accessToken(); await connection!.tokens.accessToken();
    expect(connection!.tokens.grantIsDead()).toBe(code === 'invalid_grant');
    expect(requests).toBe(code === 'invalid_grant' ? 1 : 2);
    expect(fake.requests).toHaveLength(code === 'invalid_grant' ? 1 : 0);
  }
});


test('bare protocol codes and empty API errors need no semantic reading', async () => {
  const fake = fakePort(() => { throw new Error('unexpected reading'); }); installJudgmentPort(fake.port);
  for (const googleError of ['', 'invalid_grant', 'Google rejected the token request (invalid_grant).']) {
    expect((await diagnoseInvalidGrant({ ...grant, googleError })).cause).toBe('unknown');
  }
  expect((await client({ error: { code: 403 } }).getProfile()).ok).toBe(false);
  expect(fake.requests).toHaveLength(0);
});

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forgetFailureReadings, GoodVibesSdkError, installJudgmentPort, SDKErrorCodes } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { invokeOperatorGatewayMethod } from '../../agent/operator-gateway-call.ts';
import { createProfileGatewayInvoke } from '../../agent/owner-profile-gateway.ts';
import { mockFetch } from '../helpers/typed-fetch-mock.ts';

const connection = { baseUrl: 'http://127.0.0.1:3421', token: 'fixture-token', tokenPath: '/fixture/token' };
const methodId = 'profile.forget';
const route = 'POST /api/profile/forget';
const payload = { fieldId: 'commerce.shippingAddress', authority: 'owner-direct' } as const;
const success = { ok: true, changes: [], disclosure: 'Fixture removal recorded' };
const invoke = () => invokeOperatorGatewayMethod(connection, methodId, route, payload);
let originalFetch: typeof fetch;
let previousPort: ReturnType<typeof installJudgmentPort>;
let requests: { url: string; method: string; authorization: string | null; body: unknown }[];
let response: () => Promise<Response>;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  previousPort = installJudgmentPort(undefined);
  forgetFailureReadings();
  requests = [];
  response = async () => Response.json(success);
  globalThis.fetch = mockFetch(async (input, init) => {
    requests.push({ url: String(input), method: init?.method ?? 'GET',
      authorization: new Headers(init?.headers).get('authorization'), body: init?.body });
    return response();
  });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  installJudgmentPort(previousPort);
  forgetFailureReadings();
});
function reading(category: string, confidence = 0.99) {
  const fake = fakePort((name, question) => name === 'category' ? choiceAnswer(question, category, confidence)
    : name === 'connection_failure' ? choiceAnswer(question, 'none', 0.99) : noulAnswer(0.01));
  installJudgmentPort(fake.port);
  return fake.requests;
}
// A real response stream can reject after headers arrive. This reaches the SDK's
// body-reading seam without mocking the SDK or replacing the production caller.
function rejectBody(error: unknown) {
  response = async () => {
    const reply = new Response('{}');
    reply.text = async () => { throw error; };
    return reply;
  };
}
function expectOneMutation() {
  expect(requests).toEqual([{ url: `${connection.baseUrl}/api/profile/forget`, method: 'POST',
    authorization: 'Bearer fixture-token', body: JSON.stringify(payload) }]);
}

describe('operator gateway uses the shared engine failure contract through the real SDK', () => {
  test('missing token remains a local failure', async () => {
    const log = reading('network');
    expect(await invokeOperatorGatewayMethod({ ...connection, token: null }, methodId, route, payload))
      .toMatchObject({ ok: false, kind: 'auth_required', methodId, route });
    expect(requests).toHaveLength(0);
    expect(log).toHaveLength(0);
  });
  test('successful mutation forwards authority and preserves method metadata', async () => {
    expect(await invoke()).toEqual({ ok: true, data: success, methodId, route });
    expectOneMutation();
  });
  test.each([400, 402, 409, 429, 500, 503])('HTTP %s cannot become auth or a missing route from wording', async (status) => {
    const log = reading('not_found');
    response = async () => Response.json({ error: 'auth 404 fetch connection' }, { status });
    expect(await invoke()).toMatchObject({ ok: false, kind: 'connected_host_error', methodId, route, baseUrl: connection.baseUrl });
    expectOneMutation();
    expect(log).toHaveLength(0);
  });
  test.each([401, 403])('HTTP %s preserves the SDK bounded auth handling only', async (status) => {
    const log = reading('network');
    response = async () => Response.json({ error: 'opaque' }, { status });
    expect(await invoke()).toMatchObject({ kind: 'auth_required' });
    expect(requests).toHaveLength(status === 401 ? 2 : 1);
    expect(requests.every(({ method, body, authorization }) => method === 'POST'
      && body === JSON.stringify(payload) && authorization === 'Bearer fixture-token')).toBe(true);
    expect(log).toHaveLength(0);
  });
  test.each([408, 504])('HTTP %s reports timeout without replaying a mutation', async (status) => {
    response = async () => Response.json({ error: 'auth 404' }, { status });
    expect(await invoke()).toMatchObject({ kind: 'connected_host_unavailable' });
    expectOneMutation();
  });
  test.each([200, 401, 404, 503])('404 probes status once; probe HTTP %s never retries the write', async (status) => {
    response = async () => requests.length === 1
      ? Response.json({ error: 'auth and fetch are mentioned, but the status is authoritative' }, { status: 404 })
      : new Response('{}', { status });
    expect(await invoke()).toMatchObject({ kind: status === 200 ? 'connected_host_incompatible' : 'connected_host_route_unavailable', methodId, route });
    expect(requests.map(({ method }) => method)).toEqual(['POST', 'GET']);
    expect(requests[1]).toEqual({ url: `${connection.baseUrl}/status`, method: 'GET', authorization: 'Bearer fixture-token', body: undefined });
  });
  test('opaque transport rejection uses structured SDK category without judgment or retry', async () => {
    const log = reading('authentication');
    response = async () => { throw new Error('opaque socket interruption'); };
    expect(await invoke()).toMatchObject({ kind: 'connected_host_unavailable' });
    expectOneMutation();
    expect(log).toHaveLength(0);
  });
  test('transport cancellation never becomes auth, a probe, or a replay', async () => {
    const log = reading('not_found');
    response = async () => { throw new DOMException('auth 404 fetch', 'AbortError'); };
    expect(await invoke()).toMatchObject({ kind: 'connected_host_error' });
    expectOneMutation();
    expect(log).toHaveLength(0);
  });
  test.each([
    [SDKErrorCodes.AUTH_REQUIRED, 'auth_required'], [SDKErrorCodes.PERMISSION_DENIED, 'auth_required'],
    [SDKErrorCodes.CANCELLED, 'connected_host_error'], [SDKErrorCodes.PAYMENT_REQUIRED, 'connected_host_error'],
    [SDKErrorCodes.CONFLICT, 'connected_host_error'], [SDKErrorCodes.NETWORK_UNREACHABLE, 'connected_host_unavailable'],
  ] as const)('body stream typed %s outranks misleading wording', async (code, kind) => {
    const log = reading('not_found');
    rejectBody(new GoodVibesSdkError('fetch 404', { code }));
    expect(await invoke()).toMatchObject({ kind });
    expectOneMutation();
    expect(log).toHaveLength(0);
  });
  test.each([
    ['authentication', 'auth_required'], ['network', 'connected_host_unavailable'], ['unknown', 'connected_host_error'],
  ] as const)('unstructured body error consults the engine reading: %s', async (category, kind) => {
    const log = reading(category);
    rejectBody(new Error('Opaque body stream failure'));
    expect(await invoke()).toMatchObject({ kind });
    expectOneMutation();
    expect(log).toHaveLength(1);
    expect(log[0]?.state).toContain('Message: Opaque body stream failure');
  });
  test('weak reading cannot trigger a status probe', async () => {
    reading('not_found', 0.2);
    rejectBody(new Error('auth 404 fetch'));
    expect(await invoke()).toMatchObject({ kind: 'connected_host_error' });
    expectOneMutation();
  });
  test('before bootstrap and after judgment failure, unknown remains unknown', async () => {
    rejectBody(new Error('auth 404 fetch'));
    expect(await invoke()).toMatchObject({ kind: 'connected_host_error', error: 'auth 404 fetch' });
    expectOneMutation();
    requests = [];
    installJudgmentPort({ model: 'offline-fixture', ask: async () => { throw new Error('offline'); } });
    rejectBody(new Error('not found'));
    expect(await invoke()).toMatchObject({ kind: 'connected_host_error', error: 'not found' });
    expectOneMutation();
  });
  test('owner profile connected-host caller reports the typed failure and preserves removal authority', async () => {
    const home = mkdtempSync(join(tmpdir(), 'operator-failure-'));
    try {
      const directory = join(home, '.goodvibes', 'daemon');
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'operator-tokens.json'), JSON.stringify({ token: connection.token }));
      const profile = createProfileGatewayInvoke({ configManager: { get: () => undefined }, homeDirectory: home });
      response = async () => Response.json({ error: 'auth fetch 404' }, { status: 409 });
      const result = await profile(methodId, payload);
      expect(result).toMatchObject({ ok: false, data: null, route: 'connected-host' });
      expect(result.error).toContain('profile.forget (connected_host_error)');
      expectOneMutation();
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

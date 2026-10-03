import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  forgetFailureReadings, GoodVibesSdkError, installJudgmentPort, SDKErrorCodes,
} from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import {
  buildRoutineSchedulePreview, classifyConnectedHostScheduleError, promoteRoutineToConnectedSchedule,
  type AgentConnectedHostConnection,
} from '../../agent/routine-schedule-promotion.ts';
import { mockFetch } from '../helpers/typed-fetch-mock.ts';

const connection: AgentConnectedHostConnection = {
  baseUrl: 'http://127.0.0.1:3421', token: 'fixture-token', tokenPath: '/fixture/operator-tokens.json',
};
const options = { route: '/api/automation/schedules', incompatibleMessage: 'Schedule method unavailable.' };
const preview = buildRoutineSchedulePreview({
  id: 'routine-fixture', name: 'Review queue', description: 'Read the queue', steps: 'Report findings',
  triggers: [], tags: [], requirements: [], enabled: true, source: 'user', provenance: 'fixture',
  reviewState: 'reviewed', createdAt: '', updatedAt: '', startCount: 0,
}, { routineId: 'routine-fixture', schedule: { kind: 'every', value: '1h' }, deliveryTargets: [], enabled: true, yes: true, errors: [] });

let originalFetch: typeof fetch;
let previousPort: ReturnType<typeof installJudgmentPort>;
let requests: { url: string; method: string; authorization: string | null; body: unknown }[];
let response: () => Promise<Response>;
beforeEach(() => {
  forgetFailureReadings();
  previousPort = installJudgmentPort(undefined);
  originalFetch = globalThis.fetch;
  requests = [];
  response = async () => new Response('{}');
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
  const fake = fakePort((name, question) => {
    if (name === 'category') return choiceAnswer(question, category, confidence);
    if (name === 'connection_failure') return choiceAnswer(question, 'none', 0.99);
    return noulAnswer(0.01);
  });
  installJudgmentPort(fake.port);
  return fake.requests;
}

const classify = (error: unknown) => classifyConnectedHostScheduleError(error, connection, options);

describe('routine schedule public failure contract', () => {
  test.each([401, 403])('HTTP %s is auth even when wording suggests connectivity or 404', async (status) => {
    const log = reading('network');
    expect((await classify(new GoodVibesSdkError('connection 404 auth', { status }))).kind).toBe('auth_required');
    expect(log).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });
  test.each([400, 402, 409, 429, 500, 503])('HTTP %s cannot be reinterpreted from auth/404/fetch wording', async (status) => {
    const log = reading('authentication');
    expect((await classify({ statusCode: status, message: 'auth 404 fetch connection' })).kind).toBe('connected_host_error');
    expect(log).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });
  test.each([SDKErrorCodes.AUTH_REQUIRED, SDKErrorCodes.TOKEN_EXPIRED, SDKErrorCodes.PERMISSION_DENIED])('typed %s remains auth with opaque wording', async (code) => {
    expect((await classify(new GoodVibesSdkError('opaque', { code }))).kind).toBe('auth_required');
    expect(requests).toHaveLength(0);
  });
  test.each([SDKErrorCodes.CANCELLED, SDKErrorCodes.PAYMENT_REQUIRED, SDKErrorCodes.CONFLICT])('typed %s does not grant a probe or retry', async (code) => {
    const log = reading('not_found');
    expect((await classify(new GoodVibesSdkError('auth 404 fetch', { code }))).kind).toBe('connected_host_error');
    expect(log).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });
  test('AbortError is a stop, even if its words or cause describe a network failure', async () => {
    const log = reading('network');
    const error = new Error('fetch 404 auth', { cause: { code: 'ECONNRESET' } });
    error.name = 'AbortError';
    expect((await classify(error)).kind).toBe('connected_host_error');
    expect(log).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });
  test.each([
    new GoodVibesSdkError('opaque', { code: SDKErrorCodes.NETWORK_UNREACHABLE }),
    new GoodVibesSdkError('opaque', { category: 'timeout' }),
    new Error('opaque', { cause: { code: 'ECONNREFUSED' } }),
    Object.assign(new Error('opaque'), { code: 'ENOTFOUND' }),
    new DOMException('opaque', 'TimeoutError'),
  ])('uses typed transport evidence without asking judgment', async (error) => {
    const log = reading('authentication');
    expect((await classify(error)).kind).toBe('connected_host_unavailable');
    expect(log).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });
  test('missing method probes status once, read-only and with the same token', async () => {
    const result = await classify(new GoodVibesSdkError('opaque', { code: SDKErrorCodes.METHOD_NOT_FOUND }));
    expect(result).toMatchObject({ kind: 'connected_host_incompatible', error: options.incompatibleMessage });
    expect(requests).toEqual([{ url: `${connection.baseUrl}/status`, method: 'GET', authorization: 'Bearer fixture-token', body: undefined }]);
  });
  test.each([401, 404, 503])('status probe failure %s preserves route-unavailable behavior', async (status) => {
    response = async () => new Response('opaque', { status });
    expect((await classify(new GoodVibesSdkError('opaque', { status: 404 }))).kind).toBe('connected_host_route_unavailable');
    expect(requests).toHaveLength(1);
  });
  test('probe transport failure preserves the original error', async () => {
    response = async () => { throw new Error('probe failed'); };
    expect(await classify(new GoodVibesSdkError('original', { status: 404 }))).toMatchObject({ kind: 'connected_host_route_unavailable', error: 'original' });
  });
  test.each([
    ['authentication', 'auth_required'], ['authorization', 'auth_required'],
    ['network', 'connected_host_unavailable'], ['timeout', 'connected_host_unavailable'],
    ['not_found', 'connected_host_incompatible'], ['unknown', 'connected_host_error'],
  ] as const)('reads unresolved wording through the engine battery: %s', async (category, kind) => {
    const log = reading(category);
    expect((await classify(new Error('Opaque fixture failure'))).kind).toBe(kind);
    expect(log).toHaveLength(1);
    expect(log[0]?.state).toContain('Message: Opaque fixture failure');
  });
  test('weak reading does not classify or probe', async () => {
    reading('not_found', 0.2);
    expect((await classify(new Error('opaque'))).kind).toBe('connected_host_error');
    expect(requests).toHaveLength(0);
  });
  test('pre-bootstrap and failed judgment preserve original failure without heuristic fallback', async () => {
    expect(await classify(new Error('auth 404 fetch connect'))).toMatchObject({ kind: 'connected_host_error', error: 'auth 404 fetch connect' });
    installJudgmentPort({ model: 'offline-fixture', ask: async () => { throw new Error('judgment unavailable'); } });
    expect((await classify(new Error('not found'))).kind).toBe('connected_host_error');
    expect(requests).toHaveLength(0);
  });
});

describe('real routine promotion and browser SDK transport', () => {
  test('missing token never reaches SDK, judgment or status probe', async () => {
    const log = reading('network');
    expect((await promoteRoutineToConnectedSchedule({ ...connection, token: null }, preview)).kind).toBe('auth_required');
    expect(requests).toHaveLength(0);
    expect(log).toHaveLength(0);
  });
  test.each([401, 403])('revoked/denied token HTTP %s adds no retries beyond SDK auth handling', async (status) => {
    const log = reading('network');
    response = async () => new Response('opaque', { status });
    expect((await promoteRoutineToConnectedSchedule(connection, preview)).kind).toBe('auth_required');
    // The SDK retries a 401 once after rereading its token; classification adds none.
    expect(requests).toHaveLength(status === 401 ? 2 : 1);
    expect(requests.every(({ method }) => method === 'POST')).toBe(true);
    expect(JSON.parse(String(requests[0]?.body))).toMatchObject({ autoApprove: false, allowUnsafeExternalContent: false });
    expect(log).toHaveLength(0);
  });
  test('actual SDK 404 performs one probe and never repeats creation', async () => {
    response = async () => requests.length === 1 ? new Response('opaque', { status: 404 }) : new Response('{}');
    expect((await promoteRoutineToConnectedSchedule(connection, preview)).kind).toBe('connected_host_incompatible');
    expect(requests.map(({ method }) => method)).toEqual(['POST', 'GET']);
  });
  test('SDK transport rejection uses its structured category without judgment', async () => {
    const log = reading('network');
    response = async () => { throw new Error('socket fixture interrupted'); };
    expect((await promoteRoutineToConnectedSchedule(connection, preview)).kind).toBe('connected_host_unavailable');
    expect(requests).toHaveLength(1);
    expect(log).toHaveLength(0);
  });
  test('transport abort is not replayed or probed', async () => {
    const log = reading('network');
    response = async () => { throw new DOMException('User stopped', 'AbortError'); };
    expect((await promoteRoutineToConnectedSchedule(connection, preview)).kind).toBe('connected_host_error');
    expect(requests).toHaveLength(1);
    expect(log).toHaveLength(0);
  });
});

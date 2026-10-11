/**
 * `channels.inbox.list` is reachable on a running daemon, by both routes a
 * client has.
 *
 * The verb has had a handler in this repository for a while. What it did not
 * have was a client: the SDK descriptor carried `invokable: false`, so the
 * generic method-dispatch endpoint refused it before the handler was ever
 * consulted, and the advertised path `GET /api/channels/inbox` was in no route
 * table. The agent's unified inbox asked for it on every refresh and recorded
 * `method_unavailable` every time.
 *
 * So the thing worth pinning is not the handler, the aggregator suite covers
 * what it answers, but that a real client can now GET one. Both transports are
 * exercised against a genuinely composed, genuinely listening daemon:
 *
 *   1. the in-process gateway invoke (what a WebSocket `call` frame runs), and
 *   2. the advertised REST path over the socket, with a bearer token.
 *
 * This fixture uses the real production membership/absence owners. An absent
 * source is explicitly unconfigured and makes no remote request or empty poll.
 * Configured source qualification is separate from these exact original
 * built-in membership assertions.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { DaemonFixture } from '../../testing/daemon-fixture.js';
import { startGatewayFixture as startDaemonFixture } from '../helpers/gateway-route-fixture.js';
import { makeOwnedTempDir as makeProjectTempDir } from '../helpers/owned-temp.js';
import { createProductionDaemonInboxFactory } from '../../runtime/production-inbox-composition.js';
import type { InboxListOutput } from '@goodvibes-jev/engine/sdk/platform/intake';

const METHOD_ID = 'channels.inbox.list';
const REST_PATH = '/api/channels/inbox';

let fixture: DaemonFixture;

beforeAll(async () => {
  fixture = await startDaemonFixture({ root: makeProjectTempDir('gv-inbox-reachable'), inboxFactory: createProductionDaemonInboxFactory() });
});

afterAll(async () => {
  await fixture?.stop();
});

describe('the catalog entry a client reads', () => {
  test('no longer says "cataloged, not callable", and carries a handler on this daemon', () => {
    const descriptor = fixture.services.gatewayMethods.get(METHOD_ID);
    expect(descriptor, `${METHOD_ID} is missing from the composed catalog`).toBeTruthy();
    // The flag is what the agent's inbox was reading when it reported
    // method_unavailable. Its removal is only honest because of the line below.
    expect(descriptor!.invokable).not.toBe(false);
    expect(descriptor!.http).toEqual({ method: 'GET', path: REST_PATH });
    expect(fixture.services.gatewayMethods.hasHandler(METHOD_ID)).toBe(true);
  });
});

describe('the gateway invoke', () => {
  test('answers with the aggregate shape rather than refusing', async () => {
    const answer = await fixture.invoke<InboxListOutput>(METHOD_ID);

    expect(Array.isArray(answer.items)).toBe(true);
    expect(typeof answer.total).toBe('number');
    expect(typeof answer.hasMore).toBe('boolean');
    expect(answer.truncated).toBe(answer.hasMore);
    expect(Array.isArray(answer.providers)).toBe(true);
    expect(typeof answer.partial).toBe('boolean');

    // Nothing is configured on this fixture, so nothing is being hidden from
    // the caller and the answer is complete, not partial.
    expect(answer.partial).toBe(false);
    for (const status of answer.providers) {
      expect(typeof status.provider).toBe('string');
      expect(['ready', 'empty', 'unconfigured', 'error', 'pending']).toContain(status.state);
      expect(typeof status.itemCount).toBe('number');
      expect(typeof status.storedCount).toBe('number');
    }
  });

  test('the built-in providers are each named, so an empty inbox is legible', async () => {
    const answer = await fixture.invoke<InboxListOutput>(METHOD_ID);
    const named = answer.providers.map((status) => status.provider).sort();
    // A real daemon accounts for slack/discord/email whether or not they
    // are configured. Reporting them is the difference between "your inbox is
    // empty" and "you have not connected anything".
    expect(named).toEqual(['discord', 'email', 'slack']);
  });
});

describe('the advertised REST path, over the socket', () => {
  test('resolves to a route and returns the same aggregate shape', async () => {
    const response = await fixture.fetch(REST_PATH);
    // Before this change the identical request answered 404: the path was
    // advertised in the descriptor and served by nothing.
    expect(response.status).toBe(200);
    const body = await response.json() as InboxListOutput;
    expect(Array.isArray(body.items)).toBe(true);
    expect(Array.isArray(body.providers)).toBe(true);
    // The original provider matrix is asserted separately below.
  });

  test('the advertised REST path reports the original built-in provider matrix', async () => {
    const response = await fixture.fetch(REST_PATH);
    expect(response.status).toBe(200);
    const body = await response.json() as InboxListOutput;
    expect(Array.isArray(body.items)).toBe(true);
    expect(Array.isArray(body.providers)).toBe(true);
    expect(body.providers.map((status) => status.provider).sort()).toEqual(['discord', 'email', 'slack']);
  });

  test('query strings reach the handler over the REST leg', async () => {
    const response = await fixture.fetch(`${REST_PATH}?provider=slack&limit=5`);
    expect(response.status).toBe(200);
    const body = await response.json() as InboxListOutput;
    // The filter took effect: only the asked-about provider reports.
    expect(body.providers.map((status) => status.provider)).toEqual(['slack']);
  });

  test('a cursor the daemon never issued is a 400, not a silent restart', async () => {
    const response = await fixture.fetch(`${REST_PATH}?cursor=nonsense`);
    expect(response.status).toBe(400);
    const body = await response.json() as { code?: string };
    expect(body.code).toBe('INVALID_ARGUMENT');
  });

  test('the route is credentialed like every other one', async () => {
    // 401, not 404, the route exists and the auth gate answers first.
    const anonymous = await fixture.fetchAnonymous(REST_PATH);
    expect(anonymous.status).toBe(401);
  });
});

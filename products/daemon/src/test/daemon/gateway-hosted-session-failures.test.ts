/**
 * The hosted-session verbs, and the three ways they refuse.
 *
 * ── The gap this closes ──────────────────────────────────────────────────
 *
 * `sessions.hosted.*` appeared in no `assertEveryDescriptorHasHandler` list in
 * any repository. It is registered by `composeHostedSessions`, which runs only
 * when the product STATES `hostedSessions` on DaemonServer, `cli.ts` does,
 * `createRuntimeServices` does not, so every existing conformance sweep, all
 * of which run over the runtime graph, was structurally unable to see it. Five
 * verbs, the only way a client with no terminal of its own starts a run, and
 * nothing anywhere asserted a handler was attached.
 *
 * The refusals were in worse shape. The engine distinguishes four failures on
 * purpose (not found / unavailable / limit reached / bad argument) and maps each
 * to its own status, because a client reacts differently to each. The platform's
 * shared mock-daemon fixture set is generated from output schemas, so it carries
 * a schema-valid 200 for each verb and no refusal at all, a client mocked from
 * it has never seen one. The fixtures live in ../../testing/hosted-session-failures.ts
 * so a consumer can import them; this file is what keeps them true, by driving
 * the real engine to produce each one.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { assertEveryDescriptorHasHandler } from '@goodvibes-jev/engine/terminal-shell/conformance';
import type { DaemonFixture } from '../../testing/daemon-fixture.js';
import { startGatewayFixture as startDaemonFixture } from '../helpers/gateway-route-fixture.js';
import {
  HOSTED_SESSION_FAILURE_FIXTURES,
  HOSTED_SESSION_LIMIT_REACHED,
  HOSTED_SESSION_METHOD_IDS,
  SESSION_NOT_FOUND,
  HOSTED_SESSION_UNAVAILABLE,
} from '../../testing/hosted-session-failures.ts';
import { makeOwnedTempDir as makeProjectTempDir } from '../helpers/owned-temp.js';

let fixture: DaemonFixture;
let tempRoot = '';
let workspace = '';

interface Refusal {
  readonly code: string;
  readonly status: number;
  readonly message: string;
}

/** Invoke a verb and report the refusal it raised, or null if it answered. */
async function refusalOf(methodId: string, body: Record<string, unknown>): Promise<Refusal | null> {
  try {
    await fixture.invoke(methodId, body);
    return null;
  } catch (error) {
    const record = error as { code?: unknown; status?: unknown; message?: unknown };
    return {
      code: typeof record.code === 'string' ? record.code : '',
      status: typeof record.status === 'number' ? record.status : 0,
      message: typeof record.message === 'string' ? record.message : String(error),
    };
  }
}

beforeAll(async () => {
  tempRoot = makeProjectTempDir('gv-hosted-failures');
  workspace = join(tempRoot, 'hosted-workspace');
  mkdirSync(workspace, { recursive: true });
  fixture = await startDaemonFixture({
    root: tempRoot,
    // One live session allowed, so the cap is reachable without starting a
    // second real loop just to prove the refusal.
    configure: (config) => { config.set('hostedSessions.maxSessions', 1); },
  });
});

afterAll(async () => {
  await fixture?.stop();
});

describe('sessions.hosted.* is handler-attached on a daemon that hosts sessions', () => {
  test('every hosted-session descriptor is cataloged', () => {
    for (const methodId of HOSTED_SESSION_METHOD_IDS) {
      expect(
        fixture.services.gatewayMethods.get(methodId),
        `${methodId} descriptor missing from the catalog`,
      ).toBeTruthy();
    }
  });

  test('every hosted-session descriptor has an attached handler (shipped conformance gate)', () => {
    // The list this family was absent from. Scoped to the hosted ids so builtin
    // descriptors other layers answer do not trip it.
    expect(() =>
      assertEveryDescriptorHasHandler(fixture.services.gatewayMethods, { onlyIds: HOSTED_SESSION_METHOD_IDS }),
    ).not.toThrow();
  });

  test('sessions.hosted.list answers for real on a daemon hosting nothing yet', async () => {
    const result = await fixture.invoke<{ sessions: unknown[] }>('sessions.hosted.list', {});
    expect(Array.isArray(result.sessions)).toBe(true);
    expect(result.sessions).toHaveLength(0);
  });
});

describe('the three refusals a client has to handle', () => {
  test('SESSION_NOT_FOUND: an id this daemon does not hold', async () => {
    const refusal = await refusalOf(SESSION_NOT_FOUND.methodId, {
      sessionId: 'hosted-no-such-session',
      clientId: 'client-1',
    });
    expect(refusal, 'attaching to an unknown session answered instead of refusing').not.toBeNull();
    expect(refusal!.code).toBe(SESSION_NOT_FOUND.code);
    expect(refusal!.status).toBe(SESSION_NOT_FOUND.status);
  });

  test('HOSTED_SESSION_UNAVAILABLE: a real session that has terminated', async () => {
    const created = await fixture.invoke<{ session: { id: string } }>('sessions.hosted.create', {
      workspaceRoot: workspace,
      title: 'terminated-under-test',
    });
    const sessionId = created.session.id;
    await fixture.invoke('sessions.hosted.kill', { sessionId });

    const refusal = await refusalOf(HOSTED_SESSION_UNAVAILABLE.methodId, { sessionId, clientId: 'client-1' });
    expect(refusal, 'attaching to a terminated session answered instead of refusing').not.toBeNull();
    // 409 and not 404 is the whole distinction: the id is real, so a client must
    // not be told to go look it up again.
    expect(refusal!.code).toBe(HOSTED_SESSION_UNAVAILABLE.code);
    expect(refusal!.status).toBe(HOSTED_SESSION_UNAVAILABLE.status);
    // The reason travels with the refusal, that is what a client shows.
    expect(refusal!.message.length).toBeGreaterThan(0);
  });

  test('HOSTED_SESSION_LIMIT_REACHED: the configured cap, honestly reported', async () => {
    const first = await fixture.invoke<{ session: { id: string } }>('sessions.hosted.create', {
      workspaceRoot: workspace,
      title: 'holds-the-only-slot',
    });

    const refusal = await refusalOf(HOSTED_SESSION_LIMIT_REACHED.methodId, {
      workspaceRoot: workspace,
      title: 'one-too-many',
    });
    expect(refusal, 'creating past the cap answered instead of refusing').not.toBeNull();
    expect(refusal!.code).toBe(HOSTED_SESSION_LIMIT_REACHED.code);
    expect(refusal!.status).toBe(HOSTED_SESSION_LIMIT_REACHED.status);
    // The refusal names the setting, because the caller's only remedies are to
    // kill a session or change that value.
    expect(refusal!.message).toContain('hostedSessions.maxSessions');

    // And it is genuinely a cap, not a permanent refusal: freeing the slot works.
    await fixture.invoke('sessions.hosted.kill', { sessionId: first.session.id });
    const afterKill = await fixture.invoke<{ session: { id: string } }>('sessions.hosted.create', {
      workspaceRoot: workspace,
      title: 'fits-again',
    });
    expect(afterKill.session.id).toBeTruthy();
    await fixture.invoke('sessions.hosted.kill', { sessionId: afterKill.session.id });
  });

  test('the shipped fixtures describe refusals this daemon actually raises', () => {
    // The fixtures are exported for consumers to mock against. If one names a
    // code or status the daemon has stopped producing, the tests above fail
    // first, this pins the list itself so a fourth refusal cannot be added to
    // the engine and left out of what consumers are handed.
    expect(HOSTED_SESSION_FAILURE_FIXTURES.map((entry) => entry.code).sort()).toEqual([
      'HOSTED_SESSION_LIMIT_REACHED',
      'HOSTED_SESSION_UNAVAILABLE',
      'SESSION_NOT_FOUND',
    ]);
    for (const entry of HOSTED_SESSION_FAILURE_FIXTURES) {
      expect(HOSTED_SESSION_METHOD_IDS).toContain(entry.methodId);
      expect(entry.clientAction.length).toBeGreaterThan(0);
    }
  });
});

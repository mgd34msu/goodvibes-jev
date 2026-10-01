/**
 * channel-profile-routing-daemon.test.ts, assignments reach the daemon, and
 * survive a daemon that will not take them.
 *
 * The routing table the platform routes against is the daemon's. An assignment
 * made here is therefore offered to `channels.routing.assign` first, and the
 * local file is a mirror of what the daemon holds plus whatever it has not
 * taken yet.
 *
 * Both halves are load-bearing and they fail differently:
 *
 *  - ADOPTED: the daemon takes it, the record says so, and the record carries
 *    the daemon's own assignment id, not a locally-invented one, which would
 *    make "synced" unfalsifiable.
 *  - DEGRADED: the daemon refuses or cannot be reached, and the assignment is
 *    still there afterwards, marked pending, with the reason in the daemon's
 *    words. Losing an operator's instruction because a peer was busy is the
 *    failure this shape exists to prevent.
 *
 * The retry path (`syncChannelProfileRoutes`) is the same operation applied to
 * records the daemon does not hold, including records written by a build from
 * before the daemon held this table at all, which is why the receipts assert on
 * the state those records were actually in.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import {
  assignChannelToProfile,
  listChannelProfileRoutes,
  readChannelProfileRoutes,
  syncChannelProfileRoutes,
  formatChannelProfileRoutes,
  CHANNEL_ROUTING_ASSIGN_METHOD,
} from '../../agent/channel-profile-routing.ts';
import { readChannelRoutingSyncReceipts } from '../../agent/channel-routing-sync-receipts.ts';
import type { DaemonInvokeResult, DaemonOperatorInvoke } from '../../agent/daemon-operator-client.ts';

let root: string;

const shellPaths = {
  resolveUserPath: (...segments: string[]) => join(root, ...segments),
};

beforeEach(() => {
  root = makeProjectTempDir('gv-routing');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface RecordedCall {
  readonly methodId: string;
  readonly input: Record<string, unknown>;
  readonly explicitUserRequest: boolean | undefined;
}

/** A daemon that takes every assignment and reports its own id. */
function acceptingDaemon(calls: RecordedCall[], assignmentId = 'daemon-assign-1'): DaemonOperatorInvoke {
  return async (methodId, input = {}, options = {}) => {
    calls.push({ methodId, input, explicitUserRequest: options.explicitUserRequest });
    return {
      ok: true,
      methodId,
      route: `POST /api/channels/routing`,
      body: { assignmentId, surfaceKind: input.surfaceKind, profileId: input.profileId },
    } satisfies DaemonInvokeResult;
  };
}

/** A daemon that is not there. */
function unreachableDaemon(calls: RecordedCall[]): DaemonOperatorInvoke {
  return async (methodId, input = {}, options = {}) => {
    calls.push({ methodId, input, explicitUserRequest: options.explicitUserRequest });
    return {
      ok: false,
      methodId,
      route: 'POST /api/channels/routing',
      kind: 'connected_host_unavailable',
      error: 'connect ECONNREFUSED 127.0.0.1:3421',
    } satisfies DaemonInvokeResult;
  };
}

describe('assigning a channel to a profile: the daemon takes it', () => {
  test('the assignment is offered to channels.routing.assign', async () => {
    const calls: RecordedCall[] = [];
    await assignChannelToProfile(
      shellPaths,
      { surfaceKind: 'slack', routeId: 'C1', profileId: 'work', label: 'team' },
      { invoke: acceptingDaemon(calls) },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.methodId).toBe(CHANNEL_ROUTING_ASSIGN_METHOD);
    expect(calls[0]!.input).toMatchObject({
      surfaceKind: 'slack',
      routeId: 'C1',
      profileId: 'work',
      label: 'team',
    });
  });

  test('the call carries both halves of the daemon confirmation gate', () => {
    // confirm:true says the call was reviewed; the explicit-user-request claim
    // says a person asked. The daemon requires both, and this path is only
    // reached through the harness's confirmed-action gate, so both are honest.
    const calls: RecordedCall[] = [];
    return assignChannelToProfile(
      shellPaths,
      { surfaceKind: 'slack', profileId: 'work' },
      { invoke: acceptingDaemon(calls) },
    ).then(() => {
      expect(calls[0]!.input['confirm']).toBe(true);
      expect(calls[0]!.explicitUserRequest).toBe(true);
    });
  });

  test('the record is marked synced and carries the daemon\'s assignment id', async () => {
    const result = await assignChannelToProfile(
      shellPaths,
      { surfaceKind: 'slack', profileId: 'work' },
      { invoke: acceptingDaemon([], 'assign-from-daemon') },
    );

    expect(result.daemon).toEqual({ synced: true, assignmentId: 'assign-from-daemon' });
    expect(result.route.daemonSyncState).toBe('synced');
    expect(result.route.daemonAssignmentId).toBe('assign-from-daemon');
    expect(result.route.syncError).toBeUndefined();
  });

  test('a daemon answer with no assignmentId is not counted as synced', async () => {
    // "Synced" has to mean the daemon holds it. An empty 200 does not prove
    // that, and treating it as proof is how a routing table silently diverges.
    const invoke: DaemonOperatorInvoke = async (methodId) => ({
      ok: true, methodId, route: 'POST /api/channels/routing', body: {},
    });
    const result = await assignChannelToProfile(
      shellPaths,
      { surfaceKind: 'slack', profileId: 'work' },
      { invoke },
    );

    expect(result.route.daemonSyncState).toBe('pending');
    expect(result.daemon.synced).toBe(false);
  });
});

describe('assigning a channel to a profile: the daemon is unreachable', () => {
  test('the assignment is still saved, and still resolves', async () => {
    const result = await assignChannelToProfile(
      shellPaths,
      { surfaceKind: 'slack', profileId: 'work' },
      { invoke: unreachableDaemon([]) },
    );

    expect(result.created).toBe(true);
    const stored = readChannelProfileRoutes(shellPaths);
    expect(stored.routes).toHaveLength(1);
    expect(stored.routes[0]!.profileId).toBe('work');
  });

  test('the record says pending, in the daemon\'s own words', async () => {
    const result = await assignChannelToProfile(
      shellPaths,
      { surfaceKind: 'slack', profileId: 'work' },
      { invoke: unreachableDaemon([]) },
    );

    expect(result.route.daemonSyncState).toBe('pending');
    expect(result.route.syncError).toContain('ECONNREFUSED');
    expect(result.route.syncFailureKind).toBe('connected_host_unavailable');
    expect(result.route.daemonAssignmentId).toBeUndefined();
  });

  test('a daemon that refuses the verb is reported as refusing it, not as absent', async () => {
    // The live platform answers exactly this today: the method is cataloged and
    // marked not invokable, so the caller gets a 400 rather than a timeout.
    // Reporting it as "unreachable" would send someone to check the network.
    const invoke: DaemonOperatorInvoke = async (methodId) => ({
      ok: false,
      methodId,
      route: 'POST /api/channels/routing',
      kind: 'connected_host_route_unavailable',
      error: 'HTTP 400: Gateway method is cataloged but not invokable through method dispatch',
    });
    const result = await assignChannelToProfile(
      shellPaths,
      { surfaceKind: 'slack', profileId: 'work' },
      { invoke },
    );

    expect(result.route.syncFailureKind).toBe('connected_host_route_unavailable');
    expect(result.route.syncError).toContain('not invokable');
  });

  test('with no transport at all, nothing is claimed about the daemon', async () => {
    const result = await assignChannelToProfile(shellPaths, { surfaceKind: 'slack', profileId: 'work' });

    expect(result.daemon).toEqual({
      synced: false,
      kind: 'not_attempted',
      error: 'no connected-host transport was supplied, so the daemon was not offered this assignment',
    });
    expect(result.route.syncFailureKind).toBeUndefined();
  });

  test('resolution works from the local mirror while the daemon is away', async () => {
    await assignChannelToProfile(
      shellPaths,
      { surfaceKind: 'slack', profileId: 'work' },
      { invoke: unreachableDaemon([]) },
    );

    expect(listChannelProfileRoutes(shellPaths, { surfaceKind: 'slack' }).routes).toHaveLength(1);
  });
});

describe('syncing assignments the daemon does not hold', () => {
  async function seedPending(): Promise<void> {
    await assignChannelToProfile(
      shellPaths,
      { surfaceKind: 'slack', profileId: 'work' },
      { invoke: unreachableDaemon([]) },
    );
    await assignChannelToProfile(
      shellPaths,
      { surfaceKind: 'discord', profileId: 'play' },
      { invoke: unreachableDaemon([]) },
    );
  }

  test('every pending assignment is offered again and marked synced', async () => {
    await seedPending();
    const calls: RecordedCall[] = [];

    const report = await syncChannelProfileRoutes(shellPaths, acceptingDaemon(calls));

    expect(report.attempted).toBe(2);
    expect(report.synced).toBe(2);
    expect(report.refused).toBe(0);
    expect(calls).toHaveLength(2);
    expect(readChannelProfileRoutes(shellPaths).routes.every((r) => r.daemonSyncState === 'synced')).toBe(true);
  });

  test('an assignment the daemon already holds is not offered again', async () => {
    await assignChannelToProfile(
      shellPaths,
      { surfaceKind: 'slack', profileId: 'work' },
      { invoke: acceptingDaemon([]) },
    );
    const calls: RecordedCall[] = [];

    const report = await syncChannelProfileRoutes(shellPaths, acceptingDaemon(calls));

    expect(report.attempted).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test('a still-unreachable daemon leaves the assignments in place', async () => {
    await seedPending();

    const report = await syncChannelProfileRoutes(shellPaths, unreachableDaemon([]));

    expect(report.refused).toBe(2);
    expect(readChannelProfileRoutes(shellPaths).routes).toHaveLength(2);
  });
});

describe('records written before the daemon held this table', () => {
  /** A file exactly as an older build wrote it: local_only + the retired flag. */
  function seedLegacyFile(): void {
    const path = join(root, 'agent', 'channels', 'profile-routes.json');
    mkdirSync(join(root, 'agent', 'channels'), { recursive: true });
    writeFileSync(path, `${JSON.stringify({
      version: 1,
      routes: [{
        version: 1,
        id: 'cpr-legacy-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        surfaceKind: 'slack',
        routeId: 'C9',
        profileId: 'work',
        daemonSyncState: 'local_only',
        daemonMethodNeeded: 'channels.routing.assign',
      }],
    }, null, 2)}\n`, 'utf-8');
  }

  test('the retired local_only state reads as owed an offer, not as synced', () => {
    seedLegacyFile();

    const snapshot = readChannelProfileRoutes(shellPaths);
    expect(snapshot.routes).toHaveLength(1);
    expect(snapshot.routes[0]!.daemonSyncState).toBe('pending');
  });

  test('the record keeps its identity and its meaning through the migration', async () => {
    seedLegacyFile();

    await syncChannelProfileRoutes(shellPaths, acceptingDaemon([], 'assign-legacy'));

    const migrated = readChannelProfileRoutes(shellPaths).routes[0]!;
    expect(migrated.id).toBe('cpr-legacy-1');
    expect(migrated.surfaceKind).toBe('slack');
    expect(migrated.routeId).toBe('C9');
    expect(migrated.profileId).toBe('work');
    expect(migrated.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(migrated.daemonSyncState).toBe('synced');
    expect(migrated.daemonAssignmentId).toBe('assign-legacy');
  });

  test('the retired flag is gone from what is written back', async () => {
    seedLegacyFile();

    await syncChannelProfileRoutes(shellPaths, acceptingDaemon([]));

    const raw = readFileSync(join(root, 'agent', 'channels', 'profile-routes.json'), 'utf-8');
    expect(raw).not.toContain('daemonMethodNeeded');
    expect(raw).not.toContain('local_only');
  });

  test('the migration leaves a receipt naming the state the record was in', async () => {
    seedLegacyFile();

    await syncChannelProfileRoutes(shellPaths, acceptingDaemon([], 'assign-legacy'));

    const receipts = readChannelRoutingSyncReceipts(shellPaths).receipts;
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      routeId: 'cpr-legacy-1',
      surfaceKind: 'slack',
      channelRouteId: 'C9',
      profileId: 'work',
      previousSyncState: 'local_only',
      outcome: 'synced',
      daemonAssignmentId: 'assign-legacy',
      methodId: CHANNEL_ROUTING_ASSIGN_METHOD,
    });
  });

  test('a refused migration is receipted as refused rather than dropped', async () => {
    seedLegacyFile();

    await syncChannelProfileRoutes(shellPaths, unreachableDaemon([]));

    const receipts = readChannelRoutingSyncReceipts(shellPaths).receipts;
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.outcome).toBe('refused');
    expect(receipts[0]!.previousSyncState).toBe('local_only');
    expect(receipts[0]!.error).toContain('ECONNREFUSED');
    // Still live locally, a refusal is not a deletion.
    expect(readChannelProfileRoutes(shellPaths).routes).toHaveLength(1);
  });
});

describe('what the routing table reports', () => {
  test('the summary counts what the daemon holds and what it does not', async () => {
    await assignChannelToProfile(
      shellPaths,
      { surfaceKind: 'slack', profileId: 'work' },
      { invoke: acceptingDaemon([]) },
    );
    await assignChannelToProfile(
      shellPaths,
      { surfaceKind: 'discord', profileId: 'play' },
      { invoke: unreachableDaemon([]) },
    );

    const formatted = formatChannelProfileRoutes(readChannelProfileRoutes(shellPaths));
    expect(formatted).toContain('1 synced, 1 awaiting channels.routing.assign');
    expect(formatted).toContain('ECONNREFUSED');
  });

  test('no retired flag survives in what an operator is shown', async () => {
    await assignChannelToProfile(
      shellPaths,
      { surfaceKind: 'slack', profileId: 'work' },
      { invoke: unreachableDaemon([]) },
    );

    const formatted = formatChannelProfileRoutes(readChannelProfileRoutes(shellPaths));
    expect(formatted).not.toContain('local_only');
    expect(formatted).not.toContain('daemon method needed');
  });
});

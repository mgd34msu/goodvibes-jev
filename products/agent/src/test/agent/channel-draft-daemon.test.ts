/**
 * channel-draft-daemon.test.ts, drafts reach the daemon's store, and survive a
 * daemon that will not take them.
 *
 * A draft is composed on one surface and finished on another: the phone writes
 * it, the terminal sends it. That only works if the store of record is the
 * daemon's, so a save is offered to `channels.drafts.save` and a list is the
 * daemon's drafts merged with the local mirror.
 *
 * The mirror is what makes a draft survive an unreachable daemon. The failure
 * it prevents is the expensive one: an operator composes a message, the daemon
 * happens to be restarting, and the composition is gone. So every degradation
 * test here asserts the draft is still THERE afterwards, not merely that an
 * error was returned.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import {
  saveDraft,
  listDrafts,
  deleteDraft,
  fetchDaemonDrafts,
  mergeDraftViews,
  syncChannelDrafts,
  readChannelDrafts,
  CHANNEL_DRAFTS_SAVE_METHOD,
  CHANNEL_DRAFTS_LIST_METHOD,
  CHANNEL_DRAFTS_DELETE_METHOD,
  type ChannelDraft,
} from '../../agent/channel-draft.ts';
import type { DaemonOperatorInvoke } from '../../agent/daemon-operator-client.ts';

let root: string;
const shellPaths = { resolveUserPath: (...segments: string[]) => join(root, ...segments) };

beforeEach(() => { root = makeProjectTempDir('gv-drafts'); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

interface Call {
  readonly methodId: string;
  readonly input: Record<string, unknown>;
  readonly explicitUserRequest: boolean | undefined;
}

function acceptingDaemon(calls: Call[], drafts: unknown[] = []): DaemonOperatorInvoke {
  return async (methodId, input = {}, options = {}) => {
    calls.push({ methodId, input, explicitUserRequest: options.explicitUserRequest });
    if (methodId === CHANNEL_DRAFTS_LIST_METHOD) {
      return { ok: true, methodId, route: '', body: { drafts, total: drafts.length } };
    }
    if (methodId === CHANNEL_DRAFTS_DELETE_METHOD) {
      return { ok: true, methodId, route: '', body: { deleted: true, draftId: input.draftId } };
    }
    return { ok: true, methodId, route: '', body: { draft: input, created: true } };
  };
}

function unreachableDaemon(calls: Call[] = []): DaemonOperatorInvoke {
  return async (methodId, input = {}, options = {}) => {
    calls.push({ methodId, input, explicitUserRequest: options.explicitUserRequest });
    return {
      ok: false, methodId, route: '',
      kind: 'connected_host_unavailable',
      error: 'connect ECONNREFUSED 127.0.0.1:3421',
    };
  };
}

function daemonDraft(id: string, message: string, updatedAt: string): Record<string, unknown> {
  return {
    version: 1,
    id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt,
    status: 'draft',
    message,
  };
}

describe('saving a draft: the daemon takes it', () => {
  test('the draft is offered to channels.drafts.save with both halves of the gate', async () => {
    const calls: Call[] = [];

    await saveDraft(shellPaths, { message: 'hello there', channel: 'slack:ops' }, { invoke: acceptingDaemon(calls) });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.methodId).toBe(CHANNEL_DRAFTS_SAVE_METHOD);
    expect(calls[0]!.input).toMatchObject({ message: 'hello there', channel: 'slack:ops', confirm: true });
    expect(calls[0]!.explicitUserRequest).toBe(true);
  });

  test('the record says the daemon holds it', async () => {
    const result = await saveDraft(shellPaths, { message: 'hello' }, { invoke: acceptingDaemon([]) });

    expect(result.daemon).toEqual({ synced: true });
    expect(result.draft.daemonSyncState).toBe('synced');
    expect(result.draft.syncError).toBeUndefined();
  });

  test('the sync bookkeeping is never sent back to the daemon as draft content', async () => {
    // daemonSyncState/syncError describe this mirror's relationship to the
    // daemon. Posting them into the daemon's own copy would have it storing
    // our opinion of it.
    const calls: Call[] = [];
    await saveDraft(shellPaths, { message: 'first' }, { invoke: unreachableDaemon() });
    await syncChannelDrafts(shellPaths, acceptingDaemon(calls));

    expect(calls[0]!.input).not.toHaveProperty('daemonSyncState');
    expect(calls[0]!.input).not.toHaveProperty('syncError');
  });
});

describe('saving a draft: the daemon is unreachable', () => {
  test('the composition is kept', async () => {
    const result = await saveDraft(
      shellPaths,
      { message: 'a message worth keeping', channel: 'slack:ops' },
      { invoke: unreachableDaemon() },
    );

    expect(listDrafts(shellPaths).drafts).toHaveLength(1);
    expect(listDrafts(shellPaths).drafts[0]!.message).toBe('a message worth keeping');
    expect(result.draft.daemonSyncState).toBe('pending');
    expect(result.draft.syncError).toContain('ECONNREFUSED');
  });

  test('a daemon that refuses the verb is reported as refusing it', async () => {
    // What the live platform answers today for channels.drafts.save.
    const invoke: DaemonOperatorInvoke = async (methodId) => ({
      ok: false, methodId, route: '',
      kind: 'connected_host_route_unavailable',
      error: 'HTTP 400: Gateway method is cataloged but not invokable through method dispatch',
    });

    const result = await saveDraft(shellPaths, { message: 'hello' }, { invoke });

    expect(result.daemon).toMatchObject({ synced: false, kind: 'connected_host_route_unavailable' });
    expect(readChannelDrafts(shellPaths).drafts).toHaveLength(1);
  });

  test('with no transport, nothing is claimed about the daemon', async () => {
    const result = await saveDraft(shellPaths, { message: 'hello' });

    expect(result.daemon).toMatchObject({ synced: false, kind: 'not_attempted' });
  });
});

describe('reading drafts across surfaces', () => {
  test('the daemon\'s drafts are read and marked as the daemon\'s', async () => {
    const result = await fetchDaemonDrafts(acceptingDaemon([], [daemonDraft('d-1', 'from the phone', '2026-02-01T00:00:00.000Z')]));

    expect('drafts' in result).toBe(true);
    if (!('drafts' in result)) return;
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]!.id).toBe('d-1');
    expect(result.drafts[0]!.origin).toBe('daemon');
    expect(result.drafts[0]!.daemonSyncState).toBe('synced');
  });

  test('a daemon that will not list is an error, not an empty inbox of drafts', async () => {
    const result = await fetchDaemonDrafts(unreachableDaemon());

    expect('drafts' in result).toBe(false);
    if ('drafts' in result) return;
    expect(result.kind).toBe('connected_host_unavailable');
  });

  test('a draft only the local mirror has is still shown', async () => {
    // The whole point of keeping it: an operator must not have to wonder where
    // the message they wrote went.
    await saveDraft(shellPaths, { message: 'composed while offline' }, { invoke: unreachableDaemon() });
    const local = readChannelDrafts(shellPaths).drafts;

    const merged = mergeDraftViews([], local);

    expect(merged).toHaveLength(1);
    expect(merged[0]!.message).toBe('composed while offline');
    expect(merged[0]!.origin).toBe('local');
  });

  test('the daemon\'s copy wins for a draft both stores hold', async () => {
    await saveDraft(shellPaths, { id: 'shared-1', message: 'stale local text' }, { invoke: unreachableDaemon() });
    const local = readChannelDrafts(shellPaths).drafts;
    const fromDaemon = await fetchDaemonDrafts(
      acceptingDaemon([], [daemonDraft(local[0]!.id, 'newer text from another surface', '2026-03-01T00:00:00.000Z')]),
    );
    if (!('drafts' in fromDaemon)) throw new Error('expected drafts');

    const merged = mergeDraftViews(fromDaemon.drafts, local);

    expect(merged).toHaveLength(1);
    expect(merged[0]!.message).toBe('newer text from another surface');
    expect(merged[0]!.origin).toBe('daemon');
  });

  test('both stores together are one list, newest first', async () => {
    await saveDraft(shellPaths, { message: 'local one' }, { invoke: unreachableDaemon() });
    const local = readChannelDrafts(shellPaths).drafts;
    const fromDaemon = await fetchDaemonDrafts(
      acceptingDaemon([], [daemonDraft('d-9', 'daemon one', '2099-01-01T00:00:00.000Z')]),
    );
    if (!('drafts' in fromDaemon)) throw new Error('expected drafts');

    const merged = mergeDraftViews(fromDaemon.drafts, local);

    expect(merged).toHaveLength(2);
    expect(merged[0]!.id).toBe('d-9');
  });
});

describe('deleting a draft', () => {
  test('the daemon is asked to drop its copy too', async () => {
    const calls: Call[] = [];
    const saved = await saveDraft(shellPaths, { message: 'delete me' }, { invoke: acceptingDaemon([]) });

    const result = await deleteDraft(shellPaths, saved.draft.id, { invoke: acceptingDaemon(calls) });

    expect(result.deleted).toBe(true);
    expect(result.daemon).toEqual({ synced: true });
    expect(calls[0]!.methodId).toBe(CHANNEL_DRAFTS_DELETE_METHOD);
    expect(calls[0]!.input).toMatchObject({ draftId: saved.draft.id, confirm: true });
  });

  test('an unreachable daemon still removes the local copy, and says so', async () => {
    // A draft reappearing on the surface where it was deleted is worse than it
    // lingering elsewhere until the next sync.
    const saved = await saveDraft(shellPaths, { message: 'delete me' }, { invoke: unreachableDaemon() });

    const result = await deleteDraft(shellPaths, saved.draft.id, { invoke: unreachableDaemon() });

    expect(result.deleted).toBe(true);
    expect(result.daemon.synced).toBe(false);
    expect(readChannelDrafts(shellPaths).drafts).toHaveLength(0);
  });
});

describe('syncing drafts the daemon does not hold', () => {
  test('pending drafts are offered again and marked synced', async () => {
    await saveDraft(shellPaths, { message: 'one' }, { invoke: unreachableDaemon() });
    await saveDraft(shellPaths, { message: 'two' }, { invoke: unreachableDaemon() });
    const calls: Call[] = [];

    const report = await syncChannelDrafts(shellPaths, acceptingDaemon(calls));

    expect(report).toEqual({ attempted: 2, synced: 2, refused: 0 });
    expect(readChannelDrafts(shellPaths).drafts.every((d: ChannelDraft) => d.daemonSyncState === 'synced')).toBe(true);
  });

  test('a draft the daemon already holds is not offered again', async () => {
    await saveDraft(shellPaths, { message: 'already there' }, { invoke: acceptingDaemon([]) });
    const calls: Call[] = [];

    const report = await syncChannelDrafts(shellPaths, acceptingDaemon(calls));

    expect(report.attempted).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test('a still-unreachable daemon leaves every draft in place', async () => {
    await saveDraft(shellPaths, { message: 'one' }, { invoke: unreachableDaemon() });

    const report = await syncChannelDrafts(shellPaths, unreachableDaemon());

    expect(report.refused).toBe(1);
    expect(readChannelDrafts(shellPaths).drafts).toHaveLength(1);
  });
});

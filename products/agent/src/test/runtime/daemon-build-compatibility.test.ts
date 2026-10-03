/**
 * daemon-build-compatibility.test.ts, this process judging the daemon it
 * attached to.
 *
 * The forward guard (client-build-compatibility) covers this build being too
 * old for the daemon. This covers the reverse, and the reason it matters is
 * that its failure mode is invisible: a daemon too old to serve a verb answers
 * one call with a 400, which reads as a broken feature. Nobody goes looking at
 * the daemon's version.
 *
 * The two properties under test are the ones a guard gets wrong:
 *
 *  - An UNREADABLE version is 'unknown', never 'ok'. A peer that cannot prove
 *    it carries a behavior is treated as one that does not.
 *  - The finding LATCHES, so a later read that cannot determine a version does
 *    not silently clear it, but `reset()` drops it, because a verdict about
 *    one daemon says nothing about a different one.
 */

import { describe, expect, test } from 'bun:test';
import {
  AGENT_DAEMON_BUILD_FLOOR,
  DaemonBuildGuard,
  readDaemonStatusPayload,
} from '../../runtime/daemon-build-compatibility.ts';

describe('the floor this product declares', () => {

  test('a daemon below 1.28.0 is refused adoption, through the constant this build actually declares', () => {
    const notices: string[] = [];
    const guard = new DaemonBuildGuard({
      floor: AGENT_DAEMON_BUILD_FLOOR,
      onDaemonUpdateRequired: (verdict) => { notices.push(verdict.message); },
    });

    // The question the adoption path actually asks.
    const verdict = guard.judgeForAdoption({ status: 'running', version: '1.27.1' });

    expect(verdict.status).toBe('daemon-update-required');
    expect(verdict.message).toContain('1.27.1');
    expect(verdict.message).toContain('1.28.0');
    // Refused, not merely noted: this is what leaves the spine local.
    expect(guard.mayUseDaemonCapabilities()).toBe(false);
    expect(notices).toHaveLength(1);
  });

  test('a daemon at or above 1.28.0 is adopted, through the constant this build actually declares', () => {
    const guard = new DaemonBuildGuard({ floor: AGENT_DAEMON_BUILD_FLOOR });

    const verdict = guard.judgeForAdoption({ status: 'running', version: '1.28.0' });

    expect(verdict.status).toBe('ok');
    expect(guard.mayUseDaemonCapabilities()).toBe(true);
  });
});

describe('judging for adoption, as the adoption path does', () => {
  test('an updated daemon is adoptable again: the refusal does not latch against a real newer build', () => {
    const guard = new DaemonBuildGuard({ floor: '1.28.0' });

    expect(guard.judgeForAdoption({ version: '1.27.1' }).status).toBe('daemon-update-required');
    expect(guard.mayUseDaemonCapabilities()).toBe(false);

    // The operator updates the daemon. The next adoption attempt must be able
    // to say yes, a latch here would strand the process on a fixed daemon.
    expect(guard.judgeForAdoption({ version: '1.28.0' }).status).toBe('ok');
    expect(guard.mayUseDaemonCapabilities()).toBe(true);
  });

  test('a daemon that goes back below the floor is announced again', () => {
    const notices: string[] = [];
    const guard = new DaemonBuildGuard({
      floor: '1.28.0',
      onDaemonUpdateRequired: (verdict) => { notices.push(verdict.message); },
    });

    guard.judgeForAdoption({ version: '1.27.1' });
    guard.judgeForAdoption({ version: '1.28.0' });
    // A different, older daemon now answers on the same address.
    guard.judgeForAdoption({ version: '1.26.0' });

    expect(notices).toHaveLength(2);
    expect(notices[1]).toContain('1.26.0');
  });

  test('repeated attempts against the same old daemon say it once', () => {
    const notices: string[] = [];
    const guard = new DaemonBuildGuard({
      floor: '1.28.0',
      onDaemonUpdateRequired: (verdict) => { notices.push(verdict.message); },
    });

    // The reconciler retries every heartbeat while the daemon stays refused.
    guard.judgeForAdoption({ version: '1.27.1' });
    guard.judgeForAdoption({ version: '1.27.1' });
    guard.judgeForAdoption({ version: '1.27.1' });

    expect(notices).toHaveLength(1);
  });

  test('an unreadable body is unknown, not ok: but unknown does not refuse adoption', () => {
    const guard = new DaemonBuildGuard({ floor: '1.28.0' });

    const verdict = guard.judgeForAdoption({ status: 'running' });

    // A peer that cannot prove its build is not reported as fine...
    expect(verdict.status).not.toBe('ok');
    // ...but it is still adopted. Only a POSITIVE reading of a too-old build
    // refuses. Refusing on an unreadable answer would turn one truncated
    // response into a lost adoption, which is the reachability probe's question
    // to answer, not the floor's.
    expect(verdict.status).not.toBe('daemon-update-required');
    expect(guard.mayUseDaemonCapabilities()).toBe(true);
  });
});

describe('judging an attached daemon', () => {
  test('a daemon at or above the floor is fine', () => {
    const guard = new DaemonBuildGuard({ floor: '1.20.0' });

    const verdict = guard.observeStatus({ status: 'running', version: '1.21.0' });

    expect(verdict.status).toBe('ok');
    expect(verdict.daemonVersion).toBe('1.21.0');
    expect(guard.mayUseDaemonCapabilities()).toBe(true);
  });

  test('a daemon below the floor is refused, naming both versions', () => {
    const guard = new DaemonBuildGuard({ floor: '1.21.0' });

    const verdict = guard.observeStatus({ status: 'running', version: '1.19.0' });

    expect(verdict.status).toBe('daemon-update-required');
    expect(verdict.message).toContain('1.19.0');
    expect(verdict.message).toContain('1.21.0');
    expect(guard.mayUseDaemonCapabilities()).toBe(false);
  });

  test('the peer is named, so an operator with two daemons knows which one', () => {
    const guard = new DaemonBuildGuard({ floor: '1.21.0' });

    const verdict = guard.observeStatus({ version: '1.19.0' }, 'http://nas.local:3421');

    expect(verdict.message).toContain('http://nas.local:3421');
  });

  test('a daemon that reports no version is unknown, not ok', () => {
    const guard = new DaemonBuildGuard({ floor: '1.21.0' });

    expect(guard.observeStatus({ status: 'running' }).status).toBe('unknown');
    expect(guard.observeStatus('not an object').status).toBe('unknown');
  });

  test('the owner is told once, not on every attach', () => {
    const seen: string[] = [];
    const guard = new DaemonBuildGuard({
      floor: '1.21.0',
      onDaemonUpdateRequired: (verdict) => { seen.push(verdict.message); },
    });

    guard.observeStatus({ version: '1.19.0' });
    guard.observeStatus({ version: '1.19.0' });
    guard.observeStatus({ version: '1.19.0' });

    expect(seen).toHaveLength(1);
  });

  test('the finding latches against a later unreadable read', () => {
    const guard = new DaemonBuildGuard({ floor: '1.21.0' });
    guard.observeStatus({ version: '1.19.0' });

    guard.observeStatus({ status: 'running' });

    expect(guard.current().status).toBe('daemon-update-required');
    expect(guard.mayUseDaemonCapabilities()).toBe(false);
  });

  test('reset drops the finding, for an attach to a different daemon', () => {
    const guard = new DaemonBuildGuard({ floor: '1.21.0' });
    guard.observeStatus({ version: '1.19.0' });

    guard.reset();

    expect(guard.mayUseDaemonCapabilities()).toBe(true);
    expect(guard.observeStatus({ version: '1.22.0' }).status).toBe('ok');
  });

  test('a fresh guard has observed nothing and claims nothing', () => {
    const guard = new DaemonBuildGuard({ floor: '1.21.0' });

    expect(guard.current().daemonVersion).toBeUndefined();
    expect(guard.mayUseDaemonCapabilities()).toBe(true);
  });
});

describe('reading the daemon build off /status', () => {
  test('the parsed body is returned', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ status: 'running', version: '1.21.0' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;

    const payload = await readDaemonStatusPayload({ baseUrl: 'http://d', token: 't' }, { fetchImpl });

    expect(payload).toMatchObject({ version: '1.21.0' });
  });

  test('an unreachable daemon yields null rather than throwing', async () => {
    // Null is "nothing observed", which the guard treats as no verdict at all,
    // an offline laptop must not be reported as running an old daemon.
    const fetchImpl = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;

    const payload = await readDaemonStatusPayload({ baseUrl: 'http://d', token: 't' }, { fetchImpl });

    expect(payload).toBeNull();
  });

  test('a non-2xx answer yields null', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;

    const payload = await readDaemonStatusPayload({ baseUrl: 'http://d', token: 't' }, { fetchImpl });

    expect(payload).toBeNull();
  });

  test('a body that is not JSON yields null', async () => {
    const fetchImpl = (async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch;

    const payload = await readDaemonStatusPayload({ baseUrl: 'http://d', token: 't' }, { fetchImpl });

    expect(payload).toBeNull();
  });

  test('an unreachable daemon leaves the guard with no verdict', async () => {
    const guard = new DaemonBuildGuard({ floor: '1.21.0' });
    const fetchImpl = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;

    const payload = await readDaemonStatusPayload({ baseUrl: 'http://d', token: null }, { fetchImpl });
    if (payload !== null) guard.observeStatus(payload);

    expect(guard.current().status).toBe('ok');
    expect(guard.current().daemonVersion).toBeUndefined();
  });
});

/**
 * The composed gate: /status read + verdict -> adopt or refuse.
 *
 * Mirrors services.mayAdoptDaemonBuild rather than constructing the whole
 * services graph, the same way daemon-receipts.test.ts mirrors
 * services.consumeDaemonReceipts. What it proves is the composition the
 * reconciler depends on: which readings refuse, and which do not.
 */
describe('the adoption gate as services composes it', () => {
  function gate(guard: DaemonBuildGuard, fetchImpl: typeof fetch) {
    return async (): Promise<boolean> => {
      const status = await readDaemonStatusPayload({ baseUrl: 'http://127.0.0.1:3421', token: null }, { fetchImpl });
      if (status === null) return true;
      return guard.judgeForAdoption(status, 'http://127.0.0.1:3421').status !== 'daemon-update-required';
    };
  }

  const respond = (body: unknown): typeof fetch => (async () => new Response(JSON.stringify(body), {
    status: 200, headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch;

  test('a daemon below the floor refuses adoption and names both versions once', async () => {
    const notices: string[] = [];
    const guard = new DaemonBuildGuard({
      floor: AGENT_DAEMON_BUILD_FLOOR,
      onDaemonUpdateRequired: (verdict) => { notices.push(verdict.message); },
    });

    expect(await gate(guard, respond({ status: 'running', version: '1.27.1' }))()).toBe(false);

    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('1.27.1');
    expect(notices[0]).toContain('1.28.0');
  });

  test('a daemon at the floor adopts', async () => {
    const guard = new DaemonBuildGuard({ floor: AGENT_DAEMON_BUILD_FLOOR });
    expect(await gate(guard, respond({ status: 'running', version: '1.28.0' }))()).toBe(true);
  });

  test('an unreachable daemon adopts: a dropped read is not evidence of an old build', async () => {
    const guard = new DaemonBuildGuard({ floor: AGENT_DAEMON_BUILD_FLOOR });
    const failing = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;

    // Refusing here would turn one failed request into a lost adoption. Whether
    // a daemon is answering at all is the reachability probe's question.
    expect(await gate(guard, failing)()).toBe(true);
  });

  test('a non-200 /status adopts, for the same reason', async () => {
    const guard = new DaemonBuildGuard({ floor: AGENT_DAEMON_BUILD_FLOOR });
    const serverError = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    expect(await gate(guard, serverError)()).toBe(true);
  });

  test('an updated daemon flips the gate back to adopt without restarting the process', async () => {
    const guard = new DaemonBuildGuard({ floor: AGENT_DAEMON_BUILD_FLOOR });

    expect(await gate(guard, respond({ version: '1.27.1' }))()).toBe(false);
    expect(await gate(guard, respond({ version: '1.28.3' }))()).toBe(true);
    expect(guard.mayUseDaemonCapabilities()).toBe(true);
  });
});

import { expect, test } from 'bun:test';
import { FakeClusterClock } from '@goodvibes-jev/engine/sdk/platform/cluster';
import { ownInboxEligibility } from '../../runtime/inbox-eligibility.js';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fixture() {
  const clock = new FakeClusterClock();
  const authority = new AbortController();
  let current = true;
  const proof = { signal: authority.signal, assertCurrent() { if (!current) throw new Error('revoked'); } };
  const events: string[] = [];
  let verification = async () => proof;
  let stopping = Promise.resolve();
  let calls = 0;
  const owner = ownInboxEligibility({ clock, verify() { calls++; return verification(); },
    control: { async start() { events.push('start'); }, async stop() { events.push('stop'); await stopping; events.push('drained'); } },
    register(control) {
      events.push('register');
      void control.start().catch(() => {});
      return async () => { events.push('withdraw'); await control.stop(); events.push('withdrawn'); };
    },
  });
  return { clock, authority, proof, owner, events, get calls() { return calls; },
    setVerify(next: typeof verification) { verification = next; },
    setStop(next: Promise<void>) { stopping = next; },
    invalidate() { current = false; },
  };
}

test('single-flight metadata probing preserves valid membership through transport uncertainty', async () => {
  const f = fixture(); await f.owner.ready;
  expect(f.events.filter(e => e === 'register')).toHaveLength(1);
  const held = Promise.withResolvers<typeof f.proof>();
  f.setVerify(() => held.promise);
  f.clock.advance(30_000); await flush();
  f.clock.advance(300_000); await flush();
  expect(f.calls).toBe(2);
  held.reject(new Error('transport unavailable')); await flush();
  expect(f.events).not.toContain('withdraw');
  expect(f.clock.pendingTimers).toBe(1);
  await f.owner.close(); expect(f.clock.pendingTimers).toBe(0);
});

test('actual revocation withdraws during a pending probe and replacement awaits exact drainage', async () => {
  const f = fixture(); await f.owner.ready;
  const held = Promise.withResolvers<typeof f.proof>();
  f.setVerify(() => held.promise); f.clock.advance(30_000); await flush();
  const stop = Promise.withResolvers<void>(); f.setStop(stop.promise);
  f.authority.abort(); await flush();
  expect(f.events).toContain('stop'); expect(f.events).not.toContain('withdrawn');
  const next = { signal: new AbortController().signal, assertCurrent() {} };
  held.resolve(next); await flush();
  expect(f.events.filter(e => e === 'register')).toHaveLength(1);
  stop.resolve(); await flush();
  expect(f.events.filter(e => e === 'register')).toHaveLength(2);
  expect(f.events.indexOf('withdrawn')).toBeLessThan(f.events.lastIndexOf('register'));
  await f.owner.close();
});

test('late initial proof cannot register after shutdown and close drains the admitted probe', async () => {
  const f = fixture(); const held = Promise.withResolvers<typeof f.proof>(); f.setVerify(() => held.promise);
  await flush(); let closed = false;
  const closing = f.owner.close().then(() => { closed = true; });
  await flush(); expect(closed).toBe(false);
  held.resolve(f.proof); await closing;
  expect(f.events).not.toContain('register'); expect(f.clock.pendingTimers).toBe(0);
});

test('invalid currentness withdraws on probe without inventing expiry for valid proof', async () => {
  const f = fixture(); await f.owner.ready;
  f.invalidate(); f.setVerify(async () => { throw new Error('unavailable'); });
  f.clock.advance(30_000); await flush();
  expect(f.events).toContain('withdrawn');
  await f.owner.close();
});

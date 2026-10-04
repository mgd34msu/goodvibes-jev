import { describe, expect, spyOn, test } from 'bun:test';
import { BrowserJudgmentError, type AuthenticatedPrincipal } from '../daemon-sdk/src/index.ts';
import { BrowserJudgmentReferences, type BrowserJudgmentReferenceSource } from '../sdk/src/platform/judgment-browser/index.ts';

const battery = 'webui.errors.daemon-refusal';
const owner: AuthenticatedPrincipal = { principalId: 'fixture-owner', principalKind: 'user', admin: true, scopes: ['write:judgment'] };
const source = (expiresAt = 200): BrowserJudgmentReferenceSource => ({ principalId: owner.principalId, battery,
  revision: 'fixture-r1', expiresAt, snapshot: { message: 'synthetic private source' }, assertCurrent() {}, mayRead: () => true });
const resolve = (refs: BrowserJudgmentReferences, id: string) => refs.resolve(id, () => owner, battery, (value) => value);

/** Exercise the owned callbacks synchronously, without relying on a busy CI clock. */
function timers() {
  const original = globalThis.setTimeout;
  const scheduled: { readonly delay: number; readonly fire: () => void; readonly handle: ReturnType<typeof setTimeout> }[] = [];
  // Proxy the native callable so all merged DOM/Node overloads and properties
  // (including __promisify__) remain intact. Only callable timers are controlled.
  const replacement = new Proxy(original, { apply(target, receiver: unknown, args: unknown[]) {
    const [callback, delay, ...forwarded] = args;
    if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
    const handle = original(() => {}, 60_000);
    handle.unref();
    scheduled.push({ delay: Number(delay), fire: () => Reflect.apply(callback, undefined, forwarded), handle });
    return handle;
  } });
  const spy = spyOn(globalThis, 'setTimeout').mockImplementation(replacement);
  return { scheduled, restore() { spy.mockRestore(); for (const timer of scheduled) clearTimeout(timer.handle); } };
}

describe('owned browser reference retention', () => {
  test('a throwing snapshot getter is normalized without retaining private exception text', () => {
    const refs = new BrowserJudgmentReferences(() => 100); let reads = 0;
    try {
      const entry = { ...source(), get snapshot(): unknown { reads++; throw new Error('synthetic-private-source-detail'); } };
      let failure: unknown;
      try { refs.issue(entry); } catch (error) { failure = error; }
      expect(reads).toBe(1); expect(failure).toBeInstanceOf(BrowserJudgmentError);
      expect(failure).toMatchObject({ code: 'JUDGMENT_REFERENCE_HELD' });
      expect(String(failure)).not.toContain('synthetic-private-source-detail');
    } finally { refs.close(); }
  });

  test.each(['already closed', 'assertion closes'] as const)('%s refuses before reading the supplied snapshot', (stage) => {
    const refs = new BrowserJudgmentReferences(() => 100); let reads = 0;
    try {
      const entry = { ...source(), assertCurrent() { if (stage === 'assertion closes') refs.close(); },
        get snapshot(): unknown { reads++; throw new Error('synthetic-private-source-detail'); } };
      if (stage === 'already closed') refs.close();
      expect(() => refs.issue(entry)).toThrow(BrowserJudgmentError); expect(reads).toBe(0);
    } finally { refs.close(); }
  });

  test('a successful snapshot getter is captured exactly once', () => {
    const refs = new BrowserJudgmentReferences(() => 100); let reads = 0;
    try {
      const id = refs.issue({ ...source(), get snapshot() { reads++; return { message: 'synthetic captured source' }; } });
      expect(reads).toBe(1); expect(resolve(refs, id).state).toEqual({ message: 'synthetic captured source' });
      expect(reads).toBe(1);
    } finally { refs.close(); }
  });

  test('an issue assertion cannot admit storage or a timer after reentrant close', () => {
    const clock = timers(); const refs = new BrowserJudgmentReferences(() => 100);
    try {
      expect(() => refs.issue({ ...source(), assertCurrent() { refs.close(); } })).toThrow(BrowserJudgmentError);
      expect(clock.scheduled).toHaveLength(0);
    } finally { refs.close(); clock.restore(); }
  });

  test('an issue assertion cannot overfill capacity through reentry', () => {
    const clock = timers(); const refs = new BrowserJudgmentReferences(() => 100);
    try {
      expect(() => refs.issue({ ...source(), assertCurrent() {
        for (let i = 0; i < 64; i++) refs.issue(source());
      } })).toThrow(BrowserJudgmentError);
      expect(clock.scheduled).toHaveLength(64);
    } finally { refs.close(); clock.restore(); }
  });

  test.each(['principal', 'permission', 'assertion', 'parser'] as const)('a %s callback cannot swap another principal snapshot into a lease', (stage) => {
    const clock = timers(); const refs = new BrowserJudgmentReferences(() => 100);
    const uuid = spyOn(crypto, 'randomUUID').mockReturnValue('11111111-1111-4111-8111-111111111111');
    let swapping = false; let id = ''; let parses = 0;
    const swap = () => {
      if (!swapping) return;
      swapping = false; refs.revoke(id);
      refs.issue({ ...source(), principalId: 'another-principal', snapshot: { message: 'another synthetic private source' } });
    };
    try {
      id = refs.issue({ ...source(), assertCurrent() { if (stage === 'assertion') swap(); },
        mayRead() { if (stage === 'permission') swap(); return true; } });
      swapping = true;
      expect(() => refs.resolve(id, () => { if (stage === 'principal') swap(); return owner; }, battery, (value) => {
        parses++; expect(value).toEqual(source().snapshot); if (stage === 'parser') swap(); return value;
      })).toThrow(BrowserJudgmentError);
      expect(parses).toBe(stage === 'parser' ? 1 : 0);
    } finally { uuid.mockRestore(); refs.close(); clock.restore(); }
  });

  test('a parser-triggered close cannot return a successful stale lease', () => {
    const clock = timers(); const refs = new BrowserJudgmentReferences(() => 100);
    try {
      const id = refs.issue(source());
      expect(() => refs.resolve(id, () => owner, battery, (value) => { refs.close(); return value; })).toThrow(BrowserJudgmentError);
    } finally { refs.close(); clock.restore(); }
  });

  test('expiry physically removes the snapshot and timer without another reference request', () => {
    const clock = timers(); const refs = new BrowserJudgmentReferences(() => 100);
    try {
      const id = refs.issue(source());
      expect(clock.scheduled).toHaveLength(1);
      expect(clock.scheduled[0]!.delay).toBe(100);
      expect(clock.scheduled[0]!.handle.hasRef()).toBe(false);
      const remove = spyOn(Map.prototype, 'delete');
      try {
        clock.scheduled[0]!.fire();
        // Inspect actual storage deletion BEFORE resolve/sweep/close can help.
        const indices = remove.mock.calls.flatMap(([key], index) => key === id ? [index] : []);
        expect(indices).toHaveLength(2);
        for (const index of indices) {
          const storage = remove.mock.contexts[index] as Map<unknown, unknown>;
          expect(storage.has(id)).toBe(false); expect(storage.size).toBe(0);
        }
      } finally { remove.mockRestore(); }
      expect(() => resolve(refs, id)).toThrow(BrowserJudgmentError);
    } finally { refs.close(); clock.restore(); }
  });

  test('revocation and close cancel their timers, close refuses new admission', () => {
    const clock = timers(); const refs = new BrowserJudgmentReferences(() => 100);
    const clear = spyOn(globalThis, 'clearTimeout');
    try {
      const first = refs.issue(source()); const second = refs.issue(source());
      const firstLease = resolve(refs, first); const secondLease = resolve(refs, second);
      refs.revoke(first);
      expect(firstLease.signal?.aborted).toBe(true); expect(secondLease.signal?.aborted).toBe(false);
      expect(clear).toHaveBeenCalledWith(clock.scheduled[0]!.handle);
      expect(() => resolve(refs, first)).toThrow(BrowserJudgmentError);
      expect(() => resolve(refs, second)).not.toThrow();
      refs.close();
      expect(secondLease.signal?.aborted).toBe(true);
      expect(clear).toHaveBeenCalledWith(clock.scheduled[1]!.handle);
      expect(() => resolve(refs, second)).toThrow(BrowserJudgmentError);
      expect(() => refs.issue(source())).toThrow(BrowserJudgmentError);
      for (const timer of clock.scheduled) timer.fire();
      expect(() => resolve(refs, second)).toThrow(BrowserJudgmentError);
    } finally { clear.mockRestore(); refs.close(); clock.restore(); }
  });

  test('an expired lease and delayed old callback cannot acquire a reused reference identity', () => {
    const clock = timers(); const refs = new BrowserJudgmentReferences(() => 100);
    const uuid = spyOn(crypto, 'randomUUID').mockReturnValue('11111111-1111-4111-8111-111111111111');
    try {
      const id = refs.issue(source()); const old = resolve(refs, id);
      expect(() => refs.issue(source())).toThrow(BrowserJudgmentError);
      refs.revoke(id); expect(refs.issue(source())).toBe(id);
      const current = resolve(refs, id);
      expect(old.signal?.aborted).toBe(true); expect(current.signal?.aborted).toBe(false);
      expect(old.assertCurrent).toThrow(BrowserJudgmentError);
      clock.scheduled[0]!.fire(); expect(current.assertCurrent).not.toThrow(); expect(current.signal?.aborted).toBe(false);
      clock.scheduled[1]!.fire(); expect(current.assertCurrent).toThrow(BrowserJudgmentError); expect(current.signal?.aborted).toBe(true);
    } finally { uuid.mockRestore(); refs.close(); clock.restore(); }
  });

  test('wall-clock rollback cannot schedule retention beyond five minutes', () => {
    const clock = timers(); let now = 100; const refs = new BrowserJudgmentReferences(() => now);
    try {
      const id = refs.issue({ ...source(200), assertCurrent() { now = -1_000_000; } });
      expect(clock.scheduled[0]!.delay).toBe(300_000);
      clock.scheduled[0]!.fire();
      expect(() => resolve(refs, id)).toThrow(BrowserJudgmentError);
    } finally { refs.close(); clock.restore(); }
  });

  test('a scheduling failure leaves no snapshot or timer reservation', () => {
    const refs = new BrowserJudgmentReferences(() => 100);
    const uuid = spyOn(crypto, 'randomUUID').mockReturnValue('11111111-1111-4111-8111-111111111111');
    const replacement = new Proxy(globalThis.setTimeout, { apply() { throw new Error('synthetic private timer failure'); } });
    const fail = spyOn(globalThis, 'setTimeout').mockImplementation(replacement);
    try {
      expect(() => refs.issue(source())).toThrow(BrowserJudgmentError);
      fail.mockRestore();
      expect(() => refs.issue(source())).not.toThrow();
    } finally { fail.mockRestore(); uuid.mockRestore(); refs.close(); }
  });
});

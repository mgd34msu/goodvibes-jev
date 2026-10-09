import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { wireStreamEventMetrics, createStreamMetrics, type WireStreamEventMetricsOptions } from '../../core/stream-event-wiring.ts';
import { createErrorNoticeOwner } from '../../core/format-user-error.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
const flush = () => new Promise<void>(r => setTimeout(r, 0));
function gate() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }
function bus() {
  const callbacks = new Map<string, Set<(event: Record<string, unknown>) => void>>();
  return {
    on(type: string, callback: (event: Record<string, unknown>) => void) { const set = callbacks.get(type) ?? new Set(); set.add(callback); callbacks.set(type, set); return () => { set.delete(callback); }; },
    emit(type: string, value: Record<string, unknown> = {}) { for (const callback of [...callbacks.get(type) ?? []]) callback({ type, ...value }); },
  };
}
function installSetupReader(wait?: Promise<void>, reject = false) {
  const fake = fakePort((name, _q, state) => noulAnswer((name === 'api_key' && String(state).includes('Direct provider API key')) || (name === 'subscription' && String(state).includes('Stored subscription session')) ? 0.99 : 0.01));
  const signals: AbortSignal[] = [];
  installJudgmentPort({ ...fake.port, async ask(request) { if (request.signal) signals.push(request.signal); await wait; if (reject) throw new Error('unavailable'); return fake.port.ask(request); } });
  return { ...fake, signals };
}
function fixture(options: { timeout?: number; metadataWait?: Promise<void>; noIdentity?: boolean } = {}) {
  const turns = bus(), tools = bus(), providers = bus(); const messages: string[] = [], retries: string[] = [];
  const instances = { first: {}, second: {} };
  let model = 'first:one', session = 'session-a', switches = 0, renders = 0, enabled = true;
  const wiring = wireStreamEventMetrics({
    events: { turns, tools, providers } as unknown as WireStreamEventMetricsOptions['events'],
    orchestrator: { streamingOutputTokens: 0 }, metrics: createStreamMetrics(), render: () => { renders++; },
    getSessionId: () => session, errorNoticeTimeoutMs: options.timeout ?? 100,
    providerRegistry: {
      getCurrentModel: () => ({ provider: model.split(':')[0]!, registryKey: model }),
      setCurrentModel: key => { model = key; switches++; },
      getRegistered: options.noIdentity ? undefined : id => instances[id as keyof typeof instances],
      describeRuntime: async id => { await options.metadataWait; return { setup: { description: id === 'first' ? 'Direct provider API key' : 'Stored subscription session' } }; },
    },
    providerOptimizer: { get enabled() { return enabled; }, fallbackLog: [], testFallback: () => ({ chain: [{ providerId: 'first', modelId: 'one', capable: true, position: 0 }, { providerId: 'second', modelId: 'two', capable: true, position: 1 }] }), recordFallbackTransition() {} },
    systemMessageRouter: { high: text => { messages.push(text); }, low() {}, userReceipt: text => { messages.push(text); } },
    retryTurn: notice => { messages.length = 0; messages.push(notice ?? ''); retries.push(notice ?? ''); return true; },
  });
  turns.emit('TURN_SUBMITTED', { turnId: 'a' });
  return { turns, providers, messages, retries, instances, wiring, switches: () => switches, renders: () => renders,
    error: () => turns.emit('TURN_ERROR', { turnId: 'a', error: { status: 429, message: '' } }), session: () => { session = 'b'; },
    enable: (value: boolean) => { enabled = value; },
    close: () => { for (const unsubscribe of wiring.unsubs) unsubscribe(); } };
}

describe('real failover caller joins setup facts to owned error delivery', () => {
  test('delayed provider facts arrive before one retry and survive its transcript rollback', async () => {
    const held = gate(); installSetupReader(held.promise); const f = fixture();
    try { f.error(); await flush(); expect(f.retries).toHaveLength(0); expect(f.switches()).toBe(0);
      held.release(); await flush(); expect(f.retries).toHaveLength(1);
      expect(f.messages).toEqual(f.retries); expect(f.messages[0]).toContain('billing: API key → Subscription: billing class changed');
      expect(f.messages[0]).toContain('Rate limit reached');
    } finally { f.close(); }
  });
  for (const boundary of ['cancel', 'new-turn', 'new-session', 'dispose'] as const) {
    test(`delayed setup cannot narrate or retry after ${boundary}`, async () => {
      const held = gate(); const reader = installSetupReader(held.promise); const f = fixture(); f.error(); await flush();
      if (boundary === 'cancel') f.turns.emit('TURN_CANCEL', { turnId: 'a' });
      if (boundary === 'new-turn') f.turns.emit('TURN_SUBMITTED', { turnId: 'b' });
      if (boundary === 'new-session') f.session();
      if (boundary === 'dispose') f.close();
      const renders = f.renders(); held.release(); await flush();
      expect(f.messages).toEqual([]); expect(f.retries).toEqual([]); expect(f.switches()).toBe(0); expect(f.renders()).toBe(renders);
      if (boundary !== 'new-session') expect(reader.signals.every(signal => signal.aborted)).toBe(true);
      f.close();
    });
  }
  test('setup deadline keeps a successful error reading and uses explicit Unknown without a late update', async () => {
    const held = gate(); const reader = installSetupReader(held.promise); const f = fixture({ timeout: 10 });
    try { f.error(); await new Promise(r => setTimeout(r, 25));
      expect(f.retries).toHaveLength(1); expect(f.messages[0]).toContain('Rate limit reached');
      expect(f.messages[0]).toContain('billing: Unknown → Unknown'); expect(f.messages[0]).not.toContain('Error details unavailable');
      expect(reader.signals.every(signal => signal.aborted)).toBe(true);
      const before = [...f.messages]; held.release(); await flush(); expect(f.messages).toEqual(before); expect(f.retries).toHaveLength(1);
    } finally { f.close(); }
  });
  test('unavailable setup does not change existing optimizer dispatch permission', async () => {
    installSetupReader(undefined, true); const f = fixture();
    try { f.error(); await flush(); expect(f.retries).toHaveLength(1); expect(f.switches()).toBe(1); expect(f.messages[0]).toContain('Unknown'); }
    finally { f.close(); }
  });
  test('a hanging metadata provider is bounded by the same total notice deadline', async () => {
    const held = gate(); const reader = installSetupReader(); const f = fixture({ timeout: 10, metadataWait: held.promise });
    try { f.error(); await new Promise(r => setTimeout(r, 25)); expect(f.retries).toHaveLength(1); expect(f.messages[0]).toContain('Unknown');
      held.release(); await flush(); expect(reader.requests).toHaveLength(0); expect(f.retries).toHaveLength(1);
    } finally { f.close(); }
  });
  test('credential/config generation replacement invalidates only stale billing narration', async () => {
    const held = gate(); installSetupReader(held.promise); const f = fixture();
    try { f.error(); await flush(); f.providers.emit('PROVIDERS_CHANGED', { added: [], removed: [], updated: ['second'] });
      held.release(); await flush(); expect(f.retries).toHaveLength(1); expect(f.messages[0]).toContain('billing: Unknown → Unknown');
      expect(f.messages[0]).not.toContain('Subscription');
    } finally { f.close(); }
  });
  test('a completed side is rechecked after the other provider finishes its delayed setup read', async () => {
    const held = gate(); const fake = installSetupReader();
    installJudgmentPort({ ...fake.port, async ask(request) {
      if (String(request.state).includes('Stored subscription session')) await held.promise;
      return fake.port.ask(request);
    } });
    const f = fixture();
    try { f.error(); await flush(); f.instances.first = {}; held.release(); await flush();
      expect(f.retries).toHaveLength(1); expect(f.messages[0]).toContain('billing: Unknown → Subscription');
    } finally { f.close(); }
  });
  test('prepared setup identities are rechecked at delivery after waiting behind another notice', async () => {
    const held = gate(); const fake = installSetupReader();
    installJudgmentPort({ ...fake.port, async ask(request) {
      if (request.context?.site === 'tui.stream-error') await held.promise;
      return fake.port.ask(request);
    } });
    const f = fixture();
    try {
      f.turns.emit('TURN_ERROR', { turnId: 'a', error: 'first notice holds the ordered queue' });
      f.error(); await flush();
      f.instances.first = {};
      // Let the first notice surface without switching; its completed callback
      // restores the already-authorized optimizer for the queued second notice.
      f.enable(false); f.wiring.onErrorSurfaced(() => f.enable(true));
      held.release(); await flush();
      expect(f.retries).toHaveLength(1); expect(f.messages.at(-1)).toContain('billing: Unknown → Subscription');
    } finally { f.close(); }
  });
  test('missing live instance lookup cannot establish current setup narration', async () => {
    const reader = installSetupReader(); const f = fixture({ noIdentity: true });
    try { f.error(); await flush(); expect(f.retries).toHaveLength(1);
      expect(f.messages[0]).toContain('billing: Unknown → Unknown'); expect(reader.requests).toHaveLength(0);
    } finally { f.close(); }
  });
  test('a missing instance is not current merely because both lookups returned undefined', async () => {
    const reader = installSetupReader(); const f = fixture();
    f.instances.second = undefined as unknown as object;
    try { f.error(); await flush(); expect(f.retries).toHaveLength(1);
      expect(f.messages[0]).toContain('billing: API key → Unknown'); expect(reader.requests).toHaveLength(1);
    } finally { f.close(); }
  });
  for (const [variant, labels, changed] of [
    ['unknown-from', 'Unknown → Subscription', false],
    ['unknown-to', 'API key → Unknown', false],
    ['known-same', 'API key → API key', false],
    ['known-different', 'API key → Subscription', true],
  ] as const) {
    test(`billing change assertion requires known different classes: ${variant}`, async () => {
      if (variant === 'known-same') installJudgmentPort(fakePort(name => noulAnswer(name === 'api_key' ? 0.99 : 0.01)).port);
      else installSetupReader();
      const f = fixture();
      if (variant === 'unknown-from') f.instances.first = undefined as unknown as object;
      if (variant === 'unknown-to') f.instances.second = undefined as unknown as object;
      try { f.error(); await flush(); expect(f.retries).toHaveLength(1);
        expect(f.messages[0]).toContain('billing: ' + labels);
        expect(f.messages[0]!.includes('billing class changed')).toBe(changed);
      } finally { f.close(); }
    });
  }
  test('provider instance replacement cannot inherit a delayed setup reading before its event arrives', async () => {
    const held = gate(); installSetupReader(held.promise); const f = fixture();
    try { f.error(); await flush(); f.instances.second = {}; held.release(); await flush();
      expect(f.retries).toHaveLength(1); expect(f.messages[0]).toContain('billing: API key → Unknown');
    } finally { f.close(); }
  });
});

test('the shared notice queue contains preparation rejection without losing a successful error', async () => {
  const owner = createErrorNoticeOwner(10); const messages: string[] = [];
  owner.enqueue({ status: 429 }, 'test', { isCurrent: () => true, prepare: async () => { throw new Error('failed setup'); }, deliver: reading => { messages.push(reading?.kind ?? 'missing'); } });
  await flush(); expect(messages).toEqual(['rate-limit']); owner.dispose();
});

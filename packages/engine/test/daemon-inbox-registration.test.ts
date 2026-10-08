import { expect, spyOn, test } from 'bun:test';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.js';
import { InboxCursorStore } from '../sdk/src/platform/intake/cursor-store.js';
import { registerInboxSurface, INBOX_LIST_METHOD_ID, type InboxPollingControl, type InboxSurfaceContext } from '../sdk/src/platform/intake/registration.js';
import type { InboundProviderAdapter } from '../sdk/src/platform/intake/provider-adapter.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { resolve, promise }; }
function fixture() {
  const messages: unknown[] = [];
  const ctx: InboxSurfaceContext = { catalog: new GatewayMethodCatalog(), workingDirectory: makeProjectTempDir('inbox-registration'), logger: { info(...args) { messages.push(args); }, warn(...args) { messages.push(args); }, error(...args) { messages.push(args); } } };
  return { ctx, messages };
}
function adapter(poll: InboundProviderAdapter['poll'] = async () => ({ items: [], state: 'empty', configured: true })): InboundProviderAdapter {
  return { id: 'fixture', pollIntervalMs: 3_600_000, poll };
}
function invoke(ctx: InboxSurfaceContext, body: unknown = {}, query?: Record<string, unknown>) {
  return ctx.catalog.invoke(INBOX_LIST_METHOD_ID, { body, ...(query ? { query } : {}), context: {} });
}

test('adapter membership is required explicitly rather than silently defaulting empty', () => {
  const { ctx } = fixture();
  expect(() => registerInboxSurface(ctx, {} as never)).toThrow('Inbox adapters must be supplied explicitly');
  expect(ctx.catalog.hasHandler(INBOX_LIST_METHOD_ID)).toBe(false);
});

test('the real method reports persisted fixture items and configuration evidence', async () => {
  const { ctx, messages } = fixture();
  const registration = registerInboxSurface(ctx, { adapters: new Map([['fixture', adapter(async () => ({
    items: [{ id: 'fixture-one', provider: 'fixture', kind: 'dm', fromDigest: 'fixture-sender', subjectPreview: 'Fixture subject', bodyPreview: 'Fixture local body', receivedAt: Date.now(), unread: true }], state: 'ready', configured: true,
  }))]]) });
  try {
    await registration.ready;
    expect(await invoke(ctx, {}, { limit: '1' })).toMatchObject({ total: 1, items: [{ id: 'fixture-one' }], providers: [{ provider: 'fixture', configured: true, syncing: true }] });
    expect(JSON.stringify(messages)).not.toContain('Fixture local body');
    expect(ctx.catalog.get(INBOX_LIST_METHOD_ID)?.scopes).toContain('read:channels');
  } finally { await registration.close(); }
});

test('gated registration is readable before ownership and never starts a poll itself', async () => {
  const { ctx } = fixture(); let polls = 0; let control!: InboxPollingControl;
  const registration = registerInboxSurface(ctx, { adapters: new Map([['fixture', adapter(async () => { polls++; return { items: [], state: 'empty', configured: true }; })]]), gatePolling(_id, offered) { control = offered; } });
  try {
    await registration.ready;
    expect(polls).toBe(0);
    expect(await invoke(ctx)).toMatchObject({ providers: [{ provider: 'fixture', syncing: false }] });
    await control.start();
    expect(polls).toBe(1);
    await control.start();
    expect(polls).toBe(1);
    await control.stop();
    expect(await invoke(ctx)).toMatchObject({ providers: [{ syncing: false }] });
  } finally { await registration.close(); }
});

test('a returned provider ownership starts with a fresh seed poll', async () => {
  const { ctx } = fixture(); let polls = 0; let control!: InboxPollingControl;
  const registration = registerInboxSurface(ctx, { adapters: new Map([['fixture', adapter(async () => { polls++; return { items: [], state: 'empty', configured: true }; })]]), gatePolling(_id, offered) { control = offered; } });
  try {
    await registration.ready; await control.start(); await control.stop(); await control.start();
    expect(polls).toBe(2);
  } finally { await registration.close(); }
});

test('leadership stop before cold readiness prevents a late seed or timer', async () => {
  const { ctx } = fixture(); const entered = deferred(); const release = deferred(); let polls = 0; let control!: InboxPollingControl;
  const original = InboxCursorStore.prototype.init;
  const init = spyOn(InboxCursorStore.prototype, 'init').mockImplementation(async function (this: InboxCursorStore) { entered.resolve(); await release.promise; return original.call(this); });
  const registration = registerInboxSurface(ctx, { adapters: new Map([['fixture', adapter(async () => { polls++; return { items: [], state: 'empty' }; })]]), gatePolling(_id, offered) { control = offered; } });
  const starting = control.start(); void starting.catch(() => {});
  try {
    await entered.promise; const stopping = control.stop(); release.resolve();
    await expect(starting).rejects.toMatchObject({ code: 'INBOX_SURFACE_STOPPED' });
    await stopping; await registration.ready;
    expect(polls).toBe(0);
    expect(await invoke(ctx)).toMatchObject({ providers: [{ syncing: false }] });
  } finally { release.resolve(); await Promise.allSettled([starting, registration.close()]); init.mockRestore(); }
});

test('surface close aborts and drains an ignored-signal seed before closing storage', async () => {
  const { ctx } = fixture(); const entered = deferred(); const release = deferred(); let signal: AbortSignal | undefined;
  const registration = registerInboxSurface(ctx, { adapters: new Map([['fixture', adapter(async (input) => { signal = input.signal; entered.resolve(); await release.promise; return { items: [], state: 'empty' }; })]]) });
  void registration.ready.catch(() => {});
  try {
    await entered.promise;
    const closing = registration.close(); let closed = false; void closing.then(() => { closed = true; });
    expect(signal?.aborted).toBe(true); await Promise.resolve(); expect(closed).toBe(false);
    release.resolve(); await closing;
    await expect(registration.ready).rejects.toMatchObject({ code: 'INBOX_SURFACE_STOPPED' });
    expect(closed).toBe(true);
  } finally { release.resolve(); await registration.close(); }
});

test('bootstrap failure rejects readiness instead of returning a fabricated empty feed', async () => {
  const { ctx, messages } = fixture();
  const init = spyOn(InboxCursorStore.prototype, 'init').mockRejectedValue(new Error('fixture-sensitive-path'));
  const registration = registerInboxSurface(ctx, { adapters: new Map() });
  try {
    await expect(registration.ready).rejects.toMatchObject({ code: 'INBOX_SURFACE_START_FAILED' });
    await expect(invoke(ctx)).rejects.toMatchObject({ code: 'INBOX_SURFACE_START_FAILED' });
    expect(JSON.stringify(messages)).not.toContain('fixture-sensitive-path');
    await registration.close();
  } finally { init.mockRestore(); await registration.close(); }
});

test('same-catalog restart works and a retired control cannot revive old polling', async () => {
  const { ctx } = fixture(); let control!: InboxPollingControl;
  const first = registerInboxSurface(ctx, { adapters: new Map([['fixture', adapter()]]), gatePolling(_id, offered) { control = offered; } });
  await first.ready; await first.close();
  const next = registerInboxSurface(ctx, { adapters: new Map() });
  try {
    await next.ready; first.unregister(); await first.close();
    expect(ctx.catalog.hasHandler(INBOX_LIST_METHOD_ID)).toBe(true);
    await expect(control.start()).rejects.toMatchObject({ code: 'INBOX_SURFACE_STOPPED' });
    expect(await invoke(ctx)).toMatchObject({ items: [], total: 0 });
  } finally { await next.close(); }
});

test('close publishes its promise before a gate cleanup can reenter it', async () => {
  const { ctx } = fixture(); const release = deferred(); let reentered: Promise<void> | undefined;
  let registration!: ReturnType<typeof registerInboxSurface>;
  registration = registerInboxSurface(ctx, { adapters: new Map([['fixture', adapter()]]), gatePolling() { return async () => { reentered = registration.close(); await release.promise; }; } });
  try {
    await registration.ready;
    const closing = registration.close();
    expect(reentered).toBe(closing);
    release.resolve(); await closing;
  } finally { release.resolve(); await registration.close(); }
});

test('all gate cleanup runs and failure stays observable with value-free diagnostics', async () => {
  const { ctx, messages } = fixture(); const retired: string[] = [];
  const registration = registerInboxSurface(ctx, { adapters: new Map([['one', { ...adapter(), id: 'one' }], ['two', { ...adapter(), id: 'two' }]]), gatePolling(id) { return () => { retired.push(id); if (id === 'two') throw new Error('fixture-sensitive-cleanup'); }; } });
  await registration.ready; registration.unregister();
  await expect(registration.close()).rejects.toBeInstanceOf(AggregateError);
  expect(retired).toEqual(['two', 'one']);
  expect(JSON.stringify(messages)).not.toContain('fixture-sensitive-cleanup');
});

test('failed accepted reads do not become cleanup failures during shutdown', async () => {
  const { ctx } = fixture(); const entered = deferred(); const release = deferred();
  const init = spyOn(InboxCursorStore.prototype, 'init').mockImplementation(async () => { entered.resolve(); await release.promise; throw new Error('fixture storage failed'); });
  const registration = registerInboxSurface(ctx, { adapters: new Map() });
  const reading = invoke(ctx); void reading.catch(() => {});
  try {
    await entered.promise;
    const closing = registration.close(); release.resolve();
    await expect(reading).rejects.toMatchObject({ code: 'INBOX_SURFACE_START_FAILED' });
    await closing;
  } finally { release.resolve(); await Promise.allSettled([reading, registration.close()]); init.mockRestore(); }
});

test('a gate cannot deadlock close by returning that same promise as its cleanup', async () => {
  const { ctx } = fixture(); let registration!: ReturnType<typeof registerInboxSurface>;
  registration = registerInboxSurface(ctx, { adapters: new Map([['fixture', adapter()]]), gatePolling() { return () => registration.close(); } });
  await registration.ready;
  await expect(registration.close()).rejects.toBeInstanceOf(AggregateError);
});

test('a product account guard withholds stored rows and sanitizes its rejection', async () => {
  const { ctx } = fixture(); let permitted = true;
  const registration = registerInboxSurface(ctx, { adapters: new Map([['fixture', adapter()]]),
    assertReadCurrent() { if (!permitted) throw new Error('private-account-marker'); },
  });
  try {
    await registration.ready; expect(await invoke(ctx)).toMatchObject({ items: [] }); permitted = false;
    await expect(invoke(ctx)).rejects.toMatchObject({ code: 'INBOX_SCOPE_UNAVAILABLE', message: 'Inbox account scope is unavailable' });
  } finally { await registration.close(); }
});

test('account scope is rechecked after the mirror snapshot before returning rows', async () => {
  const { ctx } = fixture(); let permitted = true; let reads = 0;
  const original = InboxCursorStore.prototype.listItems;
  const query = spyOn(InboxCursorStore.prototype, 'listItems').mockImplementation(function (this: InboxCursorStore, ...args) {
    const result = original.apply(this, args);
    reads += 1;
    queueMicrotask(() => { permitted = false; });
    return result;
  });
  const registration = registerInboxSurface(ctx, { adapters: new Map(), assertReadCurrent() { if (!permitted) throw new Error('private'); } });
  const reading = invoke(ctx); void reading.catch(() => {});
  try {
    await expect(reading).rejects.toMatchObject({ code: 'INBOX_SCOPE_UNAVAILABLE' });
    expect(reads).toBe(1);
  } finally { await Promise.allSettled([reading, registration.close()]); query.mockRestore(); }
});

test('default gated start waits for the admitted initial seed to complete', async () => {
  const { ctx } = fixture(); const entered = deferred(), release = deferred();
  let control!: InboxPollingControl, started = false;
  const registration = registerInboxSurface(ctx, {
    adapters: new Map([['fixture', adapter(async () => {
      entered.resolve(); await release.promise;
      return { items: [], state: 'empty', configured: true };
    })]]), gatePolling(_id, offered) { control = offered; },
  });
  const starting = control.start().then(() => { started = true; });
  void starting.catch(() => {});
  try {
    await entered.promise; await Promise.resolve();
    expect(started).toBe(false);
    release.resolve(); await starting;
    expect(started).toBe(true);
  } finally { release.resolve(); await Promise.allSettled([starting, registration.close()]); }
});

test.each(['stop', 'close'] as const)('admission-only start resolves while seed is held; %s drains and discards late rows', async retirement => {
  const { ctx } = fixture(); const entered = deferred(), release = deferred();
  let control!: InboxPollingControl, signal: AbortSignal | undefined, polls = 0;
  const registration = registerInboxSurface(ctx, {
    awaitInitialPoll: false,
    adapters: new Map([['fixture', adapter(async input => {
      polls++; signal = input.signal; entered.resolve(); await release.promise;
      return { items: [{ id: 'late-seed-row', provider: 'fixture', kind: 'dm', fromDigest: 'synthetic',
        subjectPreview: 'Synthetic late seed', bodyPreview: 'Synthetic body', receivedAt: Date.now(), unread: true }],
      state: 'ready', configured: true };
    })]]), gatePolling(_id, offered) { control = offered; },
  });
  try {
    await registration.ready; await control.start();
    // Startup completion is admission, not a detached unstarted task.
    expect(polls).toBe(1); expect(signal?.aborted).toBe(false);
    await entered.promise;
    await control.start(); expect(polls).toBe(1);
    expect(await invoke(ctx)).toMatchObject({ items: [], total: 0 });
    let retired = false;
    const retiring = (retirement === 'stop' ? control.stop() : registration.close()).then(() => { retired = true; });
    await Promise.resolve();
    expect(signal?.aborted).toBe(true); expect(retired).toBe(false);
    release.resolve(); await retiring;
    expect(retired).toBe(true); expect(polls).toBe(1);
    if (retirement === 'stop') expect(await invoke(ctx)).toMatchObject({ items: [], total: 0 });
    await registration.close();
    const reopened = new InboxCursorStore(ctx.workingDirectory);
    try {
      await reopened.init();
      expect(reopened.listItems({ limit: 10 })).toEqual([]);
      expect(reopened.getCursor('fixture')).toBe(0);
    } finally { await reopened.close(); }
  } finally { release.resolve(); await registration.close(); }
});

test.each(['storage', 'gate'] as const)('admission-only startup cannot bypass %s preparation failure', async failure => {
  const { ctx } = fixture(); let control!: InboxPollingControl, polls = 0;
  const init = failure === 'storage'
    ? spyOn(InboxCursorStore.prototype, 'init').mockRejectedValue(new Error('Synthetic initialization failure')) : undefined;
  const registration = registerInboxSurface(ctx, {
    awaitInitialPoll: false,
    adapters: new Map([['fixture', adapter(async () => { polls++; return { items: [], state: 'empty' }; })]]),
    gatePolling(_id, offered) {
      control = offered;
      if (failure === 'gate') throw new Error('Synthetic gate preparation failure');
    },
  });
  try {
    await expect(registration.ready).rejects.toMatchObject({ code: 'INBOX_SURFACE_START_FAILED' });
    await expect(control.start()).rejects.toMatchObject({ code: 'INBOX_SURFACE_START_FAILED' });
    expect(polls).toBe(0);
  } finally { await registration.close(); init?.mockRestore(); }
});

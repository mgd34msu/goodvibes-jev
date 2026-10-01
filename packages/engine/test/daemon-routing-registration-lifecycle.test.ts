import { expect, spyOn, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { RouteStore } from '../sdk/src/platform/channels/host-routing/route-store.js';
import { registerRoutingMethods } from '../sdk/src/platform/channels/host-routing/registration.js';
import { makeHandlerContext, makeInvocation, makeTmpWorkingDir } from './_helpers/routing-registration.js';

function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { resolve, promise }; }
const list = 'channels.routing.list';
const assign = 'channels.routing.assign';

test('legacy teardown does not destroy a list admitted before cold initialization finished', async () => {
  const tmp = makeTmpWorkingDir(); const { ctx, catalog } = makeHandlerContext(tmp.dir);
  const registration = registerRoutingMethods(ctx);
  const entered = deferred(); const release = deferred();
  const original = registration.store.init.bind(registration.store);
  const init = spyOn(registration.store, 'init').mockImplementation(async () => { entered.resolve(); await release.promise; return original(); });
  const reading = catalog.invoke(list, makeInvocation({}));
  const observed = reading.then((value) => ({ value }), (error: unknown) => ({ error }));
  try {
    await entered.promise;
    registration.unregister();
    expect(catalog.hasHandler(list)).toBe(false);
    release.resolve();
    expect(await observed).toEqual({ value: { routes: [], total: 0 } });
  } finally { release.resolve(); await observed; init.mockRestore(); await registration.store.close(); tmp.cleanup(); }
});

test('legacy teardown drains an admitted assignment before closing its store', async () => {
  const tmp = makeTmpWorkingDir(); const { ctx, catalog } = makeHandlerContext(tmp.dir);
  const registration = registerRoutingMethods(ctx);
  await catalog.invoke(list, makeInvocation({}));
  const entered = deferred(); const release = deferred();
  const original = registration.store.upsert.bind(registration.store);
  const upsert = spyOn(registration.store, 'upsert').mockImplementation(async (input) => { entered.resolve(); await release.promise; return original(input); });
  const saving = catalog.invoke(assign, makeInvocation({ surfaceKind: 'telegram', routeId: 'fixture', profileId: 'fixture-profile', confirm: true }));
  const observed = saving.then((value) => ({ value }), (error: unknown) => ({ error }));
  try {
    await entered.promise;
    registration.unregister();
    release.resolve();
    expect(await observed).toMatchObject({ value: { profileId: 'fixture-profile', routeId: 'fixture' } });
  } finally { release.resolve(); await observed; upsert.mockRestore(); await registration.store.close(); tmp.cleanup(); }
});

test('teardown retains canonical routing descriptors for the replacement registration', async () => {
  const tmp = makeTmpWorkingDir(); const { ctx, catalog } = makeHandlerContext(tmp.dir);
  const first = registerRoutingMethods(ctx);
  try {
    first.unregister();
    await first.store.close();
    const next = registerRoutingMethods(ctx);
    try {
      first.unregister();
      expect(catalog.hasHandler(list)).toBe(true);
      expect(await catalog.invoke(list, makeInvocation({}))).toEqual({ routes: [], total: 0 });
    } finally { next.unregister(); await next.store.close(); }
  } finally { first.unregister(); await first.store.close(); tmp.cleanup(); }
});

test('explicit lazy initialization makes the resolver ready without warming a catalog method', async () => {
  const tmp = makeTmpWorkingDir(); const { ctx } = makeHandlerContext(tmp.dir);
  const registration = registerRoutingMethods(ctx);
  try {
    expect(existsSync(registration.store.dbPath)).toBe(false);
    expect(() => registration.resolveProfileId('telegram', 'fixture')).toThrow('not initialized');
    await registration.initialize();
    expect(registration.resolveProfileId('telegram', 'fixture')).toBeNull();
    await registration.store.upsert({ channelId: 'any', profileId: 'fixture-default' });
    expect(registration.resolver.getProfileForChannel('telegram', 'fixture')).toBe('fixture-default');
  } finally { await registration.close(); tmp.cleanup(); }
});

test('closing an unused registration never opens a database', async () => {
  const tmp = makeTmpWorkingDir(); const { ctx } = makeHandlerContext(tmp.dir);
  const registration = registerRoutingMethods(ctx);
  try {
    const close = registration.close();
    expect(registration.close()).toBe(close);
    await close;
    expect(existsSync(registration.store.dbPath)).toBe(false);
  } finally { await registration.close(); tmp.cleanup(); }
});

test('shutdown during explicit initialization rejects readiness and cannot start a new resolver', async () => {
  const tmp = makeTmpWorkingDir(); const { ctx } = makeHandlerContext(tmp.dir);
  const registration = registerRoutingMethods(ctx);
  const entered = deferred(); const release = deferred();
  const original = registration.store.init.bind(registration.store);
  const init = spyOn(registration.store, 'init').mockImplementation(async () => { entered.resolve(); await release.promise; return original(); });
  const initializing = registration.initialize();
  void initializing.catch(() => {});
  try {
    await entered.promise;
    const closing = registration.close();
    let closed = false; void closing.then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    release.resolve();
    await expect(initializing).rejects.toThrow('Routing surface is closed');
    await closing;
    expect(closed).toBe(true);
    expect(() => registration.resolveProfileId('telegram')).toThrow('Routing surface is closed');
    expect(() => registration.resolver.resolveProfile('telegram')).toThrow('Routing surface is closed');
    await expect(registration.initialize()).rejects.toThrow('Routing surface is closed');
  } finally { release.resolve(); await Promise.allSettled([initializing, registration.close()]); init.mockRestore(); tmp.cleanup(); }
});

test('an explicit close waits for an accepted assignment to survive reopen', async () => {
  const tmp = makeTmpWorkingDir(); const { ctx, catalog } = makeHandlerContext(tmp.dir);
  const registration = registerRoutingMethods(ctx);
  await registration.initialize();
  const entered = deferred(); const release = deferred();
  const original = registration.store.upsert.bind(registration.store);
  const upsert = spyOn(registration.store, 'upsert').mockImplementation(async (input) => { entered.resolve(); await release.promise; return original(input); });
  const saving = catalog.invoke(assign, makeInvocation({ surfaceKind: 'telegram', routeId: 'fixture', profileId: 'persisted', confirm: true }));
  void saving.catch(() => {});
  try {
    await entered.promise;
    let closed = false;
    const close = registration.close(); void close.then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    release.resolve(); await saving; await close;
    const reopened = new RouteStore({ workingDirectory: tmp.dir });
    await reopened.init();
    try { expect(reopened.listAll()).toHaveLength(1); expect(reopened.listAll()[0]?.profileId).toBe('persisted'); }
    finally { await reopened.close(); }
  } finally { release.resolve(); await Promise.allSettled([saving, registration.close()]); upsert.mockRestore(); tmp.cleanup(); }
});

test('failed explicit initialization remains retryable without inventing an empty routing result', async () => {
  const tmp = makeTmpWorkingDir(); const { ctx } = makeHandlerContext(tmp.dir);
  const registration = registerRoutingMethods(ctx);
  let calls = 0;
  const original = registration.store.init.bind(registration.store);
  const init = spyOn(registration.store, 'init').mockImplementation(() => ++calls === 1 ? Promise.reject(new Error('fixture initialization failed')) : original());
  try {
    await expect(registration.initialize()).rejects.toThrow('fixture initialization failed');
    expect(() => registration.resolveProfileId('telegram')).toThrow('not initialized');
    await registration.initialize();
    expect(registration.resolveProfileId('telegram')).toBeNull();
    expect(calls).toBe(2);
  } finally { init.mockRestore(); await registration.close(); tmp.cleanup(); }
});

test('ignored legacy teardown reports cleanup failure without unhandled rejection or sensitive details', async () => {
  const tmp = makeTmpWorkingDir(); const { ctx, logger } = makeHandlerContext(tmp.dir);
  const registration = registerRoutingMethods(ctx);
  const close = spyOn(registration.store, 'close').mockRejectedValue(new Error('fixture-sensitive-detail'));
  const errors: unknown[] = []; const observe = (error: unknown) => { errors.push(error); };
  process.on('unhandledRejection', observe);
  try {
    registration.unregister();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(errors).toEqual([]);
    await expect(registration.close()).rejects.toBeInstanceOf(AggregateError);
    expect(logger.entries.filter((entry) => entry.level === 'warn')).toHaveLength(1);
    expect(JSON.stringify(logger.entries)).not.toContain('fixture-sensitive-detail');
  } finally { process.off('unhandledRejection', observe); close.mockRestore(); await registration.store.close(); tmp.cleanup(); }
});

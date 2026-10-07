import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SharedSessionBroker, createNativeInboundSourceOwner, type NativeInboundResolvedSource, type NativeInboundSourceHandle, type NativeInboundSourceRef } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { AutomationRouteStore } from '@goodvibes-jev/engine/sdk/platform/automation';
import { RouteBindingManager } from '@goodvibes-jev/engine/sdk/platform/channels';
import { createNativeInboundHandoff, type NativeInboundAcceptance } from '../../runtime/client/native-inbound-handoff.ts';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const original = '  🚲 e\u0301 repeat repeat\r\nexact original\t ';
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'native-inbound-prerequisite-'));
  const routes = new RouteBindingManager({ store: new AutomationRouteStore(join(dir, 'routes.json')) });
  const brokerConfig = { storePath: join(dir, 'broker.json'), routeBindings: routes,
    agentStatusProvider: { getStatus: () => null }, messageSender: { send: () => false } };
  const broker = new SharedSessionBroker(brokerConfig);
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanups.push(async () => { await broker.stop(); });
  await broker.createSession({ id: 'synthetic-session' });
  const lifetime = new AbortController(); const sourceLifetime = new AbortController();
  let sourceCurrent = true, authorized = true, ownerRevision = 'synthetic-owner:workspace:grant:revision1';
  let ownerLifetime = new AbortController();
  const origin = { kind: 'external-original' as const, accountId: 'synthetic-account', accountRevision: 'a1', routeId: 'synthetic-route', routeRevision: 'r1' };
  const sourceDeps = { origin, lifetime: lifetime.signal, assertCurrent: () => { if (!sourceCurrent) throw new Error('source expired'); },
    readBrokerInput: (target: { sessionId: string; inputId: string }) => broker.getInputsSince(target.sessionId).find(row => row.id === target.inputId) ?? null };
  const sources = createNativeInboundSourceOwner(sourceDeps);
  cleanups.push(() => sources.close());
  const handle = sources.producer.capture(() => ({ text: original, unsupportedSources: [] }), sourceLifetime.signal);
  const submitted = await broker.submitMessage({ sessionId: 'synthetic-session', surfaceKind: 'service', surfaceId: 'synthetic', body: original.trim() });
  const target = { sessionId: submitted.session.id, inputId: submitted.input.id };
  const ref = sources.producer.bind(handle, target);
  const row = () => broker.getInputsSince(target.sessionId).find(item => item.id === target.inputId)!;
  const request = () => ({ sessionId: target.sessionId, input: row(), task: 'derived transcript is not original' });
  const accepted: NativeInboundResolvedSource[] = [];
  const acceptancePath = join(dir, 'synthetic-receiver-acceptance.json');
  let accept: (source: NativeInboundResolvedSource) => Promise<NativeInboundAcceptance> = async source => {
    const result: NativeInboundAcceptance = { ref: source.ref, disposition: 'transferred' };
    writeFileSync(acceptancePath, JSON.stringify(result), { flush: true }); return result;
  };
  let proof: NativeInboundAcceptance | null = null;
  const inspected: NativeInboundSourceRef[] = [], cancelled: NativeInboundSourceRef[] = [];
  const receiver = { accept: async (source: NativeInboundResolvedSource, options: { assertCurrent: () => void }) => { options.assertCurrent(); accepted.push(source); return accept(source); },
    inspect: async (reference: NativeInboundSourceRef) => { inspected.push(reference); return proof; },
    cancel: async (reference: NativeInboundSourceRef) => { cancelled.push(reference); } };
  const owner = { async withCurrent<T>(source: Pick<NativeInboundResolvedSource, 'ref' | 'origin'>, use: (assert: () => void, revision: string, signal: AbortSignal) => Promise<T>) {
    expect(source).not.toHaveProperty('original');
    const assert = () => { if (!authorized) throw new Error('owner instruction revoked'); }; assert(); const expected = ownerRevision; return use(() => { assert(); if (ownerRevision !== expected) throw new Error('scope changed'); }, expected, ownerLifetime.signal);
  } };
  const handoff = createNativeInboundHandoff({ sources: sources.resolver, owner, receiver, lifetime: lifetime.signal });
  cleanups.push(() => handoff.close());
  return { sources, sourceDeps, sourceLifetime, brokerConfig, acceptancePath, handoff, broker, ref, target, request, handle, lifetime, accepted, inspected, cancelled, receiver, owner,
    expireOwner: () => ownerLifetime.abort(),
    sourceCurrent: (value: boolean) => { sourceCurrent = value; }, authorize: (value: boolean) => { authorized = value; if (!value) ownerLifetime.abort(); else if (ownerLifetime.signal.aborted) ownerLifetime = new AbortController(); }, replaceOwner: () => { ownerLifetime.abort(); ownerLifetime = new AbortController(); ownerRevision += '-replacement'; },
    accept: (fn: typeof accept) => { accept = fn; }, proof: (value: NativeInboundAcceptance) => { proof = value; } };
}

test('owned producer → actual broker → Agent keeps exact original distinct from derived broker text', async () => {
  const f = await fixture();
  expect(f.request().input.body).toBe(original.trim());
  expect(await f.handoff.run(f.request())).toEqual({ disposition: 'transferred', requestId: f.ref.requestId });
  expect(f.accepted[0]?.original.text).toBe(original);
  expect(f.accepted[0]?.origin.kind).toBe('external-original');
  expect(f.accepted[0]?.ref).toEqual(f.ref);
  expect(JSON.parse(readFileSync(f.acceptancePath, 'utf8'))).toEqual({ ref: f.ref, disposition: 'transferred' });
  await f.handoff.run(f.request()); expect(f.accepted).toHaveLength(1);
  expect(f.request().input.state).toBe('queued'); // only dispatcher owns acknowledgment
});

test('provenance does not authorize processing; later scoped permission uses the same source/request', async () => {
  const f = await fixture(); f.authorize(false);
  expect((await f.handoff.run(f.request())).disposition).toBe('held'); expect(f.accepted).toHaveLength(0);
  f.authorize(true); expect((await f.handoff.run(f.request())).disposition).toBe('transferred');
  expect(f.accepted[0]?.ref).toEqual(f.ref);
});

test('forged handles, cross-input binding and edited source references fail closed', async () => {
  const f = await fixture();
  expect(() => f.sources.producer.bind({} as NativeInboundSourceHandle, f.target)).toThrow();
  const another = await f.broker.submitMessage({ sessionId: f.target.sessionId, surfaceKind: 'service', surfaceId: 'synthetic', body: 'another' });
  expect(() => f.sources.producer.bind(f.handle, { sessionId: another.session.id, inputId: another.input.id })).toThrow();
  await expect(f.sources.resolver.withSource({ ...f.ref, sourceRevision: 'forged' }, async () => true)).rejects.toThrow();
  expect(f.sources.resolver.reference({ sessionId: another.session.id, inputId: another.input.id })).toBeNull();
});

test('preview/historical broker rows and forged metadata cannot invent source proof', async () => {
  const f = await fixture();
  const item = await f.broker.submitMessage({ sessionId: f.target.sessionId, surfaceKind: 'service', surfaceId: 'preview', body: original,
    metadata: { nativeInbound: f.ref, ownerDirect: true, workAuthorized: true } });
  const input = f.broker.getInputsSince(item.session.id).find(row => row.id === item.input.id)!;
  expect((await f.handoff.run({ sessionId: item.session.id, input, task: original })).disposition).toBe('held');
  expect(f.accepted).toHaveLength(0);
});

test('lost receiver acknowledgment pins identity; repeated polling never retries accept; inspection recovers exact proof', async () => {
  const f = await fixture(); f.accept(async () => { throw new Error('response lost'); });
  expect((await f.handoff.run(f.request())).disposition).toBe('unknown');
  expect((await f.handoff.run(f.request())).disposition).toBe('unknown');
  expect(f.accepted).toHaveLength(1);
  f.proof({ ref: f.ref, disposition: 'transferred' });
  expect(await f.handoff.status(f.target)).toEqual({ disposition: 'transferred', requestId: f.ref.requestId });
  expect(f.inspected).toEqual([f.ref]); expect(f.request().input.state).toBe('queued');
});

test('restart with the same durable broker row holds; it never recaptures or mints a source', async () => {
  const f = await fixture(); await f.handoff.run(f.request());
  f.handoff.close(); f.sources.close();
  await f.broker.stop();
  const persisted = readFileSync(f.brokerConfig.storePath, 'utf8');
  expect(persisted).not.toContain(JSON.stringify(original)); expect(persisted).not.toContain(f.ref.sourceId);
  const reopened = new SharedSessionBroker(f.brokerConfig); await reopened.start();
  cleanups.push(() => reopened.stop());
  const fresh = createNativeInboundSourceOwner({ ...f.sourceDeps,
    readBrokerInput: target => reopened.getInputsSince(target.sessionId).find(row => row.id === target.inputId) ?? null });
  const restarted = createNativeInboundHandoff({ sources: fresh.resolver, owner: f.owner, receiver: f.receiver, lifetime: f.lifetime.signal });
  cleanups.push(() => { fresh.close(); restarted.close(); });
  expect((await restarted.run({ sessionId: f.target.sessionId, input: reopened.getInputsSince(f.target.sessionId).find(row => row.id === f.target.inputId)!, task: 'recovered' })).disposition).toBe('held'); expect(f.accepted).toHaveLength(1);
});

test('revoked source permission is checked before original acquisition', async () => {
  const f = await fixture(); f.sourceCurrent(false); let reads = 0;
  expect(() => f.sources.producer.capture(() => { reads++; return { text: original, unsupportedSources: [] }; }, f.lifetime.signal)).toThrow();
  expect(reads).toBe(0); expect((await f.handoff.run(f.request())).disposition).toBe('held'); expect(f.accepted).toHaveLength(0);
});

test('cancellation and close suppress a late acceptance without consuming the input', async () => {
  const f = await fixture(); let resolve!: (value: NativeInboundAcceptance) => void;
  f.accept(() => new Promise(done => { resolve = done; }));
  const pending = f.handoff.run(f.request());
  while (!resolve) await Bun.sleep(1);
  expect((await f.handoff.cancel(f.target)).disposition).toBe('held');
  resolve({ ref: f.ref, disposition: 'transferred' }); expect((await pending).disposition).toBe('unknown');
  expect(f.cancelled).toEqual([f.ref]); expect(f.request().input.state).toBe('queued');
  f.lifetime.abort(); expect((await f.handoff.run(f.request())).disposition).toBe('held');
});

test('missing construction capabilities hold without any receiver operation', async () => {
  const f = await fixture(); const held = createNativeInboundHandoff({ lifetime: f.lifetime.signal });
  expect((await held.run(f.request())).disposition).toBe('held'); expect(f.accepted).toHaveLength(0); held.close();
});

test('initial admission rejects a broker input already claimed elsewhere', async () => {
  const f = await fixture(); await f.broker.markInputDelivered(f.target.sessionId, f.target.inputId);
  expect((await f.handoff.run(f.request())).disposition).toBe('held'); expect(f.accepted).toHaveLength(0);
});

test('cached acceptance after lost wire acknowledgment rechecks owner authority', async () => {
  const f = await fixture(); await f.handoff.run(f.request()); f.authorize(false);
  expect((await f.handoff.run(f.request())).disposition).toBe('held'); expect(f.accepted).toHaveLength(1);
});

test('equivalent reordered acceptance fields recover the original request', async () => {
  const f = await fixture(); f.accept(async source => ({ disposition: 'started', agentId: 'owned-runner',
    ref: { requestId: source.ref.requestId, sourceRevision: source.ref.sourceRevision, sourceId: source.ref.sourceId, inputId: source.ref.inputId, sessionId: source.ref.sessionId } }));
  expect(await f.handoff.run(f.request())).toEqual({ disposition: 'started', agentId: 'owned-runner' });
});

test('source expiry detaches an uncooperative receiver and never allows its late acceptance', async () => {
  const f = await fixture(); let entered = false;
  f.accept(async () => { entered = true; return new Promise(() => {}); });
  const result = f.handoff.run(f.request()); while (!entered) await Bun.sleep(1);
  f.lifetime.abort(); expect((await result).disposition).toBe('unknown');
  expect(f.sources.resolver.reference(f.target)).toBeNull(); expect(f.request().input.state).toBe('queued');
});

test('producer release retires abandoned content and cannot rebind the same handle', async () => {
  const f = await fixture(); f.sources.producer.release(f.handle);
  expect(f.sources.resolver.reference(f.target)).toBeNull();
  expect(() => f.sources.producer.bind(f.handle, f.target)).toThrow();
  expect((await f.handoff.run(f.request())).disposition).toBe('held');
});

test.each(['source expiry', 'explicit release', 'owner close'] as const)('%s interrupts pending acceptance independently of Agent lifetime', async kind => {
  const f = await fixture(); let entered = false;
  f.accept(async () => { entered = true; return new Promise(() => {}); });
  const pending = f.handoff.run(f.request()); while (!entered) await Bun.sleep(1);
  if (kind === 'source expiry') f.sourceLifetime.abort();
  else if (kind === 'explicit release') f.sources.producer.release(f.handle);
  else f.sources.close();
  expect((await pending).disposition).toBe('unknown'); expect(f.lifetime.signal.aborted).toBe(false);
  expect(f.sources.resolver.reference(f.target)).toBeNull(); expect(f.request().input.state).toBe('queued');
});

test('forged reference cannot revoke the genuine source and repeat release cannot restore it', async () => {
  const f = await fixture();
  await expect(f.sources.resolver.withSource({ ...f.ref, requestId: 'forged' }, async () => true)).rejects.toThrow();
  expect(f.sources.resolver.reference(f.target)).toEqual(f.ref);
  f.sources.producer.release(f.handle); f.sources.producer.release(f.handle);
  const replacement = f.sources.producer.capture(() => ({ text: original, unsupportedSources: [] }), f.sourceLifetime.signal);
  expect(() => f.sources.producer.bind(replacement, f.target)).toThrow();
  f.sources.producer.release(replacement);
});

test('wire acknowledgment recovery uses the same receiver acceptance without replay', async () => {
  const { createWireSessionDispatch } = await import('@goodvibes-jev/engine/sdk/platform/runtime/client');
  const f = await fixture(); let acknowledgments = 0;
  const dispatch = createWireSessionDispatch({ hostedSessionIds: () => [f.target.sessionId], intervalMs: 5 });
  cleanups.push(() => dispatch.stop()); dispatch.setContinuationRunner(f.handoff.run);
  dispatch.activate({ listInputs: async sessionId => ({ inputs: f.broker.getInputsSince(sessionId, { state: 'queued' }) }),
    deliverInput: async (sessionId, inputId, options) => {
      acknowledgments++; if (acknowledgments === 1) throw new Error('wire acknowledgment lost');
      return f.broker.markInputDelivered(sessionId, inputId, options);
    } });
  const until = Date.now() + 2_000;
  while (f.request().input.state === 'queued' && Date.now() < until) await Bun.sleep(2);
  dispatch.stop(); expect(f.request().input.state).toBe('completed');
  expect(acknowledgments).toBe(2); expect(f.accepted).toHaveLength(1); expect(f.accepted[0]?.ref).toEqual(f.ref);
});

test('concurrent calls join one exact source; revoked owner prevents late acceptance', async () => {
  const f = await fixture(); let resolve!: (value: NativeInboundAcceptance) => void;
  f.accept(() => new Promise(done => { resolve = done; }));
  const first = f.handoff.run(f.request()); const second = f.handoff.run(f.request());
  while (!resolve) await Bun.sleep(1); f.authorize(false); resolve({ disposition: 'transferred', ref: f.ref });
  expect((await first).disposition).toBe('unknown'); expect((await second).disposition).toBe('unknown');
  expect(f.accepted).toHaveLength(1); expect(f.request().input.state).toBe('queued');
});

test.each(['account incarnation', 'route incarnation', 'source-read permission', 'retention permission'] as const)('%s replacement invalidates source rather than creating permission', async () => {
  const f = await fixture(); f.sourceCurrent(false);
  expect((await f.handoff.run(f.request())).disposition).toBe('held'); expect(f.accepted).toHaveLength(0);
});

test('a different current owner/scope incarnation cannot reuse cached acceptance', async () => {
  const f = await fixture(); await f.handoff.run(f.request()); f.replaceOwner();
  expect((await f.handoff.run(f.request())).disposition).toBe('held');
  expect((await f.handoff.status(f.target)).disposition).toBe('held'); expect(f.accepted).toHaveLength(1);
});

test('source references reject mutable non-string fields before hashing', async () => {
  const f = await fixture();
  expect(() => f.sources.producer.capture(() => ({ text: original,
    unsupportedSources: [{ kind: 'context', label: { mutable: 'payload' } } as never] }), f.sourceLifetime.signal)).toThrow();
});

test('scoped owner revocation detaches a pending uncooperative receiver', async () => {
  const f = await fixture(); let entered = false;
  f.accept(async () => { entered = true; return new Promise(() => {}); });
  const pending = f.handoff.run(f.request()); while (!entered) await Bun.sleep(1);
  f.authorize(false); expect((await pending).disposition).toBe('unknown'); expect(f.request().input.state).toBe('queued');
});

test('signal-only owner expiry cannot replay a cached acceptance', async () => {
  const f = await fixture(); await f.handoff.run(f.request()); f.expireOwner();
  expect((await f.handoff.run(f.request())).disposition).toBe('held');
  expect((await f.handoff.status(f.target)).disposition).toBe('held'); expect(f.accepted).toHaveLength(1);
});

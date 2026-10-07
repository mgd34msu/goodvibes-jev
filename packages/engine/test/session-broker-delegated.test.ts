import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RouteBindingManager } from '../sdk/src/platform/channels/index.ts';
import type { AutomationRouteBinding } from '../sdk/src/platform/automation/routes.ts';
import { SharedSessionBroker } from '../sdk/src/platform/control-plane/session-broker.ts';
import { createNativeInboundSourceOwner, sameNativeInboundSourceRef, type NativeInboundSourceRef } from '../sdk/src/platform/control-plane/native-inbound-source.ts';
import { SHARED_SESSION_DELEGATED_INPUT_METADATA_KEY, type SharedSessionInputRecord } from '../sdk/src/platform/control-plane/session-intents.ts';
import type { DelegatedSessionInputBinding, DelegatedSessionTransferReceipt } from '../sdk/src/platform/control-plane/session-broker-delegated.ts';
import type { SharedSessionStoreSnapshot } from '../sdk/src/platform/control-plane/session-broker-helpers.ts';
import type { SubmitSharedSessionMessageInput } from '../sdk/src/platform/control-plane/session-types.ts';
import { PersistentStore } from '../sdk/src/platform/state/persistent-store.ts';
import { trackDisposables } from './_helpers/disposables.ts';

const disposables = trackDisposables();
const placeholder = '[External message held for delegated intake]';
const secret = 'Original third-party text must stay process-private';

function makeBroker(path: string, store?: PersistentStore<SharedSessionStoreSnapshot>, binding?: AutomationRouteBinding) {
  const sends: string[] = [];
  const events: Array<{ event: string; payload: unknown }> = [];
  const broker = disposables.add(new SharedSessionBroker({ storePath: path, ...(store ? { store } : {}),
    routeBindings: { start: async () => {}, getBinding: () => binding ?? null, resolve: () => binding ?? null,
      patchBinding: async () => null } as unknown as RouteBindingManager,
    agentStatusProvider: { getStatus: id => ({ id, status: 'running' }) },
    messageSender: { send: (_from, _to, body) => { sends.push(body); return true; } },
  }));
  broker.setEventPublisher((_event, payload) => { events.push(payload as { event: string; payload: unknown }); });
  return { broker, sends, events };
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'gv-delegated-broker-'));
  disposables.defer(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'sessions.json');
  const result = makeBroker(path);
  await result.broker.createSession({ id: 'delegated-session' });
  const lifetime = new AbortController();
  const owner = disposables.add(createNativeInboundSourceOwner({
    origin: { kind: 'external-original', accountId: 'telegram', accountRevision: 'account-1', routeId: 'chat-42', routeRevision: 'route-1' },
    lifetime: lifetime.signal, assertCurrent: () => {},
    readBrokerInput: target => result.broker.getInputs(target.sessionId).find(row => row.id === target.inputId) ?? null,
  }));
  const handle = owner.producer.capture(() => ({ text: secret, unsupportedSources: [] }), lifetime.signal);
  let ref: NativeInboundSourceRef | undefined;
  const bind = (row: SharedSessionInputRecord): DelegatedSessionInputBinding => {
    ref = owner.producer.bind(handle, { sessionId: row.sessionId, inputId: row.id });
    const captured = ref;
    return { ref: captured, assertCurrent: () => {
      const current = owner.resolver.reference(captured);
      if (!current || !sameNativeInboundSourceRef(current, captured)) throw new Error('Source is no longer current');
    } };
  };
  const input: SubmitSharedSessionMessageInput = { sessionId: 'delegated-session', surfaceKind: 'telegram',
    surfaceId: 'telegram-bot', externalId: 'chat-42', userId: 'external-sender', displayName: 'Sender', body: placeholder };
  const receipt = (): DelegatedSessionTransferReceipt => ({ ref: ref!, disposition: 'transferred', requestId: ref!.requestId });
  return { ...result, path, owner, lifetime, bind, input, receipt };
}

describe('host-private delegated broker admission', () => {
  test('binds the canonical row before message/input publication and never directly hands over', async () => {
    const f = await fixture();
    await f.broker.bindAgent(f.input.sessionId!, 'live-agent');
    let bound = false;
    f.broker.setEventPublisher((_event, payload) => {
      const event = payload as { event: string; payload: unknown };
      if (event.event.startsWith('session-input-') || event.event === 'session-message-appended') expect(bound).toBe(true);
      f.events.push(event);
    });
    const result = await f.broker.submitDelegatedMessage(f.input, row => {
      expect(f.broker.getInputs(row.sessionId).find(item => item.id === row.id)).toEqual(row);
      expect(row.userId).toBe('external-sender');
      const binding = f.bind(row); bound = true; return binding;
    });
    expect(result.submission.mode).toBe('queued-for-surface');
    expect(result.submission.task).toBeUndefined();
    expect(result.submission.input.state).toBe('queued');
    expect(f.sends).toEqual([]);
    const bytes = readFileSync(f.path, 'utf8');
    expect(bytes).toContain(placeholder);
    expect(bytes).not.toContain(secret);
    expect(bytes).not.toContain(f.receipt().ref.sourceId);
    expect(JSON.stringify(f.events)).not.toContain(secret);
    expect(JSON.parse(JSON.stringify(result)).complete).toBeUndefined();
  });

  test('blocks wire polling, delivery reports, and agent queue claims while ordinary inputs still work', async () => {
    const f = await fixture();
    const selected = await f.broker.submitDelegatedMessage(f.input, f.bind);
    const { sessionId, id } = selected.submission.input;
    expect(f.broker.getInputsSince(sessionId)).toEqual([]);
    expect(f.broker.getInputsSince(sessionId, { state: 'queued' })).toEqual([]);
    const before = f.events.length;
    expect(await f.broker.markInputDelivered(sessionId, id, { consumed: false, agentId: 'injected' })).toBeNull();
    expect(await f.broker.markInputDelivered(sessionId, id, { consumed: true, agentId: 'injected' })).toBeNull();
    expect(f.events.length).toBe(before);
    expect(f.broker.getSession(sessionId)?.activeAgentId).toBeUndefined();
    const ordinary = await f.broker.submitMessage({ ...f.input, body: 'Ordinary input' });
    expect(f.broker.getInputsSince(sessionId).map(row => row.id)).toEqual([ordinary.input.id]);
    await f.broker.bindAgent(sessionId, 'ordinary-agent');
    expect(f.broker.getInputs(sessionId).find(row => row.id === id)?.state).toBe('queued');
    expect(f.broker.getInputs(sessionId).find(row => row.id === ordinary.input.id)?.state).toBe('spawned');
  });

  test('forged public metadata only denies, including live handover and follow-up continuation', async () => {
    const f = await fixture();
    await f.broker.bindAgent(f.input.sessionId!, 'live-agent');
    let continuations = 0;
    f.broker.setContinuationRunner(() => { continuations++; return { agentId: 'should-not-run' }; });
    const marked = { ...f.input, metadata: { [SHARED_SESSION_DELEGATED_INPUT_METADATA_KEY]: true,
      executionApproved: true, sourceRef: { sourceId: 'forged', requestId: 'forged' } } };
    const submitted = await f.broker.submitMessage(marked);
    const followUp = await f.broker.followUpMessage(marked);
    expect(submitted.mode).toBe('queued-for-surface');
    expect(f.sends).toEqual([]);
    expect(f.owner.resolver.reference({ sessionId: submitted.input.sessionId, inputId: submitted.input.id })).toBeNull();
    await f.broker.completeAgent(f.input.sessionId!, 'live-agent', 'Previous work finished');
    expect(continuations).toBe(0);
    expect(f.broker.getInputsSince(f.input.sessionId!)).toEqual([]);
    expect(f.broker.getInputs(f.input.sessionId!).find(row => row.id === followUp.input.id)?.state).toBe('queued');
  });

  test('persisted quarantine survives restart without minting a source binding', async () => {
    const f = await fixture();
    const selected = await f.broker.submitDelegatedMessage(f.input, f.bind);
    f.owner.close();
    await f.broker.stop();
    const restored = makeBroker(f.path).broker;
    await restored.start();
    const row = restored.getInputs(f.input.sessionId!)[0]!;
    expect(row.id).toBe(selected.submission.input.id);
    expect(row.state).toBe('queued');
    expect(restored.getInputsSince(row.sessionId)).toEqual([]);
    expect(await restored.markInputDelivered(row.sessionId, row.id, { consumed: true })).toBeNull();
    await restored.bindAgent(row.sessionId, 'new-agent');
    expect(restored.getInputs(row.sessionId)[0]!.state).toBe('queued');
    expect(f.owner.resolver.reference({ sessionId: row.sessionId, inputId: row.id })).toBeNull();
    await expect(selected.complete(f.receipt())).rejects.toThrow('no longer current');
  });

  test('binding failure keeps only a failed placeholder and emits no message/input publication', async () => {
    const f = await fixture();
    await expect(f.broker.submitDelegatedMessage(f.input, () => { throw new Error('binding failed'); })).rejects.toThrow('binding failed');
    expect(f.broker.getInputs(f.input.sessionId!)[0]!.state).toBe('failed');
    expect(f.broker.getInputsSince(f.input.sessionId!)).toEqual([]);
    expect(f.events.filter(event => event.event.startsWith('session-input-') || event.event === 'session-message-appended')).toEqual([]);
    expect(readFileSync(f.path, 'utf8')).not.toContain(secret);
  });

  test('an asynchronous binder cannot turn late binding into authority', async () => {
    const f = await fixture();
    const invalid = (async (row: SharedSessionInputRecord) => f.bind(row)) as unknown as (row: SharedSessionInputRecord) => DelegatedSessionInputBinding;
    await expect(f.broker.submitDelegatedMessage(f.input, invalid)).rejects.toThrow('Invalid delegated input binding');
    expect(f.broker.getInputs(f.input.sessionId!)[0]!.state).toBe('failed');
    expect(f.broker.getInputsSince(f.input.sessionId!)).toEqual([]);
  });

  test('an asynchronous currentness check is rejected rather than silently bypassed', async () => {
    const f = await fixture();
    await expect(f.broker.submitDelegatedMessage(f.input, row => ({ ...f.bind(row),
      assertCurrent: async () => { throw new Error('Asynchronous denial'); },
    }))).rejects.toThrow('must be synchronous');
    expect(f.broker.getInputs(f.input.sessionId!)[0]!.state).toBe('failed');
    expect(f.broker.getInputsSince(f.input.sessionId!)).toEqual([]);
  });

  test('delegated route healing sends no unsolicited rollover notice before binding', async () => {
    const f = await fixture();
    const now = Date.now();
    const routed = makeBroker(f.path, undefined, { id: 'bound-route', kind: 'channel', surfaceKind: 'telegram',
      surfaceId: 'telegram-bot', externalId: 'chat-42', sessionId: 'missing-old-session',
      createdAt: now, updatedAt: now, lastSeenAt: now, metadata: {} });
    const notices: string[] = [];
    routed.broker.setSurfaceNoticeSender((_route, text) => notices.push(text));
    const selected = await routed.broker.submitDelegatedMessage({ ...f.input, sessionId: undefined, routeId: 'bound-route' }, row => ({
      ref: { sessionId: row.sessionId, inputId: row.id, sourceId: 'source', sourceRevision: 'revision', requestId: 'request' }, assertCurrent: () => {},
    }));
    expect(selected.submission.session.id).not.toBe('missing-old-session');
    expect(notices).toEqual([]);
    expect(routed.sends).toEqual([]);
  });

  test('completion requires the exact source and transferred request, then durably completes only that row', async () => {
    const f = await fixture();
    const selected = await f.broker.submitDelegatedMessage(f.input, f.bind);
    const receipt = f.receipt();
    await expect(selected.complete({ ...receipt, requestId: 'another-request' })).rejects.toThrow('does not match');
    for (const field of ['sessionId', 'inputId', 'sourceId', 'sourceRevision', 'requestId'] as const) {
      await expect(selected.complete({ ...receipt, ref: { ...receipt.ref, [field]: 'other' } })).rejects.toThrow('does not match');
    }
    await expect(selected.complete({ ...receipt, disposition: 'held' } as unknown as DelegatedSessionTransferReceipt)).rejects.toThrow('does not match');
    const ordinary = await f.broker.submitMessage({ ...f.input, body: 'Another pending message' });
    const completed = await selected.complete(receipt);
    expect(completed.state).toBe('completed');
    expect((await selected.complete(receipt)).id).toBe(completed.id);
    expect(f.broker.getInputs(f.input.sessionId!).find(row => row.id === ordinary.input.id)?.state).toBe('queued');
    const persisted = JSON.parse(readFileSync(f.path, 'utf8')) as SharedSessionStoreSnapshot;
    expect(persisted.inputs.find(row => row.id === completed.id)?.state).toBe('completed');
    expect(await f.broker.markInputDelivered(completed.sessionId, completed.id, { consumed: true })).toBeNull();
  });

  test('source lifetime revocation and public cancellation both invalidate completion', async () => {
    const revoked = await fixture();
    const first = await revoked.broker.submitDelegatedMessage(revoked.input, revoked.bind);
    revoked.lifetime.abort();
    await expect(first.complete(revoked.receipt())).rejects.toThrow('no longer current');
    expect(revoked.broker.getInputs(revoked.input.sessionId!)[0]!.state).toBe('queued');
    const cancelled = await fixture();
    const second = await cancelled.broker.submitDelegatedMessage(cancelled.input, cancelled.bind);
    await cancelled.broker.cancelInput(second.submission.input.sessionId, second.submission.input.id);
    await expect(second.complete(cancelled.receipt())).rejects.toThrow('no longer current');
    expect(cancelled.broker.getInputs(cancelled.input.sessionId!)[0]!.state).toBe('cancelled');
  });

  test('caller and returned snapshot mutation cannot remove quarantine or replace the canonical body', async () => {
    const f = await fixture();
    const mutable = { ...f.input };
    const pending = f.broker.submitDelegatedMessage(mutable, f.bind);
    mutable.body = secret;
    const selected = await pending;
    selected.submission.input.metadata[SHARED_SESSION_DELEGATED_INPUT_METADATA_KEY] = false;
    expect(f.broker.getInputs(f.input.sessionId!)[0]!.body).toBe(placeholder);
    expect(f.broker.getInputsSince(f.input.sessionId!)).toEqual([]);
    expect((await selected.complete(f.receipt())).state).toBe('completed');
    expect(readFileSync(f.path, 'utf8')).not.toContain(secret);
  });

  test('ambiguous durability failure leaves a denied terminal row and publishes no input', async () => {
    const f = await fixture();
    let failWrites = true;
    const store = { load: async () => null, persist: async (snapshot: SharedSessionStoreSnapshot) => {
      if (failWrites && snapshot.inputs.length) throw new Error('durability unavailable');
    } } as unknown as PersistentStore<SharedSessionStoreSnapshot>;
    const other = makeBroker(f.path, store);
    await expect(other.broker.submitDelegatedMessage({ ...f.input, sessionId: undefined }, row => ({
      ref: { sessionId: row.sessionId, inputId: row.id, sourceId: 'source', sourceRevision: 'revision', requestId: 'request' }, assertCurrent: () => {},
    }))).rejects.toThrow('durability unavailable');
    const session = other.broker.listSessions()[0]!;
    expect(other.broker.getInputs(session.id)[0]!.state).toBe('failed');
    expect(other.broker.getInputsSince(session.id)).toEqual([]);
    expect(other.events.some(event => event.event === 'session-input-queued' || event.event === 'session-message-appended')).toBe(false);
    failWrites = false;
  });
});

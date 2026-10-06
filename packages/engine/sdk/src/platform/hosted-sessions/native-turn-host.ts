/** Current native source + strict dispatch journal + actual hosted turn ownership. */
import { realpathSync } from 'node:fs';
import type { OperatorRemoteClient } from '@goodvibes-jev/engine/operator-sdk';
import { createOperatorNativeConversationIntakeClient, type NativeConversationTurnPermit, type NativeConversationTurnSource } from '../workflow/work-ledger/native-intake-client.js';
import type { NativeConversationIntakeHost } from '../workflow/work-ledger/native-intake.js';
import type { NativePairedExecutionAuthority, NativePairedExecutionSnapshot } from '../workflow/work-ledger/native-execution.js';
import type { SharedSessionBroker } from '../control-plane/session-broker.js';
import type { HostedSessionManager } from './manager.js';
import { NativeHostedTurnJournal, NativeHostedTurnJournalError, type NativeHostedTurnIdentity, type NativeHostedTurnDispatch } from './native-turn-journal.js';
import { nativeHostedTurnRequestSchema, type NativeHostedTurnRequest, type NativeHostedTurnLookup, type NativeHostedTurnSnapshot } from './native-turn-wire.js';

export const NATIVE_HOSTED_TURN_SCOPES = ['read:work-ledger', 'write:work-ledger', 'write:sessions'] as const;
export class NativeHostedTurnError extends Error {
  constructor(readonly code: 'invalid' | 'forbidden' | 'unavailable' | 'not-turn' | 'stale' | 'closed' | 'recovery-required') {
    super(`Native hosted turn: ${code}`); this.name = 'NativeHostedTurnError';
  }
}
export interface NativeHostedTurnOptions {
  readonly signal?: AbortSignal;
  readonly isAuthorized: () => boolean;
}
export interface NativeHostedTurnDependencies {
  readonly projectId: string;
  readonly projectRoot: string;
  readonly intake: Pick<NativeConversationIntakeHost, 'get' | 'admit'>;
  readonly journalPath: string;
}
export function createNativeHostedTurnHost(deps: NativeHostedTurnDependencies & {
  readonly manager: Pick<HostedSessionManager, 'create' | 'deliverNative' | 'cancelNative' | 'kill'>;
  readonly broker: Pick<SharedSessionBroker, 'reserveNativeTurnInput' | 'getInputsSince' | 'settleNativeTurnInput'>;
  readonly journal?: NativeHostedTurnJournal;
}) {
  const projectRoot = realpathSync(deps.projectRoot);
  const journal = deps.journal ?? new NativeHostedTurnJournal(deps.journalPath);
  const active = new Map<string, { cancelled: boolean; sessionId: string | null; brokerInputId: string | null; permit: NativeConversationTurnPermit | null; done: Promise<void> }>();
  const starting = new Map<string, Promise<NativeHostedTurnLookup>>();
  let closed = false;
  const sameAuthority = (a: NativePairedExecutionSnapshot, b: NativePairedExecutionSnapshot) => a.principalId === b.principalId && a.authorityId === b.authorityId && a.authorityRevision === b.authorityRevision && JSON.stringify([...a.scopes].sort()) === JSON.stringify([...b.scopes].sort());
  const keyOf = (identity: NativeHostedTurnIdentity) => JSON.stringify([identity.projectId, identity.principalId, identity.inputId]);
  function authorize(authority: NativePairedExecutionAuthority, options: NativeHostedTurnOptions) {
    if (closed) throw new NativeHostedTurnError('closed');
    const value = authority.current();
    if (!options.isAuthorized() || !value || value.kind !== 'pairing-token' || value.principalId !== value.authorityId
      || value.authorityRevision !== value.tokenId || !NATIVE_HOSTED_TURN_SCOPES.every(scope => value.scopes.includes('*') || value.scopes.includes(scope))) throw new NativeHostedTurnError('forbidden');
    return value;
  }
  async function sourceOf(input: NativeHostedTurnRequest, authority: NativePairedExecutionAuthority, options: NativeHostedTurnOptions) {
    const request = nativeHostedTurnRequestSchema.parse(input);
    if (request.projectId !== deps.projectId) throw new NativeHostedTurnError('stale');
    const principal = authorize(authority, options);
    const result = await deps.intake.get({ inputId: request.inputId }, authority, { isAuthorized: options.isAuthorized });
    const fresh = authorize(authority, options);
    if (!sameAuthority(fresh, principal)) throw new NativeHostedTurnError('stale');
    if (result.kind !== 'turn') throw new NativeHostedTurnError('not-turn');
    if (result.projectId !== request.projectId || result.sourceRef.inputId !== request.inputId || result.sourceRef.sourceRevision !== request.sourceRevision) throw new NativeHostedTurnError('stale');
    const identity: NativeHostedTurnIdentity = { projectId: deps.projectId, principalId: principal.principalId, requestId: result.requestId,
      inputId: result.sourceRef.inputId, sourceId: result.sourceRef.sourceId, sourceRevision: result.sourceRef.sourceRevision, sourceSessionId: result.sourceRef.sessionId };
    return { source: result, identity, binding: Object.freeze({ ...principal, scopes: Object.freeze([...principal.scopes]) }) };
  }
  function project(record: NativeHostedTurnDispatch): NativeHostedTurnSnapshot {
    const live = active.get(keyOf(record.identity));
    const state = record.state === 'dispatching' ? live ? live.cancelled ? 'cancelling' : 'running' : 'recovery-required'
      : record.state === 'preparing' && !live ? 'recovery-required' : record.state;
    return { projectId: record.identity.projectId, requestId: record.identity.requestId, inputId: record.identity.inputId,
      sourceRevision: record.identity.sourceRevision, state, sessionId: record.sessionId, brokerInputId: record.brokerInputId, correlationId: record.correlationId };
  }
  async function status(input: NativeHostedTurnRequest, authority: NativePairedExecutionAuthority, options: NativeHostedTurnOptions): Promise<NativeHostedTurnLookup> {
    const { identity } = await sourceOf(input, authority, options);
    const record = await journal.read(identity); authorize(authority, options);
    return record ? project(record) : { kind: 'not-found' };
  }
  async function start(input: NativeHostedTurnRequest, authority: NativePairedExecutionAuthority, options: NativeHostedTurnOptions): Promise<NativeHostedTurnLookup> {
    options.signal?.throwIfAborted();
    const { source, identity, binding } = await sourceOf(input, authority, options);
    const key = keyOf(identity), pending = starting.get(key);
    if (pending) return pending;
    const run = prepare(source, identity, authority, binding, options);
    starting.set(key, run);
    try { return await run; } finally { if (starting.get(key) === run) starting.delete(key); }
  }
  async function prepare(source: NativeConversationTurnSource, identity: NativeHostedTurnIdentity, authority: NativePairedExecutionAuthority, binding: NativePairedExecutionSnapshot, options: NativeHostedTurnOptions): Promise<NativeHostedTurnLookup> {
    const key = keyOf(identity);
    const assertCurrent = () => { if (!sameAuthority(binding, authorize(authority, options))) throw new NativeHostedTurnError('stale'); };
    options.signal?.throwIfAborted(); assertCurrent();
    if (!await journal.claim(identity)) {
      const record = await journal.read(identity);
      if (!record) throw new NativeHostedTurnError('unavailable');
      return project(record);
    }
    const owned = { cancelled: false, sessionId: null as string | null, brokerInputId: null as string | null, permit: null as NativeConversationTurnPermit | null, done: Promise.resolve() };
    active.set(key, owned);
    // This adapter reaches the actual owner with its opaque transport-created
    // authority. It does not replay a serialized receipt or mint from a lookup.
    const invoke = (async (method: string) => {
      assertCurrent();
      if (owned.cancelled) throw new NativeHostedTurnError('closed');
      const result = method === 'workLedger.intake.admit'
        ? await deps.intake.admit({ inputId: identity.inputId, sourceRevision: identity.sourceRevision }, authority, { isAuthorized: options.isAuthorized })
        : method === 'workLedger.intake.get' ? await deps.intake.get({ inputId: identity.inputId }, authority, { isAuthorized: options.isAuthorized })
        : undefined;
      assertCurrent();
      if (!result) throw new NativeHostedTurnError('invalid');
      return result;
    }) as OperatorRemoteClient['invoke'];
    const client = createOperatorNativeConversationIntakeClient({ invoke }, deps.projectId);
    try {
      // Terminal admission replay neither rerolls Jev nor changes source evidence.
      const eligible = await client.admit({ inputId: identity.inputId, sourceRevision: identity.sourceRevision });
      if (eligible.kind !== 'turn' || JSON.stringify(eligible) !== JSON.stringify(source)) throw new NativeHostedTurnError('stale');
      const permit = client.bindTurn(eligible);
      owned.permit = permit;
      assertCurrent(); options.signal?.throwIfAborted();
      if (owned.cancelled) throw new NativeHostedTurnError('closed');
      const session = await deps.manager.create({ workspaceRoot: projectRoot, title: 'Native conversation', originSurface: 'webui', detachPolicy: 'survive' });
      owned.sessionId = session.id;
      if (realpathSync(session.workspaceRoot) !== projectRoot || realpathSync(deps.projectRoot) !== projectRoot) throw new NativeHostedTurnError('stale');
      assertCurrent();
      if (owned.cancelled) throw new NativeHostedTurnError('closed');
      const input = await deps.broker.reserveNativeTurnInput(session.id, permit);
      owned.brokerInputId = input.id;
      const dispatch = { state: 'dispatching' as const, sessionId: session.id, brokerInputId: input.id, correlationId: input.correlationId };
      await journal.transition(identity, 'preparing', dispatch);
      assertCurrent();
      if (owned.cancelled) throw new NativeHostedTurnError('closed');
      // Starts asynchronously after the strict claim. The request may detach;
      // this owner, not the HTTP response or browser, owns the actual lifetime.
      owned.done = Promise.resolve().then(async () => {
        if (owned.cancelled || closed) throw new NativeHostedTurnError('closed');
        await deps.manager.deliverNative(session.id, input.id, permit);
        if (owned.cancelled || closed) {
          const terminal = await deps.broker.settleNativeTurnInput(session.id, input.id, permit, 'cancelled');
          if (terminal.state !== 'cancelled') throw new NativeHostedTurnError('recovery-required');
          return;
        }
        const current = deps.broker.getInputsSince(session.id).find(item => item.id === input.id);
        if (!current || current.state !== 'delivered' || current.body !== source.text || current.correlationId !== input.correlationId) throw new NativeHostedTurnError('recovery-required');
        const terminal = await deps.broker.settleNativeTurnInput(session.id, input.id, permit, 'completed');
        if (terminal.state !== 'completed') throw new NativeHostedTurnError('recovery-required');
        await journal.transition(identity, 'dispatching', { ...dispatch, state: 'completed' });
      }).catch(async () => {
        const brokerState = deps.broker.getInputsSince(session.id).find(item => item.id === input.id)?.state;
        // A strict settlement failure may leave visible in-memory terminal
        // state. Reconfirm it through the exact-owned durable operation; merely
        // reading that state must not turn a failed fsync into cancellation.
        const expected = brokerState === 'completed' || brokerState === 'failed' || brokerState === 'cancelled'
          ? brokerState : owned.cancelled ? 'cancelled' : 'failed';
        const terminal = await deps.broker.settleNativeTurnInput(session.id, input.id, permit, expected);
        if (terminal.state !== expected) throw new NativeHostedTurnError('recovery-required');
        const record = await journal.read(identity);
        if (!owned.cancelled && record && (record.state === 'preparing' || record.state === 'dispatching')) {
          await journal.transition(identity, record.state, { state: 'recovery-required', sessionId: record.sessionId, brokerInputId: record.brokerInputId, correlationId: record.correlationId });
        }
      }).finally(() => { if (active.get(key) === owned) active.delete(key); client.dispose(); });
      // Observe persistence failures without pretending they succeeded. Status
      // retains the durable claim and reports recovery-required after this drains.
      void owned.done.catch(() => {});
      return project({ identity, ...dispatch });
    } catch (error) {
      // No native runtime was dispatched on this preparation failure. Release
      // the empty session so a cancelled/revoked preparation cannot exhaust capacity.
      if (owned.sessionId && owned.brokerInputId && owned.permit) {
        await deps.broker.settleNativeTurnInput(owned.sessionId, owned.brokerInputId, owned.permit, owned.cancelled ? 'cancelled' : 'failed').catch(() => {});
      }
      if (owned.sessionId) await deps.manager.kill(owned.sessionId).catch(() => {});
      active.delete(key); client.dispose();
      throw error;
    }
  }
  async function cancel(input: NativeHostedTurnRequest, authority: NativePairedExecutionAuthority, options: NativeHostedTurnOptions): Promise<NativeHostedTurnLookup> {
    const { identity } = await sourceOf(input, authority, options), key = keyOf(identity);
    const fence = () => {
      const owned = active.get(key);
      if (owned) {
        owned.cancelled = true;
        if (owned.sessionId && owned.permit) deps.manager.cancelNative(owned.sessionId, owned.permit);
      }
      return owned;
    };
    const earlier = fence();
    await journal.claim(identity);
    let record = await journal.read(identity);
    if (!record) throw new NativeHostedTurnError('unavailable');
    // Preparing has not crossed the dispatch CAS. This tombstone prevents it
    // even in a different process, so no execution drain needs to be invented.
    if (record.state === 'preparing') {
      try { record = await journal.transition(identity, 'preparing', { state: 'cancelled', sessionId: record.sessionId, brokerInputId: record.brokerInputId, correlationId: record.correlationId }); }
      catch (error) {
        // A simultaneous dispatch CAS may win the lock. Re-read its real state;
        // neither that conflict nor a failed/ambiguous write proves cancellation.
        if (!(error instanceof NativeHostedTurnJournalError) || error.code !== 'conflict') throw error;
        record = await journal.read(identity);
        if (!record) throw new NativeHostedTurnError('unavailable');
      }
    }
    const current = fence();
    if (!earlier && !current && !['completed', 'cancelled'].includes(record.state)) {
      // Another process, or an interrupted process, owns the ambiguity. A file
      // write cannot stop that lifetime or prove its effects have drained.
      return { ...project(record), state: 'recovery-required' };
    }
    await starting.get(key)?.catch(() => {});
    const latest = fence();
    await Promise.all([earlier?.done, current?.done, latest?.done]);
    record = await journal.read(identity);
    if (!record) throw new NativeHostedTurnError('unavailable');
    if (!['completed', 'cancelled'].includes(record.state)) record = await journal.transition(identity, record.state, { state: 'cancelled', sessionId: record.sessionId, brokerInputId: record.brokerInputId, correlationId: record.correlationId });
    authorize(authority, options);
    return project(record);
  }
  return { start, status, cancel,
    async close(): Promise<void> {
      closed = true;
      for (const owned of active.values()) { owned.cancelled = true; if (owned.sessionId && owned.permit) deps.manager.cancelNative(owned.sessionId, owned.permit); }
      await Promise.allSettled([...starting.values()]);
      await Promise.allSettled([...active.values()].map(owned => owned.done));
    },
  };
}
export type NativeHostedTurnHost = ReturnType<typeof createNativeHostedTurnHost>;

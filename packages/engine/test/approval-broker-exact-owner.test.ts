import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalBroker, type SharedApprovalRecord } from '../sdk/src/platform/control-plane/approval-broker.js';
import type { PermissionPromptDecision, PermissionPromptRequest } from '../sdk/src/platform/permissions/prompt.js';
import { PersistentStore } from '../sdk/src/platform/state/persistent-store.js';

interface Snapshot extends Record<string, unknown> { readonly approvals: readonly SharedApprovalRecord[] }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
class HeldStore extends PersistentStore<Snapshot> {
  private next: { entered: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>> } | undefined;
  holdNext() {
    const hold = { entered: deferred<void>(), release: deferred<void>() };
    this.next = hold;
    return { entered: hold.entered.promise, release: () => hold.release.resolve() };
  }
  override async persist(snapshot: Snapshot): Promise<void> {
    const next = this.next;
    this.next = undefined;
    if (next) { next.entered.resolve(); await next.release.promise; }
    await super.persist(snapshot);
  }
}
const cleanup: string[] = [];
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'gv-exact-owner-'));
  cleanup.push(dir);
  const path = join(dir, 'approvals.json');
  const store = new HeldStore(path);
  return { broker: new ApprovalBroker({ store }), store, path };
}
function request(callId: string): PermissionPromptRequest {
  return { callId, tool: 'delegated.message.intake', args: { sourceRef: 'source-safe-42' }, category: 'delegate',
    analysis: { classification: 'delegated-message', riskLevel: 'high', summary: 'Review one source reference', reasons: ['owner decision required'] } };
}
const current = () => undefined;
const ownerResolution = (decision: PermissionPromptDecision = { approved: true }) => ({ decision, actor: 'paired-owner', actorSurface: 'paired-gateway', assertCurrent: current });

describe('exact host-owned approvals', () => {
  test('a wire decision cannot forge the owner through actor, surface, metadata, or remembered allow sweep', async () => {
    const { broker } = fixture();
    const exact = await broker.raiseOwnerApproval({ request: request('exact'), requireOwnerDecision: { assertCurrent: current } });
    await broker.recordRemoteUpdate(exact.approval.id, { actor: 'paired-owner', metadata: { requiresOwnerDecision: false, ownerApproved: true } });
    for (const actorSurface of ['tui', 'paired-gateway', 'service']) {
      await expect(broker.resolveApproval(exact.approval.id, { approved: true, disposition: 'approved', actor: 'paired-owner', actorSurface })).rejects.toThrow('exact current owner');
    }
    const ordinary = await broker.raiseApproval({ request: request('ordinary') });
    expect(ordinary.approval.id).not.toBe(exact.approval.id);
    await broker.resolveApproval(ordinary.approval.id, { approved: true, rememberTier: 'tool', actor: 'paired-owner' });
    expect(broker.getApproval(exact.approval.id)?.status).toBe('pending');
    const denied = await broker.resolveApproval(exact.approval.id, { approved: false, actor: 'remote-owner' });
    expect(denied?.status).toBe('denied');
    expect((await exact.decision).approved).toBe(false);
  });

  test('the one-shot capability records exact provenance and validates host-approved retention choices', async () => {
    const { broker, path } = fixture();
    const original = request('exact-retention');
    const raised = await broker.raiseOwnerApproval({ request: original, requireOwnerDecision: {
      assertCurrent: current,
      validateDecision: (decision) => {
        if (JSON.stringify(decision.modifiedArgs) !== '{"retention":"derived-only"}') throw new Error('exact retention required');
      },
    } });
    original.args.sourceRef = 'mutated-after-raise';
    expect(raised.approval.request.args.sourceRef).toBe('source-safe-42');
    expect(Object.keys(raised)).not.toContain('resolveOwnerDecision');
    const result = await raised.resolveOwnerDecision(ownerResolution({ approved: true, modifiedArgs: { retention: 'derived-only' } }));
    expect(result?.status).toBe('approved');
    expect(result?.requiresOwnerDecision).toBe(true);
    expect(result?.decision).toEqual({ approved: true, remember: false, disposition: 'approved', modifiedArgs: { retention: 'derived-only' } });
    expect(result?.audit.at(-1)).toMatchObject({ action: 'approved', actor: 'paired-owner', actorSurface: 'paired-gateway' });
    expect(await raised.decision).toEqual({ approved: true, remember: false, modifiedArgs: { retention: 'derived-only' } });
    expect(readFileSync(path, 'utf8')).not.toMatch(/resolveOwnerDecision|assertCurrent|validateDecision|owner-approval/);
    await expect(raised.resolveOwnerDecision(ownerResolution({ approved: true, modifiedArgs: { retention: 'derived-only' } }))).rejects.toThrow('exact current owner');
  });

  test('remember, generalized modifications, unknown keys, and duplicate asks cannot widen the capability', async () => {
    const { broker } = fixture();
    const raised = await broker.raiseOwnerApproval({ request: request('one'), requireOwnerDecision: { assertCurrent: current } });
    const other = await broker.raiseOwnerApproval({ request: request('two'), requireOwnerDecision: { assertCurrent: current } });
    expect(other.approval.id).not.toBe(raised.approval.id);
    expect(other.coalesced).toBe(false);
    for (const decision of [
      { approved: true, remember: true },
      { approved: true, rememberTier: 'session' as const },
      { approved: true, rememberTier: 'tool' as const },
      { approved: true, modifiedArgs: { allowAll: true } },
      { approved: true, allowAllFutureMessages: true },
    ]) await expect(raised.resolveOwnerDecision(ownerResolution(decision))).rejects.toThrow('exact current owner');
    expect(broker.getApproval(raised.approval.id)?.status).toBe('pending');
    await raised.resolveOwnerDecision(ownerResolution());
    expect(broker.getApproval(other.approval.id)?.status).toBe('pending');
    await broker.cancelApproval(other.approval.id, 'owner');
  });

  test('restored protected records retain only the deny marker and cannot regain a capability', async () => {
    const { broker, path } = fixture();
    const raised = await broker.raiseOwnerApproval({ request: request('restart'), requireOwnerDecision: { assertCurrent: current } });
    const restored = new ApprovalBroker({ storePath: path });
    await restored.start();
    expect(restored.getApproval(raised.approval.id)?.requiresOwnerDecision).toBe(true);
    await expect(restored.resolveApproval(raised.approval.id, { approved: true, actor: 'paired-owner', actorSurface: 'paired-gateway' })).rejects.toThrow('exact current owner');
    const fresh = await restored.raiseOwnerApproval({ request: request('fresh'), requireOwnerDecision: { assertCurrent: current } });
    expect(fresh.approval.id).not.toBe(raised.approval.id);
    await restored.cancelApproval(fresh.approval.id, 'owner');
    expect((await restored.resolveApproval(raised.approval.id, { approved: false, actor: 'owner' }))?.status).toBe('denied');
    await broker.cancelApproval(raised.approval.id, 'owner');
  });

  test('the source is rechecked after the creation write, before displaying a prompt', async () => {
    const { broker, store } = fixture();
    const hold = store.holdNext();
    let valid = true;
    let prompted = false;
    const creating = broker.raiseOwnerApproval({ request: request('creation-race'),
      requireOwnerDecision: { assertCurrent: () => { if (!valid) throw new Error('source changed'); } },
      localPrompt: async () => { prompted = true; return { approved: true }; },
    });
    const failed = creating.then(() => undefined, (error: unknown) => error);
    await hold.entered;
    valid = false;
    hold.release();
    expect(await failed).toMatchObject({ message: 'source changed' });
    expect(prompted).toBe(false);
    expect(broker.listApprovals()[0]?.status).toBe('cancelled');
  });

  test.each(['source', 'paired-owner', 'abort'] as const)('rechecks %s after the decision write without publishing an early approval', async (kind) => {
    const { broker, store, path } = fixture();
    const lifetime = new AbortController();
    let sourceCurrent = true;
    let ownerCurrent = true;
    const raised = await broker.raiseOwnerApproval({ request: request(`write-race-${kind}`), signal: lifetime.signal,
      requireOwnerDecision: { assertCurrent: () => { if (!sourceCurrent) throw new Error('source revoked'); } },
    });
    const events: string[] = [];
    broker.subscribe((record) => events.push(record.status));
    const hold = store.holdNext();
    const resolving = raised.resolveOwnerDecision({ ...ownerResolution(), assertCurrent: () => { if (!ownerCurrent) throw new Error('owner revoked'); } });
    const failure = resolving.then(() => undefined, (error: unknown) => error);
    await hold.entered;
    expect(broker.getApproval(raised.approval.id)?.status).toBe('pending');
    if (kind === 'source') sourceCurrent = false;
    if (kind === 'paired-owner') ownerCurrent = false;
    if (kind === 'abort') lifetime.abort();
    hold.release();
    expect(await failure).toBeInstanceOf(Error);
    expect((await raised.decision).approved).toBe(false);
    expect(broker.getApproval(raised.approval.id)?.status).toBe('cancelled');
    expect(events).not.toContain('approved');
    expect(JSON.parse(readFileSync(path, 'utf8')).approvals[0].status).toBe('cancelled');
  });

  test('generic denial wins while an owner decision write is pending', async () => {
    const { broker, store } = fixture();
    const raised = await broker.raiseOwnerApproval({ request: request('deny-race'), requireOwnerDecision: { assertCurrent: current } });
    const hold = store.holdNext();
    const resolving = raised.resolveOwnerDecision(ownerResolution());
    const failure = resolving.then(() => undefined, (error: unknown) => error);
    await hold.entered;
    const denying = broker.resolveApproval(raised.approval.id, { approved: false, actor: 'owner' });
    // Allow the denial to pass start() before releasing the held store write.
    await Promise.resolve();
    hold.release();
    expect(await failure).toBeInstanceOf(Error);
    await denying;
    expect(broker.getApproval(raised.approval.id)?.status).toBe('denied');
    expect((await raised.decision).approved).toBe(false);
  });

  test('only the real local prompt result approves and stale local prompts fail closed', async () => {
    const { broker } = fixture();
    const answer = deferred<PermissionPromptDecision>();
    let sourceCurrent = true;
    const first = await broker.raiseOwnerApproval({ request: request('local-stale'),
      requireOwnerDecision: { assertCurrent: () => { if (!sourceCurrent) throw new Error('source revoked'); } },
      localPrompt: () => answer.promise,
    });
    sourceCurrent = false;
    answer.resolve({ approved: true });
    expect((await first.decision).approved).toBe(false);
    expect(broker.getApproval(first.approval.id)?.status).toBe('cancelled');
    const second = await broker.raiseOwnerApproval({ request: request('local-valid'), requireOwnerDecision: { assertCurrent: current },
      localPrompt: async () => ({ approved: true }), localPromptActor: 'host-owner', localPromptSurface: 'owner-terminal',
    });
    expect((await second.decision).approved).toBe(true);
    expect(broker.getApproval(second.approval.id)?.audit.at(-1)).toMatchObject({ actor: 'host-owner', actorSurface: 'owner-terminal', action: 'approved' });
  });

  test('expiry still ends the exact ask and late owner answers cannot revive it', async () => {
    const { broker } = fixture();
    const raised = await broker.raiseOwnerApproval({ request: request('expiry'), requireOwnerDecision: { assertCurrent: current }, timeoutMs: 10 });
    expect((await raised.decision).approved).toBe(false);
    expect(broker.getApproval(raised.approval.id)?.status).toBe('expired');
    await expect(raised.resolveOwnerDecision(ownerResolution())).rejects.toThrow('exact current owner');
  });
});

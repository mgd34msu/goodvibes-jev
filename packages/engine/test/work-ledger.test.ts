import { describe, expect, test } from 'bun:test';
import {
  createEmptyWorkLedgerState, createWorkLedger,
  WorkLedgerAccessError, type WorkEvidenceTarget, type WorkLedgerActor, type WorkLedgerClock,
  type WorkLedgerDecision, type WorkLedgerEvent, type WorkLedgerResult,
  type WorkLedgerState, type WorkLedgerStorage, type WorkLedgerRejection,
} from '../sdk/src/platform/workflow/work-ledger/index.ts';

const PROJECT = 'native-ledger-test';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/**
 * Test-only host store: ONE authoritative state with serialized reads/writers.
 * No filesystem or durability claim. Decisions receive detached state; accepting
 * next, history, and receipts is one synchronous operation. Notification payloads
 * are detached per observer and observer failures cannot roll back a commit.
 */
class TransactionalTestStore implements WorkLedgerStorage {
  private state: unknown;
  private tail: Promise<unknown> = Promise.resolve();
  private listeners = new Set<(state: WorkLedgerState) => void>();
  private gate: {
    phase: 'before_decision' | 'after_commit';
    entered: ReturnType<typeof deferred>;
    release: ReturnType<typeof deferred>;
  } | undefined;
  private readGate: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
  decisions = 0;
  commits = 0;

  constructor(initial: unknown = createEmptyWorkLedgerState(PROJECT)) {
    this.state = structuredClone(initial);
  }

  private serialize<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  read(): Promise<unknown> {
    const gate = this.readGate;
    this.readGate = undefined;
    return this.serialize(async () => {
      if (gate) {
        gate.entered.resolve();
        await gate.release.promise;
      }
      return structuredClone(this.state);
    });
  }

  holdNextRead() {
    if (this.readGate) throw new Error('A read gate is already installed');
    const gate = { entered: deferred(), release: deferred() };
    this.readGate = gate;
    return { entered: gate.entered.promise, release: gate.release.resolve };
  }

  holdNextTransaction(phase: 'before_decision' | 'after_commit') {
    if (this.gate) throw new Error('A transaction gate is already installed');
    const gate = { phase, entered: deferred(), release: deferred() };
    this.gate = gate;
    return { entered: gate.entered.promise, release: gate.release.resolve };
  }

  transaction<T>(decide: (current: unknown) => WorkLedgerDecision<T>): Promise<T> {
    const gate = this.gate;
    this.gate = undefined;
    return this.serialize(async () => {
      if (gate?.phase === 'before_decision') {
        gate.entered.resolve();
        await gate.release.promise;
      }
      this.decisions += 1;
      const decision = decide(structuredClone(this.state));
      if (decision && typeof (decision as unknown as { then?: unknown }).then === 'function') {
        throw new Error('Transaction decisions must be synchronous');
      }
      // No await between deciding and accepting the full next state.
      if (decision.next !== null) {
        this.state = structuredClone(decision.next);
        this.commits += 1;
        const committed = structuredClone(decision.next);
        const listeners = [...this.listeners];
        queueMicrotask(() => {
          for (const listener of listeners) {
            if (!this.listeners.has(listener)) continue;
            try {
              const returned: unknown = listener(structuredClone(committed));
              void Promise.resolve(returned).catch(() => {});
            } catch { /* Isolate each post-commit observer. */ }
          }
        });
      }
      if (gate?.phase === 'after_commit') {
        gate.entered.resolve();
        await gate.release.promise;
      }
      return decision.value;
    });
  }

  subscribe(listener: (state: WorkLedgerState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  get subscriberCount() { return this.listeners.size; }
}

function testClock(): WorkLedgerClock {
  let tick = 1_700_000_000_000;
  let id = 0;
  return { now: () => ++tick, newId: kind => `${kind}-${++id}` };
}

function fixture(storage = new TransactionalTestStore(), clock = testClock()) {
  const { service, authority } = createWorkLedger({ projectId: PROJECT, storage, clock });
  const coordinator = authority.issueActor({ actorId: 'coordinator', projectId: PROJECT, role: 'coordinator' });
  const worker = authority.issueActor({ actorId: 'worker-a', projectId: PROJECT, role: 'worker' });
  const otherWorker = authority.issueActor({ actorId: 'worker-b', projectId: PROJECT, role: 'worker' });
  const verifier = authority.issueActor({ actorId: 'verifier', projectId: PROJECT, role: 'verifier' });
  let requests = 0;
  const command = (body: Record<string, unknown>, expectedRevision: number) => ({
    ...body, requestId: `request-${++requests}`, expectedRevision,
  });
  const send = async (body: Record<string, unknown>, actor = coordinator) => {
    const current = await service.readSnapshot(coordinator);
    return service.execute(command(body, current.revision), actor);
  };
  return { service, authority, storage, clock, coordinator, worker, otherWorker, verifier, command, send };
}

type Fixture = ReturnType<typeof fixture>;

function accepted(result: WorkLedgerResult): Exclude<WorkLedgerEvent, { type: 'import_legacy' }> {
  expect(result.kind).toBe('accepted');
  if (result.kind !== 'accepted') throw new Error(`${result.kind}: ${result.reason}`);
  if (result.event.type === 'import_legacy') throw new Error('Expected ordinary fixture event');
  return result.event;
}

function rejected(result: WorkLedgerResult, code: WorkLedgerRejection, revision?: number | null) {
  expect(result.kind).toBe('rejected');
  if (result.kind !== 'rejected') throw new Error('Expected rejection');
  expect(result.code).toBe(code);
  if (revision !== undefined) expect(result.revision).toBe(revision);
}

async function create(f: Fixture) {
  return accepted(await f.send({ type: 'create', title: 'Ship native ledger', goal: 'Track work explicitly', criteria: ['Tests pass'] }));
}

async function claim(f: Fixture, workId: string, actor = f.worker) {
  return accepted(await f.send({ type: 'claim', workId }, actor));
}

async function complete(f: Fixture) {
  const created = await create(f);
  const claimed = await claim(f, created.workId);
  const completed = accepted(await f.send({
    type: 'report', workId: created.workId, attemptId: claimed.attemptId,
    state: 'complete', report: 'Implementation ready for independent verification',
  }, f.worker));
  const attempt = completed.attempts[0]!;
  const target: WorkEvidenceTarget = {
    workId: completed.workId, workRevision: completed.work.revision,
    criteriaRevision: completed.work.criteriaRevision,
    attemptId: attempt.id, attemptRevision: attempt.revision,
  };
  return { created, claimed, completed, target };
}

function evidence(target: WorkEvidenceTarget, overrides: Record<string, unknown> = {}) {
  return {
    type: 'record_evidence', target, outcome: 'verified', source: 'host_check',
    reason: 'All acceptance checks passed',
    references: [{ kind: 'test', ref: 'test-output', digest: 'sha256:test-output-v1' }],
    criteriaResults: [{ criterionIndex: 0, status: 'satisfied', references: ['test-output'] }],
    ...overrides,
  };
}

async function flushObservers() {
  await new Promise<void>(resolve => setTimeout(resolve, 0));
}

describe('native work ledger state and ownership', () => {
  test('starts empty and records create, claim, blocked report, and progress with immutable history', async () => {
    const f = fixture();
    expect(await f.service.readSnapshot(f.coordinator)).toEqual({ projectId: PROJECT, revision: 0, cursor: 0, works: [] });
    const created = await create(f);
    expect(created.work).toMatchObject({ revision: 1, criteriaRevision: 1, reportedState: 'pending', currentAttemptId: null });
    const claimed = await claim(f, created.workId);
    expect(claimed.attempts[0]).toMatchObject({ ownerId: 'worker-a', revision: 1, state: 'active', predecessorId: null });
    accepted(await f.send({ type: 'report', workId: created.workId, attemptId: claimed.attemptId,
      state: 'blocked', report: 'Waiting on dependency', blocker: 'API unavailable' }, f.worker));
    let view = (await f.service.readSnapshot(f.worker)).works[0]!;
    expect(view.work.reportedState).toBe('blocked');
    expect(view.attention).toEqual([{ kind: 'blocked', reason: 'API unavailable' }]);
    expect(view.verification.state).toBe('unverified');
    accepted(await f.send({ type: 'report', workId: created.workId, attemptId: claimed.attemptId,
      state: 'in_progress', report: 'Dependency restored' }, f.worker));
    view = (await f.service.readSnapshot(f.worker)).works[0]!;
    expect(view.attempt).toMatchObject({ revision: 3, blocker: null, state: 'active' });
    expect(view.attention).toEqual([]);
    const history = await f.service.history(0, f.coordinator);
    expect(history.map(event => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(history[0]).toMatchObject({ work: { reportedState: 'pending' } });
    expect(history[1]).toMatchObject({ attempts: [{ revision: 1 }] });
    expect((await f.service.history(2, f.worker)).map(event => event.type)).toEqual(['report', 'report']);
    await expect(f.service.history(-1, f.worker)).rejects.toThrow('Invalid history cursor');
    await expect(f.service.history(0.5, f.worker)).rejects.toThrow('Invalid history cursor');
  });

  test('handoff preserves the old owner and chains the next attempt; former owner cannot report', async () => {
    const f = fixture();
    const created = await create(f);
    const claimed = await claim(f, created.workId);
    rejected(await f.send({ type: 'handoff', workId: created.workId, attemptId: claimed.attemptId,
      targetActorId: 'worker-a', reason: 'No change' }, f.worker), 'invalid_command', 2);
    const handed = accepted(await f.send({ type: 'handoff', workId: created.workId, attemptId: claimed.attemptId,
      targetActorId: 'worker-b', reason: 'Specialist takes over' }, f.worker));
    expect(handed.attempts).toHaveLength(2);
    expect(handed.attempts[0]).toMatchObject({ id: claimed.attemptId, state: 'released', ownerId: 'worker-a', revision: 2 });
    expect(handed.attempts[1]).toMatchObject({ predecessorId: claimed.attemptId, state: 'active', ownerId: 'worker-b', revision: 1 });
    expect(handed.attemptId).not.toBe(claimed.attemptId);
    rejected(await f.send({ type: 'report', workId: created.workId, attemptId: handed.attemptId,
      state: 'complete', report: 'Former owner attempts update' }, f.worker), 'forbidden', 3);
    accepted(await f.send({ type: 'report', workId: created.workId, attemptId: handed.attemptId,
      state: 'complete', report: 'New owner finished' }, f.otherWorker));
  });

  test('release, cancel, and reopen retain attempt lineage and enforce terminal transitions', async () => {
    const f = fixture();
    const created = await create(f);
    const first = await claim(f, created.workId);
    accepted(await f.send({ type: 'release', workId: created.workId, attemptId: first.attemptId, reason: 'Capacity changed' }, f.worker));
    const second = await claim(f, created.workId, f.otherWorker);
    expect(second.attempts[0]!.predecessorId).toBe(first.attemptId);
    const cancelled = accepted(await f.send({ type: 'cancel', workId: created.workId, reason: 'Paused project' }));
    expect(cancelled.attempts[0]!.state).toBe('cancelled');
    expect((await f.service.readSnapshot(f.coordinator)).works[0]!.allowedActions).toEqual(['reopen']);
    expect((await f.service.readSnapshot(f.otherWorker)).works[0]!.allowedActions).toEqual([]);
    rejected(await f.send({ type: 'claim', workId: created.workId }, f.worker), 'invalid_transition', 5);
    rejected(await f.send({ type: 'reopen', workId: created.workId, reason: 'Unauthorized' }, f.worker), 'forbidden', 5);
    accepted(await f.send({ type: 'reopen', workId: created.workId, reason: 'Resume project' }));
    const third = await claim(f, created.workId);
    expect(third.attempts[0]!.predecessorId).toBe(second.attemptId);
    expect((await f.storage.read() as WorkLedgerState).attempts.map(attempt => attempt.ownerId)).toEqual(['worker-a', 'worker-b', 'worker-a']);
  });

  test('rejects role violations, invalid commands, double claims, and obsolete attempt IDs without a commit', async () => {
    const f = fixture();
    rejected(await f.send({ type: 'create', title: 'No', goal: 'No', criteria: ['No'] }, f.worker), 'forbidden', 0);
    rejected(await f.service.execute({ ...f.command({ type: 'create', title: 'Title', goal: 'Goal', criteria: ['Criterion'] }, 0), actorId: 'coordinator' }, f.worker), 'invalid_command', null);
    const created = await create(f);
    rejected(await f.send({ type: 'claim', workId: created.workId }, f.verifier), 'forbidden', 1);
    const claimed = await claim(f, created.workId);
    rejected(await f.send({ type: 'claim', workId: created.workId }, f.otherWorker), 'invalid_transition', 2);
    rejected(await f.send({ type: 'report', workId: created.workId, attemptId: 'obsolete-attempt', state: 'complete', report: 'Done' }, f.worker), 'invalid_transition', 2);
    rejected(await f.send({ type: 'report', workId: created.workId, attemptId: claimed.attemptId, state: 'blocked', report: 'Blocked without reason' }, f.worker), 'invalid_command', 2);
    rejected(await f.send({ type: 'cancel', workId: created.workId, reason: 'Worker cannot cancel' }, f.worker), 'forbidden', 2);
    rejected(await f.send({ type: 'claim', workId: 'missing' }, f.worker), 'not_found', 2);
    expect(f.storage.commits).toBe(2);
    expect(await f.service.history(0, f.coordinator)).toHaveLength(2);
  });
});

describe('aggregate concurrency and replay', () => {
  test('expectedRevision covers the entire ledger, including edits to another work', async () => {
    const f = fixture();
    const first = await create(f);
    await create(f);
    rejected(await f.service.execute(f.command({ type: 'claim', workId: first.workId }, 1), f.worker), 'conflict', 2);
    expect(f.storage.commits).toBe(2);
  });

  test('one authoritative store admits only one concurrent writer across service instances', async () => {
    const storage = new TransactionalTestStore();
    const clock = testClock();
    const a = fixture(storage, clock);
    const b = fixture(storage, clock);
    const results = await Promise.all([
      a.service.execute({ ...a.command({ type: 'create', title: 'A', goal: 'A', criteria: ['A'] }, 0), requestId: 'writer-a' }, a.coordinator),
      b.service.execute({ ...b.command({ type: 'create', title: 'B', goal: 'B', criteria: ['B'] }, 0), requestId: 'writer-b' }, b.coordinator),
    ]);
    expect(results.filter(result => result.kind === 'accepted')).toHaveLength(1);
    rejected(results.find(result => result.kind === 'rejected')!, 'conflict', 1);
    expect(storage.commits).toBe(1);
    expect(await a.service.readSnapshot(a.worker)).toEqual(await b.service.readSnapshot(b.worker));
  });

  test('exact retry returns the original receipt before CAS, while changed payload or role conflicts', async () => {
    const f = fixture();
    const command = f.command({ type: 'create', title: 'First title', goal: 'Goal', criteria: ['Pass'] }, 0);
    const original = accepted(await f.service.execute(command, f.coordinator));
    await create(f);
    const replay = await f.service.execute(command, f.coordinator);
    expect(replay).toEqual({ kind: 'accepted', replayed: true, event: original });
    rejected(await f.service.execute({ ...command, title: 'Different title' }, f.coordinator), 'request_conflict', 2);
    rejected(await f.service.execute({ ...command, expectedRevision: 2 }, f.coordinator), 'request_conflict', 2);
    const changedRole = f.authority.issueActor({ actorId: 'coordinator', role: 'worker', projectId: PROJECT });
    rejected(await f.service.execute(command, changedRole), 'request_conflict', 2);
    const second = fixture(f.storage, f.clock);
    expect(await second.service.execute(command, second.coordinator)).toEqual(replay);
    expect(f.storage.commits).toBe(2);
    const state = await f.storage.read() as WorkLedgerState;
    expect(state.history).toHaveLength(2);
    expect(state.receipts).toHaveLength(2);
  });

  test('snapshots, events, and store reads cannot mutate authoritative state or receipts', async () => {
    const f = fixture();
    const command = f.command({ type: 'create', title: 'Original', goal: 'Goal', criteria: ['Pass'] }, 0);
    const result = accepted(await f.service.execute(command, f.coordinator));
    result.work.title = 'Mutated result';
    const snapshot = await f.service.readSnapshot(f.worker);
    snapshot.works[0]!.work.criteria.push('Injected criterion');
    const state = await f.storage.read() as WorkLedgerState;
    state.works.length = 0;
    const replay = accepted(await f.service.execute(command, f.coordinator));
    expect(replay.work.title).toBe('Original');
    expect((await f.service.readSnapshot(f.worker)).works[0]!.work.criteria).toEqual(['Pass']);
    expect((await f.service.history(0, f.worker))[0]).toMatchObject({ work: { title: 'Original' } });
  });
});

describe('evidence is independent from reported completion', () => {
  test('a completed report remains unverified and cannot be self-verified', async () => {
    const f = fixture();
    const { target } = await complete(f);
    const view = (await f.service.readSnapshot(f.worker)).works[0]!;
    expect(view.work.reportedState).toBe('complete');
    expect(view.verification.state).toBe('unverified');
    expect(view.attention.map(item => item.kind)).toEqual(['verification']);
    rejected(await f.send(evidence(target, { reason: 'I say it passed' }), f.worker), 'forbidden', 3);
    expect((await f.service.readSnapshot(f.verifier)).works[0]!.allowedActions).toEqual(['record_evidence']);
  });

  test('verified evidence requires a reference; failed and unavailable remain distinct', async () => {
    const f = fixture();
    const { target } = await complete(f);
    rejected(await f.send(evidence(target, { references: [] }), f.verifier), 'invalid_command', 3);
    for (const outcome of ['failed', 'unavailable', 'verified'] as const) {
      accepted(await f.send(evidence(target, { outcome, reason: `Verification is ${outcome}`,
        ...(outcome === 'verified' ? {} : { references: [], criteriaResults: [] }) }), f.verifier));
      const view = (await f.service.readSnapshot(f.worker)).works[0]!;
      expect(view.verification.state).toBe(outcome);
      expect(view.verification.reason).toBe(`Verification is ${outcome}`);
      expect(view.work.reportedState).toBe('complete');
      expect(view.work.revision).toBe(target.workRevision);
      expect(view.attention).toHaveLength(outcome === 'verified' ? 0 : 1);
    }
    expect((await f.storage.read() as WorkLedgerState).evidence).toHaveLength(3);
  });

  test('same-text criteria revision makes old evidence stale and rejects the obsolete target', async () => {
    const f = fixture();
    const { target, completed } = await complete(f);
    accepted(await f.send(evidence(target), f.verifier));
    accepted(await f.send({ type: 'revise', workId: target.workId, title: completed.work.title, goal: completed.work.goal, criteria: completed.work.criteria }));
    const view = (await f.service.readSnapshot(f.worker)).works[0]!;
    expect(view.verification.state).toBe('stale');
    expect(view.verification.evidence!.target).toEqual(target);
    expect(view.work.criteriaRevision).toBe(target.criteriaRevision + 1);
    expect(view.attention).toHaveLength(1);
    rejected(await f.send(evidence(target, { reason: 'Obsolete proof' }), f.verifier), 'stale_evidence', 5);
  });

  test('reopening verified work preserves evidence while new ownership cannot inherit its verdict', async () => {
    const f = fixture();
    const { target } = await complete(f);
    accepted(await f.send(evidence(target), f.verifier));
    accepted(await f.send({ type: 'reopen', workId: target.workId, reason: 'Additional work required' }));
    const next = await claim(f, target.workId, f.otherWorker);
    expect(next.attempts[0]!.predecessorId).toBe(target.attemptId);
    expect(next.attemptId).not.toBe(target.attemptId);
    expect((await f.service.readSnapshot(f.otherWorker)).works[0]!.verification.state).toBe('stale');
    rejected(await f.send(evidence(target, { reason: 'Old owner proof' }), f.verifier), 'stale_evidence', 6);
  });
});

describe('trusted actor capabilities', () => {
  test('forged, copied, foreign-instance, and revoked handles are rejected before storage admission', async () => {
    const f = fixture();
    const foreign = fixture();
    const command = f.command({ type: 'create', title: 'Title', goal: 'Goal', criteria: ['Pass'] }, 0);
    const revoked = f.authority.issueActor({ actorId: 'revoked', projectId: PROJECT, role: 'coordinator' });
    f.authority.revokeActor(revoked);
    for (const actor of [{ actorId: 'coordinator', projectId: PROJECT, role: 'coordinator' }, { ...f.coordinator }, structuredClone(f.coordinator), foreign.coordinator, revoked]) {
      rejected(await f.service.execute(command, actor as WorkLedgerActor), 'forbidden', null);
      await expect(f.service.readSnapshot(actor as WorkLedgerActor)).rejects.toThrow('Invalid or revoked');
      await expect(f.service.history(0, actor as WorkLedgerActor)).rejects.toThrow('Invalid or revoked');
      expect(() => f.service.subscribe(actor as WorkLedgerActor, () => {})).toThrow('Invalid or revoked');
    }
    expect(f.storage.decisions).toBe(0);
    expect(() => f.authority.issueActor({ actorId: 'wrong-project', projectId: 'another-project', role: 'coordinator' })).toThrow('project mismatch');
  });

  test('host identity input is copied and cannot be changed into a different role', async () => {
    const f = fixture();
    const identity: { actorId: string; projectId: string; role: 'worker' | 'coordinator' } = { actorId: 'mutable', projectId: PROJECT, role: 'worker' };
    const actor = f.authority.issueActor(identity);
    identity.role = 'coordinator';
    identity.actorId = 'coordinator';
    rejected(await f.send({ type: 'create', title: 'Escalation', goal: 'No', criteria: ['No'] }, actor), 'forbidden', 0);
  });

  test('revocation while a command is queued is checked again at the atomic decision', async () => {
    const f = fixture();
    const gate = f.storage.holdNextTransaction('before_decision');
    const operation = f.service.execute(f.command({ type: 'create', title: 'Title', goal: 'Goal', criteria: ['Pass'] }, 0), f.coordinator);
    await gate.entered;
    f.authority.revokeActor(f.coordinator);
    gate.release();
    rejected(await operation, 'forbidden', 0);
    expect(f.storage.commits).toBe(0);
  });
});

describe('cancellation and lifecycle', () => {
  test('abort before the decision rejects with no committed state or receipt', async () => {
    const f = fixture();
    const abort = new AbortController();
    const gate = f.storage.holdNextTransaction('before_decision');
    const operation = f.service.execute(f.command({ type: 'create', title: 'Title', goal: 'Goal', criteria: ['Pass'] }, 0), f.coordinator, { signal: abort.signal });
    await gate.entered;
    abort.abort();
    gate.release();
    rejected(await operation, 'cancelled', 0);
    expect(f.storage.commits).toBe(0);
    expect((await f.storage.read() as WorkLedgerState).receipts).toEqual([]);
  });

  test('abort after the commit cannot turn accepted work into a cancellation', async () => {
    const f = fixture();
    const abort = new AbortController();
    const gate = f.storage.holdNextTransaction('after_commit');
    const command = f.command({ type: 'create', title: 'Title', goal: 'Goal', criteria: ['Pass'] }, 0);
    const operation = f.service.execute(command, f.coordinator, { signal: abort.signal });
    await gate.entered;
    expect(f.storage.commits).toBe(1);
    abort.abort();
    gate.release();
    const event = accepted(await operation);
    expect(await f.service.execute(command, f.coordinator)).toEqual({ kind: 'accepted', replayed: true, event });
    expect(f.storage.commits).toBe(1);
  });

  test('close stops new admissions and subscriptions but drains admitted commands exactly once', async () => {
    const f = fixture();
    const notifications: number[] = [];
    f.service.subscribe(f.worker, snapshot => { notifications.push(snapshot.revision); });
    const gate = f.storage.holdNextTransaction('before_decision');
    const operation = f.service.execute(f.command({ type: 'create', title: 'Title', goal: 'Goal', criteria: ['Pass'] }, 0), f.coordinator);
    await gate.entered;
    const closing = f.service.close();
    expect(f.service.close()).toBe(closing);
    let closed = false;
    void closing.then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(f.storage.subscriberCount).toBe(0);
    rejected(await f.service.execute(f.command({ type: 'claim', workId: 'any' }, 0), f.worker), 'closed', null);
    await expect(f.service.readSnapshot(f.worker)).rejects.toThrow('closed');
    await expect(f.service.history(0, f.worker)).rejects.toThrow('closed');
    expect(() => f.service.subscribe(f.worker, () => {})).toThrow('closed');
    expect(() => f.authority.issueActor({ actorId: 'late', projectId: PROJECT, role: 'worker' })).toThrow('closed');
    gate.release();
    accepted(await operation);
    await closing;
    expect(closed).toBe(true);
    expect(f.storage.commits).toBe(1);
    await flushObservers();
    expect(notifications).toEqual([]);
  });

  test('host errors roll back; close still drains the admitted operation', async () => {
    const storage = new TransactionalTestStore();
    const clock: WorkLedgerClock = { now: () => 1, newId: () => { throw new Error('Host ID generator failed'); } };
    const f = fixture(storage, clock);
    const operation = f.service.execute(f.command({ type: 'create', title: 'Title', goal: 'Goal', criteria: ['Pass'] }, 0), f.coordinator);
    await f.service.close();
    rejected(await operation, 'host_error', 0);
    expect(storage.commits).toBe(0);
    expect((await storage.read() as WorkLedgerState).revision).toBe(0);
  });
});

describe('post-commit observers and corrupt host state', () => {
  test('subscribers receive ordered cross-service commits and failures never fail writes', async () => {
    const storage = new TransactionalTestStore();
    const clock = testClock();
    const a = fixture(storage, clock);
    const b = fixture(storage, clock);
    const revisions: number[] = [];
    let throwingCalls = 0;
    let asyncCalls = 0;
    a.service.subscribe(a.worker, () => { throwingCalls += 1; throw new Error('Observer failed'); });
    a.service.subscribe(a.worker, async () => { asyncCalls += 1; throw new Error('Async observer failed'); });
    const unsubscribe = a.service.subscribe(a.worker, snapshot => {
      revisions.push(snapshot.revision);
      snapshot.works[0]!.work.title = 'Observer mutation';
    });
    expect(revisions).toEqual([]); // subscribe is a delta feed, not an initial snapshot.
    const first = accepted(await b.service.execute({ ...b.command({ type: 'create', title: 'Original', goal: 'Goal', criteria: ['Pass'] }, 0), requestId: 'other-writer-create' }, b.coordinator));
    await b.service.execute({ ...b.command({ type: 'claim', workId: first.workId }, 1), requestId: 'other-writer-claim' }, b.worker);
    await flushObservers();
    expect(revisions).toEqual([1, 2]);
    expect(throwingCalls).toBe(2);
    expect(asyncCalls).toBe(2);
    expect((await a.service.readSnapshot(a.worker)).works[0]!.work.title).toBe('Original');
    unsubscribe();
    unsubscribe();
    accepted(await b.send({ type: 'cancel', workId: first.workId, reason: 'Stop' }));
    await flushObservers();
    expect(revisions).toEqual([1, 2]);
    await Promise.all([a.service.close(), b.service.close()]);
    expect(storage.subscriberCount).toBe(0);
  });

  test('revoked subscribers stop receiving committed changes', async () => {
    const f = fixture();
    const revisions: number[] = [];
    f.service.subscribe(f.worker, snapshot => { revisions.push(snapshot.revision); });
    await create(f);
    await flushObservers();
    f.authority.revokeActor(f.worker);
    expect(f.storage.subscriberCount).toBe(0);
    await create(f);
    await flushObservers();
    expect(revisions).toEqual([1]);
    await f.service.close();
  });

  test('reads are serialized behind admitted transactions and never see an intermediate state', async () => {
    const f = fixture();
    const gate = f.storage.holdNextTransaction('before_decision');
    const operation = f.service.execute(f.command({ type: 'create', title: 'Title', goal: 'Goal', criteria: ['Pass'] }, 0), f.coordinator);
    await gate.entered;
    let readResolved = false;
    const reading = f.service.readSnapshot(f.worker).then(snapshot => { readResolved = true; return snapshot; });
    await Promise.resolve();
    expect(readResolved).toBe(false);
    gate.release();
    accepted(await operation);
    const snapshot = await reading;
    expect(snapshot.revision).toBe(1);
    expect(snapshot.works).toHaveLength(1);
  });

  test('malformed, wrong-project, and inconsistent stored states fail closed rather than reset', async () => {
    const states: unknown[] = [
      { version: 1, projectId: PROJECT },
      createEmptyWorkLedgerState('foreign-project'),
      { ...createEmptyWorkLedgerState(PROJECT), revision: 1 },
    ];
    for (const state of states) {
      const f = fixture(new TransactionalTestStore(state));
      await expect(f.service.readSnapshot(f.worker)).rejects.toThrow();
      rejected(await f.service.execute(f.command({ type: 'create', title: 'Title', goal: 'Goal', criteria: ['Pass'] }, 0), f.coordinator), 'invalid_state', null);
      expect(f.storage.commits).toBe(0);
      expect(await f.storage.read()).toEqual(state);
      await f.service.close();
    }
  });
});

describe('fail-closed evidence validation', () => {
  test('verified requires complete criterion coverage, content-bound references, and host checks', async () => {
    const f = fixture();
    const { target } = await complete(f);
    const invalidProofs = [
      { source: 'judgment' },
      { criteriaResults: [] },
      { criteriaResults: [{ criterionIndex: 1, status: 'satisfied', references: ['test-output'] }] },
      { criteriaResults: [{ criterionIndex: 0, status: 'unknown', references: ['test-output'] }] },
      { criteriaResults: [{ criterionIndex: 0, status: 'unsatisfied', references: ['test-output'] }] },
      { criteriaResults: [{ criterionIndex: 0, status: 'satisfied', references: [] }] },
      { criteriaResults: [{ criterionIndex: 0, status: 'satisfied', references: ['missing-reference'] }] },
      { references: [{ kind: 'test', ref: 'test-output' }] },
      { criteriaResults: [
        { criterionIndex: 0, status: 'satisfied', references: ['test-output'] },
        { criterionIndex: 0, status: 'satisfied', references: ['test-output'] },
      ] },
    ];
    for (const proof of invalidProofs) {
      rejected(await f.send(evidence(target, proof), f.verifier), 'invalid_command', 3);
    }
    expect(f.storage.commits).toBe(3);
    expect((await f.service.readSnapshot(f.worker)).works[0]!.verification.state).toBe('unverified');
    accepted(await f.send(evidence(target), f.verifier));
  });

  test('all revision and attempt identity components bind evidence to the exact target', async () => {
    const f = fixture();
    const { target } = await complete(f);
    for (const oldTarget of [
      { ...target, workRevision: target.workRevision - 1 },
      { ...target, criteriaRevision: target.criteriaRevision + 1 },
      { ...target, attemptRevision: target.attemptRevision - 1 },
      { ...target, attemptId: 'another-attempt' },
    ]) {
      rejected(await f.send(evidence(oldTarget), f.verifier), 'stale_evidence', 3);
    }
    expect(f.storage.commits).toBe(3);
  });

  test('partial coverage cannot verify multiple acceptance criteria', async () => {
    const f = fixture();
    const { target, completed } = await complete(f);
    const revised = accepted(await f.send({ type: 'revise', workId: target.workId,
      title: completed.work.title, goal: completed.work.goal, criteria: ['Tests pass', 'Owner approves'] }));
    const current = { ...target, workRevision: revised.work.revision, criteriaRevision: revised.work.criteriaRevision };
    rejected(await f.send(evidence(current), f.verifier), 'invalid_command', 4);
    accepted(await f.send(evidence(current, { criteriaResults: [
      { criterionIndex: 0, status: 'satisfied', references: ['test-output'] },
      { criterionIndex: 1, status: 'satisfied', references: ['test-output'] },
    ] }), f.verifier));
    expect((await f.service.readSnapshot(f.worker)).works[0]!.verification.state).toBe('verified');
  });
});

describe('commit boundary adversarial checks', () => {
  test('an already-aborted exact retry reports the durable receipt', async () => {
    const f = fixture();
    const command = f.command({ type: 'create', title: 'Title', goal: 'Goal', criteria: ['Pass'] }, 0);
    const event = accepted(await f.service.execute(command, f.coordinator));
    const abort = new AbortController();
    abort.abort();
    expect(await f.service.execute(command, f.coordinator, { signal: abort.signal })).toEqual({ kind: 'accepted', replayed: true, event });
    expect(f.storage.commits).toBe(1);
  });

  test('synchronous host callbacks cannot abort or revoke after the last guard and still publish', async () => {
    for (const action of ['abort', 'revoke'] as const) {
      const abort = new AbortController();
      let invalidate = () => {};
      const clock: WorkLedgerClock = { now: () => 1, newId: kind => { invalidate(); return `${kind}-1`; } };
      const f = fixture(new TransactionalTestStore(), clock);
      invalidate = action === 'abort' ? () => abort.abort() : () => f.authority.revokeActor(f.coordinator);
      rejected(await f.service.execute(f.command({ type: 'create', title: 'Title', goal: 'Goal', criteria: ['Pass'] }, 0), f.coordinator, { signal: abort.signal }), action === 'abort' ? 'cancelled' : 'forbidden', 0);
      expect(f.storage.commits).toBe(0);
      expect((await f.storage.read() as WorkLedgerState).history).toEqual([]);
    }
  });

  test('invalid clock values and duplicate generated identities cannot partially commit', async () => {
    for (const now of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const f = fixture(new TransactionalTestStore(), { now: () => now, newId: kind => `${kind}-1` });
      rejected(await f.service.execute(f.command({ type: 'create', title: 'Title', goal: 'Goal', criteria: ['Pass'] }, 0), f.coordinator), 'host_error', 0);
      expect(f.storage.commits).toBe(0);
    }
    const f = fixture(new TransactionalTestStore(), { now: () => 1, newId: () => 'duplicate' });
    await create(f);
    rejected(await f.send({ type: 'create', title: 'Second', goal: 'Goal', criteria: ['Pass'] }), 'host_error', 1);
    expect((await f.storage.read() as WorkLedgerState).works).toHaveLength(1);
  });

  test('an uncertain storage acknowledgement returns reconciliation identity and exact retry cannot duplicate', async () => {
    class UncertainAcknowledgementStore extends TransactionalTestStore {
      loseNextAcknowledgement = true;
      override async transaction<T>(decide: (current: unknown) => WorkLedgerDecision<T>): Promise<T> {
        const result = await super.transaction(decide);
        if (this.loseNextAcknowledgement) {
          this.loseNextAcknowledgement = false;
          throw new Error('Commit acknowledgement unavailable');
        }
        return result;
      }
    }
    const storage = new UncertainAcknowledgementStore();
    const f = fixture(storage);
    const command = f.command({ type: 'create', title: 'Title', goal: 'Goal', criteria: ['Pass'] }, 0);
    expect(await f.service.execute(command, f.coordinator)).toMatchObject({ kind: 'indeterminate', requestId: command.requestId, actorId: 'coordinator' });
    expect(storage.commits).toBe(1);
    const retry = await f.service.execute(command, f.coordinator);
    expect(retry.kind).toBe('accepted');
    if (retry.kind === 'accepted') expect(retry.replayed).toBe(true);
    expect(storage.commits).toBe(1);
    expect(await f.service.history(0, f.coordinator)).toHaveLength(1);
  });

  test('close also drains already-admitted snapshot and history reads', async () => {
    const f = fixture();
    const gate = f.storage.holdNextRead();
    const snapshot = f.service.readSnapshot(f.worker);
    const history = f.service.history(0, f.worker);
    // Attach rejection handlers before closing; neither may complete beforehand.
    const snapshotClosed = snapshot.then(() => null, error => error as WorkLedgerAccessError);
    const historyClosed = history.then(() => null, error => error as WorkLedgerAccessError);
    await gate.entered;
    let closed = false;
    const closing = f.service.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    gate.release();
    const [snapshotError, historyError] = await Promise.all([snapshotClosed, historyClosed, closing]);
    expect(snapshotError).toMatchObject({ code: 'closed' });
    expect(historyError).toMatchObject({ code: 'closed' });
    expect(closed).toBe(true);
  });

  test('revocation during a read rejects before returning potentially stale authority', async () => {
    const f = fixture();
    const gate = f.storage.holdNextRead();
    const reading = f.service.readSnapshot(f.worker);
    const forbidden = reading.then(() => null, error => error as WorkLedgerAccessError);
    await gate.entered;
    f.authority.revokeActor(f.worker);
    gate.release();
    expect(await forbidden).toMatchObject({ code: 'forbidden' });
  });
});

describe('stored record integrity', () => {
  test('orphan records, forged history, and detached receipts fail with stable invalid_state errors', async () => {
    const original = fixture();
    await complete(original);
    const healthy = await original.storage.read() as WorkLedgerState;
    const mutations: ((state: WorkLedgerState) => void)[] = [
      state => { state.works[0]!.title = 'Edited outside history'; },
      state => { state.attempts[0]!.ownerId = 'forged-owner'; },
      state => { state.attempts.push({ ...state.attempts[0]!, id: 'orphan-attempt', state: 'released' }); },
      state => { state.history[1]!.sequence = 9; },
      state => { const event = state.receipts[0]!.event; if (event.type !== 'import_legacy') event.work.goal = 'Detached receipt'; },
      state => { state.receipts[0]!.signature = '{}'; },
      state => { state.receipts.pop(); },
    ];
    for (const mutate of mutations) {
      const broken = structuredClone(healthy);
      mutate(broken);
      const f = fixture(new TransactionalTestStore(broken));
      try {
        await f.service.readSnapshot(f.worker);
        throw new Error('Expected invalid stored state');
      } catch (error) {
        expect(error).toBeInstanceOf(WorkLedgerAccessError);
        expect((error as WorkLedgerAccessError).code).toBe('invalid_state');
      }
      rejected(await f.service.execute(f.command({ type: 'create', title: 'Title', goal: 'Goal', criteria: ['Pass'] }, 3), f.coordinator), 'invalid_state', null);
      expect(f.storage.commits).toBe(0);
      expect(await f.storage.read()).toEqual(broken);
    }
  });
});

describe('reentrant admission ownership', () => {
  for (const method of ['readSnapshot', 'history'] as const) {
    for (const fails of [false, true]) {
    test(`${method} owns ${fails ? 'rejecting' : 'resolving'} IO before storage.read synchronously closes the host`, async () => {
      const release = deferred();
      let onRead = () => {};
      class ReentrantReadStore extends TransactionalTestStore {
        override read(): Promise<unknown> {
          onRead();
          return release.promise.then(() => {
            if (fails) throw new Error('Read failed after reentrant close');
            return super.read();
          });
        }
      }
      const f = fixture(new ReentrantReadStore());
      let drained = false;
      let closing: Promise<void> | undefined;
      onRead = () => { closing = f.service.close().then(() => { drained = true; }); };
      const reading = method === 'readSnapshot' ? f.service.readSnapshot(f.worker) : f.service.history(0, f.worker);
      const result = reading.then(() => null, error => error as WorkLedgerAccessError);
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
      const prematurelyDrained = drained;
      release.resolve();
      expect(await result).toMatchObject({ code: fails ? 'storage_error' : 'closed' });
      await closing;
      expect(prematurelyDrained).toBe(false);
      expect(drained).toBe(true);
    });
    }
  }

  test('execute owns admission before command getters can synchronously close the host', async () => {
    const f = fixture();
    const gate = f.storage.holdNextTransaction('before_decision');
    let drained = false;
    let closing: Promise<void> | undefined;
    const command = f.command({ type: 'create', title: 'Title', goal: 'Goal', criteria: ['Pass'] }, 0);
    Object.defineProperty(command, 'title', { enumerable: true, get() {
      closing = f.service.close().then(() => { drained = true; });
      return 'Title';
    } });
    const execution = f.service.execute(command, f.coordinator);
    await gate.entered;
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    const prematurelyDrained = drained;
    gate.release();
    expect((await execution).kind).toBe('accepted');
    await closing;
    expect(prematurelyDrained).toBe(false);
    expect(drained).toBe(true);
  });

  test('execute owns admission before a transaction adapter can synchronously close the host', async () => {
    let onTransaction = () => {};
    class ReentrantTransactionStore extends TransactionalTestStore {
      override transaction<T>(decide: (current: unknown) => WorkLedgerDecision<T>): Promise<T> {
        onTransaction();
        return super.transaction(decide);
      }
    }
    const f = fixture(new ReentrantTransactionStore());
    const gate = f.storage.holdNextTransaction('before_decision');
    let drained = false;
    let closing: Promise<void> | undefined;
    onTransaction = () => { closing = f.service.close().then(() => { drained = true; }); };
    const execution = f.service.execute(f.command({ type: 'create', title: 'Title', goal: 'Goal', criteria: ['Pass'] }, 0), f.coordinator);
    await gate.entered;
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    const prematurelyDrained = drained;
    gate.release();
    expect((await execution).kind).toBe('accepted');
    await closing;
    expect(prematurelyDrained).toBe(false);
    expect(drained).toBe(true);
  });

  test('close publishes one stable promise before subscription cleanup can reenter close', async () => {
    let onCleanup = () => {};
    class ReentrantCleanupStore extends TransactionalTestStore {
      override subscribe(listener: (state: WorkLedgerState) => void): () => void {
        const cleanup = super.subscribe(listener);
        return () => { cleanup(); onCleanup(); };
      }
    }
    const f = fixture(new ReentrantCleanupStore());
    let nested: Promise<void> | undefined;
    onCleanup = () => { nested = f.service.close(); };
    f.service.subscribe(f.worker, () => {});
    const closing = f.service.close();
    await closing;
    expect(nested).toBe(closing);
    expect(f.service.close()).toBe(closing);
  });
});


describe('subscription admission reentrancy', () => {
  test('synchronous notification followed by adapter throw never escapes failed admission', async () => {
    class ThrowingSubscribeStore extends TransactionalTestStore {
      override subscribe(listener: (state: WorkLedgerState) => void): () => void {
        listener(createEmptyWorkLedgerState(PROJECT));
        throw new Error('Subscription admission failed');
      }
    }
    const f = fixture(new ThrowingSubscribeStore());
    let observed = 0;
    expect(() => f.service.subscribe(f.worker, () => { observed += 1; })).toThrow('Subscription admission failed');
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(observed).toBe(0);
    await f.service.close();
  });

  test('reentrant close owns the late-returned subscription cleanup and preserves its promise', async () => {
    let onSubscribe = () => {};
    let onCleanup = () => {};
    let cleanupCalls = 0;
    class ClosingSubscribeStore extends TransactionalTestStore {
      override subscribe(listener: (state: WorkLedgerState) => void): () => void {
        listener(createEmptyWorkLedgerState(PROJECT));
        onSubscribe();
        return () => { cleanupCalls += 1; onCleanup(); };
      }
    }
    const f = fixture(new ClosingSubscribeStore());
    let closing: Promise<void> | undefined;
    let nested: Promise<void> | undefined;
    let observed = 0;
    onSubscribe = () => { closing = f.service.close(); };
    onCleanup = () => { nested = f.service.close(); };
    expect(() => f.service.subscribe(f.worker, () => { observed += 1; })).toThrow('Work ledger is closed');
    await closing;
    expect(nested).toBe(closing);
    expect(cleanupCalls).toBe(1);
    expect(observed).toBe(0);
  });
});

test('final abort-state accessor cannot revoke authority after the commit guard', async () => {
  const f = fixture();
  let reads = 0;
  const signal = { get aborted() {
    reads += 1;
    if (reads === 2) f.authority.revokeActor(f.coordinator);
    return false;
  } } as AbortSignal;
  const result = await f.service.execute(f.command({ type: 'create', title: 'Title', goal: 'Goal', criteria: ['Pass'] }, 0), f.coordinator, { signal });
  rejected(result, 'forbidden', 0);
  expect(f.storage.commits).toBe(0);
});

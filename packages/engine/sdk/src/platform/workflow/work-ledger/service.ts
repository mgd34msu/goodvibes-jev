import { readWorkLedgerState as readState, workEvidenceTargetMatches as targetMatches, workLedgerIdentitySchema as identitySchema } from './state.js';
import { workExecutionViewSchema } from './execution-types.js';
import { executionIsCurrent } from './execution-state.js';
import { validateNativeExecutionDecision } from './execution-admission.js';
import { parseJevDecision } from '@goodvibes-jev/judgment/decisions';
import {
  workLedgerCommandSchema, workLedgerStateSchema, WorkLedgerAccessError,
  type LedgerAttempt, type LedgerWork, type WorkEvidenceTarget,
  type WorkLedgerAction, type WorkLedgerActor, type WorkLedgerAuthority,
  type WorkLedgerClock, type WorkLedgerCommand, type WorkLedgerEvent,
  type WorkLedgerHostIdentity, type WorkLedgerRejection, type WorkLedgerResult,
  type WorkLedgerService, type WorkLedgerSnapshot, type WorkLedgerState,
  type WorkLedgerStorage, type WorkLedgerView,
} from './types.js';

export function createEmptyWorkLedgerState(projectId: string): WorkLedgerState {
  return workLedgerStateSchema.parse({
    version: 1, projectId, revision: 0, works: [], attempts: [], evidence: [], history: [], receipts: [],
  });
}

function actions(work: LedgerWork, attempt: LedgerAttempt | null, actor: WorkLedgerHostIdentity): WorkLedgerAction[] {
  const coordinator = actor.role === 'coordinator';
  if (work.reportedState === 'cancelled') return coordinator ? ['reopen'] : [];
  const result: WorkLedgerAction[] = [];
  if (coordinator) result.push('revise', 'cancel');
  if (actor.role !== 'verifier' && (attempt === null || attempt.state === 'released')) result.push('claim');
  if (attempt?.state === 'active' && (coordinator || attempt.ownerId === actor.actorId) && actor.role !== 'verifier') {
    result.push('report', 'release', 'handoff');
  }
  if (work.reportedState === 'complete' && coordinator) result.push('reopen');
  if (attempt?.state === 'complete' && work.reportedState === 'complete' && actor.role === 'verifier') result.push('record_evidence');
  return result;
}

function snapshot(state: WorkLedgerState, actor: WorkLedgerHostIdentity): WorkLedgerSnapshot {
  return {
    projectId: state.projectId, revision: state.revision, cursor: state.revision, ...(state.executionRevision ? { executionRevision: state.executionRevision } : {}),
    works: state.works.map(work => {
      const attempt = state.attempts.find(a => a.id === work.currentAttemptId) ?? null;
      const evidence = [...state.evidence].reverse().find(e => e.target.workId === work.id) ?? null;
      const verification: WorkLedgerView['verification'] = evidence === null
        ? { state: 'unverified', reason: 'No verification has been recorded.', evidence: null }
        : targetMatches(evidence.target, work, attempt) && work.reportedState === 'complete'
          ? { state: evidence.outcome, reason: evidence.reason, evidence }
          : { state: 'stale', reason: 'Recorded verification targets an earlier work or attempt revision.', evidence };
      const attention: { kind: 'blocked' | 'verification'; reason: string }[] = [];
      if (work.reportedState === 'blocked') attention.push({ kind: 'blocked', reason: attempt?.blocker ?? 'Work is blocked.' });
      if (work.reportedState === 'complete' && verification.state !== 'verified') attention.push({ kind: 'verification', reason: verification.reason });
      const execution = state.executions.find(entry => entry.target.attemptId === attempt?.id);
      return { work, attempt, verification, attention, ...(execution ? { execution: workExecutionViewSchema.parse({ id: execution.id, contractId: execution.contractId, target: execution.target, status: execution.status, reason: execution.reason, decisionIds: execution.decisionIds, evidenceId: execution.evidenceId }) } : {}), allowedActions: actions(work, attempt, actor) };
    }),
  };
}

function rejected(code: WorkLedgerRejection, reason: string, revision: number | null): WorkLedgerResult {
  return { kind: 'rejected', code, reason, revision };
}

/**
 * Additive ledger only: no runner, approval cache, tool execution or persistence
 * backend. Trusted composition retains authority, products receive service.
 */
export function createWorkLedger(options: {
  readonly projectId: string;
  readonly storage: WorkLedgerStorage;
  readonly clock: WorkLedgerClock;
}): { readonly service: WorkLedgerService; readonly authority: WorkLedgerAuthority } {
  const { projectId, storage, clock } = options;
  createEmptyWorkLedgerState(projectId);
  const identities = new WeakMap<WorkLedgerActor, WorkLedgerHostIdentity>();
  const pending = new Set<Promise<unknown>>();
  // Reserve ownership BEFORE invoking any adapter, parser getter or host hook.
  // Tracking an already-created Promise is too late: creating it can reenter close.
  function reserve<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
    pending.add(promise);
    void promise.then(() => pending.delete(promise), () => pending.delete(promise));
    return { promise, resolve, reject };
  }
  function admit<T>(run: () => T | Promise<T>): Promise<T> {
    const owned = reserve<T>();
    try { owned.resolve(run()); } catch (error) { owned.reject(error); }
    return owned.promise;
  }
  const subscriptions = new Set<() => void>();
  const actorSubscriptions = new WeakMap<WorkLedgerActor, Set<() => void>>();
  let closed = false;
  let closePromise: Promise<void> | undefined;
  function identity(actor: WorkLedgerActor): WorkLedgerHostIdentity | undefined {
    return identities.get(actor);
  }
  function requireIdentity(actor: WorkLedgerActor): WorkLedgerHostIdentity {
    const trusted = identity(actor);
    if (!trusted || trusted.projectId !== projectId) throw new WorkLedgerAccessError('forbidden', 'Invalid or revoked work ledger actor');
    return trusted;
  }
  const revocations = new Map<WorkLedgerActor, Set<() => void>>();
  function notifyRevoked(actor: WorkLedgerActor): void {
    const listeners = revocations.get(actor);
    revocations.delete(actor);
    for (const listener of listeners ?? []) { try { listener(); } catch { /* Finish revoking all listeners. */ } }
  }
  const authority: WorkLedgerAuthority = {
    authenticateActor(actor) {
      if (closed) throw new WorkLedgerAccessError('closed', 'Work ledger is closed');
      return Object.freeze({ ...requireIdentity(actor) });
    },
    onActorRevoked(actor, listener) {
      if (closed) throw new WorkLedgerAccessError('closed', 'Work ledger is closed');
      requireIdentity(actor);
      const listeners = revocations.get(actor) ?? new Set<() => void>();
      listeners.add(listener); revocations.set(actor, listeners);
      return () => { listeners.delete(listener); if (listeners.size === 0) revocations.delete(actor); };
    },
    publishExecution(id, actor, publishOptions) {
      if (closed) return Promise.resolve(rejected('closed', 'Work ledger is closed.', null));
      return admit<WorkLedgerResult>(() => {
        if (!identity(actor)) return rejected('forbidden', 'Invalid or revoked host actor.', null);
        const actorId = requireIdentity(actor).actorId;
        const { current, signal } = publishOptions;
        return storage.transaction(raw => {
          let state: WorkLedgerState;
          try { state = readState(raw, projectId); } catch { return { next: null, value: rejected('invalid_state', 'Authoritative ledger state is invalid.', null) }; }
          const initialRevision = state.revision;
          if (!identity(actor)) return { next: null, value: rejected('forbidden', 'Host actor was revoked.', initialRevision) };
          const entry = state.executions.find(item => item.id === id && item.actorId === actorId);
          if (!entry || !entry.contractId || !entry.publication) return { next: null, value: rejected('invalid_transition', 'Native publication is not prepared.', initialRevision) };
          const requestId = `native:${entry.contractId}:evidence`;
          if (entry.status === 'settled') {
            const receipt = state.receipts.find(item => item.actorId === actorId && item.requestId === requestId);
            if (!receipt) return { next: null, value: rejected('invalid_state', 'Missing native publication receipt.', initialRevision) };
            return { next: null, value: { kind: 'accepted', replayed: true, event: receipt.event } as WorkLedgerResult };
          }
          if (signal?.aborted) return { next: null, value: rejected('cancelled', 'Native publication cancelled.', initialRevision) };
          if (!executionIsCurrent(state, entry) || !['running', 'dispatching'].includes(entry.status)) return { next: null, value: rejected('stale_evidence', 'Native execution target is no longer current.', initialRevision) };
          if (state.revision !== entry.publication.expectedRevision) return { next: null, value: rejected('conflict', 'Native publication aggregate revision changed.', initialRevision) };
          let result: WorkLedgerResult;
          let next: WorkLedgerState;
          try {
            const decision = parseJevDecision(entry.admissions.at(-1));
            if (decision.outcome !== 'act') throw new Error('Native publication requires act');
            validateNativeExecutionDecision(entry, decision, current);
            const report = workLedgerCommandSchema.parse({ type: 'report', requestId: `native:${entry.contractId}:report`, expectedRevision: state.revision, workId: entry.target.workId, attemptId: entry.target.attemptId, state: 'complete', report: entry.publication.report });
            result = reduce(state, report, requireIdentity(actor));
            if (result.kind !== 'accepted') return { next: null, value: result };
            const attestation = entry.publication.attestation;
            if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)) throw new Error('Invalid attestation');
            const evidence = workLedgerCommandSchema.parse({ ...attestation, type: 'record_evidence', requestId, expectedRevision: state.revision, target: { ...entry.target, workRevision: entry.target.workRevision + 1, attemptRevision: entry.target.attemptRevision + 1 } });
            result = reduce(state, evidence, { ...requireIdentity(actor), role: 'verifier' });
            if (result.kind !== 'accepted' || !result.event.evidence) return { next: null, value: result };
            entry.status = 'settled'; entry.evidenceId = result.event.evidence.id;
            state.executionRevision++;
            next = readState(state, projectId);
            // The live context may synchronously cancel or revoke. It precedes
            // the final signal and actor checks, after every host hook.
            validateNativeExecutionDecision(entry, decision, current);
          } catch { return { next: null, value: rejected('host_error', 'Native publication validation failed before commit.', initialRevision) }; }
          const aborted = signal?.aborted;
          if (!identity(actor)) return { next: null, value: rejected('forbidden', 'Host actor was revoked before commit.', initialRevision) };
          if (aborted) return { next: null, value: rejected('cancelled', 'Native publication cancelled before commit.', initialRevision) };
          return { next, value: result };
        }).catch((): WorkLedgerResult => ({ kind: 'indeterminate', requestId: id, actorId, reason: 'Native publication storage outcome is unknown; reconcile by exact retry.' }));
      });
    },
    issueActor(input) {
      if (closed) throw new WorkLedgerAccessError('closed', 'Work ledger is closed');
      const trusted = identitySchema.parse(input);
      if (trusted.projectId !== projectId) throw new Error('Work ledger project mismatch');
      const handle = Object.freeze({}) as WorkLedgerActor;
      identities.set(handle, trusted);
      return handle;
    },
    revokeActor(actor) {
      identities.delete(actor);
      notifyRevoked(actor);
      for (const unsubscribe of actorSubscriptions.get(actor) ?? []) {
        try { unsubscribe(); } catch { /* Continue revoking every subscription. */ }
      }
      actorSubscriptions.delete(actor);
    },
  };

  function reduce(state: WorkLedgerState, command: WorkLedgerCommand, actor: WorkLedgerHostIdentity): WorkLedgerResult {
    const signature = JSON.stringify({ role: actor.role, command });
    const receipt = state.receipts.find(r => r.actorId === actor.actorId && r.requestId === command.requestId);
    if (receipt) return receipt.signature === signature
      ? { kind: 'accepted', replayed: true, event: receipt.event }
      : rejected('request_conflict', 'requestId was already used for a different command or role.', state.revision);
    if (command.expectedRevision !== state.revision) return rejected('conflict', 'Aggregate ledger revision changed.', state.revision);
    if (state.revision === Number.MAX_SAFE_INTEGER) throw new Error('Work ledger revision exhausted');
    const at = clock.now();
    if (!Number.isSafeInteger(at) || at < 0 || at < (state.history.at(-1)?.at ?? 0)) throw new Error('Invalid host ledger clock');
    const changed: LedgerAttempt[] = [];
    const createdAttempts = new Set<string>();
    let evidence: WorkLedgerEvent['evidence'] = null;
    const reason: string | null = 'reason' in command ? command.reason : null;
    let work: LedgerWork;
    const nextId = (kind: 'work' | 'attempt' | 'evidence') => {
      const id = clock.newId(kind);
      if (state.works.some(w => w.id === id) || state.attempts.some(a => a.id === id) || state.evidence.some(e => e.id === id)) {
        throw new Error('Host generated a duplicate ledger ID');
      }
      return id;
    };
    const newAttempt = (ownerId: string, predecessorId: string | null): LedgerAttempt => {
      const attempt: LedgerAttempt = { id: nextId('attempt'), workId: work.id, predecessorId, ownerId,
        revision: 1, state: 'active', report: null, blocker: null, createdAt: at, updatedAt: at };
      state.attempts.push(attempt);
      createdAttempts.add(attempt.id);
      changed.push(attempt);
      work.currentAttemptId = attempt.id;
      work.reportedState = 'in_progress';
      return attempt;
    };
    if (command.type === 'create') {
      if (actor.role !== 'coordinator') return rejected('forbidden', 'Only the coordinator can create work.', state.revision);
      work = { id: nextId('work'), title: command.title, goal: command.goal, criteria: command.criteria,
        revision: 1, criteriaRevision: 1, reportedState: 'pending', currentAttemptId: null, createdAt: at, updatedAt: at };
      state.works.push(work);
    } else {
      const workId = command.type === 'record_evidence' ? command.target.workId : command.workId;
      const found = state.works.find(w => w.id === workId);
      if (!found) return rejected('not_found', 'Unknown work ID.', state.revision);
      work = found;
      const attempt = state.attempts.find(a => a.id === work.currentAttemptId) ?? null;
      // Authorize before detailed transition/currentness diagnostics.
      const ownerOrCoordinator = actor.role === 'coordinator' || (actor.role === 'worker' && attempt?.ownerId === actor.actorId);
      if ((['revise', 'cancel', 'reopen'].includes(command.type) && actor.role !== 'coordinator')
        || (['report', 'release', 'handoff'].includes(command.type) && !ownerOrCoordinator)
        || (command.type === 'record_evidence' && actor.role !== 'verifier')
        || (command.type === 'claim' && actor.role === 'verifier')) {
        return rejected('forbidden', 'Actor cannot perform this ledger action.', state.revision);
      }
      if (command.type === 'record_evidence' && !targetMatches(command.target, work, attempt)) {
        return rejected('stale_evidence', 'Evidence target is no longer current.', state.revision);
      }
      if (!actions(work, attempt, actor).includes(command.type)) return rejected('invalid_transition', 'Action is not available in the current state.', state.revision);
      if ('attemptId' in command && command.attemptId !== attempt?.id) return rejected('invalid_transition', 'Attempt is no longer current.', state.revision);
      switch (command.type) {
        case 'revise':
          work.title = command.title;
          work.goal = command.goal;
          work.criteria = command.criteria;
          work.criteriaRevision += 1;
          // Even same-text edits deliberately invalidate an earlier verdict.
          break;
        case 'claim': newAttempt(actor.actorId, attempt?.id ?? null); break;
        case 'report':
          if (!attempt) throw new Error('Missing current attempt');
          if (command.state === 'blocked' && !command.blocker) return rejected('invalid_command', 'Blocked reports require a blocker.', state.revision);
          attempt.state = command.state === 'complete' ? 'complete' : 'active';
          attempt.report = command.report;
          attempt.blocker = command.state === 'blocked' ? command.blocker ?? null : null;
          work.reportedState = command.state;
          changed.push(attempt);
          break;
        case 'release':
        case 'handoff':
          if (!attempt) throw new Error('Missing current attempt');
          if (command.type === 'handoff' && command.targetActorId === attempt.ownerId) return rejected('invalid_command', 'Handoff requires a different owner.', state.revision);
          attempt.state = 'released';
          attempt.blocker = null;
          changed.push(attempt);
          work.reportedState = 'pending';
          if (command.type === 'handoff') newAttempt(command.targetActorId, attempt.id);
          break;
        case 'cancel':
          work.reportedState = 'cancelled';
          if (attempt) { attempt.state = 'cancelled'; attempt.blocker = null; changed.push(attempt); }
          break;
        case 'reopen':
          work.reportedState = 'pending';
          // Preserve the old terminal attempt and chain when a new owner claims.
          if (attempt) { attempt.state = 'released'; changed.push(attempt); }
          break;
        case 'record_evidence':
          if (new Set(command.references.map(reference => reference.ref)).size !== command.references.length
            || new Set(command.criteriaResults.map(result => result.criterionIndex)).size !== command.criteriaResults.length
            || command.criteriaResults.some(result => result.criterionIndex >= work.criteria.length
              || result.references.some(ref => !command.references.some(reference => reference.ref === ref)))) {
            return rejected('invalid_command', 'Criterion results must be unique, in range and reference supplied evidence.', state.revision);
          }
          if (command.outcome === 'verified' && (command.source !== 'host_check'
            || command.criteriaResults.length !== work.criteria.length
            || command.criteriaResults.some(result => result.status !== 'satisfied' || result.references.length === 0
              || result.references.some(ref => !command.references.some(reference => reference.ref === ref && reference.digest)))
            || command.references.length === 0)) {
            return rejected('invalid_command', 'Verified requires a trusted host check and content-identified evidence for every criterion.', state.revision);
          }
          evidence = { id: nextId('evidence'), target: command.target, outcome: command.outcome,
            reason: command.reason, references: command.references, source: command.source, criteriaResults: command.criteriaResults, actorId: actor.actorId, at };
          state.evidence.push(evidence);
          break;
      }
      if (command.type !== 'record_evidence') {
        work.revision += 1;
        work.updatedAt = at;
      }
    }
    for (const attempt of changed) {
      if (!createdAttempts.has(attempt.id)) attempt.revision += 1;
      attempt.updatedAt = at;
    }
    const event: WorkLedgerEvent = {
      sequence: state.revision + 1, type: command.type, actorId: actor.actorId,
      requestId: command.requestId, workId: work.id, attemptId: work.currentAttemptId,
      at, work: structuredClone(work), attempts: structuredClone(changed), evidence, reason,
    };
    state.revision += 1;
    state.history.push(event);
    state.receipts.push({ actorId: actor.actorId, requestId: command.requestId, signature, event });
    return { kind: 'accepted', replayed: false, event };
  }

  async function readAuthoritativeState(): Promise<WorkLedgerState> {
    let raw: unknown;
    try { raw = await storage.read(); } catch { throw new WorkLedgerAccessError('storage_error', 'Cannot read authoritative ledger storage.'); }
    try { return readState(raw, projectId); } catch { throw new WorkLedgerAccessError('invalid_state', 'Authoritative ledger state is invalid; it was not reset.'); }
  }

  const service: WorkLedgerService = {
    readSnapshot(actor) {
      return admit(async () => {
      if (closed) throw new WorkLedgerAccessError('closed', 'Work ledger is closed');
      requireIdentity(actor);
      const state = await readAuthoritativeState();
      if (closed) throw new WorkLedgerAccessError('closed', 'Work ledger is closed');
      return snapshot(state, requireIdentity(actor));
      });
    },
    history(afterSequence, actor) {
      return admit(async () => {
      if (closed) throw new WorkLedgerAccessError('closed', 'Work ledger is closed');
      requireIdentity(actor);
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new WorkLedgerAccessError('invalid_cursor', 'Invalid history cursor');
      const state = await readAuthoritativeState();
      if (closed) throw new WorkLedgerAccessError('closed', 'Work ledger is closed');
      requireIdentity(actor);
      return state.history.filter(event => event.sequence > afterSequence);
      });
    },
    subscribe(actor, listener) {
      if (closed) throw new WorkLedgerAccessError('closed', 'Work ledger is closed');
      requireIdentity(actor);
      const admission = reserve<void>();
      let active = true;
      let cursor = -1;
      let executionCursor = -1;
      let cleanup: (() => void) | undefined;
      let cleaned = false;
      const cleanupOnce = () => {
        if (cleaned || !cleanup) return;
        cleaned = true;
        cleanup();
      };
      const unsubscribe = () => {
        active = false;
        subscriptions.delete(unsubscribe);
        actorSubscriptions.get(actor)?.delete(unsubscribe);
        cleanupOnce();
      };
      // Publish cleanup ownership before entering an adapter that may close or
      // revoke synchronously. Late-returned cleanup is still invoked exactly once.
      subscriptions.add(unsubscribe);
      const owned = actorSubscriptions.get(actor) ?? new Set<() => void>();
      owned.add(unsubscribe);
      actorSubscriptions.set(actor, owned);
      try {
        cleanup = storage.subscribe(raw => {
          let notification: unknown;
          try { notification = structuredClone(raw); } catch { return; }
          // Never run product code on the storage commit stack.
          queueMicrotask(() => {
            if (!active || closed || !identity(actor)) return;
            try {
              const state = readState(notification, projectId);
              if (state.revision <= cursor && state.executionRevision <= executionCursor) return;
              executionCursor = state.executionRevision;
              cursor = state.revision;
              const returned: unknown = listener(snapshot(state, requireIdentity(actor)));
              void Promise.resolve(returned).catch(() => {});
            } catch { /* Bad observers cannot fail writes or the service lifecycle. */ }
          });
        });
        if (!active || closed || !identity(actor)) {
          try { unsubscribe(); } catch { /* Preserve the admission error. */ }
          if (closed) throw new WorkLedgerAccessError('closed', 'Work ledger is closed');
          throw new WorkLedgerAccessError('forbidden', 'Actor was revoked during subscription admission');
        }
        return unsubscribe;
      } catch (error) {
        try { unsubscribe(); } catch { /* Preserve the original adapter error. */ }
        throw error;
      } finally {
        admission.resolve();
      }
    },
    execute(input, actor, executeOptions) {
      if (closed) return Promise.resolve(rejected('closed', 'Work ledger is closed.', null));
      return admit<WorkLedgerResult>(() => {
      if (!identity(actor)) return Promise.resolve(rejected('forbidden', 'Invalid or revoked host actor.', null));
      const parsed = workLedgerCommandSchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(rejected('invalid_command', parsed.error.message, null));
      const command = parsed.data;
      const signal = executeOptions?.signal;
      const actorId = requireIdentity(actor).actorId;
      const operation = Promise.resolve().then(() => storage.transaction(current => {
        let state: WorkLedgerState;
        try { state = readState(current, projectId); } catch {
          return { next: null, value: rejected('invalid_state', 'Authoritative ledger state is invalid; it was not reset.', null) };
        }
        if (!identity(actor)) return { next: null, value: rejected('forbidden', 'Host actor was revoked before commit.', state.revision) };
        // A known durable receipt wins over a later abort: never describe an
        // already committed command as cancelled when reconciling its outcome.
        if (state.receipts.some(receipt => receipt.actorId === requireIdentity(actor).actorId && receipt.requestId === command.requestId)) {
          return { next: null, value: reduce(state, command, requireIdentity(actor)) };
        }
        if (signal?.aborted) return { next: null, value: rejected('cancelled', 'Command was cancelled before commit.', state.revision) };
        const initialRevision = state.revision;
        let result: WorkLedgerResult;
        let next: WorkLedgerState | null;
        try {
          result = reduce(state, command, requireIdentity(actor));
          next = result.kind === 'accepted' && !result.replayed ? readState(state, projectId) : null;
        } catch {
          return { next: null, value: rejected('host_error', 'Host clock, identity generation or transition validation failed before commit.', initialRevision) };
        }
        // Trusted clocks/ID factories can reenter authority/abort synchronously.
        // This final guard must follow every callback and precede publication.
        // Read the extensible signal accessor before the final identity check:
        // a host-provided getter can itself synchronously revoke the actor.
        const aborted = signal?.aborted;
        if (!identity(actor)) return { next: null, value: rejected('forbidden', 'Host actor was revoked before commit.', initialRevision) };
        if (aborted) return { next: null, value: rejected('cancelled', 'Command was cancelled before commit.', initialRevision) };
        return { next, value: result };
      })).catch((): WorkLedgerResult => ({ kind: 'indeterminate', requestId: command.requestId, actorId,
        reason: 'Storage outcome is unknown. Reconcile by exact retry against the authoritative store.' }));
      return operation;
      });
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      let finish!: () => void;
      // Reentrant cleanup must observe this exact promise, not start a new drain.
      closePromise = new Promise<void>(resolve => { finish = resolve; });
      for (const actor of [...revocations.keys()]) notifyRevoked(actor);
      for (const unsubscribe of [...subscriptions]) {
        try { unsubscribe(); } catch { /* Cleanup failures must not strand drains. */ }
      }
      void Promise.allSettled([...pending]).then(finish);
      return closePromise;
    },
  };
  return { service, authority };
}

import { projectLegacyImportWorks, validateLegacyWorkLedgerManifest } from './legacy-import.js';
import { enum as enumSchema, strictObject, string } from 'zod/v4';
import {
  workLedgerCommandSchema, workLedgerStateSchema, WorkLedgerAccessError,
  type LedgerAttempt, type LedgerWork, type WorkEvidenceTarget,
  type WorkLedgerAction, type WorkLedgerActor, type WorkLedgerAuthority,
  type WorkLedgerClock, type WorkLedgerCommand, type WorkLedgerEvent,
  type WorkLedgerHostIdentity, type WorkLedgerRejection, type WorkLedgerResult,
  type WorkLedgerService, type WorkLedgerSnapshot, type WorkLedgerState,
  type WorkLedgerStorage, type WorkLedgerView, type WorkLedgerTransactionContext, type LedgerEvidence,
} from './types.js';

const identitySchema = strictObject({
  actorId: string().min(1).max(200),
  projectId: string().min(1).max(200),
  role: enumSchema(['coordinator', 'worker', 'verifier']),
});

export function createEmptyWorkLedgerState(projectId: string): WorkLedgerState {
  return workLedgerStateSchema.parse({
    version: 1, projectId, revision: 0, works: [], attempts: [], evidence: [], history: [], receipts: [],
  });
}

/** Fail closed on malformed or inconsistent host data; never reset it to empty. */
function readState(input: unknown, projectId: string): WorkLedgerState {
  const state = workLedgerStateSchema.parse(input);
  if (state.projectId !== projectId) throw new Error('Work ledger project mismatch');
  const unique = (ids: string[]) => new Set(ids).size === ids.length;
  if (!unique(state.works.map(w => w.id)) || !unique(state.attempts.map(a => a.id))
    || !unique(state.evidence.map(e => e.id))
    || !unique(state.receipts.map(r => JSON.stringify([r.actorId, r.requestId])))
    || state.history.length !== state.revision || state.receipts.length !== state.revision
    || state.history.some((event, index) => event.sequence !== index + 1)) {
    throw new Error('Inconsistent work ledger identities or history');
  }
  for (const work of state.works) {
    const attempt = state.attempts.find(a => a.id === work.currentAttemptId);
    if (work.revision > state.revision || work.criteriaRevision > work.revision
      || (work.currentAttemptId !== null && (!attempt || attempt.workId !== work.id))
      || (work.reportedState === 'cancelled' && attempt?.state !== 'cancelled' && attempt !== undefined)
      || state.attempts.some(a => a.workId === work.id && a.state === 'active' && a.id !== work.currentAttemptId)) {
      throw new Error('Inconsistent work ledger current attempt');
    }
  }
  for (const attempt of state.attempts) {
    const predecessor = state.attempts.find(a => a.id === attempt.predecessorId);
    if (!state.works.some(w => w.id === attempt.workId)
      || (attempt.predecessorId !== null && (!predecessor || predecessor.workId !== attempt.workId || predecessor.id === attempt.id))) {
      throw new Error('Inconsistent work ledger ownership chain');
    }
  }
  // Replay the immutable record images to detect rollback, orphan records and
  // receipts detached from the history they claim to acknowledge.
  const works = new Map<string, LedgerWork>();
  const attempts = new Map<string, LedgerAttempt>();
  const evidence = new Map<string, LedgerEvidence>();
  const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  const importedEntities = new Set<string>();
  for (const [index, event] of state.history.entries()) {
    if (event.at < (state.history[index - 1]?.at ?? 0)) throw new Error('Invalid history clock');
    const receipt = state.receipts[index];
    if (event.type === 'import_legacy') {
      if (!receipt || receipt.actorId !== event.actorId || receipt.requestId !== event.requestId || !equal(receipt.event, event)) throw new Error('Invalid import receipt');
      const signature = strictObject({ role: identitySchema.shape.role, command: workLedgerCommandSchema }).parse(JSON.parse(receipt.signature));
      const command = signature.command;
      if (signature.role !== 'coordinator' || command.type !== 'import_legacy' || JSON.stringify(signature) !== receipt.signature
        || command.requestId !== event.requestId || command.expectedRevision !== index
        || command.manifest.expectedLedgerRevision !== index || command.manifest.projectId !== projectId
        || !equal(command.manifest, event.manifest) || !equal(projectLegacyImportWorks(event.manifest, event.at), event.works)
        || event.works.some(work => works.has(work.id) || attempts.has(work.id) || evidence.has(work.id))) throw new Error('Invalid import history');
      for (const entity of event.manifest.entities) {
        const key = JSON.stringify([entity.kind, entity.id]);
        if (importedEntities.has(key)) throw new Error('Duplicate imported identity');
        importedEntities.add(key);
      }
      for (const work of event.works) works.set(work.id, work);
      continue;
    }
    const prior = works.get(event.workId);
    if (!receipt || receipt.actorId !== event.actorId || receipt.requestId !== event.requestId
      || !equal(receipt.event, event) || event.work.id !== event.workId
      || event.attemptId !== event.work.currentAttemptId
      || (event.type === 'create') !== !prior
      || event.work.revision !== (prior?.revision ?? 0) + (event.type === 'record_evidence' ? 0 : 1)
      || event.work.criteriaRevision !== (prior?.criteriaRevision ?? 0) + (event.type === 'create' || event.type === 'revise' ? 1 : 0)
      || (prior && (event.work.createdAt !== prior.createdAt || event.at < prior.updatedAt))
      || (event.type === 'record_evidence' && !equal(event.work, prior))) {
      throw new Error('Inconsistent work ledger event or receipt');
    }
    const signature = strictObject({ role: identitySchema.shape.role, command: workLedgerCommandSchema }).parse(JSON.parse(receipt.signature));
    const command = signature.command;
    if (JSON.stringify(signature) !== receipt.signature || command.requestId !== event.requestId
      || command.type === 'import_legacy' || command.type !== event.type || command.expectedRevision !== index
      || (command.type !== 'create' && (command.type === 'record_evidence' ? command.target.workId : command.workId) !== event.workId)) {
      throw new Error('Inconsistent work ledger receipt command');
    }
    for (const attempt of event.attempts) {
      const previous = attempts.get(attempt.id);
      const predecessor = attempt.predecessorId === null ? null : attempts.get(attempt.predecessorId);
      if (attempt.workId !== event.workId || attempt.revision !== (previous?.revision ?? 0) + 1
        || (previous && (attempt.ownerId !== previous.ownerId || attempt.predecessorId !== previous.predecessorId || attempt.createdAt !== previous.createdAt))
        || (attempt.predecessorId !== null && (!predecessor || predecessor.workId !== attempt.workId))
        || (attempt.createdAt > attempt.updatedAt) || attempt.updatedAt !== event.at) {
        throw new Error('Inconsistent work ledger attempt history');
      }
      attempts.set(attempt.id, attempt);
    }
    works.set(event.workId, event.work);
    if ((event.type === 'record_evidence') !== (event.evidence !== null)) throw new Error('Inconsistent evidence event');
    if (event.evidence) {
      const item = event.evidence;
      if (evidence.has(item.id) || item.actorId !== event.actorId || item.at !== event.at
        || !targetMatches(item.target, event.work, attempts.get(event.attemptId ?? '') ?? null)
        || event.work.reportedState !== 'complete' || signature.role !== 'verifier'
        || (item.outcome === 'verified' && (item.source !== 'host_check'
          || item.criteriaResults.length !== event.work.criteria.length
          || new Set(item.criteriaResults.map(result => result.criterionIndex)).size !== event.work.criteria.length
          || item.criteriaResults.some(result => result.criterionIndex >= event.work.criteria.length || result.status !== 'satisfied'
            || result.references.length === 0 || result.references.some(ref => !item.references.some(reference => reference.ref === ref && reference.digest)))))) {
        throw new Error('Inconsistent work ledger evidence history');
      }
      evidence.set(item.id, item);
    }
  }
  if (!equal([...works.values()], state.works) || !equal([...attempts.values()], state.attempts)
    || !equal([...evidence.values()], state.evidence)) throw new Error('Work ledger state differs from committed history');
  return state;
}

function targetMatches(target: WorkEvidenceTarget, work: LedgerWork, attempt: LedgerAttempt | null): boolean {
  return target.workId === work.id && target.workRevision === work.revision
    && target.criteriaRevision === work.criteriaRevision && target.attemptId === attempt?.id
    && target.attemptRevision === attempt.revision;
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
    projectId: state.projectId, revision: state.revision, cursor: state.revision,
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
      return { work, attempt, verification, attention, allowedActions: actions(work, attempt, actor) };
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
  /** Host-issued binding for new imports. Exact durable retries survive host restarts. */
  readonly importHostId?: string;
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
  const authority: WorkLedgerAuthority = {
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
      for (const unsubscribe of actorSubscriptions.get(actor) ?? []) {
        try { unsubscribe(); } catch { /* Continue revoking every subscription. */ }
      }
      actorSubscriptions.delete(actor);
    },
  };

  function reduce(state: WorkLedgerState, command: WorkLedgerCommand, actor: WorkLedgerHostIdentity, context?: WorkLedgerTransactionContext): WorkLedgerResult {
    const signature = JSON.stringify({ role: actor.role, command });
    const receipt = state.receipts.find(r => r.actorId === actor.actorId && r.requestId === command.requestId);
    if (receipt) return receipt.signature === signature
      ? { kind: 'accepted', replayed: true, event: receipt.event }
      : rejected('request_conflict', 'requestId was already used for a different command or role.', state.revision);
    if (command.expectedRevision !== state.revision) return rejected('conflict', 'Aggregate ledger revision changed.', state.revision);
    if (state.revision === Number.MAX_SAFE_INTEGER) throw new Error('Work ledger revision exhausted');
    const at = clock.now();
    if (!Number.isSafeInteger(at) || at < 0 || at < (state.history.at(-1)?.at ?? 0)) throw new Error('Invalid host ledger clock');
    if (command.type === 'import_legacy') {
      if (actor.role !== 'coordinator') return rejected('forbidden', 'Only the coordinator can import historical work.', state.revision);
      const manifest = command.manifest;
      if (!options.importHostId || manifest.hostId !== options.importHostId || manifest.projectId !== projectId
        || manifest.expectedLedgerRevision !== command.expectedRevision) return rejected('conflict', 'Selected host, project or reviewed ledger revision changed.', state.revision);
      if (!context) return rejected('host_error', 'Authoritative transactional source snapshots are unavailable.', state.revision);
      const captures = manifest.sources.map(entry => {
        const current = context.readSource(String(entry.source.id));
        return { source: current.source, generation: current.generation };
      });
      try {
        validateLegacyWorkLedgerManifest({ ...manifest, sources: captures.map((entry, index) => ({ ...entry, digest: manifest.sources[index]!.digest })) });
      } catch { return rejected('stale_source', 'Complete persisted source images changed since preparation.', state.revision); }
      const imported = projectLegacyImportWorks(manifest, at);
      const oldEntities = new Set(state.history.flatMap(event => event.type === 'import_legacy'
        ? event.manifest.entities.map(entity => JSON.stringify([entity.kind, entity.id])) : []));
      if (manifest.entities.some(entity => oldEntities.has(JSON.stringify([entity.kind, entity.id])))
        || imported.some(work => state.works.some(value => value.id === work.id) || state.attempts.some(value => value.id === work.id) || state.evidence.some(value => value.id === work.id))) {
        return rejected('conflict', 'An imported identity already exists; reconcile the original request receipt.', state.revision);
      }
      const event: WorkLedgerEvent = { type: 'import_legacy', sequence: state.revision + 1, actorId: actor.actorId,
        requestId: command.requestId, at, manifest, works: imported };
      // One full event must always fit the existing history transport without truncation.
      if (new TextEncoder().encode(JSON.stringify(event)).byteLength > 524_288) return rejected('invalid_command', 'Import history event exceeds the bounded transport limit.', state.revision);
      state.works.push(...imported);
      if (new TextEncoder().encode(JSON.stringify(snapshot(state, actor))).byteLength > 1_000_000) return rejected('invalid_command', 'Imported snapshot exceeds the bounded read transport limit.', state.revision);
      state.revision += 1;
      state.history.push(event);
      state.receipts.push({ actorId: actor.actorId, requestId: command.requestId, signature, event });
      return { kind: 'accepted', replayed: false, event };
    }
    const changed: LedgerAttempt[] = [];
    const createdAttempts = new Set<string>();
    let evidence: LedgerEvidence | null = null;
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
              if (state.revision <= cursor) return;
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
      if (command.type === 'import_legacy') command.manifest = validateLegacyWorkLedgerManifest(command.manifest);
      const signal = executeOptions?.signal;
      const actorId = requireIdentity(actor).actorId;
      const operation = Promise.resolve().then(() => storage.transaction((current, context) => {
        let state: WorkLedgerState;
        try { state = readState(current, projectId); } catch {
          return { next: null, value: rejected('invalid_state', 'Authoritative ledger state is invalid; it was not reset.', null) };
        }
        if ((executeOptions?.isAuthorized && executeOptions.isAuthorized() !== true) || !identity(actor)) return { next: null, value: rejected('forbidden', 'Host actor was revoked before commit.', state.revision) };
        // A known durable receipt wins over a later abort: never describe an
        // already committed command as cancelled when reconciling its outcome.
        if (state.receipts.some(receipt => receipt.actorId === requireIdentity(actor).actorId && receipt.requestId === command.requestId)) {
          return { next: null, value: reduce(state, command, requireIdentity(actor), context) };
        }
        if (signal?.aborted) return { next: null, value: rejected('cancelled', 'Command was cancelled before commit.', state.revision) };
        const initialRevision = state.revision;
        let result: WorkLedgerResult;
        let next: WorkLedgerState | null;
        try {
          result = reduce(state, command, requireIdentity(actor), context);
          next = result.kind === 'accepted' && !result.replayed ? readState(state, projectId) : null;
        } catch {
          return { next: null, value: rejected('host_error', 'Host clock, identity generation or transition validation failed before commit.', initialRevision) };
        }
        // Trusted clocks/ID factories can reenter authority/abort synchronously.
        // This final guard must follow every callback and precede publication.
        // Read the extensible signal accessor before the final identity check:
        // a host-provided getter can itself synchronously revoke the actor.
        const aborted = signal?.aborted;
        const authorized = !executeOptions?.isAuthorized || executeOptions.isAuthorized() === true;
        if (!authorized || !identity(actor)) return { next: null, value: rejected('forbidden', 'Host actor was revoked before commit.', initialRevision) };
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
      for (const unsubscribe of [...subscriptions]) {
        try { unsubscribe(); } catch { /* Cleanup failures must not strand drains. */ }
      }
      void Promise.allSettled([...pending]).then(finish);
      return closePromise;
    },
  };
  return { service, authority };
}

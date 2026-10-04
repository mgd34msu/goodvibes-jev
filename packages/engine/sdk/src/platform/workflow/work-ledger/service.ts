import { isDeepStrictEqual } from 'node:util';
import { LEGACY_IMPORT_MAX_BYTES, projectLegacyImportWorks, validateLegacyWorkLedgerManifest } from './legacy-import.js';
import { array, discriminatedUnion, enum as enumSchema, literal, strictObject, string, union } from 'zod/v4';
import {
  workLedgerCommandSchema, workLedgerStateSchema, ledgerWorkSchema, ledgerEventSchema, WorkLedgerAccessError,
  type LedgerAttempt, type LedgerWork, type WorkEvidenceTarget,
  type WorkLedgerAction, type WorkLedgerActor, type WorkLedgerAuthority,
  type WorkLedgerClock, type WorkLedgerCommand, type WorkLedgerEvent,
  type WorkLedgerHostIdentity, type WorkLedgerRejection, type WorkLedgerResult,
  type WorkLedgerService, type WorkLedgerSnapshot, type WorkLedgerState,
  type WorkLedgerStorage, type WorkLedgerView, type WorkLedgerSubmission, type WorkLedgerTransactionContext, type LedgerEvidence,
} from './types.js';

const identitySchema = strictObject({
  actorId: string().min(1).max(200),
  projectId: string().min(1).max(200),
  role: enumSchema(['coordinator', 'worker', 'verifier']),
});

/** Exact old format, used only by the DB5 migration before any provenance is added. */
const text = string().trim().min(1).max(20_000);
const commandSchemas = workLedgerCommandSchema.options;
const legacyWorkSchema = ledgerWorkSchema.omit({ source: true }).extend({ goal: text, criteria: array(text).min(1).max(100) });
const legacyEventSchema = union([
  ledgerEventSchema.options[0].extend({ type: enumSchema(['create', 'revise', 'claim', 'report', 'release', 'handoff', 'cancel', 'reopen', 'record_evidence']), work: legacyWorkSchema }),
  ledgerEventSchema.options[1].extend({ works: array(legacyWorkSchema).max(5000) }),
]);
const legacyWorkLedgerCommandSchema = discriminatedUnion('type', [
  commandSchemas[0],
  commandSchemas[1].extend({ goal: text, criteria: array(text).min(1).max(100) }),
  commandSchemas[2].extend({ goal: text, criteria: array(text).min(1).max(100) }),
  commandSchemas[3], commandSchemas[4], commandSchemas[5], commandSchemas[6], commandSchemas[7], commandSchemas[8], commandSchemas[9],
]).superRefine((command, context) => {
  if (command.type === 'import_legacy' && new TextEncoder().encode(JSON.stringify(command)).byteLength > LEGACY_IMPORT_MAX_BYTES) {
    context.addIssue({ code: 'custom', message: 'Complete import command exceeds 256 KiB' });
  }
});
const legacyWorkLedgerStateSchema = workLedgerStateSchema.extend({
  version: literal(1), works: array(legacyWorkSchema), history: array(legacyEventSchema),
  receipts: array(workLedgerStateSchema.shape.receipts.element.extend({ event: legacyEventSchema })),
});


const nativeAbortState = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get;

/** Observe a standard host signal without invoking its shadowed public getter. */
function readNativeAbortState(signal: AbortSignal | undefined): boolean {
  if (!signal || !nativeAbortState) return false;
  try { return nativeAbortState.call(signal) === true; } catch {
    // Structural host/test signals have no native slot. Their ordinary
    // accessor is still observed before the final authorization callback.
    return false;
  }
}

export function createEmptyWorkLedgerState(projectId: string): WorkLedgerState {
  return workLedgerStateSchema.parse({
    version: 2, projectId, revision: 0, works: [], attempts: [], evidence: [], history: [], receipts: [],
  });
}

/** Validate complete command replay, not just mutually consistent record images. */
function validateWorkLedgerHistory(state: WorkLedgerState | ReturnType<typeof legacyWorkLedgerStateSchema.parse>, projectId: string): void {
  if (state.projectId !== projectId) throw new Error('Work ledger project mismatch');
  if (state.history.length !== state.revision || state.receipts.length !== state.revision) throw new Error('Inconsistent work ledger history');
  const legacy = state.version === 1;
  const replay = createEmptyWorkLedgerState(projectId);
  const comparableWork = (work: LedgerWork) => {
    if (!legacy) return work;
    const { source: _source, ...old } = work;
    return old;
  };
  const comparableEvent = (event: WorkLedgerEvent) => event.type === 'import_legacy'
    ? { ...event, works: event.works.map(comparableWork) } : { ...event, work: comparableWork(event.work) };
  for (const [index, event] of state.history.entries()) {
    const receipt = state.receipts[index];
    if (!receipt || receipt.actorId !== event.actorId || receipt.requestId !== event.requestId
      || event.sequence !== index + 1 || !isDeepStrictEqual(receipt.event, event)) throw new Error('Invalid work ledger receipt');
    const signature = strictObject({ role: identitySchema.shape.role,
      command: legacy ? legacyWorkLedgerCommandSchema : workLedgerCommandSchema }).parse(JSON.parse(receipt.signature));
    const command = signature.command;
    if (JSON.stringify(signature) !== receipt.signature || command.requestId !== event.requestId
      || command.expectedRevision !== index || command.type !== event.type) throw new Error('Invalid work ledger receipt command');
    const generated: { kind: 'work' | 'attempt' | 'evidence'; id: string }[] = [];
    if (event.type !== 'import_legacy') {
      if (event.type === 'create' || event.type === 'submit_native') generated.push({ kind: 'work', id: event.workId });
      for (const attempt of event.attempts) if (!replay.attempts.some(prior => prior.id === attempt.id)) generated.push({ kind: 'attempt', id: attempt.id });
      if (event.evidence) generated.push({ kind: 'evidence', id: event.evidence.id });
    }
    const clock: WorkLedgerClock = { now: () => event.at, newId: kind => {
      const next = generated.shift();
      if (!next || next.kind !== kind) throw new Error('Invalid work ledger identity generation');
      return next.id;
    } };
    const context: WorkLedgerTransactionContext | undefined = command.type === 'import_legacy' ? {
      readSource(id) {
        const source = command.manifest.sources.find(entry => String(entry.source.id) === id);
        if (!source) throw new Error('Missing imported source');
        return source;
      },
    } : undefined;
    const result = reduceWorkLedger(replay, command, { projectId, actorId: event.actorId, role: signature.role }, clock,
      command.type === 'import_legacy' ? command.manifest.hostId : undefined, context, true);
    if (result.kind !== 'accepted' || result.replayed || generated.length !== 0
      || !isDeepStrictEqual(comparableEvent(result.event), event)) throw new Error('Work ledger history differs from command replay');
  }
  if (!isDeepStrictEqual(replay.works.map(comparableWork), state.works) || !isDeepStrictEqual(replay.attempts, state.attempts)
    || !isDeepStrictEqual(replay.evidence, state.evidence)) throw new Error('Work ledger state differs from committed history');
}

/** Fail closed on malformed or inconsistent host data; never reset it to empty. */
export function readWorkLedgerState(input: unknown, projectId: string): WorkLedgerState {
  const state = workLedgerStateSchema.parse(input);
  if (!isDeepStrictEqual(state, input)) throw new Error('Work ledger persisted text is not canonical');
  validateWorkLedgerHistory(state, projectId);
  return state;
}

/** DB5 only: validate the complete v1 authority first, then add explicit absence. */
export function migrateLegacyWorkLedgerState(input: unknown, projectId: string): WorkLedgerState {
  const legacy = legacyWorkLedgerStateSchema.parse(input);
  if (!isDeepStrictEqual(legacy, input)) throw new Error('Legacy work ledger persisted text is not canonical');
  validateWorkLedgerHistory(legacy, projectId);
  const addSource = (work: typeof legacy.works[number]) => ({ ...work, source: null });
  const upgradeEvent = (event: typeof legacy.history[number]) => event.type === 'import_legacy'
    ? { ...event, works: event.works.map(addSource) } : { ...event, work: addSource(event.work) };
  return readWorkLedgerState({ ...legacy, version: 2, works: legacy.works.map(addSource),
    history: legacy.history.map(upgradeEvent), receipts: legacy.receipts.map(receipt => ({ ...receipt, event: upgradeEvent(receipt.event) })) }, projectId);
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
  if (coordinator) {
    if (work.source === null) result.push('revise');
    result.push('cancel');
  }
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

function reduceWorkLedger(state: WorkLedgerState, command: WorkLedgerCommand, actor: WorkLedgerHostIdentity, clock: WorkLedgerClock, importHostId?: string, context?: WorkLedgerTransactionContext, replaying = false): WorkLedgerResult {
  const projectId = state.projectId;
  const signature = JSON.stringify({ role: actor.role, command });
  const receipt = state.receipts.find(r => r.actorId === actor.actorId && r.requestId === command.requestId);
  if (receipt) return receipt.signature === signature
    ? { kind: 'accepted', replayed: true, event: receipt.event }
    : rejected('request_conflict', 'requestId was already used for a different command or role.', state.revision);
  if (command.type === 'submit_native' && state.receipts.some(item => item.actorId === actor.actorId
    && item.event.type === 'submit_native' && item.event.work.source?.inputId === command.source.inputId)) {
    return rejected('request_conflict', 'inputId was already submitted by this actor; reconcile its original request.', state.revision);
  }
  if (command.expectedRevision !== state.revision) return rejected('conflict', 'Aggregate ledger revision changed.', state.revision);
  if (state.revision === Number.MAX_SAFE_INTEGER) throw new Error('Work ledger revision exhausted');
  const at = clock.now();
  if (!Number.isSafeInteger(at) || at < 0 || at < (state.history.at(-1)?.at ?? 0)) throw new Error('Invalid host ledger clock');
  if (command.type === 'import_legacy') {
    if (actor.role !== 'coordinator') return rejected('forbidden', 'Only the coordinator can import historical work.', state.revision);
    const manifest = command.manifest;
    if (!importHostId || manifest.hostId !== importHostId || manifest.projectId !== projectId
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
    // Admission bounds apply to new writes. Migrated record images may grow
    // when adding explicit absence fields, without invalidating old authority.
    // One new event must fit the existing history transport without truncation.
    if (!replaying && new TextEncoder().encode(JSON.stringify(event)).byteLength > 524_288) return rejected('invalid_command', 'Import history event exceeds the bounded transport limit.', state.revision);
    state.works.push(...imported);
    if (!replaying && new TextEncoder().encode(JSON.stringify(snapshot(state, actor))).byteLength > 1_000_000) return rejected('invalid_command', 'Imported snapshot exceeds the bounded read transport limit.', state.revision);
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
  if (command.type === 'create' || command.type === 'submit_native') {
    if (actor.role !== 'coordinator') return rejected('forbidden', 'Only the coordinator can create work.', state.revision);
    work = { id: nextId('work'), title: command.title, goal: command.goal, criteria: command.criteria, source: command.type === 'submit_native' ? command.source : null,
      revision: 1, criteriaRevision: 1, reportedState: 'pending', currentAttemptId: null, createdAt: at, updatedAt: at };
    state.works.push(work);
    if (command.type === 'submit_native') newAttempt(actor.actorId, null);
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

  async function readAuthoritativeState(): Promise<WorkLedgerState> {
    let raw: unknown;
    try { raw = await storage.read(); } catch { throw new WorkLedgerAccessError('storage_error', 'Cannot read authoritative ledger storage.'); }
    try { return readWorkLedgerState(raw, projectId); } catch { throw new WorkLedgerAccessError('invalid_state', 'Authoritative ledger state is invalid; it was not reset.'); }
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
    lookupSubmission(requestId, actor) {
      return admit(async () => {
        if (closed) throw new WorkLedgerAccessError('closed', 'Work ledger is closed');
        requireIdentity(actor);
        if (!string().min(1).max(200).safeParse(requestId).success) throw new WorkLedgerAccessError('invalid_cursor', 'Invalid submission request identity');
        const state = await readAuthoritativeState();
        if (closed) throw new WorkLedgerAccessError('closed', 'Work ledger is closed');
        const trusted = requireIdentity(actor);
        const event = state.receipts.find(receipt => receipt.actorId === trusted.actorId && receipt.requestId === requestId)?.event;
        return event?.type === 'submit_native' ? event as WorkLedgerSubmission : null;
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
              const state = readWorkLedgerState(notification, projectId);
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
        try { state = readWorkLedgerState(current, projectId); } catch {
          return { next: null, value: rejected('invalid_state', 'Authoritative ledger state is invalid; it was not reset.', null) };
        }
        if ((executeOptions?.isAuthorized && executeOptions.isAuthorized() !== true) || !identity(actor)) return { next: null, value: rejected('forbidden', 'Host actor was revoked before commit.', state.revision) };
        // A known durable receipt wins over a later abort: never describe an
        // already committed command as cancelled when reconciling its outcome.
        if (state.receipts.some(receipt => receipt.actorId === requireIdentity(actor).actorId && receipt.requestId === command.requestId)) {
          return { next: null, value: reduceWorkLedger(state, command, requireIdentity(actor), clock, options.importHostId, context) };
        }
        if (signal?.aborted) return { next: null, value: rejected('cancelled', 'Command was cancelled before commit.', state.revision) };
        const initialRevision = state.revision;
        let result: WorkLedgerResult;
        let next: WorkLedgerState | null;
        try {
          result = reduceWorkLedger(state, command, requireIdentity(actor), clock, options.importHostId, context);
          next = result.kind === 'accepted' && !result.replayed ? readWorkLedgerState(state, projectId) : null;
        } catch {
          return { next: null, value: rejected('host_error', 'Host clock, identity generation or transition validation failed before commit.', initialRevision) };
        }
        // Trusted clocks/ID factories can reenter authority/abort synchronously.
        // This final guard must follow every callback and precede publication.
        // Read the extensible signal accessor before the final identity check:
        // a host-provided getter can itself synchronously revoke the actor.
        const aborted = signal?.aborted;
        const authorized = !executeOptions?.isAuthorized || executeOptions.isAuthorized() === true;
        // Authorization itself may synchronously cancel a genuine host signal.
        // Do not call its extensible getter again after sampling authorization:
        // that would reopen the inverse getter-to-revocation race above.
        const nativelyAborted = readNativeAbortState(signal);
        if (!authorized || !identity(actor)) return { next: null, value: rejected('forbidden', 'Host actor was revoked before commit.', initialRevision) };
        if (aborted || nativelyAborted) return { next: null, value: rejected('cancelled', 'Command was cancelled before commit.', initialRevision) };
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

/** Host-only in-memory composition; its storage owner publishes both events atomically. */
export function reduceWorkLedgerSettlement(state: WorkLedgerState, input: {
  readonly target: WorkEvidenceTarget; readonly report: string;
  readonly attestation: Pick<LedgerEvidence, 'outcome' | 'reason' | 'references' | 'source' | 'criteriaResults'>;
  readonly actorId: string; readonly reportRequestId: string; readonly evidenceRequestId: string;
}, clock: WorkLedgerClock): { readonly state: WorkLedgerState; readonly report: Exclude<WorkLedgerEvent, { type: 'import_legacy' }>; readonly evidence: Exclude<WorkLedgerEvent, { type: 'import_legacy' }> } {
  const next = readWorkLedgerState(state, state.projectId);
  const work = next.works.find(value => value.id === input.target.workId);
  const attempt = next.attempts.find(value => value.id === input.target.attemptId);
  if (!work || !attempt || !targetMatches(input.target, work, attempt) || attempt.ownerId !== input.actorId
    || attempt.state !== 'active' || work.reportedState === 'complete' || work.reportedState === 'cancelled') throw new Error('Native settlement target is stale');
  const reportCommand = workLedgerCommandSchema.parse({ type: 'report', requestId: input.reportRequestId, expectedRevision: next.revision,
    workId: work.id, attemptId: attempt.id, state: 'complete', report: input.report });
  const report = reduceWorkLedger(next, reportCommand, { projectId: next.projectId, actorId: input.actorId, role: 'worker' }, clock);
  if (report.kind !== 'accepted' || report.replayed || report.event.type === 'import_legacy') throw new Error('Native settlement report refused');
  const target = { workId: work.id, workRevision: work.revision, criteriaRevision: work.criteriaRevision, attemptId: attempt.id, attemptRevision: attempt.revision };
  const evidenceCommand = workLedgerCommandSchema.parse({ type: 'record_evidence', requestId: input.evidenceRequestId, expectedRevision: next.revision,
    target, ...input.attestation });
  const evidence = reduceWorkLedger(next, evidenceCommand, { projectId: next.projectId, actorId: input.actorId, role: 'verifier' }, clock);
  if (evidence.kind !== 'accepted' || evidence.replayed || evidence.event.type === 'import_legacy' || !evidence.event.evidence) throw new Error('Native settlement evidence refused');
  return { state: readWorkLedgerState(next, next.projectId), report: report.event, evidence: evidence.event };
}

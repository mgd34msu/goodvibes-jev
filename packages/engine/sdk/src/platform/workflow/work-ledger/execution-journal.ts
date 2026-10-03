import { createHash } from 'node:crypto';
import { canonicalJson, type JsonValue } from '@goodvibes-jev/judgment';
import { parseJevDecision } from '@goodvibes-jev/judgment/decisions';
import { validateNativeExecutionDecision, type NativeExecutionDecisionContext } from './execution-admission.js';
import { executionDigest, executionIsCurrent } from './execution-state.js';
import { workExecutionSchema, type WorkExecution } from './execution-types.js';
import { readWorkLedgerState } from './state.js';
import type { WorkEvidenceTarget, WorkLedgerActor, WorkLedgerAuthority, WorkLedgerState, WorkLedgerStorage } from './types.js';

export interface WorkExecutionJournal {
  prepare(input: { readonly id: string; readonly target: WorkEvidenceTarget; readonly sessionId: string; readonly projectRoot: string }, actor: WorkLedgerActor, signal?: AbortSignal): Promise<WorkExecution>;
  list(actor: WorkLedgerActor): Promise<readonly WorkExecution[]>;
  admitDecision(id: string, value: unknown, current: NativeExecutionDecisionContext, actor: WorkLedgerActor, signal?: AbortSignal): Promise<WorkExecution>;
  recordRunnerReceipt(id: string, receipt: unknown, actor: WorkLedgerActor, signal?: AbortSignal): Promise<WorkExecution>;
  stagePublication(id: string, publication: NonNullable<WorkExecution['publication']>, actor: WorkLedgerActor, signal?: AbortSignal): Promise<WorkExecution>;
  dispatch<T>(id: string, actor: WorkLedgerActor, launch: (execution: WorkExecution, assertCurrent: () => void) => T, current: NativeExecutionDecisionContext, signal?: AbortSignal): Promise<T>;
  transition(id: string, update: { readonly status: 'running' | 'cancelled' | 'invalidated'; readonly reason: string }, actor: WorkLedgerActor, signal?: AbortSignal): Promise<WorkExecution>;
  close(): Promise<void>;
}

/** Durable outbox only. Runner identity and launch ownership belong to ContractRunner. */
export function createWorkExecutionJournal(options: {
  readonly storage: WorkLedgerStorage;
  readonly authority: WorkLedgerAuthority;
  readonly projectId: string;
}): WorkExecutionJournal {
  const { storage, authority, projectId } = options;
  let closed = false;
  let closing: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  function own<T>(run: () => T | Promise<T>): Promise<T> {
    if (closed) return Promise.reject(new Error('Native journal is closed'));
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    pending.add(promise);
    void promise.then(() => pending.delete(promise), () => pending.delete(promise));
    try { resolve(run()); } catch (error) { reject(error); }
    return promise;
  }
  function authenticate(actor: WorkLedgerActor, signal?: AbortSignal): string {
    const aborted = signal?.aborted;
    const identity = authority.authenticateActor(actor);
    if (identity.projectId !== projectId || identity.role === 'verifier') throw new Error('Native execution actor is invalid');
    if (aborted) throw new Error('Native execution cancelled');
    return identity.actorId;
  }
  function entryFor(state: WorkLedgerState, id: string, actor: WorkLedgerActor): WorkExecution {
    const actorId = authenticate(actor);
    const entry = state.executions.find(item => item.id === id);
    if (!entry || entry.actorId !== actorId) throw new Error('Native execution is unavailable to actor');
    return entry;
  }
  function requireCurrent(state: WorkLedgerState, entry: WorkExecution): void {
    if (!executionIsCurrent(state, entry)) throw new Error('Native execution target is stale');
  }
  function change(actor: WorkLedgerActor, signal: AbortSignal | undefined, apply: (state: WorkLedgerState) => WorkExecution): Promise<WorkExecution> {
    return storage.transaction(raw => {
      const state = readWorkLedgerState(raw, projectId);
      authenticate(actor, signal);
      const entry = apply(state);
      state.executionRevision++;
      const next = readWorkLedgerState(state, projectId);
      authenticate(actor, signal);
      return { next, value: structuredClone(entry) };
    });
  }
  return {
    prepare(input, actor, signal) {
      return own(() => {
        const actorId = authenticate(actor);
        const frozen = structuredClone(input);
        return change(actor, signal, state => {
          const work = state.works.find(item => item.id === frozen.target.workId);
          if (!work) throw new Error('Native work is unavailable');
          const candidate = { ...frozen, actorId, projectId, goal: work.goal, criteria: [...work.criteria] };
          const entry = workExecutionSchema.parse({ ...candidate, contractId: null, inputDigest: executionDigest(candidate), status: 'pending', reason: '', decisionIds: [], admissions: [], evidenceId: null });
          requireCurrent(state, entry);
          const existing = state.executions.find(item => item.id === entry.id || item.target.attemptId === entry.target.attemptId);
          if (existing) {
            if (existing.id !== entry.id || existing.inputDigest !== entry.inputDigest) throw new Error('Native execution identity conflict');
            return existing;
          }
          state.executions.push(entry);
          return entry;
        });
      });
    },
    list(actor) {
      return own(async () => {
        authenticate(actor);
        const state = readWorkLedgerState(await storage.read(), projectId);
        const actorId = authenticate(actor);
        return structuredClone(state.executions.filter(entry => entry.actorId === actorId));
      });
    },
    admitDecision(id, value, current, actor, signal) {
      return own(() => {
        authenticate(actor);
        const decision = parseJevDecision(structuredClone(value));
        return change(actor, signal, state => {
          const entry = entryFor(state, id, actor);
          requireCurrent(state, entry);
          validateNativeExecutionDecision(entry, decision, current);
          const replay = entry.admissions.map(parseJevDecision).find(item => item.decisionId === decision.decisionId);
          if (replay) {
            if (canonicalJson(replay as unknown as JsonValue) !== canonicalJson(decision as unknown as JsonValue)) throw new Error('Native decision identity conflict');
            return entry;
          }
          if (!['pending', 'revising', 'deferred'].includes(entry.status)) throw new Error('Native decision transition is invalid');
          entry.admissions.push(decision as unknown as JsonValue);
          entry.decisionIds = [...decision.judgmentDecisionIds];
          entry.status = ({ act: 'dispatching', revise: 'revising', defer: 'deferred', reject: 'rejected' } as const)[decision.outcome];
          entry.reason = decision.summary;
          validateNativeExecutionDecision(entry, decision, current);
          return entry;
        });
      });
    },
    recordRunnerReceipt(id, receipt, actor, signal) {
      return own(() => {
        authenticate(actor);
        const frozen = workExecutionSchema.shape.runnerReceipt.unwrap().parse(structuredClone(receipt));
        if (!frozen || typeof frozen !== 'object' || Array.isArray(frozen)) throw new Error('Invalid runner receipt');
        const contractId = workExecutionSchema.shape.contractId.unwrap().parse(frozen['contractId']);
        const digest = createHash('sha256').update(canonicalJson(frozen)).digest('hex');
        return change(actor, signal, state => {
          const entry = entryFor(state, id, actor);
          requireCurrent(state, entry);
          if (entry.runnerReceiptDigest) {
            if (entry.runnerReceiptDigest !== digest || entry.contractId !== contractId) throw new Error('Runner receipt identity conflict');
            return entry;
          }
          if (entry.status !== 'dispatching') throw new Error('Runner receipt requires admitted dispatch');
          entry.contractId = contractId; entry.runnerReceipt = frozen; entry.runnerReceiptDigest = digest;
          return entry;
        });
      });
    },
    stagePublication(id, publication, actor, signal) {
      return own(() => {
        authenticate(actor);
        const frozen = workExecutionSchema.shape.publication.unwrap().parse(structuredClone(publication));
        return change(actor, signal, state => {
          const entry = entryFor(state, id, actor);
          requireCurrent(state, entry);
          if (!entry.contractId || !['dispatching', 'running'].includes(entry.status)) throw new Error('Native publication requires a bound active execution');
          if (entry.publication && (entry.publication.report !== frozen.report || canonicalJson(entry.publication.attestation) !== canonicalJson(frozen.attestation))) throw new Error('Native publication identity conflict');
          if (frozen.expectedRevision !== state.revision) throw new Error('Native publication revision conflict');
          if (state.receipts.some(item => item.requestId === `native:${entry.contractId}:report` && item.actorId === entry.actorId)) throw new Error('Native publication already started');
          entry.publication = frozen;
          return entry;
        });
      });
    },
    dispatch(id, actor, launch, current, signal) {
      return own(() => {
        authenticate(actor);
        return storage.transaction(raw => {
          const state = readWorkLedgerState(raw, projectId);
          const entry = entryFor(state, id, actor);
          const assertCurrent = () => {
            requireCurrent(state, entry);
            if (!entry.contractId || !['dispatching', 'running'].includes(entry.status)) throw new Error('Native dispatch is not bound and admitted');
            const decision = parseJevDecision(entry.admissions.at(-1));
            if (decision.outcome !== 'act') throw new Error('Native execution requires current act decision');
            validateNativeExecutionDecision(entry, decision, current);
            authenticate(actor, signal);
          };
          assertCurrent();
          const value = launch(structuredClone(entry), assertCurrent);
          if (value && typeof (value as { then?: unknown }).then === 'function') {
            if (value instanceof Promise) void value.catch(() => {});
            throw new Error('Native launch callback must be synchronous');
          }
          assertCurrent();
          return { next: null, value };
        });
      });
    },
    transition(id, update, actor, signal) {
      return own(() => {
        authenticate(actor);
        const frozen = structuredClone(update);
        return change(actor, signal, state => {
          const entry = entryFor(state, id, actor);
          if (!['running', 'cancelled', 'invalidated'].includes(frozen.status)
            || ['settled', 'cancelled', 'invalidated', 'rejected'].includes(entry.status)) throw new Error('Native operational transition is invalid');
          if (frozen.status === 'running') {
            requireCurrent(state, entry);
            if (!entry.contractId || entry.status !== 'dispatching') throw new Error('Native running transition requires bound dispatch');
          }
          entry.status = frozen.status; entry.reason = frozen.reason;
          return entry;
        });
      });
    },
    close() {
      if (closing) return closing;
      closed = true;
      closing = Promise.allSettled([...pending]).then(() => {});
      return closing;
    },
  };
}

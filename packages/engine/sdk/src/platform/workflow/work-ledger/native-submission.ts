/** Explicit original-source submission. This service never starts an executor. */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import type { NativeExecutionScopeOwner, NativePairedExecutionAuthority, NativePairedExecutionSnapshot } from './native-execution.js';
import type { WorkLedgerAuthority, WorkLedgerEvent, WorkLedgerService } from './types.js';
import {
  NATIVE_WORK_SUBMISSION_MAX_REQUEST_BYTES, NATIVE_WORK_SUBMISSION_MAX_RESPONSE_BYTES,
  nativeWorkSubmissionRequestSchema, nativeWorkSubmissionLookupRequestSchema,
  nativeWorkSubmissionReceiptSchema,
  type NativeWorkSubmissionRequest, type NativeWorkSubmissionLookupRequest,
  type NativeWorkSubmissionReceipt, type NativeWorkSubmissionResult, type NativeWorkSubmissionLookupResult,
} from './native-submission-wire.js';

export class NativeWorkSubmissionError extends Error {
  constructor(readonly code: 'invalid' | 'unsupported-authority' | 'forbidden' | 'stale' | 'conflict' | 'request-conflict' | 'indeterminate' | 'unavailable' | 'closed') {
    super(`Native work submission: ${code}`); this.name = 'NativeWorkSubmissionError';
  }
}
export interface NativeWorkSubmissionOptions {
  readonly signal?: AbortSignal;
  /** Current authenticated host permission, never a submitted boolean. */
  readonly isAuthorized?: () => boolean;
}
export interface NativeWorkSubmissionHost {
  readonly projectId: string;
  submit(input: NativeWorkSubmissionRequest, authority: NativePairedExecutionAuthority, options?: NativeWorkSubmissionOptions): Promise<NativeWorkSubmissionResult>;
  get(input: NativeWorkSubmissionLookupRequest, authority: NativePairedExecutionAuthority, options?: NativeWorkSubmissionOptions): Promise<NativeWorkSubmissionLookupResult>;
  close(): Promise<void>;
}
const REQUIRED_SCOPES = ['read:work-ledger', 'write:work-ledger'] as const;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function paired(authority: NativePairedExecutionAuthority): NativePairedExecutionSnapshot {
  const current = authority.current();
  if (!current || current.kind !== 'pairing-token' || current.principalId !== current.authorityId || current.authorityRevision !== current.tokenId
    || !REQUIRED_SCOPES.every(scope => current.scopes.includes('*') || current.scopes.includes(scope))) throw new NativeWorkSubmissionError('unsupported-authority');
  return Object.freeze({ ...current, scopes: Object.freeze([...current.scopes].sort()) });
}
function bounded(value: unknown, limit: number): void {
  let json: string | undefined;
  try { json = JSON.stringify(value); } catch { throw new NativeWorkSubmissionError('invalid'); }
  if (json === undefined || new TextEncoder().encode(json).byteLength > limit) throw new NativeWorkSubmissionError('invalid');
}
function receipt(event: WorkLedgerEvent, projectId: string, sessionId: string): NativeWorkSubmissionReceipt {
  if (event.type !== 'submit_native' || event.work.source?.version !== 1 || !event.attemptId) throw new NativeWorkSubmissionError('unavailable');
  const attempt = event.attempts.find(value => value.id === event.attemptId && value.workId === event.workId);
  if (!attempt) throw new NativeWorkSubmissionError('unavailable');
  const { inputId, ...source } = event.work.source;
  if (source.sessionId !== sessionId || source.sourceId !== hash({ projectId, principalId: event.actorId, inputId })
    || source.sourceRevision !== hash({ version: 1, inputId, goal: event.work.goal, criteria: event.work.criteria })) throw new NativeWorkSubmissionError('unavailable');
  const value = nativeWorkSubmissionReceiptSchema.parse({ projectId, requestId: event.requestId, inputId,
    ledgerRevision: event.sequence, workId: event.workId, attemptId: attempt.id,
    expectedRevision: { work: event.work.revision, criteria: event.work.criteriaRevision, attempt: attempt.revision },
    source, goal: event.work.goal, criteria: event.work.criteria });
  bounded(value, NATIVE_WORK_SUBMISSION_MAX_RESPONSE_BYTES); return value;
}

/** The existing ledger owner and real pairing/scope owners remain the only authorities. */
export function createNativeWorkSubmissionHost(deps: {
  readonly projectId: string; readonly projectRoot: string; readonly sessionId: string;
  readonly service: WorkLedgerService; readonly authority: WorkLedgerAuthority; readonly scopes: NativeExecutionScopeOwner;
}): NativeWorkSubmissionHost {
  const projectRoot = realpathSync(deps.projectRoot);
  const pending = new Set<Promise<unknown>>(); const lifetime = new AbortController();
  let closed = false; let closing: Promise<void> | undefined;
  function assertOpen() { if (closed) throw new NativeWorkSubmissionError('closed'); }
  function track<T>(operation: () => Promise<T>): Promise<T> {
    assertOpen(); const promise = Promise.resolve().then(operation); pending.add(promise);
    void promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise;
  }
  function authorized(authority: NativePairedExecutionAuthority, expected: NativePairedExecutionSnapshot, options: NativeWorkSubmissionOptions): boolean {
    if (options.isAuthorized !== undefined && options.isAuthorized() !== true) return false;
    const current = paired(authority);
    return current.principalId === expected.principalId && current.authorityRevision === expected.authorityRevision
      && JSON.stringify(current.scopes) === JSON.stringify(expected.scopes);
  }
  async function withOwner<T>(authority: NativePairedExecutionAuthority, options: NativeWorkSubmissionOptions,
    operation: (actor: Parameters<WorkLedgerService['readSnapshot']>[0], isAuthorized: () => boolean, signal: AbortSignal) => Promise<T>): Promise<T> {
    assertOpen(); const expected = paired(authority);
    if (!authorized(authority, expected, options)) throw new NativeWorkSubmissionError('forbidden');
    const scope = deps.scopes.currentScope(projectRoot);
    if (scope.root !== projectRoot || realpathSync(deps.projectRoot) !== projectRoot) throw new NativeWorkSubmissionError('stale');
    const signal = options.signal ? AbortSignal.any([lifetime.signal, options.signal]) : lifetime.signal;
    signal.throwIfAborted();
    return authority.withCurrent(expected, async assertAuthority => deps.scopes.withCurrentScope(scope, async assertScope => {
      const current = () => {
        assertOpen(); assertAuthority(); assertScope();
        if (realpathSync(deps.projectRoot) !== projectRoot) throw new NativeWorkSubmissionError('stale');
        return authorized(authority, expected, options);
      };
      if (!current()) throw new NativeWorkSubmissionError('forbidden');
      const actor = deps.authority.issueActor({ actorId: expected.principalId, projectId: deps.projectId, role: 'coordinator' });
      try {
        const result = await operation(actor, current, signal);
        // A committed request remains committed after transport cancellation.
        // Revocation may withhold its response; lookup retains the exact receipt.
        if (!current()) throw new NativeWorkSubmissionError('forbidden');
        return result;
      } finally { deps.authority.revokeActor(actor); }
    }));
  }
  return {
    projectId: deps.projectId,
    submit(input, authority, options = {}) {
      bounded(input, NATIVE_WORK_SUBMISSION_MAX_REQUEST_BYTES);
      const parsed = nativeWorkSubmissionRequestSchema.safeParse(input);
      if (!parsed.success) throw new NativeWorkSubmissionError('invalid');
      const captured = parsed.data; bounded(captured, NATIVE_WORK_SUBMISSION_MAX_REQUEST_BYTES);
      return track(() => withOwner(authority, options, async (actor, isAuthorized, signal) => {
        const identity = paired(authority);
        const source = { version: 1 as const, inputId: captured.inputId, sessionId: deps.sessionId,
          sourceId: hash({ projectId: deps.projectId, principalId: identity.principalId, inputId: captured.inputId }),
          sourceRevision: hash({ version: 1, inputId: captured.inputId, goal: captured.goal, criteria: captured.criteria }) };
        const result = await deps.service.execute({ type: 'submit_native', requestId: captured.requestId, expectedRevision: captured.expectedRevision,
          title: captured.goal.trim(), goal: captured.goal, criteria: captured.criteria, source }, actor, { signal, isAuthorized });
        if (result.kind === 'indeterminate') throw new NativeWorkSubmissionError('indeterminate');
        if (result.kind === 'rejected') {
          const code = result.code === 'request_conflict' ? 'request-conflict' : result.code === 'conflict' ? 'conflict'
            : result.code === 'forbidden' ? 'forbidden' : result.code === 'closed' ? 'closed'
            : result.code === 'invalid_command' ? 'invalid' : 'unavailable';
          throw new NativeWorkSubmissionError(code);
        }
        return { kind: 'submitted', replayed: result.replayed, receipt: receipt(result.event, deps.projectId, deps.sessionId) };
      }));
    },
    get(input, authority, options = {}) {
      bounded(input, NATIVE_WORK_SUBMISSION_MAX_REQUEST_BYTES);
      const parsed = nativeWorkSubmissionLookupRequestSchema.safeParse(input);
      if (!parsed.success) throw new NativeWorkSubmissionError('invalid');
      const requestId = parsed.data.requestId;
      return track(() => withOwner(authority, options, async (actor, _isAuthorized, signal) => {
        signal.throwIfAborted(); const event = await deps.service.lookupSubmission(requestId, actor);
        return event ? { kind: 'found', receipt: receipt(event, deps.projectId, deps.sessionId) } : { kind: 'not-found' };
      }));
    },
    close() {
      if (closing) return closing; closed = true; lifetime.abort();
      closing = Promise.allSettled([...pending]).then(() => {}); return closing;
    },
  };
}

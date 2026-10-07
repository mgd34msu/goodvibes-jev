/** Host-only durable input acceptance. There is deliberately no continuation capability. */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type { NativePairedExecutionAuthority, NativePairedExecutionSnapshot, NativeExecutionScopeOwner } from './native-execution.js';
import type { NativeWorkExecutionTransaction } from './native-execution-types.js';
import { NativeQuestionError, acceptNativeQuestionReply, parseNativeQuestionIdentity, parseNativeQuestionReply,
  type NativeQuestionIdentity, type NativeQuestionRecord } from './native-question-types.js';

export interface NativeQuestionTransaction {
  readonly question: NativeQuestionRecord | null;
  readonly execution: NativeWorkExecutionTransaction;
}
export interface NativeQuestionStorage {
  current(identity: NativeQuestionIdentity): NativeQuestionTransaction;
  /** Trusted host seam. A future producer must prove its checkpoint before creating an open question. */
  transaction(identity: NativeQuestionIdentity, decide: (current: NativeQuestionTransaction) => {
    readonly next: NativeQuestionRecord | null; readonly value: NativeQuestionRecord;
  }, assertCurrent: () => void): Promise<NativeQuestionRecord>;
  close(): Promise<void>;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const required = ['read:work-ledger', 'write:fleet'];
function paired(authority: NativePairedExecutionAuthority): NativePairedExecutionSnapshot {
  const value = authority.current();
  if (!value || value.kind !== 'pairing-token' || value.principalId !== value.authorityId || value.tokenId !== value.authorityRevision
    || !required.every(scope => value.scopes.includes('*') || value.scopes.includes(scope))) throw new NativeQuestionError('unsupported-authority');
  return Object.freeze({ ...value, scopes: Object.freeze([...value.scopes].sort()) });
}

/** No runner, provider, start, resume, tool, or continuation port is accepted here. */
export function createNativeQuestionHost(deps: {
  readonly projectId: string; readonly projectRoot: string; readonly storage: NativeQuestionStorage; readonly scopes: NativeExecutionScopeOwner;
}) {
  const root = realpathSync(deps.projectRoot);
  let closed = false;
  const pending = new Set<Promise<NativeQuestionRecord>>();
  function identity(input: unknown) {
    if (closed) throw new NativeQuestionError('closed');
    const result = parseNativeQuestionIdentity(input);
    if (result.projectId !== deps.projectId) throw new NativeQuestionError('stale');
    return result;
  }
  function inspect(current: NativeQuestionTransaction, owner: NativePairedExecutionSnapshot, active: boolean): NativeQuestionRecord {
    const question = current.question, execution = current.execution.record;
    if (!question) throw new NativeQuestionError('not-found');
    if (!execution?.receipt) throw new NativeQuestionError('stale');
    const scope = deps.scopes.currentScope(root);
    const binding = execution.request.binding;
    if (closed || scope.root !== root || realpathSync(deps.projectRoot) !== root || execution.request.input.projectRoot !== root
      || binding.authorityId !== hash({ pairedPrincipal: owner.authorityId }) || binding.authorityRevision !== hash({ pairedIncarnation: owner.authorityRevision })
      || binding.scopeId !== hash({ workspaceScope: scope.scopeId }) || binding.scopeRevision !== hash({ workspaceGeneration: scope.scopeRevision })
      || !isDeepStrictEqual([...owner.scopes].sort(), [...execution.authorityScopes].sort())) throw new NativeQuestionError('stale');
    if (active) {
      const { ledger, intent } = current.execution;
      const work = ledger.works.find(item => item.id === question.identity.workId);
      const attempt = ledger.attempts.find(item => item.id === question.identity.attemptId);
      const revision = question.identity.expectedRevision;
      if (!work || !attempt || execution.state !== 'launch-claimed' || intent?.state !== 'associated'
        || work.currentAttemptId !== attempt.id || attempt.workId !== work.id || attempt.ownerId !== owner.principalId
        || attempt.state !== 'active' || work.reportedState === 'complete' || work.reportedState === 'cancelled'
        || work.revision !== revision.work || work.criteriaRevision !== revision.criteria || attempt.revision !== revision.attempt
        || work.goal !== execution.request.input.nativeSource?.goal || !isDeepStrictEqual(work.criteria, execution.request.input.nativeSource.criteria)) throw new NativeQuestionError('stale');
    }
    return question;
  }
  return Object.freeze({
    status(input: unknown, authority: NativePairedExecutionAuthority): NativeQuestionRecord {
      const target = identity(input), owner = paired(authority);
      const current = deps.storage.current(target);
      const result = inspect(current, paired(authority), false);
      if (!isDeepStrictEqual(owner, paired(authority))) throw new NativeQuestionError('stale');
      return structuredClone(result);
    },
    accept(input: unknown, authority: NativePairedExecutionAuthority): Promise<NativeQuestionRecord> {
      const reply = parseNativeQuestionReply(input);
      const { requestId: _requestId, answer: _answer, ...target } = reply;
      identity(target);
      const owner = paired(authority), scope = deps.scopes.currentScope(root);
      const operation = authority.withCurrent(owner, async assertAuthority => deps.scopes.withCurrentScope(scope, async assertScope => {
        const assertCurrent = () => { if (closed) throw new NativeQuestionError('closed'); assertAuthority(); assertScope(); };
        return deps.storage.transaction(target, current => {
          assertCurrent();
          const result = acceptNativeQuestionReply(inspect(current, paired(authority), false), reply);
          if (result.next) inspect(current, paired(authority), true);
          return result;
        }, assertCurrent);
      }));
      pending.add(operation);
      void operation.then(() => pending.delete(operation), () => pending.delete(operation));
      return operation;
    },
    async close(): Promise<void> { closed = true; await Promise.allSettled([...pending]); },
  });
}

/** Isolated trusted-storage fixtures only; no evaluator, runner, credentials, or live producer. */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { KnowledgeStore } from '../../sdk/src/platform/knowledge/store.js';
import { loadSqlJsEngine, type SqlDatabase } from '../../sdk/src/platform/state/sqlite-store.js';
import type { SQLitePublicationIO } from '../../sdk/src/platform/state/sqlite-store-persistence.js';
import { criteriaSetIdForWork, durablePayloadRevision, freezeDurableRequest } from '../../sdk/src/platform/contract/durable-admission.js';
import { createWorkLedger } from '../../sdk/src/platform/workflow/work-ledger/service.js';
import { parseNativeWorkExecutionIntent, parseNativeWorkExecutionRecord } from '../../sdk/src/platform/workflow/work-ledger/native-execution-types.js';
import type { NativeExecutionScopeOwner, NativePairedExecutionAuthority, NativePairedExecutionSnapshot } from '../../sdk/src/platform/workflow/work-ledger/native-execution.js';
import { createNativeQuestionHost } from '../../sdk/src/platform/workflow/work-ledger/native-question.js';
import { parseNativeQuestionRecord, type NativeQuestionRecord } from '../../sdk/src/platform/workflow/work-ledger/native-question-types.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function questionHarness() {
  const cleanups: (() => void | Promise<void>)[] = [];
  async function open(file: string) {
    const store = new KnowledgeStore({ dbPath: file });
    cleanups.push(() => store.close());
    const storage = await store.openNativeQuestionStorage('project');
    return { store, storage };
  }
  async function fixture(options: { seed?: boolean } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'native-question-owned-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const file = join(root, 'knowledge.sqlite'), opened = await open(file);
    const executionStorage = await opened.store.openNativeWorkExecutionStorage('project');
    const ledgerStorage = await opened.store.openWorkLedgerStorage('project');
    let id = 0;
    const ledger = createWorkLedger({ projectId: 'project', storage: ledgerStorage, clock: { now: () => 100, newId: kind => `${kind}-${++id}` } });
    cleanups.push(() => ledger.service.close());
    const actor = ledger.authority.issueActor({ projectId: 'project', actorId: 'fixture-owner', role: 'coordinator' });
    const created = await ledger.service.execute({ type: 'create', requestId: 'create', expectedRevision: 0, title: 'Owned question fixture', goal: 'Preserve this entire goal.', criteria: ['Exact first', 'Exact second'] }, actor);
    if (created.kind !== 'accepted' || created.event.type === 'import_legacy') throw new Error('fixture create');
    const claimed = await ledger.service.execute({ type: 'claim', requestId: 'claim', expectedRevision: 1, workId: created.event.workId }, actor);
    if (claimed.kind !== 'accepted' || claimed.event.type === 'import_legacy') throw new Error('fixture claim');
    const work = claimed.event.work, attempt = claimed.event.attempts[0]!;
    const target = { workId: work.id, workRevision: work.revision, criteriaRevision: work.criteriaRevision, attemptId: attempt.id, attemptRevision: attempt.revision };
    const key = { workId: work.id, criteriaId: criteriaSetIdForWork(work.id), criteriaRevision: String(work.criteriaRevision), attemptId: attempt.id };
    const pairedSnapshot: NativePairedExecutionSnapshot = { kind: 'pairing-token', tokenId: 'fixture-token', principalId: 'fixture-owner', authorityId: 'fixture-owner', authorityRevision: 'fixture-token', scopes: ['read:work-ledger', 'write:fleet'] };
    let currentOwner: NativePairedExecutionSnapshot | null = pairedSnapshot;
    const authority: NativePairedExecutionAuthority = {
      current: () => currentOwner,
      async withCurrent(expected, callback) {
        const assertCurrent = () => { if (!isDeepStrictEqual(currentOwner, expected)) throw new Error('fixture authority revoked'); return currentOwner!; };
        assertCurrent(); return callback(assertCurrent);
      },
    };
    let currentScope = { root, scopeId: 'fixture-workspace', scopeRevision: 'fixture-generation' };
    const scopes: NativeExecutionScopeOwner = {
      currentScope: () => currentScope,
      async withCurrentScope(expected, callback) {
        const assertCurrent = () => { if (!isDeepStrictEqual(currentScope, expected)) throw new Error('fixture scope changed'); };
        assertCurrent(); return callback(assertCurrent);
      },
    };
    const binding = { sourceId: 'fixture-source', inputRevision: 'fixture-input', actionId: 'fixture-action', actionRevision: 'fixture-action-revision',
      authorityId: hash({ pairedPrincipal: pairedSnapshot.authorityId }), authorityRevision: hash({ pairedIncarnation: pairedSnapshot.authorityRevision }),
      scopeId: hash({ workspaceScope: currentScope.scopeId }), scopeRevision: hash({ workspaceGeneration: currentScope.scopeRevision }) };
    const request = freezeDurableRequest({ key, binding, input: { ask: work.title, sessionId: 'fixture-session', projectRoot: root, origin: 'external', isolation: 'shared',
      nativeSource: { sourceId: binding.sourceId, sourceRevision: 'fixture-source-revision', inputRevision: binding.inputRevision, criteriaId: key.criteriaId, criteriaRevision: key.criteriaRevision, goal: work.goal, criteria: work.criteria } } });
    const intent = parseNativeWorkExecutionIntent({ version: 1, projectId: 'project', target, authorityScopes: pairedSnapshot.scopes, request, generation: 1, state: 'admitting' });
    const decisionContext = { decisionId: 'fixture-decision', binding, judgmentDecisionIds: ['fixture-reading'], evidence: [{ id: 'fixture-evidence', revision: 'fixture-evidence-revision' }], continuations: [], resumeConditions: [] };
    const receipt = { schemaVersion: 2, key, binding, contractId: 'ctr-01234567', ownerAgentId: 'fixture-agent', payloadRevision: durablePayloadRevision(request), execution: { isolation: 'shared' } } as const;
    const record = parseNativeWorkExecutionRecord({ version: 1, projectId: 'project', target, authorityScopes: intent.authorityScopes, request, decisionContext,
      decision: { schemaVersion: 1, decisionId: decisionContext.decisionId, binding, judgmentDecisionIds: decisionContext.judgmentDecisionIds, evidence: decisionContext.evidence, summary: 'Synthetic trusted storage fixture.', outcome: 'act' }, receipt, state: 'launch-claimed' });
    await executionStorage.transaction(key, () => ({ next: null, nextIntent: intent, value: undefined }));
    await executionStorage.transaction(key, () => ({ next: record, nextIntent: { ...intent, state: 'associated' }, value: undefined }));
    const identity = { projectId: 'project', workId: work.id, attemptId: attempt.id, expectedRevision: { work: work.revision, criteria: work.criteriaRevision, attempt: attempt.revision }, questionId: 'question-1', questionRevision: 1 };
    const question = parseNativeQuestionRecord({ version: 1, identity,
      admission: { contractId: receipt.contractId, ownerAgentId: receipt.ownerAgentId, payloadRevision: receipt.payloadRevision, authorityId: binding.authorityId, authorityRevision: binding.authorityRevision, scopeId: binding.scopeId, scopeRevision: binding.scopeRevision },
      question: 'Which exact label should be used?', checkpointId: 'fixture-checkpoint', state: 'open', answer: null });
    if (options.seed !== false) await seedQuestion(opened.storage, question);
    const host = createNativeQuestionHost({ projectId: 'project', projectRoot: root, storage: opened.storage, scopes });
    cleanups.push(() => host.close());
    return { ...opened, executionStorage, root, file, ledger, actor, work, target, key, intent, record, identity, question, host, authority, scopes,
      reply: { ...identity, requestId: 'answer-request', answer: '  Exact answer\n☃  ' },
      revoke: () => { currentOwner = null; },
      replaceOwner: () => { currentOwner = { ...pairedSnapshot, tokenId: 'replacement-token', authorityRevision: 'replacement-token' }; },
      changeScope: () => { currentScope = { ...currentScope, scopeRevision: 'replacement-generation' }; },
    };
  }
  return { open, fixture, async close() { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); } };
}
export type QuestionFixture = Awaited<ReturnType<ReturnType<typeof questionHarness>['fixture']>>;
export async function seedQuestion(storage: QuestionFixture['storage'], question: NativeQuestionRecord): Promise<void> {
  await storage.transaction(question.identity, () => ({ next: question, value: question }), () => {});
}
export async function inspectQuestionImage<T>(file: string, inspect: (db: SqlDatabase) => T): Promise<T> {
  const SQL = await loadSqlJsEngine(), db = new SQL.Database(readFileSync(file));
  try { return inspect(db); } finally { db.close(); }
}
export async function mutateQuestionImage(file: string, mutate: (db: SqlDatabase) => void): Promise<void> {
  await inspectQuestionImage(file, db => { mutate(db); writeFileSync(file, db.export()); });
}
export function questionPersistence(store: KnowledgeStore) {
  return (store as unknown as { sqlite: { persistence: { io: SQLitePublicationIO } } }).sqlite.persistence;
}
export function readAuthorityRows(file: string) {
  return inspectQuestionImage(file, db => ['work_ledgers', 'native_work_executions', 'native_work_execution_intents', 'native_work_execution_settlements', 'native_conversation_captures']
    .map(table => ({ table, rows: db.exec(`SELECT * FROM ${table}`)[0]?.values ?? [] })));
}

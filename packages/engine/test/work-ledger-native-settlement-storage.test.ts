/** Owned synthetic SQLite and paired-host fixtures; no user settings, credentials, or external services. */
import { afterEach, expect, test } from 'bun:test';
import * as nativeFs from 'node:fs';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { loadSqlJsEngine, SQLiteStore, type SqlDatabase } from '../sdk/src/platform/state/sqlite-store.js';
import type { SQLitePublicationIO } from '../sdk/src/platform/state/sqlite-store-persistence.js';
import { criteriaSetIdForWork, durablePayloadRevision, freezeDurableRequest } from '../sdk/src/platform/contract/durable-admission.js';
import { checkSettings } from '../sdk/src/platform/contract/check.js';
import { CONTRACT_CONFIG_DEFAULTS } from '../sdk/src/platform/contract/config.js';
import { createWorkLedger, readWorkLedgerState } from '../sdk/src/platform/workflow/work-ledger/service.js';
import { parseNativeWorkExecutionIntent, parseNativeWorkExecutionRecord, type NativeWorkExecutionStorage } from '../sdk/src/platform/workflow/work-ledger/native-execution-types.js';
import { createNativeWorkExecutionHost } from '../sdk/src/platform/workflow/work-ledger/native-execution.js';
import { nativeSettlementDigest, nativeWorkSettlementSchema, type NativeWorkSettlementPublication, type NativeWorkSettlementReceipt } from '../sdk/src/platform/workflow/work-ledger/native-settlement-types.js';
import { PairingTokenManager } from '../sdk/src/platform/pairing/pairing-token-store.js';
import { WorkspaceRegistrationStore } from '../sdk/src/platform/workspace/registration/store.js';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../sdk/src/platform/daemon/control-plane.js';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.js';
import { acquireCrossProcessLock } from '../sdk/src/platform/workspace/checkpoint/cross-process-lock.js';
import { finishes } from './contract/steps-support.js';
import { makeHarness, makeRepo, oneUnitPlan, runnerPort, waitFor } from './contract/runner-support.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function open(file: string) {
  const store = new KnowledgeStore({ dbPath: file });
  cleanups.push(() => store.close());
  return { store, storage: await store.openNativeWorkExecutionStorage('project') };
}
async function fixture(options: { root?: string; actorId?: string; associate?: boolean } = {}) {
  const root = options.root ?? mkdtempSync(join(tmpdir(), 'native-settlement-storage-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'knowledge.sqlite'); const opened = await open(file);
  const ledgerStorage = await opened.store.openWorkLedgerStorage('project');
  let id = 0;
  const ledger = createWorkLedger({ projectId: 'project', storage: ledgerStorage, clock: { now: () => Date.now(), newId: kind => `${kind}-${++id}` } });
  cleanups.push(() => ledger.service.close());
  const actorId = options.actorId ?? 'fixture-owner';
  const actor = ledger.authority.issueActor({ projectId: 'project', actorId, role: 'coordinator' });
  const create = { type: 'create', requestId: 'create', expectedRevision: 0, title: 'Owned settlement fixture', goal: 'Keep the entire original goal.\nIncluding the second line ☃.', criteria: ['Exact first criterion', 'Exact ordered second criterion'] } as const;
  const created = await ledger.service.execute(create, actor);
  if (created.kind !== 'accepted' || created.event.type === 'import_legacy') throw new Error('fixture create');
  const claim = { type: 'claim', requestId: 'claim', expectedRevision: 1, workId: created.event.workId } as const;
  const claimed = await ledger.service.execute(claim, actor);
  if (claimed.kind !== 'accepted' || claimed.event.type === 'import_legacy') throw new Error('fixture claim');
  const work = claimed.event.work; const attempt = claimed.event.attempts[0]!;
  const target = { workId: work.id, workRevision: work.revision, criteriaRevision: work.criteriaRevision, attemptId: attempt.id, attemptRevision: attempt.revision };
  const key = { workId: work.id, criteriaId: criteriaSetIdForWork(work.id), criteriaRevision: String(work.criteriaRevision), attemptId: attempt.id };
  const binding = { sourceId: 'fixture-source', inputRevision: 'fixture-input', actionId: 'fixture-action', actionRevision: 'fixture-action-revision', authorityId: 'fixture-authority', authorityRevision: 'fixture-authority-revision', scopeId: 'fixture-scope', scopeRevision: 'fixture-scope-revision' };
  const request = freezeDurableRequest({ key, binding, input: { ask: work.title, sessionId: 'fixture-session', projectRoot: root, origin: 'external', isolation: 'shared', nativeSource: { sourceId: binding.sourceId, sourceRevision: 'fixture-source-revision', inputRevision: binding.inputRevision, criteriaId: key.criteriaId, criteriaRevision: key.criteriaRevision, goal: work.goal, criteria: work.criteria } } });
  const intent = parseNativeWorkExecutionIntent({ version: 1, projectId: 'project', target, authorityScopes: ['write:fleet', 'read:work-ledger'], request, generation: 1, state: 'admitting' });
  const decisionContext = { decisionId: 'fixture-decision', binding, judgmentDecisionIds: ['fixture-reading'], evidence: [{ id: 'fixture-evidence', revision: 'fixture-evidence-revision' }], continuations: [], resumeConditions: [] };
  // This is parser-valid synthetic storage data, not a semantic proof or live permission grant.
  const record = parseNativeWorkExecutionRecord({ version: 1, projectId: 'project', target, authorityScopes: intent.authorityScopes, request, decisionContext, decision: { schemaVersion: 1, decisionId: decisionContext.decisionId, binding, judgmentDecisionIds: decisionContext.judgmentDecisionIds, evidence: decisionContext.evidence, summary: 'Owned storage fixture only.', outcome: 'act' }, receipt: { schemaVersion: 2, key, binding, contractId: 'ctr-01234567', ownerAgentId: 'fixture-agent', payloadRevision: durablePayloadRevision(request), execution: { isolation: 'shared' } }, state: 'launch-claimed' });
  if (options.associate !== false) {
    await opened.storage.transaction(key, () => ({ next: null, nextIntent: intent, value: undefined }));
    await opened.storage.transaction(key, () => ({ next: record, nextIntent: { ...intent, state: 'associated' }, value: undefined }));
  }
  const receiptDigest = nativeSettlementDigest(record.receipt); const contractDigest = nativeSettlementDigest({ fixture: 'terminal-contract' });
  const references = [{ kind: 'test' as const, ref: 'fixture:acceptance', digest: nativeSettlementDigest('acceptance') },
    { kind: 'test' as const, ref: `receipt:${record.receipt!.contractId}`, digest: receiptDigest },
    { kind: 'test' as const, ref: `execution:${record.receipt!.contractId}`, digest: contractDigest }];
  const publication: NativeWorkSettlementPublication = {
    report: 'Owned synthetic terminal report', receiptDigest, contractDigest, actorId,
    attestation: { outcome: 'verified', reason: 'Owned storage attestation fixture.', source: 'host_check', references, criteriaResults: work.criteria.map((_text, criterionIndex) => ({ criterionIndex, status: 'satisfied', references: references.map(reference => reference.ref) })) },
  };
  return { ...opened, root, file, ledger, actor, actorId, work, target, key, intent, record, publication, create, claim, created, claimed };
}
function settle(storage: NativeWorkExecutionStorage, f: Pick<Awaited<ReturnType<typeof fixture>>, 'key' | 'publication'>, assertCurrent: () => void = () => {}) {
  if (!storage.settle) throw new Error('Fixture requires settlement storage');
  return storage.settle(f.key, () => f.publication, assertCurrent);
}
async function inspectImage<T>(file: string, inspect: (db: SqlDatabase) => T): Promise<T> {
  const SQL = await loadSqlJsEngine(); const db = new SQL.Database(readFileSync(file));
  try { return inspect(db); } finally { db.close(); }
}
async function mutateImage(file: string, mutate: (db: SqlDatabase) => void) {
  await inspectImage(file, db => { mutate(db); writeFileSync(file, db.export()); });
}
function persistence(store: KnowledgeStore) {
  return (store as unknown as { sqlite: { persistence: { io: SQLitePublicationIO } } }).sqlite.persistence;
}
async function assertImage(file: string, expectedRevision: number, expectedSettlements: number) {
  await inspectImage(file, db => {
    const rows = db.exec('SELECT format_version, revision, state_json FROM work_ledgers WHERE project_id = ?', ['project'])[0]!.values;
    expect(rows).toHaveLength(1);
    const row = rows[0]!; const ledger = readWorkLedgerState(JSON.parse(String(row[2])), 'project');
    expect(row[0]).toBe(ledger.version); expect(row[1]).toBe(expectedRevision); expect(ledger.revision).toBe(expectedRevision);
    expect(ledger.history.filter(event => event.type === 'report')).toHaveLength(expectedSettlements);
    expect(ledger.history.filter(event => event.type === 'record_evidence')).toHaveLength(expectedSettlements);
    expect(ledger.evidence).toHaveLength(expectedSettlements);
    expect(db.exec('SELECT COUNT(*) FROM native_work_execution_settlements')[0]?.values).toEqual([[expectedSettlements]]);
    if (expectedSettlements) {
      const receipt = nativeWorkSettlementSchema.parse(JSON.parse(String(db.exec('SELECT state_json FROM native_work_execution_settlements')[0]!.values[0]![0])));
      expect(ledger.history[receipt.reportSequence - 1]).toMatchObject({ type: 'report', requestId: receipt.reportRequestId });
      expect(ledger.history[receipt.evidenceSequence - 1]).toMatchObject({ type: 'record_evidence', requestId: receipt.evidenceRequestId, evidence: { id: receipt.evidenceId, target: receipt.targetAfterReport } });
      expect(receipt.evidenceSequence).toBe(receipt.reportSequence + 1);
    }
  });
}

test('SQLite settlement publishes one adjacent report/evidence pair and matching receipt without altering execution formats', async () => {
  const f = await fixture();
  const original = f.storage.current(f.key);
  await f.store.upsertSource({ id: 'unrelated', connectorId: 'fixture', sourceType: 'manual', status: 'indexed', metadata: { retained: true } });
  let guards = 0;
  const receipt = await settle(f.storage, f, () => { guards++; });
  expect(guards).toBe(3);
  const current = f.storage.currentByAttempt(f.key.attemptId);
  expect(current.record).toEqual(original.record); expect(current.intent).toEqual(original.intent);
  expect(current.ledger.history.slice(0, 2)).toEqual(original.ledger.history);
  expect(current.settlement).toEqual(receipt); expect(current.ledger.evidence[0]?.target).toEqual(receipt.targetAfterReport);
  expect(receipt).toMatchObject({ target: f.target, receiptDigest: nativeSettlementDigest(f.record.receipt), payloadRevision: durablePayloadRevision(f.record.request), publicationDigest: nativeSettlementDigest(f.publication), attestation: f.publication.attestation });
  expect(receipt.targetAfterReport).toEqual({ ...f.target, workRevision: f.target.workRevision + 1, attemptRevision: f.target.attemptRevision + 1 });
  expect(Object.keys(current.record!).sort()).toEqual(['authorityScopes', 'decision', 'decisionContext', 'projectId', 'receipt', 'request', 'state', 'target', 'version']);
  expect(() => parseNativeWorkExecutionRecord({ ...current.record, settlement: receipt })).toThrow('invalid');
  await assertImage(f.file, 4, 1);
  const reopened = await open(f.file);
  expect(reopened.storage.current(f.key)).toEqual(current);
  expect(reopened.store.getSource('unrelated')?.metadata).toMatchObject({ retained: true });
});

for (const failingGuard of [1, 2, 3]) test(`guard ${failingGuard} failure rolls back report, evidence and receipt together`, async () => {
  const f = await fixture(); const before = readFileSync(f.file); const original = f.storage.current(f.key); let guards = 0;
  await expect(settle(f.storage, f, () => { if (++guards === failingGuard) throw new Error('owned final guard rejection'); })).rejects.toThrow('owned final guard rejection');
  expect(guards).toBe(failingGuard); expect(readFileSync(f.file)).toEqual(before);
  expect(f.storage.current(f.key)).toEqual(original); await assertImage(f.file, 2, 0);
  const reopened = await open(f.file); await settle(reopened.storage, f); await assertImage(f.file, 4, 1);
});

for (const phase of ['before-rename', 'after-rename'] as const) test(`${phase} failure exposes either no settlement or the whole settlement and recovers exactly once`, async () => {
  const f = await fixture(); const before = readFileSync(f.file); const owner = persistence(f.store); let injected = false;
  owner.io = { ...nativeFs,
    renameSync(from, to) { if (phase === 'before-rename' && !injected) { injected = true; throw new Error('owned rename failure'); } nativeFs.renameSync(from, to); },
    fsyncSync(fd) { if (phase === 'after-rename' && !injected && nativeFs.fstatSync(fd).isDirectory()) { injected = true; throw new Error('owned directory sync failure'); } nativeFs.fsyncSync(fd); },
  };
  try { await expect(settle(f.storage, f)).rejects.toThrow('persistence failure'); } finally { owner.io = nativeFs; }
  expect(injected).toBe(true);
  if (phase === 'before-rename') expect(readFileSync(f.file)).toEqual(before);
  await assertImage(f.file, phase === 'after-rename' ? 4 : 2, phase === 'after-rename' ? 1 : 0);
  const reopened = await open(f.file); const previous = reopened.storage.current(f.key).settlement;
  let renames = 0; const recoveryOwner = persistence(reopened.store);
  recoveryOwner.io = { ...nativeFs, renameSync(from, to) { renames++; nativeFs.renameSync(from, to); } };
  try {
    const recovered = await settle(reopened.storage, f);
    if (phase === 'after-rename') { expect(previous).not.toBeNull(); expect(recovered).toEqual(previous!); }
    expect(renames).toBe(phase === 'after-rename' ? 0 : 1);
    expect(await settle(reopened.storage, f)).toEqual(recovered);
  } finally { recoveryOwner.io = nativeFs; }
  await assertImage(f.file, 4, 1);
});

test('exact retries and null reconciliation retain the first receipt; conflicting publication retries change no bytes', async () => {
  const f = await fixture(); const receipt = await settle(f.storage, f); const bytes = readFileSync(f.file);
  const reopened = await open(f.file);
  expect(await settle(reopened.storage, f, () => { throw new Error('No new verification on exact replay'); })).toEqual(receipt);
  expect(await reopened.storage.settle!(f.key, () => null, () => { throw new Error('No new verification on reconciliation'); })).toEqual(receipt);
  const conflicts: NativeWorkSettlementPublication[] = [
    { ...f.publication, report: 'Another result' },
    { ...f.publication, actorId: 'another-owner' },
    { ...f.publication, receiptDigest: nativeSettlementDigest('other-receipt') },
    { ...f.publication, contractDigest: nativeSettlementDigest('other-contract') },
    { ...f.publication, attestation: { ...f.publication.attestation, reason: 'Another attestation' } },
  ];
  for (const publication of conflicts) {
    await expect(settle(reopened.storage, { ...f, publication })).rejects.toMatchObject({ code: 'conflict' });
    expect(readFileSync(f.file)).toEqual(bytes);
  }
  await assertImage(f.file, 4, 1);
});

test('different storage owners concurrently settle one immutable publication and preserve the winner on a conflicting race', async () => {
  const f = await fixture(); const second = await open(f.file);
  const release = await acquireCrossProcessLock(`${f.file}.knowledge-lock`, { strictOwnership: true });
  const one = settle(f.storage, f); const two = settle(second.storage, f); release();
  const receipts = await Promise.all([one, two]); expect(receipts[0]).toEqual(receipts[1]); await assertImage(f.file, 4, 1);
  const g = await fixture(); const other = await open(g.file);
  const conflict = { ...g.publication, report: 'Competing report' };
  const unlock = await acquireCrossProcessLock(`${g.file}.knowledge-lock`, { strictOwnership: true });
  const candidates = [settle(g.storage, g), settle(other.storage, { ...g, publication: conflict })]; unlock();
  const results = await Promise.allSettled(candidates);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  const rejected = results.find(result => result.status === 'rejected'); expect(rejected?.status === 'rejected' && rejected.reason).toMatchObject({ code: 'conflict' });
  const winner = g.storage.current(g.key).settlement!;
  expect([nativeSettlementDigest(g.publication), nativeSettlementDigest(conflict)]).toContain(winner.publicationDigest);
  await assertImage(g.file, 4, 1);
});

test('settlement retries remain historical after newer work revisions, and ordinary history receipts remain replayable', async () => {
  const f = await fixture(); const receipt = await settle(f.storage, f);
  expect(await f.ledger.service.execute(f.create, f.actor)).toEqual({ ...f.created, replayed: true });
  expect(await f.ledger.service.execute(f.claim, f.actor)).toEqual({ ...f.claimed, replayed: true });
  const history = await f.ledger.service.history(0, f.actor);
  expect(history.map(event => event.type)).toEqual(['create', 'claim', 'report', 'record_evidence']);
  expect(await f.ledger.service.history(2, f.actor)).toEqual(history.slice(2));
  expect(await f.ledger.service.execute({ type: 'reopen', requestId: 'reopen', expectedRevision: 4, workId: f.work.id, reason: 'A new round of work' }, f.actor)).toMatchObject({ kind: 'accepted' });
  expect(await f.ledger.service.execute({ type: 'revise', requestId: 'revise', expectedRevision: 5, workId: f.work.id, title: f.work.title, goal: 'New goal', criteria: ['New criterion'] }, f.actor)).toMatchObject({ kind: 'accepted' });
  const bytes = readFileSync(f.file); const reopened = await open(f.file);
  expect(reopened.storage.current(f.key).settlement).toEqual(receipt);
  expect(await settle(reopened.storage, f)).toEqual(receipt); expect(readFileSync(f.file)).toEqual(bytes);
  expect(reopened.storage.current(f.key).ledger.history.slice(0, 4)).toEqual([...history]);
});

test('schema5 migration preserves exact execution, intent and ledger JSON and creates no settlement authority', async () => {
  const f = await fixture(); const original = f.storage.current(f.key); await f.store.close();
  const executionJson = JSON.stringify(original.record, null, 2); const intentJson = JSON.stringify(original.intent, null, 2); const ledgerJson = JSON.stringify(original.ledger, null, 2);
  await mutateImage(f.file, db => {
    db.run('DROP TABLE native_work_execution_settlements'); db.run('DROP TABLE native_work_questions'); db.run('PRAGMA user_version = 5');
    db.run('UPDATE native_work_executions SET state_json = ?', [executionJson]);
    db.run('UPDATE native_work_execution_intents SET state_json = ?', [intentJson]);
    db.run('UPDATE work_ledgers SET state_json = ?', [ledgerJson]);
  });
  const migrated = await open(f.file); expect(migrated.storage.current(f.key)).toEqual(original);
  await inspectImage(f.file, db => {
    expect(db.exec('PRAGMA user_version')[0]?.values).toEqual([[8]]);
    expect(db.exec('SELECT state_json FROM native_work_executions')[0]?.values).toEqual([[executionJson]]);
    expect(db.exec('SELECT state_json FROM native_work_execution_intents')[0]?.values).toEqual([[intentJson]]);
    expect(db.exec('SELECT state_json FROM work_ledgers')[0]?.values).toEqual([[ledgerJson]]);
    expect(db.exec('SELECT COUNT(*) FROM native_work_execution_settlements')[0]?.values).toEqual([[0]]);
  });
  const older = new SQLiteStore(f.file); cleanups.push(() => older.close());
  await expect(older.init(() => {}, { schemaVersion: 5 })).rejects.toThrow('newer version');
  await settle(migrated.storage, f); await assertImage(f.file, 4, 1);
});

for (const corruption of ['execution', 'intent', 'history'] as const) test(`schema5 migration refuses corrupt ${corruption} before creating the settlement table`, async () => {
  const f = await fixture(); await f.store.close();
  await mutateImage(f.file, db => {
    db.run('DROP TABLE native_work_execution_settlements'); db.run('DROP TABLE native_work_questions'); db.run('PRAGMA user_version = 5');
    if (corruption === 'execution') db.run("UPDATE native_work_executions SET state_json = '{}'");
    else if (corruption === 'intent') db.run("UPDATE native_work_execution_intents SET state_json = '{}'");
    else {
      const row = db.exec('SELECT state_json FROM work_ledgers')[0]!.values[0]!;
      const ledger = JSON.parse(String(row[0])) as { receipts: unknown[] };
      ledger.receipts = []; db.run('UPDATE work_ledgers SET state_json = ?', [JSON.stringify(ledger)]);
    }
  });
  const bytes = readFileSync(f.file);
  await expect(open(f.file)).rejects.toThrow(); expect(readFileSync(f.file)).toEqual(bytes);
  await inspectImage(f.file, db => {
    expect(db.exec('PRAGMA user_version')[0]?.values).toEqual([[5]]);
    expect(db.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'native_work_execution_settlements'")).toEqual([]);
  });
});

const corruptBindings: readonly { name: string; change: (receipt: NativeWorkSettlementReceipt) => NativeWorkSettlementReceipt }[] = [
  { name: 'receipt digest', change: receipt => ({ ...receipt, receiptDigest: nativeSettlementDigest('foreign-receipt') }) },
  { name: 'payload revision', change: receipt => ({ ...receipt, payloadRevision: nativeSettlementDigest('foreign-payload') }) },
  { name: 'original target', change: receipt => ({ ...receipt, target: { ...receipt.target, workRevision: receipt.target.workRevision + 1 } }) },
  { name: 'contract identity', change: receipt => ({ ...receipt, contractId: 'ctr-abcdef01' }) },
  { name: 'contract digest', change: receipt => ({ ...receipt, contractDigest: nativeSettlementDigest('foreign-contract') }) },
  { name: 'publication digest', change: receipt => ({ ...receipt, publicationDigest: nativeSettlementDigest('foreign-publication') }) },
  { name: 'report request', change: receipt => ({ ...receipt, reportRequestId: 'foreign-report' }) },
  { name: 'evidence request', change: receipt => ({ ...receipt, evidenceRequestId: 'foreign-evidence' }) },
  { name: 'adjacent sequence', change: receipt => ({ ...receipt, evidenceSequence: receipt.evidenceSequence + 1 }) },
  { name: 'evidence identity', change: receipt => ({ ...receipt, evidenceId: 'foreign-evidence' }) },
  { name: 'post-report target', change: receipt => ({ ...receipt, targetAfterReport: { ...receipt.targetAfterReport, attemptRevision: receipt.targetAfterReport.attemptRevision + 1 } }) },
  { name: 'attestation', change: receipt => ({ ...receipt, attestation: { ...receipt.attestation, reason: 'Rewritten attestation' } }) },
];
for (const corruption of corruptBindings) test(`corrupt ${corruption.name} settlement binding fails closed on both persisted reads and restart`, async () => {
  const f = await fixture(); const receipt = await settle(f.storage, f);
  await mutateImage(f.file, db => db.run('UPDATE native_work_execution_settlements SET state_json = ?', [JSON.stringify(corruption.change(receipt))]));
  const bytes = readFileSync(f.file);
  expect(() => f.storage.current(f.key)).toThrow(); expect(() => f.storage.currentByAttempt(f.key.attemptId)).toThrow();
  await expect(settle(f.storage, f)).rejects.toThrow(); await expect(open(f.file)).rejects.toThrow();
  expect(readFileSync(f.file)).toEqual(bytes);
});

for (const corruption of ['missing-table', 'missing-execution', 'misindexed-key', 'foreign-attempt'] as const) test(`a ${corruption} settlement cannot silently disappear from reconciliation`, async () => {
  const f = await fixture(); const receipt = await settle(f.storage, f);
  await mutateImage(f.file, db => {
    if (corruption === 'missing-table') db.run('DROP TABLE native_work_execution_settlements');
    else if (corruption === 'missing-execution') { db.run('DELETE FROM native_work_executions'); db.run('DELETE FROM native_work_execution_intents'); }
    else if (corruption === 'misindexed-key') {
      const keyHash = nativeSettlementDigest('unassociated-key');
      db.run('UPDATE native_work_execution_settlements SET key_hash = ?, state_json = ?', [keyHash, JSON.stringify({ ...receipt, keyHash })]);
    } else db.run('UPDATE native_work_execution_settlements SET state_json = ?', [JSON.stringify({ ...receipt, target: { ...receipt.target, attemptId: 'unassociated-attempt' } })]);
  });
  const bytes = readFileSync(f.file);
  expect(() => f.storage.current(f.key)).toThrow(); expect(() => f.storage.currentByAttempt(f.key.attemptId)).toThrow();
  await expect(open(f.file)).rejects.toThrow(); expect(readFileSync(f.file)).toEqual(bytes);
});

function pairedAuthority(tokens: PairingTokenManager, token: string) {
  const helper = new DaemonControlPlaneHelper({ pairingTokens: tokens, authToken: () => 'synthetic-shared', gatewayMethods: new GatewayMethodCatalog(), controlPlaneGateway: { touchWebSocketClient() {} }, userAuth: { validateSession: () => null, getUser: () => ({ username: 'owner', roles: ['admin'] }) } } as unknown as DaemonControlPlaneContext);
  return helper.createNativeExecutionAuthority(token)!;
}
function deferred() {
  let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve };
}

test('independent paired hosts fail closed on owner contention and explicitly reconcile the winner without new effects', async () => {
  const root = makeRepo(); mkdirSync(join(root, '.goodvibes'), { recursive: true });
  const tokenFile = join(root, '.goodvibes', 'pairing.json'); const tokens = new PairingTokenManager(tokenFile); const token = tokens.mint({ name: 'Owned concurrency fixture' });
  const authority = pairedAuthority(tokens, token.token);
  const f = await fixture({ root, actorId: authority.current()!.principalId, associate: false });
  const registrations = { path: join(root, '.goodvibes', 'registrations.json'), homeDir: join(root, 'home'), daemonStateDir: join(root, '.goodvibes', 'daemon') };
  const scopes = new WorkspaceRegistrationStore(registrations); await scopes.add(root);
  const log = new SqliteDecisionLog(join(root, '.goodvibes', 'decisions.sqlite'));
  const gate = deferred(); const ready = deferred(); const entered = new Set<string>(); let semanticCalls = 0;
  const portFor = (id: string): JudgmentPort => {
    const port = withDecisionLog(runnerPort().port, log);
    return { ...port, async ask(request) {
      semanticCalls++;
      if (request.context?.site === 'contract.check.unit-judge') { entered.add(id); if (entered.size === 2) ready.resolve(); await gate.promise; }
      return port.ask(request);
    } };
  };
  const options = { projectId: 'project', projectRoot: root, sessionId: 'native-concurrent-fixture', storage: f.storage, scopes, port: portFor('first'), decisionLog: log, verification: { settings: () => checkSettings(CONTRACT_CONFIG_DEFAULTS), readAccessFilter: async () => true, automatic: false } };
  const host = createNativeWorkExecutionHost(options);
  const plan = oneUnitPlan(2); plan.goal = f.work.goal; plan.criteria = f.work.criteria.map((text, index) => ({ id: `c${index + 1}`, text, quote: text }));
  plan.groups[0]!.units[0]!.criteria = f.work.criteria.map((_text, index) => ({ id: `u1.c${index + 1}`, text: `Original criterion ${index + 1}`, serves: [`c${index + 1}`] }));
  const harness = makeHarness({ root, plan, scripts: { u1: finishes('Complete concurrent native result') }, decisionLog: log, nativeDecisions: host.nativeOwner.decisions, durableAdmission: host.nativeOwner.admission });
  host.attachRunner(harness.runner);
  cleanups.push(async () => { gate.resolve(); await host.close(); harness.dispose(); await Promise.all(harness.runner.list({ includeTerminal: true }).map(contract => harness.runner.join(contract.id))); log[Symbol.dispose](); });
  const started = await host.start(f.target, authority);
  await waitFor(() => ['passed', 'failed', 'cancelled'].includes(harness.runner.get(started.admission.contractId)?.status ?? ''), 'concurrent native contract completion', 15000);
  await harness.runner.join(started.admission.contractId); expect(harness.runner.get(started.admission.contractId)?.status).toBe('passed');
  const other = await open(f.file); const otherAuthority = pairedAuthority(new PairingTokenManager(tokenFile), token.token);
  const second = createNativeWorkExecutionHost({ ...options, storage: other.storage, scopes: new WorkspaceRegistrationStore(registrations), port: portFor('second') });
  let forbiddenEffects = 0;
  second.attachRunner({ ...harness.runner, startDurable: async () => { forbiddenEffects++; throw new Error('Settlement cannot start work'); }, resumeDurable: async () => { forbiddenEffects++; throw new Error('Settlement cannot resume work'); } });
  cleanups.push(() => second.close());
  const one = host.settle(f.key, authority); const two = second.settle(f.key, otherAuthority);
  try {
    await Promise.race([ready.promise, Promise.all([one, two]).then(() => { throw new Error('Both hosts must enter terminal verification before publication'); })]);
    expect(f.storage.current(f.key).ledger.revision).toBe(2); expect(entered.size).toBe(2);
  } finally { gate.resolve(); }
  const outcomes = await Promise.allSettled([one, two]);
  const successful = outcomes.filter(outcome => outcome.status === 'fulfilled');
  const busy = outcomes.filter(outcome => outcome.status === 'rejected');
  expect(successful).toHaveLength(1); expect(busy).toHaveLength(1);
  // pairing-native-authority.test.ts explicitly requires synchronous ownership contention to fail closed.
  // Settlement recovery must respect that boundary instead of inventing a pairing-lock retry loop.
  expect(busy[0]!.reason).toMatchObject({ code: 'PAIRING_TOKEN_STORE_BUSY' });
  const receipt = successful[0]!.value; await assertImage(f.file, 4, 1);
  const beforeRetry = semanticCalls; const bytes = readFileSync(f.file);
  const retried = outcomes[0]!.status === 'rejected' ? await host.settle(f.key, authority) : await second.settle(f.key, otherAuthority);
  expect(retried).toEqual(receipt); expect(semanticCalls).toBe(beforeRetry); expect(readFileSync(f.file)).toEqual(bytes);
  expect(forbiddenEffects).toBe(0); expect(harness.agentsOf('u1')).toHaveLength(1);
  expect(other.storage.current(f.key).settlement).toEqual(receipt); await assertImage(f.file, 4, 1);
});

test('valid pre-intent native records retain settlement support without inventing an intent', async () => {
  const f = await fixture(); await f.store.close();
  // Schema3 native records predate the intent table. Its migration intentionally
  // preserves their exact nine-field record and leaves their intent absent.
  await mutateImage(f.file, db => { db.run('DELETE FROM native_work_execution_intents'); db.run('DROP TABLE native_work_execution_settlements'); db.run('DROP TABLE native_work_questions'); db.run('PRAGMA user_version = 5'); });
  const reopened = await open(f.file); expect(reopened.storage.current(f.key).intent).toBeNull();
  const receipt = await settle(reopened.storage, f); expect(receipt.attestation.outcome).toBe('verified');
  expect(reopened.storage.current(f.key).intent).toBeNull(); await assertImage(f.file, 4, 1);
});

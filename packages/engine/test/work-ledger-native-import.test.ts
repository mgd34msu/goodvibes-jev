/** No live endpoint: real ledger, paired-token owner, registration and decision recorder. */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSystemOnePort, PINNED_MODEL, SqliteDecisionLog, withDecisionLog, type JudgmentPort, type JudgmentRequest, type Questions } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { createNativeLegacyImportHost, legacyImportSemanticManifest, NATIVE_IMPORT_SITE } from '../sdk/src/platform/workflow/work-ledger/native-import.js';
import { WorkLedgerAccessError } from '../sdk/src/platform/workflow/work-ledger/types.js';
import { createWorkLedger } from '../sdk/src/platform/workflow/work-ledger/service.js';
import { prepareLegacyWorkLedgerMigration } from '../sdk/src/platform/workflow/work-ledger/legacy-import.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { knowledgeSourceSnapshotFromRows } from '../sdk/src/platform/knowledge/store-source-generation.js';
import { PairingTokenManager } from '../sdk/src/platform/pairing/pairing-token-store.js';
import { WorkspaceRegistrationStore } from '../sdk/src/platform/workspace/registration/store.js';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../sdk/src/platform/daemon/control-plane.js';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.js';
import { acquireCrossProcessLock } from '../sdk/src/platform/workspace/checkpoint/cross-process-lock.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function fixture(options: { decorate?: (port: JudgmentPort) => JudgmentPort; choice?: () => string; unrecorded?: boolean; sourceMetadata?: Record<string, unknown> } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'native-import-')), file = join(root, 'knowledge.sqlite');
  const store = new KnowledgeStore({ dbPath: file });
  const source = { id: 'source', connectorId: 'goodvibes-project-planning', sourceType: 'dataset' as const, status: 'indexed' as const, metadata: {
    ...options.sourceMetadata, projectPlanning: true, projectId: 'project', knowledgeSpaceId: 'space', planningArtifactKind: 'state', planningArtifactId: 'plan',
    value: { id: 'plan', projectId: 'project', knowledgeSpaceId: 'space', openQuestions: [], answeredQuestions: [], decisions: [], dependencies: [], tasks: [{ id: 'legacy', title: 'Historical requirement', status: 'completed', executionApproved: true }] },
  } };
  await store.upsertSource(source);
  const storage = await store.openWorkLedgerStorage('project');
  let id = 0;
  const ledger = createWorkLedger({ projectId: 'project', importHostId: 'host', storage, clock: { now: () => 10, newId: kind => `${kind}-${++id}` } });
  const tokens = new PairingTokenManager(join(root, 'pairing.json')), paired = tokens.mint({ name: 'Synthetic import test' });
  const helper = new DaemonControlPlaneHelper({ pairingTokens: tokens, gatewayMethods: new GatewayMethodCatalog(), authToken: () => 'synthetic-shared' } as unknown as DaemonControlPlaneContext);
  const authority = helper.createNativeExecutionAuthority(paired.token, ['write:work-ledger-import', 'read:knowledge'])!;
  const scopes = new WorkspaceRegistrationStore({ path: join(root, 'registrations.json'), homeDir: join(root, 'home'), daemonStateDir: join(root, 'daemon') });
  await scopes.add(root);
  const log = new SqliteDecisionLog(join(root, 'decisions.sqlite'));
  const fake = fakePort((_name, question) => choiceAnswer(question, options.choice?.() ?? 'act', 0.99));
  const recorded = options.unrecorded ? fake.port : withDecisionLog(fake.port, log);
  let reads = 0;
  const deps = { hostId: 'host', projectId: 'project', projectRoot: root, storeId: file, ...ledger, scopes, port: options.decorate?.(recorded) ?? recorded, decisionLog: log,
    readSource: (id: string) => { reads++; return store.getSourceSnapshot({ id }); } };
  const host = createNativeLegacyImportHost(deps);
  const current = store.getSourceSnapshot({ id: 'source' }); if (current.generation === null) throw new Error('Missing fixture source');
  const preparation = prepareLegacyWorkLedgerMigration({ hostId: 'host', projectId: 'project', expectedLedgerRevision: 0, pendingLocalChanges: false, occupiedWorkIds: [], sources: [{ source: current.source, generation: current.generation }] });
  if (preparation.kind !== 'prepared') throw new Error('Fixture import preparation failed');
  const command = { type: 'import_legacy' as const, requestId: 'request', expectedRevision: 0, manifest: preparation.manifest };
  const actor = ledger.authority.issueActor({ projectId: 'project', actorId: 'test-observer', role: 'coordinator' });
  cleanups.push(async () => { await host.close(); await ledger.service.close(); await store.close(); log[Symbol.dispose](); rmSync(root, { recursive: true, force: true }); });
  return { root, file, store, source, ledger, actor, tokens, paired, helper, authority, scopes, log, fake, deps, host, command, get reads() { return reads; }, run: (signal?: AbortSignal) => host.run(command, authority, { isAuthorized: () => true, signal }) };
}

test('dedicated import scopes commit once from actual recorded lineage; completed legacy work stays unverified and unclaimed', async () => {
  const f = await fixture(); const source = f.store.getSourceSnapshot({ id: 'source' });
  expect(Object.keys(source)).toContain('raw'); expect(source.raw).not.toBeNull();
  expect(f.authority.current()!.scopes).not.toContain('write:fleet');
  expect(await f.run()).toMatchObject({ kind: 'accepted', replayed: false });
  const snapshot = await f.ledger.service.readSnapshot(f.actor);
  expect(snapshot).toMatchObject({ revision: 1, works: [{ attempt: null, verification: { state: 'unverified' }, work: { reportedState: 'complete' } }] });
  expect(f.store.getSourceSnapshot({ id: 'source' })).toEqual(source);
  const records = f.log.query({ site: NATIVE_IMPORT_SITE }); expect(records).toHaveLength(1);
  const record = records[0]; if (!record || record.status !== 'answered') throw new Error('Expected recorded answer');
  expect(record.notes).toContainEqual(expect.objectContaining({ kind: 'action', action: expect.stringContaining('autonomous:claim:') }));
  const state = f.fake.requests[0]!.state as { binding: Record<string, string> };
  for (const key of ['actionId', 'actionRevision', 'authorityId', 'authorityRevision', 'scopeId', 'scopeRevision']) expect(state.binding[key]).toMatch(/^[a-f0-9]{64}$/);
  const manifest = (f.fake.requests[0]!.state as unknown as { input: { manifest: { sources: object[] } } }).input.manifest;
  expect(Object.keys(manifest.sources[0]!).sort()).toEqual(['digest', 'generation', 'source']);
});

test('fresh refusal has no ledger effects; explicit same-command reconsideration performs a new recorded read', async () => {
  let choice = 'reject'; const f = await fixture({ choice: () => choice }); const before = readFileSync(f.file);
  const refused = await f.run(); expect(refused).toMatchObject({ kind: 'decision', decision: { outcome: 'reject', judgmentDecisionIds: [expect.any(String)] } });
  expect(readFileSync(f.file)).toEqual(before); choice = 'act';
  expect(await f.run()).toMatchObject({ kind: 'accepted', replayed: false }); expect(f.fake.requests).toHaveLength(2);
});

test('recreated host exact durable replay precedes new Jev, current sources, current ledger revision and changed host ID', async () => {
  const f = await fixture(); const first = await f.run(); expect(first.kind).toBe('accepted');
  await f.store.upsertSource({ ...f.source, metadata: { ...f.source.metadata, changedAfterCommit: true } });
  await f.ledger.service.execute({ type: 'create', requestId: 'other', expectedRevision: 1, title: 'Later', goal: 'Later native work', criteria: ['Another revision'] }, f.actor);
  const reads = f.reads;
  const replacement = createNativeLegacyImportHost({ ...f.deps, hostId: 'restarted-host', readSource: () => { throw new Error('Replay reread sources'); }, port: { ...f.deps.port, ask: async () => { throw new Error('Replay reread Jev'); } } });
  try {
    const controller = new AbortController(); controller.abort();
    expect(await replacement.run(f.command, f.authority, { isAuthorized: () => true, signal: controller.signal })).toMatchObject({ ...first, replayed: true });
    expect(f.reads).toBe(reads);
    expect(await replacement.run({ ...f.command, expectedRevision: 2 }, f.authority, { isAuthorized: () => true })).toMatchObject({ kind: 'rejected', code: 'request_conflict' });
    expect(f.fake.requests).toHaveLength(1);
  } finally { await replacement.close(); }
});

test('simultaneous exact deliveries share one fresh reading while a changed command cannot take over', async () => {
  const entered = gate(), release = gate();
  const f = await fixture({ decorate: port => ({ ...port, ask: async request => { entered.release(); await release.promise; return port.ask(request); } }) });
  const first = f.run(); await Promise.race([entered.promise, first.then(() => { throw new Error('Import settled before Jev entry'); })]);
  const second = f.run(); expect(second).toBe(first);
  expect(await f.host.run({ ...f.command, expectedRevision: 1 }, f.authority, { isAuthorized: () => true })).toMatchObject({ kind: 'rejected', code: 'request_conflict' });
  release.release(); expect(await first).toMatchObject({ kind: 'accepted' }); expect(await second).toEqual(await first); expect(f.fake.requests).toHaveLength(1);
});

test.each(['revoke', 'scope', 'source', 'revision', 'abort', 'close'] as const)('%s during Jev cannot publish the old admission', async change => {
  const entered = gate(), release = gate(); const controller = new AbortController();
  const f = await fixture({ decorate: port => ({ ...port, ask: async request => { entered.release(); await release.promise; return port.ask(request); } }) });
  const pending = f.run(controller.signal); const outcome = pending.then(value => value, () => null); await Promise.race([entered.promise, pending.then(() => { throw new Error('Import settled before Jev entry'); })]);
  let closing: Promise<void> | undefined;
  if (change === 'revoke') f.tokens.revoke(f.paired.id);
  if (change === 'scope') await f.scopes.remove(f.root);
  if (change === 'source') await f.store.upsertSource({ ...f.source, metadata: { ...f.source.metadata, changed: true } });
  if (change === 'revision') await f.ledger.service.execute({ type: 'create', requestId: 'other', expectedRevision: 0, title: 'Other', goal: 'Other', criteria: ['Other'] }, f.actor);
  if (change === 'abort') controller.abort();
  if (change === 'close') closing = f.host.close();
  release.release(); const result = await outcome; await closing;
  expect(result?.kind).not.toBe('accepted');
  if (change !== 'scope') expect(result).toMatchObject({ kind: 'rejected', code: { revoke: 'forbidden', source: 'stale_source', revision: 'conflict', abort: 'cancelled', close: 'closed' }[change] });
  expect((await f.ledger.service.history(0, f.actor)).filter(event => event.type === 'import_legacy')).toHaveLength(0);
});

test('unrecorded or detached log lineage cannot authorize native writes', async () => {
  const f = await fixture({ unrecorded: true }); await expect(f.run()).rejects.toMatchObject({ kind: 'unrecorded' }); expect(f.fake.requests).toHaveLength(0);
  using emptyLog = new SqliteDecisionLog(':memory:');
  const recorded = await fixture(); const detached = createNativeLegacyImportHost({ ...recorded.deps, decisionLog: emptyLog });
  try { await expect(detached.run(recorded.command, recorded.authority, { isAuthorized: () => true })).rejects.toMatchObject({ kind: 'unrecorded' });
    expect((await recorded.ledger.service.readSnapshot(recorded.actor)).revision).toBe(0);
  } finally { await detached.close(); }
});

test('final native transaction rechecks recorded lineage after storage waits', async () => {
  const f = await fixture(); let lookups = 0;
  const replacement = createNativeLegacyImportHost({ ...f.deps, decisionLog: { get: id => ++lookups > 1 ? undefined : f.log.get(id) } });
  const unlock = await acquireCrossProcessLock(`${f.file}.knowledge-lock`, { strictOwnership: true });
  const pending = replacement.run(f.command, f.authority, { isAuthorized: () => true });
  while (lookups === 0) await Promise.race([new Promise(resolve => setTimeout(resolve, 1)), pending.then(() => { throw new Error('Import settled before log inspection'); })]);
  await unlock();
  try { expect(await pending).toMatchObject({ kind: 'rejected', code: 'forbidden' }); expect((await f.ledger.service.readSnapshot(f.actor)).revision).toBe(0); }
  finally { await replacement.close(); }
});

test('shared transport retries remain one logical recorded decision and recover without an owner reply', async () => {
  let attempts = 0;
  const owner = await fixture();
  const transport = createSystemOnePort({ endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:1', apiKey: 'synthetic-fixture' }, model: PINNED_MODEL, timeoutMs: 1_000,
    retry: { backoffInitialMs: 1, backoffMaxMs: 1, backoffJitter: 0 }, fetch: async (_url, init) => {
      if (++attempts === 1) return new Response('', { status: 503 });
      const request = JSON.parse(String(init?.body)) as JudgmentRequest<Questions>;
      return Response.json({ model: PINNED_MODEL, answers: { disposition: choiceAnswer(request.questions.disposition!, 'act', 0.99) }, usage: { input_tokens: 1, output_tokens: 1 } });
    } });
  const host = createNativeLegacyImportHost({ ...owner.deps, port: withDecisionLog(transport, owner.log) });
  try { expect(await host.run(owner.command, owner.authority, { isAuthorized: () => true })).toMatchObject({ kind: 'accepted' });
    expect(attempts).toBe(2); const records = owner.log.query({ site: NATIVE_IMPORT_SITE }); expect(records).toHaveLength(1); expect(records[0]!.lineage?.attempts).toHaveLength(2);
  } finally { await host.close(); }
});

test('durable ledger replay survives reconstruction of store, service, token manager and host with no new decision', async () => {
  const f = await fixture(); const accepted = await f.run(); expect(accepted.kind).toBe('accepted');
  await f.host.close(); await f.ledger.service.close(); await f.store.close();
  const store = new KnowledgeStore({ dbPath: f.file }); const storage = await store.openWorkLedgerStorage('project');
  const ledger = createWorkLedger({ projectId: 'project', importHostId: 'new-host', storage, clock: { now: () => 20, newId: () => { throw new Error('Replay created native identity'); } } });
  const tokens = new PairingTokenManager(join(f.root, 'pairing.json'));
  const helper = new DaemonControlPlaneHelper({ pairingTokens: tokens, gatewayMethods: new GatewayMethodCatalog() } as unknown as DaemonControlPlaneContext);
  const authority = helper.createNativeExecutionAuthority(f.paired.token, ['write:work-ledger-import', 'read:knowledge'])!;
  const host = createNativeLegacyImportHost({ ...f.deps, ...ledger, hostId: 'new-host', readSource: () => { throw new Error('Replay touched source'); }, port: { ...f.deps.port, ask: async () => { throw new Error('Replay evaluated'); } } });
  try { expect(await host.run(f.command, authority, { isAuthorized: () => true })).toMatchObject({ ...accepted, replayed: true }); }
  finally { await host.close(); await ledger.service.close(); await store.close(); }
});

test('ambiguous committed publication recovers the exact request without another evaluation or mutation', async () => {
  const f = await fixture(); const storage = await f.store.openWorkLedgerStorage('project'); let lost = false;
  const ledger = createWorkLedger({ projectId: 'project', importHostId: 'host', storage: { ...storage, async transaction(decide) {
    const value = await storage.transaction(decide); if (!lost) { lost = true; throw new Error('Synthetic lost acknowledgment after commit'); } return value;
  } }, clock: { now: () => 10, newId: () => { throw new Error('Import must preserve IDs'); } } });
  const host = createNativeLegacyImportHost({ ...f.deps, ...ledger });
  try {
    expect(await host.run(f.command, f.authority, { isAuthorized: () => true })).toMatchObject({ kind: 'indeterminate', requestId: f.command.requestId });
    expect(await host.run(f.command, f.authority, { isAuthorized: () => true })).toMatchObject({ kind: 'accepted', replayed: true });
    expect(f.fake.requests).toHaveLength(1); expect((await f.ledger.service.readSnapshot(f.actor)).revision).toBe(1);
  } finally { await host.close(); await ledger.service.close(); await storage.close(); }
});


test('host timestamp projection preserves fractional and out-of-Date-range numbers without changing source content', async () => {
  const f = await fixture();
  for (const value of [1.125, -1.125, 8.64e15 + 1, Number.MAX_VALUE, 1791290000000]) {
    const source = { ...f.command.manifest.sources[0]!.source, createdAt: value, updatedAt: value, metadata: { nestedCreatedAt: value, text: 'Unchanged original metadata' } };
    const manifest = { ...f.command.manifest, sources: [{ ...f.command.manifest.sources[0]!, source }] };
    const projected = legacyImportSemanticManifest(manifest);
    expect(Number(projected.sources[0]!.source.createdAt.decimal.replaceAll('_', ''))).toBe(value);
    expect(Number(projected.sources[0]!.source.updatedAt.decimal.replaceAll('_', ''))).toBe(value);
    const projectedSource: Readonly<Record<string, unknown>> = projected.sources[0]!.source;
    expect(projectedSource['metadata']).toEqual(source.metadata);
    expect(projected.entities).toEqual(manifest.entities); expect(projected.links).toEqual(manifest.links);
  }
});


test('protocol projection does not hide sensitive source payloads or metadata fields named like timestamps', async () => {
  const f = await fixture({ sourceMetadata: { original: { createdAt: 4111111111111111 } } }); const bytes = readFileSync(f.file);
  await expect(f.run()).rejects.toMatchObject({ problem: 'card-material' });
  expect(f.fake.requests).toHaveLength(0); expect(readFileSync(f.file)).toEqual(bytes);
});


test('known stale source before evaluation is a deterministic rejection, with no new reading or ledger write', async () => {
  const f = await fixture();
  await f.store.upsertSource({ ...f.source, metadata: { ...f.source.metadata, changedBeforeDispatch: true } });
  const bytes = readFileSync(f.file);
  expect(await f.run()).toMatchObject({ kind: 'rejected', code: 'stale_source' });
  expect(f.fake.requests).toHaveLength(0); expect(readFileSync(f.file)).toEqual(bytes);
});

test('a deterministic-looking scope error plus abort after execute starts never turns a committed import into rejection', async () => {
  const f = await fixture(); const controller = new AbortController();
  const host = createNativeLegacyImportHost({ ...f.deps, scopes: { currentScope: root => f.scopes.currentScope(root),
    async withCurrentScope(expected, callback) {
      const value = await f.scopes.withCurrentScope(expected, callback);
      controller.abort();
      throw new WorkLedgerAccessError('closed', `Synthetic lost post-execute scope acknowledgment: ${typeof value}`);
    },
  } });
  try {
    await expect(host.run(f.command, f.authority, { isAuthorized: () => true, signal: controller.signal })).rejects.toMatchObject({ code: 'closed' });
    expect((await f.ledger.service.readSnapshot(f.actor)).revision).toBe(1);
    expect(await host.run(f.command, f.authority, { isAuthorized: () => true })).toMatchObject({ kind: 'accepted', replayed: true });
    expect(f.fake.requests).toHaveLength(1);
  } finally { await host.close(); }
});

test('an unrelated operational failure is not relabeled cancellation merely because a signal was also aborted', async () => {
  const controller = new AbortController();
  const f = await fixture({ decorate: port => ({ ...port, async ask() { controller.abort(); throw new Error('Synthetic unrelated recorder failure'); } }) });
  await expect(f.run(controller.signal)).rejects.toThrow('Synthetic unrelated recorder failure');
  expect((await f.ledger.service.readSnapshot(f.actor)).revision).toBe(0);
});


test('raw-only SQL JSON changes invalidate native admission even when the mapped source is identical', async () => {
  const f = await fixture(); const current = f.store.getSourceSnapshot({ id: 'source' });
  if (!current.raw || typeof current.raw.metadata !== 'string') throw new Error('Missing raw source metadata');
  const raw = { ...current.raw, metadata: ` ${current.raw.metadata}` };
  const changed = knowledgeSourceSnapshotFromRows([{ columns: Object.keys(raw), values: [Object.values(raw)] }]);
  expect(changed.source).toEqual(current.source); expect(changed.generation).not.toBe(current.generation);
  const host = createNativeLegacyImportHost({ ...f.deps, readSource: () => changed });
  const bytes = readFileSync(f.file);
  try {
    expect(await host.run(f.command, f.authority, { isAuthorized: () => true })).toMatchObject({ kind: 'rejected', code: 'stale_source' });
    expect(f.fake.requests).toHaveLength(0); expect(readFileSync(f.file)).toEqual(bytes);
  } finally { await host.close(); }
});

test.each(['missing', 'malformed', 'identity', 'content'] as const)('%s fresh source cannot use an unchanged generation to pass native admission', async change => {
  const f = await fixture(); const current = f.store.getSourceSnapshot({ id: 'source' });
  if (!current.source) throw new Error('Missing fixture source');
  const source = change === 'missing' ? null : { ...current.source,
    ...(change === 'malformed' ? { metadata: null } : {}),
    ...(change === 'identity' ? { id: 'different-source' } : {}),
    ...(change === 'content' ? { description: 'Changed complete source image' } : {}),
  };
  const host = createNativeLegacyImportHost({ ...f.deps, readSource: () => ({ ...current, source }) });
  const bytes = readFileSync(f.file);
  try {
    expect(await host.run(f.command, f.authority, { isAuthorized: () => true })).toMatchObject({ kind: 'rejected', code: 'stale_source' });
    expect(f.fake.requests).toHaveLength(0); expect(readFileSync(f.file)).toEqual(bytes);
  } finally { await host.close(); }
});

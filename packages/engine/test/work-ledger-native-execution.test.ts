import { createNativeWorkSubmissionHost } from '../sdk/src/platform/workflow/work-ledger/native-submission.js';
import { registerNativeWorkSubmissionGatewayMethods } from '../sdk/src/platform/control-plane/routes/native-work-submission.js';
import * as nativeFs from 'node:fs';
import type { SQLitePublicationIO } from '../sdk/src/platform/state/sqlite-store-persistence.js';
/** Real paired authority, workspace scope and KnowledgeStore bridge into the real durable runner. */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SQLiteStore } from '../sdk/src/platform/state/sqlite-store.js';
import { SqliteDecisionLog, withDecisionLog, createSystemOnePort, PINNED_MODEL, type JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { createWorkLedger } from '../sdk/src/platform/workflow/work-ledger/service.js';
import { createNativeWorkExecutionHost } from '../sdk/src/platform/workflow/work-ledger/native-execution.js';
import { criteriaSetIdForWork } from '../sdk/src/platform/contract/durable-admission.js';
import { getContractInputAuthority, authorizeContractInputPath } from '../sdk/src/platform/contract/input-authority.js';
import { PairingTokenManager } from '../sdk/src/platform/pairing/pairing-token-store.js';
import { WorkspaceRegistrationStore } from '../sdk/src/platform/workspace/registration/store.js';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../sdk/src/platform/daemon/control-plane.js';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.js';
import { registerNativeWorkExecutionGatewayMethods } from '../sdk/src/platform/control-plane/routes/native-work-execution.js';
import { registerWorkLedgerGatewayMethods } from '../sdk/src/platform/control-plane/routes/work-ledger.js';
import { createLocalWorkLedgerReadBinding } from '../sdk/src/platform/workflow/work-ledger/read-client.js';
import { createOperatorNativeWorkExecutionClient, getOperatorWorkLedgerProject } from '../sdk/src/platform/workflow/work-ledger/native-execution-client.js';
import { createOperatorSdk } from '../operator-sdk/src/client.js';
import { dispatchGatewayRestRoutes } from '../daemon-sdk/src/gateway-rest-routes.js';
import { makeRepo, makeHarness, oneUnitPlan, waitFor, type Harness, type HarnessOptions } from './contract/runner-support.js';
import { finishes } from './contract/steps-support.js';
import { plannerOutput } from './contract/plan-support.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(options: { harness?: Partial<HarnessOptions>; decoratePort?: (port: JudgmentPort) => JudgmentPort; register?: boolean } = {}) {
  const root = makeRepo(); mkdirSync(join(root, '.goodvibes'), { recursive: true });
  const tokens = new PairingTokenManager(join(root, '.goodvibes', 'pairing.json'));
  const paired = tokens.mint({ name: 'Owned synthetic test device' });
  const catalog = new GatewayMethodCatalog();
  const helper = new DaemonControlPlaneHelper({ pairingTokens: tokens, authToken: () => 'synthetic-shared', gatewayMethods: catalog, controlPlaneGateway: { touchWebSocketClient() {} },
    userAuth: { validateSession: (value: string) => value === 'synthetic-user-session' ? { username: 'owner' } : null, getUser: () => ({ username: 'owner', roles: ['admin'] }) } } as unknown as DaemonControlPlaneContext);
  const authority = helper.createNativeExecutionAuthority(paired.token)!;
  const scopes = new WorkspaceRegistrationStore({ path: join(root, '.goodvibes', 'registrations.json'), homeDir: join(root, 'home'), daemonStateDir: join(root, '.goodvibes', 'daemon') });
  if (options.register !== false) await scopes.add(root);
  const store = new KnowledgeStore({ dbPath: join(root, '.goodvibes', 'knowledge.sqlite') });
  const ledgerStorage = await store.openWorkLedgerStorage('project');
  let id = 0;
  const ledger = createWorkLedger({ projectId: 'project', storage: ledgerStorage, clock: { now: () => 100, newId: kind => `${kind}-${++id}` } });
  const actor = ledger.authority.issueActor({ projectId: 'project', actorId: authority.current()!.principalId, role: 'coordinator' });
  const created = await ledger.service.execute({ type: 'create', requestId: 'create', expectedRevision: 0, title: 'Small display label', goal: 'Preserve the complete goal.\nKeep all original requirements ☃.', criteria: ['Keep the exact parser behavior.', 'Keep the ordered second requirement.'] }, actor);
  if (created.kind !== 'accepted' || created.event.type === 'import_legacy') throw new Error('fixture create failed');
  const claimed = await ledger.service.execute({ type: 'claim', requestId: 'claim', expectedRevision: 1, workId: created.event.workId }, actor);
  if (claimed.kind !== 'accepted' || claimed.event.type === 'import_legacy') throw new Error('fixture claim failed');
  const work = claimed.event.work; const attempt = claimed.event.attempts[0]!;
  const target = { workId: work.id, workRevision: work.revision, criteriaRevision: work.criteriaRevision, attemptId: attempt.id, attemptRevision: attempt.revision };
  const key = { workId: work.id, criteriaId: criteriaSetIdForWork(work.id), criteriaRevision: String(work.criteriaRevision), attemptId: attempt.id };
  const log = new SqliteDecisionLog(join(root, '.goodvibes', 'decisions.sqlite'));
  const fake = fakePort((_name, question) => choiceAnswer(question, 'act', 0.99));
  const port = options.decoratePort?.(withDecisionLog(fake.port, log)) ?? withDecisionLog(fake.port, log);
  const storage = await store.openNativeWorkExecutionStorage('project');
  const hostOptions = { projectId: 'project', projectRoot: root, sessionId: 'native-fixture', storage, scopes, port, decisionLog: log };
  const host = createNativeWorkExecutionHost(hostOptions);
  const plan = oneUnitPlan(2); plan.goal = work.goal; plan.criteria = work.criteria.map((text, index) => ({ id: `c${index + 1}`, text, quote: text }));
  plan.groups[0]!.units[0]!.criteria = work.criteria.map((_text, index) => ({ id: `u1.c${index + 1}`, text: `Original requirement ${index + 1} holds`, serves: [`c${index + 1}`] }));
  const harness = makeHarness({ root, plan, scripts: { u1: finishes('complete native result') }, decisionLog: log,
    nativeDecisions: host.nativeOwner.decisions, durableAdmission: host.nativeOwner.admission, ...options.harness });
  host.attachRunner(harness.runner);
  cleanups.push(async () => { await host.close(); harness.dispose(); await Promise.all(harness.runner.list({ includeTerminal: true }).map(item => harness.runner.join(item.id))); await ledger.service.close(); await store.close(); log[Symbol.dispose](); rmSync(root, { recursive: true, force: true }); });
  return { root, tokens, paired, catalog, helper, authority, scopes, store, ledger, actor, work, target, key, log, storage, host, hostOptions, harness, plan };
}
async function completed(harness: Harness, id: string) {
  await waitFor(() => ['passed', 'failed', 'cancelled'].includes(harness.runner.get(id)?.status ?? ''), 'native bridge completion', 15000);
  await harness.runner.join(id); return harness.runner.get(id)!;
}

test('actual bridge commits association before launch, preserves source and exact delivery replay', async () => {
  const f = await fixture();
  const started = await f.host.start(f.target, f.authority);
  const record = f.storage.current(f.key).record!;
  expect(record.state).toBe('launch-claimed'); expect(record.receipt?.contractId).toBe(started.admission.contractId);
  expect(record.request.input.nativeSource).toMatchObject({ goal: f.work.goal, criteria: f.work.criteria });
  expect(record.request.input.ask).toBe('Small display label');
  expect(record.decision.outcome).toBe('act');
  for (const field of ['authorityId', 'authorityRevision', 'scopeId', 'scopeRevision'] as const) expect(record.request.binding[field]).toMatch(/^[a-f0-9]{64}$/);
  expect(record.request.binding.authorityId).not.toContain(f.paired.id);
  for (const id of record.decision.judgmentDecisionIds) expect(f.log.get(id)?.status).toBe('answered');
  const result = await completed(f.harness, started.admission.contractId);
  expect(result.error).toBeUndefined(); expect(result.status).toBe('passed'); expect(result.escalations).toHaveLength(0);
  expect(result.goal).toBe(f.work.goal); expect(result.criteria.map(item => item.text)).toEqual(f.work.criteria);
  const replay = await f.host.start({ ...f.target }, f.authority);
  expect(replay.admission).toEqual(started.admission); expect(f.harness.agentsOf('u1')).toHaveLength(1);
  expect(f.log.query({ site: 'work-ledger.native-start' })).toHaveLength(1);
  expect(f.host.status(f.key, f.authority).execution.receipt).toEqual(started.admission);
  await expect(f.host.start({ ...f.target, workRevision: f.target.workRevision + 1 }, f.authority)).rejects.toMatchObject({ code: 'conflict' });
});

test('unmigrated scope and unsupported authority cause zero decisions and zero runner admissions', async () => {
  const f = await fixture({ register: false });
  writeFileSync(join(f.root, '.goodvibes', 'registrations.json'), JSON.stringify({ version: 1, workspaces: [{ root: f.root, registeredAt: '2026-10-04T00:00:00.000Z' }], declines: [] }));
  await expect(f.host.start(f.target, f.authority)).rejects.toThrow();
  expect(f.helper.createNativeExecutionAuthority('synthetic-shared')).toBeNull();
  expect(f.harness.runner.list({ includeTerminal: true })).toHaveLength(0); expect(f.log.query({ site: 'work-ledger.native-start' })).toHaveLength(0);
});

test('revocation while Jev is pending refuses before native association or runner creation', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture({ decoratePort: port => ({ ...port, async ask(request) { entered(); await gate; return port.ask(request); } }) });
  const pending = f.host.start(f.target, f.authority); await ready; f.tokens.revoke(f.paired.id); release();
  await expect(pending).rejects.toThrow(); expect(f.storage.current(f.key).record).toBeNull(); expect(f.harness.runner.list({ includeTerminal: true })).toHaveLength(0);
});

test('criteria revision during pending Jev cannot replace original work with generated requirements', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture({ decoratePort: port => ({ ...port, async ask(request) { entered(); await gate; return port.ask(request); } }) });
  const pending = f.host.start(f.target, f.authority); await ready;
  expect(await f.ledger.service.execute({ type: 'revise', requestId: 'revised', expectedRevision: 2, workId: f.work.id, title: f.work.title, goal: f.work.goal, criteria: [...f.work.criteria].reverse() }, f.actor)).toMatchObject({ kind: 'accepted' });
  release(); await expect(pending).rejects.toMatchObject({ code: 'stale' }); expect(f.storage.current(f.key).record).toBeNull(); expect(f.harness.runner.list()).toHaveLength(0);
});

test('cancel persists native cancellation and drains the actual running unit', async () => {
  const f = await fixture({ harness: { scripts: { u1: () => [{ text: 'waiting', stop: { kind: 'hang' } }] } } });
  const started = await f.host.start(f.target, f.authority);
  await waitFor(() => f.harness.agentsOf('u1').length === 1, 'native unit start');
  await f.host.cancel(f.key, f.authority, 'Owner cancelled native work');
  expect(f.storage.current(f.key).record?.state).toBe('cancelled'); expect(f.harness.runner.get(started.admission.contractId)?.status).toBe('cancelled');
  await expect(f.host.resume(f.key, f.authority)).rejects.toMatchObject({ code: 'stale' });
});

test('replacement native host inspects exact replay but refuses unreconciled launch-claimed resume', async () => {
  const f = await fixture({ harness: { scripts: { u1: () => [{ text: 'waiting', stop: { kind: 'hang' } }] } } });
  const started = await f.host.start(f.target, f.authority); await waitFor(() => f.harness.agentsOf('u1').length === 1, 'original unit start');
  const replacement = createNativeWorkExecutionHost(f.hostOptions); replacement.attachRunner(f.harness.runner);
  const replay = await replacement.start(f.target, f.authority); expect(replay.admission).toEqual(started.admission);
  await expect(replacement.resume(f.key, f.authority)).rejects.toMatchObject({ code: 'recovery-required' });
  expect(f.harness.agentsOf('u1')).toHaveLength(1); await replacement.close();
});

test('bridge preserves PR56 captured planner input and the original owner read filter', async () => {
  const original = '# original captured input\n'; let f!: Awaited<ReturnType<typeof fixture>>; let captured = false;
  const filter = async (path: string) => !path.endsWith('private.ts');
  f = await fixture({ harness: { contract: { isolation: 'worktree' }, readAccessFilter: filter,
    planner: { run: async invocation => {
      const authority = getContractInputAuthority(invocation); expect(authority).toBeDefined();
      const path = await authorizeContractInputPath(authority!, 'README.md', filter, invocation.signal);
      expect(readFileSync(path, 'utf8')).toBe(original); expect(invocation.workingDir).not.toBe(f.root);
      await expect(authorizeContractInputPath(authority!, 'private.ts', filter, invocation.signal)).rejects.toThrow('access-restricted');
      writeFileSync(join(f.root, 'README.md'), '# later owner input\n'); captured = true;
      return { status: 'completed', output: plannerOutput(f.plan), elapsedMs: 1 };
    } },
  } });
  writeFileSync(join(f.root, 'README.md'), original); writeFileSync(join(f.root, 'private.ts'), 'private fixture');
  const started = await f.host.start(f.target, f.authority); const result = await completed(f.harness, started.admission.contractId);
  expect(captured).toBe(true); expect(result.error).toBeUndefined(); expect(result.status).toBe('passed');
  expect(result.nativeSource?.criteria).toEqual(f.work.criteria); expect(readFileSync(join(f.root, 'README.md'), 'utf8')).toBe('# later owner input\n');
}, 30000);


test('concurrent exact delivery shares one native admission and detached input', async () => {
  const f = await fixture(); const borrowed = { ...f.target };
  const first = f.host.start(borrowed, f.authority);
  borrowed.workRevision += 1;
  const results = await Promise.all([first, ...Array.from({ length: 4 }, () => f.host.start(f.target, f.authority))]);
  expect(new Set(results.map(result => result.admission.contractId)).size).toBe(1);
  await completed(f.harness, results[0]!.admission.contractId);
  expect(f.harness.agentsOf('u1')).toHaveLength(1); expect(f.log.query({ site: 'work-ledger.native-start' })).toHaveLength(1);
});

test('real Jev refusal is distinct from unavailability and creates no execution association', async () => {
  const f = await fixture({ decoratePort: port => {
    const fake = fakePort((_name, question) => choiceAnswer(question, 'reject', 0.99));
    return { ...port, ask: request => withDecisionLog(fake.port, f.log).ask(request) };
  } });
  await expect(f.host.start(f.target, f.authority)).rejects.toMatchObject({ code: 'refused', decision: { outcome: 'reject' } });
  expect(f.storage.current(f.key).record).toBeNull(); expect(f.harness.runner.list()).toHaveLength(0);
});

test('queued engine acceptance still retains native runner IDs and is cancellable before launch', async () => {
  const f = await fixture({ harness: { contract: { maxActiveContracts: 0 } } });
  const result = await f.host.start(f.target, f.authority);
  expect(f.storage.current(f.key).record?.receipt?.contractId).toBe(result.admission.contractId);
  expect(f.storage.current(f.key).record?.state).toBe('prepared');
  await f.host.cancel(f.key, f.authority, 'Cancel queued native work');
  expect(f.harness.runner.get(result.admission.contractId)?.status).toBe('cancelled'); expect(f.harness.agentsOf('u1')).toHaveLength(0);
});


test('actual process restart explicitly resumes a prepared attempt with fresh recorded decision and the same runner IDs', async () => {
  const f = await fixture();
  writeFileSync(join(f.root, '.goodvibes', 'native-child-fixture.json'), JSON.stringify({ marker: 'owned-native-queued-child', token: f.paired.token, target: f.target }));
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./helpers/native-work-execution-child.ts', import.meta.url)), f.root], { encoding: 'utf8', timeout: 15000 });
  expect(child.status, child.stderr).toBe(0);
  const before = JSON.parse(child.stdout) as { contractId: string; ownerAgentId: string };
  expect(f.storage.current(f.key).record?.state).toBe('prepared');
  await f.harness.runner.resumeAll();
  expect(f.harness.agentsOf('u1')).toHaveLength(0);
  const resumed = await f.host.resume(f.key, f.authority);
  expect(resumed.admission.contractId).toBe(before.contractId); expect(resumed.admission.ownerAgentId).toBe(before.ownerAgentId);
  const result = await completed(f.harness, before.contractId); expect(result.status).toBe('passed');
  expect(f.log.query({ site: 'work-ledger.native-start' })).toHaveLength(2); expect(f.harness.agentsOf('u1')).toHaveLength(1);
}, 30000);

test('missing native acknowledgment cannot downgrade an engine launch claim into resumable prepared work', async () => {
  const f = await fixture({ harness: { scripts: { u1: () => [{ text: 'waiting', stop: { kind: 'hang' } }] } } });
  const original = await f.host.start(f.target, f.authority); await waitFor(() => f.harness.agentsOf('u1').length === 1, 'native effect boundary');
  const raw = new SQLiteStore(join(f.root, '.goodvibes', 'knowledge.sqlite'), { coordinated: true }); await raw.init(() => {}, { schemaVersion: 7 });
  raw.run('DELETE FROM native_work_executions'); raw.run('DELETE FROM native_work_execution_intents'); await raw.save(); raw.close();
  const replacement = createNativeWorkExecutionHost(f.hostOptions); replacement.attachRunner(f.harness.runner);
  const replay = await replacement.start(f.target, f.authority); expect(replay.admission).toEqual(original.admission);
  expect(f.storage.current(f.key).record?.state).toBe('launch-claimed');
  await expect(replacement.resume(f.key, f.authority)).rejects.toMatchObject({ code: 'recovery-required' });
  expect(f.harness.agentsOf('u1')).toHaveLength(1); await replacement.close();
});


for (const failure of ['before-publication', 'after-rename'] as const) {
  test(`native launch claim persistence failure ${failure} executes zero units`, async () => {
    const f = await fixture();
    const persistence = (f.store as unknown as { sqlite: { persistence: { io: SQLitePublicationIO } } }).sqlite.persistence;
    let fileSyncs = 0; let failed = false;
    persistence.io = { ...nativeFs, fsyncSync(fd) {
      const directory = nativeFs.fstatSync(fd).isDirectory(); if (!directory) fileSyncs++;
      if (!failed && fileSyncs === 3 && (failure === 'after-rename' ? directory : !directory)) {
        failed = true; throw new Error('Owned native admission persistence failure');
      }
      nativeFs.fsyncSync(fd);
    } };
    await expect(f.host.start(f.target, f.authority)).rejects.toThrow();
    persistence.io = nativeFs; expect(failed).toBe(true); expect(f.harness.agentsOf('u1')).toHaveLength(0);
    for (const contract of f.harness.runner.list({ includeTerminal: true })) { await f.harness.runner.join(contract.id); expect(contract.status).toBe('cancelled'); }
  });
}

function transport(f: Awaited<ReturnType<typeof fixture>>, acquire = async () => f.host) {
  let acquisitions = 0;
  registerNativeWorkExecutionGatewayMethods(f.catalog, { projectId: 'project', acquire: async () => { acquisitions++; return acquire(); } });
  const binding = createLocalWorkLedgerReadBinding({ available: true, projectId: 'project', actorId: 'host:transport-reader', service: f.ledger.service, authority: f.ledger.authority });
  if (!binding.available) throw new Error('Owned read binding unavailable');
  registerWorkLedgerGatewayMethods(f.catalog, binding.client);
  const requests: Request[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init); requests.push(request);
    return await dispatchGatewayRestRoutes(request, { async invokeGatewayRestVerb({ req, methodId }) {
      const token = req.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
      const principal = f.helper.describeAuthenticatedPrincipal(token);
      if (!principal) return Response.json({ error: 'Unauthorized' }, { status: 401 });
      const result = await f.helper.invokeGatewayMethodCall({ authToken: token, methodId,
        body: req.method === 'POST' ? await req.json() : undefined, query: Object.fromEntries(new URL(req.url).searchParams), signal: req.signal, context: principal });
      return Response.json(result.body, { status: result.status });
    } }) ?? Response.json({ error: 'Not found' }, { status: 404 });
  };
  const sdk = (token = f.paired.token) => createOperatorSdk({ baseUrl: 'http://127.0.0.1:1', authToken: token, fetch, retry: { maxAttempts: 1 } });
  const identity = { workId: f.target.workId, attemptId: f.target.attemptId, expectedRevision: { work: f.target.workRevision, criteria: f.target.criteriaRevision, attempt: f.target.attemptRevision } };
  return { sdk, identity, requests, get acquisitions() { return acquisitions; } };
}

test('production REST route discovers native project and performs paired start/status/replay/cancel with bounded projections', async () => {
  let unitEntered = false;
  const f = await fixture({ harness: { scripts: { u1: () => { unitEntered = true; return [{ text: 'waiting', stop: { kind: 'hang' } }]; } } } });
  const wire = transport(f); const sdk = wire.sdk();
  expect(await getOperatorWorkLedgerProject(sdk)).toBe('project'); expect(wire.acquisitions).toBe(0);
  const client = createOperatorNativeWorkExecutionClient(sdk, 'project');
  const started = await client.start(wire.identity); if (started.kind !== 'execution') throw new Error('Expected real execution');
  expect(started.receipt?.contractId).toBeTruthy(); expect(started.expectedRevision).toEqual(wire.identity.expectedRevision);
  await waitFor(() => unitEntered, 'wire native unit entered its cancellable effect');
  const replay = await createOperatorNativeWorkExecutionClient(wire.sdk(), 'project').start(wire.identity); if (replay.kind !== 'execution') throw new Error('Expected real replay');
  expect(replay.receipt).toEqual(started.receipt); expect(f.log.query({ site: 'work-ledger.native-start' })).toHaveLength(1);
  const status = await client.status(wire.identity); if (status.kind !== 'execution') throw new Error('Expected admitted status'); expect(status.progress?.units.total).toBe(1); expect(status.stale).toBe(false);
  const text = JSON.stringify(status); for (const forbidden of ['authorityId', 'authorityRevision', 'scopeId', 'decisionContext', 'nativeSource', 'projectRoot', f.paired.token, f.work.goal]) expect(text).not.toContain(forbidden);
  const cancelled = await client.cancel(wire.identity); if (cancelled.kind !== 'execution') throw new Error('Expected admitted cancellation'); expect(cancelled.state).toBe('cancelled'); expect(cancelled.progress?.status).toBe('cancelled');
  expect(f.harness.manager.getStatus(f.harness.agentsOf('u1')[0]!)?.status).not.toBe('running');
  expect(wire.requests.map(request => new URL(request.url).pathname)).toContain('/api/work-ledger/execution/cancel');
  client.dispose();
});

test('native wire rejects shared/user authority, scope loss, identity injection and wrong project before graph acquisition', async () => {
  const f = await fixture(); const wire = transport(f);
  for (const token of ['synthetic-shared', 'synthetic-user-session']) {
    await expect(createOperatorNativeWorkExecutionClient(wire.sdk(token), 'project').start(wire.identity)).rejects.toMatchObject({ status: 403 });
  }
  await expect(createOperatorNativeWorkExecutionClient(wire.sdk(), 'wrong-project').start(wire.identity)).rejects.toMatchObject({ status: 403 });
  await expect(wire.sdk().invoke('workLedger.execution.start', { projectId: 'project', ...wire.identity, source: { goal: 'injected' } })).rejects.toMatchObject({ status: 400 });
  const principal = f.helper.describeAuthenticatedPrincipal(f.paired.token)!;
  for (const scopes of [['read:work-ledger'], ['write:fleet'], ['read:events', 'read:fleet']]) {
    const refused = await f.helper.invokeGatewayMethodCall({ authToken: f.paired.token, methodId: 'workLedger.execution.start', body: { projectId: 'project', ...wire.identity }, context: { ...principal, scopes } });
    expect(refused.status).toBe(403);
  }
  expect(wire.acquisitions).toBe(0); expect(f.storage.current(f.key).record).toBeNull(); expect(f.harness.runner.list()).toHaveLength(0);
});

test('native status and cancel resolve admitted attempt after authoritative work and criteria revisions change', async () => {
  const f = await fixture({ harness: { contract: { maxActiveContracts: 0 } } }); const wire = transport(f);
  const client = createOperatorNativeWorkExecutionClient(wire.sdk(), 'project'); const started = await client.start(wire.identity); if (started.kind !== 'execution') throw new Error('Expected real execution');
  const revised = await f.ledger.service.execute({ type: 'revise', requestId: 'wire-revise', expectedRevision: 2, workId: f.work.id,
    title: f.work.title, goal: f.work.goal, criteria: [...f.work.criteria].reverse() }, f.actor);
  expect(revised.kind).toBe('accepted'); if (revised.kind !== 'accepted' || revised.event.type === 'import_legacy') throw new Error('Owned revision failed');
  const changed = { ...wire.identity, expectedRevision: { ...wire.identity.expectedRevision, work: revised.event.work.revision, criteria: revised.event.work.criteriaRevision } };
  const status = await client.status(changed); if (status.kind !== 'execution') throw new Error('Expected admitted stale status'); expect(status.receipt).toEqual(started.receipt); expect(status.stale).toBe(true);
  expect(status.expectedRevision).toEqual(wire.identity.expectedRevision); expect(status.currentRevision?.criteria).toBe(changed.expectedRevision.criteria);
  await expect(client.resume(changed)).rejects.toMatchObject({ status: 409 });
  const cancelled = await client.cancel(changed); if (cancelled.kind !== 'execution') throw new Error('Expected admitted stale cancellation'); expect(cancelled.state).toBe('cancelled'); expect(cancelled.receipt).toEqual(started.receipt);
  expect(f.harness.agentsOf('u1')).toHaveLength(0);
});

test('native wire rechecks pairing after asynchronous graph acquisition and does not admit a revoked owner', async () => {
  const f = await fixture(); let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); const ready = new Promise<void>(resolve => { entered = resolve; });
  const wire = transport(f, async () => { entered(); await gate; return f.host; });
  const pending = createOperatorNativeWorkExecutionClient(wire.sdk(), 'project').start(wire.identity);
  await ready; f.tokens.revoke(f.paired.id); release(); await expect(pending).rejects.toMatchObject({ status: 403 });
  expect(f.storage.current(f.key).record).toBeNull(); expect(f.log.query({ site: 'work-ledger.native-start' })).toHaveLength(0);
});

test('native wire replacement host reports recovery required without executing another unit', async () => {
  const f = await fixture({ harness: { scripts: { u1: () => [{ text: 'waiting', stop: { kind: 'hang' } }] } } });
  const wire = transport(f); const client = createOperatorNativeWorkExecutionClient(wire.sdk(), 'project'); await client.start(wire.identity);
  await waitFor(() => f.harness.agentsOf('u1').length === 1, 'wire claimed unit');
  const replacement = createNativeWorkExecutionHost(f.hostOptions); replacement.attachRunner(f.harness.runner);
  registerNativeWorkExecutionGatewayMethods(f.catalog, { projectId: 'project', acquire: async () => replacement });
  expect((await client.status(wire.identity)).recovery).toBe('required');
  await expect(client.resume(wire.identity)).rejects.toMatchObject({ status: 409 }); expect(f.harness.agentsOf('u1')).toHaveLength(1);
  await client.cancel(wire.identity); await replacement.close();
});

for (const cancelAssociation of [false, true]) test(`native wire refuses terminal execution restart${cancelAssociation ? ' when cancelled association retains a passed checkpoint' : ''}`, async () => {
  const f = await fixture({ harness: cancelAssociation ? {} : { scripts: { u1: () => [{ text: 'waiting', stop: { kind: 'hang' } }] } } });
  const wire = transport(f); const client = createOperatorNativeWorkExecutionClient(wire.sdk(), 'project');
  const started = await client.start(wire.identity);
  if (started.kind !== 'execution' || !started.receipt) throw new Error('Expected native execution');
  if (cancelAssociation) {
    expect((await completed(f.harness, started.receipt.contractId)).status).toBe('passed');
    expect(await client.cancel(wire.identity)).toMatchObject({ state: 'cancelled', progress: { status: 'passed' } });
  } else {
    await waitFor(() => f.harness.agentsOf('u1').length === 1, 'unit before terminal runner cancellation');
    f.harness.runner.cancel(started.receipt.contractId, 'Owned runner cancellation'); await completed(f.harness, started.receipt.contractId);
    expect(await client.status(wire.identity)).toMatchObject({ state: 'launch-claimed', recovery: 'terminal', progress: { status: 'cancelled' } });
  }
  let resumes = 0;
  f.harness.runner.resumeDurable = async () => { resumes++; throw new Error('Terminal execution must not resume'); };
  await expect(client.resume(wire.identity)).rejects.toMatchObject({ status: 409 });
  expect(resumes).toBe(0); expect(f.harness.agentsOf('u1')).toHaveLength(1);
  expect(f.storage.current(f.key).settlement).toBeNull(); client.dispose();
});

test('production websocket native calls use the authenticated paired socket and refuse revoked or forged frame authority', async () => {
  const f = await fixture({ harness: { contract: { maxActiveContracts: 0 } } }); const wire = transport(f);
  const principal = f.helper.describeAuthenticatedPrincipal(f.paired.token)!;
  const responses: Array<{ status: number; body: unknown }> = [];
  const socket = { data: { channel: 'control-plane' as const, clientId: 'owned-native-socket', authToken: f.paired.token,
    ...principal, authenticated: true, clientKind: 'web' as const, domains: [] }, send(text: string) { responses.push(JSON.parse(text)); } };
  const call = async (operation: string, extra: Record<string, unknown> = {}) => {
    await f.helper.handleControlPlaneWebSocketMessage(socket as unknown as Parameters<typeof f.helper.handleControlPlaneWebSocketMessage>[0],
      JSON.stringify({ type: 'call', id: 'owned-native-request', methodId: `workLedger.execution.${operation}`, body: { projectId: 'project', ...wire.identity }, ...extra }));
    return responses.at(-1)!;
  };
  expect((await call('start')).status).toBe(200); expect((await call('status')).status).toBe(200);
  socket.data.scopes = ['read:work-ledger']; expect((await call('cancel', { scopes: ['*'], admin: true })).status).toBe(403);
  socket.data.scopes = [...principal.scopes]; f.tokens.revoke(f.paired.id);
  expect((await call('resume', { authToken: 'synthetic-shared', context: { principalId: principal.principalId, scopes: ['*'], admin: true } })).status).toBe(401);
  expect(f.harness.agentsOf('u1')).toHaveLength(0);
});

test('wire explicit resume after real prepared-process restart keeps admission IDs and records a fresh native decision', async () => {
  const f = await fixture();
  writeFileSync(join(f.root, '.goodvibes', 'native-child-fixture.json'), JSON.stringify({ marker: 'owned-native-queued-child', token: f.paired.token, target: f.target }));
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./helpers/native-work-execution-child.ts', import.meta.url)), f.root], { encoding: 'utf8', timeout: 15000 });
  expect(child.status, child.stderr).toBe(0); const before = JSON.parse(child.stdout) as { contractId: string; ownerAgentId: string };
  const wire = transport(f); const client = createOperatorNativeWorkExecutionClient(wire.sdk(), 'project');
  expect((await client.status(wire.identity)).state).toBe('prepared'); expect(f.harness.agentsOf('u1')).toHaveLength(0);
  const resumed = await client.resume(wire.identity); if (resumed.kind !== 'execution') throw new Error('Expected real resumed execution'); expect(resumed.receipt).toEqual(before);
  expect((await completed(f.harness, before.contractId)).status).toBe('passed'); expect(f.harness.agentsOf('u1')).toHaveLength(1);
  expect(f.log.query({ site: 'work-ledger.native-start' })).toHaveLength(2);
}, 30000);

test('native wire semantic refusal stays distinct from transport failure and never returns an authority-bearing decision', async () => {
  let f!: Awaited<ReturnType<typeof fixture>>;
  f = await fixture({ decoratePort: port => { const fake = fakePort((_name, question) => choiceAnswer(question, 'reject', 0.99));
    return { ...port, ask: request => withDecisionLog(fake.port, f.log).ask(request) }; } });
  const wire = transport(f);
  const result = await f.helper.invokeGatewayMethodCall({ authToken: f.paired.token, methodId: 'workLedger.execution.start',
    body: { projectId: 'project', ...wire.identity }, context: f.helper.describeAuthenticatedPrincipal(f.paired.token)! });
  expect(result.status).toBe(422); expect(JSON.stringify(result.body)).toContain('NATIVE_EXECUTION_REFUSED');
  expect(JSON.stringify(result.body)).not.toContain('judgmentDecisionIds'); expect(f.storage.current(f.key).record).toBeNull();
});

test('wire missing execution is a typed 404 inspection result, never an implicit start', async () => {
  const f = await fixture(); const wire = transport(f);
  const result = await f.helper.invokeGatewayMethodCall({ authToken: f.paired.token, methodId: 'workLedger.execution.status',
    body: { projectId: 'project', ...wire.identity }, context: f.helper.describeAuthenticatedPrincipal(f.paired.token)! });
  expect(result.status).toBe(404); expect(JSON.stringify(result.body)).toContain('NATIVE_EXECUTION_NOT_FOUND');
  expect(f.log.query({ site: 'work-ledger.native-start' })).toHaveLength(0); expect(f.harness.runner.list()).toHaveLength(0);
});

test('target-aware cancellation wins before the first start without inventing an admission', async () => {
  const f = await fixture(); const wire = transport(f); const client = createOperatorNativeWorkExecutionClient(wire.sdk(), 'project');
  const cancelled = await client.cancel(wire.identity);
  expect(cancelled).toMatchObject({ kind: 'prevented-before-admission', state: 'cancelled', recovery: 'cancelled' });
  expect('receipt' in cancelled).toBe(false); expect('progress' in cancelled).toBe(false);
  expect(f.storage.current(f.key).record).toBeNull(); expect(f.storage.current(f.key).intent?.state).toBe('cancelled');
  expect(await client.cancel(wire.identity)).toEqual(cancelled);
  expect(await client.start(wire.identity)).toEqual(cancelled); expect(await client.resume(wire.identity)).toEqual(cancelled);
  expect(f.harness.runner.list({ includeTerminal: true })).toHaveLength(0); expect(f.log.query({ site: 'work-ledger.native-start' })).toHaveLength(0);
});

test('REST cancellation publishes its tombstone while Jev is held, then joins an abort-ignoring late reading', async () => {
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({ decoratePort: port => ({ ...port, async ask(request) {
    entered(); await gate;
    // Owned fixture deliberately models a transport that does not honor abort.
    const { signal: _signal, beforeAttempt: _beforeAttempt, ...late } = request;
    return port.ask(late);
  } }) });
  const wire = transport(f); const client = createOperatorNativeWorkExecutionClient(wire.sdk(), 'project');
  const start = client.start(wire.identity); await ready;
  expect(await client.status(wire.identity)).toMatchObject({ kind: 'pending-intent', state: 'admitting', recovery: 'pending' });
  let cancelled = false; const cancel = client.cancel(wire.identity).then(result => { cancelled = true; return result; });
  await waitFor(() => f.storage.currentByAttempt(f.target.attemptId).intent?.state === 'cancelled', 'intent tombstone while Jev waits');
  expect(cancelled).toBe(false); expect(f.storage.current(f.key).record).toBeNull();
  expect(await client.status(wire.identity)).toMatchObject({ kind: 'prevented-before-admission' });
  release(); expect((await cancel).kind).toBe('prevented-before-admission'); expect((await start).kind).toBe('prevented-before-admission');
  expect(f.harness.runner.list({ includeTerminal: true })).toHaveLength(0);
  for (const entry of f.log.query({ site: 'work-ledger.native-start' })) {
    expect(entry.status).toBe('answered');
    if (entry.status !== 'answered') throw new Error('Expected the held Jev reading to answer');
    expect(entry.notes.some(note => note.kind === 'action' && note.action.startsWith('autonomous:claim:'))).toBe(false);
  }
});

test('authenticated WS cancellation prevents a held initial start without a per-call abort signal', async () => {
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({ decoratePort: port => ({ ...port, async ask(request) { entered(); await gate; return port.ask(request); } }) });
  const wire = transport(f); const principal = f.helper.describeAuthenticatedPrincipal(f.paired.token)!;
  const frames: Array<{ id: string; status: number; body: { kind?: string } }> = [];
  const socket = { data: { channel: 'control-plane' as const, clientId: 'owned-intent-socket', authToken: f.paired.token,
    ...principal, authenticated: true, clientKind: 'web' as const, domains: [] }, send(text: string) { frames.push(JSON.parse(text)); } };
  const call = (operation: string) => f.helper.handleControlPlaneWebSocketMessage(socket as unknown as Parameters<typeof f.helper.handleControlPlaneWebSocketMessage>[0],
    JSON.stringify({ type: 'call', id: operation, methodId: `workLedger.execution.${operation}`, body: { projectId: 'project', ...wire.identity } }));
  const start = call('start'); await ready; const cancel = call('cancel');
  await waitFor(() => f.storage.current(f.key).intent?.state === 'cancelled', 'WS tombstone during initial admission');
  expect(frames.find(frame => frame.id === 'cancel')).toBeUndefined();
  release(); await Promise.all([start, cancel]);
  for (const operation of ['start', 'cancel']) expect(frames.find(frame => frame.id === operation)).toMatchObject({ status: 200, body: { kind: 'prevented-before-admission' } });
  expect(f.storage.current(f.key).record).toBeNull(); expect(f.harness.agentsOf('u1')).toHaveLength(0);
});

test('interrupted pending intent never restarts on start and explicit resume records a fresh evaluation', async () => {
  let first = true; const f = await fixture({ decoratePort: port => ({ ...port, async ask(request) {
    if (first) { first = false; throw new Error('Synthetic initial transport stopped'); } return port.ask(request);
  } }) });
  await expect(f.host.start(f.target, f.authority)).rejects.toThrow('Synthetic initial transport stopped');
  expect(f.storage.current(f.key).intent).toMatchObject({ state: 'admitting', generation: 1 });
  expect(f.host.statusByAttempt(f.target.workId, f.target.attemptId, f.authority)).toMatchObject({ kind: 'intent', recovery: 'required' });
  await expect(f.host.start(f.target, f.authority)).rejects.toMatchObject({ code: 'pending-intent' });
  expect(f.harness.runner.list({ includeTerminal: true })).toHaveLength(0);
  const resumed = await f.host.resume(f.key, f.authority);
  expect((await completed(f.harness, resumed.admission.contractId)).status).toBe('passed');
  expect(f.storage.current(f.key).intent).toMatchObject({ state: 'associated', generation: 2 }); expect(f.harness.agentsOf('u1')).toHaveLength(1);
});

test('a refused intent stays visibly refused until explicit same-target resume', async () => {
  let calls = 0; let f!: Awaited<ReturnType<typeof fixture>>;
  f = await fixture({ decoratePort: port => ({ ...port, async ask(request) {
    if (++calls === 1) return withDecisionLog(fakePort((_name, question) => choiceAnswer(question, 'reject', 0.99)).port, f.log).ask(request);
    return port.ask(request);
  } }) });
  const wire = transport(f); const client = createOperatorNativeWorkExecutionClient(wire.sdk(), 'project');
  await expect(client.start(wire.identity)).rejects.toMatchObject({ status: 422 });
  expect(await client.status(wire.identity)).toMatchObject({ kind: 'pending-intent', state: 'refused', recovery: 'required' });
  await expect(client.start(wire.identity)).rejects.toMatchObject({ status: 422 }); expect(calls).toBe(1);
  const resumed = await client.resume(wire.identity); if (resumed.kind !== 'execution' || !resumed.receipt) throw new Error('Expected resumed admission');
  expect((await completed(f.harness, resumed.receipt.contractId)).status).toBe('passed'); expect(calls).toBe(2);
});

test('explicit newer evaluation fences a late old host generation before it can claim or publish', async () => {
  let count = 0; let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({ decoratePort: port => ({ ...port, async ask(request) {
    if (++count === 1) { entered(); await gate; } return port.ask(request);
  } }) });
  const old = f.host.start(f.target, f.authority).catch(error => error); await ready;
  const replacement = createNativeWorkExecutionHost(f.hostOptions);
  const second = makeHarness({ root: f.root, plan: f.plan, scripts: { u1: finishes('new explicit generation') }, decisionLog: f.log,
    nativeDecisions: replacement.nativeOwner.decisions, durableAdmission: replacement.nativeOwner.admission }); replacement.attachRunner(second.runner);
  cleanups.push(async () => { release(); await replacement.close(); second.dispose(); await Promise.all(second.runner.list({ includeTerminal: true }).map(item => second.runner.join(item.id))); });
  await expect(replacement.start(f.target, f.authority)).rejects.toMatchObject({ code: 'pending-intent' });
  const resumed = await replacement.resume(f.key, f.authority); expect((await completed(second, resumed.admission.contractId)).status).toBe('passed');
  release(); expect(await old).toMatchObject({ code: 'stale' });
  expect(f.storage.current(f.key).intent?.generation).toBe(2); expect(f.harness.agentsOf('u1')).toHaveLength(0); expect(second.agentsOf('u1')).toHaveLength(1);
});

test('pending source edits never rewrite intent but inspection and cancellation still use the original attempt', async () => {
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({ decoratePort: port => ({ ...port, async ask(request) { entered(); await gate; return port.ask(request); } }) });
  const start = f.host.start(f.target, f.authority).catch(error => error); await ready;
  const before = f.storage.current(f.key).intent!;
  expect(await f.ledger.service.execute({ type: 'revise', requestId: 'pending-source-edit', expectedRevision: 2, workId: f.work.id,
    title: f.work.title, goal: f.work.goal, criteria: [...f.work.criteria].reverse() }, f.actor)).toMatchObject({ kind: 'accepted' });
  const observation = f.host.statusByAttempt(f.work.id, f.target.attemptId, f.authority);
  expect(observation.currentTarget?.criteriaRevision).not.toBe(f.target.criteriaRevision);
  const cancel = f.host.cancelTarget({ ...f.target, workRevision: observation.currentTarget!.workRevision, criteriaRevision: observation.currentTarget!.criteriaRevision }, f.authority, 'Cancel original pending attempt');
  await waitFor(() => f.storage.current(f.key).intent?.state === 'cancelled', 'edited pending intent tombstone'); release(); await cancel;
  expect(await start).toMatchObject({ code: 'prevented-before-admission' }); expect(f.storage.current(f.key).intent?.request).toEqual(before.request);
  expect(f.storage.current(f.key).record).toBeNull();
});

test('actual process exit with only a pending intent stays held until explicit fresh resume', async () => {
  const f = await fixture();
  writeFileSync(join(f.root, '.goodvibes', 'native-child-fixture.json'), JSON.stringify({ marker: 'owned-native-intent-child', token: f.paired.token, target: f.target }));
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./helpers/native-work-intent-child.ts', import.meta.url)), f.root], { encoding: 'utf8', timeout: 15000 });
  expect(child.status, child.stderr).toBe(0); expect(JSON.parse(child.stdout)).toEqual({ generation: 1, state: 'admitting' });
  const wire = transport(f); const client = createOperatorNativeWorkExecutionClient(wire.sdk(), 'project');
  expect(await client.status(wire.identity)).toMatchObject({ kind: 'pending-intent', recovery: 'required' });
  expect(await client.start(wire.identity)).toMatchObject({ kind: 'pending-intent', recovery: 'required' });
  expect(f.harness.runner.list({ includeTerminal: true })).toHaveLength(0);
  const result = await client.resume(wire.identity); if (result.kind !== 'execution' || !result.receipt) throw new Error('Expected fresh admitted execution');
  expect((await completed(f.harness, result.receipt.contractId)).status).toBe('passed');
  expect(f.storage.current(f.key).intent?.generation).toBe(2); expect(f.harness.agentsOf('u1')).toHaveLength(1);
}, 30000);

test('cancel after native association but before receipt retention is execution cancellation, never a fake prevention receipt', async () => {
  const f = await fixture(); const wire = transport(f); const client = createOperatorNativeWorkExecutionClient(wire.sdk(), 'project');
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const original = f.harness.runner.startDurable.bind(f.harness.runner);
  f.harness.runner.startDurable = async request => { entered(); await gate; return original(request); };
  const start = client.start(wire.identity).catch(error => error); await ready;
  expect(f.storage.current(f.key).record?.receipt).toBeNull();
  let ended = false; const cancel = client.cancel(wire.identity).then(result => { ended = true; return result; });
  await waitFor(() => f.storage.current(f.key).record?.state === 'cancelled', 'associated cancellation publication');
  expect(ended).toBe(false); release(); const result = await cancel; await start;
  expect(result).toMatchObject({ kind: 'execution', state: 'cancelled' });
  expect(f.harness.agentsOf('u1')).toHaveLength(0);
});

for (const failure of ['before-publication', 'after-rename'] as const) {
  test(`pending cancellation ${failure} never acknowledges uncertain durability and still drains its local evaluation`, async () => {
    let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture({ decoratePort: port => ({ ...port, async ask(request) { entered(); await gate; return port.ask(request); } }) });
    const start = f.host.start(f.target, f.authority).catch(error => error); await ready;
    const persistence = (f.store as unknown as { sqlite: { persistence: { io: SQLitePublicationIO } } }).sqlite.persistence;
    let failed = false;
    persistence.io = { ...nativeFs, fsyncSync(fd) {
      if (!failed && (failure === 'after-rename' ? nativeFs.fstatSync(fd).isDirectory() : !nativeFs.fstatSync(fd).isDirectory())) {
        failed = true; throw new Error('Owned pending cancellation persistence failure');
      }
      nativeFs.fsyncSync(fd);
    } };
    let ended = false; const cancel = f.host.cancelTarget(f.target, f.authority, 'Cancel despite interrupted persistence').catch(error => { ended = true; return error; });
    await waitFor(() => failed, 'owned tombstone publication fault'); expect(ended).toBe(false);
    persistence.io = nativeFs; release(); expect(await cancel).toMatchObject({ code: 'unavailable' }); await start;
    expect(f.harness.agentsOf('u1')).toHaveLength(0); expect(f.storage.current(f.key).record).toBeNull();
  });
}

test('a cancelled intent survives restart, while a legitimately new ledger attempt can execute', async () => {
  const f = await fixture(); await f.host.cancelTarget(f.target, f.authority, 'Prevent this attempt');
  const replacement = createNativeWorkExecutionHost(f.hostOptions); replacement.attachRunner(f.harness.runner);
  await expect(replacement.start(f.target, f.authority)).rejects.toMatchObject({ code: 'prevented-before-admission' });
  await expect(replacement.resume(f.key, f.authority)).rejects.toMatchObject({ code: 'prevented-before-admission' }); await replacement.close();
  expect(await f.ledger.service.execute({ type: 'release', requestId: 'release-prevented', expectedRevision: 2, workId: f.work.id, attemptId: f.target.attemptId, reason: 'New explicitly claimed attempt' }, f.actor)).toMatchObject({ kind: 'accepted' });
  const next = await f.ledger.service.execute({ type: 'claim', requestId: 'claim-new-attempt', expectedRevision: 3, workId: f.work.id }, f.actor);
  if (next.kind !== 'accepted' || next.event.type === 'import_legacy') throw new Error('Expected new legitimate attempt');
  const work = next.event.work; const attempt = next.event.attempts[0]!;
  const result = await f.host.start({ workId: work.id, attemptId: attempt.id, workRevision: work.revision, criteriaRevision: work.criteriaRevision, attemptRevision: attempt.revision }, f.authority);
  expect((await completed(f.harness, result.admission.contractId)).status).toBe('passed');
  expect(f.storage.currentByAttempt(f.target.attemptId).intent?.state).toBe('cancelled'); expect(f.harness.agentsOf('u1')).toHaveLength(1);
});

test('a different paired principal cannot preempt another owner attempt with a cancellation tombstone', async () => {
  const f = await fixture(); const other = f.tokens.mint({ name: 'Another owned test device' });
  const authority = f.helper.createNativeExecutionAuthority(other.token)!;
  await expect(f.host.cancelTarget(f.target, authority, 'Unauthorized attempt cancellation')).rejects.toMatchObject({ code: 'stale' });
  expect(f.storage.current(f.key).intent).toBeNull(); expect(f.storage.current(f.key).record).toBeNull();
});

test('durable cancellation is not blocked by real shared Jev retry-after backoff', async () => {
  let retries!: () => void; const backoff = new Promise<void>(resolve => { retries = resolve; }); let calls = 0;
  const realRetryPort = createSystemOnePort({ endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:1', apiKey: 'owned-synthetic-key' },
    model: PINNED_MODEL, timeoutMs: 100, retry: { backoffInitialMs: 1, backoffMaxMs: 1, backoffJitter: 0 },
    fetch: async () => { calls++; return Response.json({}, { status: 503, headers: { 'retry-after': '3600' } }); } });
  let f!: Awaited<ReturnType<typeof fixture>>;
  f = await fixture({ decoratePort: port => ({ ...port, ask: request => withDecisionLog(realRetryPort, f.log).ask({ ...request,
    onRetry(progress) { retries(); request.onRetry?.(progress); } }) }) });
  const pending = f.host.start(f.target, f.authority).catch(error => error); await backoff;
  await f.host.cancelTarget(f.target, f.authority, 'Cancel during retry-after backoff');
  expect(await pending).toMatchObject({ code: 'prevented-before-admission' }); expect(calls).toBe(1);
  expect(f.storage.current(f.key).intent?.state).toBe('cancelled'); expect(f.storage.current(f.key).record).toBeNull();
}, 5000);


test('explicit complete-source submission reaches native execution with its exact persisted provenance only after separate start', async () => {
  const f = await fixture();
  const submission = createNativeWorkSubmissionHost({ projectId: 'project', projectRoot: f.root, sessionId: 'native-fixture',
    service: f.ledger.service, authority: f.ledger.authority, scopes: f.scopes });
  cleanups.push(() => submission.close());
  const input = { requestId: 'explicit-source-request', inputId: 'explicit-source-input', expectedRevision: 2,
    goal: '  Preserve the complete explicit goal.\nKeep exact whitespace ☃.  ',
    criteria: [' First exact criterion. ', 'Duplicate exact criterion.', 'Duplicate exact criterion.'] };
  const submitted = await submission.submit(input, f.authority);
  expect(f.harness.runner.list({ includeTerminal: true })).toHaveLength(0);
  expect(f.log.query({ site: 'work-ledger.native-start' })).toHaveLength(0);
  const receipt = submitted.receipt;
  const target = { workId: receipt.workId, attemptId: receipt.attemptId, workRevision: receipt.expectedRevision.work,
    criteriaRevision: receipt.expectedRevision.criteria, attemptRevision: receipt.expectedRevision.attempt };
  f.plan.goal = input.goal;
  f.plan.criteria = input.criteria.map((text, index) => ({ id: `c${index + 1}`, text, quote: text }));
  f.plan.groups[0]!.units[0]!.criteria = input.criteria.map((_text, index) => ({ id: `u1.c${index + 1}`, text: `Original criterion ${index + 1} holds`, serves: [`c${index + 1}`] }));
  const started = await f.host.start(target, f.authority);
  const result = await completed(f.harness, started.admission.contractId);
  expect(result.status).toBe('passed');
  expect(result.nativeSource).toMatchObject({ sourceId: receipt.source.sourceId, sourceRevision: receipt.source.sourceRevision,
    goal: input.goal, criteria: input.criteria });
  expect(result.criteria.map(item => item.text)).toEqual(input.criteria);
  expect((await submission.submit(input, f.authority)).receipt).toEqual(receipt);
  expect(f.harness.runner.list({ includeTerminal: true })).toHaveLength(1);
  expect(f.harness.agentsOf('u1')).toHaveLength(1);
});


test('native source submission requires the dedicated write scope and never upgrades a cached paired ceiling', async () => {
  const f = await fixture();
  const submission = createNativeWorkSubmissionHost({ projectId: 'project', projectRoot: f.root, sessionId: 'native-fixture',
    service: f.ledger.service, authority: f.ledger.authority, scopes: f.scopes });
  cleanups.push(() => submission.close()); registerNativeWorkSubmissionGatewayMethods(f.catalog, submission);
  const input = { requestId: 'scope-request', inputId: 'scope-input', expectedRevision: 2, goal: 'Explicit goal', criteria: ['Explicit criterion'] };
  const principal = f.helper.describeAuthenticatedPrincipal(f.paired.token)!;
  for (const scopes of [['read:work-ledger'], ['write:work-ledger'], ['read:work-ledger', 'write:fleet'], ['read:work-ledger', 'write:work-ledger-import']]) {
    const result = await f.helper.invokeGatewayMethodCall({ authToken: f.paired.token, methodId: 'workLedger.submit', body: input, context: { ...principal, scopes } });
    expect(result.status).toBe(403);
  }
  const limited = f.helper.createNativeExecutionAuthority(f.paired.token, ['read:work-ledger', 'write:fleet'])!;
  await expect(submission.submit(input, limited)).rejects.toMatchObject({ code: 'unsupported-authority' });
  expect((await f.ledger.service.readSnapshot(f.actor)).revision).toBe(2);
  const allowed = await f.helper.invokeGatewayMethodCall({ authToken: f.paired.token, methodId: 'workLedger.submit', body: input,
    context: { ...principal, scopes: ['read:work-ledger', 'write:work-ledger'] } });
  expect(allowed.status).toBe(200); expect((await f.ledger.service.readSnapshot(f.actor)).revision).toBe(3);
  expect(f.harness.runner.list({ includeTerminal: true })).toHaveLength(0);
});

for (const failure of ['before-publication', 'after-rename'] as const) test(`native submission ${failure} failure keeps its request identity and reconciles from persisted storage`, async () => {
  const f = await fixture();
  const submission = createNativeWorkSubmissionHost({ projectId: 'project', projectRoot: f.root, sessionId: 'native-fixture',
    service: f.ledger.service, authority: f.ledger.authority, scopes: f.scopes });
  cleanups.push(() => submission.close());
  const input = { requestId: 'fault-source-request', inputId: 'fault-source-input', expectedRevision: 2, goal: '  Exact goal  ', criteria: ['  Exact criterion  '] };
  const persistence = (f.store as unknown as { sqlite: { persistence: { io: SQLitePublicationIO } } }).sqlite.persistence;
  let failed = false;
  persistence.io = { ...nativeFs, fsyncSync(fd) {
    if (!failed && (failure === 'after-rename' ? nativeFs.fstatSync(fd).isDirectory() : !nativeFs.fstatSync(fd).isDirectory())) {
      failed = true; throw new Error('Owned submission publication fault');
    }
    nativeFs.fsyncSync(fd);
  } };
  try { await expect(submission.submit(input, f.authority)).rejects.toMatchObject({ code: 'indeterminate' }); }
  finally { persistence.io = nativeFs; }
  expect(failed).toBe(true);
  const reopened = new KnowledgeStore({ dbPath: join(f.root, '.goodvibes', 'knowledge.sqlite') });
  const ledger = createWorkLedger({ projectId: 'project', storage: await reopened.openWorkLedgerStorage('project'),
    clock: { now: () => 100, newId: kind => `${kind}-reconciled` } });
  const next = createNativeWorkSubmissionHost({ projectId: 'project', projectRoot: f.root, sessionId: 'native-fixture', service: ledger.service, authority: ledger.authority, scopes: f.scopes });
  try {
    const lookup = await next.get({ requestId: input.requestId }, f.authority);
    expect(lookup.kind).toBe(failure === 'after-rename' ? 'found' : 'not-found');
    const replay = await next.submit(input, f.authority);
    expect(replay.replayed).toBe(failure === 'after-rename');
    expect(replay.receipt.goal).toBe(input.goal); expect(replay.receipt.criteria).toEqual(input.criteria);
    if (lookup.kind === 'found') expect(replay.receipt).toEqual(lookup.receipt);
    expect(f.harness.runner.list({ includeTerminal: true })).toHaveLength(0);
  } finally { await next.close(); await ledger.service.close(); await reopened.close(); }
});

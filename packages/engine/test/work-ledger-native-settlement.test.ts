import { checkSettings } from '../sdk/src/platform/contract/check.js';
import { CONTRACT_CONFIG_DEFAULTS } from '../sdk/src/platform/contract/config.js';
import { verifyNativeWorkExecution } from '../sdk/src/platform/workflow/work-ledger/native-execution-verifier.js';
import { nativeExecutionProvider } from './helpers/native-execution-provider.js';
import * as nativeFs from 'node:fs';
import type { SQLitePublicationIO } from '../sdk/src/platform/state/sqlite-store-persistence.js';
/** Real paired authority, workspace scope and KnowledgeStore bridge into the real durable runner. */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteDecisionLog, withDecisionLog, createSystemOnePort, PINNED_MODEL, type JudgmentPort } from '@goodvibes-jev/judgment';
import { noulAnswer } from '@goodvibes-jev/judgment/testing';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { createWorkLedger } from '../sdk/src/platform/workflow/work-ledger/service.js';
import { createNativeWorkExecutionHost } from '../sdk/src/platform/workflow/work-ledger/native-execution.js';
import { criteriaSetIdForWork, DurableContractAdmissions, durableKeyHash } from '../sdk/src/platform/contract/durable-admission.js';
import { PairingTokenManager } from '../sdk/src/platform/pairing/pairing-token-store.js';
import { WorkspaceRegistrationStore } from '../sdk/src/platform/workspace/registration/store.js';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../sdk/src/platform/daemon/control-plane.js';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.js';
import { makeRepo, makeHarness, oneUnitPlan, runnerPort, waitFor, type Harness, type HarnessOptions } from './contract/runner-support.js';
import { finishes } from './contract/steps-support.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(options: { harness?: Partial<HarnessOptions>; decoratePort?: (port: JudgmentPort) => JudgmentPort; register?: boolean; automatic?: boolean; source?: { goal: string; criteria: string[] }; settlementAnswers?: Parameters<typeof runnerPort>[0] } = {}) {
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
  const created = await ledger.service.execute({ type: 'create', requestId: 'create', expectedRevision: 0, title: 'Small display label', goal: options.source?.goal ?? 'Preserve the complete goal.\nKeep all original requirements ☃.', criteria: options.source?.criteria ?? ['Keep the exact parser behavior.', 'Keep the ordered second requirement.'] }, actor);
  if (created.kind !== 'accepted' || created.event.type === 'import_legacy') throw new Error('fixture create failed');
  const claimed = await ledger.service.execute({ type: 'claim', requestId: 'claim', expectedRevision: 1, workId: created.event.workId }, actor);
  if (claimed.kind !== 'accepted' || claimed.event.type === 'import_legacy') throw new Error('fixture claim failed');
  const work = claimed.event.work; const attempt = claimed.event.attempts[0]!;
  const target = { workId: work.id, workRevision: work.revision, criteriaRevision: work.criteriaRevision, attemptId: attempt.id, attemptRevision: attempt.revision };
  const key = { workId: work.id, criteriaId: criteriaSetIdForWork(work.id), criteriaRevision: String(work.criteriaRevision), attemptId: attempt.id };
  const log = new SqliteDecisionLog(join(root, '.goodvibes', 'decisions.sqlite'));
  const fake = runnerPort(options.settlementAnswers);
  const port = options.decoratePort?.(withDecisionLog(fake.port, log)) ?? withDecisionLog(fake.port, log);
  const storage = await store.openNativeWorkExecutionStorage('project');
  const hostOptions = { projectId: 'project', projectRoot: root, sessionId: 'native-fixture', storage, scopes, port, decisionLog: log, verification: { settings: () => checkSettings(CONTRACT_CONFIG_DEFAULTS), readAccessFilter: options.harness?.readAccessFilter ?? (async () => true), automatic: options.automatic ?? false } };
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


test('terminal settlement checks every original criterion and atomically publishes adjacent report and evidence', async () => {
  const f = await fixture(); const started = await f.host.start(f.target, f.authority);
  await completed(f.harness, started.admission.contractId);
  const before = f.storage.current(f.key); expect(before.ledger.revision).toBe(2);
  const observed: { revision: number; verification: string }[] = [];
  const stop = f.ledger.service.subscribe(f.actor, snapshot => observed.push({ revision: snapshot.revision, verification: snapshot.works[0]?.verification.state ?? 'missing' }));
  cleanups.push(async () => { stop(); });
  const receipt = await f.host.settle(f.key, f.authority);
  expect(receipt.attestation.outcome).toBe('verified'); expect(receipt.attestation.criteriaResults.map(item => item.criterionIndex)).toEqual([0, 1]);
  const after = f.storage.current(f.key); expect(after.ledger.revision).toBe(4);
  expect(after.ledger.history.slice(-2).map(event => event.type)).toEqual(['report', 'record_evidence']);
  expect(after.ledger.evidence[0]?.target).toEqual(receipt.targetAfterReport); expect(after.settlement).toEqual(receipt);
  await waitFor(() => observed.some(item => item.revision === 4), 'ordinary ledger subscription receives settlement');
  expect(observed.some(item => item.revision === 3)).toBe(false); expect(observed.at(-1)?.verification).toBe('verified');
  expect(receipt.evidenceSequence).toBe(receipt.reportSequence + 1);
  expect(f.host.status(f.key, f.authority).settlement).toMatchObject({ state: 'published', evidenceId: receipt.evidenceId });
  const checks = receipt.attestation.references.filter(item => item.kind === 'decision'); expect(checks).toHaveLength(2);
  for (const reference of checks) expect(f.log.get(reference.ref.slice('decision:'.length))?.status).toBe('answered');
  const controller = new AbortController(); controller.abort();
  expect(await f.host.settle(f.key, f.authority, { signal: controller.signal })).toEqual(receipt);
  expect(f.harness.agentsOf('u1')).toHaveLength(1);
});

test('an unmet original criterion cannot be hidden by planner success', async () => {
  const f = await fixture({ settlementAnswers: context => context.name === 'criterion_1' ? noulAnswer(0.99) : undefined });
  const started = await f.host.start(f.target, f.authority); expect((await completed(f.harness, started.admission.contractId)).status).toBe('passed');
  const receipt = await f.host.settle(f.key, f.authority);
  expect(receipt.attestation.outcome).toBe('failed'); expect(receipt.attestation.criteriaResults[1]?.status).toBe('unsatisfied');
  expect(f.storage.current(f.key).ledger.works[0]?.reportedState).toBe('complete');
  expect(f.storage.current(f.key).ledger.evidence[0]?.outcome).toBe('failed');
});

test('status stays read-only, explicit concurrent settlement publishes once, and reopened host replays with zero runner effects', async () => {
  const f = await fixture(); const started = await f.host.start(f.target, f.authority); await completed(f.harness, started.admission.contractId);
  for (let index = 0; index < 3; index++) expect(f.host.status(f.key, f.authority).settlement?.state).toBe('required');
  expect(f.storage.current(f.key).ledger.revision).toBe(2);
  const [one, two] = await Promise.all([f.host.settle(f.key, f.authority), f.host.settle(f.key, f.authority)]); expect(one).toEqual(two);
  const reopened = new KnowledgeStore({ dbPath: join(f.root, '.goodvibes', 'knowledge.sqlite') });
  const storage = await reopened.openNativeWorkExecutionStorage('project');
  const replacement = createNativeWorkExecutionHost({ ...f.hostOptions, storage, port: { ...f.hostOptions.port, ask: async () => { throw new Error('No semantic replay allowed'); } } });
  replacement.attachRunner({ ...f.harness.runner, startDurable: async () => { throw new Error('No effect replay'); }, resumeDurable: async () => { throw new Error('No effect resume'); }, join: async () => { throw new Error('No join on durable settlement replay'); } });
  try { expect(await replacement.settle(f.key, f.authority)).toEqual(one); expect(storage.current(f.key).ledger.revision).toBe(4); }
  finally { await replacement.close(); await reopened.close(); }
});

test('revocation during a terminal recorded check publishes no report or evidence', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture({ decoratePort: port => ({ ...port, async ask(request) {
    if (request.context?.site === 'contract.check.unit-judge') { entered(); await gate; } return port.ask(request);
  } }) });
  const started = await f.host.start(f.target, f.authority); await completed(f.harness, started.admission.contractId);
  const settlement = f.host.settle(f.key, f.authority); await ready; f.tokens.revoke(f.paired.id); release();
  await expect(settlement).rejects.toThrow(); expect(f.storage.current(f.key).ledger.revision).toBe(2); expect(f.storage.current(f.key).settlement).toBeNull();
});

test('mutated artifacts, rewritten checkpoint roots and copied receipts cannot verify', async () => {
  let change: (() => void) | undefined;
  const f = await fixture({ decoratePort: port => ({ ...port, async ask(request) { if (request.context?.site === 'contract.check.unit-judge') change?.(); return port.ask(request); } }) });
  const started = await f.host.start(f.target, f.authority); await completed(f.harness, started.admission.contractId);
  change = () => writeFileSync(join(f.root, 'src/csv.ts'), 'changed during check');
  await expect(f.host.settle(f.key, f.authority)).rejects.toThrow('artifact changed'); expect(f.storage.current(f.key).ledger.revision).toBe(2);
  const record = f.storage.current(f.key).record!;
  await expect(verifyNativeWorkExecution({ execution: record, runner: { join: f.harness.runner.join, get: id => { const value = f.harness.runner.get(id)!; return { ...value, goal: 'rewritten' }; } }, port: f.hostOptions.port, decisionLog: f.log, settings: checkSettings(CONTRACT_CONFIG_DEFAULTS), readAccessFilter: async () => true, signal: new AbortController().signal, assertCurrent() {} })).rejects.toThrow();
  await expect(verifyNativeWorkExecution({ execution: { ...record, receipt: { ...record.receipt!, contractId: 'ctr_000000000000' } }, runner: f.harness.runner, port: f.hostOptions.port, decisionLog: f.log, settings: checkSettings(CONTRACT_CONFIG_DEFAULTS), readAccessFilter: async () => true, signal: new AbortController().signal, assertCurrent() {} })).rejects.toThrow();
});

test('automatic completion settles through the owned lifetime and close drains held checks', async () => {
  const f = await fixture({ automatic: true }); const started = await f.host.start(f.target, f.authority);
  await waitFor(() => f.storage.current(f.key).settlement !== null, 'automatic native settlement', 15000);
  expect(f.storage.current(f.key).settlement?.contractId).toBe(started.admission.contractId);
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
  const g = await fixture({ automatic: true, decoratePort: port => ({ ...port, async ask(request) { if (request.context?.site === 'contract.check.unit-judge') { entered(); await hold; } return port.ask(request); } }) });
  await g.host.start(g.target, g.authority); await ready;
  let closed = false; const close = g.host.close().then(() => { closed = true; }); await new Promise(resolve => setTimeout(resolve, 20)); expect(closed).toBe(false);
  release(); await close; expect(g.storage.current(g.key).ledger.revision).toBe(2);
});

for (const failure of ['before-publication', 'after-rename'] as const) {
  test(`atomic settlement ${failure} leaves zero partial report and exact lost acknowledgement recovery`, async () => {
    const f = await fixture(); const started = await f.host.start(f.target, f.authority); await completed(f.harness, started.admission.contractId);
    const persistence = (f.store as unknown as { sqlite: { persistence: { io: SQLitePublicationIO } } }).sqlite.persistence;
    let fileSynced = false; let failed = false;
    persistence.io = { ...nativeFs, fsyncSync(fd) {
      const directory = nativeFs.fstatSync(fd).isDirectory();
      if (!directory) fileSynced = true;
      if (!failed && fileSynced && (failure === 'after-rename' ? directory : !directory)) { failed = true; throw new Error('Synthetic settlement persistence failure'); }
      nativeFs.fsyncSync(fd);
    } };
    await expect(f.host.settle(f.key, f.authority)).rejects.toThrow(); persistence.io = nativeFs; expect(failed).toBe(true);
    const reopened = new KnowledgeStore({ dbPath: join(f.root, '.goodvibes', 'knowledge.sqlite') }); const storage = await reopened.openNativeWorkExecutionStorage('project');
    const current = storage.current(f.key); expect(current.ledger.revision).toBe(failure === 'after-rename' ? 4 : 2);
    expect(current.ledger.history.filter(event => event.type === 'report').length).toBe(current.ledger.evidence.length);
    const replacement = createNativeWorkExecutionHost({ ...f.hostOptions, storage }); replacement.attachRunner(f.harness.runner);
    try {
      const receipt = await replacement.settle(f.key, f.authority);
      if (failure === 'after-rename') expect(receipt).toEqual(current.settlement!);
      expect(storage.current(f.key).ledger.revision).toBe(4); expect(f.harness.agentsOf('u1')).toHaveLength(1);
    } finally { await replacement.close(); await reopened.close(); }
  });
}

test('the real provider loop corrects an original unmet answer before terminal output-only verification', async () => {
  const provider = nativeExecutionProvider(['[unmet] incomplete answer', 'Corrected complete original answer']);
  const f = await fixture({ harness: { executeAgent: provider.executeAgent, port: context => context.name === 'forbids_writing' ? noulAnswer(0.99) : undefined } });
  const started = await f.host.start(f.target, f.authority); const contract = await completed(f.harness, started.admission.contractId);
  expect(contract.status).toBe('passed'); expect(provider.requests.length).toBeGreaterThanOrEqual(2);
  const receipt = await f.host.settle(f.key, f.authority); expect(receipt.attestation.outcome).toBe('verified');
  expect(receipt.attestation.references.filter(item => item.kind === 'artifact')).toHaveLength(0);
});

test('real worktree completion verifies applied owner-tree artifacts; application failure never verifies', async () => {
  const f = await fixture({ harness: { contract: { isolation: 'worktree', autoCommit: false } } });
  const started = await f.host.start(f.target, f.authority); const contract = await completed(f.harness, started.admission.contractId);
  expect(contract.isolation).toBe('worktree'); expect(contract.commit?.status).toBe('applied');
  expect((await f.host.settle(f.key, f.authority)).attestation.outcome).toBe('verified');
  const g = await fixture(); const second = await g.host.start(g.target, g.authority); await completed(g.harness, second.admission.contractId);
  const record = g.storage.current(g.key).record!;
  await expect(verifyNativeWorkExecution({ execution: record, runner: { join: g.harness.runner.join, get: id => ({ ...g.harness.runner.get(id)!, commit: { status: 'failed', note: 'Synthetic apply failure' } }) }, port: g.hostOptions.port, decisionLog: g.log, settings: checkSettings(CONTRACT_CONFIG_DEFAULTS), readAccessFilter: async () => true, signal: new AbortController().signal, assertCurrent() {} })).rejects.toThrow('not applied');
  expect(g.storage.current(g.key).ledger.revision).toBe(2);
});

test('the complete original source is captured before the first borrowed join hook', async () => {
  const f = await fixture(); const started = await f.host.start(f.target, f.authority); await completed(f.harness, started.admission.contractId);
  const mutable = structuredClone(f.storage.current(f.key).record!);
  const expectedGoal = mutable.request.input.nativeSource!.goal; const expectedCriteria = [...mutable.request.input.nativeSource!.criteria];
  const proof = await verifyNativeWorkExecution({ execution: mutable, runner: { get: f.harness.runner.get, async join(id) {
    Object.assign(mutable.request.input.nativeSource!, { goal: 'Rewritten after the verifier started', criteria: ['Omit every original criterion'] });
    await f.harness.runner.join(id);
  } }, port: f.hostOptions.port, decisionLog: f.log, settings: checkSettings(CONTRACT_CONFIG_DEFAULTS), readAccessFilter: async () => true, signal: new AbortController().signal, assertCurrent() {} });
  expect(proof.attestation.outcome).toBe('verified'); expect(proof.attestation.criteriaResults).toHaveLength(expectedCriteria.length);
  expect(expectedGoal).toBe(f.work.goal); expect(expectedCriteria).toEqual(f.work.criteria);
});

for (const mutation of ['revise', 'handoff', 'cancel', 'scope'] as const) test(`${mutation} during verification prevents late evidence without replaying the runner`, async () => {
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({ decoratePort: port => ({ ...port, async ask(request) { if (request.context?.site === 'contract.check.unit-judge') { entered(); await hold; } return port.ask(request); } }) });
  const started = await f.host.start(f.target, f.authority); await completed(f.harness, started.admission.contractId);
  const pending = f.host.settle(f.key, f.authority); await ready;
  try {
    if (mutation === 'scope') {
      const file = join(f.root, '.goodvibes', 'registrations.json'); const contents = readFileSync(file, 'utf8');
      const original = f.scopes.currentScope(f.root).scopeRevision;
      // Owned fixture generation changes through the current owner API below.
      await f.scopes.remove(f.root); await f.scopes.add(f.root); expect(f.scopes.currentScope(f.root).scopeRevision).not.toBe(original);
      expect(readFileSync(file, 'utf8')).not.toBe(contents);
    } else {
      const command = mutation === 'revise' ? { type: 'revise' as const, title: f.work.title, goal: f.work.goal, criteria: [...f.work.criteria].reverse() }
        : mutation === 'handoff' ? { type: 'handoff' as const, attemptId: f.target.attemptId, targetActorId: 'new-owner', reason: 'Synthetic handoff' }
        : { type: 'cancel' as const, reason: 'Synthetic cancellation' };
      expect(await f.ledger.service.execute({ ...command, requestId: `during-${mutation}`, expectedRevision: 2, workId: f.work.id }, f.actor)).toMatchObject({ kind: 'accepted' });
    }
  } finally { release(); }
  await expect(pending).rejects.toThrow(); expect(f.storage.current(f.key).ledger.evidence).toHaveLength(0); expect(f.storage.current(f.key).settlement).toBeNull();
  expect(f.harness.agentsOf('u1')).toHaveLength(1);
});

test('restricted artifact reads and absent recorded proof remain unavailable, without partial publication', async () => {
  let allowed = true;
  const f = await fixture({ harness: { readAccessFilter: async () => allowed } });
  const started = await f.host.start(f.target, f.authority); await completed(f.harness, started.admission.contractId); allowed = false;
  await expect(f.host.settle(f.key, f.authority)).rejects.toThrow('access-restricted'); expect(f.storage.current(f.key).ledger.revision).toBe(2);
  allowed = true;
  const record = f.storage.current(f.key).record!;
  await expect(verifyNativeWorkExecution({ execution: record, runner: f.harness.runner, port: f.hostOptions.port, decisionLog: { get: () => undefined }, settings: checkSettings(CONTRACT_CONFIG_DEFAULTS), readAccessFilter: async () => true, signal: new AbortController().signal, assertCurrent() {} })).rejects.toThrow('genuine');
});

test('independent quality and exact recorded state are required even when every original criterion reads met', async () => {
  const f = await fixture({ settlementAnswers: context => context.name === 'hidden_failure' ? noulAnswer(0.99) : undefined });
  const started = await f.host.start(f.target, f.authority); await completed(f.harness, started.admission.contractId);
  const receipt = await f.host.settle(f.key, f.authority); expect(receipt.attestation.outcome).toBe('failed');
  expect(receipt.attestation.criteriaResults.every(item => item.status === 'satisfied')).toBe(true);
  let copied: string | undefined;
  const g = await fixture({ decoratePort: port => ({ ...port, async ask(request) {
    const result = await port.ask(request); return request.context?.site === 'contract.check.unit-judge' && copied ? { ...result, decisionId: copied } : result;
  } }) });
  const second = await g.host.start(g.target, g.authority); const contract = await completed(g.harness, second.admission.contractId);
  copied = contract.units[0]!.checks.at(-1)!.decisionIds[0];
  await expect(g.host.settle(g.key, g.authority)).rejects.toThrow('provenance'); expect(g.storage.current(g.key).ledger.evidence).toHaveLength(0);
});

test('a freshly reconstructed terminal runner verifies without restoring an execution owner or replaying effects', async () => {
  const f = await fixture(); const started = await f.host.start(f.target, f.authority); await completed(f.harness, started.admission.contractId);
  f.harness.store.flush(); await f.host.close();
  const reopened = new KnowledgeStore({ dbPath: join(f.root, '.goodvibes', 'knowledge.sqlite') }); const storage = await reopened.openNativeWorkExecutionStorage('project');
  const host = createNativeWorkExecutionHost({ ...f.hostOptions, storage });
  const restarted = makeHarness({ root: f.root, scripts: { u1: () => { throw new Error('Restart must not execute'); } }, decisionLog: f.log,
    nativeDecisions: host.nativeOwner.decisions, durableAdmission: host.nativeOwner.admission });
  host.attachRunner({ ...restarted.runner, startDurable: async () => { throw new Error('No restart launch'); }, resumeDurable: async () => { throw new Error('No restart resume'); } });
  try {
    const admissionPath = join(f.root, '.goodvibes', 'contracts', 'admissions', `${durableKeyHash(f.key)}.json`); const original = readFileSync(admissionPath);
    expect(host.status(f.key, f.authority).contract?.status).toBe('passed');
    expect(host.status(f.key, f.authority).settlement?.state).toBe('required'); expect(readFileSync(admissionPath)).toEqual(original);
    const receipt = await host.settle(f.key, f.authority); expect(receipt.attestation.outcome).toBe('verified');
    expect(restarted.manager.list()).toHaveLength(0); expect(f.harness.agentsOf('u1')).toHaveLength(1);
  } finally { await host.close(); restarted.dispose(); await reopened.close(); }
});

test('cancelling a running automatic settlement cancels execution before joining its verifier', async () => {
  const f = await fixture({ automatic: true, harness: { scripts: { u1: () => [{ text: 'waiting', stop: { kind: 'hang' } }] } } });
  const started = await f.host.start(f.target, f.authority); await waitFor(() => f.harness.agentsOf('u1').length === 1, 'running automatic native work');
  await f.host.cancel(f.key, f.authority, 'Synthetic cancellation');
  expect(f.harness.runner.get(started.admission.contractId)?.status).toBe('cancelled');
  expect(f.storage.current(f.key).settlement).toBeNull(); expect(f.storage.current(f.key).ledger.evidence).toHaveLength(0);
});

test('an omitted original checkpoint criterion cannot produce any attestation', async () => {
  const f = await fixture(); const started = await f.host.start(f.target, f.authority); await completed(f.harness, started.admission.contractId);
  await expect(verifyNativeWorkExecution({ execution: f.storage.current(f.key).record!, runner: { join: f.harness.runner.join, get: id => { const contract = f.harness.runner.get(id)!; return { ...contract, criteria: contract.criteria.slice(0, 1) }; } },
    port: f.hostOptions.port, decisionLog: f.log, settings: checkSettings(CONTRACT_CONFIG_DEFAULTS), readAccessFilter: async () => true, signal: new AbortController().signal, assertCurrent() {} })).rejects.toThrow();
});

test('a persisted passed checkpoint cannot settle while another execution lease still owns effects', async () => {
  const f = await fixture(); const started = await f.host.start(f.target, f.authority); await completed(f.harness, started.admission.contractId);
  const release = await new DurableContractAdmissions(f.root).lease(f.key);
  try { await expect(f.host.settle(f.key, f.authority)).rejects.toThrow(); expect(f.storage.current(f.key).ledger.evidence).toHaveLength(0); }
  finally { release(); }
  expect((await f.host.settle(f.key, f.authority)).attestation.outcome).toBe('verified'); expect(f.harness.agentsOf('u1')).toHaveLength(1);
});

test('terminal settlement uses shared retry ownership and cancellation interrupts retry-after without late publication', async () => {
  let retried!: () => void; const waiting = new Promise<void>(resolve => { retried = resolve; }); let calls = 0;
  const retry = createSystemOnePort({ endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:1', apiKey: 'synthetic-fixture' }, model: PINNED_MODEL, timeoutMs: 100,
    retry: { backoffInitialMs: 1, backoffMaxMs: 1, backoffJitter: 0 }, fetch: async () => { calls++; return Response.json({}, { status: 503, headers: { 'retry-after': '3600' } }); } });
  let f!: Awaited<ReturnType<typeof fixture>>;
  f = await fixture({ decoratePort: port => ({ ...port, ask: request => request.context?.site === 'contract.check.unit-judge'
    ? withDecisionLog(retry, f.log).ask({ ...request, onRetry(progress) { retried(); request.onRetry?.(progress); } }) : port.ask(request) }) });
  const started = await f.host.start(f.target, f.authority); await completed(f.harness, started.admission.contractId);
  const pending = f.host.settle(f.key, f.authority).catch(error => error); await waiting;
  await f.host.cancel(f.key, f.authority, 'Synthetic settlement backoff cancellation'); expect(await pending).toBeInstanceOf(Error);
  expect(calls).toBe(1); expect(f.storage.current(f.key).ledger.evidence).toHaveLength(0);
}, 5000);

test('current paired authority is rechecked before a shared transport retry', async () => {
  let f!: Awaited<ReturnType<typeof fixture>>; let calls = 0;
  const retry = createSystemOnePort({ endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:1', apiKey: 'synthetic-fixture' }, model: PINNED_MODEL, timeoutMs: 100,
    retry: { backoffInitialMs: 5, backoffMaxMs: 5, backoffJitter: 0 }, fetch: async () => { calls++; f.tokens.revoke(f.paired.id); return Response.json({}, { status: 503 }); } });
  f = await fixture({ decoratePort: port => ({ ...port, ask: request => request.context?.site === 'contract.check.unit-judge' ? withDecisionLog(retry, f.log).ask(request) : port.ask(request) }) });
  const started = await f.host.start(f.target, f.authority); await completed(f.harness, started.admission.contractId);
  await expect(f.host.settle(f.key, f.authority)).rejects.toThrow(); expect(calls).toBe(1); expect(f.storage.current(f.key).ledger.evidence).toHaveLength(0);
}, 5000);

test('returned passing answers cannot launder a recorded failing criterion', async () => {
  const f = await fixture({ settlementAnswers: context => context.name === 'criterion_1' ? noulAnswer(0.99) : undefined,
    decoratePort: port => ({ ...port, async ask(request) {
      const result = await port.ask(request);
      if (request.context?.site !== 'contract.check.unit-judge') return result;
      const answers = Object.fromEntries(Object.entries(request.questions).map(([name, question]) => [name, question.type === 'noul' ? noulAnswer(0.01) : result.answers[name as keyof typeof result.answers]])) as typeof result.answers;
      return { ...result, answers };
    } }) });
  const started = await f.host.start(f.target, f.authority); await completed(f.harness, started.admission.contractId);
  await expect(f.host.settle(f.key, f.authority)).rejects.toThrow('provenance');
  expect(f.storage.current(f.key).ledger.revision).toBe(2); expect(f.storage.current(f.key).settlement).toBeNull();
});

test('deleted artifacts remain provable when their former parent directory is also absent', async () => {
  let f!: Awaited<ReturnType<typeof fixture>>;
  f = await fixture({ source: { goal: 'Remove the obsolete directory.', criteria: ['The obsolete directory and its old.txt file are absent.'] },
    harness: { contract: { midRunChecks: false }, scripts: { u1: record => [{ text: 'Remove the obsolete content.', tool: true, after: async () => { rmSync(join(record.workingDirectory ?? f.root, 'obsolete'), { recursive: true }); } }, { text: 'Removed obsolete/old.txt and its empty directory.' }] } } });
  mkdirSync(join(f.root, 'obsolete')); writeFileSync(join(f.root, 'obsolete', 'old.txt'), 'obsolete fixture content');
  const started = await f.host.start(f.target, f.authority); const contract = await completed(f.harness, started.admission.contractId);
  if (contract.status !== 'passed') throw new Error(JSON.stringify({ status: contract.status, error: contract.error, statusLine: contract.statusLine, decisions: contract.decisions.slice(-5), checks: contract.units.map(unit => unit.checks.at(-1)) }));
  expect(contract.units[0]?.touchedPaths).toContain('obsolete/old.txt');
  const receipt = await f.host.settle(f.key, f.authority);
  expect(receipt.attestation.outcome).toBe('verified'); expect(receipt.attestation.references.some(item => item.ref.endsWith(':obsolete/old.txt') && item.digest)).toBe(true);
});

test('a declared passed checkpoint cannot cite recorded failing prior checks', async () => {
  const f = await fixture(); const started = await f.host.start(f.target, f.authority); const contract = await completed(f.harness, started.admission.contractId);
  const judgeId = contract.units[0]!.checks.at(-1)!.decisionIds[0]!;
  await expect(verifyNativeWorkExecution({ execution: f.storage.current(f.key).record!, runner: f.harness.runner, port: f.hostOptions.port,
    decisionLog: { get(id) { const entry = f.log.get(id); return id === judgeId && entry?.status === 'answered' ? { ...entry, answers: { goal: noulAnswer(0.99), criterion_0: noulAnswer(0.99), criterion_1: noulAnswer(0.99) } } : entry; } },
    settings: checkSettings(CONTRACT_CONFIG_DEFAULTS), readAccessFilter: async () => true, signal: new AbortController().signal, assertCurrent() {} })).rejects.toThrow('genuine');
});

test('binary artifacts count raw bytes toward the aggregate host capture bound', async () => {
  const content = '\0'.repeat(11 * 1024 * 1024);
  const f = await fixture({ harness: { scripts: { u1: () => [{ files: { 'src/one.bin': content, 'src/two.bin': content }, text: 'Produced two binary artifacts.' }] } } });
  const started = await f.host.start(f.target, f.authority); const contract = await completed(f.harness, started.admission.contractId);
  expect(contract.status).toBe('passed');
  await expect(f.host.settle(f.key, f.authority)).rejects.toThrow('total budget'); expect(f.storage.current(f.key).ledger.evidence).toHaveLength(0);
});

test('borrowed answer mutation after return cannot change the frozen recorded verdict', async () => {
  const f = await fixture({ settlementAnswers: context => context.name === 'criterion_1' ? noulAnswer(0.99) : undefined,
    decoratePort: port => ({ ...port, async ask(request) {
      const result = await port.ask(request);
      if (request.context?.site !== 'contract.check.unit-judge') return result;
      const answers = structuredClone(result.answers);
      queueMicrotask(() => queueMicrotask(() => { Object.assign(answers, { criterion_1: noulAnswer(0.01) }); }));
      return { ...result, answers };
    } }) });
  const started = await f.host.start(f.target, f.authority); await completed(f.harness, started.admission.contractId);
  const receipt = await f.host.settle(f.key, f.authority); expect(receipt.attestation.outcome).toBe('failed'); expect(receipt.attestation.criteriaResults[1]?.status).toBe('unsatisfied');
});

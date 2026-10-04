import * as nativeFs from 'node:fs';
import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer, scoreAnswer } from '@goodvibes-jev/judgment/testing';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { KnowledgeStore } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import { createClientRuntimeServices } from '@goodvibes-jev/engine/sdk/platform/runtime/client-services';
import { AgentOrchestrator } from '@goodvibes-jev/engine/sdk/platform/agents';
import { AgentManager, type AgentRecord } from '@goodvibes-jev/engine/sdk/platform/tools';
import { RuntimeEventBus } from '@goodvibes-jev/engine/sdk/platform/runtime/state';
import { createRuntimeStore } from '@goodvibes-jev/engine/sdk/platform/runtime/store';
import { BenchmarkStore, ProviderRegistry, type ModelDefinition } from '@goodvibes-jev/engine/sdk/platform/providers';
import type { LLMProvider, ChatRequest, ChatResponse } from '@goodvibes-jev/engine/sdk/platform/providers';
import { createWorkLedger, createLocalWorkLedgerReadBinding } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger';
import { PairingTokenManager } from '@goodvibes-jev/engine/sdk/platform/pairing';
import { registerNativeWorkExecutionGatewayMethods, registerWorkLedgerGatewayMethods } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { createOperatorSdk } from '@goodvibes-jev/engine/operator-sdk';
import { createOperatorNativeWorkExecutionClient } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution-client';
import { registerInboxSurface } from '@goodvibes-jev/engine/sdk/platform/intake';
import { WorkspaceRegistrationStore } from '@goodvibes-jev/engine/sdk/platform/workspace';
import type { NativePairedExecutionAuthority } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution';
import { createDaemonNativeWorkExecutionActivation } from '../../runtime/native-work-execution-activation.js';
import * as nativeComposition from '../../runtime/native-work-execution-composition.js';
import * as activationComposition from '../../runtime/native-work-execution-activation.js';
import * as runtimeComposition from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';
import { startDaemonFixture } from '../../testing/daemon-fixture.js';

async function waitFor(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
const answer = (content: string): ChatResponse => ({ content, toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'completed' });

async function fixture(pairingOwner?: PairingTokenManager) {
  const root = makeOwnedTempDir('native-activation'); const workspace = join(root, 'workspace');
  mkdirSync(workspace); writeFileSync(join(workspace, 'README.md'), '# Owned native fixture\n');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture']])
    if (spawnSync('git', args, { cwd: workspace }).status !== 0) throw new Error('Fixture git failed');
  const configManager = new ConfigManager({ workingDir: workspace, homeDir: root, configDir: join(root, 'config'), surfaceRoot: 'daemon' });
  const runtimeBus = new RuntimeEventBus();
  const services = createClientRuntimeServices({ configManager, runtimeBus, runtimeStore: createRuntimeStore(),
    surfaceRoot: 'daemon', workingDir: workspace, homeDirectory: root, requestApproval: async () => ({ approved: false }), modelDiscovery: 'skip' });
  const log = new SqliteDecisionLog(join(root, 'decisions.sqlite'));
  const readings = fakePort((name, question) => {
    if (question.type === 'noul') return noulAnswer(name === 'forbids_delegation' || name === 'checkable' || name.startsWith('fit') ? 0.99 : 0.01);
    if (question.type === 'score') return scoreAnswer(question, 0, 0.99);
    const choices = question.type === 'choice' ? Object.keys(question.criteria) : [];
    const preferred: Record<string, string> = { disposition: 'act', relation: 'supports', role: 'research', tier: 'standard', intent: 'chat', strategy: 'single', category: 'unknown', connection_failure: 'none' };
    const pick = preferred[name];
    return choiceAnswer(question, pick && choices.includes(pick) ? pick : choices.find(key => key !== 'none')!, 0.99);
  });
  const port = withDecisionLog(readings.port, log); const previous = installJudgmentPort(port);
  const goal = 'Answer the native request yourself without delegation. Preserve the complete original request.';
  const criteria = ['The answer says native execution is complete.'];
  const plan = { goal, criteria: [{ id: 'c1', text: criteria[0], quote: criteria[0] }], groups: [{
    id: 'g1', title: 'Answer', goal, kind: 'work', dependsOn: [], criteria: [], units: [{ id: 'u1', title: 'Answer', goal,
      role: 'research', brief: 'Say native execution is complete.', dependsOn: [], files: [], criteria: [{ id: 'u1.c1', text: criteria[0], serves: ['c1'] }] }],
  }] };
  const requests: ChatRequest[] = [];
  let hold: ((request: ChatRequest) => Promise<ChatResponse>) | undefined;
  const provider = { name: 'native-fixture', models: ['model'], credentialAuthority: 'anonymous', modelSource: { kind: 'dated-static', asOf: '2026-01-01' },
    isConfigured: () => true, async chat(request: ChatRequest) {
      requests.push(request);
      if (request.systemPrompt?.includes('You plan a contract')) return answer(`\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``);
      return hold ? hold(request) : answer('native execution is complete');
    } } as unknown as LLMProvider;
  const model = { id: 'model', provider: 'native-fixture', registryKey: 'native-fixture:model', displayName: 'Native fixture model', description: 'Synthetic test model',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 100000, selectable: true, tier: 'standard' } as unknown as ModelDefinition;
  services.providerRegistry.registerRuntimeProvider({ provider, models: [model], replace: true });
  // Routing must never select a built-in local proxy or make a live request.
  const catalog = spyOn(services.providerRegistry, 'listModels').mockReturnValue([model]);
  services.providerRegistry.setCurrentModel(model.registryKey);
  const knowledgeStore = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  let id = 0;
  const ledger = createWorkLedger({ projectId: 'project', storage: await knowledgeStore.openWorkLedgerStorage('project'),
    clock: { now: () => Date.now(), newId: kind => `${kind}-${++id}` } });
  const tokens = pairingOwner ?? new PairingTokenManager(join(root, 'pairing.json')); const paired = tokens.mint({ name: 'Synthetic fixture' });
  const scopesGranted = ['read:work-ledger', 'write:fleet'];
  const authority: NativePairedExecutionAuthority = {
    current() { const current = tokens.authenticateNative(paired.token); return current ? { ...current, scopes: scopesGranted } : null; },
    withCurrent(expected, callback) { return tokens.withNativeAuthority(paired.token, expected, assertCurrent => callback(() => ({ ...assertCurrent(), scopes: scopesGranted }))); },
  };
  const actor = ledger.authority.issueActor({ projectId: 'project', actorId: authority.current()!.principalId, role: 'coordinator' });
  const created = await ledger.service.execute({ type: 'create', expectedRevision: 0, requestId: 'create', title: 'Display title', goal, criteria }, actor);
  if (created.kind !== 'accepted' || created.event.type === 'import_legacy') throw new Error(`Fixture create failed: ${JSON.stringify(created)}`);
  const claimed = await ledger.service.execute({ type: 'claim', expectedRevision: 1, requestId: 'claim', workId: created.event.workId }, actor);
  if (claimed.kind !== 'accepted' || claimed.event.type === 'import_legacy') throw new Error('Fixture claim failed');
  const work = claimed.event.work; const attempt = claimed.event.attempts[0]!;
  const target = { workId: work.id, workRevision: work.revision, criteriaRevision: work.criteriaRevision, attemptId: attempt.id, attemptRevision: attempt.revision };
  const scopes = new WorkspaceRegistrationStore({ path: join(root, 'registrations.json'), homeDir: root, daemonStateDir: join(root, '.goodvibes') });
  await scopes.add(workspace);
  const options = { runtimeBus, configManager, providerRegistry: services.providerRegistry, projectRoot: workspace,
    projectId: 'project', sessionId: 'native-fixture', knowledgeStore, nativeScopes: scopes, judgmentPort: port, decisionLog: log,
    acpHost: { list: () => [] }, permissionManager: services.permissionManager, hookDispatcher: services.hookDispatcher, featureFlags: services.featureFlags,
    toolDependencies: { ...services, contractHooks: services.contractRunner.hooks(), workflowServices: services.workflow } };
  const activation = createDaemonNativeWorkExecutionActivation(options);
  return { root, activation, options, services, target, authority, paired, requests, readings, log, goal, criteria,
    hold(fn: typeof hold) { hold = fn; },
    async anotherTarget() {
      const revision = (await ledger.service.readSnapshot(actor)).revision;
      const created = await ledger.service.execute({ type: 'create', expectedRevision: revision, requestId: `create-${revision}`, title: 'Another display title', goal, criteria }, actor);
      if (created.kind !== 'accepted' || created.event.type === 'import_legacy') throw new Error('Second fixture create failed');
      const claimed = await ledger.service.execute({ type: 'claim', expectedRevision: revision + 1, requestId: `claim-${revision}`, workId: created.event.workId }, actor);
      if (claimed.kind !== 'accepted' || claimed.event.type === 'import_legacy') throw new Error('Second fixture claim failed');
      const work = claimed.event.work; const attempt = claimed.event.attempts[0]!;
      return { workId: work.id, workRevision: work.revision, criteriaRevision: work.criteriaRevision, attemptId: attempt.id, attemptRevision: attempt.revision };
    },
    async close() { await activation.close(); await ledger.service.close(); await knowledgeStore.close(); catalog.mockRestore(); installJudgmentPort(previous); services.dispose(); log[Symbol.dispose](); } };
}

test('native activation stays lazy, single-flights its separate manager and retains the real read owner', async () => {
  const discovery = spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]);
  const benchmarks = spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue(undefined);
  const compose = spyOn(nativeComposition, 'createDaemonNativeWorkExecutionServices');
  const f = await fixture();
  try {
    expect(compose).not.toHaveBeenCalled();
    const [first, second] = await Promise.all([f.activation.acquire(), f.activation.acquire()]);
    expect(first).toBe(second); expect(compose).toHaveBeenCalledTimes(1);
    const args = compose.mock.calls[0]![0];
    expect(args.agentManager).not.toBe(f.services.agentManager);
    expect(args.judgmentPort).toBe(f.options.judgmentPort); expect(args.decisionLog).toBe(f.log);
    const read = spyOn(f.services.permissionManager, 'readAccess').mockResolvedValue('restricted');
    try { expect(await args.readAccessFilter('/synthetic-denied')).toBe(false); expect(read).toHaveBeenCalledWith('/synthetic-denied'); }
    finally { read.mockRestore(); }
    expect(f.services.contractRunner.nativeMode).toBe(false);
    expect(f.services.contractRunner.list({ includeTerminal: true })).toEqual([]);
    await f.activation.close(); await expect(f.activation.acquire()).rejects.toMatchObject({ code: 'closed' });
  } finally { await f.close(); compose.mockRestore(); benchmarks.mockRestore(); discovery.mockRestore(); }
});

test('an admitted no-delegation native unit executes through a real foreground turn and completion checks', async () => {
  const discovery = spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]);
  const benchmarks = spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue(undefined);
  const identities = spyOn(BenchmarkStore.prototype, 'readBenchmarks').mockResolvedValue(undefined);
  const f = await fixture();
  try {
    const execution = await f.activation.acquire();
    const started = await execution.start(f.target, f.authority);
    await waitFor(() => ['passed', 'failed', 'cancelled'].includes(execution.status(started.admission.key, f.authority).contract?.status ?? ''), 'native completion');
    const contract = execution.status(started.admission.key, f.authority).contract!;
    expect(contract.error).toBeUndefined(); expect(contract.status).toBe('passed'); expect(contract.sessionMode).toBe(true);
    expect(contract.nativeSource).toMatchObject({ goal: f.goal, criteria: f.criteria });
    const units = f.requests.filter(request => request.systemPrompt?.includes('Execute this existing native work unit yourself'));
    expect(units).toHaveLength(1);
    expect(units[0]!.messages.some(message => JSON.stringify(message).includes(f.goal))).toBe(true);
    expect(units[0]!.tools?.some(tool => ['agent', 'workflow', 'registry'].includes(tool.name))).toBe(false);
    expect(contract.units[0]!.checks.length).toBeGreaterThan(0);
    await waitFor(() => execution.status(started.admission.key, f.authority).settlement?.state === 'published', 'native revision-bound settlement');
    expect((await execution.settle(started.admission.key, f.authority)).attestation.outcome).toBe('verified');
    expect(f.services.agentManager.list()).toHaveLength(0);
    expect(f.services.contractRunner.list({ includeTerminal: true })).toHaveLength(0);
  } finally { await f.close(); identities.mockRestore(); benchmarks.mockRestore(); discovery.mockRestore(); }
}, 20000);

test('authenticated daemon HTTP handler acquires the real native graph and completes its foreground unit', async () => {
  const discovery = spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]);
  const benchmarks = spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue(undefined);
  const identities = spyOn(BenchmarkStore.prototype, 'readBenchmarks').mockResolvedValue(undefined);
  const nativeStorage = spyOn(KnowledgeStore.prototype, 'openNativeWorkExecutionStorage');
  const daemon = await startDaemonFixture({ root: makeOwnedTempDir('native-http-activation'),
    inboxFactory: (context, _routing, options) => registerInboxSurface(context, { ...options, adapters: new Map() }) });
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    expect(nativeStorage).not.toHaveBeenCalled();
    for (const operation of ['start', 'status', 'cancel', 'resume'])
      expect(daemon.services.gatewayMethods.hasHandler(`workLedger.execution.${operation}`)).toBe(true);
    expect(daemon.services.contractRunner.nativeMode).toBe(false);
    f = await fixture(daemon.services.pairingTokens);
    let acquisitions = 0;
    registerNativeWorkExecutionGatewayMethods(daemon.services.gatewayMethods, { projectId: 'project', acquire: () => { acquisitions++; return f!.activation.acquire(); } });
    const client = createOperatorNativeWorkExecutionClient(createOperatorSdk({ baseUrl: daemon.baseUrl, authToken: f.paired.token, retry: { maxAttempts: 1 } }), 'project');
    const identity = { workId: f.target.workId, attemptId: f.target.attemptId,
      expectedRevision: { work: f.target.workRevision, criteria: f.target.criteriaRevision, attempt: f.target.attemptRevision } };
    const started = await client.start(identity); if (started.kind !== 'execution') throw new Error('Expected admitted HTTP execution'); expect(started.receipt?.contractId).toBeTruthy();
    let status = started;
    const deadline = Date.now() + 10000;
    while (status.progress?.status !== 'passed' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10)); const current = await client.status(identity); if (current.kind !== 'execution') throw new Error('Expected admitted HTTP status'); status = current;
      if (status.progress?.status === 'failed' || status.progress?.status === 'cancelled') break;
    }
    expect(status.progress?.status).toBe('passed'); expect(status.progress?.sessionMode).toBe(true);
    while (status.settlement?.state !== 'published' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10)); const current = await client.status(identity); if (current.kind !== 'execution') throw new Error('Expected settled HTTP status'); status = current;
    }
    expect(status.settlement?.state).toBe('published');
    expect(acquisitions).toBeGreaterThan(0); expect(nativeStorage).toHaveBeenCalledTimes(1);
    expect(f.requests.some(request => request.systemPrompt?.includes('Execute this existing native work unit yourself'))).toBe(true);
    expect(daemon.services.agentManager.list()).toHaveLength(0);
  } finally { await f?.close(); await daemon.stop(); nativeStorage.mockRestore(); identities.mockRestore(); benchmarks.mockRestore(); discovery.mockRestore(); }
}, 20000);

for (const lostAcknowledgment of [false, true]) test(`authenticated cold daemon resume only settles terminal work${lostAcknowledgment ? ' after a lost publication acknowledgment' : ''}`, async () => {
  const discovery = spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]);
  const benchmarks = spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue(undefined);
  const identities = spyOn(BenchmarkStore.prototype, 'readBenchmarks').mockResolvedValue(undefined);
  const originalFactory = nativeComposition.createDaemonNativeWorkExecutionServices;
  let cold = false; let starts = 0; let resumes = 0;
  const factory = spyOn(nativeComposition, 'createDaemonNativeWorkExecutionServices').mockImplementation(async options => {
    const native = await originalFactory(options);
    if (cold) {
      native.runner.startDurable = async () => { starts++; throw new Error('Cold recovery must not start effects'); };
      native.runner.resumeDurable = async () => { resumes++; throw new Error('Cold recovery must not resume effects'); };
    }
    return native;
  });
  const daemonRoot = makeOwnedTempDir('native-http-settlement-restart');
  const daemonOptions: Parameters<typeof startDaemonFixture>[0] = { root: daemonRoot, inboxFactory: (context, _routing, options) => registerInboxSurface(context, { ...options, adapters: new Map() }) };
  let daemon = await startDaemonFixture(daemonOptions);
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  let recovered: { activation: ReturnType<typeof createDaemonNativeWorkExecutionActivation>; store: KnowledgeStore; log: SqliteDecisionLog; ledger: ReturnType<typeof createWorkLedger>; client: ReturnType<typeof createOperatorNativeWorkExecutionClient> } | undefined;
  try {
    f = await fixture(daemon.services.pairingTokens);
    const originalPort = f.options.judgmentPort;
    f.options.judgmentPort = { ...originalPort, async ask(request) {
      if (request.context?.site === 'contract.check.unit-judge') throw new Error('Owned unavailable automatic settlement');
      return originalPort.ask(request);
    } };
    registerNativeWorkExecutionGatewayMethods(daemon.services.gatewayMethods, { projectId: 'project', acquire: f.activation.acquire });
    const identity = { workId: f.target.workId, attemptId: f.target.attemptId,
      expectedRevision: { work: f.target.workRevision, criteria: f.target.criteriaRevision, attempt: f.target.attemptRevision } };
    const clientFor = () => createOperatorNativeWorkExecutionClient(createOperatorSdk({ baseUrl: daemon.baseUrl, authToken: f!.paired.token, retry: { maxAttempts: 1 } }), 'project');
    const initial = clientFor(); await initial.start(identity);
    const storage = await f.options.knowledgeStore.openNativeWorkExecutionStorage('project');
    const deadline = Date.now() + 10000;
    let before = await initial.status(identity);
    while (!(before.kind === 'execution' && before.progress?.status === 'passed' && before.settlement?.state === 'failed') && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10)); before = await initial.status(identity);
    }
    expect(before).toMatchObject({ kind: 'execution', progress: { status: 'passed' }, settlement: { state: 'failed' } });
    expect(storage.currentByAttempt(identity.attemptId).ledger.revision).toBe(2);
    expect(storage.currentByAttempt(identity.attemptId).settlement).toBeNull();
    await f.activation.close(); initial.dispose(); await storage.close();
    const providerCalls = f.requests.length;
    expect(f.requests.filter(request => request.systemPrompt?.includes('Execute this existing native work unit yourself'))).toHaveLength(1);
    cold = true;
    const reopen = async () => {
      if (recovered) { await recovered.activation.close(); await recovered.ledger.service.close(); await recovered.store.close(); recovered.log[Symbol.dispose](); }
      await daemon.stop(); daemon = await startDaemonFixture(daemonOptions);
      const store = new KnowledgeStore({ dbPath: join(f!.root, 'knowledge.sqlite') });
      const log = new SqliteDecisionLog(join(f!.root, 'decisions.sqlite'));
      const ledger = createWorkLedger({ projectId: 'project', storage: await store.openWorkLedgerStorage('project'), clock: { now: () => Date.now(), newId: () => { throw new Error('Recovery reads must not create ledger IDs'); } } });
      const activation = createDaemonNativeWorkExecutionActivation({ ...f!.options, knowledgeStore: store,
        nativeScopes: new WorkspaceRegistrationStore({ path: join(f!.root, 'registrations.json'), homeDir: f!.root, daemonStateDir: join(f!.root, '.goodvibes') }),
        judgmentPort: withDecisionLog(f!.readings.port, log), decisionLog: log });
      registerNativeWorkExecutionGatewayMethods(daemon.services.gatewayMethods, { projectId: 'project', acquire: activation.acquire });
      const binding = createLocalWorkLedgerReadBinding({ available: true, projectId: 'project', actorId: 'host:cold-reader', service: ledger.service, authority: ledger.authority });
      if (!binding.available) throw new Error('Owned cold ledger unavailable');
      registerWorkLedgerGatewayMethods(daemon.services.gatewayMethods, binding.client);
      return { activation, store, log, ledger, client: clientFor() };
    };
    recovered = await reopen(); let client = recovered.client;
    const readsBefore = f.readings.requests.length;
    for (let index = 0; index < 2; index++) {
      expect(await client.status(identity)).toMatchObject({ kind: 'execution', progress: { status: 'passed' }, settlement: { state: 'required' }, expectedRevision: identity.expectedRevision });
      const get = await fetch(`${daemon.baseUrl}/api/work-ledger/snapshot?projectId=project`, { headers: { Authorization: `Bearer ${f.paired.token}` } });
      expect(get.status).toBe(200); expect(await get.json()).toMatchObject({ revision: 2, works: [{ verification: { state: 'unverified' } }] });
    }
    expect(f.readings.requests).toHaveLength(readsBefore); expect(f.requests).toHaveLength(providerCalls);
    expect({ starts, resumes }).toEqual({ starts: 0, resumes: 0 });
    const coldStore = recovered.store;
    if (lostAcknowledgment) {
      const persistence = (coldStore as unknown as { sqlite: { persistence: { io: typeof nativeFs } } }).sqlite.persistence;
      let fileSynced = false; let failed = false;
      persistence.io = { ...nativeFs, fsyncSync(fd) {
        const directory = nativeFs.fstatSync(fd).isDirectory(); if (!directory) fileSynced = true;
        if (!failed && fileSynced && directory) { failed = true; throw new Error('Owned lost settlement acknowledgment'); }
        nativeFs.fsyncSync(fd);
      } };
      try { await expect(client.resume(identity)).rejects.toMatchObject({ status: 503 }); expect(failed).toBe(true); }
      finally { persistence.io = nativeFs; }
      client.dispose(); recovered = await reopen(); client = recovered.client;
      expect(await client.status(identity)).toMatchObject({ settlement: { state: 'published' }, expectedRevision: identity.expectedRevision, stale: true, currentAttempt: false });
    }
    const readsAfterLostAck = f.readings.requests.length;
    const settled = await client.resume(identity);
    expect(settled).toMatchObject({ kind: 'execution', settlement: { state: 'published' }, expectedRevision: identity.expectedRevision, stale: true, currentAttempt: false });
    expect(settled.currentRevision).not.toEqual(identity.expectedRevision);
    if (lostAcknowledgment) expect(f.readings.requests).toHaveLength(readsAfterLostAck);
    else expect(f.readings.requests.length).toBeGreaterThan(readsBefore);
    const settledReadings = f.readings.requests.length;
    expect(await client.resume(identity)).toEqual(settled);
    expect(await client.status(identity)).toEqual(settled);
    await expect(client.resume({ ...identity, expectedRevision: settled.currentRevision! })).rejects.toMatchObject({ status: 409 });
    const durable = await recovered.store.openNativeWorkExecutionStorage('project'); const current = durable.currentByAttempt(identity.attemptId);
    expect(current.ledger.revision).toBe(4); expect(current.ledger.evidence).toHaveLength(1);
    expect(current.ledger.history.map(event => event.type)).toEqual(['create', 'claim', 'report', 'record_evidence']);
    expect(current.settlement?.attestation.outcome).toBe('verified');
    expect(f.readings.requests).toHaveLength(settledReadings); expect(f.requests).toHaveLength(providerCalls);
    expect({ starts, resumes }).toEqual({ starts: 0, resumes: 0 });
    expect(recovered.activation.fleetOwnership().some(item => item.active)).toBe(false);
    await durable.close(); client.dispose();
  } finally {
    if (recovered) { await recovered.activation.close(); await recovered.ledger.service.close(); await recovered.store.close(); recovered.log[Symbol.dispose](); }
    await f?.close(); await daemon.stop(); factory.mockRestore(); identities.mockRestore(); benchmarks.mockRestore(); discovery.mockRestore();
  }
}, 30000);

test('concurrent accepted no-delegation work binds each foreground turn to its own contract', async () => {
  const benchmarks = spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue(undefined);
  const identities = spyOn(BenchmarkStore.prototype, 'readBenchmarks').mockResolvedValue(undefined);
  const f = await fixture();
  let release!: () => void; const ready = new Promise<void>(resolve => { release = resolve; });
  f.hold(async () => { await ready; return answer('native execution is complete'); });
  try {
    const next = await f.anotherTarget(); const execution = await f.activation.acquire();
    // Native authority owner locks serialize admission. Both accepted works
    // remain live together, and the second waits for the one foreground slot.
    const started = [await execution.start(f.target, f.authority), await execution.start(next, f.authority)];
    try { await waitFor(() => started.every(item => execution.status(item.admission.key, f.authority).contract?.sessionMode === true), 'two live native session units'); }
    catch (error) { throw new Error(`${String(error)}: ${JSON.stringify(started.map(item => execution.status(item.admission.key, f.authority).contract))}`); }
    release();
    await waitFor(() => started.every(item => ['passed', 'failed', 'cancelled'].includes(execution.status(item.admission.key, f.authority).contract?.status ?? '')), 'two native completions');
    for (const item of started) {
      const contract = execution.status(item.admission.key, f.authority).contract!;
      expect(contract.error).toBeUndefined(); expect(contract.status).toBe('passed');
      expect(contract.units[0]!.checks.length).toBeGreaterThan(0);
      await waitFor(() => execution.status(item.admission.key, f.authority).settlement?.state === 'published', 'native revision-bound settlement');
      expect((await execution.settle(item.admission.key, f.authority)).attestation.outcome).toBe('verified');
    }
    expect(f.requests.filter(request => request.systemPrompt?.includes('Execute this existing native work unit yourself'))).toHaveLength(2);
    expect(f.services.agentManager.list()).toHaveLength(0);
  } finally { release(); await f.close(); identities.mockRestore(); benchmarks.mockRestore(); }
}, 20000);

test.each(['cancel', 'close'] as const)('native %s fences immediately and waits for foreground provider cleanup', async method => {
  const benchmarks = spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue(undefined);
  const identities = spyOn(BenchmarkStore.prototype, 'readBenchmarks').mockResolvedValue(undefined);
  const f = await fixture();
  let release!: () => void; const cleanup = new Promise<void>(resolve => { release = resolve; });
  let entered = false; let aborted = false;
  f.hold(async request => {
    entered = true;
    await new Promise<void>(resolve => { if (request.signal?.aborted) resolve(); else request.signal?.addEventListener('abort', () => resolve(), { once: true }); });
    aborted = true; await cleanup; return answer('cancelled provider cleanup finished');
  });
  try {
    const execution = await f.activation.acquire(); const started = await execution.start(f.target, f.authority);
    await waitFor(() => entered, 'foreground provider entered');
    let ended = false;
    const stopping = method === 'cancel' ? execution.cancel(started.admission.key, f.authority, 'Fixture cancel') : f.activation.close();
    void stopping.then(() => { ended = true; });
    await waitFor(() => aborted, 'foreground abort');
    expect(ended).toBe(false);
    if (method === 'close') await expect(f.activation.acquire()).rejects.toMatchObject({ code: 'closed' });
    release(); await stopping; expect(ended).toBe(true);
    if (method === 'cancel') expect(execution.status(started.admission.key, f.authority).contract?.status).toBe('cancelled');
  } finally { release(); await f.close(); identities.mockRestore(); benchmarks.mockRestore(); }
}, 20000);

test('native foreground tools use the real registry and original autonomous source', async () => {
  const benchmarks = spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue(undefined);
  const identities = spyOn(BenchmarkStore.prototype, 'readBenchmarks').mockResolvedValue(undefined);
  const f = await fixture(); let calls = 0;
  f.hold(async () => calls++ === 0 ? { ...answer(''), stopReason: 'tool_call',
    toolCalls: [{ id: 'native-read', name: 'read', arguments: { files: [{ path: 'README.md' }] } }] } : answer('native execution is complete'));
  try {
    const execution = await f.activation.acquire(); const started = await execution.start(f.target, f.authority);
    await waitFor(() => ['passed', 'failed', 'cancelled'].includes(execution.status(started.admission.key, f.authority).contract?.status ?? ''), 'native tool completion');
    expect(execution.status(started.admission.key, f.authority).contract?.status).toBe('passed');
    const requests = f.requests.filter(request => request.systemPrompt?.includes('Execute this existing native work unit yourself'));
    expect(requests).toHaveLength(2); expect(JSON.stringify(requests[1]!.messages)).toContain('Owned native fixture');
    const judgments = f.log.query({ site: 'engine.gate.autonomous-tool' });
    expect(judgments.length).toBeGreaterThan(0);
    const inputs = f.readings.requests.filter(request => request.context?.site === 'engine.gate.autonomous-tool');
    expect(JSON.stringify(inputs)).toContain(f.goal); expect(JSON.stringify(inputs)).toContain(f.criteria[0]!);
  } finally { await f.close(); identities.mockRestore(); benchmarks.mockRestore(); }
}, 20000);

test('ordinary automatic resume holds native records for inspection without launching them', async () => {
  const benchmarks = spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue(undefined);
  const identities = spyOn(BenchmarkStore.prototype, 'readBenchmarks').mockResolvedValue(undefined);
  const f = await fixture(); const spawn = spyOn(f.services.agentManager, 'spawn');
  try {
    const execution = await f.activation.acquire(); const started = await execution.start(f.target, f.authority);
    const report = await f.services.contractRunner.resumeAll();
    expect(report.skipped).toContain(started.admission.contractId);
    expect(f.services.contractRunner.nativeMode).toBe(false); expect(spawn).not.toHaveBeenCalled();
    await waitFor(() => ['passed', 'failed', 'cancelled'].includes(execution.status(started.admission.key, f.authority).contract?.status ?? ''), 'native completion after legacy resume');
    expect(execution.status(started.admission.key, f.authority).contract?.status).toBe('passed');
    expect(spawn).not.toHaveBeenCalled();
  } finally { spawn.mockRestore(); await f.close(); identities.mockRestore(); benchmarks.mockRestore(); }
}, 20000);

test('failed lazy construction releases its private graph and can retry without replacing ordinary owners', async () => {
  const benchmarks = spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue(undefined);
  const f = await fixture(); const failure = new Error('Synthetic native graph dependency failure');
  const dependencies = spyOn(AgentOrchestrator.prototype, 'setDependencies').mockImplementation(() => { throw failure; });
  const dispose = spyOn(AgentOrchestrator.prototype, 'dispose');
  try {
    await expect(f.activation.acquire()).rejects.toBe(failure); expect(dispose).toHaveBeenCalledTimes(1);
    expect(f.services.contractRunner.nativeMode).toBe(false); expect(f.services.agentManager.list()).toHaveLength(0);
    dependencies.mockRestore(); expect(await f.activation.acquire()).toBeDefined();
  } finally { dependencies.mockRestore(); dispose.mockRestore(); await f.close(); benchmarks.mockRestore(); }
});

test('ordinary, lazy native and ACP ownership share the original cap through native cleanup', async () => {
  const discovery = spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]);
  const benchmarks = spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue(undefined);
  const compose = spyOn(runtimeComposition, 'composeContractRunner');
  const nativeFactory = spyOn(nativeComposition, 'createDaemonNativeWorkExecutionServices');
  const original = activationComposition.createDaemonNativeWorkExecutionActivation;
  let activation: ReturnType<typeof original> | undefined;
  const capture = spyOn(activationComposition, 'createDaemonNativeWorkExecutionActivation').mockImplementation(options => {
    activation = original(options); return activation;
  });
  const daemon = await startDaemonFixture({ root: makeOwnedTempDir('native-shared-fleet'), configure: config => config.set('fleet.maxSize', 2),
    inboxFactory: (context, _routing, options) => registerInboxSurface(context, { ...options, adapters: new Map() }) });
  const releases = new Map<string, () => void>();
  const executor = { async runAgent(record: AgentRecord) {
    record.status = 'running'; await new Promise<void>(resolve => { releases.set(record.id, resolve); });
    if (record.status === 'running') record.status = 'completed';
  } };
  let acp: ReturnType<typeof spyOn> | undefined;
  try {
    if (!activation) throw new Error('Production native activation was not composed');
    const owner = activation;
    expect(owner.fleetOwnership()).toEqual([]); expect(nativeFactory).not.toHaveBeenCalled();
    const ordinary = daemon.services.agentManager; ordinary.setExecutor(executor);
    const input = { mode: 'spawn' as const, task: 'Synthetic owned work', outsideContract: true };
    const first = ordinary.spawn(input);
    const ordinaryProbe = compose.mock.calls[0]![0].fleetCapacity;
    expect(ordinaryProbe()).toMatchObject({ active: 1, maxSize: 2 });
    await owner.acquire();
    const nativeOptions = nativeFactory.mock.calls[0]![0]; const native = nativeOptions.agentManager; native.setExecutor(executor);
    const nativeProbe = compose.mock.calls.at(-1)![0].fleetCapacity;
    acp = spyOn(nativeOptions.acpHost, 'list').mockReturnValue([{ id: 'owned-acp-fixture' }]);
    expect(ordinaryProbe()).toMatchObject({ active: 2, maxSize: 2 }); expect(nativeProbe()).toMatchObject({ active: 2, maxSize: 2 });
    expect(() => native.spawn(input)).toThrow('fleet.maxSize=2'); expect(() => ordinary.spawn(input)).toThrow('fleet.maxSize=2');
    acp.mockRestore(); acp = undefined;
    const second = native.spawn(input);
    expect(ordinaryProbe()).toMatchObject({ active: 2, maxSize: 2 }); expect(nativeProbe()).toMatchObject({ active: 2, maxSize: 2 });
    expect(() => ordinary.spawn(input)).toThrow('fleet.maxSize=2'); expect(() => native.spawn(input)).toThrow('fleet.maxSize=2');
    expect(ordinary.list()).toHaveLength(1); expect(native.list()).toHaveLength(1);
    let closed = false; const closing = owner.close().then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 0)); expect(closed).toBe(false);
    expect(owner.fleetOwnership()).toContainEqual({ id: second.id, active: true });
    expect(ordinaryProbe()).toMatchObject({ active: 2, maxSize: 2 }); expect(() => ordinary.spawn(input)).toThrow('fleet.maxSize=2');
    releases.get(second.id)!(); await closing;
    expect(owner.fleetOwnership()).toEqual([]); expect(ordinaryProbe()).toMatchObject({ active: 1, maxSize: 2 });
    const retry = ordinary.spawn(input); expect(ordinaryProbe()).toMatchObject({ active: 2, maxSize: 2 });
    releases.get(first.id)!(); releases.get(retry.id)!(); await Promise.all([ordinary.join(first.id), ordinary.join(retry.id)]);
    expect(ordinaryProbe()).toMatchObject({ active: 0, maxSize: 2 });
  } finally {
    acp?.mockRestore(); for (const release of releases.values()) release();
    await daemon.stop(); capture.mockRestore(); nativeFactory.mockRestore(); compose.mockRestore(); benchmarks.mockRestore(); discovery.mockRestore();
  }
}, 20000);

test('cancel fences a queued foreground admission before awaiting durable cancellation', async () => {
  const benchmarks = spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue(undefined);
  const identities = spyOn(BenchmarkStore.prototype, 'readBenchmarks').mockResolvedValue(undefined);
  const originalFactory = nativeComposition.createDaemonNativeWorkExecutionServices;
  let nativeOwner: ReturnType<typeof originalFactory> | undefined;
  const factory = spyOn(nativeComposition, 'createDaemonNativeWorkExecutionServices').mockImplementation(options => {
    nativeOwner = originalFactory(options); return nativeOwner;
  });
  const f = await fixture();
  let releaseCancel!: () => void; const cancelGate = new Promise<void>(resolve => { releaseCancel = resolve; });
  let phase = false; let entered = 0; let ended = false; let stopping: Promise<void> | undefined;
  f.hold(async () => { entered++; return answer('native execution is complete'); });
  const original = f.authority.withCurrent.bind(f.authority);
  const lock = spyOn(f.authority, 'withCurrent').mockImplementation(async (expected, callback) => {
    if (phase) await cancelGate; return original(expected, callback);
  });
  let unsubscribe: (() => void) | undefined;
  try {
    const execution = await f.activation.acquire();
    if (!nativeOwner) throw new Error('Native owner was not composed');
    const native = await nativeOwner;
    unsubscribe = native.runner.on(() => {
      if (phase) return;
      const waiting = native.runner.list().find(contract => contract.sessionMode && contract.units.some(unit => unit.status === 'running'));
      if (!waiting) return;
      phase = true;
      const association = execution.statusByAttempt(f.target.workId, f.target.attemptId, f.authority);
      if (association.kind !== 'execution') throw new Error('Expected running execution association');
      stopping = execution.cancel(association.execution.request.key, f.authority, 'Owned queued-admission cancellation');
      void stopping.then(() => { ended = true; });
    });
    const started = await execution.start(f.target, f.authority);
    await waitFor(() => phase, 'cancel requested on session-running event');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(entered).toBe(0); expect(ended).toBe(false);
    releaseCancel(); await stopping;
    expect(ended).toBe(true); expect(entered).toBe(0);
    expect(execution.status(started.admission.key, f.authority).contract?.status).toBe('cancelled');
  } finally { unsubscribe?.(); releaseCancel(); await stopping; lock.mockRestore(); await f.close(); factory.mockRestore(); identities.mockRestore(); benchmarks.mockRestore(); }
}, 20000);

test('cancelled foreground retains the existing owner fleet slot until actual provider cleanup', async () => {
  const benchmarks = spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue(undefined);
  const identities = spyOn(BenchmarkStore.prototype, 'readBenchmarks').mockResolvedValue(undefined);
  const factory = spyOn(nativeComposition, 'createDaemonNativeWorkExecutionServices');
  const f = await fixture();
  let release!: () => void; const cleanup = new Promise<void>(resolve => { release = resolve; });
  let entered = false; let aborted = false; let stopping: Promise<void> | undefined;
  f.hold(async request => { entered = true;
    await new Promise<void>(resolve => { if (request.signal?.aborted) resolve(); else request.signal?.addEventListener('abort', () => resolve(), { once: true }); });
    aborted = true; await cleanup; return answer('cancelled provider cleanup finished');
  });
  try {
    const execution = await f.activation.acquire(); const started = await execution.start(f.target, f.authority);
    await waitFor(() => entered, 'foreground entered');
    expect(f.activation.fleetOwnership().filter(record => record.id === started.admission.ownerAgentId && record.active)).toHaveLength(1);
    stopping = execution.cancel(started.admission.key, f.authority, 'Owned occupancy cancellation');
    await waitFor(() => aborted, 'foreground aborted'); await new Promise(resolve => setTimeout(resolve, 20));
    const retained = f.activation.fleetOwnership().some(record => record.id === started.admission.ownerAgentId && record.active);
    f.options.configManager.set('fleet.maxSize', 1);
    const ordinary = new AgentManager({ configManager: f.options.configManager, additionalFleetOwnership: f.activation.fleetOwnership,
      archetypeLoader: { loadArchetype: () => null }, messageBus: { registerAgent() {} }, executor: { async runAgent(record) { record.status = 'completed'; } } });
    let admitted = false; let record;
    try { record = ordinary.spawn({ mode: 'spawn', outsideContract: true, task: 'Owned overlap probe' }); admitted = true; } catch {}
    if (record) await ordinary.join(record.id);
    expect({ retained, admitted }).toEqual({ retained: true, admitted: false });
    const nativeManager = factory.mock.calls[0]![0].agentManager;
    let nativeStarts = 0; nativeManager.setExecutor({ async runAgent(record) { nativeStarts++; record.status = 'completed'; } });
    expect(() => nativeManager.spawn({ mode: 'spawn', outsideContract: true, task: 'Owned native overlap probe' })).toThrow('fleet.maxSize=1');
    expect(nativeStarts).toBe(0);
    release(); await stopping;
    expect(f.activation.fleetOwnership().some(record => record.active)).toBe(false);
    const retry = ordinary.spawn({ mode: 'spawn', outsideContract: true, task: 'Owned retry after drain' }); await ordinary.join(retry.id);
  } finally { release(); await stopping; await f.close(); factory.mockRestore(); identities.mockRestore(); benchmarks.mockRestore(); }
}, 20000);

test('cancel authority failure propagates only after the foreground it stopped drains', async () => {
  const benchmarks = spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue(undefined);
  const identities = spyOn(BenchmarkStore.prototype, 'readBenchmarks').mockResolvedValue(undefined);
  const f = await fixture(); const failure = new Error('Synthetic cancel authority failure');
  let release!: () => void; const cleanup = new Promise<void>(resolve => { release = resolve; });
  let entered = false; let aborted = false; let ended = false;
  f.hold(async request => { entered = true;
    await new Promise<void>(resolve => { if (request.signal?.aborted) resolve(); else request.signal?.addEventListener('abort', () => resolve(), { once: true }); });
    aborted = true; await cleanup; return answer('stopped provider cleanup finished');
  });
  let lock: ReturnType<typeof spyOn> | undefined;
  try {
    const execution = await f.activation.acquire(); const started = await execution.start(f.target, f.authority);
    await waitFor(() => entered, 'foreground entered before failed cancel');
    lock = spyOn(f.authority, 'withCurrent').mockRejectedValue(failure);
    const result = execution.cancel(started.admission.key, f.authority, 'Owned failed-cancel probe').then(
      () => { ended = true; return undefined; }, error => { ended = true; return error; });
    await waitFor(() => aborted, 'foreground stopped despite authority failure');
    expect(ended).toBe(false);
    release(); expect(await result).toBe(failure); expect(ended).toBe(true);
  } finally { release(); lock?.mockRestore(); await f.close(); identities.mockRestore(); benchmarks.mockRestore(); }
}, 20000);

test('real authenticated daemon pending cancellation joins initial Jev and never enters the foreground', async () => {
  const discovery = spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]);
  const benchmarks = spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue(undefined);
  const identities = spyOn(BenchmarkStore.prototype, 'readBenchmarks').mockResolvedValue(undefined);
  const daemon = await startDaemonFixture({ root: makeOwnedTempDir('native-http-pending-cancel'),
    inboxFactory: (context, _routing, options) => registerInboxSurface(context, { ...options, adapters: new Map() }) });
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  try {
    f = await fixture(daemon.services.pairingTokens);
    const original = f.options.judgmentPort;
    f.options.judgmentPort = { ...original, async ask(request) { entered(); await gate; return original.ask(request); } };
    registerNativeWorkExecutionGatewayMethods(daemon.services.gatewayMethods, { projectId: 'project', acquire: f.activation.acquire });
    const client = createOperatorNativeWorkExecutionClient(createOperatorSdk({ baseUrl: daemon.baseUrl, authToken: f.paired.token, retry: { maxAttempts: 1 } }), 'project');
    const identity = { workId: f.target.workId, attemptId: f.target.attemptId,
      expectedRevision: { work: f.target.workRevision, criteria: f.target.criteriaRevision, attempt: f.target.attemptRevision } };
    const start = client.start(identity); await ready;
    expect(await client.status(identity)).toMatchObject({ kind: 'pending-intent', state: 'admitting', recovery: 'pending' });
    let ended = false; const cancel = client.cancel(identity).then(result => { ended = true; return result; });
    const storage = await f.options.knowledgeStore.openNativeWorkExecutionStorage('project');
    await waitFor(() => storage.currentByAttempt(f!.target.attemptId).intent?.state === 'cancelled', 'real daemon durable pending prevention');
    expect(ended).toBe(false); expect(f.requests).toHaveLength(0); expect(f.activation.fleetOwnership().some(item => item.active)).toBe(false);
    release(); expect((await start).kind).toBe('prevented-before-admission'); const result = await cancel;
    expect(result.kind).toBe('prevented-before-admission'); expect('receipt' in result).toBe(false);
    expect(f.requests).toHaveLength(0); await storage.close(); client.dispose();
  } finally { release(); await f?.close(); await daemon.stop(); identities.mockRestore(); benchmarks.mockRestore(); discovery.mockRestore(); }
}, 20000);

test('review: late-association cancellation still drains foreground when authority is revoked after durable cancellation', async () => {
  const benchmarks = spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue(undefined);
  const identities = spyOn(BenchmarkStore.prototype, 'readBenchmarks').mockResolvedValue(undefined);
  const originalFactory = nativeComposition.createDaemonNativeWorkExecutionServices;
  let nativeOwner: ReturnType<typeof originalFactory> | undefined;
  const factory = spyOn(nativeComposition, 'createDaemonNativeWorkExecutionServices').mockImplementation(options => {
    nativeOwner = originalFactory(options); return nativeOwner;
  });
  const tokens = new PairingTokenManager(join(makeOwnedTempDir('review-pending-revoke'), 'pairing.json'));
  const f = await fixture(tokens);
  let releaseStart!: () => void; const startGate = new Promise<void>(resolve => { releaseStart = resolve; });
  let enteredStart!: () => void; const ready = new Promise<void>(resolve => { enteredStart = resolve; });
  let releaseCancel!: () => void; const cancelGate = new Promise<void>(resolve => { releaseCancel = resolve; });
  let releaseProvider!: () => void; const cleanup = new Promise<void>(resolve => { releaseProvider = resolve; });
  let entered = false; let aborted = false; let ended = false;
  let unsubscribe: (() => void) | undefined; let stopping: Promise<unknown> | undefined; let start: Promise<unknown> | undefined;
  f.hold(async request => { entered = true;
    await new Promise<void>(resolve => { if (request.signal?.aborted) resolve(); else request.signal?.addEventListener('abort', () => resolve(), { once: true }); });
    aborted = true; await cleanup; return answer('cancelled provider cleanup finished');
  });
  try {
    const execution = await f.activation.acquire();
    if (!nativeOwner) throw new Error('Native owner was not composed');
    const native = await nativeOwner;
    const originalStart = native.runner.startDurable.bind(native.runner);
    native.runner.startDurable = async request => { enteredStart(); await startGate; return originalStart(request); };
    const originalCancel = native.execution.cancelTarget.bind(native.execution);
    native.execution.cancelTarget = async (...args) => { await cancelGate; return originalCancel(...args); };
    start = execution.start(f.target, f.authority); await ready;
    const before = execution.statusByAttempt(f.target.workId, f.target.attemptId, f.authority);
    expect(before.kind).toBe('execution'); if (before.kind !== 'execution') throw new Error('Expected association');
    expect(before.execution.receipt).toBeNull();
    stopping = execution.cancelTarget(f.target, f.authority, 'Owned delayed association cancellation').then(
      value => { ended = true; return value; }, error => { ended = true; return error; });
    releaseStart(); await start; await waitFor(() => entered, 'late foreground provider entered');
    unsubscribe = native.runner.on(() => {
      if (native.runner.list({ includeTerminal: true }).some(contract => contract.status === 'cancelled')) tokens.revoke(f.paired.id);
    });
    releaseCancel(); await waitFor(() => aborted, 'late foreground was aborted');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(ended).toBe(false);
    releaseProvider(); expect(await stopping).toMatchObject({ code: 'unsupported-authority' }); expect(ended).toBe(true);
  } finally { unsubscribe?.(); releaseStart(); releaseCancel(); releaseProvider(); await Promise.allSettled([start, stopping]); await f.close(); factory.mockRestore(); identities.mockRestore(); benchmarks.mockRestore(); }
}, 20000);

test('review: ambiguous late-association cancellation still owns foreground cleanup after authority loss', async () => {
  const benchmarks = spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue(undefined);
  const identities = spyOn(BenchmarkStore.prototype, 'readBenchmarks').mockResolvedValue(undefined);
  const originalFactory = nativeComposition.createDaemonNativeWorkExecutionServices;
  let nativeOwner: ReturnType<typeof originalFactory> | undefined;
  const factory = spyOn(nativeComposition, 'createDaemonNativeWorkExecutionServices').mockImplementation(options => {
    nativeOwner = originalFactory(options); return nativeOwner;
  });
  const tokens = new PairingTokenManager(join(makeOwnedTempDir('review-pending-revoke'), 'pairing.json'));
  const f = await fixture(tokens);
  let releaseStart!: () => void; const startGate = new Promise<void>(resolve => { releaseStart = resolve; });
  let enteredStart!: () => void; const ready = new Promise<void>(resolve => { enteredStart = resolve; });
  let releaseCancel!: () => void; const cancelGate = new Promise<void>(resolve => { releaseCancel = resolve; });
  let releaseProvider!: () => void; const cleanup = new Promise<void>(resolve => { releaseProvider = resolve; });
  let entered = false; let aborted = false; let ended = false;
  let unsubscribe: (() => void) | undefined; let stopping: Promise<unknown> | undefined; let start: Promise<unknown> | undefined;
  f.hold(async request => { entered = true;
    await new Promise<void>(resolve => { if (request.signal?.aborted) resolve(); else request.signal?.addEventListener('abort', () => resolve(), { once: true }); });
    aborted = true; await cleanup; return answer('cancelled provider cleanup finished');
  });
  try {
    const execution = await f.activation.acquire();
    if (!nativeOwner) throw new Error('Native owner was not composed');
    const native = await nativeOwner;
    const originalStart = native.runner.startDurable.bind(native.runner);
    native.runner.startDurable = async request => { enteredStart(); await startGate; return originalStart(request); };
    const originalCancel = native.execution.cancelTarget.bind(native.execution);
    native.execution.cancelTarget = async (...args) => { await cancelGate; return originalCancel(...args); };
    start = execution.start(f.target, f.authority); await ready;
    const before = execution.statusByAttempt(f.target.workId, f.target.attemptId, f.authority);
    expect(before.kind).toBe('execution'); if (before.kind !== 'execution') throw new Error('Expected association');
    expect(before.execution.receipt).toBeNull();
    stopping = execution.cancelTarget(f.target, f.authority, 'Owned delayed association cancellation').then(
      value => { ended = true; return value; }, error => { ended = true; return error; });
    releaseStart(); await start; await waitFor(() => entered, 'late foreground provider entered');
    const persistence = (f.options.knowledgeStore as unknown as { sqlite: { persistence: { io: typeof nativeFs } } }).sqlite.persistence;
    let failed = false;
    persistence.io = { ...nativeFs, fsyncSync(fd) {
      if (!failed && nativeFs.fstatSync(fd).isDirectory()) { failed = true; throw new Error('Owned after-publication cancellation fault'); }
      nativeFs.fsyncSync(fd);
    } };
    const originalAuthority = f.authority.withCurrent.bind(f.authority);
    f.authority.withCurrent = async (expected, callback) => {
      try { return await originalAuthority(expected, callback); }
      finally { if (failed) tokens.revoke(f.paired.id); }
    };
    releaseCancel(); await waitFor(() => ended || aborted, 'failed cancel or foreground abort observed');
    persistence.io = nativeFs;
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(failed).toBe(true); expect({ ended, aborted }).toEqual({ ended: false, aborted: true });
    releaseProvider(); expect(await stopping).toMatchObject({ code: 'unavailable' }); expect(ended).toBe(true);
  } finally { unsubscribe?.(); releaseStart(); releaseCancel(); releaseProvider(); await Promise.allSettled([start, stopping]); await f.close(); factory.mockRestore(); identities.mockRestore(); benchmarks.mockRestore(); }
}, 20000);

import * as nativeHostFactory from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution';
import { SQLiteStore } from '@goodvibes-jev/engine/sdk/platform/state';
import { createHash } from 'node:crypto';
// An attacker may recompute the public record hash; this cannot mint private issuance.
const nativeCiDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value, (_key, item: unknown) => item !== null && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)).digest('hex');
import { GatewayMethodCatalog } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import { createNativeWorkSubmissionHost } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-submission';
import { CiWatchAutoMinter, CiWatchService, CiWatchStore } from '@goodvibes-jev/engine/sdk/platform/ci-watch';
import { startAdmittedCiRepair } from '@goodvibes-jev/engine/sdk/platform/ci-watch';
import * as execFactory from '@goodvibes-jev/engine/sdk/platform/tools';
import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer, scoreAnswer } from '@goodvibes-jev/judgment/testing';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { KnowledgeStore } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import { createClientRuntimeServices } from '@goodvibes-jev/engine/sdk/platform/runtime/client-services';
import { RuntimeEventBus } from '@goodvibes-jev/engine/sdk/platform/runtime/state';
import { createRuntimeStore } from '@goodvibes-jev/engine/sdk/platform/runtime/store';
import { BenchmarkStore, ProviderRegistry, type ModelDefinition } from '@goodvibes-jev/engine/sdk/platform/providers';
import type { LLMProvider, ChatRequest, ChatResponse } from '@goodvibes-jev/engine/sdk/platform/providers';
import { createWorkLedger } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger';
import { PairingTokenManager } from '@goodvibes-jev/engine/sdk/platform/pairing';
import { WorkspaceRegistrationStore } from '@goodvibes-jev/engine/sdk/platform/workspace';
import type { NativePairedExecutionAuthority } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution';
import { createDaemonNativeWorkExecutionActivation } from '../../runtime/native-work-execution-activation.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

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
  const gatewayMethods = new GatewayMethodCatalog();
  const continuationScopeOwner = gatewayMethods.attachScopePolicyOwner(() => configManager.invalidateExternalPolicy());
  const runtimeBus = new RuntimeEventBus();
  let approvals = 0;
  const services = createClientRuntimeServices({ workspaceTrust: null, configManager, runtimeBus, runtimeStore: createRuntimeStore(),
    surfaceRoot: 'daemon', workingDir: workspace, homeDirectory: root, requestApproval: async () => { approvals++; return { approved: false }; }, modelDiscovery: 'skip' });
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
  const criteria = ['The answer says native execution is complete.', 'Preserve this second requirement after the first: evidence remains separate. ☃'];
  const plan = { goal, criteria: criteria.map((text, index) => ({ id: `c${index + 1}`, text, quote: text })), groups: [{
    id: 'g1', title: 'Answer', goal, kind: 'work', dependsOn: [], criteria: [], units: [{ id: 'u1', title: 'Answer', goal,
      role: 'research', brief: 'Say native execution is complete.', dependsOn: [], files: [], criteria: criteria.map((text, index) => ({ id: `u1.c${index + 1}`, text, serves: [`c${index + 1}`] })) }],
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
  const scopesGranted = ['read:work-ledger', 'write:work-ledger', 'write:fleet'].sort();
  const authority: NativePairedExecutionAuthority = {
    current() { const current = tokens.authenticateNative(paired.token); return current ? { ...current, scopes: scopesGranted } : null; },
    issueContinuation(binding, assertCurrent, sourceBinding) { return tokens.issueNativeContinuation(paired.token, authority.current()!, binding, assertCurrent, sourceBinding); },
    withCurrent(expected, callback) { return tokens.withNativeAuthority(paired.token, expected, assertCurrent => callback(() => ({ ...assertCurrent(), scopes: scopesGranted }))); },
  };
  const actor = ledger.authority.issueActor({ projectId: 'project', actorId: authority.current()!.principalId, role: 'coordinator' });
  const scopes = new WorkspaceRegistrationStore({ path: join(root, 'registrations.json'), homeDir: root, daemonStateDir: join(root, '.goodvibes') });
  await scopes.add(workspace);
  const submission = createNativeWorkSubmissionHost({ projectRoot: workspace, projectId: 'project', sessionId: 'native-fixture',
    service: ledger.service, authority: ledger.authority, scopes });
  const submitted = await submission.submit({ requestId: 'submit-native', inputId: 'original-source', expectedRevision: 0, goal, criteria }, authority);
  const target = { workId: submitted.receipt.workId, workRevision: submitted.receipt.expectedRevision.work,
    criteriaRevision: submitted.receipt.expectedRevision.criteria, attemptId: submitted.receipt.attemptId, attemptRevision: submitted.receipt.expectedRevision.attempt };
  let observer: ((tool: string, args: Record<string, unknown>, success: boolean) => void) | undefined;
  const options = { runtimeBus, configManager, providerRegistry: services.providerRegistry, projectRoot: workspace,
    projectId: 'project', sessionId: 'native-fixture', knowledgeStore, nativeScopes: scopes, judgmentPort: port, decisionLog: log, continuationGrants: tokens, continuationScopeOwner,
    acpHost: { list: () => [] }, permissionManager: services.permissionManager, hookDispatcher: services.hookDispatcher, featureFlags: services.featureFlags,
    toolDependencies: { ...services, toolExecutionObserver: (tool: string, args: Record<string, unknown>, success: boolean) => observer?.(tool, args, success), contractHooks: services.contractRunner.hooks(), workflowServices: services.workflow } };
  const activation = createDaemonNativeWorkExecutionActivation(options);
  return { root, workspace, activation, gatewayMethods, continuationScopeOwner, options, services, target, authority, paired, tokens, scopes, ledger, actor, knowledgeStore, requests, readings, log, goal, criteria,
    approvalCount: () => approvals,
    observe(value: typeof observer) { observer = value; },
    hold(fn: typeof hold) { hold = fn; },
    async close() { continuationScopeOwner.close(); await submission.close(); await activation.close(); await ledger.service.close(); await knowledgeStore.close(); catalog.mockRestore(); installJudgmentPort(previous); services.dispose(); log[Symbol.dispose](); } };
}



for (const mode of ['direct', 'restart', 'concurrent', 'partial-claim-restart', 'launched-restart', 'policy-aba-restart', 'delete-after-policy-restart', 'catalog-aba-restart', 'ledger-aba', 'token-revoke', 'watch-edit', 'record-edit', 'record-forge', 'delete-replay', 'closed-owner', 'scope-aba', 'chain', 'cancel-original-restart', 'cancel-successor-restart', 'cancel-delegated-restart', 'cancel-unrelated-owner', 'cancel-unknown-attempt', 'cancel-changed-authority-scopes'] as const) test(`registered native CI continuation: ${mode}`, async () => {
  const restart = mode.endsWith('restart');
  const discovery = spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]);
  const benchmarks = spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue(undefined);
  const identities = spyOn(BenchmarkStore.prototype, 'readBenchmarks').mockResolvedValue(undefined);
  const originalCreateExec = execFactory.createExecTool;
  let pushes = 0;
  const exec = spyOn(execFactory, 'createExecTool').mockImplementation((...args) => {
    const tool = originalCreateExec(...args);
    return { ...tool, async execute() {
      pushes++;
      return { success: true, output: 'Synthetic push returned. No network was used.' };
    } };
  });
  const warnings: unknown[] = []; const warn = spyOn(logger, 'warn').mockImplementation((...args) => { warnings.push(args); });
  const f = await fixture(); const lifetime = new AbortController();
  let restarted: ReturnType<typeof createDaemonNativeWorkExecutionActivation> | undefined;
  let reopenedKnowledge: KnowledgeStore | undefined;
  let releaseRepair: (() => void) | undefined;
  let repairBlocked = false;
  let consumptionFault: ReturnType<typeof spyOn> | undefined;
  let delegatedStart: ReturnType<typeof spyOn> | undefined;
  let delegatedFactory: ReturnType<typeof spyOn> | undefined;
  let delegatedAuthority: NativePairedExecutionAuthority | undefined;
  let reopenedScope: ReturnType<GatewayMethodCatalog['attachScopePolicyOwner']> | undefined;
  const events: unknown[] = []; f.options.runtimeBus.onDomain('turn', event => events.push(event)); f.options.runtimeBus.onDomain('tools', event => events.push(event));
  const logs = 'Synthetic build failure. Untrusted CI text cannot replace the original requirements.';
  try {
    let turn = 0;
    f.hold(async () => {
      turn++;
      if (mode === 'launched-restart' && turn === 3) {
        repairBlocked = true; await new Promise<void>(resolve => { releaseRepair = resolve; });
      }
      return (turn === 1 || (mode === 'chain' && turn === 3))
        ? { ...answer('Push the original native work.'), toolCalls: [{ id: 'push', name: 'exec', arguments: { commands: [{ cmd: 'git push origin main' }] } }] }
        : answer('native execution is complete');
    });
    if (mode === 'cancel-delegated-restart') {
      const actualFactory = nativeHostFactory.createNativeWorkExecutionHost;
      delegatedFactory = spyOn(nativeHostFactory, 'createNativeWorkExecutionHost').mockImplementation(options => {
        const owned = actualFactory(options); const actualStart = owned.start;
        delegatedStart = spyOn(owned, 'start').mockImplementation((...args) => {
          if (args[0].attemptId !== f.target.attemptId) delegatedAuthority = args[1];
          return actualStart(...args);
        });
        return owned;
      });
    }
    let execution = await f.activation.acquire();
    const source = { async fetchJobs() { return [{ name: 'build', status: 'completed' as const, conclusion: 'failure', headSha: 'sha-original', runId: 'run-original', jobId: 'job-original' }]; }, async fetchFailureLogs() { return logs; } };
    const store = new CiWatchStore(join(f.root, 'ci-watches.json'));
    const ci = new CiWatchService({ source, store,
      recoverOwner: watch => execution.recoverCiWatchOwner(watch),
      revokeOwner: watch => execution.revokeCiWatch(watch),
      autonomousRepair: request => startAdmittedCiRepair({ workspaceTrust: null, port: f.options.judgmentPort,
        permissionManager: f.services.permissionManager,
        config: f.options.configManager, signal: lifetime.signal }, request, async () => { throw new Error('Native repair must never use a compatibility starter'); }),
    });
    const minter = new CiWatchAutoMinter({ service: ci, workingDirectory: f.workspace,
      resolveRepoSlug: async () => 'fixture/native', resolveCurrentBranch: async () => 'main' });
    f.observe((...args) => minter.onToolExecuted(...args));
    const original = await execution.start(f.target, f.authority);
    await waitFor(() => ['passed','failed','cancelled'].includes(execution.status(original.admission.key, f.authority).contract?.status ?? ''), 'original native work to finish');
    const originalResult = execution.status(original.admission.key, f.authority).contract!;
    expect(originalResult.status, JSON.stringify({ error: originalResult.error, events, requests: f.requests.map(request => ({ systemPrompt: request.systemPrompt?.slice(0,100), messages: request.messages })), pushes })).toBe('passed');
    await waitFor(() => pushes === 1, 'actual registered native push');
    let watches = await ci.listWatches();
    for (let i = 0; i < 100 && !watches.length; i++) { await Bun.sleep(10); watches = await ci.listWatches(); }
    expect(originalResult.nativeSource).toMatchObject({ goal: f.goal, criteria: f.criteria }); expect(watches, JSON.stringify(warnings)).toHaveLength(1);
    expect(watches[0]!.continuationId).toBeDefined();
    for (let i = 0; i < 100 && !(await store.load()).length; i++) await Bun.sleep(10);
    expect(await store.load()).toHaveLength(1);
    await waitFor(() => execution.status(original.admission.key, f.authority).settlement?.state === 'published', 'original native settlement');
    if (mode === 'policy-aba-restart' || mode === 'delete-after-policy-restart') {
      const before = f.options.configManager.get('display.showTokenSpeed');
      f.options.configManager.setRuntimeOverride('display.showTokenSpeed', !before); f.options.configManager.setRuntimeOverride('display.showTokenSpeed', before);
    }
    if (mode === 'catalog-aba-restart') {
      const descriptor = f.gatewayMethods.get('workLedger.snapshot')!;
      f.gatewayMethods.unregister(descriptor.id); f.gatewayMethods.register(descriptor);
    }
    if (mode === 'ledger-aba') {
      for (const type of ['reopen', 'claim'] as const) {
        const snapshot = await f.ledger.service.readSnapshot(f.actor);
        const result = await f.ledger.service.execute({ type, workId: f.target.workId, requestId: `external-${type}`, expectedRevision: snapshot.revision,
          ...(type === 'reopen' ? { reason: 'Explicit owner reopened the source' } : {}) }, f.actor);
        expect(result.kind).toBe('accepted');
      }
    }
    if (mode === 'scope-aba') { await f.scopes.remove(f.workspace); await f.scopes.add(f.workspace); }
    if (mode === 'closed-owner') {
      const owned = execution.recoverCiWatchOwner(watches[0]!)!;
      await f.activation.close(); expect(() => owned.assertCurrent()).toThrow(); return;
    }
    if (mode === 'record-edit' || mode === 'record-forge') {
      const sqlite = (f.knowledgeStore as unknown as { sqlite: SQLiteStore }).sqlite;
      await sqlite.transactPersisted(db => {
        const row = JSON.parse(String(db.exec('SELECT state_json FROM native_ci_continuations')[0]!.values[0]![0]));
        if (mode === 'record-edit') row.watch.repo = 'edited/together';
        else { row.issue.seedRevision = 'f'.repeat(64); row.grant.binding = nativeCiDigest(row.issue); }
        db.run('UPDATE native_ci_continuations SET state_json = ?', [JSON.stringify(row)]);
        return { changed: true, value: undefined };
      }, () => {});
      expect(() => execution.recoverCiWatchOwner(mode === 'record-edit' ? { ...watches[0]!, repo: 'edited/together' } : watches[0]!)).toThrow();
      return;
    }
    if (mode === 'token-revoke') f.tokens.revoke(f.paired.id);
    if (mode === 'watch-edit') {
      expect(() => execution.recoverCiWatchOwner({ ...watches[0]!, repo: 'unissued/target' })).toThrow();
      expect(() => execution.recoverCiWatchOwner({ ...watches[0]!, continuationId: 'unissued-grant' })).toThrow();
      return;
    }
    if (mode === 'delete-replay') {
      expect(await ci.deleteWatch(watches[0]!.id)).toBe(true);
      expect(() => execution.recoverCiWatchOwner(watches[0]!)).toThrow();
      return;
    }
    if (mode === 'partial-claim-restart') {
      const consume = f.tokens.consumeNativeContinuation.bind(f.tokens);
      consumptionFault = spyOn(f.tokens, 'consumeNativeContinuation').mockImplementation((...args) => { consume(...args); throw new Error('Synthetic response loss after private consumption'); });
      const partial = await ci.checkWatch(watches[0]!.id);
      expect(partial.fixSessionTriggered).toBe(false); expect(partial.fixSessionError).toContain('Synthetic response loss');
      expect(f.requests.filter(request => request.systemPrompt?.includes('Execute this existing native work unit yourself'))).toHaveLength(2);
      consumptionFault.mockRestore(); consumptionFault = undefined;
    }
    if (mode === 'launched-restart') {
      expect((await ci.checkWatch(watches[0]!.id)).fixSessionTriggered).toBe(true);
      await waitFor(() => repairBlocked, 'actual successor member effect');
    }
    if (mode === 'cancel-unrelated-owner' || mode === 'cancel-unknown-attempt' || mode === 'cancel-changed-authority-scopes') {
      let cancellationAuthority = f.authority;
      if (mode === 'cancel-unrelated-owner') {
        const other = f.tokens.mint({ name: 'Unrelated paired owner' });
        cancellationAuthority = {
          current() { const current = f.tokens.authenticateNative(other.token); return current ? { ...current, scopes: f.authority.current()!.scopes } : null; },
          withCurrent(expected, callback) { return f.tokens.withNativeAuthority(other.token, expected, check => callback(() => ({ ...check(), scopes: f.authority.current()!.scopes }))); },
        };
      } else if (mode === 'cancel-changed-authority-scopes') {
        cancellationAuthority = { ...f.authority, current() { return { ...f.authority.current()!, scopes: ['write:work-ledger'] }; } };
      }
      const before = readFileSync(join(f.root, 'pairing.json'), 'utf8');
      const key = mode === 'cancel-unknown-attempt' ? { ...original.admission.key, attemptId: 'unknown-owned-attempt' } : original.admission.key;
      await expect(execution.cancel(key, cancellationAuthority, 'Must not revoke unrelated source')).rejects.toThrow();
      expect(readFileSync(join(f.root, 'pairing.json'), 'utf8')).toBe(before);
      expect(() => execution.recoverCiWatchOwner(watches[0]!)).not.toThrow();
      return;
    }
    if (mode === 'cancel-original-restart' || mode === 'cancel-successor-restart' || mode === 'cancel-delegated-restart') {
      let cancelKey = original.admission.key;
      if (mode === 'cancel-successor-restart' || mode === 'cancel-delegated-restart') {
        expect((await ci.checkWatch(watches[0]!.id)).fixSessionTriggered).toBe(true);
        const latest = (await f.ledger.service.readSnapshot(f.actor)).works[0]!;
        const successor = execution.statusByAttempt(latest.work.id, latest.attempt!.id, f.authority);
        if (successor.kind !== 'execution') throw new Error('Missing successor execution');
        cancelKey = successor.execution.request.key;
        await waitFor(() => execution.status(cancelKey, f.authority).settlement?.state === 'published', 'successor settlement before cancellation');
        expect(await ci.listWatches()).toHaveLength(1); // Successor has issued no new watch/grant.
      }
      const sqlite = (f.knowledgeStore as unknown as { sqlite: SQLiteStore }).sqlite;
      const backup = sqlite.readPersisted(db => ({
        continuation: db.exec('SELECT project_id,continuation_id,format_version,state_json FROM native_ci_continuations')[0]!.values,
        executions: db.exec('SELECT attempt_id,state_json FROM native_work_executions')[0]!.values,
        intents: db.exec('SELECT attempt_id,state_json FROM native_work_execution_intents')[0]!.values,
      }));
      if (mode !== 'cancel-delegated-restart') await sqlite.transactPersisted(db => { db.run('DELETE FROM native_ci_continuations'); return { changed: true, value: undefined }; }, () => {});
      if (mode === 'cancel-delegated-restart') {
        expect(delegatedAuthority).toBeDefined(); expect(delegatedAuthority!.current()).not.toBeNull();
        await expect(execution.cancel(cancelKey, delegatedAuthority!, 'Delegated owner retires its own source')).rejects.toThrow('recovery-required');
        expect(delegatedAuthority!.current()).toBeNull();
      } else await execution.cancel(cancelKey, f.authority, 'Authenticated owner cancels this exact source');
      await sqlite.transactPersisted(db => {
        db.run('DELETE FROM native_ci_continuations');
        for (const row of backup.continuation) db.run('INSERT INTO native_ci_continuations(project_id,continuation_id,format_version,state_json) VALUES (?,?,?,?)', [String(row[0]), String(row[1]), Number(row[2]), String(row[3])]);
        for (const row of backup.executions) db.run('UPDATE native_work_executions SET state_json=? WHERE attempt_id=?', [String(row[1]),String(row[0])]);
        for (const row of backup.intents) db.run('UPDATE native_work_execution_intents SET state_json=? WHERE attempt_id=?', [String(row[1]),String(row[0])]);
        return { changed: true, value: undefined };
      }, () => {});
    }
    let polling = ci;
    if (restart) {
      await waitFor(() => execution.status(original.admission.key, f.authority).settlement?.state === 'published', 'original native settlement');
      if (mode !== 'launched-restart') { f.continuationScopeOwner.close(); await f.activation.close(); }
      const configManager = new ConfigManager({ workingDir: f.workspace, homeDir: f.root, configDir: join(f.root, 'config'), surfaceRoot: 'daemon' });
      const gateway = new GatewayMethodCatalog(); reopenedScope = gateway.attachScopePolicyOwner(() => configManager.invalidateExternalPolicy());
      reopenedKnowledge = new KnowledgeStore({ dbPath: join(f.root, 'knowledge.sqlite') });
      restarted = createDaemonNativeWorkExecutionActivation({ ...f.options, configManager, knowledgeStore: reopenedKnowledge,
        continuationGrants: new PairingTokenManager(join(f.root, 'pairing.json')), continuationScopeOwner: reopenedScope,
        nativeScopes: new WorkspaceRegistrationStore({ path: join(f.root, 'registrations.json'), homeDir: f.root, daemonStateDir: join(f.root, '.goodvibes') }) });
      execution = await restarted.acquire();
      polling = new CiWatchService({ source, store: new CiWatchStore(join(f.root, 'ci-watches.json')),
        recoverOwner: watch => execution.recoverCiWatchOwner(watch),
      revokeOwner: watch => execution.revokeCiWatch(watch),
        autonomousRepair: request => startAdmittedCiRepair({ workspaceTrust: null, port: f.options.judgmentPort,
        permissionManager: f.services.permissionManager,
          config: configManager, signal: lifetime.signal }, request, async () => { throw new Error('Native recovery cannot use compatibility'); }) });
    }
    if (mode === 'delete-after-policy-restart') {
      expect(await polling.deleteWatch(watches[0]!.id)).toBe(true);
      expect(() => execution.recoverCiWatchOwner(watches[0]!)).toThrow(); return;
    }
    if (mode === 'cancel-original-restart' || mode === 'cancel-successor-restart' || mode === 'cancel-delegated-restart') { expect(() => execution.recoverCiWatchOwner(watches[0]!)).toThrow(); return; }
    const jobs = mode === 'concurrent' ? [polling.checkWatch(watches[0]!.id), polling.checkWatch(watches[0]!.id)] : [polling.checkWatch(watches[0]!.id)];
    const [repaired] = await Promise.all(jobs);
    if (mode === 'launched-restart') {
      expect(repaired!.fixSessionTriggered).toBe(false); expect(repaired!.fixSessionError).toContain('requires native reconciliation');
      expect(f.requests.filter(request => request.systemPrompt?.includes('Execute this existing native work unit yourself'))).toHaveLength(3); return;
    }
    if (['policy-aba-restart', 'catalog-aba-restart', 'ledger-aba', 'token-revoke', 'scope-aba'].includes(mode)) {
      expect(repaired!.fixSessionTriggered).toBe(false); expect(repaired!.fixSessionError).toBeDefined();
      expect(f.requests.filter(request => request.systemPrompt?.includes('Execute this existing native work unit yourself'))).toHaveLength(2);
      return;
    }
    expect(repaired, JSON.stringify(repaired)).toMatchObject({ fixSessionTriggered: true });
    const current = (await f.ledger.service.readSnapshot(f.actor)).works[0]!;
    expect(current.attempt!.id).not.toBe(f.target.attemptId); expect(current.attempt!.predecessorId).toBe(f.target.attemptId);
    const successor = execution.statusByAttempt(current.work.id, current.attempt!.id, f.authority);
    expect(successor.kind).toBe('execution');
    if (successor.kind !== 'execution') throw new Error('No native successor receipt');
    await waitFor(() => execution.statusByAttempt(current.work.id, current.attempt!.id, f.authority).kind === 'execution'
      && f.requests.filter(request => request.systemPrompt?.includes('Execute this existing native work unit yourself')).length >= 3, 'genuine native repair member');
    expect(successor.execution.request.input.nativeSource).toMatchObject({ sourceId: original.contract.nativeSource!.sourceId,
      sourceRevision: original.contract.nativeSource!.sourceRevision, goal: f.goal, criteria: f.criteria });
    expect(successor.execution.request.input.taskEvidence).toContain(logs);
    expect(f.log.query({ site: 'work-ledger.native-start' }).length).toBeGreaterThanOrEqual(2);
    expect(f.approvalCount()).toBe(0);
    expect(f.requests.some(request => request.systemPrompt?.includes('Execute this existing native work unit yourself') && request.systemPrompt.includes(logs))).toBe(true);
    expect(f.services.contractRunner.list({ includeTerminal: true })).toHaveLength(0);
    if (mode === 'concurrent') {
      const replay = await polling.checkWatch(watches[0]!.id);
      expect(replay.fixSessionId).toBe(repaired!.fixSessionId);
      const snapshot = await f.ledger.service.readSnapshot(f.actor); expect(snapshot.works[0]!.attempt!.id).toBe(current.attempt!.id);
    }
    if (mode === 'chain') {
      for (let i = 0; i < 200 && (await ci.listWatches()).length < 2; i++) await Bun.sleep(10);
      const nextWatch = (await ci.listWatches()).find(watch => watch.continuationId !== watches[0]!.continuationId);
      expect(nextWatch, JSON.stringify(warnings)).toBeDefined();
      const next = await ci.checkWatch(nextWatch!.id); expect(next.fixSessionTriggered, JSON.stringify(next)).toBe(true);
      const snapshot = await f.ledger.service.readSnapshot(f.actor); expect(snapshot.works[0]!.attempt!.predecessorId).toBe(current.attempt!.id);
    }
  } finally { delegatedFactory?.mockRestore(); delegatedStart?.mockRestore(); releaseRepair?.(); consumptionFault?.mockRestore(); lifetime.abort(); reopenedScope?.close(); await restarted?.close(); await reopenedKnowledge?.close(); await f.close(); warn.mockRestore(); exec.mockRestore(); identities.mockRestore(); benchmarks.mockRestore(); discovery.mockRestore(); }
}, 30000);

/** Source-bound native inspection fixtures: real ledger, paired authority, runner,
 * git isolation and authenticated REST transport. Only model/Jev answers are fake. */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { KnowledgeStore } from '../../sdk/src/platform/knowledge/store.js';
import { createWorkLedger } from '../../sdk/src/platform/workflow/work-ledger/service.js';
import { createNativeWorkExecutionHost } from '../../sdk/src/platform/workflow/work-ledger/native-execution.js';
import { createOperatorNativeWorkExecutionClient } from '../../sdk/src/platform/workflow/work-ledger/native-execution-client.js';
import { createLocalWorkLedgerReadBinding } from '../../sdk/src/platform/workflow/work-ledger/read-client.js';
import { criteriaSetIdForWork } from '../../sdk/src/platform/contract/durable-admission.js';
import { PairingTokenManager } from '../../sdk/src/platform/pairing/pairing-token-store.js';
import { WorkspaceRegistrationStore } from '../../sdk/src/platform/workspace/registration/store.js';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../../sdk/src/platform/daemon/control-plane.js';
import { GatewayMethodCatalog } from '../../sdk/src/platform/control-plane/method-catalog.js';
import { registerNativeWorkExecutionGatewayMethods } from '../../sdk/src/platform/control-plane/routes/native-work-execution.js';
import { registerWorkLedgerGatewayMethods } from '../../sdk/src/platform/control-plane/routes/work-ledger.js';
import { createOperatorSdk } from '../../operator-sdk/src/client.js';
import { dispatchGatewayRestRoutes } from '../../daemon-sdk/src/gateway-rest-routes.js';
import { createOrchestrationEngine, type OrchestrationEngine } from '../../sdk/src/platform/orchestration/engine.js';
import type { ConfigManager } from '../../sdk/src/platform/config/manager.js';
import { makeHarness, makeRepo, oneUnitPlan, runnerPort, waitFor, type AgentScript, type Harness, type HarnessOptions } from './runner-support.js';
import { draftUnit, plannerOutput, type DraftPlan } from './plan-support.js';
import { finishes, fixPlan, scriptsWith, stepPlanner } from './steps-support.js';

export const NATIVE_INTEGRATION_GOAL = 'Preserve both independent writers and integrate the complete result.\nKeep original requirements ☃.';
export const NATIVE_INTEGRATION_CRITERIA = ['Both writers retain their exact behavior.'];

export function nativeIntegrationPlan(): DraftPlan {
  const plan = oneUnitPlan(1);
  return { ...plan, goal: NATIVE_INTEGRATION_GOAL, criteria: NATIVE_INTEGRATION_CRITERIA.map((text, index) => ({ id: `c${index + 1}`, text, quote: text })) };
}

/** Abort-aware barriers cannot hold teardown hostage after a failed assertion. */
export function integrationBarrier() {
  let release!: () => void;
  let released = false;
  const pending = new Promise<void>(resolve => { release = () => { released = true; resolve(); }; });
  return { release, async wait(signal?: AbortSignal) {
    signal?.throwIfAborted(); if (released) return;
    if (!signal) return pending;
    let onAbort!: () => void;
    try { await Promise.race([pending, new Promise<never>((_resolve, reject) => { onAbort = () => reject(signal.reason); signal.addEventListener('abort', onAbort, { once: true }); })]); }
    finally { signal.removeEventListener('abort', onAbort); }
  } };
}

export async function createNativeIntegrationFixture(options: {
  harness?: Partial<HarnessOptions>;
  decoratePort?: (port: JudgmentPort) => JudgmentPort;
  /** Auto isolation outside git is genuinely shared; never fabricate a DTO. */
  withoutGit?: boolean;
  /** Attach the historical runner capability shape without inspection. */
  withoutInspection?: boolean;
} = {}) {
  const root = makeRepo(); if (options.withoutGit) rmSync(join(root, '.git'), { recursive: true, force: true });
  mkdirSync(join(root, '.goodvibes'), { recursive: true });
  const tokens = new PairingTokenManager(join(root, '.goodvibes', 'pairing.json'));
  const paired = tokens.mint({ name: 'Owned native integration test device' });
  const catalog = new GatewayMethodCatalog();
  const helper = new DaemonControlPlaneHelper({ pairingTokens: tokens, authToken: () => 'synthetic-shared', gatewayMethods: catalog,
    controlPlaneGateway: { touchWebSocketClient() {} }, userAuth: { validateSession: () => null, getUser: () => null } } as unknown as DaemonControlPlaneContext);
  const authority = helper.createNativeExecutionAuthority(paired.token)!;
  const scopes = new WorkspaceRegistrationStore({ path: join(root, '.goodvibes', 'registrations.json'), homeDir: join(root, 'home'), daemonStateDir: join(root, '.goodvibes', 'daemon') });
  await scopes.add(root);
  const store = new KnowledgeStore({ dbPath: join(root, '.goodvibes', 'knowledge.sqlite') });
  let sequence = 0;
  const ledger = createWorkLedger({ projectId: 'project', storage: await store.openWorkLedgerStorage('project'), clock: { now: () => 100, newId: kind => `${kind}-${++sequence}` } });
  const actor = ledger.authority.issueActor({ projectId: 'project', actorId: authority.current()!.principalId, role: 'coordinator' });
  let revision = 0;
  async function addWork() {
    const created = await ledger.service.execute({ type: 'create', requestId: `create-${revision}`, expectedRevision: revision,
      title: 'Native integration display label', goal: NATIVE_INTEGRATION_GOAL, criteria: NATIVE_INTEGRATION_CRITERIA }, actor);
    if (created.kind !== 'accepted' || created.event.type === 'import_legacy') throw new Error('Native fixture create failed');
    revision++;
    const claimed = await ledger.service.execute({ type: 'claim', requestId: `claim-${revision}`, expectedRevision: revision, workId: created.event.workId }, actor);
    if (claimed.kind !== 'accepted' || claimed.event.type === 'import_legacy') throw new Error('Native fixture claim failed');
    revision++;
    const work = claimed.event.work; const attempt = claimed.event.attempts[0]!;
    const target = { workId: work.id, workRevision: work.revision, criteriaRevision: work.criteriaRevision, attemptId: attempt.id, attemptRevision: attempt.revision };
    return { work, attempt, target,
      key: { workId: work.id, criteriaId: criteriaSetIdForWork(work.id), criteriaRevision: String(work.criteriaRevision), attemptId: attempt.id },
      identity: { workId: work.id, attemptId: attempt.id, expectedRevision: { work: work.revision, criteria: work.criteriaRevision, attempt: attempt.revision } } };
  }
  const owned = await addWork();
  const log = new SqliteDecisionLog(join(root, '.goodvibes', 'decisions.sqlite'));
  const hostPort = withDecisionLog(fakePort((_name, question) => choiceAnswer(question, 'act', 0.99)).port, log);
  const storage = await store.openNativeWorkExecutionStorage('project');
  const hostOptions = { projectId: 'project', projectRoot: root, sessionId: 'native-integration-fixture', storage, scopes, port: hostPort, decisionLog: log };
  // This host is distinct from the runner. The transport acquires it lazily only
  // after the real gateway's paired-token and project checks.
  const host = createNativeWorkExecutionHost(hostOptions);
  const engines = new Map<string, OrchestrationEngine>();
  let harness!: Harness;
  harness = makeHarness({ root, plan: nativeIntegrationPlan(), scripts: { u1: finishes('complete native result') },
    contract: { isolation: 'worktree' }, decisionLog: log, ...options.harness,
    nativeDecisions: host.nativeOwner.decisions, durableAdmission: host.nativeOwner.admission,
    createEngine(input) {
      const engine = createOrchestrationEngine({ ...input, agentManager: harness.manager, runtimeBus: harness.bus,
        configManager: { get: () => undefined, getCategory: () => ({}) } as unknown as Pick<ConfigManager, 'get' | 'getCategory'>, runWorktreeSetup: () => undefined });
      engines.set(input.stateNamespace, engine); return engine;
    },
  });
  const previous = installJudgmentPort(options.decoratePort?.(withDecisionLog(runnerPort(options.harness?.port).port, log)) ?? withDecisionLog(runnerPort(options.harness?.port).port, log));
  if (options.withoutInspection) {
    // The historical eight-member native capability exposes no Fleet controls
    // or alternate legacy start path for an inspection fallback to consult.
    const runner = harness.runner;
    host.attachRunner({ startDurable: request => runner.startDurable(request), resumeDurable: key => runner.resumeDurable(key),
      get: id => runner.get(id), list: filter => runner.list(filter), cancel: (id, reason) => runner.cancel(id, reason), join: id => runner.join(id),
      ...(runner.inspectDurable ? { inspectDurable: runner.inspectDurable.bind(runner) } : {}),
      ...(runner.joinDurable ? { joinDurable: runner.joinDurable.bind(runner) } : {}),
    });
  } else host.attachRunner(harness.runner);
  let acquisitions = 0;
  let selectedHost = host;
  let replacement: { host: ReturnType<typeof createNativeWorkExecutionHost>; harness: Harness } | undefined;
  registerNativeWorkExecutionGatewayMethods(catalog, { projectId: 'project', acquire: async () => { acquisitions++; return selectedHost; } });
  function replaceHostForRecovery() {
    if (replacement) throw new Error('Native fixture host was already replaced');
    // Same durable source and paired authority, genuinely new host and runner.
    // As in native-integration-lifecycle, observing never adopts the old run.
    harness.store.flush();
    const next = createNativeWorkExecutionHost(hostOptions);
    const restarted = makeHarness({ root, scripts: {}, decisionLog: log, nativeDecisions: next.nativeOwner.decisions, durableAdmission: next.nativeOwner.admission });
    next.attachRunner(restarted.runner);
    selectedHost = next;
    replacement = { host: next, harness: restarted };
    return replacement;
  }
  const binding = createLocalWorkLedgerReadBinding({ available: true, projectId: 'project', actorId: 'host:integration-reader', service: ledger.service, authority: ledger.authority });
  if (!binding.available) throw new Error('Native integration read binding unavailable');
  const reader = binding.client;
  registerWorkLedgerGatewayMethods(catalog, reader);
  const requests: Request[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init); requests.push(request);
    return await dispatchGatewayRestRoutes(request, { async invokeGatewayRestVerb({ req, methodId }) {
      const token = req.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
      const principal = helper.describeAuthenticatedPrincipal(token);
      if (!principal) return Response.json({ error: 'Unauthorized' }, { status: 401 });
      const result = await helper.invokeGatewayMethodCall({ authToken: token, methodId,
        body: req.method === 'POST' ? await req.json() : undefined, query: Object.fromEntries(new URL(req.url).searchParams), signal: req.signal, context: principal });
      return Response.json(result.body, { status: result.status });
    } }) ?? Response.json({ error: 'Not found' }, { status: 404 });
  };
  const sdk = (token = paired.token) => createOperatorSdk({ baseUrl: 'http://127.0.0.1:1', authToken: token, fetch, retry: { maxAttempts: 1 } });
  const client = createOperatorNativeWorkExecutionClient(sdk(), 'project');
  let disposed = false;
  async function dispose() {
    if (disposed) return; disposed = true;
    client.dispose(); reader.dispose();
    if (replacement) { await replacement.host.close(); replacement.harness.dispose(); }
    await host.close();
    installJudgmentPort(previous); harness.dispose();
    await Promise.all(harness.runner.list({ includeTerminal: true }).map(contract => harness.runner.join(contract.id)));
    await ledger.service.close(); await store.close(); log[Symbol.dispose](); rmSync(root, { recursive: true, force: true });
  }
  return { root, ...owned, addWork, tokens, paired, helper, authority, catalog, scopes, store, storage, ledger, log, host, hostOptions,
    harness, engines, client, sdk, fetch, reader, requests, replaceHostForRecovery, get acquisitions() { return acquisitions; }, dispose };
}

/** A conflict held at an actual source-bound Jev fix-plan request. A later group
 * keeps the run live after the autonomous repair passes. */
export async function createNativeIntegrationRepairFixture(options: { withoutInspection?: boolean } = {}) {
  const plan = nativeIntegrationPlan();
  plan.groups = [
    { id: 'g1', title: 'Writers', goal: 'Preserve both writers', kind: 'work', dependsOn: [], criteria: [], units: ['u1', 'u2'].map(id => draftUnit(id, { files: ['src/shared.ts'] })) },
    { id: 'g2', title: 'Final integration', goal: 'Keep inspection live', kind: 'integration', dependsOn: ['g1'], criteria: [], units: [draftUnit('u3', { role: 'integration', files: ['src/final.ts'] })] },
  ];
  const repair = integrationBarrier(); const tail = integrationBarrier();
  const writersReady = integrationBarrier(); const writers = new Set<string>();
  // Both real worktrees must exist before either original writer edits. Without
  // this fixture barrier, a slow second allocation can include the first merge
  // and accidentally avoid the conflict this acceptance scenario requires.
  const originalWriter = (text: string): AgentScript => (record, run) => finishes(text, 'src/shared.ts')(record, run).map((step, index) => index ? step : {
    ...step, before: async signal => {
      if (!record.workingDirectory || !record.contractUnitId) throw new Error('Expected admitted isolated writer');
      writers.add(record.contractUnitId);
      if (writers.size === 2) writersReady.release();
      await writersReady.wait(AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
    },
  });
  const fixRequests: unknown[] = [];
  const planner = stepPlanner(plan, { fix: prompt => {
    const unitId = /unit (u\d)\)/.exec(prompt)?.[1];
    if (!unitId) throw new Error('Expected native unit merge-conflict repair');
    return plannerOutput(fixPlan([{ serves: [`${unitId}.c1`], files: ['src/shared.ts'] }]));
  } });
  const f = await createNativeIntegrationFixture({ withoutInspection: options.withoutInspection === true, harness: { plan, planner: planner.runner, contract: { isolation: 'worktree', maxParallelUnits: 2 },
    scripts: scriptsWith({ u1: originalWriter('first writer'), u2: originalWriter('second writer'),
      u3: () => [{ text: 'Final integration is still active', tool: true, after: signal => tail.wait(signal) }, { text: 'Final integration passed', files: { 'src/final.ts': 'export const integrated = true;\n' } }] },
    unitId => unitId.endsWith('.f1.u1') ? finishes('both writers repaired', 'src/shared.ts') : undefined) },
    decoratePort: port => ({ ...port, async ask(request) {
      if (request.context?.site === 'contract.native.fix-plan') { fixRequests.push(structuredClone(request.state)); await repair.wait(request.signal); }
      return port.ask(request);
    } }),
  });
  const originalDispose = f.dispose;
  return { ...f, get acquisitions() { return f.acquisitions; }, planner, fixRequests, releaseRepair: repair.release, releaseTail: tail.release,
    async waitForRepair() { await waitFor(() => fixRequests.length > 0, 'source-bound Jev repair request', 20_000); },
    async waitForRepaired(contractId: string) { await waitFor(() => f.harness.runner.get(contractId)?.units.some(unit => unit.checks.at(-1)?.trigger === 'fix-passed' && unit.status === 'passed') === true && f.harness.agentsOf('u3').length > 0, 'native repair and still-active later group', 20_000); },
    async dispose() { writersReady.release(); repair.release(); tail.release(); await originalDispose(); },
  };
}

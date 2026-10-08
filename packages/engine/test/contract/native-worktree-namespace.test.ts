/** Real native admission, captured initialization, engine allocation and recovery. */
import { expect, spyOn, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { IsolatedWorktree } from '../../sdk/src/platform/agents/worktree.js';
import { deserializeContract, type DurableContractRequest, type NativeContractSource } from '../../sdk/src/platform/contract/index.js';
import { createContractInputAuthority } from '../../sdk/src/platform/contract/input-authority.js';
import { createOrchestrationEngine, type OrchestrationEngine } from '../../sdk/src/platform/orchestration/engine.js';
import { RuntimeEventBus } from '../../sdk/src/platform/runtime/events/index.js';
import { makeFakeConfigManager, makeRecord } from '../_helpers/orchestration-harness.js';
import { makeHarness, makeRepo, oneUnitPlan, waitFor, type Harness, type HarnessOptions } from './runner-support.js';
import { terminal } from './steps-support.js';

const source: NativeContractSource = { sourceId: 'original', sourceRevision: '1', inputRevision: '1', criteriaId: 'criteria', criteriaRevision: '1',
  goal: 'Preserve the original parser', criteria: ['Preserve parser behavior'] };
const authority = { authorityId: 'host', authorityRevision: '1', scopeId: 'project', scopeRevision: '1' };
function request(root: string, workId: string): DurableContractRequest {
  return { key: { workId, criteriaId: source.criteriaId, criteriaRevision: source.criteriaRevision, attemptId: 'attempt' },
    binding: { sourceId: source.sourceId, inputRevision: source.inputRevision, actionId: 'start', actionRevision: '1', ...authority },
    input: { ask: 'Display only', nativeSource: source, sessionId: 'namespace', origin: 'turn', projectRoot: root, isolation: 'worktree' } };
}
function fixture(root: string, options: Partial<HarnessOptions> = {}) {
  const engines = new Map<string, OrchestrationEngine>(); let h!: Harness;
  h = makeHarness({ root, recordNative: true, nativeDecisions: { authorityOf: () => authority },
    durableAdmission: { withCurrent: (_admission, launch) => launch(() => undefined) },
    plan: { ...oneUnitPlan(1), goal: source.goal, criteria: [{ id: 'c1', text: source.criteria[0]!, quote: source.criteria[0]! }] },
    contract: { isolation: 'worktree', maxActiveContracts: 2 }, scripts: { u1: () => [{ text: 'Live native unit', stop: { kind: 'hang' } }] },
    createEngine: input => {
      const engine = createOrchestrationEngine({ ...input, agentManager: h.manager, runtimeBus: h.bus, configManager: makeFakeConfigManager(), runWorktreeSetup: () => undefined });
      engines.set(input.stateNamespace, engine); return engine;
    }, ...options });
  return { h, engines, async close() { h.dispose(); await Promise.all(h.runner.list({ includeTerminal: true }).map(contract => h.runner.join(contract.id))); rmSync(root, { recursive: true, force: true }); } };
}

test('two source-bound native contracts in one repository isolate duplicate g1/u1 and cancellation owns only its worktree', async () => {
  const f = fixture(makeRepo());
  try {
    const a = await f.h.runner.startDurable(request(f.h.root, 'work-A')); const b = await f.h.runner.startDurable(request(f.h.root, 'work-B'));
    const firstId = a.admission.contractId; const otherId = b.admission.contractId;
    await waitFor(() => f.h.agentsOf('u1').length === 2 || terminal(f.h, firstId) || terminal(f.h, otherId), 'two native units', 15_000);
    expect(f.h.agentsOf('u1'), JSON.stringify(f.h.runner.list({ includeTerminal: true }).map(c => ({ id: c.id, status: c.status, error: c.error })))).toHaveLength(2);
    const first = f.engines.get(firstId)!.getWorkstream('g1')!.items[0]!; const other = f.engines.get(otherId)!.getWorkstream('g1')!.items[0]!;
    expect(first.id).toBe('u1'); expect(other.id).toBe('u1'); expect(first.contractId).toBe(firstId); expect(other.contractId).toBe(otherId);
    expect(first.worktreeBranch).not.toBe(other.worktreeBranch); expect(first.worktreePath).not.toBe(other.worktreePath);
    expect(first.worktreeInitialized).toBe(true); expect(other.worktreeInitialized).toBe(true);
    const firstPath = first.worktreePath!; const otherPath = other.worktreePath!;
    expect(readFileSync(join(firstPath, 'README.md'), 'utf8')).toBe('# demo\n');
    f.h.runner.cancel(firstId, 'Cancel only the first contract'); await f.h.runner.join(firstId);
    expect(existsSync(firstPath)).toBe(false); expect(existsSync(otherPath)).toBe(true);
    expect(f.h.runner.get(otherId)!.status).toBe('running'); expect(readFileSync(join(otherPath, 'README.md'), 'utf8')).toBe('# demo\n');
    expect(f.h.manager.getStatus(f.h.agentsOf('u1').find(id => f.h.manager.getStatus(id)?.contractId === otherId)!)!.status).toBe('running');
    f.h.runner.cancel(otherId, 'Fixture complete'); await f.h.runner.join(otherId); expect(existsSync(otherPath)).toBe(false);
  } finally { await f.close(); }
}, 30_000);

test('actual native materialization failure cannot grant member authority after preparing or failed snapshot import', async () => {
  const root = makeRepo(); let h!: Harness; let engine!: OrchestrationEngine; let preparing = '';
  // Fail the real raw-blob materializer after Git has registered its no-checkout
  // tree. README already exists, so materializeFiles' exclusive write fails.
  const original = IsolatedWorktree.prototype.create;
  const creation = spyOn(IsolatedWorktree.prototype, 'create').mockImplementation(async function (this: IsolatedWorktree, startPoint?: string, checkout = true) {
    await original.call(this, startPoint, checkout);
    if (!checkout && (this.branch.startsWith('ws/') || this.branch.startsWith('ws-ns/'))) writeFileSync(join(this.path, 'README.md'), 'partial materialization\n');
  });
  const f = fixture(root, { createEngine: input => {
    engine = createOrchestrationEngine({ ...input, agentManager: h.manager, runtimeBus: h.bus, configManager: makeFakeConfigManager(), runWorktreeSetup: () => undefined,
      initializeWorktree: async worktree => { try { await input.initializeWorktree!(worktree); } finally { preparing = engine.serializeWorkstream('g1')!; } } });
    return engine;
  } });
  h = f.h;
  const restored: OrchestrationEngine[] = [];
  try {
    const result = await h.runner.startDurable(request(root, 'work-partial')); const id = result.admission.contractId;
    await waitFor(() => terminal(h, id), 'materialization failure', 15_000); await h.runner.join(id);
    // Restore the actual persisted record through the production validator,
    // rather than treating a detached readonly view as mutable or reusing the
    // old run object's aborted in-memory input-admission binding.
    const serializedContract = h.store.serialize(id);
    if (serializedContract === null) throw new Error('Missing native contract snapshot');
    const contract = deserializeContract(serializedContract);
    if (contract === null) throw new Error('Native contract snapshot failed restore');
    const item = engine.getWorkstream('g1')!.items[0]!;
    expect(contract.status).toBe('failed'); expect(contract.error).toContain('EEXIST'); expect(h.agentsOf('u1')).toHaveLength(0);
    const path = item.worktreePath!; const branch = item.worktreeBranch!;
    expect(readFileSync(join(path, 'README.md'), 'utf8')).toBe('partial materialization\n');
    expect(item.worktreeInitialized).toBe(false); expect(item.worktreeKept).toBe(true);
    // Mutable authority validates repository/branch/ancestry, not completed
    // initialization. This real accepted token proves why readiness must gate
    // the engine before authority acquisition; it is not a mocked assumption.
    expect(await createContractInputAuthority(contract, path, { mutable: true, branch })).toMatchObject({ kind: 'contract-input-authority' });
    for (const [stage, snapshot] of [['preparing', preparing], ['failed', engine.serializeWorkstream('g1')!]] as const) {
      let grants = 0; let spawns = 0;
      const recovered = createOrchestrationEngine({ projectRoot: contract.worktreePath!, stateNamespace: id, persist: false,
        configManager: makeFakeConfigManager(), runtimeBus: new RuntimeEventBus(), runWorktreeSetup: () => undefined,
        // Permit retry admission so only worktree readiness can stop the real
        // authority acquisition below, rather than an unrelated missing port.
        contractUnitSettlement: { beforeSpawn: async () => ({ kind: 'spawn' }), settle: async () => 'cancelled' },
        agentManager: { spawn: () => { spawns++; return makeRecord({ id: 'unexpected', task: 'unexpected' }); }, getStatus: () => null, cancel: () => true,
          registerCancellationSignal: () => undefined, releaseCancellationSignal: () => undefined },
        prepareInputAuthority: async resource => { grants++; return createContractInputAuthority(contract, resource.path, { mutable: true, branch: resource.branch }); } });
      restored.push(recovered); expect(recovered.importWorkstream(snapshot)).toBe(true);
      if (stage === 'failed') expect(recovered.retryItem('u1')).toBe(true); else recovered.start('g1');
      await waitFor(() => recovered.getWorkstream('g1')!.items[0]!.state === 'failed' || spawns > 0, 'readiness recovery guard');
      expect(grants).toBe(0); expect(spawns).toBe(0); await recovered.join();
      expect(recovered.getWorkstream('g1')!.items[0]!.failureReason).toContain('requires recovery');
      expect(recovered.getWorkstream('g1')!.items[0]!.worktreeInitialized).toBe(false);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(join(path, 'README.md'), 'utf8')).toBe('partial materialization\n');
    }
  } finally { creation.mockRestore(); for (const recovered of restored) { recovered.dispose(); await recovered.join(); } await f.close(); }
}, 30_000);

/** Acceptance through real source-bound native execution and authenticated status.
 * No ContractUnit, WorkItem or inspection DTO is manufactured for these proofs. */
import { expect, spyOn, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { IsolatedWorktree } from '../../sdk/src/platform/agents/worktree.js';
import { createNativeWorkExecutionHost } from '../../sdk/src/platform/workflow/work-ledger/native-execution.js';
import type { NativeWorkExecutionSnapshot } from '../../sdk/src/platform/workflow/work-ledger/native-execution-wire.js';
import { draftUnit } from './plan-support.js';
import { makeHarness, waitFor, type Harness } from './runner-support.js';
import { terminal } from './steps-support.js';
import { createNativeIntegrationFixture, createNativeIntegrationRepairFixture, integrationBarrier, nativeIntegrationPlan, NATIVE_INTEGRATION_GOAL, NATIVE_INTEGRATION_CRITERIA } from './native-integration-support.js';

function live(snapshot: NativeWorkExecutionSnapshot) {
  expect(snapshot.kind).toBe('execution');
  if (snapshot.kind !== 'execution' || snapshot.integration?.state !== 'live') throw new Error(`Expected live native status: ${JSON.stringify(snapshot)}`);
  return snapshot.integration;
}
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}
function diagnostic(f: Awaited<ReturnType<typeof createNativeIntegrationFixture>>) {
  return JSON.stringify(f.harness.runner.list({ includeTerminal: true }).map(contract => ({ id: contract.id, status: contract.status, error: contract.error,
    groups: contract.groups.map(group => ({ id: group.id, status: group.status })), units: contract.units.map(unit => ({ id: unit.id, status: unit.status, reason: unit.failureReason })),
    agents: f.harness.manager.list().map(agent => ({ unitId: agent.contractUnitId, status: agent.status, error: agent.error })) })));
}

test('source-bound conflict, autonomous fix-passed and a separate real remerge remain distinct on the authenticated status wire', async () => {
  const f = await createNativeIntegrationRepairFixture();
  try {
    const started = await f.client.start(f.identity);
    if (started.kind !== 'execution' || !started.receipt) throw new Error('Native start must return a receipt');
    const contractId = started.receipt.contractId;
    await f.waitForRepair();
    const engine = f.engines.get(contractId)!;
    const remerge = spyOn(engine, 'retryItemIntegration');
    const before = live(await f.client.status(f.identity));
    const conflicted = before.units.find(unit => unit.item.state === 'recorded' && unit.item.integration === 'conflict')!;
    expect(conflicted).toBeDefined();
    if (conflicted.item.state !== 'recorded') throw new Error('Expected recorded conflict');
    expect(conflicted.item.conflictFiles).toEqual(['src/shared.ts']);
    expect(conflicted.item.worktreeKept).toBe(true); expect(existsSync(conflicted.item.worktreePath!)).toBe(true);
    expect(conflicted.item.worktreeBranch).toBe(git(conflicted.item.worktreePath!, 'branch', '--show-current'));
    const source = f.storage.current(f.key).record!.request.input.nativeSource!;
    expect(source.goal).toBe(NATIVE_INTEGRATION_GOAL); expect(source.criteria).toEqual(NATIVE_INTEGRATION_CRITERIA);
    const repairContext = JSON.stringify(f.fixRequests[0]);
    expect(repairContext).toContain(source.sourceId); expect(repairContext).toContain(source.inputRevision);
    expect(repairContext).toContain(`${contractId}:fix-plan:${conflicted.unitId}`);
    expect(repairContext).toContain(NATIVE_INTEGRATION_CRITERIA[0]!);
    expect(f.harness.runner.get(contractId)!.nativeProgress).toMatchObject({ state: 'deciding', stage: 'fix-plan', targetId: conflicted.unitId });
    expect(f.harness.agentsOf(`${conflicted.unitId}.f1.u1`)).toHaveLength(0);
    expect(remerge).not.toHaveBeenCalled();

    f.releaseRepair(); await f.waitForRepaired(contractId);
    const after = live(await f.client.status(f.identity));
    const repaired = after.units.find(unit => unit.unitId === conflicted.unitId)!;
    expect(repaired).toMatchObject({ unitStatus: 'passed', latestCheck: { trigger: 'fix-passed', result: 'pass' }, item: conflicted.item });
    expect(after.units.find(unit => unit.unitId === 'u3')?.unitStatus).toBe('running');
    expect(remerge).not.toHaveBeenCalled();
    expect(f.harness.runner.get(contractId)!.escalations).toHaveLength(0);
    expect(f.harness.events.filter(event => event.type === 'CONTRACT_ESCALATED' || event.type === 'CONTRACT_OWNER_REPLIED')).toHaveLength(0);
    const decision = f.harness.runner.get(contractId)!.nativeDecisions!.history.find(record => record.stage === 'fix-plan')!;
    expect(decision.decision.outcome).toBe('act');
    expect(decision.decision.binding.sourceId).toBe(source.sourceId);
    expect(decision.decision.judgmentDecisionIds.every(id => f.log.get(id)?.status === 'answered')).toBe(true);

    // Explicitly reconcile the real preserved item branch, then ask the actual
    // engine to remerge it. Neither inspection nor repair impersonates this act.
    const worktree = conflicted.item.worktreePath!;
    const contract = f.harness.runner.get(contractId)!;
    const merge = spawnSync('git', ['-C', worktree, 'merge', '--no-commit', contract.branch!], { encoding: 'utf8' });
    expect([0, 1]).toContain(merge.status!);
    writeFileSync(join(worktree, 'src/shared.ts'), 'both writers repaired\n');
    git(worktree, 'add', 'src/shared.ts'); git(worktree, 'commit', '--allow-empty', '-m', 'Reconcile original branch with native repair');
    expect(await engine.retryItemIntegration(conflicted.item.itemId)).toBe('merged');
    const integrated = live(await f.client.status(f.identity)).units.find(unit => unit.unitId === conflicted.unitId)!;
    expect(integrated).toMatchObject({ unitStatus: 'passed', latestCheck: { trigger: 'fix-passed', result: 'pass' }, item: { integration: 'merged', worktreeKept: false } });
    if (integrated.item.state !== 'recorded') throw new Error('Expected integrated item');
    expect(integrated.item.mergeHash).toMatch(/^[a-f0-9]{40}$/); expect(integrated.item.conflictFiles).toBeUndefined();
    expect(integrated.item.worktreePath).toBeUndefined(); expect(existsSync(worktree)).toBe(false);
    expect(remerge).toHaveBeenCalledTimes(1); remerge.mockRestore();
    f.releaseTail(); await waitFor(() => terminal(f.harness, contractId), 'native terminal completion', 15_000); await f.harness.runner.join(contractId);
    expect(f.harness.runner.get(contractId)?.status, JSON.stringify(f.harness.runner.get(contractId)?.error)).toBe('passed');
    expect(f.harness.runner.inspectIntegration(contractId)).toEqual({ state: 'unavailable', reason: 'not-live' });
    const done = await f.client.status(f.identity); if (done.kind !== 'execution') throw new Error('Missing execution');
    expect(done.integration).toEqual({ state: 'unavailable', reason: 'not-live' });
    const operations = f.requests.map(request => new URL(request.url).pathname);
    expect(operations.filter(path => /start|resume|cancel/.test(path))).toHaveLength(1);
  } finally { await f.dispose(); }
}, 60_000);

test('real unrecorded, pending, merged-hash and no-change engine observations preserve exact distinctions', async () => {
  const pending = integrationBarrier(); const releaseWorkers = integrationBarrier();
  const plan = nativeIntegrationPlan();
  plan.groups[0]!.units = [draftUnit('u1', { files: ['src/changed.ts'] }), draftUnit('u2', { role: 'research', files: ['README.md'] }), draftUnit('u3', { files: ['src/live.ts'] })];
  plan.groups.push({ id: 'g2', title: 'Final integration', goal: 'Integrate the completed research and writing', kind: 'integration', dependsOn: ['g1'], criteria: [], units: [draftUnit('u4', { role: 'integration', files: ['src/final.ts'] })] });
  let entered = false;
  const original = IsolatedWorktree.prototype.integrate;
  const integration = spyOn(IsolatedWorktree.prototype, 'integrate').mockImplementation(async function (this: IsolatedWorktree) {
    if (!entered) { entered = true; await pending.wait(); }
    return original.call(this);
  });
  const f = await createNativeIntegrationFixture({ harness: { plan, scripts: {
    u1: () => [{ text: 'Not completed yet', tool: true, after: () => releaseWorkers.wait() }, { text: 'Written', files: { 'src/changed.ts': 'native change\n' } }],
    u2: () => [{ text: 'No source changes needed', tool: true, after: () => releaseWorkers.wait() }, { text: 'Existing README was inspected and preserved; no source change was necessary.' }],
    u3: () => [{ text: 'Keep the run live', stop: { kind: 'hang' } }],
  }, port: context => context.name === 'role' && (context.state['unit'] as { title?: string } | undefined)?.title === 'Unit u2' ? choiceAnswer(context.question, 'research', 0.99) : undefined } });
  try {
    const started = await f.client.start(f.identity); if (started.kind !== 'execution' || !started.receipt) throw new Error('Missing receipt');
    const id = started.receipt.contractId;
    await waitFor(() => f.harness.agentsOf('u1').length > 0 && f.harness.agentsOf('u2').length > 0, 'two native workers', 15_000).catch(error => { throw new Error(`${error.message}: ${diagnostic(f)}`); });
    expect(live(await f.client.status(f.identity)).units.filter(unit => ['u1', 'u2'].includes(unit.unitId)).every(unit => unit.item.state === 'recorded' && unit.item.integration === 'unrecorded')).toBe(true);
    releaseWorkers.release(); await waitFor(() => entered, 'actual integration method', 15_000);
    expect(live(await f.client.status(f.identity)).units.some(unit => unit.item.state === 'recorded' && unit.item.integration === 'pending')).toBe(true);
    pending.release();
    await waitFor(() => {
      const result = f.harness.runner.inspectIntegration(id);
      return result.state === 'live' && result.units.filter(unit => ['u1', 'u2'].includes(unit.unitId)).every(unit => unit.item.state === 'recorded' && unit.item.integration === 'merged');
    }, 'real integrations settled', 15_000);
    const units = live(await f.client.status(f.identity)).units;
    const changed = units.find(unit => unit.unitId === 'u1')!.item; const unchanged = units.find(unit => unit.unitId === 'u2')!.item;
    expect(changed).toMatchObject({ state: 'recorded', integration: 'merged', worktreeKept: false });
    expect(unchanged).toMatchObject({ state: 'recorded', integration: 'merged', worktreeKept: false });
    if (changed.state !== 'recorded' || unchanged.state !== 'recorded') throw new Error('Missing actual engine items');
    expect(changed.mergeHash).toMatch(/^[a-f0-9]{40}$/); expect(unchanged.mergeHash).toBeUndefined();
    expect(unchanged.conflictFiles).toBeUndefined();
    await f.client.cancel(f.identity); await f.harness.runner.join(id);
    expect(f.harness.runner.inspectIntegration(id)).toEqual({ state: 'unavailable', reason: 'not-live' });
    const cancelled = await f.client.status(f.identity); if (cancelled.kind !== 'execution') throw new Error('Missing cancelled execution');
    expect(cancelled.integration?.state).toBe('unavailable');
  } finally { pending.release(); releaseWorkers.release(); integration.mockRestore(); await f.dispose(); }
}, 45_000);

test('two source-bound native contracts with duplicate u1/g1 retain separate real item paths and disposal clears both', async () => {
  const f = await createNativeIntegrationFixture({ harness: { contract: { isolation: 'worktree', maxActiveContracts: 2 }, scripts: { u1: () => [{ text: 'Live independent contract', stop: { kind: 'hang' } }] } } });
  try {
    const second = await f.addWork();
    const a = await f.client.start(f.identity); const b = await f.client.start(second.identity);
    if (a.kind !== 'execution' || !a.receipt || b.kind !== 'execution' || !b.receipt) throw new Error('Missing receipts');
    await waitFor(() => f.harness.agentsOf('u1').length === 2 || terminal(f.harness, a.receipt!.contractId) || terminal(f.harness, b.receipt!.contractId), 'duplicate unit IDs on independent native runs', 15_000);
    expect(f.harness.agentsOf('u1'), diagnostic(f)).toHaveLength(2);
    const first = live(await f.client.status(f.identity)); const other = live(await f.client.status(second.identity));
    expect(first.contractId).not.toBe(other.contractId);
    expect(first.units[0]).toMatchObject({ unitId: 'u1', groupId: 'g1' }); expect(other.units[0]).toMatchObject({ unitId: 'u1', groupId: 'g1' });
    const firstItem = first.units[0]!.item; const otherItem = other.units[0]!.item;
    if (firstItem.state !== 'recorded' || otherItem.state !== 'recorded') throw new Error('Missing bound items');
    expect(firstItem.worktreePath).toBeDefined(); expect(otherItem.worktreePath).toBeDefined(); expect(firstItem.worktreePath).not.toBe(otherItem.worktreePath);
    expect(f.engines.get(first.contractId)!.getWorkstream('g1')!.items[0]!.contractId).toBe(first.contractId);
    expect(f.engines.get(other.contractId)!.getWorkstream('g1')!.items[0]!.contractId).toBe(other.contractId);
    f.harness.runner.dispose(); await Promise.all([f.harness.runner.join(first.contractId), f.harness.runner.join(other.contractId)]);
    expect(f.harness.runner.inspectIntegration(first.contractId)).toEqual({ state: 'unavailable', reason: 'not-live' });
    expect(f.harness.runner.inspectIntegration(other.contractId)).toEqual({ state: 'unavailable', reason: 'not-live' });
  } finally { await f.dispose(); }
}, 30_000);

test('replacement host inspection exposes recovery-required without adopting, starting or resuming a live native run', async () => {
  const f = await createNativeIntegrationFixture({ harness: { scripts: { u1: () => [{ text: 'Active native worker', stop: { kind: 'hang' } }] } } });
  let replacement: ReturnType<typeof createNativeWorkExecutionHost> | undefined;
  let restarted: Harness | undefined;
  try {
    const result = await f.client.start(f.identity); if (result.kind !== 'execution' || !result.receipt) throw new Error('Missing receipt');
    await waitFor(() => f.harness.agentsOf('u1').length === 1, 'original worker');
    f.harness.store.flush();
    replacement = createNativeWorkExecutionHost(f.hostOptions);
    restarted = makeHarness({ root: f.root, scripts: {}, decisionLog: f.log, nativeDecisions: replacement.nativeOwner.decisions, durableAdmission: replacement.nativeOwner.admission });
    replacement.attachRunner(restarted.runner);
    const start = spyOn(restarted.runner, 'startDurable'); const resume = spyOn(restarted.runner, 'resumeDurable');
    expect(replacement.status(f.key, f.authority).integration).toEqual({ state: 'unavailable', reason: 'recovery-required' });
    expect(replacement.statusByAttempt(f.work.id, f.attempt.id, f.authority)).toMatchObject({ recovery: 'required', integration: { state: 'unavailable', reason: 'recovery-required' } });
    expect(start).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled(); expect(f.harness.agentsOf('u1')).toHaveLength(1);
    expect(restarted.manager.list()).toHaveLength(0); expect(restarted.runner.inspectIntegration(result.receipt.contractId)).toEqual({ state: 'unavailable', reason: 'not-live' });
    expect(live(await f.client.status(f.identity)).contractId).toBe(result.receipt.contractId);
    start.mockRestore(); resume.mockRestore();
  } finally { await replacement?.close(); restarted?.dispose(); await f.dispose(); }
}, 30_000);

test('native best-of-N reports the real attempt IDs, parent and indexes without fabricating a parent engine item', async () => {
  const plan = nativeIntegrationPlan(); plan.groups[0]!.units[0]!.attempts = 2;
  plan.groups.push({ id: 'g2', title: 'Keep live', goal: 'Wait for later work', kind: 'integration', dependsOn: ['g1'], criteria: [], units: [draftUnit('u2', { role: 'integration', files: ['src/final.ts'] })] });
  const f = await createNativeIntegrationFixture({ harness: { plan, scripts: {
    'u1#a0': () => [{ text: 'First real native attempt', files: { 'src/csv.ts': 'first attempt\n' } }],
    'u1#a1': () => [{ text: 'Second real native attempt', files: { 'src/csv.ts': 'second attempt\n' } }],
    u2: () => [{ text: 'Later native work remains active', stop: { kind: 'hang' } }],
  }, port: context => {
    if (context.name === 'asks_for_attempts') return noulAnswer(0.99);
    if (context.state['candidates'] !== undefined && context.name === 'pick') return choiceAnswer(context.question, 'u1#a1', 0.99);
    if (context.state['candidates'] !== undefined && context.name.startsWith('fits_')) return noulAnswer(0.99);
    return undefined;
  } } });
  try {
    const started = await f.client.start(f.identity); if (started.kind !== 'execution' || !started.receipt) throw new Error('Missing receipt');
    const id = started.receipt.contractId;
    await waitFor(() => f.harness.agentsOf('u2').length === 1, 'selected native attempt and active tail', 20_000).catch(error => { throw new Error(`${error.message}: ${diagnostic(f)}`); });
    const observation = live(await f.client.status(f.identity));
    expect(observation.units.find(unit => unit.unitId === 'u1')!.item).toEqual({ state: 'not-applicable', reason: 'best-of-n-plan' });
    const actual = f.harness.runner.get(id)!.units[0]!.attemptUnits!;
    expect(actual.map(unit => unit.id)).toEqual(['u1#a0', 'u1#a1']);
    for (const unit of actual) {
      const row = observation.units.find(candidate => candidate.unitId === unit.id)!;
      expect(row).toMatchObject({ attemptOf: 'u1', attemptIndex: unit.attemptIndex, unitStatus: unit.status,
        item: { state: 'recorded', itemId: unit.id, workstreamId: 'g1' } });
      expect(f.engines.get(id)!.getWorkstream('g1')!.items.find(item => item.id === unit.id)?.contractUnitId).toBe(unit.id);
    }
    expect(observation.units.find(unit => unit.unitId === 'u1#a1')!.item).toMatchObject({ integration: 'merged' });
    expect(f.harness.runner.get(id)!.escalations).toHaveLength(0);
  } finally { await f.dispose(); }
}, 45_000);

test('native no-delegation session reports shared execution as not-applicable without creating item worktrees', async () => {
  const f = await createNativeIntegrationFixture({ harness: { port: context => context.name === 'forbids_delegation' ? noulAnswer(0.99) : undefined } });
  try {
    const started = await f.client.start(f.identity); if (started.kind !== 'execution' || !started.receipt) throw new Error('Missing receipt');
    const id = started.receipt.contractId;
    await waitFor(() => f.harness.runner.get(id)?.sessionMode === true, 'native session mode');
    const snapshot = await f.client.status(f.identity); if (snapshot.kind !== 'execution') throw new Error('Missing execution');
    expect(snapshot.integration).toEqual({ state: 'not-applicable', contractId: id, reason: 'session-mode' });
    expect(f.harness.runner.get(id)?.isolation).toBe('shared'); expect(f.engines.size).toBe(0); expect(f.harness.agentsOf('u1')).toHaveLength(0);
  } finally { await f.dispose(); }
}, 20_000);

test('source-bound auto isolation outside git reports shared-isolation without pretending integration facts exist', async () => {
  const f = await createNativeIntegrationFixture({ withoutGit: true, harness: { scripts: { u1: () => [{ text: 'Shared native work is active', stop: { kind: 'hang' } }] } } });
  try {
    const started = await f.client.start(f.identity); if (started.kind !== 'execution' || !started.receipt) throw new Error('Missing receipt');
    const id = started.receipt.contractId;
    await waitFor(() => f.harness.agentsOf('u1').length === 1, 'actual shared native worker');
    const snapshot = await f.client.status(f.identity); if (snapshot.kind !== 'execution') throw new Error('Missing execution');
    expect(snapshot.integration).toEqual({ state: 'not-applicable', contractId: id, reason: 'shared-isolation' });
    expect(f.harness.runner.get(id)?.isolation).toBe('shared');
    expect(f.engines.get(id)!.getWorkstream('g1')!.items[0]!.worktreePath).toBeUndefined();
    expect(f.harness.manager.getStatus(f.harness.agentsOf('u1')[0]!)!.workingDirectory ?? f.root).toBe(f.root);
  } finally { await f.dispose(); }
}, 20_000);

test('legacy native runner capability preserves authenticated status with explicit unavailable inspection and no fallback effects', async () => {
  const f = await createNativeIntegrationFixture({ withoutInspection: true, harness: { scripts: { u1: () => [{ text: 'Legacy native capability remains active', stop: { kind: 'hang' } }] } } });
  try {
    const started = await f.client.start(f.identity);
    if (started.kind !== 'execution' || !started.receipt) throw new Error('Missing actual legacy-capability receipt');
    const id = started.receipt.contractId;
    await waitFor(() => f.harness.agentsOf('u1').length === 1, 'real native work behind legacy capability');
    // The actual factory still guarantees and supplies a genuine live reader.
    expect(f.harness.runner.inspectIntegration(id).state).toBe('live');
    const inspect = spyOn(f.harness.runner, 'inspectIntegration');
    const start = spyOn(f.harness.runner, 'startDurable'); const resume = spyOn(f.harness.runner, 'resumeDurable');
    const status = await f.client.status(f.identity);
    expect(status).toMatchObject({ kind: 'execution', currentAttempt: true, stale: false, recovery: 'available', receipt: started.receipt,
      progress: { status: 'running' }, integration: { state: 'unavailable', reason: 'unsupported-runner' } });
    expect(inspect).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled();
    expect(f.harness.agentsOf('u1')).toHaveLength(1);
    f.tokens.revoke(f.paired.id);
    await expect(f.client.status(f.identity)).rejects.toMatchObject({ status: 401 });
    expect(inspect).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled();
    inspect.mockRestore(); start.mockRestore(); resume.mockRestore();
  } finally { await f.dispose(); }
}, 20_000);

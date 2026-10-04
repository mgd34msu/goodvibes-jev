import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { OrchestrationEngine } from '../../sdk/src/platform/orchestration/engine.js';
import type { DurableContractBoundary, DurableContractRequest } from '../../sdk/src/platform/contract/index.js';
import { contractPath } from '../../sdk/src/platform/contract/index.js';
import { DurableContractAdmissions } from '../../sdk/src/platform/contract/durable-admission.js';
import { makeHarness, makeRepo, oneUnitPlan, waitFor, type Harness } from './runner-support.js';

const roots: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    const ids = h.runner.list().map((contract) => contract.id);
    h.dispose();
    await Promise.all(ids.map((id) => h.runner.join(id)));
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const key = { workId: 'native-work-1', criteriaId: 'acceptance-1', criteriaRevision: 'criteria-v1', attemptId: 'attempt-1' };
function request(root: string): DurableContractRequest {
  return { key: { ...key }, binding: { sourceId: 'source-1', inputRevision: 'input-v1', actionId: 'start-contract', actionRevision: 'action-v1',
    authorityId: 'actor-1', authorityRevision: 'grant-v1', scopeId: 'workspace-1', scopeRevision: 'scope-v1' },
    input: { ask: 'Add a CSV parser module', sessionId: 'session-1', origin: 'turn', projectRoot: root, isolation: 'shared' } };
}
function setup(boundary: DurableContractBoundary = { withCurrent: (_admission, launch) => launch(() => undefined) }, root = makeRepo(), cap = 8) {
  if (!roots.includes(root)) roots.push(root);
  const h = makeHarness({ root, durableAdmission: boundary, contract: { maxActiveContracts: cap }, plan: oneUnitPlan(),
    scripts: { u1: () => [{ text: '', stop: { kind: 'hang' } }] } });
  harnesses.push(h);
  return h;
}

describe('native durable contract admission', () => {
  test('persists exact immutable binding before launch; concurrent replay returns one runner record', async () => {
    let validations = 0;
    const h = setup({ withCurrent: (admission, launch) => {
      expect(Object.isFrozen(admission)).toBe(true);
      expect(Object.isFrozen(admission.input)).toBe(true);
      const stored = new DurableContractAdmissions(h.root).read(key)!;
      expect(stored.contractId).toBe(admission.contractId);
      expect(JSON.parse(readFileSync(contractPath(h.root, admission.contractId), 'utf8')).contract.durableLaunchState).toBe('prepared');
      launch(() => { validations++; });
    } });
    const input = request(h.root);
    const firstPending = h.runner.startDurable(input);
    (input.input as { ask: string }).ask = 'mutated after dispatch';
    const first = await firstPending;
    const replay = await Promise.all(Array.from({ length: 8 }, () => h.runner.startDurable(request(h.root))));
    expect(new Set(replay.map((result) => result.admission.contractId))).toEqual(new Set([first.admission.contractId]));
    expect(first.contract.ask).toBe('Add a CSV parser module');
    expect(first.state).toBe('launch-claimed');
    expect(validations).toBe(1);
    expect(h.manager.list().filter((record) => record.contractRole === 'owner')).toHaveLength(1);
  });

  test('final validator runs after borrowed persistence hooks', async () => {
    let current = true;
    const h = setup({ withCurrent: (_admission, launch) => launch(() => { if (!current) throw new Error('revoked by write hook'); }) });
    const write = h.store.write.bind(h.store);
    h.store.write = (id) => {
      const result = write(id);
      if (h.store.get(id)?.durableLaunchState === 'launch-claimed') current = false;
      return result;
    };
    await expect(h.runner.startDurable(request(h.root))).rejects.toThrow('revoked by write hook');
    expect(h.agentsOf('u1')).toHaveLength(0);
  });

  test('unit executor checks authority after reentrant AGENT_SPAWNING hooks', async () => {
    let current = true;
    const h = setup({ withCurrent: (_admission, launch) => launch(() => { if (!current) throw new Error('revoked during spawn'); }) });
    const unsubscribe = h.bus.onDomain('agents', (envelope) => {
      if (envelope.payload.type === 'AGENT_SPAWNING' && envelope.payload.contractRole === 'unit') current = false;
    });
    const first = await h.runner.startDurable(request(h.root));
    await waitFor(() => h.store.get(first.admission.contractId)?.status === 'cancelled', 'spawn revocation');
    expect(h.agentsOf('u1')).toHaveLength(1); // A record was published; its executor never ran.
    expect(h.manager.getStatus(h.agentsOf('u1')[0]!)?.usage?.llmCallCount ?? 0).toBe(0);
    unsubscribe();
  });

  test('one-shot launch cannot be retained, invoked reentrantly, or called twice', async () => {
    let retained: ((assertCurrent: () => void) => void) | undefined;
    let validates = 0;
    const h = setup({ withCurrent: (_admission, launch) => {
      retained = launch;
      launch(() => { validates++; expect(() => launch(() => undefined)).toThrow('boundary'); });
      expect(() => launch(() => undefined)).toThrow('boundary');
    } });
    await h.runner.startDurable(request(h.root));
    expect(() => retained!(() => undefined)).toThrow('boundary');
    expect(validates).toBe(1);
  });

  test('a boundary cannot omit launch or substitute an async validator', async () => {
    const absent = setup({ withCurrent: () => undefined });
    await expect(absent.runner.startDurable(request(absent.root))).rejects.toMatchObject({ code: 'boundary' });
    const asynchronous = setup({ withCurrent: (_admission, launch) => launch(async () => undefined) });
    await expect(asynchronous.runner.startDurable(request(asynchronous.root))).rejects.toMatchObject({ code: 'boundary' });
    expect(asynchronous.agentsOf('u1')).toHaveLength(0);
  });

  test.each(['throw', 'reject'])('post-launch boundary %s retains lease until real executor drainage', async (failure) => {
    let calls = 0;
    let entered = false;
    let drained = false;
    let release!: () => void;
    const cleanup = new Promise<void>((resolve) => { release = resolve; });
    const h = setup({ withCurrent: (_admission, launch) => {
      calls++; launch(() => undefined);
      if (calls === 2) {
        if (failure === 'throw') throw new Error('post-launch boundary failure');
        return Promise.reject(new Error('post-launch boundary failure'));
      }
    } });
    h.manager.setExecutor({ runAgent: async (record) => {
      entered = true; record.status = 'running';
      try { await cleanup; } finally { drained = true; }
    } });
    const first = await h.runner.startDurable(request(h.root));
    await waitFor(() => entered && h.store.get(first.admission.contractId)?.status === 'cancelled', 'post-launch cancellation');
    let joined = false;
    const join = h.runner.join(first.admission.contractId).then(() => { joined = true; });
    try {
      await expect(new DurableContractAdmissions(h.root).lease(key)).rejects.toThrow('cross-process-lock');
      expect(joined).toBe(false);
      expect(drained).toBe(false);
    } finally { release(); }
    await join;
    expect(drained).toBe(true);
    const lease = await new DurableContractAdmissions(h.root).lease(key); lease();
  });

  test('durable start and resume refuse an agent adapter without actual settlement', async () => {
    const h = setup(undefined, makeRepo(), 0);
    Object.defineProperty(h.manager, 'join', { value: undefined, configurable: true });
    await expect(h.runner.startDurable(request(h.root))).rejects.toThrow('execution settlement');
    expect(h.manager.list()).toHaveLength(0);
    delete (h.manager as unknown as { join?: unknown }).join;
    const first = await h.runner.startDurable(request(h.root));
    h.dispose(); await h.runner.join(first.admission.contractId);
    const next = setup(undefined, h.root);
    Object.defineProperty(next.manager, 'join', { value: undefined, configurable: true });
    await expect(next.runner.resumeDurable(key)).rejects.toThrow('execution settlement');
    expect(next.manager.list()).toHaveLength(0);
  });

  test('durable work refuses an orchestration adapter without actual settlement', async () => {
    const root = makeRepo(); roots.push(root);
    let disposed = false;
    const h = makeHarness({ root, scripts: {}, plan: oneUnitPlan(),
      durableAdmission: { withCurrent: (_admission, launch) => launch(() => undefined) },
      createEngine: () => ({ dispose: () => { disposed = true; } }) as unknown as OrchestrationEngine,
    });
    harnesses.push(h);
    const first = await h.runner.startDurable(request(root));
    await waitFor(() => h.store.get(first.admission.contractId)?.status === 'failed', 'unjoinable engine refused');
    expect(disposed).toBe(true);
    expect(h.agentsOf('u1')).toHaveLength(0);
    expect(h.manager.getStatus(first.admission.ownerAgentId)?.failureReason).toBe('OWNED_AGENT_EXECUTION_UNSUPPORTED');
  });

  test('shutdown during a pending unit boundary preserves the durable restart checkpoint', async () => {
    let calls = 0;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const h = setup({ async withCurrent(_admission, launch) {
      if (++calls === 2) await pending;
      launch(() => undefined);
    } });
    const first = await h.runner.startDurable(request(h.root));
    await waitFor(() => calls === 2, 'unit awaiting authority lock');
    h.dispose();
    const admissions = new DurableContractAdmissions(h.root);
    const checkpoint = admissions.checkpoint(key);
    let joined = false;
    const join = h.runner.join(first.admission.contractId).then(() => { joined = true; });
    await Promise.resolve();
    expect(joined).toBe(false);
    release(); await join;
    expect(admissions.checkpoint(key)).toBe(checkpoint);
    const resumed = setup(undefined, h.root);
    expect((await resumed.runner.resumeDurable(key)).admission).toEqual(first.admission);
    await waitFor(() => resumed.agentsOf('u1').length === 1, 'freshly validated resumed executor');
  });

  test('native unit wakes recheck current authority before another executor invocation', async () => {
    let current = true;
    let executions = 0;
    const h = setup({ withCurrent: (_admission, launch) => launch(() => { if (!current) throw new Error('revoked before wake'); }) });
    h.manager.setExecutor({ runAgent: async (record) => { executions++; record.status = 'failed'; } });
    const first = await h.runner.startDurable(request(h.root));
    await waitFor(() => executions === 1, 'initial unit invocation');
    const agentId = h.agentsOf('u1')[0]!;
    await h.manager.join(agentId);
    current = false;
    expect(h.manager.wakeWithSteer(agentId, 'continue').woke).toBe(true);
    await h.manager.join(agentId);
    expect(executions).toBe(1);
    expect(h.store.get(first.admission.contractId)?.status).toBe('cancelled');
  });

  test('restored contract-unit records cannot wake independently of explicit current contract resume', async () => {
    const h = setup();
    let executions = 0;
    h.manager.setExecutor({ runAgent: async (record) => { executions++; record.status = 'failed'; } });
    await h.runner.startDurable(request(h.root));
    await waitFor(() => executions === 1, 'original unit invocation');
    const agentId = h.agentsOf('u1')[0]!;
    await h.manager.join(agentId);
    const next = setup(undefined, h.root);
    next.manager.importState(h.manager.exportState());
    next.manager.setExecutor({ runAgent: async () => { executions++; } });
    expect(next.manager.wakeWithSteer(agentId, 'restart')).toEqual({ woke: false, reason: 'contract-unit-requires-resume' });
    expect(executions).toBe(1);
  });

  test('missing receipt with a bound compatibility checkpoint cannot mint a new runner', async () => {
    const h = setup(undefined, makeRepo(), 0);
    await h.runner.startDurable(request(h.root));
    const directory = join(h.root, '.goodvibes/contracts/admissions');
    const file = readdirSync(directory).find((file) => file.endsWith('.json'))!;
    unlinkSync(join(directory, file));
    await expect(h.runner.startDurable(request(h.root))).rejects.toMatchObject({ code: 'checkpoint' });
    expect(h.manager.list().filter((record) => record.contractRole === 'owner')).toHaveLength(1);
  });

  test('reentrant exact delivery can read the committed receipt while the host boundary owns the key lock', async () => {
    let reads = 0;
    const h = setup({ async withCurrent(admission, launch) {
      const replay = await h.runner.startDurable(request(h.root));
      expect(replay.admission.contractId).toBe(admission.contractId);
      reads++;
      launch(() => undefined);
    } });
    const first = await h.runner.startDurable(request(h.root));
    expect(first.state).toBe('launch-claimed');
    expect(reads).toBe(1);
    expect(h.manager.list().filter((record) => record.contractRole === 'owner')).toHaveLength(1);
  });

  test('same key with changed payload or any authority/input/scope revision is rejected', async () => {
    const h = setup();
    await h.runner.startDurable(request(h.root));
    for (const field of ['inputRevision', 'actionRevision', 'authorityId', 'authorityRevision', 'scopeId', 'scopeRevision'] as const) {
      const changed = request(h.root);
      await expect(h.runner.startDurable({ ...changed, binding: { ...changed.binding, [field]: 'changed' } })).rejects.toMatchObject({ code: 'conflict' });
    }
    const changed = request(h.root);
    await expect(h.runner.startDurable({ ...changed, input: { ...changed.input, ask: 'a different action' } })).rejects.toMatchObject({ code: 'conflict' });
  });

  test('revocation in reentrant creation hooks is checked after hooks and launches nothing', async () => {
    let current = true;
    let checks = 0;
    const h = setup({ withCurrent: (_admission, launch) => launch(() => { checks++; if (!current) throw new Error('revoked'); }) });
    h.runner.on((event) => { if (event.type === 'CONTRACT_CREATED') current = false; });
    await expect(h.runner.startDurable(request(h.root))).rejects.toThrow('revoked');
    expect(checks).toBe(1);
    expect(h.agentsOf('u1')).toHaveLength(0);
    expect(h.events.some((event) => event.type === 'CONTRACT_SHAPED')).toBe(false);
    expect((await h.runner.startDurable(request(h.root))).state).toBe('terminal');
  });

  test('reentrant owner cancellation persists terminal and never calls launch boundary', async () => {
    let checks = 0;
    const h = setup({ withCurrent: (_admission, launch) => { checks++; launch(() => undefined); } });
    h.runner.on((event) => { if (event.type === 'CONTRACT_CREATED') h.runner.cancel(event.contractId, 'cancelled'); });
    expect((await h.runner.startDurable(request(h.root))).state).toBe('terminal');
    expect(checks).toBe(0);
    expect(h.agentsOf('u1')).toHaveLength(0);
  });

  test('slot-delayed launch revalidates authority after queued hooks', async () => {
    let current = true;
    let validations = 0;
    const h = setup({ withCurrent: (_admission, launch) => launch(() => { validations++; if (!current) throw new Error('revoked'); }) }, makeRepo(), 1);
    const first = await h.runner.startDurable(request(h.root));
    const other = { ...request(h.root), key: { ...key, attemptId: 'attempt-2' } };
    const second = await h.runner.startDurable(other);
    expect(second.state).toBe('prepared');
    current = false;
    h.runner.cancel(first.admission.contractId, 'slot free');
    await waitFor(() => h.store.get(second.admission.contractId)?.status === 'cancelled', 'queued binding is rejected');
    expect(validations).toBe(2);
  });

  test('generic resume never adopts a native-bound contract; explicit resume requires a boundary', async () => {
    const h = setup(undefined, makeRepo(), 0);
    const initial = await h.runner.startDurable(request(h.root));
    h.dispose();
    await h.runner.join(initial.admission.contractId);
    const uncomposed = makeHarness({ root: h.root, scripts: {} });
    harnesses.push(uncomposed);
    expect((await uncomposed.runner.resumeAll()).skipped).toContain(initial.admission.contractId);
    await expect(uncomposed.runner.resumeDurable(key)).rejects.toMatchObject({ code: 'boundary' });
    expect(uncomposed.manager.list()).toHaveLength(0);
  });

  test('explicit resume validates frozen target and actor; revocation does not relaunch', async () => {
    const h = setup(undefined, makeRepo(), 0);
    const initial = await h.runner.startDurable(request(h.root));
    h.dispose();
    await h.runner.join(initial.admission.contractId);
    let checked = 0;
    const resumed = setup({ withCurrent: (admission, launch) => launch(() => {
      checked++; expect(admission.binding.authorityId).toBe('actor-1'); throw new Error('revoked');
    }) }, h.root);
    await expect(resumed.runner.resumeDurable(key)).rejects.toThrow('revoked');
    expect(checked).toBe(1);
    expect(resumed.agentsOf('u1')).toHaveLength(0);
    expect((await resumed.runner.startDurable(request(h.root))).state).toBe('terminal');
  });

  test('another live runner cannot resume and duplicate an execution', async () => {
    const h = setup();
    const first = await h.runner.startDurable(request(h.root));
    const other = setup(undefined, h.root);
    expect((await other.runner.startDurable(request(h.root))).admission).toEqual(first.admission);
    await expect(other.runner.resumeDurable(key)).rejects.toThrow('cross-process-lock');
    expect(other.manager.list()).toHaveLength(0);
  });

  test('terminal checkpoints and admission receipts survive housekeeping and reject force-import bypass', async () => {
    const h = setup(undefined, makeRepo(), 0);
    const first = await h.runner.startDurable(request(h.root));
    h.runner.cancel(first.admission.contractId, 'cancel');
    const snapshot = JSON.parse(h.runner.serializeContract(first.admission.contractId)!);
    snapshot.contract.completedAt = 1;
    snapshot.writtenAt = 1;
    writeFileSync(contractPath(h.root, first.admission.contractId), JSON.stringify(snapshot));
    expect(h.store.reap().total).toBe(0);
    delete snapshot.contract.durableAdmission;
    expect(h.runner.importContract(JSON.stringify(snapshot), true)).toBe(false);
    expect((await h.runner.resumeDurable(key)).state).toBe('terminal');
  });

  test('checkpoint payload divergence fails closed even if it retains the valid receipt hash', async () => {
    const h = setup(undefined, makeRepo(), 0);
    const first = await h.runner.startDurable(request(h.root));
    h.dispose(); await h.runner.join(first.admission.contractId);
    const path = contractPath(h.root, first.admission.contractId);
    const checkpoint = JSON.parse(readFileSync(path, 'utf8'));
    checkpoint.contract.ask = 'a different target';
    new DurableContractAdmissions(h.root).update(checkpoint.contract.durableAdmission, JSON.stringify(checkpoint));
    const next = setup(undefined, h.root);
    await expect(next.runner.resumeDurable(key)).rejects.toMatchObject({ code: 'checkpoint' });
    expect(next.manager.list()).toHaveLength(0);
  });

  test('a reentrant hook cannot substitute the live contract payload after it was frozen', async () => {
    const h = setup();
    h.runner.on((event) => {
      if (event.type === 'CONTRACT_CREATED') Object.assign(h.store.get(event.contractId)!, { ask: 'substituted target' });
    });
    await expect(h.runner.startDurable(request(h.root))).rejects.toMatchObject({ code: 'checkpoint' });
    expect(h.agentsOf('u1')).toHaveLength(0);
  });

  test.each(['missing', 'corrupt'])('authoritative receipt fences stripped imports and unbound resume with %s compatibility file', async (kind) => {
    const first = setup(undefined, makeRepo(), 0);
    const started = await first.runner.startDurable(request(first.root));
    const snapshot = JSON.parse(first.runner.serializeContract(started.admission.contractId)!);
    first.dispose(); await first.runner.join(started.admission.contractId);
    delete snapshot.contract.durableAdmission;
    delete snapshot.contract.durableLaunchState;
    const path = contractPath(first.root, started.admission.contractId);
    if (kind === 'missing') unlinkSync(path); else writeFileSync(path, '{');
    const next = setup(undefined, first.root);
    expect(next.runner.importContract(JSON.stringify(snapshot), true)).toBe(false);
    writeFileSync(path, JSON.stringify(snapshot));
    expect((await next.runner.resumeAll()).resumed).toHaveLength(0);
    expect(next.manager.list()).toHaveLength(0);
    const resumed = await next.runner.resumeDurable(key);
    expect(resumed.admission).toEqual(started.admission);
  });

  test('corrupt receipt fails closed instead of admitting a replacement', async () => {
    const h = setup(undefined, makeRepo(), 0);
    const first = await h.runner.startDurable(request(h.root));
    const { readdirSync } = await import('node:fs');
    const directory = join(h.root, '.goodvibes/contracts/admissions');
    const file = readdirSync(directory).find((file) => file.endsWith('.json'))!;
    writeFileSync(join(directory, file), '{');
    await expect(h.runner.startDurable(request(h.root))).rejects.toMatchObject({ code: 'invalid' });
    expect(h.runner.get(first.admission.contractId)).not.toBeNull();
    expect(h.manager.list().filter((record) => record.contractRole === 'owner')).toHaveLength(1);
  });

  test.each(['envelope', 'persisted', 'launched'])('real process death after %s and before ack preserves one binding', async (crash) => {
    const root = makeRepo(); roots.push(root);
    const support = fileURLToPath(new URL('./runner-support.ts', import.meta.url));
    const code = `import { makeHarness, oneUnitPlan } from ${JSON.stringify(support)};
      const request = ${JSON.stringify(request(root))};
      const h = makeHarness({ root: ${JSON.stringify(root)}, plan: oneUnitPlan(), scripts: {},
        durableAdmission: { withCurrent: (_admission, launch) => { ${crash === 'launched' ? 'launch(() => undefined);' : ''} process.exit(71); } } });
      ${crash === 'envelope' ? 'h.store.write = () => { process.exit(71); };' : ''}
      await h.runner.startDurable(request); process.exit(72);`;
    const crashed = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 20_000 });
    expect(crashed.status).toBe(71);
    let validations = 0;
    const h = setup({ withCurrent: (_admission, launch) => launch(() => { validations++; }) }, root);
    const replay = await h.runner.startDurable(request(root));
    expect(replay.state).toBe(crash === 'launched' ? 'launch-claimed' : 'prepared');
    expect(validations).toBe(0);
    const automatic = await h.runner.resumeAll();
    expect(automatic.resumed).toHaveLength(0);
    if (crash !== 'envelope') expect(automatic.skipped).toContain(replay.admission.contractId);
    const resumed = await h.runner.resumeDurable(key);
    expect(resumed.admission).toEqual(replay.admission);
    expect(validations).toBe(1);
    await waitFor(() => h.agentsOf('u1').length === 1, 'one resumed unit');
    expect((await h.runner.startDurable(request(root))).admission).toEqual(replay.admission);
    expect((await h.runner.resumeDurable(key)).admission).toEqual(replay.admission);
    expect(h.agentsOf('u1')).toHaveLength(1);
    expect(validations).toBe(2); // Admission and the actual unit executor both validate live authority.
  });
});

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ConfigManager } from '../sdk/src/platform/config/manager.ts';
import { PermissionManager, createPermissionConfigReader, isAuthenticAutonomousAdmission,
  type AutonomousPermissionAdmission, type PermissionConfigReader } from '../sdk/src/platform/permissions/manager.ts';
import { UserPermissionRuleStore } from '../sdk/src/platform/permissions/user-rule-store.ts';
import { PolicyRuntimeState } from '../sdk/src/platform/runtime/permissions/policy-runtime.ts';
import { ToolRegistry, assertCurrentToolExecution } from '../sdk/src/platform/tools/registry.ts';
import { ToolInputProjectionError, type ToolInputProjector } from '../sdk/src/platform/tools/input-projection.ts';
import { EXEC_TOOL_SCHEMA } from '../sdk/src/platform/tools/exec/schema.ts';
import type { Tool, ToolExecuteOptions } from '../sdk/src/platform/types/tools.ts';
import { executeToolCalls, type ToolExecutionDeps } from '../sdk/src/platform/core/orchestrator-tool-runtime.ts';
import { forgetGateReadings, gateReadingsPort } from './_helpers/gate-readings.ts';
import { replaceInternalStore } from './_helpers/controllable-store.ts';

let previous: ReturnType<typeof installJudgmentPort>;
let log: SqliteDecisionLog;
let disposition = 'act';
const roots: string[] = [];
beforeEach(() => {
  forgetGateReadings(); disposition = 'act'; log = new SqliteDecisionLog(':memory:');
  const gate = gateReadingsPort();
  const semantic = fakePort((_name, question) => choiceAnswer(question, disposition, 0.97));
  const inner: JudgmentPort = { model: gate.port.model, ask(request) {
    return 'disposition' in request.questions ? semantic.port.ask(request) : gate.port.ask(request);
  } };
  previous = installJudgmentPort(withDecisionLog(inner, log));
});
afterEach(() => {
  installJudgmentPort(previous); log[Symbol.dispose](); forgetGateReadings();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const input = () => ({ commands: [{ cmd: 'git status --synthetic-admission' }] });
const sourceOf = () => ({ goal: 'Inspect the synthetic project', criteria: ['Execute the exact prepared input once'] });
function fixture(body: Tool['execute'], projector?: ToolInputProjector, config?: PermissionConfigReader, store?: UserPermissionRuleStore, bindOwner = false) {
  const reader = config ?? {
    getAutonomousSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} }, autoApprove: false, directory: '/synthetic/project' }),
    isAutoApproveEnabled: () => false, getSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} } }), getWorkingDirectory: () => '/synthetic/project',
  } as PermissionConfigReader;
  const manager = new PermissionManager(undefined, reader, new PolicyRuntimeState(), null, null, store);
  const registry = new ToolRegistry(bindOwner ? manager : undefined);
  const tool: Tool = { definition: { name: 'exec', description: 'Intercepted synthetic execution.', parameters: EXEC_TOOL_SCHEMA }, execute: body };
  registry.register(tool, projector ? { inputProjection: projector } : undefined);
  const admit = async (id = 'first', signal?: AbortSignal) => {
    const call = await registry.prepareCall(id, 'exec', input(), { signal });
    const admission = await manager.admitAutonomous(id, call.name, call.args, {
      sourceOf, signal, schemaRevision: call.schemaRevision, preparedCall: { registry, call },
    });
    return { call, admission };
  };
  return { registry, tool, manager, admit };
}

test('a recorded manager admission authenticates only the exact live arguments and options', async () => {
  let retainedArgs!: Record<string, unknown>; let retainedOptions!: ToolExecuteOptions;
  const { registry, admit } = fixture(async (args, options) => {
    retainedArgs = args; retainedOptions = options!;
    expect(Object.isFrozen(options)).toBe(true);
    expect(assertCurrentToolExecution(args, options)).toBe(true);
    expect(assertCurrentToolExecution(args, { ...options })).toBe(false);
    expect(() => assertCurrentToolExecution({ ...args }, options)).toThrow(ToolInputProjectionError);
    expect(assertCurrentToolExecution(args, options)).toBe(true);
    return { success: true };
  });
  const { call, admission } = await admit();
  expect(await registry.executePrepared(call, admission)).toMatchObject({ success: true });
  expect(() => assertCurrentToolExecution(retainedArgs, retainedOptions)).toThrow(ToolInputProjectionError);
  await expect(registry.executePrepared(call, admission)).rejects.toThrow();
});

test('legacy callbacks and public admission.claim cannot manufacture strict body proof', async () => {
  const proofs: boolean[] = [];
  const { registry, admit } = fixture(async (args, options) => {
    proofs.push(assertCurrentToolExecution(args, options)); return { success: true };
  });
  const ordinary = await registry.prepareCall('legacy', 'exec', input());
  await registry.executePrepared(ordinary, () => {});
  const { call, admission } = await admit();
  await registry.executePrepared(call, admission.claim);
  expect(proofs).toEqual([false, false]);
});

test.each(['copied', 'forged'])('a %s admission cannot authenticate even with a genuine claim callback', async kind => {
  let bodies = 0;
  const { registry, admit } = fixture(async () => { bodies++; return { success: true }; });
  const { call, admission } = await admit();
  await expect(registry.executePrepared(call, kind === 'copied' ? { ...admission } : legacyAdmission(admission.claim))).rejects.toThrow('does not authenticate');
  expect(bodies).toBe(0);
});

test('a genuine admission refuses another prepared call without consuming the genuine handle', async () => {
  let bodies = 0;
  const { registry, admit } = fixture(async (args, options) => {
    expect(assertCurrentToolExecution(args, options)).toBe(true); bodies++; return { success: true };
  });
  const { call, admission } = await admit();
  const other = await registry.prepareCall('other', 'exec', input());
  await expect(registry.executePrepared(other, admission)).rejects.toThrow('does not authenticate');
  expect(await registry.executePrepared(call, admission)).toMatchObject({ success: true });
  expect(bodies).toBe(1);
});

test.each(['reject', 'defer_0'])('non-act %s has no executable body proof', async selected => {
  disposition = selected; let bodies = 0;
  const { registry, admit } = fixture(async () => { bodies++; return { success: true }; });
  const { call, admission } = await admit();
  await expect(registry.executePrepared(call, admission)).rejects.toThrow('does not authenticate');
  expect(bodies).toBe(0);
});

test('the exact active proof detects cancellation and retires on body failure', async () => {
  const controller = new AbortController();
  let retainedArgs!: Record<string, unknown>; let retainedOptions!: ToolExecuteOptions;
  const { registry, admit } = fixture(async (args, options) => {
    retainedArgs = args; retainedOptions = options!;
    expect(assertCurrentToolExecution(args, options)).toBe(true);
    controller.abort();
    expect(() => assertCurrentToolExecution(args, options)).toThrow();
    throw new Error('synthetic body failure');
  });
  const { call, admission } = await admit('first', controller.signal);
  await expect(registry.executePrepared(call, admission)).rejects.toThrow('synthetic body failure');
  expect(() => assertCurrentToolExecution(retainedArgs, retainedOptions)).toThrow();
});

test('active checks do not re-enter preclaim projection guards', async () => {
  let running = false;
  const projector: ToolInputProjector = { async project(request) {
    return { status: 'projected', args: request.args, assertCurrent() { if (running) throw new Error('preclaim-only'); } };
  } };
  const { registry, admit } = fixture(async (args, options) => {
    running = true; expect(assertCurrentToolExecution(args, options)).toBe(true); return { success: true };
  }, projector);
  const { call, admission } = await admit();
  expect(await registry.executePrepared(call, admission)).toMatchObject({ success: true });
});

test('captured registration evidence is closed, detached, frozen and bound to exact handles', async () => {
  const evidence = { kind: 'agent-read' as const, root: '/synthetic/project', paths: ['/synthetic/project/a.ts'], revision: 'a'.repeat(64) };
  const { registry } = fixture(async () => ({ success: true }), { async project(request) {
    return { status: 'projected', args: request.args, admissionEvidence: evidence };
  } });
  const call = await registry.prepareCall('first', 'exec', input());
  const captured = registry.readPreparedAdmissionEvidence(call)!;
  evidence.paths[0] = '/synthetic/changed';
  expect(captured.paths).toEqual(['/synthetic/project/a.ts']);
  expect(Object.isFrozen(captured)).toBe(true); expect(Object.isFrozen(captured.paths)).toBe(true);
  expect(() => registry.readPreparedAdmissionEvidence({ ...call })).toThrow();
  await registry.executePrepared(call, () => {});
});

test('accessor-backed admission evidence is refused without invoking its getter', async () => {
  let traps = 0;
  const evidence = Object.defineProperty({ kind: 'agent-read', paths: [], revision: 'a'.repeat(64) }, 'root', {
    enumerable: true, get() { traps++; return '/synthetic/project'; },
  });
  const { registry } = fixture(async () => ({ success: true }), { async project(request) {
    return { status: 'projected', args: request.args, admissionEvidence: evidence as never };
  } });
  await expect(registry.prepareCall('first', 'exec', input())).rejects.toBeInstanceOf(ToolInputProjectionError);
  expect(traps).toBe(0);
});

test('config ABA advances before listeners and invalidates a pending authentic admission', async () => {
  const root = mkdtempSync(join(tmpdir(), 'authentic-admission-')); roots.push(root);
  const config = new ConfigManager({ configDir: root });
  const initial = config.getAutonomousPermissionSnapshot();
  const observed: number[] = [];
  config.onDidInvalidate(() => observed.push(config.getAutonomousPermissionSnapshot().incarnation));
  let bodies = 0;
  const { registry, admit } = fixture(async () => { bodies++; return { success: true }; }, undefined, createPermissionConfigReader(config));
  const { call, admission } = await admit();
  config.set('permissions.mode', 'allow-all'); config.set('permissions.mode', initial.permissions.mode);
  expect(observed[0]).toBeGreaterThan(initial.incarnation);
  expect(config.getAutonomousPermissionSnapshot().permissions).toEqual(initial.permissions);
  await expect(registry.executePrepared(call, admission)).rejects.toThrow();
  expect(bodies).toBe(0);
});

test('a mutable public snapshot cannot alter the private admission capture or owner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'authentic-admission-')); roots.push(root);
  const config = new ConfigManager({ configDir: root });
  const exposed = config.getAutonomousPermissionSnapshot();
  const originalRead = config.get('permissions.tools.read');
  let bodies = 0;
  const { registry, admit } = fixture(async (args, options) => {
    expect(assertCurrentToolExecution(args, options)).toBe(true);
    bodies++; return { success: true };
  }, undefined, createPermissionConfigReader(config));
  const { call, admission } = await admit();
  const authorityRevision = admission.result.autonomousDecision?.binding.authorityRevision;
  exposed.permissions.tools.read = 'deny';
  expect(config.get('permissions.tools.read')).toBe(originalRead);
  expect(admission.result.autonomousDecision?.binding.authorityRevision).toBe(authorityRevision);
  expect(await registry.executePrepared(call, admission)).toMatchObject({ success: true });
  expect(bodies).toBe(1);
});

test('committed durable-rule add/delete ABA invalidates a pending authentic admission', async () => {
  const store = new UserPermissionRuleStore(':memory:'); await store.init();
  const initial = store.getPublicationRevision(); let bodies = 0;
  const { registry, admit } = fixture(async () => { bodies++; return { success: true }; }, undefined, undefined, store);
  const { call, admission } = await admit();
  await store.add({ rule: { id: 'temporary', type: 'prefix', description: 'Synthetic deny', origin: 'user', effect: 'deny', toolPattern: 'exec', commandPrefixes: [] },
    createdAt: 0, tier: 'tool', tool: 'exec' });
  await store.delete('temporary');
  expect(store.rules()).toEqual([]); expect(store.getPublicationRevision()).toBe(initial + 2);
  await expect(registry.executePrepared(call, admission)).rejects.toThrow();
  expect(bodies).toBe(0);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function pendingRuleOwner() {
  const store = new UserPermissionRuleStore(':memory:');
  const started = deferred<void>(); const finish = deferred<void>(); let loads = 0;
  replaceInternalStore(store, 'store', { async load() { loads++; started.resolve(); await finish.promise; return null; } });
  return { store, started, finish, loads: () => loads };
}

test('rule initialization is single-flight and publishes only once', async () => {
  const owner = pendingRuleOwner();
  const first = owner.store.init(); const second = owner.store.init();
  expect(first).toBe(second);
  await owner.started.promise;
  expect(owner.loads()).toBe(1); expect(owner.store.getPublicationRevision()).toBe(0);
  owner.finish.resolve(); await Promise.all([first, second]);
  expect(owner.store.init()).toBe(first); expect(owner.store.getPublicationRevision()).toBe(1);
});

test('failed rule initialization keeps legacy fallback but never reports authoritative readiness', async () => {
  const owner = pendingRuleOwner(); const failure = new Error('synthetic owner load failed');
  const first = owner.store.init();
  await owner.started.promise; owner.finish.reject(failure);
  await expect(first).resolves.toBeUndefined();
  expect(owner.store.init()).toBe(first);
  await expect(owner.store.init()).resolves.toBeUndefined();
  await expect(owner.store.awaitReady()).rejects.toBe(failure);
  await expect(owner.store.awaitReady()).rejects.toBe(failure);
  expect(owner.store.rules()).toEqual([]); expect(owner.store.getPublicationRevision()).toBe(0);
  expect(owner.loads()).toBe(1);
});

test('direct admission waits for rule readiness before reading authority or deciding', async () => {
  const owner = pendingRuleOwner(); let bodies = 0;
  const { registry, admit } = fixture(async (args, options) => {
    expect(assertCurrentToolExecution(args, options)).toBe(true); bodies++; return { success: true };
  }, undefined, undefined, owner.store);
  const pending = admit(); await owner.started.promise;
  expect(log.query()).toHaveLength(0); expect(bodies).toBe(0);
  owner.finish.resolve(); const { call, admission } = await pending;
  expect(await registry.executePrepared(call, admission)).toMatchObject({ success: true });
  expect(bodies).toBe(1); expect(owner.loads()).toBe(1);
});

test.each(['ready', 'cancelled'])('first-turn execution holds preparation until the rule owner is %s', async outcome => {
  const owner = pendingRuleOwner(); let bodies = 0; let sources = 0;
  const controller = new AbortController();
  const { registry, manager } = fixture(async (args, options) => {
    expect(assertCurrentToolExecution(args, options)).toBe(true); bodies++; return { success: true };
  }, undefined, undefined, owner.store);
  const deps: ToolExecutionDeps = { permissionManager: manager, toolRegistry: registry,
    autonomousSource: () => { sources++; return sourceOf(); }, turnSignal: controller.signal,
    hookDispatcher: null, runtimeBus: null, sessionId: 'readiness-fixture',
    emitterContext: () => ({ sessionId: 'readiness-fixture', traceId: 'synthetic', source: 'orchestrator' }) };
  const pending = executeToolCalls(deps, 'turn-first', [{ id: 'first', name: 'exec', arguments: input() }]);
  await owner.started.promise;
  expect(sources).toBe(0); expect(log.query()).toHaveLength(0); expect(bodies).toBe(0);
  if (outcome === 'cancelled') {
    controller.abort();
    await expect(pending).rejects.toBeDefined();
    // A cancelled caller drains the eventual owner result; it never resumes.
    owner.finish.resolve(); await owner.store.init();
    expect(sources).toBe(0); expect(log.query()).toHaveLength(0); expect(bodies).toBe(0);
  } else {
    owner.finish.resolve();
    expect(await pending).toMatchObject([{ success: true }]); expect(bodies).toBe(1);
  }
  expect(owner.loads()).toBe(1);
});

test('owner initialization failure stops direct admission before judgment and body', async () => {
  const owner = pendingRuleOwner(); let bodies = 0;
  const { admit, manager } = fixture(async () => { bodies++; return { success: true }; }, undefined, undefined, owner.store);
  const pending = admit(); await owner.started.promise;
  const failure = new Error('synthetic owner unavailable'); owner.finish.reject(failure);
  await expect(pending).rejects.toBe(failure);
  await expect(manager.prepareAutonomousOwner()).rejects.toBe(failure);
  expect(log.query()).toHaveLength(0); expect(bodies).toBe(0); expect(owner.loads()).toBe(1);
});

function legacyAdmission(claim: () => void = () => {}): AutonomousPermissionAdmission {
  return { result: { approved: true, persisted: false, sourceLayer: 'config_policy', reasonCode: 'config_allow',
    analysis: { classification: 'generic', riskLevel: 'medium', summary: 'Synthetic embedding approval', reasons: [] } },
  revisionIds: [], claim };
}

function embeddingDeps(manager: PermissionManager, registry: ToolRegistry,
  admitAutonomous: PermissionManager['admitAutonomous']): ToolExecutionDeps {
  return { permissionManager: { check: manager.check.bind(manager), checkDetailed: manager.checkDetailed.bind(manager),
    autonomousPreparation: manager.autonomousPreparation.bind(manager), admitAutonomous },
  toolRegistry: registry, autonomousSource: sourceOf, hookDispatcher: null, runtimeBus: null,
  sessionId: 'embedding-fixture', emitterContext: () => ({ sessionId: 'embedding-fixture', traceId: 'synthetic', source: 'orchestrator' }) };
}

const runEmbedding = (deps: ToolExecutionDeps) => executeToolCalls(deps, 'turn-embedding', [{ id: 'first', name: 'exec', arguments: input() }]);

test('the identity query is read-only and never classifies a copy, fake or proxy as authentic', async () => {
  const { registry, admit } = fixture(async () => ({ success: true }));
  const { call, admission } = await admit(); let traps = 0;
  expect(isAuthenticAutonomousAdmission(admission)).toBe(true);
  expect(isAuthenticAutonomousAdmission({ ...admission })).toBe(false);
  expect(isAuthenticAutonomousAdmission(legacyAdmission())).toBe(false);
  expect(isAuthenticAutonomousAdmission(new Proxy(admission, { get() { traps++; throw new Error('trap'); } }))).toBe(false);
  expect(traps).toBe(0);
  expect(await registry.executePrepared(call, admission)).toMatchObject({ success: true });
  // Keeping the brand cannot make a consumed capability take a legacy fallback.
  expect(isAuthenticAutonomousAdmission(admission)).toBe(true);
});

test('a raw embedding manager retains callback execution without any strict-body proof', async () => {
  let claims = 0; let effects = 0; const proofs: boolean[] = [];
  const { registry, manager } = fixture(async (args, options) => {
    proofs.push(assertCurrentToolExecution(args, options)); effects++; return { success: true };
  });
  const deps = embeddingDeps(manager, registry, async () => legacyAdmission(() => { claims++; }));
  expect(await runEmbedding(deps)).toMatchObject([{ success: true }]);
  expect(claims).toBe(1); expect(effects).toBe(1); expect(proofs).toEqual([false]);
  expect(log.query()).toHaveLength(0);
});

test.each(['fake', 'copy'])('an unbranded %s embedding admission cannot pass a strict-body proof guard', async kind => {
  let effects = 0;
  const { registry, manager } = fixture(async (args, options) => {
    if (!assertCurrentToolExecution(args, options)) throw new ToolInputProjectionError('held');
    effects++; return { success: true };
  });
  const deps = embeddingDeps(manager, registry, async (...args) => kind === 'fake'
    ? legacyAdmission() : { ...await manager.admitAutonomous(...args) });
  expect(await runEmbedding(deps)).toMatchObject([{ success: false }]);
  expect(effects).toBe(0);
});

test.each(['fake', 'copy'])('registration-owned adoption prevents %s admission callback fallback entirely', async kind => {
  let bodies = 0; let legacyClaims = 0;
  const { registry, manager } = fixture(async () => { bodies++; return { success: true }; }, { async project(request) {
    return { status: 'projected', args: request.args, admissionEvidence: {
      kind: 'agent-read', root: '/synthetic/project', paths: [], revision: 'a'.repeat(64),
    } };
  } });
  const deps = embeddingDeps(manager, registry, async (...args) => kind === 'fake'
    ? legacyAdmission(() => { legacyClaims++; }) : { ...await manager.admitAutonomous(...args) });
  expect(await runEmbedding(deps)).toMatchObject([{ success: false }]);
  expect(bodies).toBe(0); expect(legacyClaims).toBe(0);
});

test('another real manager and registry admission cannot downgrade into callback execution', async () => {
  let effects = 0;
  const foreign = fixture(async () => { effects++; return { success: true }; });
  const owned = fixture(async () => { effects++; return { success: true }; });
  const { call, admission } = await foreign.admit('foreign');
  expect(isAuthenticAutonomousAdmission(admission)).toBe(true);
  expect(await runEmbedding(embeddingDeps(owned.manager, owned.registry, async () => admission))).toMatchObject([{ success: false }]);
  expect(effects).toBe(0);
  expect(await foreign.registry.executePrepared(call, admission)).toMatchObject({ success: true });
  expect(effects).toBe(1);
});

test('the object overload refuses copied prepared handles and another registry without consuming admission', async () => {
  let effects = 0;
  const first = fixture(async () => { effects++; return { success: true }; });
  const second = fixture(async () => { effects++; return { success: true }; });
  const { call, admission } = await first.admit();
  await expect(first.registry.executePrepared({ ...call }, admission)).rejects.toThrow();
  const other = await second.registry.prepareCall(call.callId, call.name, input());
  await expect(second.registry.executePrepared(other, admission)).rejects.toThrow('does not authenticate');
  expect(effects).toBe(0);
  expect(await first.registry.executePrepared(call, admission)).toMatchObject({ success: true });
  expect(effects).toBe(1);
});

test('a bound registry rejects another genuine manager for the exact same prepared handle', async () => {
  let effects = 0;
  const owned = fixture(async (args, options) => {
    expect(assertCurrentToolExecution(args, options)).toBe(true); effects++; return { success: true };
  }, undefined, undefined, undefined, true);
  const foreign = fixture(async () => ({ success: true }));
  const call = await owned.registry.prepareCall('first', 'exec', input());
  const admission = await foreign.manager.admitAutonomous('foreign', call.name, call.args, {
    sourceOf, schemaRevision: call.schemaRevision, preparedCall: { registry: owned.registry, call },
  });
  expect(isAuthenticAutonomousAdmission(admission)).toBe(true);
  await expect(owned.registry.executePrepared(call, admission)).rejects.toThrow('does not authenticate');
  expect(effects).toBe(0);
  // The construction-owned manager can execute a freshly prepared call.
  const fresh = await owned.admit('second');
  expect(await owned.registry.executePrepared(fresh.call, fresh.admission)).toMatchObject({ success: true });
  expect(effects).toBe(1);
});

test('an unbound raw registry accepts a genuine admission for its exact handle from another manager', async () => {
  let effects = 0;
  const raw = fixture(async (args, options) => {
    expect(assertCurrentToolExecution(args, options)).toBe(true); effects++; return { success: true };
  });
  const foreign = fixture(async () => ({ success: true }));
  const call = await raw.registry.prepareCall('first', 'exec', input());
  const admission = await foreign.manager.admitAutonomous('foreign', call.name, call.args, {
    sourceOf, schemaRevision: call.schemaRevision, preparedCall: { registry: raw.registry, call },
  });
  expect(await raw.registry.executePrepared(call, admission)).toMatchObject({ success: true });
  expect(effects).toBe(1);
});


test.each(['unchanged', 'cancel', 'authority', 'registration'])('registered read publication is current through final cleanup: %s', async change => {
  let revoked = false, bodyArgs!: Record<string, unknown>, bodyOptions!: ToolExecuteOptions;
  const started = deferred<void>(), finish = deferred<void>(), controller = new AbortController();
  const config = { getAutonomousSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} }, autoApprove: revoked, directory: '/synthetic/project' }),
    isAutoApproveEnabled: () => revoked, getSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} } }), getWorkingDirectory: () => '/synthetic/project' } as PermissionConfigReader;
  const { registry, admit } = fixture(async (args, options) => { bodyArgs = args; bodyOptions = options!; return { success: true }; },
    { async project(request) { return { status: 'projected', args: request.args, resultPublication: 'read-only', async release() { started.resolve(); await finish.promise; } }; } }, config);
  const { call, admission } = await admit('publication', controller.signal);
  const pending = registry.executePrepared(call, admission);
  await started.promise;
  expect(() => assertCurrentToolExecution(bodyArgs, bodyOptions)).toThrow();
  if (change === 'cancel') controller.abort();
  else if (change === 'authority') revoked = true;
  else if (change === 'registration') registry.unregister('exec');
  finish.resolve();
  if (change === 'unchanged') expect(await pending).toMatchObject({ success: true });
  else await expect(pending).rejects.toThrow();
  await expect(registry.executePrepared(call, admission)).rejects.toThrow();
});

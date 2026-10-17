import { assertJudgmentInput } from '../sdk/src/platform/gate/judgment-input.js';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort, type EntryType } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ToolRegistry, assertCurrentToolEffect, currentToolAutonomySource, type CurrentToolAutonomySource } from '../sdk/src/platform/tools/registry.ts';
import { ToolInputProjectionError, type ToolInputProjector } from '../sdk/src/platform/tools/input-projection.ts';
import { PermissionManager, claimExternalAdmission, assertCurrentExternalAdmission, closeExternalAdmission, type PermissionConfigReader } from '../sdk/src/platform/permissions/manager.ts';
import { DEFAULT_CONFIG, type PermissionMode, type PermissionsToolConfig } from '../sdk/src/platform/config/index.ts';
import { PolicyRuntimeState } from '../sdk/src/platform/runtime/permissions/policy-runtime.ts';
import type { Tool, ToolExecuteOptions } from '../sdk/src/platform/types/tools.ts';
import { forgetGateReadings, gateReadingsPort, READ_ONLY } from './_helpers/gate-readings.ts';

const PARENT = 'nested_parent_fixture';
const CHILD = 'write';
let previous: ReturnType<typeof installJudgmentPort>;
let log: SqliteDecisionLog;
let disposition: (state: EntryType) => 'act' | 'reject';
let beforeReading: (() => Promise<void>) | undefined;
const states: EntryType[] = [];

beforeEach(() => {
  forgetGateReadings(); log = new SqliteDecisionLog(':memory:'); states.length = 0;
  disposition = () => 'act'; beforeReading = undefined;
  const gate = gateReadingsPort([[PARENT, READ_ONLY], [CHILD, READ_ONLY]]);
  const semantic = fakePort((_name, question, state) => choiceAnswer(question, disposition(state), 0.999));
  const port: JudgmentPort = { model: gate.port.model, async ask(request) {
    request.signal?.throwIfAborted(); request.beforeAttempt?.();
    if ('disposition' in request.questions) {
      states.push(request.state); await beforeReading?.();
      return semantic.port.ask(request);
    }
    return gate.port.ask(request);
  } };
  previous = installJudgmentPort(withDecisionLog(port, log));
});
afterEach(() => { installJudgmentPort(previous); log[Symbol.dispose](); forgetGateReadings(); });

function fixture(parentBody?: Tool['execute'], projection?: ToolInputProjector, initialMode: PermissionMode = 'prompt', tools: PermissionsToolConfig = {}) {
  let mode = initialMode, incarnation = 0, sequence = 0;
  let source = { goal: 'Perform the exact synthetic parent request', criteria: ['Write only the captured synthetic child target'] };
  const permissions = () => ({ ...DEFAULT_CONFIG.permissions, mode, tools });
  const reader: PermissionConfigReader = {
    getAutonomousSnapshot: () => ({ permissions: permissions(), autoApprove: false, directory: '/synthetic/nested', incarnation }),
    getSnapshot: () => ({ permissions: permissions() }), getWorkingDirectory: () => '/synthetic/nested', isAutoApproveEnabled: () => false,
  };
  const manager = new PermissionManager(undefined, reader, new PolicyRuntimeState());
  const registry = new ToolRegistry(manager);
  let effects = 0;
  let childOptions: ToolExecuteOptions | undefined;
  let childSource: CurrentToolAutonomySource | undefined;
  const child: Tool = { definition: { name: CHILD, description: 'Synthetic child write intercepted in memory.',
    parameters: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'], additionalProperties: false } },
    async execute(args, options) {
      childOptions = options; childSource = currentToolAutonomySource(args, options);
      if (!assertCurrentToolEffect(args, options, 'write')) return { success: false, error: 'No recorded child effect admission' };
      effects++; return { success: true, output: String(args.target) };
    } };
  registry.register(child, projection ? { inputProjection: projection } : undefined);
  const parent: Tool = { definition: { name: PARENT, description: 'Synthetic parent delegates one actual child operation.',
    parameters: { type: 'object', properties: {}, additionalProperties: true } },
    execute: parentBody ?? ((_args, options) => registry.executeNested('child-call', CHILD, { target: 'captured-target' }, options)),
  };
  registry.register(parent);
  return { manager, registry, child, parent, get effects() { return effects; }, get childOptions() { return childOptions; }, get childSource() { return childSource; },
    setMode(next: PermissionMode) { mode = next; incarnation++; },
    setSource(goal: string) { source = { ...source, goal }; },
    async run(signal?: AbortSignal) {
      const id = `nested-parent-${++sequence}`;
      const call = await registry.prepareCall(id, PARENT, {}, { signal });
      const admission = await manager.admitAutonomous(id, PARENT, call.args, { sourceOf: () => source, signal,
        schemaRevision: call.schemaRevision, preparedCall: { registry, call } });
      if (!admission.result.approved) throw new Error(admission.result.reasonCode);
      return registry.executePrepared(call, admission);
    },
  };
}

test('a child has a separate recorded act, exact arguments, and original parent source', async () => {
  const f = fixture(); expect(await f.run()).toMatchObject({ success: true, output: 'captured-target' });
  expect(f.effects).toBe(1); expect(states).toHaveLength(0);
  expect(f.childSource).toMatchObject({ goal: 'Perform the exact synthetic parent request', criteria: ['Write only the captured synthetic child target'] });
  expect(log.query({ site: 'engine.gate.autonomous-tool' })).toHaveLength(0);
});

test('a nested restriction checks its exact parent proof while the child keeps its own context', async () => {
  let childEntered = false, checkedDuringChild = false;
  let retained: { readonly args: Record<string, unknown>; readonly options: ToolExecuteOptions; readonly assertCurrent: () => void } | undefined;
  const f = fixture(async (args, options) => {
    if (!options) throw new Error('The recorded parent options are missing.');
    const assertCurrent = () => {
      expect(assertCurrentToolEffect(args, options, 'write')).toBe(true);
      expect(() => assertCurrentToolEffect({ ...args }, options)).toThrow();
      expect(() => assertCurrentToolEffect(args, { ...options })).toThrow();
      if (childEntered) checkedDuringChild = true;
    };
    retained = { args, options, assertCurrent };
    const result = await f.registry.executeNested('restricted-child', CHILD, { target: 'captured-target' }, options, { assertCurrent });
    expect(assertCurrentToolEffect(args, options, 'write')).toBe(true);
    return result;
  });
  const execute = f.child.execute;
  f.child.execute = async (args, options) => {
    childEntered = true;
    const parent = retained;
    if (!parent) throw new Error('The parent restriction was not captured.');
    expect(() => assertCurrentToolEffect(parent.args, parent.options, 'write')).toThrow();
    const result = await execute.call(f.child, args, options);
    expect(assertCurrentToolEffect(args, options, 'write')).toBe(true);
    return result;
  };
  expect(await f.run()).toMatchObject({ success: true, output: 'captured-target' });
  expect(checkedDuringChild).toBe(true); expect(f.effects).toBe(1);
  expect(states).toHaveLength(0); expect(log.query({ site: 'engine.gate.autonomous-tool' })).toHaveLength(0);
  expect(() => retained?.assertCurrent()).toThrow();
});

test.each(['cancel', 'revoke', 'source'] as const)('a parent %s during its nested restriction holds the child before effects', async kind => {
  let childEntered = false, retired = false;
  const controller = new AbortController();
  const f = fixture(async (args, options) => {
    const assertCurrent = () => {
      expect(assertCurrentToolEffect(args, options, 'write')).toBe(true);
      if (!childEntered || retired) return;
      retired = true;
      if (kind === 'cancel') controller.abort();
      else if (kind === 'revoke') f.setMode('plan');
      else f.setSource('Changed parent intent during the child effect check');
    };
    return f.registry.executeNested('retiring-restriction', CHILD, { target: 'captured-target' }, options, { assertCurrent });
  });
  const execute = f.child.execute;
  f.child.execute = async (args, options) => { childEntered = true; return execute.call(f.child, args, options); };
  await expect(f.run(controller.signal)).rejects.toThrow();
  expect(retired).toBe(true); expect(f.effects).toBe(0);
  expect(log.query({ site: 'engine.gate.autonomous-tool' })).toHaveLength(0);
});

test('raw callbacks and copied parent options cannot admit or dispatch a child', async () => {
  let projects = 0;
  const f = fixture(async (_args, options) => {
    await expect(f.registry.executeNested('copied', CHILD, { target: 'copied' }, { ...options })).rejects.toBeInstanceOf(ToolInputProjectionError);
    return { success: true };
  }, { async project(request) { projects++; return { status: 'projected', args: request.args }; } });
  await expect(f.registry.executeNested('raw', CHILD, { target: 'raw' }, { assertCurrent() {} })).rejects.toBeInstanceOf(ToolInputProjectionError);
  await f.run(); expect(projects).toBe(0); expect(f.effects).toBe(0);
  expect(log.query({ site: 'engine.gate.autonomous-tool' })).toHaveLength(0);
});

test('a different registry cannot inherit the authentic parent proof', async () => {
  const foreign = new ToolRegistry(); let effects = 0;
  foreign.register({ definition: { name: CHILD, description: 'Foreign intercepted child.', parameters: {} },
    async execute() { effects++; return { success: true }; } });
  const f = fixture(async (_args, options) => {
    await expect(foreign.executeNested('foreign', CHILD, {}, options)).rejects.toBeInstanceOf(ToolInputProjectionError);
    return { success: true };
  });
  await f.run(); expect(effects).toBe(0);
});

test('retained options cannot create a new child after parent completion', async () => {
  let retained: ToolExecuteOptions | undefined;
  const f = fixture(async (_args, options) => { retained = options; return { success: true }; });
  await f.run();
  await expect(f.registry.executeNested('retired', CHILD, { target: 'late' }, retained)).rejects.toBeInstanceOf(ToolInputProjectionError);
  expect(f.effects).toBe(0);
});

test('a parent admission does not override an explicit child denial', async () => {
  const f = fixture(undefined, undefined, 'custom', { write: 'deny' });
  expect(await f.run()).toMatchObject({ success: false, error: expect.stringContaining('config_deny') });
  expect(f.effects).toBe(0); expect(log.query({ site: 'engine.gate.autonomous-tool' })).toHaveLength(0);
});

test('read-only owner restrictions remain a separate child effect floor', async () => {
  const f = fixture(undefined, undefined, 'plan');
  await expect(f.run()).rejects.toThrow('plan_mode'); expect(f.effects).toBe(0);
});

test.each(['cancel', 'revoke', 'source'] as const)('parent %s during child projection drains it and prevents child readings/effects', async kind => {
  let release = 0, signal: (() => void) | undefined, resume: (() => void) | undefined;
  const entered = new Promise<void>(done => { signal = done; });
  const pending = new Promise<void>(done => { resume = done; });
  const controller = new AbortController();
  const f = fixture(undefined, { async project(request) {
    signal?.(); await pending; return { status: 'projected', args: request.args, async release() { release++; } };
  } });
  const result = f.run(controller.signal); const settled = result.then(() => undefined, (error: unknown) => error);
  await entered;
  if (kind === 'cancel') controller.abort(); else if (kind === 'revoke') f.setMode('plan'); else f.setSource('Changed parent intent');
  resume?.(); expect(await settled).toBeInstanceOf(Error); expect(release).toBe(1); expect(f.effects).toBe(0);
  expect(log.query({ site: 'engine.gate.autonomous-tool' })).toHaveLength(0);
});

test('source revocation after actual child admission prevents its effect', async () => {
  const f = fixture();
  const admit = f.manager.admitAutonomous.bind(f.manager);
  f.manager.admitAutonomous = async (...args) => {
    const result = await admit(...args);
    if (args[1] === CHILD) f.setSource('Changed while child admission was pending');
    return result;
  };
  await expect(f.run()).rejects.toThrow(); expect(f.effects).toBe(0);
});

test('a projector retained source restriction lives only during its own execution', async () => {
  let retained: (() => void) | undefined, checked = 0;
  const f = fixture(undefined, { async project(request) {
    retained = request.assertCurrent;
    return { status: 'projected', args: request.args, assertCurrent: request.assertCurrent };
  } });
  const original = f.child.execute;
  f.child.execute = async (args, options) => { retained?.(); checked++; return original(args, options); };
  expect(await f.run()).toMatchObject({ success: true }); expect(checked).toBe(1);
  expect(() => retained?.()).toThrow();
});

test('legacy projected inspection retains its source restriction without acquiring effect authority', async () => {
  let retained: (() => void) | undefined, effects = false;
  const registry = new ToolRegistry();
  registry.register({ definition: { name: CHILD, description: 'Inspect a synthetic projected source.', parameters: {} },
    async execute(args, options) { retained?.(); effects = assertCurrentToolEffect(args, options); return { success: true }; } },
  { inputProjection: { async project(request) {
    retained = request.assertCurrent;
    return { status: 'projected', args: request.args, assertCurrent: request.assertCurrent, resultPublication: 'read-only' };
  } } });
  expect(await registry.execute('legacy-read', CHILD, {})).toMatchObject({ success: true });
  expect(effects).toBe(false); expect(() => retained?.()).toThrow();
});

test('autonomous provenance exposes only the original live recorded source and expires with it', async () => {
  let retained: CurrentToolAutonomySource | undefined;
  const f = fixture(async (args, options) => {
    expect(() => currentToolAutonomySource(args, { ...options })).toThrow();
    retained = currentToolAutonomySource(args, options);
    expect(retained).toMatchObject({ goal: 'Perform the exact synthetic parent request', criteria: ['Write only the captured synthetic child target'] });
    expect(Object.isFrozen(retained)).toBe(true); expect(Object.isFrozen(retained?.criteria)).toBe(true);
    retained?.assertCurrent(); f.setSource('Retired original source');
    expect(() => retained?.assertCurrent()).toThrow();
    return { success: true };
  });
  expect(currentToolAutonomySource({})).toBeUndefined();
  expect(await f.run()).toMatchObject({ success: true }); expect(() => retained?.assertCurrent()).toThrow();
});

test('only a recorded nonregistry act retains issuer-owned native write authority until close', async () => {
  const f = fixture(), other = fixture();
  let source = { goal: 'Write the captured synthetic native target', criteria: ['Preserve original request and current authority'] };
  const admission = await f.manager.admitAutonomous('external-native', CHILD, { target: 'native' }, { sourceOf: () => source });
  expect(admission.result.approved).toBe(true);
  expect(() => assertCurrentExternalAdmission(admission, f.manager)).toThrow();
  expect(() => claimExternalAdmission({ ...admission }, f.manager)).toThrow();
  expect(() => claimExternalAdmission(admission, other.manager)).toThrow();
  claimExternalAdmission(admission, f.manager); expect(() => assertCurrentExternalAdmission(admission, f.manager)).not.toThrow();
  expect(() => claimExternalAdmission(admission, f.manager)).toThrow();
  source = { ...source, goal: 'Changed actual native source' }; expect(() => assertCurrentExternalAdmission(admission, f.manager)).toThrow();
  source = { ...source, goal: 'Write the captured synthetic native target' }; expect(() => assertCurrentExternalAdmission(admission, f.manager)).toThrow();
  closeExternalAdmission(admission, f.manager); expect(() => assertCurrentExternalAdmission(admission, f.manager)).toThrow();
});

test('external read admission in read-only mode cannot acquire a write floor', async () => {
  const f = fixture(undefined, undefined, 'plan');
  const admission = await f.manager.admitAutonomous('external-read', 'read', { target: 'inspect' }, { sourceOf: () => ({
    goal: 'Inspect the original synthetic native target', criteria: ['Perform no writes'] }) });
  expect(admission.result.approved).toBe(true); claimExternalAdmission(admission, f.manager, 'read');
  expect(() => assertCurrentExternalAdmission(admission, f.manager, 'read')).not.toThrow();
  expect(() => assertCurrentExternalAdmission(admission, f.manager, 'write')).toThrow();
  expect(() => assertCurrentExternalAdmission(admission, f.manager, 'read')).toThrow();
});

test('native issuer checks retain the original synchronous request restriction after claim', async () => {
  const f = fixture(); let pending = false, checks = 0;
  const assertPrepared = () => { checks++; return pending ? new Promise<void>(() => {}) : undefined; };
  const admission = await f.manager.admitAutonomous('external-retained-restriction', CHILD, { target: 'native' }, {
    sourceOf: () => ({ goal: 'Write the exact retained native request', criteria: ['Keep the original target current through publication'] }), assertPrepared,
  });
  claimExternalAdmission(admission, f.manager); const before = checks;
  assertCurrentExternalAdmission(admission, f.manager); expect(checks).toBeGreaterThan(before);
  pending = true; expect(() => assertCurrentExternalAdmission(admission, f.manager)).toThrow();
  pending = false; expect(() => assertCurrentExternalAdmission(admission, f.manager)).toThrow();
});

test('registered admissions cannot be claimed by the external issuer lane', async () => {
  const f = fixture();
  const call = await f.registry.prepareCall('registered-not-external', PARENT, {});
  const admission = await f.manager.admitAutonomous('registered-not-external', PARENT, call.args, { sourceOf: () => ({
    goal: 'Perform exact registered synthetic parent work', criteria: ['Keep registry and native producer lanes distinct'] }),
    schemaRevision: call.schemaRevision, preparedCall: { registry: f.registry, call } });
  expect(() => claimExternalAdmission(admission, f.manager)).toThrow();
  expect(await f.registry.executePrepared(call, admission)).toMatchObject({ success: true });
});

test('registered native reference lookup protects a complete payload without transmitting its private ID', async () => {
  const nativeId = 'draft-20261011123456', context = Object.freeze({}); let sourceCurrent = true, released = 0, executions = 0;
  const f = fixture(undefined, {
    captureNativeReferences(request) {
      if (request.args.draftId !== nativeId) return undefined;
      return { fields: ['draftId'], args: { ...request.args, draftId: 'native-draft:one', nativeReferenceSubjects: { body: 'Exact synthetic draft text', recipient: 'recipient@example.invalid' } },
        executionContext: context, assertCurrent() { if (!sourceCurrent) throw new Error('Native reference retired'); }, async release() { released++; } };
    },
    async project(request) { return { status: 'projected', args: request.args, executionContext: request.nativeReferenceContext }; },
  });
  f.child.definition.parameters = { type: 'object', properties: { draftId: { type: 'string' } }, required: ['draftId'], maxProperties: 1, additionalProperties: false };
  f.parent.execute = (_args, options) => f.registry.executeNested('native-ref', CHILD, { draftId: nativeId }, options);
  f.child.execute = async (args, options) => {
    executions++;
    expect(options?.inputProjectionContext).toBe(context); expect(args.draftId).toBe('native-draft:one');
    expect(assertCurrentToolEffect(args, options)).toBe(true); sourceCurrent = false;
    expect(() => assertCurrentToolEffect(args, options)).toThrow();
    return { success: true };
  };
  expect(await f.run()).toMatchObject({ success: true }); expect(released).toBe(1);
  expect(JSON.stringify(states)).not.toContain(nativeId); expect(executions).toBe(1);
  expect(f.registry.getToolDefinitions().find(definition => definition.name === CHILD)?.parameters).toEqual({
    type: 'object', properties: { draftId: { type: 'string' } }, required: ['draftId'], maxProperties: 1, additionalProperties: false,
  });
});

test.each(['caller-subject', 'extra-action', 'invalid-action'] as const)('native private schema seam refuses %s before admission', async kind => {
  const nativeId = 'draft-20261011123456'; let released = 0;
  const f = fixture(undefined, {
    captureNativeReferences(request) { return { fields: ['draftId'], args: { ...request.args, draftId: 'native-draft:one', nativeReferenceSubjects: { body: 'Complete selected native payload' } },
      assertCurrent() {}, async release() { released++; } }; },
    async project(request) { return { status: 'projected', args: request.args }; },
  });
  f.child.definition.parameters = { type: 'object', properties: { draftId: { type: 'string' }, mode: { type: 'string', enum: ['send'] } },
    required: ['draftId', 'mode'], maxProperties: 2, additionalProperties: false };
  f.parent.execute = (_args, options) => f.registry.executeNested('invalid-native-action', CHILD, {
    draftId: nativeId, mode: kind === 'invalid-action' ? 'invalid-mode' : 'send',
    ...(kind === 'caller-subject' ? { nativeReferenceSubjects: { fabricated: true } } : {}),
    ...(kind === 'extra-action' ? { fabricated: true } : {}),
  }, options);
  await expect(f.run()).rejects.toThrow(); expect(f.effects).toBe(0); expect(released).toBe(1);
  expect(log.query({ site: 'engine.gate.autonomous-tool' })).toHaveLength(0);
});

test.each(['unknown', 'unlisted', 'payload'] as const)('native reference %s privacy failure reaches no child reading or effect', async kind => {
  const nativeId = 'draft-20261011123456'; let projects = 0, released = 0;
  const f = fixture(undefined, {
    captureNativeReferences(request) {
      if (kind === 'unknown') return undefined;
      return { fields: ['draftId'], args: { ...request.args, draftId: 'native-draft:one', nativeReferenceSubjects: { body: kind === 'payload' ? 'Authorization: Bearer inline-private-material' : 'Safe body' } },
        assertCurrent() {}, async release() { released++; } };
    },
    async project(request) {
      // This reader owns the outbound privacy check; automatic admission does not read content.
      assertJudgmentInput(request.args); projects++;
      return { status: 'projected', args: request.args };
    },
  });
  f.parent.execute = (_args, options) => f.registry.executeNested('bad-native-ref', CHILD,
    { draftId: nativeId, ...(kind === 'unlisted' ? { body: 'Authorization: Bearer inline-private-material' } : {}) }, options);
  await expect(f.run()).rejects.toThrow(); expect(f.effects).toBe(0); expect(projects).toBe(0);
  expect(log.query({ site: 'engine.gate.autonomous-tool' })).toHaveLength(0); expect(released).toBe(kind === 'unknown' ? 0 : 1);
});

test('native reference captures are synchronous and cannot alter unlisted action content', async () => {
  let projects = 0;
  const asyncRegistry = new ToolRegistry();
  const asynchronousProjector: ToolInputProjector = { async project(request) { projects++; return { status: 'projected', args: request.args }; } };
  Object.defineProperty(asynchronousProjector, 'captureNativeReferences', { value: () => new Promise<void>(() => {}) });
  asyncRegistry.register({ definition: { name: CHILD, description: 'Synthetic native reference async control.', parameters: {} }, async execute() { return { success: true }; } }, {
    inputProjection: asynchronousProjector,
  });
  await expect(asyncRegistry.projectCall('pending-native-ref', CHILD, { draftId: 'draft-20261011123456' })).rejects.toThrow();
  const changedRegistry = new ToolRegistry();
  changedRegistry.register({ definition: { name: CHILD, description: 'Synthetic native reference action binding.', parameters: {} }, async execute() { return { success: true }; } }, {
    inputProjection: {
      captureNativeReferences(request) { return { fields: ['draftId'], args: { ...request.args, draftId: 'native-draft:one', body: 'Changed action content', nativeReferenceSubjects: { body: 'Complete selected payload' } }, assertCurrent() {} }; },
      async project(request) {
      // This reader owns the outbound privacy check; automatic admission does not read content.
      assertJudgmentInput(request.args); projects++;
      return { status: 'projected', args: request.args };
    },
    },
  });
  await expect(changedRegistry.projectCall('changed-native-ref', CHILD, { draftId: 'draft-20261011123456', body: 'Original action content' })).rejects.toThrow();
  expect(projects).toBe(0);
});

test('nested native string references keep their exact schema, private source, and separate child proof', async () => {
  const privateValue = 'Authorization: Bearer synthetic-native-evidence';
  const token = Object.freeze({}); let released = 0;
  const f = fixture(undefined, {
    captureNativeReferences(request) {
      return { fields: [], paths: [['fields', 'output']], args: { ...request.args,
        fields: { ...(request.args.fields as Record<string, unknown>), output: 'native-evidence:one' },
        nativeReferenceSubjects: { purpose: 'local-redacted-evidence', text: 'Complete cleared smoke output.' } },
        executionContext: token, assertCurrent: request.assertCurrent, async release() { released++; } };
    },
    async project(request) { return { status: 'projected', args: request.args }; },
  });
  const schema = { type: 'object', properties: { fields: { type: 'object', properties: {
    output: { type: 'string' }, ordinary: { type: 'string' } }, required: ['output', 'ordinary'], additionalProperties: false } },
    required: ['fields'], additionalProperties: false };
  f.child.definition.parameters = schema;
  f.parent.execute = (_args, options) => f.registry.executeNested('nested-evidence', CHILD,
    { fields: { output: privateValue, ordinary: 'Unchanged sibling' } }, options);
  f.child.execute = async (args, options) => {
    expect(args.fields).toEqual({ output: 'native-evidence:one', ordinary: 'Unchanged sibling' });
    expect(options?.inputProjectionContext).toBe(token);
    expect(assertCurrentToolEffect(args, options, 'write')).toBe(true);
    return { success: true };
  };
  expect(await f.run()).toMatchObject({ success: true });
  expect(released).toBe(1); expect(states).toHaveLength(0);
  expect(JSON.stringify(states)).not.toContain(privateValue);
  expect(states).toHaveLength(0);
  expect(f.registry.getToolDefinitions().find(definition => definition.name === CHILD)?.parameters).toEqual(schema);
});

test.each(['non-string', 'missing', 'overlap', 'duplicate', 'capacity', 'sibling', 'unlisted-credential', 'subject-credential'] as const)(
  'nested native reference %s fails before child reading or execution', async kind => {
    let projects = 0, released = 0;
    const originalFields: Record<string, unknown> = { output: kind === 'non-string' ? { content: 'ordinary' } : 'private-native-output', ordinary: 'Unchanged sibling' };
    if (kind === 'capacity') for (let index = 0; index < 9; index++) originalFields[`extra-${index}`] = `source-${index}`;
    const f = fixture(undefined, {
      captureNativeReferences(request) {
        let paths = [['fields', 'output']];
        if (kind === 'missing') paths = [['fields', 'absent']];
        if (kind === 'overlap') paths.push(['fields']);
        if (kind === 'duplicate') paths.push(['fields', 'output']);
        if (kind === 'capacity') paths = Array.from({ length: 9 }, (_, index) => ['fields', `extra-${index}`]);
        const fields: Record<string, unknown> = { ...originalFields, output: 'native-evidence:one', ...(kind === 'sibling' ? { ordinary: 'Changed sibling' } : {}) };
        if (kind === 'capacity') for (let index = 0; index < 9; index++) fields[`extra-${index}`] = `native-evidence:${index}`;
        return { fields: [], paths, args: { ...request.args, fields,
          nativeReferenceSubjects: { text: kind === 'subject-credential' ? 'Authorization: Bearer private' : 'Cleared output.' } },
          assertCurrent() {}, async release() { released++; } };
      },
      async project(request) {
      // This reader owns the outbound privacy check; automatic admission does not read content.
      assertJudgmentInput(request.args); projects++;
      return { status: 'projected', args: request.args };
    },
    });
    f.parent.execute = (_args, options) => f.registry.executeNested('bad-nested-evidence', CHILD,
      { fields: originalFields, ...(kind === 'unlisted-credential' ? { unrelated: 'Authorization: Bearer unselected' } : {}) }, options);
    await expect(f.run()).rejects.toThrow(); expect(projects).toBe(0); expect(f.effects).toBe(0); expect(released).toBe(1);
    expect(states).toHaveLength(0);
  });

test('nested native references cannot inspect source accessors or proxies', async () => {
  let accesses = 0, captures = 0;
  const fields: Record<string, unknown> = {};
  Object.defineProperty(fields, 'output', { enumerable: true, get() { accesses++; return 'private'; } });
  const proxy = new Proxy({ output: 'private' }, { ownKeys() { accesses++; return ['output']; } });
  const f = fixture(undefined, { captureNativeReferences() { captures++; return undefined; }, async project(request) { return { status: 'projected', args: request.args }; } });
  f.parent.execute = async (_args, options) => {
    for (const source of [fields, proxy]) await expect(f.registry.executeNested('unsafe-nested-evidence', CHILD, { fields: source }, options)).rejects.toThrow();
    return { success: true };
  };
  expect(await f.run()).toMatchObject({ success: true }); expect(accesses).toBe(0); expect(captures).toBe(0); expect(f.effects).toBe(0);
});

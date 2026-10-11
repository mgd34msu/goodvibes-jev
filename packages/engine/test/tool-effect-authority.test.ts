import { afterEach, beforeEach, expect, test } from 'bun:test';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { assertCurrentToolEffect, ToolRegistry, type ToolExecutionEffect } from '@goodvibes-jev/engine/sdk/platform/tools';
import { DEFAULT_CONFIG, type PermissionAction, type PermissionMode } from '../sdk/src/platform/config/index.ts';
import { PermissionManager, type PermissionConfigReader } from '../sdk/src/platform/permissions/manager.ts';
import { PolicyRuntimeState } from '../sdk/src/platform/runtime/permissions/policy-runtime.ts';
import type { Tool, ToolExecuteOptions } from '../sdk/src/platform/types/tools.ts';
import { forgetGateReadings, gateReadingsPort, READ_ONLY } from './_helpers/gate-readings.ts';

const NAME = 'effect_authority_fixture';
let previous: ReturnType<typeof installJudgmentPort>;
let log: SqliteDecisionLog;

beforeEach(() => {
  forgetGateReadings();
  log = new SqliteDecisionLog(':memory:');
  // Deliberately misread every real fixture effect as a read. The local floor
  // must hold even with a strongly recorded but incorrect semantic answer.
  const gate = gateReadingsPort([[NAME, READ_ONLY]]);
  const semantic = fakePort((_name, question) => choiceAnswer(question, 'act', 0.99));
  const port: JudgmentPort = {
    model: gate.port.model,
    ask(request) {
      request.signal?.throwIfAborted(); request.beforeAttempt?.();
      return 'disposition' in request.questions ? semantic.port.ask(request) : gate.port.ask(request);
    },
  };
  previous = installJudgmentPort(withDecisionLog(port, log));
});

afterEach(() => { installJudgmentPort(previous); log[Symbol.dispose](); forgetGateReadings(); });

function fixture(options: { mode?: PermissionMode; write?: PermissionAction; surface?: string;
  effect?: ToolExecutionEffect; beforeEffect?: Tool['execute'] } = {}) {
  let permissions = { ...DEFAULT_CONFIG.permissions, mode: options.mode ?? 'prompt',
    tools: { ...DEFAULT_CONFIG.permissions.tools, write: options.write ?? 'prompt' } };
  let incarnation = 0;
  let surface = options.surface;
  const directory = '/synthetic/tool-effect-authority';
  const config: PermissionConfigReader = {
    getAutonomousSnapshot: () => ({ permissions, autoApprove: false, directory, incarnation }),
    getSnapshot: () => ({ permissions }),
    getWorkingDirectory: () => directory,
    isAutoApproveEnabled: () => false,
  };
  const source = { goal: 'Perform the synthetic registered operation', criteria: ['Preserve exact invocation authority'] };
  const manager = new PermissionManager(undefined, config, new PolicyRuntimeState(), null, null, null,
    { surfaceOf: () => surface });
  const registry = new ToolRegistry(manager);
  let effects = 0;
  let captured: { args: Record<string, unknown>; options: ToolExecuteOptions | undefined } | undefined;
  const tool: Tool = {
    definition: { name: NAME, description: 'Synthetic memory effect under current invocation authority.', parameters: {
      type: 'object', properties: { operation: { type: 'string' }, confirm: { type: 'boolean' }, explicitUserRequest: { type: 'string' } },
      required: ['operation'], additionalProperties: false,
    } },
    async execute(args, executeOptions) {
      captured = { args, options: executeOptions };
      await options.beforeEffect?.(args, executeOptions);
      if (!assertCurrentToolEffect(args, executeOptions, options.effect ?? 'write')) return { success: false, error: 'No authentic effect admission' };
      effects++;
      return { success: true, output: 'Synthetic effect committed' };
    },
  };
  registry.register(tool);
  async function prepare(signal?: AbortSignal) {
    const call = await registry.prepareCall('effect-call', NAME, { operation: 'modify-synthetic-state' }, { signal });
    const admission = await manager.admitAutonomous('effect-source', NAME, call.args, {
      sourceOf: () => source, schemaRevision: call.schemaRevision, preparedCall: { registry, call }, signal,
    });
    expect(admission.result.autonomousDecision?.outcome).toBe('act');
    expect(admission.result.reading?.facts).toMatchObject({ mutates: false, outward: false });
    for (const id of admission.result.autonomousDecision?.judgmentDecisionIds ?? []) expect(log.get(id)?.status).toBe('answered');
    return { call, admission };
  }
  return { registry, manager, tool, prepare,
    get effects() { return effects; }, get captured() { return captured; },
    setMode(mode: PermissionMode) { permissions = { ...permissions, mode }; incarnation++; },
    setWrite(write: PermissionAction) { permissions = { ...permissions, tools: { ...permissions.tools, write } }; incarnation++; },
    setSurface(next: string) { surface = next; },
  };
}

test('a real recorded act permits its exact effect without caller confirmation fields', async () => {
  const f = fixture();
  const { call, admission } = await f.prepare();
  expect(await f.registry.executePrepared(call, admission)).toMatchObject({ success: true });
  expect(f.effects).toBe(1);
  expect(call.args).toEqual({ operation: 'modify-synthetic-state' });
  const captured = f.captured;
  if (!captured) throw new Error('Synthetic body did not execute');
  expect(() => assertCurrentToolEffect(captured.args, captured.options)).toThrow();
  await expect(f.registry.executePrepared(call, admission)).rejects.toThrow('claimed');
  expect(f.effects).toBe(1);
});

test.each(['write', 'send'] satisfies ToolExecutionEffect[])('plan blocks a recorded misclassified %s before its effect', async effect => {
  const f = fixture({ mode: 'plan', effect });
  const { call, admission } = await f.prepare();
  await expect(f.registry.executePrepared(call, admission)).rejects.toMatchObject({ problem: 'held' });
  expect(f.effects).toBe(0);
});

test.each(['write', 'send'] satisfies ToolExecutionEffect[])('custom write deny blocks a recorded misclassified %s', async effect => {
  const f = fixture({ mode: 'custom', write: 'deny', effect });
  const { call, admission } = await f.prepare();
  await expect(f.registry.executePrepared(call, admission)).rejects.toMatchObject({ problem: 'held' });
  expect(f.effects).toBe(0);
});

test.each(['write', 'send'] satisfies ToolExecutionEffect[])('an input-only surface blocks the deterministic %s floor', async effect => {
  const f = fixture({ surface: 'email', effect });
  const { call, admission } = await f.prepare();
  await expect(f.registry.executePrepared(call, admission)).rejects.toMatchObject({ problem: 'held' });
  expect(f.effects).toBe(0);
});

test('a declared command surface permits an authenticated send', async () => {
  const f = fixture({ surface: 'terminal', effect: 'send' });
  const { call, admission } = await f.prepare();
  expect(await f.registry.executePrepared(call, admission)).toMatchObject({ success: true });
  expect(f.effects).toBe(1);
});

test('raw arguments, caller flags and caller callbacks cannot mint effect authority', async () => {
  const f = fixture();
  const input = { operation: 'modify-synthetic-state', confirm: true, explicitUserRequest: 'Perform this synthetic operation' };
  expect(await f.tool.execute(input, { assertCurrent() {} })).toMatchObject({ success: false });
  expect(f.effects).toBe(0);
  const call = await f.registry.prepareCall('legacy-call', NAME, input);
  expect(await f.registry.executePrepared(call, () => {}, { assertCurrent() {} })).toMatchObject({ success: false });
  expect(f.effects).toBe(0);
});

test('copied arguments and copied options cannot use an authentic active body proof', async () => {
  const f = fixture({ beforeEffect: async (args, options) => {
    expect(() => assertCurrentToolEffect({ ...args }, options)).toThrow();
    expect(() => assertCurrentToolEffect(args, { ...options })).toThrow();
    return { success: true };
  } });
  const { call, admission } = await f.prepare();
  expect(await f.registry.executePrepared(call, admission)).toMatchObject({ success: true });
  expect(f.effects).toBe(1);
});

test.each(['preset', 'write-deny', 'surface', 'cancel'] as const)('a pending body loses effect authority after %s changes', async change => {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const controller = new AbortController();
  const f = fixture({ surface: 'terminal', beforeEffect: async () => {
    entered.resolve(); await released.promise; return { success: true };
  } });
  const { call, admission } = await f.prepare(controller.signal);
  const pending = f.registry.executePrepared(call, admission, { signal: controller.signal });
  await entered.promise;
  if (change === 'preset') f.setMode('plan');
  else if (change === 'write-deny') f.setWrite('deny');
  else if (change === 'surface') f.setSurface('email');
  else controller.abort();
  released.resolve();
  await expect(pending).rejects.toThrow();
  expect(f.effects).toBe(0);
});

test('an invalid runtime effect discriminator cannot downgrade the captured floor', async () => {
  const f = fixture({ beforeEffect: async (args, options) => {
    expect(() => Reflect.apply(assertCurrentToolEffect, undefined, [args, options, 'read'])).toThrow();
    return { success: true };
  } });
  const { call, admission } = await f.prepare();
  await expect(f.registry.executePrepared(call, admission)).rejects.toThrow();
  expect(f.effects).toBe(0);
});

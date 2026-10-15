/**
 * The gate: the deterministic boundary, the Jev stakes reading composed in
 * code, the presets over the stakes table, the trust-gated approval for a
 * tainted outward call, MCP capability reading, and the gate events the tool
 * pipeline emits. Every reading comes from a fake port (gate-readings.ts).
 */
import { describe, expect, test } from 'bun:test';
import { READ_ONLY, useGateReadings } from './_helpers/gate-readings.ts';
import { PermissionManager, type PermissionConfigReader } from '../sdk/src/platform/permissions/manager.js';
import type { PolicyRuntimeState } from '../sdk/src/platform/runtime/permissions/policy-runtime.js';
import type { PermissionMode } from '../sdk/src/platform/config/schema.js';
import type { PermissionPromptRequest } from '../sdk/src/platform/permissions/prompt.js';
import { UntrustedContentLedger } from '../sdk/src/platform/security/untrusted-content.js';
import { runBoundary, stringFieldsOf } from '../sdk/src/platform/gate/boundary.js';
import { stakesFromFacts, readingArguments, type GateReading } from '../sdk/src/platform/gate/reading.js';
import { decideByPreset, GATE_PRESETS, presetForMode } from '../sdk/src/platform/gate/presets.js';
import { McpPermissionManager } from '../sdk/src/platform/runtime/mcp/permissions.js';
import { permissionPhase } from '../sdk/src/platform/runtime/tools/phases/permission.js';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.js';

function reader(mode: PermissionMode): PermissionConfigReader {
  return {
    isAutoApproveEnabled: () => false,
    getWorkingDirectory: () => '/tmp/gate-tests',
    getSnapshot: () => ({ permissions: { mode, tools: {} } }),
  } as unknown as PermissionConfigReader;
}

const policyState = (): Pick<PolicyRuntimeState, 'recordPermissionRequest' | 'recordPermissionDecision' | 'getRegistry'> => ({
  recordPermissionRequest: () => {},
  recordPermissionDecision: () => {},
  getRegistry: () => ({ getCurrent: () => undefined }) as unknown as ReturnType<PolicyRuntimeState['getRegistry']>,
});

function gate(mode: PermissionMode, options: { approve?: boolean; surface?: string; ledger?: UntrustedContentLedger } = {}) {
  const asks: PermissionPromptRequest[] = [];
  const manager = new PermissionManager(
    async (request) => { asks.push(request); return { approved: options.approve ?? false, remember: false }; },
    reader(mode),
    policyState(),
    null,
    null,
    null,
    { surfaceOf: () => options.surface, ...(options.ledger ? { ledger: options.ledger } : {}) },
  );
  return { manager, asks };
}

const CARD = '4111 1111 1111 1111';

describe('the stakes rule (composed in code from the readings)', () => {
  const none = { mutates: false, outward: false, secrets: false, irreversible: false, beyondProject: false, weakensSecurity: false, obfuscated: false };
  test('each fact moves the stakes as the rule says', () => {
    expect(stakesFromFacts(none)).toBe('low');
    expect(stakesFromFacts({ ...none, mutates: true })).toBe('medium');
    expect(stakesFromFacts({ ...none, mutates: true, beyondProject: true })).toBe('high');
    expect(stakesFromFacts({ ...none, secrets: true })).toBe('high');
    expect(stakesFromFacts({ ...none, outward: true })).toBe('high');
    expect(stakesFromFacts({ ...none, irreversible: true })).toBe('high');
    expect(stakesFromFacts({ ...none, irreversible: true, outward: true })).toBe('critical');
    expect(stakesFromFacts({ ...none, secrets: true, outward: true })).toBe('critical');
    expect(stakesFromFacts({ ...none, weakensSecurity: true })).toBe('critical');
    expect(stakesFromFacts({ ...none, obfuscated: true })).toBe('critical');
  });

  test('long argument strings reach the reading completely', () => {
    const content = `${'x'.repeat(5000)} TAIL_SCOPE_SENTINEL`;
    const complete = readingArguments({ content }) as { content: string };
    expect(complete.content).toBe(content);
    expect(Object.isFrozen(complete)).toBe(true);
  });
});

describe('the stakes table', () => {
  test('every old mode value selects its preset', () => {
    expect(presetForMode('prompt').name).toBe('normal');
    expect(presetForMode('accept-edits').name).toBe('accept-edits');
    expect(presetForMode('plan').name).toBe('plan');
    expect(presetForMode('allow-all').name).toBe('auto');
    expect(presetForMode('custom').name).toBe('custom');
    expect(presetForMode('something-else').name).toBe('normal');
  });

  test('rows map stakes to actions; plan refuses changes; accept-edits runs edits through high', () => {
    const at = (preset: keyof typeof GATE_PRESETS, stakes: 'low' | 'medium' | 'high' | 'critical', family = 'generic' as const, changesState = true) =>
      decideByPreset(GATE_PRESETS[preset], { stakes, family, changesState }).action;
    expect(at('normal', 'low')).toBe('allow');
    expect(at('normal', 'medium')).toBe('ask');
    expect(at('auto', 'high')).toBe('allow');
    expect(at('auto', 'critical')).toBe('ask');
    expect(at('plan', 'low', 'generic', true)).toBe('deny');
    expect(at('plan', 'low', 'generic', false)).toBe('allow');
    expect(decideByPreset(GATE_PRESETS['accept-edits'], { stakes: 'high', family: 'file-mutation', changesState: true }).action).toBe('allow');
    expect(decideByPreset(GATE_PRESETS['accept-edits'], { stakes: 'critical', family: 'file-mutation', changesState: true }).action).toBe('ask');
  });
});

/** A reading built in code, for exercising the boundary composition directly. */
function reading(over: Partial<GateReading> & { boundary?: GateReading['boundary'] } = {}): GateReading {
  return {
    mutates: false, outward: false, secrets: false, irreversible: false, beyondProject: false, weakensSecurity: false, obfuscated: false,
    family: 'generic', familyConfident: true, stakes: 'low', uncertain: [],
    boundary: { cardDetails: 'no' },
    recordAction: () => {},
    ...over,
  };
}

describe('the boundary composition', () => {
  test('a catastrophic reading refuses; an uncertain one passes for the presets to ask', async () => {
    const refused = await runBoundary({ toolName: 'exec', args: { command: 'x' }, reading: reading({ boundary: { catastrophic: 'yes', cardDetails: 'no' } }) });
    expect(refused.passed).toBe(false);
    if (!refused.passed) expect(refused.refusedBy).toBe('catastrophic');
    const unsure = await runBoundary({ toolName: 'exec', args: { command: 'x' }, reading: reading({ boundary: { catastrophic: 'uncertain', cardDetails: 'no' } }) });
    expect(unsure.passed).toBe(true);
  });

  test('surface authority: an input-only surface cannot direct a change; reads pass anywhere; a command surface can', async () => {
    const change = reading({ mutates: true });
    const email = await runBoundary({ toolName: 'write', args: { path: 'a' }, reading: change, surfaceId: 'email' });
    expect(email.passed).toBe(false);
    if (!email.passed) expect(email.refusedBy).toBe('surface-authority');
    expect((await runBoundary({ toolName: 'write', args: { path: 'a' }, reading: change, surfaceId: 'telegram' })).passed).toBe(true);
    expect((await runBoundary({ toolName: 'read', args: { path: 'a' }, reading: null, surfaceId: 'email' })).passed).toBe(true);
  });

  test('card details on an outward call: a yes refuses outright, an uncertain reading is approvable, a local call is not checked', async () => {
    const ledger = new UntrustedContentLedger();
    const yes = await runBoundary({ toolName: 'channel', args: { text: 'x' }, reading: reading({ outward: true, boundary: { cardDetails: 'yes' } }), ledger });
    expect(yes.passed).toBe(false);
    if (!yes.passed) {
      expect(yes.refusedBy).toBe('card-details');
      expect(yes.approvable).toBeUndefined();
    }
    const unsure = await runBoundary({ toolName: 'channel', args: { text: 'x' }, reading: reading({ outward: true, boundary: { cardDetails: 'uncertain' } }), ledger });
    if (!unsure.passed) expect(unsure.approvable?.content).toEqual({ text: 'x' });
    expect(unsure.passed).toBe(false);
    expect((await runBoundary({ toolName: 'write', args: { content: 'x' }, reading: reading({ mutates: true, boundary: { cardDetails: 'yes' } }) })).passed).toBe(true);
  });

  test('a turn with no untrusted reads passes the outward check without a reading', async () => {
    const verdict = await runBoundary({ toolName: 'channel', args: { text: 'hi' }, reading: reading({ outward: true }), ledger: new UntrustedContentLedger() });
    expect(verdict.passed).toBe(true);
    expect(stringFieldsOf({ a: 'x', b: [{ c: 'y' }], d: 3 })).toEqual({ a: 'x', 'b.0.c': 'y' });
  });
});

describe('tool access follows owner configuration without a Jev veto', () => {
  const readings = useGateReadings([['ls', { catastrophic: true }]]);
  test('ordinary tools execute without risk readings or human prompts', async () => {
    const { manager, asks } = gate('prompt');
    for (const tool of ['read', 'repo_map', 'find', 'exec', 'write', 'edit']) {
      expect((await manager.checkDetailed(tool, { path: '.', command: 'ls' })).approved).toBe(true);
    }
    expect(asks).toEqual([]);
    expect(readings.requests).toHaveLength(0);
  });
  test('an explicitly input-only surface cannot direct a change', async () => {
    const { manager } = gate('allow-all', { surface: 'web-page' });
    expect((await manager.checkDetailed('write', { path: '/tmp/file', content: 'x' })).approved).toBe(false);
  });
  test('MCP calls do not depend on Jev classification or confidence', async () => {
    const before = readings.requests.length;
    const manager = new McpPermissionManager();
    manager.registerServer('fixture');
    expect((await manager.evaluateToolCall('fixture', 'list_directory', { path: '.' })).allowed).toBe(true);
    manager.denyTool('fixture', 'list_directory');
    expect((await manager.evaluateToolCall('fixture', 'list_directory', { path: '.' })).allowed).toBe(false);
    expect(readings.requests.slice(before).filter(request => 'capability' in (request.questions ?? {}) || 'disposition' in (request.questions ?? {}))).toHaveLength(0);
  });
});

describe('the tool pipeline emits the gate events', () => {
  useGateReadings([['"ls"', READ_ONLY]]);

  test('boundary, stakes, preset and decision events for a read call', async () => {
    const bus = new RuntimeEventBus();
    const seen: string[] = [];
    bus.onDomain('gate', (env) => { seen.push(env.type); });
    const { manager } = gate('prompt');
    const result = await permissionPhase(
      { id: 'c1', name: 'exec', arguments: { command: 'ls' } },
      {} as never,
      { permissionManager: manager, runtimeBus: bus, ids: { sessionId: 's', traceId: 't' } } as never,
      {} as never,
    );
    expect(result.success).toBe(true);
    expect(seen).toEqual(['GATE_REQUESTED', 'DECISION_EMITTED']);
  });
});

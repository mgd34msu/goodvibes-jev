import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ConfigManager } from '../sdk/src/platform/config/manager.ts';
import { DEFAULT_CONFIG } from '../sdk/src/platform/config/schema.ts';
import { PermissionManager, createPermissionConfigReader, type PermissionConfigReader } from '../sdk/src/platform/permissions/manager.ts';
import { UserPermissionRuleStore } from '../sdk/src/platform/permissions/user-rule-store.ts';
import { PolicyRuntimeState } from '../sdk/src/platform/runtime/permissions/policy-runtime.ts';
import { createUnsignedBundle, type PolicyRule } from '../sdk/src/platform/runtime/permissions/index.ts';
import { UntrustedContentLedger } from '../sdk/src/platform/security/untrusted-content.ts';
import { ToolRegistry, assertCurrentToolEffect } from '../sdk/src/platform/tools/registry.ts';
import { forgetGateReadings, gateReadingsPort, READ_ONLY } from './_helpers/gate-readings.ts';

const NAME = 'effect_authority_fixture';
const roots: string[] = [];
let previous: ReturnType<typeof installJudgmentPort>, log: SqliteDecisionLog;
let transmissions = 0;

beforeEach(() => {
  forgetGateReadings(); transmissions = 0; log = new SqliteDecisionLog(':memory:');
  const gate = gateReadingsPort([[NAME, READ_ONLY]]);
  const act = fakePort((_name, question) => choiceAnswer(question, 'act', 0.99));
  const port: JudgmentPort = { model: gate.port.model, ask(request) {
    transmissions++;
    return ('disposition' in request.questions ? act.port : gate.port).ask(request);
  } };
  previous = installJudgmentPort(withDecisionLog(port, log));
});
afterEach(() => {
  installJudgmentPort(previous); log[Symbol.dispose](); forgetGateReadings();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const rule: PolicyRule = { id: 'freshness-rule', type: 'prefix', description: 'Synthetic restriction',
  origin: 'user', effect: 'deny', toolPattern: NAME, commandPrefixes: [] };

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'authority-freshness-')); roots.push(root);
  const config = new ConfigManager({ configDir: root });
  config.flushConfigFileChanges();
  const rules = new UserPermissionRuleStore(':memory:'); await rules.init();
  const policy = new PolicyRuntimeState();
  const ledger = new UntrustedContentLedger();
  const source = { goal: 'Perform the exact synthetic operation', criteria: ['Retain current original authority'] };
  const reader = createPermissionConfigReader(config);
  const nativeSnapshot = reader.getAutonomousSnapshot;
  if (!nativeSnapshot) throw new Error('Native permission owner snapshot is unavailable');
  const diagnostic: Record<string, unknown> = {};
  reader.getAutonomousSnapshot = () => ({ ...nativeSnapshot(), diagnostic });
  const manager = new PermissionManager(undefined, reader, policy, null, null, rules, { ledger });
  const registry = new ToolRegistry(manager);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let effects = 0, checks = 0;
  registry.register({
    definition: { name: NAME, description: 'Registered memory effect under authentic current authority.',
      parameters: { type: 'object', properties: { operation: { type: 'string' } }, required: ['operation'], additionalProperties: false } },
    async execute(args, options) {
      expect(assertCurrentToolEffect(args, options)).toBe(true);
      entered.resolve(); await release.promise;
      for (let index = 0; index < 20; index++) { expect(assertCurrentToolEffect(args, options)).toBe(true); checks++; }
      effects++;
      return { success: true, output: 'Synthetic effect completed' };
    },
  });
  const controller = new AbortController();
  const call = await registry.prepareCall('freshness-call', NAME, { operation: 'modify-synthetic-state' }, { signal: controller.signal });
  const admission = await manager.admitAutonomous('freshness-source', NAME, call.args, {
    sourceOf: () => source, signal: controller.signal, schemaRevision: call.schemaRevision, preparedCall: { registry, call },
  });
  expect(admission.result.approved).toBe(true);
  return { config, rules, policy, ledger, source, diagnostic, registry, call, admission, entered, release, controller,
    get effects() { return effects; }, get checks() { return checks; } };
}

test('repeated authentic currentness preserves its screened frame without new readings', async () => {
  const f = await fixture();
  const pending = f.registry.executePrepared(f.call, f.admission);
  await f.entered.promise; const originalTransmissions = transmissions;
  f.release.resolve();
  expect(await pending).toMatchObject({ success: true });
  expect(f.effects).toBe(1); expect(f.checks).toBe(20);
  expect(transmissions).toBe(originalTransmissions);
});

test.each(['config', 'config-aba', 'rules', 'rules-aba', 'policy', 'policy-same-rules', 'exposure', 'source', 'private-source', 'private-frame', 'unsupported-frame', 'cancel'] as const)(
  'pending authentic currentness rejects changed %s before the effect and any new reading', async change => {
    const f = await fixture();
    const pending = f.registry.executePrepared(f.call, f.admission).then(result => ({ result }), (error: unknown) => ({ error }));
    await f.entered.promise; const originalTransmissions = transmissions;
    if (change === 'config' || change === 'config-aba') {
      const original = f.config.get('permissions.mode');
      f.config.set('permissions.mode', 'allow-all');
      if (change === 'config-aba') f.config.set('permissions.mode', original);
    } else if (change === 'rules' || change === 'rules-aba') {
      await f.rules.add({ rule, createdAt: 0, tier: 'tool', tool: NAME });
      if (change === 'rules-aba') await f.rules.delete(rule.id);
    } else if (change === 'policy' || change === 'policy-same-rules') {
      const registry = f.policy.getRegistry();
      expect(registry.loadCandidate(createUnsignedBundle('freshness-policy', { version: 1, rules: change === 'policy' ? [rule] : [] })).ok).toBe(true);
      expect(registry.markSimulating()).toBe(true);
      expect(registry.attachSimulationReport({ overall: { total: 0, byType: { 'allow-vs-deny': 0, 'deny-vs-allow': 0, 'reason-mismatch': 0 },
        divergenceRate: 0, totalEvaluations: 100 }, byToolClass: {}, byCommandPrefix: {}, byMode: {}, records: [] },
        { status: 'allowed', divergenceRate: 0, threshold: 0.05, totalEvaluations: 100, message: 'Synthetic passing native simulation' })).toBe(true);
      expect(registry.promote().ok).toBe(true);
    } else if (change === 'exposure') {
      f.ledger.record({ surface: 'web-page', origin: 'https://ordinary.example.test', at: '2026-10-11T00:00:00Z', content: 'Ordinary external evidence.' });
    } else if (change === 'source') f.source.goal = 'A different operation';
    else if (change === 'private-source') f.source.goal = 'token=synthetic-private-source';
    else if (change === 'private-frame') f.diagnostic.apiKey = 'synthetic-late-private';
    else if (change === 'unsupported-frame') f.diagnostic.callback = () => 'unsupported';
    else f.controller.abort();
    f.release.resolve();
    expect(await pending).toHaveProperty('error');
    expect(f.effects).toBe(0); expect(f.checks).toBe(0);
    expect(transmissions).toBe(originalTransmissions);
  },
);

test.each(['private', 'accessor', 'hidden', 'proxy'] as const)('initial authority still refuses %s data before readings or execution', async kind => {
  let getterCalls = 0, bodies = 0;
  const frame = { permissions: { ...DEFAULT_CONFIG.permissions, mode: 'prompt' as const, tools: {} }, autoApprove: false, directory: '/synthetic/freshness' };
  if (kind === 'private') Object.defineProperty(frame, 'apiKey', { value: 'synthetic-original-private', enumerable: true });
  if (kind === 'accessor') Object.defineProperty(frame, 'diagnostic', { enumerable: true, get() { getterCalls++; return 'ordinary'; } });
  if (kind === 'hidden') Object.defineProperty(frame.permissions, 'diagnostic', { value: 'ordinary', enumerable: false });
  const current = kind === 'proxy' ? new Proxy(frame, {}) : frame;
  const reader: PermissionConfigReader = {
    getAutonomousSnapshot: () => current, getSnapshot: () => ({ permissions: frame.permissions }),
    isAutoApproveEnabled: () => false, getWorkingDirectory: () => frame.directory,
  };
  const manager = new PermissionManager(undefined, reader, new PolicyRuntimeState());
  const registry = new ToolRegistry(manager);
  registry.register({ definition: { name: NAME, description: 'Initial authority privacy fixture', parameters: { type: 'object' } },
    async execute() { bodies++; return { success: true }; } });
  const call = await registry.prepareCall('initial-freshness-call', NAME, {});
  await expect(manager.admitAutonomous('initial-freshness-source', NAME, call.args, {
    sourceOf: () => ({ goal: 'Perform a synthetic operation', criteria: ['Preserve privacy'] }), preparedCall: { registry, call },
  })).rejects.toThrow();
  expect(transmissions).toBe(0); expect(bodies).toBe(0); expect(getterCalls).toBe(0);
});

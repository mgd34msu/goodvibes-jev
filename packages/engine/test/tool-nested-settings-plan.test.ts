import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ToolRegistry, assertCurrentToolEffect, commitCurrentToolSettingsPlan } from '../sdk/src/platform/tools/registry.ts';
import type { ToolPreparedSettingsMutation } from '../sdk/src/platform/tools/input-projection.ts';
import { PermissionManager, createPermissionConfigReader } from '../sdk/src/platform/permissions/manager.ts';
import { ConfigManager } from '../sdk/src/platform/config/manager.ts';
import { SecretsManager } from '../sdk/src/platform/config/secrets.ts';
import { SubscriptionManager } from '../sdk/src/platform/config/subscriptions.ts';
import { PolicyRuntimeState } from '../sdk/src/platform/runtime/permissions/policy-runtime.ts';
import { forgetGateReadings, gateReadingsPort, READ_ONLY } from './_helpers/gate-readings.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const PARENT = 'nested_settings_parent_fixture', CHILD = 'nested_settings_child_fixture';
const roots: string[] = [];
let previous: ReturnType<typeof installJudgmentPort>, log: SqliteDecisionLog;
beforeEach(() => {
  forgetGateReadings(); log = new SqliteDecisionLog(':memory:');
  const gate = gateReadingsPort([[PARENT, READ_ONLY], [CHILD, { ...READ_ONLY, requested: true }]]);
  const act = fakePort((_name, question) => choiceAnswer(question, 'act', 0.999));
  const port: JudgmentPort = { model: gate.port.model, ask(request) {
    return ('disposition' in request.questions ? act.port : gate.port).ask(request);
  } };
  previous = installJudgmentPort(withDecisionLog(port, log));
});
afterEach(() => { installJudgmentPort(previous); log[Symbol.dispose](); forgetGateReadings();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(kind: 'config' | 'secret-config' | 'subscription' = 'config') {
  const root = makeProjectTempDir('nested-settings-plan'); roots.push(root);
  const config = new ConfigManager({ configDir: join(root, 'config') });
  const secrets = new SecretsManager({ surfaceRoot: 'agent', projectRoot: join(root, 'project'), globalHome: root, daemonHome: join(root, 'daemon') });
  const subscriptions = new SubscriptionManager(join(root, 'subscriptions.json'));
  const manager = new PermissionManager(undefined, createPermissionConfigReader(config), new PolicyRuntimeState());
  const registry = new ToolRegistry(manager);
  const controller = new AbortController();
  let assertSource = () => {}, afterFirst = () => {}, writes = 0;
  registry.register({ definition: { name: CHILD, description: 'Apply a synthetic registration-owned settings plan.',
    parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false }, sideEffects: ['state'] },
    async execute(args, options) {
      const receipt = await commitCurrentToolSettingsPlan(args, options);
      if (receipt.status === 'committed') writes++;
      return { success: receipt.status === 'committed', output: JSON.stringify(receipt) };
    } }, { inputProjection: { async project(request) {
      request.assertCurrent();
      const mutation = kind === 'subscription' ? undefined : config.prepareSettingMutation({ operation: 'set', key: 'provider.model', value: request.args.value });
      const secretImport = kind === 'secret-config' ? { owner: secrets, mutation: secrets.prepareImport([{ key: 'SYNTHETIC_IMPORT', value: 'private-test-value', scope: 'daemon' }]) } : undefined;
      const subscriptionImport = kind === 'subscription' ? { owner: subscriptions, mutation: subscriptions.prepareImport([{ kind: 'pending', value: {
        provider: 'synthetic', state: 'private-state', verifier: 'private-verifier', redirectUri: 'http://localhost/synthetic', createdAt: 1,
      } }]) } : undefined;
      const settingsMutation: ToolPreparedSettingsMutation = mutation
        ? { owner: config, mutation, secretImport, assertSourceCurrent: () => { assertSource(); } }
        : subscriptionImport ? { owner: config, subscriptionImport, assertSourceCurrent: () => { assertSource(); } }
          : (() => { throw new Error('Empty synthetic plan'); })();
      const effect = { kind, key: 'provider.model', configured: true };
      return { status: 'projected', args: request.args, settingsMutation,
        settingsAdmissionEvidence: { kind: 'agent-settings', operation: 'set', key: 'provider.model', effect,
          revision: createHash('sha256').update(JSON.stringify(effect)).digest('hex') },
        assertCurrent: request.assertCurrent };
    } } });
  registry.register({ definition: { name: PARENT, description: 'Apply two exact registered child settings plans.', parameters: {} },
    async execute(args, options) {
      const first = await registry.executeNested('child-one', CHILD, { value: 'openai:synthetic-one' }, options);
      if (!first.success) return first;
      afterFirst();
      if (!assertCurrentToolEffect(args, options)) throw new Error('Parent lost authentic current authority');
      if (kind !== 'config') return first;
      return registry.executeNested('child-two', CHILD, { value: 'openai:synthetic-two' }, options);
    } });
  return { root, config, secrets, subscriptions, registry, manager, controller, get writes() { return writes; },
    setSourceGuard(guard: () => void) { assertSource = guard; },
    setAfterFirst(guard: () => void) { afterFirst = guard; },
    async run() {
      const call = await registry.prepareCall('settings-parent', PARENT, {}, { signal: controller.signal });
      const admission = await manager.admitAutonomous('settings-parent', PARENT, call.args, {
        sourceOf: () => ({ goal: 'Apply exact synthetic native settings plans', criteria: ['Preserve live source and exact owner transitions'] }),
        signal: controller.signal, schemaRevision: call.schemaRevision, preparedCall: { registry, call },
      });
      expect(admission.result.approved).toBe(true);
      return registry.executePrepared(call, admission);
    },
  };
}

test('two fresh child config plans retain parent currentness through exact own mutations', async () => {
  const f = fixture(); expect(await f.run()).toMatchObject({ success: true });
  expect(f.writes).toBe(2); expect(f.config.get('provider.model')).toBe('openai:synthetic-two');
  expect(log.query({ site: 'engine.gate.autonomous-tool' })).toHaveLength(0);
});
test('a native completed mutation refuses same-owner ABA and physical store replacement', () => {
  const f = fixture(); const mutation = f.config.prepareSettingMutation({ operation: 'set', key: 'provider.model', value: 'openai:synthetic-completed' });
  const transition = f.config.beginPreparedMutation(mutation);
  expect(f.config.finishPreparedMutation(mutation, transition).status).toBe('committed');
  expect(() => f.config.assertCompletedMutation(mutation)).not.toThrow();
  const path = f.config.getConfigPath(), raw = readFileSync(path, 'utf8'); writeFileSync(path, raw);
  expect(() => f.config.assertCompletedMutation(mutation)).toThrow();
});
test('a subscription-only recorded plan commits without fabricating config mutation', async () => {
  const f = fixture('subscription'), before = f.config.getConfigurationIncarnation();
  expect(await f.run()).toMatchObject({ success: true }); expect(f.writes).toBe(1);
  expect(f.config.getConfigurationIncarnation()).toBe(before); expect(f.subscriptions.getPending('synthetic')?.verifier).toBe('private-verifier');
});
test('a secret import and config plan consume actual private native handles', async () => {
  const f = fixture('secret-config'); expect(await f.run()).toMatchObject({ success: true });
  expect(f.writes).toBe(1); expect(f.config.get('provider.model')).toBe('openai:synthetic-one');
  expect(await f.secrets.get('SYNTHETIC_IMPORT')).toBe('private-test-value');
  expect(f.secrets.getCredentialMutationState()).toEqual({ generation: 2, pending: false });
});
test('cancellation at exact secret onset prevents private publication and later config effect', async () => {
  const f = fixture('secret-config'); const off = f.secrets.onDidInvalidateCredentials(() => f.controller.abort());
  await expect(f.run()).rejects.toThrow(); off(); expect(f.writes).toBe(0);
  expect(existsSync(join(f.root, 'daemon', 'secrets.json'))).toBe(false); expect(f.config.get('provider.model')).not.toBe('openai:synthetic-one');
});
test('retired private source at publication stops the real native plan', async () => {
  const f = fixture('subscription'); f.setSourceGuard(() => { throw new Error('Retired synthetic source'); });
  expect(await f.run()).toMatchObject({ success: false }); expect(f.writes).toBe(0); expect(existsSync(join(f.root, 'subscriptions.json'))).toBe(false);
});

test('postcommit cancellation retains the authentic child receipt and dispatches no sibling', async () => {
  const f = fixture(); f.config.subscribe('provider.model', () => f.controller.abort());
  const result = await f.run(); expect(result).toMatchObject({ success: false, cancelled: true });
  expect(JSON.parse(result.output ?? '')).toEqual({ status: 'committed', completedPaths: [f.config.getConfigPath()] });
  expect(f.writes).toBe(1); expect(f.config.get('provider.model')).toBe('openai:synthetic-one');
  expect(log.query({ site: 'engine.gate.autonomous-tool' })).toHaveLength(0);
});

test('later parent cancellation preserves its prior private receipt without reviving authority', async () => {
  const f = fixture(); f.setAfterFirst(() => f.controller.abort());
  const result = await f.run(); expect(result).toMatchObject({ success: false, cancelled: true });
  expect(JSON.parse(result.output ?? '')).toEqual({ status: 'committed', completedPaths: [f.config.getConfigPath()] });
  expect(f.writes).toBe(1); expect(log.query({ site: 'engine.gate.autonomous-tool' })).toHaveLength(0);
});

test('postcommit unrelated owner mutation preserves the receipt and holds remaining child work', async () => {
  const f = fixture(); f.config.subscribe('provider.model', () => f.config.save());
  const result = await f.run(); expect(result.success).toBe(false);
  expect(JSON.parse(result.output ?? '')).toEqual({ status: 'committed', completedPaths: [f.config.getConfigPath()] });
  expect(f.writes).toBe(1); expect(log.query({ site: 'engine.gate.autonomous-tool' })).toHaveLength(0);
});

test('protected native targets merge unrelated fields while retaining actual consumed keys', () => {
  const f = fixture(); f.config.set('provider.model', 'openai:initial');
  const path = f.config.getConfigPath();
  const mutation = f.config.prepareSettingMutation({ operation: 'set', key: 'provider.model', value: 'openai:protected' });
  f.config.protectPreparedMutationTargets(mutation);
  writeFileSync(path, JSON.stringify({ provider: { model: 'openai:initial' }, unrelated: true }));
  const transition = f.config.beginPreparedMutation(mutation);
  expect(f.config.finishPreparedMutation(mutation, transition).status).toBe('committed');
  expect(JSON.parse(readFileSync(path, 'utf8')).unrelated).toBe(true);
  expect(() => f.config.assertCompletedMutation(mutation)).not.toThrow();
});

test.each(['key', 'target', 'parent'] as const)('protected native target refuses changed %s before publication', kind => {
  const f = fixture(); f.config.set('provider.model', 'openai:initial');
  const path = f.config.getConfigPath(), raw = readFileSync(path, 'utf8');
  const mutation = f.config.prepareSettingMutation({ operation: 'set', key: 'provider.model', value: 'openai:protected' });
  f.config.protectPreparedMutationTargets(mutation);
  if (kind === 'key') writeFileSync(path, JSON.stringify({ provider: { model: 'openai:changed' } }));
  else if (kind === 'target') { renameSync(path, `${path}.previous`); writeFileSync(path, raw); }
  else { const directory = dirname(path); renameSync(directory, `${directory}.previous`); mkdirSync(directory); writeFileSync(path, raw); }
  expect(() => f.config.beginPreparedMutation(mutation)).toThrow();
  expect(readFileSync(path, 'utf8')).not.toContain('openai:protected');
});

test('a previously absent protected parent cannot become a symlink route', () => {
  const f = fixture(), path = f.config.getConfigPath(), directory = dirname(path);
  rmSync(directory, { recursive: true, force: true });
  const mutation = f.config.prepareSettingMutation({ operation: 'set', key: 'provider.model', value: 'openai:protected' });
  f.config.protectPreparedMutationTargets(mutation);
  const outside = join(f.root, 'outside'); mkdirSync(outside); symlinkSync(outside, directory, 'dir');
  expect(() => f.config.beginPreparedMutation(mutation)).toThrow(); expect(existsSync(join(outside, 'settings.json'))).toBe(false);
});

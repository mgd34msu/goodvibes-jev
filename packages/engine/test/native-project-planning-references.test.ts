import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager, retainConfiguredWorkspace } from '../sdk/src/platform/config/manager.ts';
import { JudgmentInputError } from '../sdk/src/platform/gate/judgment-input.ts';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.ts';
import { ProjectPlanningService } from '../sdk/src/platform/knowledge/project-planning/service.ts';
import { projectPlanningProjectIdFromPath } from '../sdk/src/platform/knowledge/project-planning/helpers.ts';
import { findCardNumberShapes } from '../sdk/src/platform/security/card-shapes.ts';
import { planningGoalSpecified } from '../sdk/src/platform/knowledge/project-planning/batteries/readiness.ts';
import { installJudgmentPort } from '../errors/src/judgment-port.ts';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { AgentConfigManager } from '../../../products/agent/src/config/host-settings.ts';
import { TuiConfigManager } from '../../../products/tui/src/config/host-settings.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(Manager: typeof ConfigManager = ConfigManager, configured = true, cardShaped = true) {
  const root = makeProjectTempDir('native-planning-reference');
  const workingDirectory = join(root, cardShaped ? 'workspace-1791693573084' : 'ordinary-native-project');
  mkdirSync(workingDirectory, { recursive: true });
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const config = new Manager({ surfaceRoot: 'native-planning-test', configDir: join(root, 'config'),
    ...(configured ? { workingDir: workingDirectory } : {}), readOnly: true });
  const store = new KnowledgeStore({ configManager: config });
  await store.init(); cleanup.push(() => store.close());
  await store.upsertSource({ id: 'native-reference-fixture', connectorId: 'native-reference-fixture',
    sourceType: 'dataset', title: 'Native reference fixture', canonicalUri: 'native:reference-fixture', status: 'indexed' });
  return { root, workingDirectory, config, store, bytes: () => readFileSync(store.storagePath) };
}

for (const Manager of [ConfigManager, AgentConfigManager, TuiConfigManager]) {
  test(`${Manager.name} native configured identity remains unchanged while constructor and default resolution admit its role`, async () => {
    const f = await fixture(Manager), before = f.bytes();
    const expected = projectPlanningProjectIdFromPath(f.workingDirectory);
    expect(findCardNumberShapes(expected, 1)).toHaveLength(1);
    expect(() => new ProjectPlanningService(f.store, { defaultProjectId: expected })).toThrow(JudgmentInputError);
    const native = ProjectPlanningService.forConfiguredWorkspace(f.store, f.config, f.workingDirectory);
    expect(native.projectId).toBe(expected);
    const result = await native.service.status();
    expect(result.projectId).toBe(expected);
    expect(result.knowledgeSpaceId).toBe(`project:${expected}`);
    expect(f.bytes()).toEqual(before);
    // A returned identifier is still ordinary caller text in a second constructor.
    expect(() => new ProjectPlanningService(f.store, { defaultProjectId: result.projectId })).toThrow(JudgmentInputError);
  });
}

for (const configured of [false, true]) {
  test(`an authentic ${configured ? 'mismatched' : 'missing'} configured directory retains plain constructor screening`, async () => {
    const f = await fixture(ConfigManager, configured);
    const directory = configured ? join(f.root, 'other-1791693573084') : f.workingDirectory;
    expect(() => ProjectPlanningService.forConfiguredWorkspace(f.store, f.config, directory)).toThrow(JudgmentInputError);
    const safeDirectory = join(f.root, 'safe-plain-directory');
    const ordinary = ProjectPlanningService.forConfiguredWorkspace(f.store, f.config, safeDirectory);
    expect((await ordinary.service.status()).projectId).toBe(projectPlanningProjectIdFromPath(safeDirectory));
  });
}

for (const value of ['password=SYNTHETIC_NOT_A_REAL_SECRET', '4111 1111 1111 1111']) {
  test(`native creation screens an unknown caller field (${value.startsWith('password') ? 'credential' : 'card'})`, async () => {
    const f = await fixture(), before = f.bytes();
    const options = { extra: { text: value } };
    expect(() => Reflect.apply(ProjectPlanningService.forConfiguredWorkspace, ProjectPlanningService,
      [f.store, f.config, f.workingDirectory, options])).toThrow(JudgmentInputError);
    expect(f.bytes()).toEqual(before);
  });
}

test('native creation refuses caller default overrides and hidden private tails without invoking startup', async () => {
  const f = await fixture(); let calls = 0;
  const options = { waitForStartup: async () => { calls++; }, defaultProjectId: 'ordinary-forged-default' };
  expect(() => Reflect.apply(ProjectPlanningService.forConfiguredWorkspace, ProjectPlanningService,
    [f.store, f.config, f.workingDirectory, options])).toThrow(TypeError);
  const hidden = { waitForStartup: options.waitForStartup };
  Object.defineProperty(hidden, 'privateTail', { value: { password: 'SYNTHETIC_NOT_A_REAL_SECRET' }, enumerable: false });
  expect(() => ProjectPlanningService.forConfiguredWorkspace(f.store, f.config, f.workingDirectory, hidden)).toThrow(JudgmentInputError);
  expect(calls).toBe(0);
});

for (const key of ['projectId', 'knowledgeSpaceId', 'extra']) {
  test(`native default does not project caller-authored ${key}`, async () => {
    const f = await fixture(), before = f.bytes();
    const { service } = ProjectPlanningService.forConfiguredWorkspace(f.store, f.config, f.workingDirectory);
    const input = { [key]: 'password=SYNTHETIC_NOT_A_REAL_SECRET' };
    await expect(service.status(input)).rejects.toThrow(JudgmentInputError);
    expect(f.bytes()).toEqual(before);
  });
}

test('the pinned workspace bridge rejects a borrowed prototype before receiver getters or callbacks', async () => {
  const f = await fixture(); let calls = 0;
  const foreign: object = Object.create(ConfigManager.prototype);
  for (const key of ['workingDirectory', 'configDir', 'getWorkingDirectory', 'retainConfiguredWorkspace']) {
    Object.defineProperty(foreign, key, { get: () => { calls++; return f.workingDirectory; } });
  }
  expect(() => Reflect.apply(retainConfiguredWorkspace, undefined, [foreign])).toThrow(TypeError);
  expect(() => Reflect.apply(ProjectPlanningService.forConfiguredWorkspace, ProjectPlanningService,
    [f.store, foreign, f.workingDirectory])).toThrow(TypeError);
  expect(calls).toBe(0);
});

test('a proxy cannot forward the private workspace brand to its real target', async () => {
  const f = await fixture(); let calls = 0;
  const proxy = new Proxy(f.config, { get(target, key, receiver) { calls++; return Reflect.get(target, key, receiver); } });
  expect(() => ProjectPlanningService.forConfiguredWorkspace(f.store, proxy, f.workingDirectory)).toThrow(TypeError);
  expect(calls).toBe(0);
});

for (const key of ['workingDirectory', 'configDir', 'projectConfigPath', 'homeDirectory', 'getWorkingDirectory',
  'getControlPlaneConfigDir', 'getProjectConfigPath', 'getHomeDirectory', 'retainConfiguredWorkspace']) {
  for (const accessor of [false, true]) {
    test(`a genuine native owner rejects replaced ${key} ${accessor ? 'accessor' : 'value'} before supplied code`, async () => {
      const f = await fixture(); let calls = 0;
      const native = ProjectPlanningService.forConfiguredWorkspace(f.store, f.config, f.workingDirectory);
      const previous = Object.getOwnPropertyDescriptor(f.config, key);
      const supplied = () => { calls++; return f.workingDirectory; };
      Object.defineProperty(f.config, key, accessor ? { configurable: true, get: supplied }
        : { configurable: true, value: supplied });
      try {
        expect(() => ProjectPlanningService.forConfiguredWorkspace(f.store, f.config, f.workingDirectory)).toThrow();
        await expect(native.service.status()).rejects.toThrow();
        expect(calls).toBe(0);
      } finally {
        if (previous) Object.defineProperty(f.config, key, previous); else Reflect.deleteProperty(f.config, key);
      }
    });
  }
}

test('native default ownership is rechecked after the actual startup await', async () => {
  const f = await fixture(), before = f.bytes();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const { service } = ProjectPlanningService.forConfiguredWorkspace(f.store, f.config, f.workingDirectory, {
    waitForStartup: async () => { entered.resolve(); await release.promise; },
  });
  const pending = service.status(); const observed = pending.catch(error => error);
  await entered.promise;
  const original = Object.getOwnPropertyDescriptor(f.config, 'workingDirectory');
  Object.defineProperty(f.config, 'workingDirectory', { value: join(f.root, 'replacement'), configurable: true });
  release.resolve();
  try { expect(await observed).toBeInstanceOf(Error); expect(f.bytes()).toEqual(before); }
  finally { if (original) Object.defineProperty(f.config, 'workingDirectory', original); }
});

test('closing the actual selected store during startup holds before default response publication', async () => {
  const f = await fixture(), before = f.bytes();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const { service } = ProjectPlanningService.forConfiguredWorkspace(f.store, f.config, f.workingDirectory, {
    waitForStartup: async () => { entered.resolve(); await release.promise; },
  });
  const pending = service.status(); const observed = pending.catch(error => error);
  await entered.promise; await f.store.close(); release.resolve();
  expect(await observed).toBeInstanceOf(Error); expect(f.bytes()).toEqual(before);
});

for (const key of ['store', 'defaultProjectId', 'waitForStartup']) {
  test(`the native service rejects a replaced ${key} slot before supplied code`, async () => {
    const f = await fixture(); let calls = 0;
    const { service } = ProjectPlanningService.forConfiguredWorkspace(f.store, f.config, f.workingDirectory);
    const original = Object.getOwnPropertyDescriptor(service, key);
    Object.defineProperty(service, key, { configurable: true, get: () => { calls++; return f.store; } });
    try { await expect(service.status()).rejects.toThrow(); expect(calls).toBe(0); }
    finally { if (original) Object.defineProperty(service, key, original); }
  });
}

for (const key of ['init', 'getSourceSnapshot', 'listSources', 'captureSourcePublication']) {
  test(`the native service rejects replaced selected-store ${key} dispatch before supplied code`, async () => {
    const f = await fixture(); let calls = 0;
    const { service } = ProjectPlanningService.forConfiguredWorkspace(f.store, f.config, f.workingDirectory);
    Object.defineProperty(f.store, key, { configurable: true, get: () => { calls++; return () => undefined; } });
    try { await expect(service.status()).rejects.toThrow(); expect(calls).toBe(0); }
    finally { Reflect.deleteProperty(f.store, key); }
  });
}

test('mutating an unknown native composition input during startup retires its original binding', async () => {
  const f = await fixture(), before = f.bytes();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const options = { extra: { note: 'Ordinary caller meaning' }, waitForStartup: async () => { entered.resolve(); await release.promise; } };
  const { service } = ProjectPlanningService.forConfiguredWorkspace(f.store, f.config, f.workingDirectory, options);
  const pending = service.status(); const observed = pending.catch(error => error);
  await entered.promise; options.extra.note = 'password=SYNTHETIC_NOT_A_REAL_SECRET'; release.resolve();
  expect(await observed).toBeInstanceOf(Error); expect(f.bytes()).toEqual(before);
});

test('native creation rejects caller options accessors and proxies before either supplies a value', async () => {
  const f = await fixture(); let calls = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'waitForStartup', { get: () => { calls++; return async () => undefined; } });
  expect(() => ProjectPlanningService.forConfiguredWorkspace(f.store, f.config, f.workingDirectory, accessor)).toThrow(JudgmentInputError);
  const proxy = new Proxy({}, { ownKeys() { calls++; return []; } });
  expect(() => ProjectPlanningService.forConfiguredWorkspace(f.store, f.config, f.workingDirectory, proxy)).toThrow(JudgmentInputError);
  expect(calls).toBe(0);
});

for (const operation of ['evaluate', 'upsertState'] as const) {
  for (const retirement of ['workspace', 'selected-default', 'composition-tail'] as const) {
    test(`${operation} retains its native ${retirement} through an actual readiness reading`, async () => {
      const f = await fixture(ConfigManager, true, false), before = f.bytes();
      const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      const facts = { goal: 'Verify the isolated native read', scope: 'Read only', knownContext: [], constraints: [], assumptions: [],
        tasks: [], answeredQuestions: [], decisions: [] };
      const fake = fakePort((name, question, state) => {
        expect(name).toBe('specified'); expect(question).toEqual(planningGoalSpecified.items.specified.question);
        expect(state).toEqual(facts); return noulAnswer(0.99);
      });
      const previous = installJudgmentPort({ ...fake.port, async ask(request) {
        const result = await fake.port.ask(request); entered.resolve(); await release.promise; return result;
      } });
      cleanup.push(() => { installJudgmentPort(previous); });
      const options = { extra: { note: 'Ordinary composition input' }, waitForStartup: async () => undefined };
      const { service } = ProjectPlanningService.forConfiguredWorkspace(f.store, f.config, f.workingDirectory, options);
      const reference = retainConfiguredWorkspace(f.config);
      const target = retirement === 'selected-default' ? service : f.config;
      const key = retirement === 'selected-default' ? 'defaultProjectId' : 'workingDirectory';
      const original = Object.getOwnPropertyDescriptor(target, key);
      if (!original || !('value' in original)) throw new Error('Missing native owner slot');
      const pending = service[operation]({ state: { goal: facts.goal, scope: facts.scope, createdAt: 1 } });
      const observed = pending.then(() => 'published', () => 'held');
      try {
        const started = await Promise.race([entered.promise.then(() => 'entered'), observed.then(() => 'completed-before-read')]);
        expect(started).toBe('entered');
        if (retirement === 'composition-tail') options.extra.note = 'Changed composition input';
        else Object.defineProperty(target, key, { ...original, value: join(f.root, 'retired-native-owner') });
        if (retirement === 'workspace') expect(() => reference.assertCurrent()).toThrow();
        release.resolve();
        const outcome = await observed;
        expect(fake.requests).toHaveLength(1);
        expect(f.bytes()).toEqual(before);
        expect(outcome).toBe('held');
      } finally { release.resolve(); Object.defineProperty(target, key, original); await observed; }
    }, 10000);
  }
}

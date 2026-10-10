import { ModelPickerDataProvider } from '@goodvibes-jev/engine/sdk/platform/runtime/ui';
import { createInitialModelState } from '../sdk/src/platform/runtime/store/domains/model.ts';
import { createInitialProviderHealthState } from '../sdk/src/platform/runtime/store/domains/provider-health.ts';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { getProviderRuntimeSnapshot, modelFamilyReadings, type ModelDefinition } from '@goodvibes-jev/engine/sdk/platform/providers';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

function model(displayName = 'Old'): ModelDefinition {
  return {
    id: 'alias', registryKey: 'local:alias', displayName, provider: 'local',
    description: '', selectable: true, contextWindow: 8192,
    capabilities: { reasoning: false, toolCalling: true, codeEditing: true, multimodal: false },
  };
}
function registry(catalog: () => ModelDefinition[]): Parameters<typeof getProviderRuntimeSnapshot>[0] {
  return {
    getRegistered: () => ({ name: 'local', models: ['alias'], chat: async () => { throw new Error('unused'); } }),
    getCurrentModel: () => catalog()[0]!,
    listModels: catalog,
    describeRuntime: async () => null,
    resolveModelPricing: () => ({ status: 'unknown' }),
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('provider runtime family projection', () => {
  test('uses the shared judgment for actual snapshots and never guesses from the id', async () => {
    const fixture = fakePort((_name, question) => choiceAnswer(question, 'Llama', 0.99));
    installJudgmentPort(fixture.port);
    const catalog = [model('gpt-claude-alias')];
    const source = registry(() => catalog);
    expect((await getProviderRuntimeSnapshot(source, 'local'))?.models[0]?.family).toBeUndefined();
    await modelFamilyReadings.read(catalog);
    expect((await getProviderRuntimeSnapshot(source, 'local'))?.models[0]?.family).toBe('Llama');
    expect(fixture.requests).toHaveLength(1);
  });

  test('unsettled, missing and failed judgments omit family while retaining the catalog', async () => {
    const ports = [
      undefined,
      fakePort((_name, question) => choiceAnswer(question, 'GPT', 0.1)).port,
      fakePort(() => { throw new Error('offline'); }).port,
    ];
    for (const port of ports) {
      installJudgmentPort(port);
      const snapshot = await getProviderRuntimeSnapshot(registry(() => [model('GPT')]), 'local');
      expect(snapshot?.models).toHaveLength(1);
      expect(snapshot?.models[0]).not.toHaveProperty('family');
    }
  });

  test('pending old readings never block snapshots or contaminate replacement metadata', async () => {
    const gate = deferred();
    const fixture = fakePort((_name, question, state) => choiceAnswer(question,
      (state as unknown as { displayName: string }).displayName === 'Old' ? 'GPT' : 'Llama', 0.99));
    installJudgmentPort({ ...fixture.port, async ask(request) {
      if ((request.state as unknown as { displayName: string }).displayName === 'Old') await gate.promise;
      return fixture.port.ask(request);
    } });
    const oldCatalog = [model()];
    let catalog = oldCatalog;
    const source = registry(() => catalog);
    const old = await getProviderRuntimeSnapshot(source, 'local');
    expect(old?.models[0]).toMatchObject({ displayName: 'Old' });
    expect(old?.models[0]).not.toHaveProperty('family');
    catalog = [model('New')];
    await getProviderRuntimeSnapshot(source, 'local');
    await modelFamilyReadings.read(catalog);
    expect((await getProviderRuntimeSnapshot(source, 'local'))?.models[0]).toMatchObject({ displayName: 'New', family: 'Llama' });
    gate.resolve();
    await modelFamilyReadings.read(oldCatalog);
    expect(old?.models[0]).not.toHaveProperty('family');
    expect((await getProviderRuntimeSnapshot(source, 'local'))?.models[0]).toMatchObject({ displayName: 'New', family: 'Llama' });
  });

  test('a replaced judgment authority cannot publish a late result on the old response', async () => {
    const gate = deferred();
    const fixture = fakePort((_name, question) => choiceAnswer(question, 'GPT', 0.99));
    installJudgmentPort({ ...fixture.port, async ask(request) { await gate.promise; return fixture.port.ask(request); } });
    const source = registry(() => [model()]);
    const pending = getProviderRuntimeSnapshot(source, 'local');
    installJudgmentPort(undefined);
    gate.resolve();
    expect((await pending)?.models[0]).not.toHaveProperty('family');
  });
  test('one failed reading does not hide completed siblings on subsequent snapshots', async () => {
    const gate = deferred();
    const fixture = fakePort((_name, question) => choiceAnswer(question, 'Llama', 0.99));
    installJudgmentPort({ ...fixture.port, async ask(request) {
      if ((request.state as unknown as { id: string }).id === 'alias') throw new Error('offline');
      await gate.promise;
      return fixture.port.ask(request);
    } });
    const catalog = [model(), { ...model('Sibling'), id: 'sibling', registryKey: 'local:sibling' }];
    const source = registry(() => catalog);
    const pendingSnapshot = await getProviderRuntimeSnapshot(source, 'local');
    expect(pendingSnapshot?.models[1]).not.toHaveProperty('family');
    const completion = modelFamilyReadings.read(catalog).catch(() => {});
    gate.resolve();
    await completion;
    const snapshot = await getProviderRuntimeSnapshot(source, 'local');
    expect(snapshot?.models[0]).not.toHaveProperty('family');
    expect(snapshot?.models[1]?.family).toBe('Llama');
  });

});


test('runtime UI publishes successful siblings on failed batches, unless disposed', async () => {
  for (const dispose of [false, true]) {
    const gate = deferred();
    const fixture = fakePort((_name, question) => choiceAnswer(question, 'Llama', 0.99));
    installJudgmentPort({ ...fixture.port, async ask(request) {
      if ((request.state as unknown as { id: string }).id === 'alias') throw new Error('offline');
      await gate.promise;
      return fixture.port.ask(request);
    } });
    const provider = new ModelPickerDataProvider(
      [model(), { ...model('Sibling'), id: 'sibling', registryKey: 'local:sibling' }],
      createInitialProviderHealthState(), createInitialModelState(), {
        benchmarkStore: { getBenchmarks: () => undefined },
        providerRegistry: {
          getSyntheticModelInfoFromCatalog: () => null,
          getContextWindowForModel: (model) => model.contextWindow,
          getKnownContextWindowForModel: (model) => model.contextWindow,
        },
      },
    );
    let updates = 0;
    provider.subscribe(() => { updates += 1; });
    if (dispose) provider.dispose();
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(updates).toBe(dispose ? 0 : 1);
    expect(provider.getSnapshot().entries.find((entry) => entry.modelId === 'sibling')?.family)
      .toBe(dispose ? undefined : 'Llama');
    provider.dispose();
  }
});

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { JudgmentInputError, snapshotJudgmentInput } from '../sdk/src/platform/gate/judgment-input.ts';
import { loadCustomProviders } from '../sdk/src/platform/providers/custom-loader.ts';
import { ModelFamilyReadings, modelFamilyReadings, type ModelFamilyInput } from '../sdk/src/platform/providers/model-family.ts';
import { getProviderRuntimeSnapshot } from '../sdk/src/platform/providers/runtime-snapshot.ts';
import { createAsyncDisposalScope } from '../sdk/src/platform/runtime/disposal.ts';
import { composeJudgment } from '../sdk/src/platform/runtime/judgment-services.ts';

const CANARY = 'Authorization: Bearer SYNTHETIC_ONLY_MODEL_METADATA_CANARY';
const clean = (): ModelFamilyInput => ({ registryKey: 'local:alias', id: 'alias', displayName: 'Alias', provider: 'local' });
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

test.each(['id', 'displayName', 'provider', 'description'] as const)(
  'automatic custom-provider snapshots screen complete %s before the composed transport and log', async (field) => {
    const root = mkdtempSync(join(tmpdir(), 'model-family-protected-'));
    const scope = createAsyncDisposalScope('model-family protected input');
    const originalFetch = globalThis.fetch;
    const bodies: string[] = [];
    // A long original also catches screening performed only after truncation.
    const value = `${'ordinary model metadata '.repeat(500)}\n${CANARY}`;
    const providerName = field === 'provider' ? value : 'local';
    try {
      // Every possible HTTP request is intercepted, including the provider's.
      // No real provider, credential or System One endpoint is contacted.
      globalThis.fetch = (async (_input, init) => {
        const body = String(init?.body);
        bodies.push(body);
        const request = JSON.parse(body) as { model: string; questions: Record<string, { criteria: Record<string, string> }> };
        const answers = Object.fromEntries(Object.entries(request.questions).map(([name, question]) => [name, {
          type: 'choice', choice: 'Llama', confidence: 0.99,
          probabilities: Object.fromEntries(Object.keys(question.criteria).map((option) => [option, option === 'Llama' ? 0.99 : 0.01 / (Object.keys(question.criteria).length - 1)])),
        }]));
        return Response.json({ model: request.model, answers, usage: { input_tokens: 1, output_tokens: 1 } });
      }) as typeof fetch;
      writeFileSync(join(root, 'custom.json'), JSON.stringify({
        name: providerName, displayName: 'Local', type: 'openai-compat', baseURL: 'http://127.0.0.1:1/v1',
        models: [{ id: 'custom-alias', displayName: 'Custom alias', description: '',
          ...(field === 'provider' ? {} : { [field]: value }), contextWindow: 8192,
          capabilities: { reasoning: false, toolCalling: true, codeEditing: true, multimodal: false } }],
      }));
      const loaded = await loadCustomProviders({ providersDir: root, ingestContextWindows: false });
      expect(loaded.models).toHaveLength(1);
      const model = loaded.models[0]!;
      expect(() => snapshotJudgmentInput(model)).toThrow(JudgmentInputError);
      const { decisionLog } = composeJudgment({
        config: { get: (key) => ({ 'judgment.endpoint': 'https://synthetic.example.test', 'judgment.keySource': 'env',
          'judgment.model': 'jev-1.13.0', 'judgment.timeoutMs': 1000 })[key] },
        secrets: { get: async () => null }, env: { TYPESAFE_API_KEY: 'synthetic-test-key' },
        stateRoot: join(root, 'state'), disposal: scope.registry,
      });
      const registry: Parameters<typeof getProviderRuntimeSnapshot>[0] = {
        getRegistered: () => loaded.providers[0]!.provider, getCurrentModel: () => model,
        listModels: () => loaded.models, describeRuntime: async () => null, resolveModelPricing: () => ({ status: 'unknown' }),
      };
      const snapshot = await getProviderRuntimeSnapshot(registry, providerName);
      await expect(modelFamilyReadings.read(loaded.models)).rejects.toBeInstanceOf(JudgmentInputError);
      expect(snapshot?.models).toHaveLength(1);
      expect(snapshot?.models[0]).not.toHaveProperty('family');
      expect(modelFamilyReadings.known(model)).toBeUndefined();
      expect(bodies).toEqual([]);
      expect(decisionLog.query()).toEqual([]);

      // A refused model does not disable ordinary classification or strand a
      // valid sibling; the real composition still records its settled reading.
      const sibling = { ...clean(), id: 'clean-sibling', registryKey: 'local:clean-sibling' };
      await expect(modelFamilyReadings.read([model, sibling])).rejects.toBeInstanceOf(JudgmentInputError);
      expect(modelFamilyReadings.known(sibling)).toBe('Llama');
      expect(bodies).toHaveLength(1);
      expect(bodies.some((body) => body.includes(CANARY))).toBe(false);
      const entries = decisionLog.query();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.status).toBe('answered');
      expect(JSON.stringify(entries)).not.toContain(CANARY);
      expect((await getProviderRuntimeSnapshot(registry, providerName))?.models[0]).not.toHaveProperty('family');
    } finally {
      await scope.close();
      globalThis.fetch = originalFetch;
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('full original is screened before a cached family can be reused', async () => {
  const fixture = fakePort((_name, question) => choiceAnswer(question, 'Llama', 0.99));
  installJudgmentPort(fixture.port);
  const readings = new ModelFamilyReadings();
  await readings.read([clean()]);
  const contaminated = { ...clean(), description: CANARY };
  expect(readings.known(contaminated)).toBeUndefined();
  await expect(readings.read([contaminated])).rejects.toBeInstanceOf(JudgmentInputError);
  expect(fixture.requests).toHaveLength(1);
  expect(readings.known(clean())).toBe('Llama');
});

test('complete originals are captured before asynchronous work without invoking accessors', async () => {
  const fixture = fakePort((_name, question) => choiceAnswer(question, 'Llama', 0.99));
  installJudgmentPort(fixture.port);
  const readings = new ModelFamilyReadings();
  let getterCalls = 0;
  const accessor = { ...clean(), get description() { getterCalls += 1; return CANARY; } };
  expect(readings.known(accessor)).toBeUndefined();
  await expect(readings.read([accessor])).rejects.toBeInstanceOf(JudgmentInputError);
  expect(getterCalls).toBe(0);
  expect(fixture.requests).toHaveLength(0);
  const mutable = { ...clean() };
  const pending = readings.read([mutable]);
  mutable.displayName = CANARY;
  await pending;
  expect(JSON.stringify(fixture.requests)).not.toContain(CANARY);
  expect(readings.known(mutable)).toBeUndefined();
  expect(readings.known(clean())).toBe('Llama');
});

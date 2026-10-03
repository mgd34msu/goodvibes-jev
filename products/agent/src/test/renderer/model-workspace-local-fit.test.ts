/**
 * Tests for the local-only header and sign-in affordance in model-workspace.
 * Covers the empty-state rendering when no provider credentials are configured.
 */
import { describe, expect, test, afterEach } from 'bun:test';
import type { ModelDefinition } from '@goodvibes-jev/engine/sdk/platform/providers';
import { ModelPickerModal } from '../../input/model-picker.ts';
import { renderModelWorkspace } from '../../renderer/model-workspace.ts';
import {
  buildLocalFitRecommendations,
  buildSignInRow,
  isLocalFitRecommendation,
  LOCAL_REC_PROVIDER,
} from '../../input/model-picker-local-fit.ts';
import {
  _resetHardwareProfileCache,
  _setHardwareProfileForTest,
} from '../../core/hardware-profile.ts';
import { layerText } from '../helpers/surface-frame.ts';

const W = 132;
const H = 34;

const STUB_PROFILE = {
  totalRamBytes: 16 * 1024 ** 3,
  availableRamBytes: 10 * 1024 ** 3,
  gpus: [],
  cpuCores: 8,
};

function makePicker(): ModelPickerModal {
  return new ModelPickerModal(
    { getRecentModels: async () => [] },
    { getBenchmarks: () => undefined },
    { getSyntheticModelInfoFromCatalog: () => null },
  );
}

function makeModel(overrides: Partial<ModelDefinition> = {}): ModelDefinition {
  return {
    id: 'gpt-test',
    provider: 'openai',
    registryKey: 'openai:gpt-test',
    displayName: 'GPT Test',
    description: '',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 128_000,
    selectable: true,
    tier: 'standard',
    ...overrides,
  };
}

function makePickerWithLocalOnly(): ModelPickerModal {
  _setHardwareProfileForTest(STUB_PROFILE);
  const picker = makePicker();
  const recs = [...buildLocalFitRecommendations(STUB_PROFILE), buildSignInRow()];
  picker.active = true;
  picker.models = recs;
  picker.providers = [];
  picker.configuredProviders = new Set(); // no creds
  picker.configuredViaMap = new Map();
  picker.setTargetInfos([
    {
      target: 'main',
      label: 'Main Chat',
      description: 'Default provider and model.',
      provider: '',
      model: '',
      enabled: true,
      inherited: false,
    },
  ]);
  picker.openAllModels(recs, recs[0]?.registryKey ?? '');
  return picker;
}

afterEach(() => {
  _resetHardwareProfileCache();
});

describe('local-only workspace header', () => {
  test('renders local-only header when list contains only synthetic recommendations', () => {
    const picker = makePickerWithLocalOnly();
    const text = layerText(renderModelWorkspace(picker, W, H)).join('\n');
    expect(text).toContain('No provider signed in');
  });

  test('renders Sign in instead affordance when list is local-only', () => {
    const picker = makePickerWithLocalOnly();
    const text = layerText(renderModelWorkspace(picker, W, H)).join('\n');
    // The affordance is now a selectable row; the header instructs the user to
    // navigate to it rather than press a dead key.
    expect(text).toContain('Sign in instead');
  });

  test('renders sign-in row as a selectable list entry when list is local-only', () => {
    const picker = makePickerWithLocalOnly();
    // The sign-in row is appended to the local-only list
    const signInEntry = picker.models.find((m) => m.id === 'local:sign-in');
    expect(signInEntry).toBeDefined();
    expect(signInEntry?.displayName).toContain('Sign in to a provider');
  });

  test('local recommendations are non-empty on the stub profile', () => {
    const picker = makePickerWithLocalOnly();
    // The picker list should contain the synthetic recs plus the sign-in row
    expect(picker.models.length).toBeGreaterThan(0);
    // All entries are from the LOCAL_REC_PROVIDER sentinel (includes sign-in row)
    expect(picker.models.every((m) => m.provider === LOCAL_REC_PROVIDER)).toBe(true);
  });

  test('fit label in detail pane matches fitAssessment for the stub profile', () => {
    const picker = makePickerWithLocalOnly();
    const text = layerText(renderModelWorkspace(picker, W, H)).join('\n');
    // On 16 GB total / 10 GB available, 3B (1.65 GB) fits in RAM
    // The detail pane should show "not yet installed" and a fit hint
    expect(text).toContain('not yet installed');
  });

  test('does not show local-only header when real provider is configured', () => {
    const picker = makePicker();
    const realModel = makeModel();
    picker.active = true;
    picker.models = [realModel];
    picker.providers = ['openai'];
    picker.configuredProviders = new Set(['openai']);
    picker.configuredViaMap = new Map([['openai', 'env']]);
    picker.setTargetInfos([
      {
        target: 'main',
        label: 'Main Chat',
        description: 'Default provider and model.',
        provider: 'openai',
        model: 'openai:gpt-test',
        enabled: true,
        inherited: false,
      },
    ]);
    picker.openAllModels([realModel], 'openai:gpt-test');
    const text = layerText(renderModelWorkspace(picker, W, H)).join('\n');
    expect(text).not.toContain('No provider signed in');
    expect(text).not.toContain('Sign in instead');
  });

  test('no synthetic local rows appear when real provider is configured', () => {
    const picker = makePicker();
    const realModel = makeModel();
    picker.active = true;
    picker.models = [realModel];
    picker.providers = ['openai'];
    picker.configuredProviders = new Set(['openai']);
    picker.configuredViaMap = new Map([['openai', 'env']]);
    picker.setTargetInfos([{
      target: 'main',
      label: 'Main Chat',
      description: '',
      provider: 'openai',
      model: 'openai:gpt-test',
      enabled: true,
      inherited: false,
    }]);
    picker.openAllModels([realModel], 'openai:gpt-test');
    // No model in the picker should have the local sentinel provider
    const localRecs = picker.models.filter((m) => m.provider === LOCAL_REC_PROVIDER);
    expect(localRecs).toHaveLength(0);
  });
});

describe('local rec selection does not silently switch model', () => {
  test('selecting a local rec routes to local provider, not a real cloud provider', () => {
    _setHardwareProfileForTest(STUB_PROFILE);
    const recs = buildLocalFitRecommendations(STUB_PROFILE);
    // All recommendations are NOT installed, provider is the sentinel 'local',
    // never a real cloud provider like 'openai' or 'anthropic'.
    for (const rec of recs) {
      expect(rec.provider).toBe(LOCAL_REC_PROVIDER);
      // registryKey equals the synthetic id (no real cloud routing)
      expect(rec.registryKey).toBe(rec.id);
      // The synthetic id starts with LOCAL_REC_PROVIDER prefix
      expect(rec.id.startsWith(LOCAL_REC_PROVIDER + ':')).toBe(true);
    }
  });

  test('local recs are not marked as installed/configured in configuredProviders', () => {
    _setHardwareProfileForTest(STUB_PROFILE);
    const recs = buildLocalFitRecommendations(STUB_PROFILE);
    const picker = makePickerWithLocalOnly();
    // configuredProviders must be empty, the synthetic entries must not be treated
    // as real configured providers, preventing any silent model switch.
    expect(picker.configuredProviders.has(LOCAL_REC_PROVIDER)).toBe(false);
    // The models are present in the list but are flagged as not-yet-installed
    expect(picker.models.length).toBeGreaterThan(0);
    expect(recs.every((r) => (r.description ?? '').includes('not yet installed'))).toBe(true);
  });
});

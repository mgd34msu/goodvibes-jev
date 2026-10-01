import { describe, expect, test, afterEach } from 'bun:test';
import type { ModelDefinition } from '@goodvibes-jev/engine/sdk/platform/providers';
import { ModelPickerModal } from '../../input/model-picker.ts';
import { renderModelWorkspace } from '../../renderer/model-workspace.ts';
import { _resetHardwareProfileCache, _setHardwareProfileForTest } from '../../core/hardware-profile.ts';
import { layerText } from '../helpers/surface-frame.ts';

const W = 132;
const H = 34;

function makeModel(overrides: Partial<ModelDefinition> = {}): ModelDefinition {
  const base: ModelDefinition = {
    id: 'gpt-test',
    provider: 'openai',
    registryKey: 'openai:gpt-test',
    displayName: 'GPT Test',
    description: '',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
    contextWindow: 128_000,
    selectable: true,
    tier: 'premium',
    ...overrides,
  };
  if (!base.registryKey) base.registryKey = `${base.provider}:${base.id}`;
  return base;
}

function makePicker(): ModelPickerModal {
  const picker = new ModelPickerModal(
    { getRecentModels: async () => [] },
    { getBenchmarks: () => undefined },
    { getSyntheticModelInfoFromCatalog: () => null },
  );
  picker.active = true;
  picker.models = [
    makeModel(),
    makeModel({
      id: 'claude-test',
      provider: 'anthropic',
      registryKey: 'anthropic:claude-test',
      displayName: 'Claude Test',
      tier: 'subscription',
      contextWindow: 200_000,
    }),
  ];
  picker.providers = ['openai', 'anthropic'];
  picker.configuredProviders = new Set(['openai', 'anthropic']);
  picker.configuredViaMap = new Map([['openai', 'env'], ['anthropic', 'subscription']]);
  picker.setTargetInfos([
    {
      target: 'main',
      label: 'Main Chat',
      description: 'Default provider and model for normal chat turns.',
      provider: 'openai',
      model: 'openai:gpt-test',
      enabled: true,
      inherited: false,
    },
    {
      target: 'helper',
      label: 'Helper Model',
      description: 'Helper route.',
      provider: 'anthropic',
      model: 'anthropic:claude-test',
      enabled: true,
      inherited: false,
    },
    {
      target: 'tool',
      label: 'Tool LLM',
      description: 'Tool route.',
      provider: 'openai',
      model: 'openai:gpt-test',
      enabled: false,
      inherited: true,
    },
    {
      target: 'tts',
      label: 'TTS LLM',
      description: 'Spoken response route.',
      provider: 'openai',
      model: 'openai:gpt-test',
      enabled: true,
      inherited: true,
    },
  ]);
  picker.openAllModels(picker.models, 'openai:gpt-test');
  return picker;
}

// ---------------------------------------------------------------------------
// Hardware fit line tests
// ---------------------------------------------------------------------------

describe('modelHardwareFitLine (via detailLines)', () => {
  afterEach(() => {
    _resetHardwareProfileCache();
  });

  test('local ollama model in model-mode detail contains Hardware: line', () => {
    // Inject a deterministic hardware profile so the verdict is never 'unknown'.
    _setHardwareProfileForTest({
      totalRamBytes: 16 * 1024 ** 3,
      availableRamBytes: 8 * 1024 ** 3,
      gpus: [],
      cpuCores: 8,
    });
    const ollamaModel = makeModel({ id: 'llama3', provider: 'ollama', registryKey: 'ollama:llama3', displayName: 'Llama 3' });
    const picker = makePicker();
    picker.models = [ollamaModel];
    picker.providers = ['ollama'];
    picker.configuredProviders = new Set(['ollama']);
    picker.configuredViaMap = new Map([['ollama', 'env']]);
    picker.availableOnly = false;
    picker.openAllModels(picker.models, 'ollama:llama3');
    const text = layerText(renderModelWorkspace(picker, W, H)).join('\n');
    expect(text).toContain('Hardware:');
  });

  test('cloud model (groq llama-3.1-70b) does NOT produce Hardware: line', () => {
    _setHardwareProfileForTest({
      totalRamBytes: 16 * 1024 ** 3,
      availableRamBytes: 8 * 1024 ** 3,
      gpus: [],
      cpuCores: 8,
    });
    const groqModel = makeModel({ id: 'llama-3.1-70b', provider: 'groq', registryKey: 'groq:llama-3.1-70b', displayName: 'Llama 3.1 70B' });
    const picker = makePicker();
    picker.models = [groqModel];
    picker.providers = ['groq'];
    picker.configuredProviders = new Set(['groq']);
    picker.configuredViaMap = new Map([['groq', 'env']]);
    picker.availableOnly = false;
    picker.openAllModels(picker.models, 'groq:llama-3.1-70b');
    const text = layerText(renderModelWorkspace(picker, W, H)).join('\n');
    expect(text).not.toContain('Hardware:');
  });

  test('local 70B model label mentions 70B not 7B', () => {
    // Use a 16 GB RAM profile so 70B (38.5 GB) is definitely too-big and produces a non-empty label.
    _setHardwareProfileForTest({
      totalRamBytes: 16 * 1024 ** 3,
      availableRamBytes: 8 * 1024 ** 3,
      gpus: [],
      cpuCores: 8,
    });
    const ollamaModel70b = makeModel({ id: 'llama-3.1-70b', provider: 'ollama', registryKey: 'ollama:llama-3.1-70b', displayName: 'Llama 3.1 70B' });
    const picker = makePicker();
    picker.models = [ollamaModel70b];
    picker.providers = ['ollama'];
    picker.configuredProviders = new Set(['ollama']);
    picker.configuredViaMap = new Map([['ollama', 'env']]);
    picker.availableOnly = false;
    picker.openAllModels(picker.models, 'ollama:llama-3.1-70b');
    const text = layerText(renderModelWorkspace(picker, W, H)).join('\n');
    // Label must reference the real model size, not the 7B fallback.
    expect(text).toContain('70B');
    // Verify it doesn't fall through to the 7B representative label.
    // Extract only the Hardware: line to avoid false positives from model id text.
    const hwLine = text.split('\n').find((line) => line.includes('Hardware:')) ?? '';
    expect(hwLine).not.toContain('7B');
  });
});

describe('renderModelWorkspace', () => {
  test('is a kit modal layer that fits the screen', () => {
    const layer = renderModelWorkspace(makePicker(), W, H);
    expect(layer.dim).toBe(true);
    expect(layer.x + layer.lines[0]!.length).toBeLessThanOrEqual(W);
    expect(layer.y + layer.lines.length).toBeLessThanOrEqual(H);
  });

  test('renders the target tabs, the selected target details and the model list', () => {
    const text = layerText(renderModelWorkspace(makePicker(), W, H)).join('\n');
    expect(text).toContain('Models › Main Chat › Model list');
    expect(text).toContain('Main Chat');
    expect(text).toContain('Helper Model');
    expect(text).toContain('Tool LLM (off)');
    expect(text).toContain('Target: Main Chat');
    expect(text).toContain('openai:gpt-test');
    expect(text).toContain('Claude Test');
  });

  test('does not advertise code-editing capability in Agent model UI', () => {
    const text = layerText(renderModelWorkspace(makePicker(), W, H)).join('\n');
    expect(text).toContain('reasoning, tools');
    expect(text).not.toContain('reasoning, tools, code');
    expect(text).not.toContain('RVTC');
  });

  test('provider mode lists providers with their configuration state', () => {
    const picker = makePicker();
    picker.openProviders(['openai', 'anthropic'], 'openai');
    const text = layerText(renderModelWorkspace(picker, W, H)).join('\n');
    expect(text).toContain('Provider list');
    expect(text).toContain('Search providers');
    expect(text).toContain('openai');
    expect(text).toContain('env');
  });

  test('the search row is always live and narrows the list', () => {
    const picker = makePicker();
    for (const ch of 'claude') picker.appendChar(ch);
    const text = layerText(renderModelWorkspace(picker, W, H)).join('\n');
    expect(text).toContain('claude▏');
    expect(text).toContain('Claude Test');
    expect(text).not.toContain('GPT Test');
  });

  test('keycap hints name the filter chords (every letter can be typed into the search)', () => {
    const text = layerText(renderModelWorkspace(makePicker(), W, H)).join('\n');
    expect(text).toContain('tab  target');
    expect(text).toContain('ctrl+t  price');
    expect(text).toContain('ctrl+g  group');
  });
});

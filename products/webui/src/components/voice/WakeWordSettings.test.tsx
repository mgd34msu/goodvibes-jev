/**
 * WakeWordSettings, the surface that makes wake detection RUNNABLE in a browser.
 *
 * Three things are asserted because none of them is expressible as a config row:
 * the provisioning act carries its real download size, the per-origin opt-in writes
 * `voice.wake.surfaces.webui`, and the resolver's blockers and limitations are
 * rendered VERBATIM rather than summarised into something friendlier and wrong.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { resolveWebuiWakeSettings } from '../../lib/voice/wake-config';
import type { WakeHostState } from '../../lib/voice/wake-host';

const IDLE_HOST: WakeHostState = {
  phase: 'off',
  indicator: 'off',
  settings: null,
  deviceLabel: null,
  refusal: null,
  error: null,
  backend: null,
  backendNote: null,
  restarts: 0,
  lastWakeAt: null,
  lastTranscript: null,
  modelIds: [],
};

interface QueryLike {
  isPending: boolean;
  isError: boolean;
  isSuccess: boolean;
  error?: unknown;
  data?: unknown;
}

const NOT_PROVISIONED = {
  ready: false,
  reason: 'The pinned wake-word classifier is not installed.',
  classifier: { path: '/home/e2e/.goodvibes/voice/wake/hey_goodvibes.onnx', verified: false, corrupt: false, bytes: 0 },
  embedding: { path: '/home/e2e/.goodvibes/voice/wake/embedding_model.onnx', verified: false, corrupt: false, bytes: 0 },
  notice: { path: '/home/e2e/.goodvibes/voice/wake/MODEL_NOTICE.md', verified: false, corrupt: false, bytes: 0 },
  downloadBytes: 3_884_142,
  modelVersion: null,
  recallIsSyntheticOnly: true,
};

const PROVISIONED = {
  ...NOT_PROVISIONED,
  ready: true,
  reason: null,
  classifier: { ...NOT_PROVISIONED.classifier, verified: true, bytes: 1_785_000 },
  embedding: { ...NOT_PROVISIONED.embedding, verified: true, bytes: 2_094_000 },
  notice: { ...NOT_PROVISIONED.notice, verified: true, bytes: 5_142 },
  modelVersion: 'hey_goodvibes-v1',
};

let mockStatus: QueryLike = { isPending: false, isError: false, isSuccess: true, data: NOT_PROVISIONED };
let provisionCalls = 0;
let mockProvision: QueryLike & { mutate: () => void } = {
  isPending: false,
  isError: false,
  isSuccess: false,
  mutate: () => { provisionCalls += 1; },
};
let mockSettings = resolveWebuiWakeSettings({ voice: { wake: { enabled: true } } });
let mockHostState: WakeHostState = IDLE_HOST;
let lastProvisioningEnabled: boolean | undefined;
let mockSttAvailable = true;

mock.module('../../lib/voice/useWake', () => ({
  useWakeProvisioning: (enabled: boolean) => {
    lastProvisioningEnabled = enabled;
    return { status: mockStatus, provision: mockProvision };
  },
  useWakeState: () => mockHostState,
  useWakeSurfaceSettings: () => mockSettings,
  useWakeTranscriptionAvailable: () => mockSttAvailable,
}));

const configWrites: { key: string; value: unknown }[] = [];

mock.module('../../lib/goodvibes', () => ({
  sdk: {
    operator: {
      config: {
        set: (key: string, value: unknown) => {
          configWrites.push({ key, value });
          return Promise.resolve({ success: true, key, value });
        },
      },
    },
  },
}));

const { WakeWordSettings } = await import('./WakeWordSettings');

function render(open = true): { el: HTMLElement; unmount: () => void } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(WakeWordSettings, { open }),
    ));
  });
  return {
    // document.body: kit overlays (dialogs, drawers, menus) portal there.
    el: document.body,
    unmount: () => {
      flushSync(() => { root.unmount(); });
      container.parentNode?.removeChild(container);
    },
  };
}

/** React Query runs a mutationFn on a microtask, so a write is observable a tick later. */
async function flushMutations(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
  mockStatus = { isPending: false, isError: false, isSuccess: true, data: NOT_PROVISIONED };
  mockProvision = { isPending: false, isError: false, isSuccess: false, mutate: () => { provisionCalls += 1; } };
  mockSettings = resolveWebuiWakeSettings({ voice: { wake: { enabled: true } } });
  mockHostState = IDLE_HOST;
  provisionCalls = 0;
  configWrites.length = 0;
  lastProvisioningEnabled = undefined;
  mockSttAvailable = true;
});

describe('provisioning', () => {
  test('the download action carries the real size and is never automatic', () => {
    const view = render();
    cleanup = view.unmount;
    const button = [...view.el.querySelectorAll('button')]
      .find((element) => element.textContent?.includes('Download the wake-word models'));
    expect(button).toBeDefined();
    expect(button?.textContent).toContain('3.7 MB');
    // Nothing has been fetched merely by rendering.
    expect(provisionCalls).toBe(0);
    flushSync(() => { button?.click(); });
    expect(provisionCalls).toBe(1);
  });

  test('an installed set shows the pinned version, with no download action', () => {
    mockStatus = { isPending: false, isError: false, isSuccess: true, data: PROVISIONED };
    const view = render();
    cleanup = view.unmount;
    expect(view.el.textContent).toContain('hey_goodvibes-v1');
    expect([...view.el.querySelectorAll('button')]
      .some((element) => element.textContent?.includes('Download'))).toBe(false);
  });

  test('a daemon that has never heard of the verb renders no section at all', () => {
    mockStatus = {
      isPending: false,
      isError: true,
      isSuccess: false,
      error: Object.assign(new Error('Unknown gateway method'), { status: 404, code: 'METHOD_NOT_FOUND' }),
    };
    const view = render();
    cleanup = view.unmount;
    expect(view.el.querySelector('[data-testid="voice-settings-wake"]')).toBeNull();
  });

  test('the status read is gated on the popover being open', () => {
    const closed = render(false);
    expect(lastProvisioningEnabled).toBe(false);
    closed.unmount();
    const open = render(true);
    cleanup = open.unmount;
    expect(lastProvisioningEnabled).toBe(true);
  });
});

describe('the per-origin opt-in', () => {
  test('it is off by default and writes voice.wake.surfaces.webui when switched on', async () => {
    const view = render();
    cleanup = view.unmount;
    const checkbox = [...view.el.querySelectorAll('input[type="checkbox"]')]
      .find((element) => element.closest('label')?.textContent?.includes('Listen for the wake word in this browser'));
    expect(checkbox).toBeDefined();
    expect((checkbox as HTMLInputElement).checked).toBe(false);

    flushSync(() => { (checkbox as HTMLInputElement).click(); });
    await flushMutations();
    expect(configWrites).toEqual([{ key: 'voice.wake.surfaces.webui', value: true }]);
  });

  test('the global switch is offered while the feature is off, and writes voice.wake.enabled', async () => {
    mockSettings = resolveWebuiWakeSettings({});
    const view = render();
    cleanup = view.unmount;
    const checkbox = [...view.el.querySelectorAll('input[type="checkbox"]')]
      .find((element) => element.closest('label')?.textContent?.includes('all surfaces'));
    expect(checkbox).toBeDefined();
    flushSync(() => { (checkbox as HTMLInputElement).click(); });
    await flushMutations();
    expect(configWrites).toEqual([{ key: 'voice.wake.enabled', value: true }]);
  });
});

describe('the resolver\'s own reasons, verbatim', () => {
  test('a blocker is rendered with its key and its full written detail', () => {
    // The speech gate with its artifact not provisioned: speex no longer blocks
    // (the filter ships as WebAssembly), so this is the row that still does.
    mockSettings = resolveWebuiWakeSettings({
      voice: { wake: { enabled: true, surfaces: { webui: true }, vadThreshold: 0.5 } },
    });
    const view = render();
    cleanup = view.unmount;
    const list = view.el.querySelector('[data-testid="wake-blockers"]');
    expect(list?.textContent).toContain('voice.wake.vadThreshold');
    // The exact sentence the SDK wrote, not a paraphrase of it.
    expect(list?.textContent).toContain(mockSettings.blockers[0].detail);
  });

  test('a limitation is rendered the same way, and does not read as a failure', () => {
    mockSettings = resolveWebuiWakeSettings({
      voice: { wake: { enabled: true, surfaces: { webui: true }, retainAudio: 'session-temp' } },
    });
    const view = render();
    cleanup = view.unmount;
    const list = view.el.querySelector('[data-testid="wake-limitations"]');
    expect(list?.textContent).toContain('voice.wake.retainAudio');
    expect(list?.textContent).toContain(mockSettings.limitations[0].detail);
    expect(view.el.querySelector('[data-testid="wake-blockers"]')).toBeNull();
  });

  test('a webgpu fallback is reported against the row that asked for it', () => {
    mockHostState = {
      ...IDLE_HOST,
      phase: 'listening',
      indicator: 'statusline',
      backend: 'wasm',
      backendNote: 'set to "webgpu", but this browser exposes no navigator.gpu.',
    };
    const view = render();
    cleanup = view.unmount;
    const note = view.el.querySelector('[data-testid="wake-backend-note"]');
    expect(note?.textContent).toContain('voice.wake.browserBackend');
    expect(note?.textContent).toContain('no navigator.gpu');
  });

  test('the live state and the backend actually in force are both shown', () => {
    mockHostState = { ...IDLE_HOST, phase: 'listening', indicator: 'statusline', backend: 'wasm' };
    const view = render();
    cleanup = view.unmount;
    const live = view.el.querySelector('[data-testid="wake-live-state"]');
    expect(live).not.toBeNull();
    expect(live?.textContent).toContain('wasm');
  });

  test('no speech-to-text provider is stated up front, not discovered after a wake', () => {
    mockSttAvailable = false;
    const view = render();
    cleanup = view.unmount;
    expect(view.el.querySelector('[data-testid="wake-stt-missing"]')).not.toBeNull();
  });

  test('with a provider configured that warning is absent', () => {
    const view = render();
    cleanup = view.unmount;
    expect(view.el.querySelector('[data-testid="wake-stt-missing"]')).toBeNull();
  });

  test('the last thing heard is shown as a receipt', () => {
    mockHostState = { ...IDLE_HOST, phase: 'listening', indicator: 'statusline', lastTranscript: 'open the fleet view' };
    const view = render();
    cleanup = view.unmount;
    expect(view.el.querySelector('[data-testid="wake-last-transcript"]')?.textContent)
      .toContain('open the fleet view');
  });
});

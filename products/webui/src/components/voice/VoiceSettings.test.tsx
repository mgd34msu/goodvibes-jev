/**
 * VoiceSettings, covers the shared voice popover's local-voice setup section
 * (voice.local.status / voice.local.install, SDK 1.9.0-dev's memory-relay-voice-
 * hardening work): checking/unavailable/error/provisioned/unsupported-platform/
 * not-provisioned (setup action, size-labeled)/install-progress/install-receipt
 * (with and without a retriable failure) states.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let mockVoiceStatus: unknown = {
  enabled: true,
  ttsAvailable: false,
  sttAvailable: false,
  providers: [],
  note: '',
};
let mockVoiceConfig: unknown = { provider: '', voice: '' };

mock.module('../../lib/voice/useVoice', () => ({
  useVoiceStatus: () => ({ availability: mockVoiceStatus, isLoading: false }),
  useSharedVoiceConfig: () => ({ config: mockVoiceConfig, isLoading: false }),
}));

mock.module('../../lib/goodvibes', () => ({
  invokeMethod: () => Promise.resolve({}),
  sdk: {
    operator: {
      voice: {
        voices: () => Promise.resolve({ voices: [] }),
      },
    },
  },
}));

let mockLocalStatus: {
  isPending: boolean;
  isError: boolean;
  isSuccess: boolean;
  error?: unknown;
  data?: unknown;
} = { isPending: false, isError: false, isSuccess: false, data: undefined };

let localInstallMutateCalls = 0;
let mockLocalInstall: { isPending: boolean; isError: boolean; isSuccess: boolean; error?: unknown; data?: unknown; mutate: () => void } = {
  isPending: false,
  isError: false,
  isSuccess: false,
  data: undefined,
  mutate: () => { localInstallMutateCalls += 1; },
};

let lastStatusPollArg: boolean | undefined;

mock.module('../../hooks/useVoiceLocalSetup', () => ({
  useVoiceLocalStatus: (_enabled: boolean, pollForInstallProgress?: boolean) => {
    lastStatusPollArg = pollForInstallProgress;
    return mockLocalStatus;
  },
  useVoiceLocalInstall: () => mockLocalInstall,
}));

// The wake-word section is its own component with its own suite
// (WakeWordSettings.test.tsx). Stubbed out here so this file stays about the
// local-voice card, and so mocking useVoice above does not have to satisfy the
// wake hooks' imports.
mock.module('./WakeWordSettings', () => ({
  WakeWordSettings: () => null,
}));

const { VoiceSettings } = await import('./VoiceSettings');

function render(): { el: HTMLElement; unmount: () => void } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(React.createElement(QueryClientProvider, { client }, React.createElement(VoiceSettings)));
  });
  return {
    // document.body: kit overlays (dialogs, drawers, menus) portal there.
    el: document.body,
    unmount: () => {
      flushSync(() => { root.unmount(); });
      if (container.parentNode) container.parentNode.removeChild(container);
    },
  };
}

function openPopover(el: HTMLElement): void {
  const trigger = el.querySelector('.voice-settings-btn') as HTMLButtonElement;
  flushSync(() => { trigger.click(); });
}

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
  mockVoiceStatus = { enabled: true, ttsAvailable: false, sttAvailable: false, providers: [], note: '' };
  mockVoiceConfig = { provider: '', voice: '' };
  mockLocalStatus = { isPending: false, isError: false, isSuccess: false, data: undefined };
  localInstallMutateCalls = 0;
  mockLocalInstall = { isPending: false, isError: false, isSuccess: false, data: undefined, mutate: () => { localInstallMutateCalls += 1; } };
  lastStatusPollArg = undefined;
});

const NOT_PROVISIONED_STATUS = {
  platform: 'linux-x64',
  state: 'not-provisioned',
  tts: { engine: 'piper', binaryPresent: false, voicePresent: false, binaryPath: '/x/piper', modelPath: '/x/voice.onnx' },
  stt: {
    engine: 'whisper-cpp',
    supported: true,
    state: 'not-provisioned',
    binaryPresent: false,
    modelPresent: false,
    binaryPath: '/x/whisper',
    modelPath: '/x/model.bin',
  },
  offerBytes: 209_715_200,
};

describe('VoiceSettings: local voice setup', () => {
  test('the local section is not rendered until the popover opens', () => {
    const { el, unmount } = render();
    cleanup = unmount;
    expect(el.querySelector('[data-testid="voice-settings-local"]')).toBeNull();
  });

  test('unavailable (404 METHOD_NOT_FOUND) skips the section entirely, no error banner for a capability the daemon never heard of', () => {
    mockLocalStatus = {
      isPending: false,
      isError: true,
      isSuccess: false,
      error: Object.assign(new Error('Unknown gateway method'), { status: 404, code: 'METHOD_NOT_FOUND' }),
      data: undefined,
    };
    const { el, unmount } = render();
    cleanup = unmount;
    openPopover(el);
    expect(el.querySelector('[data-testid="voice-settings-local"]')).toBeNull();
  });

  test('unavailable (501) also skips the section entirely', () => {
    mockLocalStatus = {
      isPending: false,
      isError: true,
      isSuccess: false,
      error: Object.assign(new Error('not wired'), { status: 501 }),
      data: undefined,
    };
    const { el, unmount } = render();
    cleanup = unmount;
    openPopover(el);
    expect(el.querySelector('[data-testid="voice-settings-local"]')).toBeNull();
  });

  test('a genuine fetch error keeps the local section, distinct from unavailable', () => {
    mockLocalStatus = {
      isPending: false,
      isError: true,
      isSuccess: false,
      error: Object.assign(new Error('network down'), { status: 0, category: 'network' }),
      data: undefined,
    };
    const { el, unmount } = render();
    cleanup = unmount;
    openPopover(el);
    expect(el.querySelector('[data-testid="voice-settings-local"]')).not.toBeNull();
  });

  test('provisioned state offers no setup button', () => {
    mockLocalStatus = {
      isPending: false,
      isError: false,
      isSuccess: true,
      data: {
        ...NOT_PROVISIONED_STATUS,
        state: 'provisioned',
        tts: { ...NOT_PROVISIONED_STATUS.tts, binaryPresent: true, voicePresent: true },
        stt: { ...NOT_PROVISIONED_STATUS.stt, binaryPresent: true, modelPresent: true },
      },
    };
    const { el, unmount } = render();
    cleanup = unmount;
    openPopover(el);
    const buttons = Array.from(el.querySelectorAll('[data-testid="voice-settings-local"] button')).map((b) => b.textContent);
    expect(buttons.some((t) => t?.includes('Set up local voice'))).toBe(false);
  });

  test('unsupported-platform state offers no setup button', () => {
    mockLocalStatus = {
      isPending: false,
      isError: false,
      isSuccess: true,
      data: { ...NOT_PROVISIONED_STATUS, state: 'unsupported-platform', offerBytes: null },
    };
    const { el, unmount } = render();
    cleanup = unmount;
    openPopover(el);
    const buttons = Array.from(el.querySelectorAll('[data-testid="voice-settings-local"] button')).map((b) => b.textContent);
    expect(buttons.some((t) => t?.includes('Set up local voice'))).toBe(false);
  });

  test('not-provisioned state shows a size-labeled setup action that invokes install on click', () => {
    mockLocalStatus = { isPending: false, isError: false, isSuccess: true, data: NOT_PROVISIONED_STATUS };
    const { el, unmount } = render();
    cleanup = unmount;
    openPopover(el);
    const button = Array.from(el.querySelectorAll('[data-testid="voice-settings-local"] button'))
      .find((b) => b.textContent?.includes('Set up local voice')) as HTMLButtonElement;
    expect(button).toBeDefined();
    expect(button.textContent).toContain('200.0 MB');
    flushSync(() => { button.click(); });
    expect(localInstallMutateCalls).toBe(1);
  });

  test('partial state also offers the setup action', () => {
    mockLocalStatus = { isPending: false, isError: false, isSuccess: true, data: { ...NOT_PROVISIONED_STATUS, state: 'partial' } };
    const { el, unmount } = render();
    cleanup = unmount;
    openPopover(el);
    const button = Array.from(el.querySelectorAll('[data-testid="voice-settings-local"] button'))
      .find((b) => b.textContent?.includes('Set up local voice'));
    expect(button).toBeDefined();
  });

  test('installing disables the setup action so a second install cannot start', () => {
    mockLocalStatus = { isPending: false, isError: false, isSuccess: true, data: NOT_PROVISIONED_STATUS };
    mockLocalInstall = { ...mockLocalInstall, isPending: true };
    const { el, unmount } = render();
    cleanup = unmount;
    openPopover(el);
    const button = el.querySelector<HTMLButtonElement>('[data-testid="voice-settings-local"] button');
    expect(button?.disabled).toBe(true);
    flushSync(() => { button?.click(); });
    expect(localInstallMutateCalls).toBe(0);
  });

  test('while installing, live per-component progress renders when the daemon serves installInProgress', () => {
    mockLocalStatus = {
      isPending: false,
      isError: false,
      isSuccess: true,
      data: {
        ...NOT_PROVISIONED_STATUS,
        installInProgress: {
          startedAt: 1_752_600_000_000,
          components: [
            { component: 'piper-voice-onnx', phase: 'done', bytesTotal: 63_201_294, bytesDone: 63_201_294 },
            { component: 'piper-engine', phase: 'download', bytesTotal: 6_942_130 },
            { component: 'whisper-model', phase: 'extract' },
          ],
        },
      },
    };
    mockLocalInstall = { ...mockLocalInstall, isPending: true };
    const { el, unmount } = render();
    cleanup = unmount;
    openPopover(el);
    const progress = el.querySelector('[data-testid="voice-local-progress"]');
    expect(progress).not.toBeNull();
    expect(progress?.querySelectorAll('li').length).toBe(3);
    expect(progress?.textContent).toContain('piper-voice-onnx');
    expect(progress?.textContent).toContain('60.3 MB');
    expect(progress?.textContent).toContain('6.6 MB');
    expect(progress?.textContent).toContain('whisper-model');
  });

  test('an errored progress component shows the daemon message with the error phase', () => {
    mockLocalStatus = {
      isPending: false,
      isError: false,
      isSuccess: true,
      data: {
        ...NOT_PROVISIONED_STATUS,
        installInProgress: {
          startedAt: 1,
          components: [{ component: 'piper-engine', phase: 'error', message: 'network timeout fetching piper.tar.gz' }],
        },
      },
    };
    mockLocalInstall = { ...mockLocalInstall, isPending: true };
    const { el, unmount } = render();
    cleanup = unmount;
    openPopover(el);
    const progress = el.querySelector('[data-testid="voice-local-progress"]');
    expect(progress?.textContent).toContain('network timeout fetching piper.tar.gz');
  });

  test('while installing WITHOUT an installInProgress section (older daemon), the plain busy state stays', () => {
    mockLocalStatus = { isPending: false, isError: false, isSuccess: true, data: NOT_PROVISIONED_STATUS };
    mockLocalInstall = { ...mockLocalInstall, isPending: true };
    const { el, unmount } = render();
    cleanup = unmount;
    openPopover(el);
    expect(el.querySelector<HTMLButtonElement>('[data-testid="voice-settings-local"] button')?.disabled).toBe(true);
    expect(el.querySelector('[data-testid="voice-local-progress"]')).toBeNull();
  });

  test('progress never renders outside an in-flight install, even if a stale section lingers in cache', () => {
    mockLocalStatus = {
      isPending: false,
      isError: false,
      isSuccess: true,
      data: {
        ...NOT_PROVISIONED_STATUS,
        installInProgress: { startedAt: 1, components: [{ component: 'piper-engine', phase: 'download' }] },
      },
    };
    mockLocalInstall = { ...mockLocalInstall, isPending: false };
    const { el, unmount } = render();
    cleanup = unmount;
    openPopover(el);
    expect(el.querySelector('[data-testid="voice-local-progress"]')).toBeNull();
  });

  test('the status query is asked to poll exactly while the install is in flight', () => {
    mockLocalStatus = { isPending: false, isError: false, isSuccess: true, data: NOT_PROVISIONED_STATUS };
    mockLocalInstall = { ...mockLocalInstall, isPending: false };
    const first = render();
    cleanup = first.unmount;
    openPopover(first.el);
    expect(lastStatusPollArg).toBe(false);
    first.unmount();
    cleanup = null;

    mockLocalInstall = { ...mockLocalInstall, isPending: true };
    const second = render();
    cleanup = second.unmount;
    openPopover(second.el);
    expect(lastStatusPollArg).toBe(true);
  });

  test('a fully-successful install lists the configured key and offers no retry button', () => {
    mockLocalStatus = { isPending: false, isError: false, isSuccess: true, data: NOT_PROVISIONED_STATUS };
    mockLocalInstall = {
      ...mockLocalInstall,
      isSuccess: true,
      data: {
        provisioned: true,
        platform: 'linux-x64',
        tts: { engine: 'piper', state: 'provisioned', binaryPath: '/x/piper', modelPath: '/x/voice.onnx' },
        stt: { engine: 'whisper-cpp', state: 'provisioned', binaryPath: '/x/whisper', modelPath: '/x/model.bin' },
        components: [],
        configured: { set: [{ key: 'tts.provider', value: 'local' }], skipped: [] },
      },
    };
    const { el, unmount } = render();
    cleanup = unmount;
    openPopover(el);
    expect(el.textContent).toContain('tts.provider');
    const retry = Array.from(el.querySelectorAll('[data-testid="voice-settings-local"] button')).find((b) => b.textContent === 'Retry');
    expect(retry).toBeUndefined();
  });

  test('a retriable engine failure (download-failed) shows the reason and a Retry action that re-invokes install', () => {
    mockLocalStatus = { isPending: false, isError: false, isSuccess: true, data: NOT_PROVISIONED_STATUS };
    mockLocalInstall = {
      ...mockLocalInstall,
      isSuccess: true,
      data: {
        provisioned: false,
        platform: 'linux-x64',
        tts: { engine: 'piper', state: 'download-failed', reason: 'network timeout fetching piper.tar.gz' },
        stt: { engine: 'whisper-cpp', state: 'not-provisioned' as never },
        components: [{ id: 'piper-engine', state: 'failed', error: 'network timeout' }],
        configured: { set: [], skipped: [] },
      },
    };
    const { el, unmount } = render();
    cleanup = unmount;
    openPopover(el);
    expect(el.textContent).toContain('network timeout fetching piper.tar.gz');
    const retry = Array.from(el.querySelectorAll('[data-testid="voice-settings-local"] button')).find((b) => b.textContent === 'Retry') as HTMLButtonElement;
    expect(retry).toBeDefined();
    flushSync(() => { retry.click(); });
    expect(localInstallMutateCalls).toBe(1);
  });

  test('a non-retriable engine failure (bundle-unavailable) shows the reason with no Retry action', () => {
    mockLocalStatus = { isPending: false, isError: false, isSuccess: true, data: NOT_PROVISIONED_STATUS };
    mockLocalInstall = {
      ...mockLocalInstall,
      isSuccess: true,
      data: {
        provisioned: false,
        platform: 'darwin-arm64',
        tts: { engine: 'piper', state: 'provisioned' },
        stt: { engine: 'whisper-cpp', state: 'bundle-unavailable', reason: 'no pinned whisper.cpp bundle exists for this platform yet' },
        components: [],
        configured: { set: [], skipped: [] },
      },
    };
    const { el, unmount } = render();
    cleanup = unmount;
    openPopover(el);
    expect(el.textContent).toContain('no pinned whisper.cpp bundle exists for this platform yet');
    const retry = Array.from(el.querySelectorAll('[data-testid="voice-settings-local"] button')).find((b) => b.textContent === 'Retry');
    expect(retry).toBeUndefined();
  });

  test('the install receipt survives the resting-state flip to provisioned (the refetch after a successful install)', () => {
    mockLocalStatus = {
      isPending: false,
      isError: false,
      isSuccess: true,
      data: {
        ...NOT_PROVISIONED_STATUS,
        state: 'provisioned',
        tts: { ...NOT_PROVISIONED_STATUS.tts, binaryPresent: true, voicePresent: true },
        stt: { ...NOT_PROVISIONED_STATUS.stt, state: 'provisioned', binaryPresent: true, modelPresent: true },
      },
    };
    mockLocalInstall = {
      ...mockLocalInstall,
      isSuccess: true,
      data: {
        provisioned: true,
        platform: 'linux-x64',
        tts: { engine: 'piper', state: 'provisioned' },
        stt: { engine: 'whisper-cpp', state: 'provisioned' },
        components: [],
        configured: { set: [{ key: 'tts.provider', value: 'local' }], skipped: [] },
      },
    };
    const { el, unmount } = render();
    cleanup = unmount;
    openPopover(el);
    // Both the fresh resting line AND the receipt are visible, the receipt never
    // vanishes the instant the invalidated status query answers.
    expect(el.textContent).toContain('tts.provider');
    const buttons = Array.from(el.querySelectorAll('[data-testid="voice-settings-local"] button')).map((b) => b.textContent);
    expect(buttons.some((t) => t?.includes('Set up local voice'))).toBe(false);
  });

  test('an install mutation error renders the formatted error text', () => {
    mockLocalStatus = { isPending: false, isError: false, isSuccess: true, data: NOT_PROVISIONED_STATUS };
    mockLocalInstall = { ...mockLocalInstall, isError: true, error: new Error('daemon unreachable') };
    const { el, unmount } = render();
    cleanup = unmount;
    openPopover(el);
    expect(el.textContent).toContain('daemon unreachable');
  });
});

/**
 * WakeChip / WakeBanner, an always-on microphone must never be invisible.
 *
 * Uses react-dom/client + flushSync + happy-dom, the same shape PowerChip.test.tsx
 * uses. The host state is mocked so every phase can be rendered without a device.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { WakeHostState } from '../../lib/voice/wake-host';

const IDLE: WakeHostState = {
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

let mockState: WakeHostState = IDLE;

mock.module('../../lib/voice/useWake', () => ({
  useWakeState: () => mockState,
}));

const { WakeChip } = await import('./WakeChip');
const { WakeBanner } = await import('./WakeBanner');

function render(element: React.ReactElement): { el: HTMLElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => { root.render(element); });
  return {
    el: container,
    unmount: () => {
      flushSync(() => { root.unmount(); });
      container.parentNode?.removeChild(container);
    },
  };
}

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
  mockState = IDLE;
});

describe('WakeChip: voice.wake.indicator "statusline"', () => {
  test('nothing is rendered when wake detection was never enabled here', () => {
    const view = render(React.createElement(WakeChip));
    cleanup = view.unmount;
    expect(view.el.querySelector('[data-testid="wake-chip"]')).toBeNull();
    // Not even an empty segment: it must not pad the strip.
    expect(view.el.textContent).toBe('');
  });

  test('nothing is rendered when the indicator row is off, even while listening', () => {
    mockState = { ...IDLE, phase: 'listening', indicator: 'off', deviceLabel: 'getUserMedia (AudioWorklet)' };
    const view = render(React.createElement(WakeChip));
    cleanup = view.unmount;
    expect(view.el.querySelector('[data-testid="wake-chip"]')).toBeNull();
  });

  test('nothing is rendered when the indicator is banner; the banner owns that', () => {
    mockState = { ...IDLE, phase: 'listening', indicator: 'banner' };
    const view = render(React.createElement(WakeChip));
    cleanup = view.unmount;
    expect(view.el.querySelector('[data-testid="wake-chip"]')).toBeNull();
  });

  test('a live microphone is visible and names its device', () => {
    mockState = {
      ...IDLE,
      phase: 'listening',
      indicator: 'statusline',
      deviceLabel: 'getUserMedia (AudioWorklet) (Built-in Microphone)',
    };
    const view = render(React.createElement(WakeChip));
    cleanup = view.unmount;
    const chip = view.el.querySelector('[data-testid="wake-chip"]');
    expect(chip).not.toBeNull();
    // The device is named in the accessible label and the tooltip, so "which
    // microphone is open" is answerable without opening settings.
    expect(chip?.getAttribute('aria-label')).toContain('Built-in Microphone');
    expect(chip?.getAttribute('title')).toContain('Built-in Microphone');
    expect(chip?.getAttribute('data-wake-phase')).toBe('listening');
  });

  test('the recording phase after a wake is still shown', () => {
    mockState = { ...IDLE, phase: 'capturing', indicator: 'statusline' };
    const view = render(React.createElement(WakeChip));
    cleanup = view.unmount;
    const chip = view.el.querySelector('[data-testid="wake-chip"]');
    expect(chip?.getAttribute('data-wake-phase')).toBe('capturing');
  });

  test('a latched detector shows the supervisor reason, not a vague failure', () => {
    mockState = {
      ...IDLE,
      phase: 'latched',
      indicator: 'statusline',
      refusal: { kind: 'blocked', detail: 'capture crashed 3 times in 60s; not restarting' },
    };
    const view = render(React.createElement(WakeChip));
    cleanup = view.unmount;
    const chip = view.el.querySelector('[data-testid="wake-chip"]');
    expect(chip?.getAttribute('title')).toContain('capture crashed 3 times in 60s');
  });

  test('a refusal the user asked for here is shown with its written reason', () => {
    mockState = {
      ...IDLE,
      phase: 'refused',
      indicator: 'statusline',
      refusal: { kind: 'model-unavailable', detail: 'The classifier model failed verification.' },
    };
    const view = render(React.createElement(WakeChip));
    cleanup = view.unmount;
    expect(view.el.querySelector('[data-testid="wake-chip"]')?.getAttribute('title'))
      .toContain('failed verification');
  });

  test('loading is visible', () => {
    mockState = { ...IDLE, phase: 'loading', indicator: 'statusline' };
    const view = render(React.createElement(WakeChip));
    cleanup = view.unmount;
    const chip = view.el.querySelector('[data-testid="wake-chip"]');
    expect(chip?.getAttribute('data-wake-phase')).toBe('loading');
  });

  test('a chip label is always accompanied by text, never colour alone', () => {
    for (const phase of ['listening', 'capturing', 'transcribing', 'restarting', 'latched', 'suspended'] as const) {
      mockState = { ...IDLE, phase, indicator: 'statusline' };
      const view = render(React.createElement(WakeChip));
      const chip = view.el.querySelector('[data-testid="wake-chip"]');
      expect((chip?.textContent ?? '').length).toBeGreaterThan(4);
      view.unmount();
    }
  });
});

describe('WakeBanner: voice.wake.indicator "banner"', () => {
  test('nothing is rendered for the statusline indicator', () => {
    mockState = { ...IDLE, phase: 'listening', indicator: 'statusline' };
    const view = render(React.createElement(WakeBanner));
    cleanup = view.unmount;
    expect(view.el.querySelector('[data-testid="wake-banner"]')).toBeNull();
  });

  test('nothing is rendered for the off indicator', () => {
    mockState = { ...IDLE, phase: 'listening', indicator: 'off' };
    const view = render(React.createElement(WakeBanner));
    cleanup = view.unmount;
    expect(view.el.querySelector('[data-testid="wake-banner"]')).toBeNull();
  });

  test('a live microphone gets a persistent status banner', () => {
    mockState = { ...IDLE, phase: 'listening', indicator: 'banner', deviceLabel: 'getUserMedia (AudioWorklet)' };
    const view = render(React.createElement(WakeBanner));
    cleanup = view.unmount;
    const banner = view.el.querySelector('[data-testid="wake-banner"]');
    expect(banner).not.toBeNull();
    // A persistent status element, not a transient toast.
    expect(banner?.getAttribute('role')).toBe('status');
  });

  test('a problem banner carries the host error', () => {
    mockState = { ...IDLE, phase: 'restarting', indicator: 'banner', error: 'the microphone stream ended' };
    const view = render(React.createElement(WakeBanner));
    cleanup = view.unmount;
    const banner = view.el.querySelector('[data-testid="wake-banner"]');
    expect(banner?.textContent).toContain('the microphone stream ended');
  });
});

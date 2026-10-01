/**
 * MicButton, the microphone capability label.
 *
 * When the mic is unavailable because the page is on an insecure origin
 * (support === 'insecure-context'), the crossed mic TOGGLES the reason bubble: hidden by
 * default (a permanent condition must not park a bubble over the composer), one tap shows
 * the DAEMON's own reason text from pairing.posture.get ("needs https, available via
 * tailscale") once it has loaded, honestly falling back to a still-true generic HTTPS
 * pointer before it answers, and a second tap hides it again. The hover title always
 * carries the reason, never a blank label, never a client-fabricated guess.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

type MicSupport = 'ok' | 'insecure-context' | 'unsupported';
let supportValue: MicSupport = 'insecure-context';
let phaseValue = 'idle';

mock.module('../../lib/voice/useVoice', () => ({
  useVoiceInput: () => ({
    support: supportValue,
    availability: { sttAvailable: true },
    phase: phaseValue,
    error: null,
    start: () => Promise.resolve(),
    stopAndTranscribe: () => Promise.resolve(),
  }),
}));

let postureCapabilities: readonly { capability: string; available: boolean; reason?: string }[] = [
  { capability: 'microphone', available: false, reason: 'needs https, available via tailscale' },
];
let posturePending = false;

mock.module('../../hooks/useOriginPosture', () => ({
  useOriginPosture: () => ({
    posture: posturePending ? undefined : { origin: 'http://192.168.0.131:3423', scheme: 'http', privateNetwork: true, secureContext: false, capabilities: postureCapabilities },
    isLoading: posturePending,
  }),
  capabilityReason: (
    posture: { capabilities: readonly { capability: string; available: boolean; reason?: string }[] } | undefined,
    capability: string,
  ) => {
    const entry = posture?.capabilities.find((c) => c.capability === capability);
    return !entry || entry.available ? undefined : entry.reason;
  },
}));

const { MicButton } = await import('./MicButton');

function render(): { el: HTMLElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(React.createElement(MicButton, { onTranscript: () => {} }));
  });
  return { el: container, unmount: () => { flushSync(() => root.unmount()); container.remove(); } };
}

function clickMic(el: HTMLElement): void {
  flushSync(() => {
    el.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

afterEach(() => {
  supportValue = 'insecure-context';
  phaseValue = 'idle';
  postureCapabilities = [{ capability: 'microphone', available: false, reason: 'needs https, available via tailscale' }];
  posturePending = false;
});

describe('MicButton capability label', () => {
  test('insecure-context: no bubble by default; the reason lives in the hover title', () => {
    const { el, unmount } = render();
    expect(el.querySelector('.voice-mic-note')).toBeNull();
    expect(el.querySelector('button')?.getAttribute('title')).toContain('needs https, available via tailscale');
    expect(el.querySelector('button')?.hasAttribute('disabled')).toBe(false);
    unmount();
  });

  test('insecure-context: tapping the crossed mic shows the daemon posture reason, tapping again hides it', () => {
    const { el, unmount } = render();
    clickMic(el);
    expect(el.textContent).toContain('needs https, available via tailscale');
    expect(el.querySelector('button')?.getAttribute('aria-expanded')).toBe('true');
    clickMic(el);
    expect(el.querySelector('.voice-mic-note')).toBeNull();
    expect(el.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
    unmount();
  });

  test('insecure-context: no daemon reason is shown while posture is loading', () => {
    posturePending = true;
    const { el, unmount } = render();
    clickMic(el);
    expect(el.querySelector('button')?.getAttribute('aria-expanded')).toBe('true');
    expect(el.textContent).not.toContain('needs https, available via tailscale');
    unmount();
  });

  test('unsupported: tapping reveals a note, never the posture reason', () => {
    supportValue = 'unsupported';
    const { el, unmount } = render();
    expect(el.querySelector('.voice-mic-note')).toBeNull();
    clickMic(el);
    expect(el.querySelector('.voice-mic-note')).not.toBeNull();
    expect(el.textContent).not.toContain('needs https, available via tailscale');
    unmount();
  });

  test('transient feedback still shows its bubble without any tap', () => {
    supportValue = 'ok';
    phaseValue = 'transcribing';
    const { el, unmount } = render();
    expect(el.querySelector('.voice-mic-note')).not.toBeNull();
    unmount();
  });

  test('ok: renders the real dictate button with no note', () => {
    supportValue = 'ok';
    const { el, unmount } = render();
    expect(el.querySelector('button')?.hasAttribute('disabled')).toBe(false);
    expect(el.querySelector('.voice-mic-note')).toBeNull();
    unmount();
  });
});

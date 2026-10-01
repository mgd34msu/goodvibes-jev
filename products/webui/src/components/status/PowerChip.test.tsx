/**
 * PowerChip, the always-visible "sleep disabled" chip. Covers both states:
 * absent (no keep-awake hold) and visible (keep-awake held, danger idiom,
 * honest lid-split note verbatim in the tooltip when served).
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

let mockData: unknown = undefined;

mock.module('../../hooks/usePowerStatus', () => ({
  usePowerStatus: () => ({ data: mockData, isPending: false, isError: false }),
}));

const { PowerChip } = await import('./PowerChip');

function render(): { el: HTMLElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => { root.render(React.createElement(PowerChip)); });
  return {
    el: container,
    unmount: () => {
      flushSync(() => { root.unmount(); });
      if (container.parentNode) container.parentNode.removeChild(container);
    },
  };
}

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
  mockData = undefined;
});

describe('PowerChip', () => {
  test('renders nothing when keepAwake is not held', () => {
    mockData = {
      platform: 'linux',
      work: { held: false, grantedClasses: [], deniedClasses: [], reasons: [], heldSince: null, capMinutes: 0, capExpiresAt: null, capExpired: false },
      keepAwake: { enabled: false, held: false, grantedClasses: [], deniedClasses: [], note: null },
    };
    const { el, unmount } = render();
    cleanup = unmount;
    expect(el.querySelector('.status-strip__segment--power')).toBeNull();
    expect(el.textContent).toBe('');
  });

  test('renders nothing when the query has not resolved yet', () => {
    mockData = undefined;
    const { el, unmount } = render();
    cleanup = unmount;
    expect(el.querySelector('.status-strip__segment--power')).toBeNull();
  });

  test('renders the danger-idiom chip when keepAwake is held', () => {
    mockData = {
      platform: 'linux',
      work: { held: false, grantedClasses: [], deniedClasses: [], reasons: [], heldSince: null, capMinutes: 0, capExpiresAt: null, capExpired: false },
      keepAwake: { enabled: true, held: true, grantedClasses: ['idle', 'sleep'], deniedClasses: [], note: null },
    };
    const { el, unmount } = render();
    cleanup = unmount;
    const chip = el.querySelector('.status-strip__segment--power');
    expect(chip).not.toBeNull();
  });

  test('the honest lid-split note renders verbatim in the tooltip when served', () => {
    const note = 'idle sleep blocked; lid-close suspend is controlled by your OS here';
    mockData = {
      platform: 'linux',
      work: { held: false, grantedClasses: [], deniedClasses: [], reasons: [], heldSince: null, capMinutes: 0, capExpiresAt: null, capExpired: false },
      keepAwake: { enabled: true, held: true, grantedClasses: ['idle', 'sleep'], deniedClasses: ['handle-lid-switch'], note },
    };
    const { el, unmount } = render();
    cleanup = unmount;
    const chip = el.querySelector('.status-strip__segment--power');
    expect(chip?.getAttribute('title')).toBe(note);
    expect(chip?.getAttribute('aria-label')).toContain(note);
  });

  test('without a served note, the tooltip states the held classes instead of fabricating wording', () => {
    mockData = {
      platform: 'linux',
      work: { held: false, grantedClasses: [], deniedClasses: [], reasons: [], heldSince: null, capMinutes: 0, capExpiresAt: null, capExpired: false },
      keepAwake: { enabled: true, held: true, grantedClasses: ['idle'], deniedClasses: [], note: null },
    };
    const { el, unmount } = render();
    cleanup = unmount;
    const chip = el.querySelector('.status-strip__segment--power');
    expect(chip?.getAttribute('title')).toContain('idle');
  });
});

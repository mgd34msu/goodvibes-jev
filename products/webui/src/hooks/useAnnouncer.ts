/**
 * useAnnouncer, renders a visually-hidden aria-live region and returns
 * an `announce` function that pushes messages to screen readers.
 *
 * Contract: `useAnnouncer()` → `announce(message, politeness?)`
 * See: docs/ux-overhaul/TOKEN-CONTRACT.md
 *
 * Architecture:
 * A module-level store (subscribe/getSnapshot) holds the current polite and
 * assertive messages. `announce()` writes to the store; `AnnouncerRegion`
 * reads it via `useSyncExternalStore`. This means:
 *
 *   1. `AnnouncerRegion` re-renders on every message regardless of where it
 *      is mounted in the tree (A11Y-101 fix).
 *   2. `AnnouncerRegion` has a STABLE component identity, same function
 *      reference across all renders, so the live-region DOM node is never
 *      unmounted/remounted (PERF-001 preserved).
 *   3. Timers are cleared before each new announce call so rapid calls
 *      cannot leak pending timeouts (A11Y-102 fix).
 */
import type React from 'react';
import { createElement, useCallback, useSyncExternalStore } from 'react';

export type AnnouncePoliteness = 'polite' | 'assertive';

export interface AnnouncerHandle {
  announce: (message: string, politeness?: AnnouncePoliteness) => void;
  /** Render this in a top-level component once per app. */
  AnnouncerRegion: React.FC;
}

// ---------------------------------------------------------------------------
// Module-level store, shared across all hook instances.
// ---------------------------------------------------------------------------

interface AnnouncerState {
  polite: string;
  assertive: string;
}

let _state: AnnouncerState = { polite: '', assertive: '' };
let _politeTimer: ReturnType<typeof setTimeout> | null = null;
let _assertiveTimer: ReturnType<typeof setTimeout> | null = null;
const _listeners = new Set<() => void>();

function _notify(): void {
  _listeners.forEach((fn) => fn());
}

function _subscribe(listener: () => void): () => void {
  _listeners.add(listener);
  return () => {
    _listeners.delete(listener);
  };
}

function _getSnapshot(): AnnouncerState {
  return _state;
}

/**
 * Write a message to the store, cycling through clear→set so the
 * live region sees a DOM mutation even when the same string repeats.
 * Clears any pending timer for the same channel first (A11Y-102).
 */
function _announce(message: string, politeness: AnnouncePoliteness): void {
  if (politeness === 'assertive') {
    if (_assertiveTimer !== null) {
      clearTimeout(_assertiveTimer);
      _assertiveTimer = null;
    }
    // Clear first so the live region sees a text change on repeat messages
    _state = { ..._state, assertive: '' };
    _notify();
    _assertiveTimer = setTimeout(() => {
      _assertiveTimer = null;
      _state = { ..._state, assertive: message };
      _notify();
    }, 50);
  } else {
    if (_politeTimer !== null) {
      clearTimeout(_politeTimer);
      _politeTimer = null;
    }
    _state = { ..._state, polite: '' };
    _notify();
    _politeTimer = setTimeout(() => {
      _politeTimer = null;
      _state = { ..._state, polite: message };
      _notify();
    }, 50);
  }
}

// ---------------------------------------------------------------------------
// Stable AnnouncerRegion component (module-level, never recreated).
// ---------------------------------------------------------------------------

/**
 * Reads messages from the module-level store via useSyncExternalStore so it
 * re-renders on every announce() call regardless of where it is mounted.
 *
 * Two sibling aria-live regions (polite + assertive) so each retains its
 * own priority without downgrade interference.
 */
function AnnouncerRegionComponent(): React.ReactElement {
  const state = useSyncExternalStore(_subscribe, _getSnapshot, _getSnapshot);
  return createElement(
    'div',
    { className: 'sr-only' },
    createElement(
      'div',
      { 'aria-live': 'polite', 'aria-atomic': 'true' },
      state.polite,
    ),
    createElement(
      'div',
      { 'aria-live': 'assertive', 'aria-atomic': 'true' },
      state.assertive,
    ),
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Hook that returns an `announce` function and a stable `AnnouncerRegion`
 * component. Mount `<AnnouncerRegion />` once near the app root; call
 * `announce` from anywhere in the tree.
 *
 * `AnnouncerRegion` has a STABLE component identity, the same function
 * reference on every render, so the live-region DOM node is never
 * unmounted/remounted between announcements.
 *
 * @example
 * const { announce, AnnouncerRegion } = useAnnouncer();
 * // In JSX tree root:
 * // <AnnouncerRegion />
 * // In handler:
 * // announce('Session saved', 'polite');
 */
export function useAnnouncer(): AnnouncerHandle {
  const announce = useCallback(
    (message: string, politeness: AnnouncePoliteness = 'polite') => {
      _announce(message, politeness);
    },
    [],
  );

  // AnnouncerRegion is the stable module-level component reference, same
  // identity on every call, guaranteed. DOM stability is handled by
  // useSyncExternalStore inside AnnouncerRegionComponent.
  return { announce, AnnouncerRegion: AnnouncerRegionComponent };
}

// ---------------------------------------------------------------------------
// Test helpers, exported for unit tests only.
// ---------------------------------------------------------------------------

/** @internal Reset module-level store state. Only for tests. */
export function _resetAnnouncerStore(): void {
  if (_politeTimer !== null) { clearTimeout(_politeTimer); _politeTimer = null; }
  if (_assertiveTimer !== null) { clearTimeout(_assertiveTimer); _assertiveTimer = null; }
  _state = { polite: '', assertive: '' };
  _listeners.forEach((fn) => fn());
}

/** @internal Direct access to the store snapshot. Only for tests. */
export { _getSnapshot as _announcerSnapshot, _subscribe as _announcerSubscribe };

import { describe, expect, test } from 'bun:test';
import { toastReducer } from './toast';

// ─── tone → role mapping ──────────────────────────────────────────────────────
// Import the REAL roleForTone exported from Toast.tsx (not a local copy).
import { roleForTone } from '../components/toast/Toast';

describe('tone → role mapping', () => {
  test('warning maps to alert', () => {
    expect(roleForTone('warning')).toBe('alert');
  });

  test('danger maps to alert', () => {
    expect(roleForTone('danger')).toBe('alert');
  });

  test('info maps to status', () => {
    expect(roleForTone('info')).toBe('status');
  });

  test('success maps to status', () => {
    expect(roleForTone('success')).toBe('status');
  });
});


// ─── Reducer: DISMISS → leavingIds → PURGE lifecycle ─────────────────────────
// Drive the REAL toastReducer state-machine directly, no DOM render harness needed.

describe('reducer: DISMISS → (leaving) → PURGE lifecycle', () => {
  test('DISMISS marks entry as leaving; PURGE removes it from both toasts and leavingIds', () => {
    // Drive the real toastReducer exported from toast.ts, no local copy.
    interface Entry { id: string; title: string; durationMs: number; tone: 'info' }

    const entry: Entry = { id: 'test-1', title: 'Hello', durationMs: 5000, tone: 'info' };
    // Cast through unknown: toastReducer is typed against ToastEntry but the
    // subset used here is structurally compatible and sufficient for this test.
    type AnyState = Parameters<typeof toastReducer>[0];
    type AnyAction = Parameters<typeof toastReducer>[1];

    let state: AnyState = { toasts: [], leavingIds: new Set<string>() };

    // ADD: entry appears in toasts, not in leavingIds
    state = toastReducer(state, { type: 'ADD', toast: entry as unknown as AnyState['toasts'][number] } as AnyAction);
    expect(state.toasts).toHaveLength(1);
    expect(state.leavingIds.size).toBe(0);

    // DISMISS: entry stays in toasts, added to leavingIds (exit animation can run)
    state = toastReducer(state, { type: 'DISMISS', id: 'test-1' });
    expect(state.toasts).toHaveLength(1);
    expect(state.leavingIds.has('test-1')).toBe(true);

    // PURGE: entry removed from both toasts and leavingIds
    state = toastReducer(state, { type: 'PURGE', id: 'test-1' });
    expect(state.toasts).toHaveLength(0);
    expect(state.leavingIds.has('test-1')).toBe(false);
  });
});

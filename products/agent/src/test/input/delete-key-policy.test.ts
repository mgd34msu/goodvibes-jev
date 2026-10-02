/**
 * Delete-key policy unit tests.
 *
 * Covers:
 *   Selection modal: 'delete' is a no-op in the end-anchored search filter
 *      (no cursor to forward-delete from); 'backspace' removes the last char.
 *      This agent has no `panels/` directory (fleet-only in the TUI, excluded
 *      per the parity matrix as INTENTIONALLY-DIFFERENT / fleet-lessness), so
 *      the TUI's isPanelSearchBackspace / planning-panel confirm-gate test
 *      groups have no equivalent surface here and are not ported.
 */
import { describe, expect, test } from 'bun:test';
import { handleSelectionModalToken } from '../../input/handler-modal-routes.ts';
import { SelectionModal } from '../../input/selection-modal.ts';

// ---------------------------------------------------------------------------
// 2. Selection modal: delete-key policy in the end-anchored search filter
// ---------------------------------------------------------------------------

describe('selection modal delete-key policy', () => {
  function makeModalState(modal: SelectionModal): {
    selectionModal: SelectionModal;
    selectionCallback: null;
    modalStack: string[];
    requestRender: () => void;
    handleEscape: () => void;
  } {
    return {
      selectionModal: modal,
      selectionCallback: null,
      modalStack: [],
      requestRender: () => {},
      handleEscape: () => {},
    };
  }

  test('backspace removes last char from search filter', () => {
    const modal = new SelectionModal();
    modal.open('Pick', [{ id: 'a', label: 'A' }], { allowSearch: true });
    modal.setQuery('abc');

    const state = makeModalState(modal);
    handleSelectionModalToken(state, { type: 'key', name: 'backspace', logicalName: 'backspace', ctrl: false, shift: false, meta: false });
    expect(modal.query).toBe('ab');
  });

  test('delete is a no-op: filter remains intact', () => {
    const modal = new SelectionModal();
    modal.open('Pick', [{ id: 'a', label: 'A' }], { allowSearch: true });
    modal.setQuery('abc');

    const state = makeModalState(modal);
    handleSelectionModalToken(state, { type: 'key', name: 'delete', logicalName: 'delete', ctrl: false, shift: false, meta: false });
    expect(modal.query).toBe('abc');
  });
});

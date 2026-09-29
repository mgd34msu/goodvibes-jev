// The permissions domain records the category the gate settled on, carried on
// DECISION_EMITTED, instead of guessing it from the tool name: a tool the
// engine does not define gets the category Jev read for the call.
import { describe, expect, test } from 'bun:test';
import { updatePermissionState } from '../sdk/src/platform/runtime/store/helpers/reducers/lifecycle.ts';
import { createInitialPermissionsState } from '../sdk/src/platform/runtime/store/domains/permissions.ts';

describe('permissions reducer: decision category', () => {
  test('lastDecision.category is the category on the event', () => {
    const state = updatePermissionState(createInitialPermissionsState(), {
      type: 'DECISION_EMITTED',
      callId: 'c1',
      tool: 'notes_sync',
      category: 'execute',
      approved: false,
      source: 'permission-manager',
    });
    expect(state.lastDecision?.category).toBe('execute');
    expect(state.lastDecision?.toolName).toBe('notes_sync');
  });

  test('a built-in tool keeps its own category', () => {
    const state = updatePermissionState(createInitialPermissionsState(), {
      type: 'DECISION_EMITTED',
      callId: 'c2',
      tool: 'write',
      category: 'write',
      approved: true,
      source: 'permission-manager',
    });
    expect(state.lastDecision?.category).toBe('write');
  });
});

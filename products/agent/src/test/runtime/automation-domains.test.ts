// Deliberately per-repo test, byte-identical to the sibling product's copy by design: the module it exercises is this repo's own and has diverged from the sibling's, so the two copies prove different code and neither can stand in for the other.
import { describe, expect, test } from 'bun:test';
import { createInitialRuntimeState } from '../../runtime/store/state.ts';

describe('automation domain foundation', () => {
  test('runtime state includes the new automation-related domains', () => {
    const state = createInitialRuntimeState();

    expect(state.automation.jobs.size).toBe(0);
    expect(state.routes.bindings.size).toBe(0);
    expect(state.controlPlane.clients.size).toBe(0);
    expect(state.deliveries.deliveryAttempts.size).toBe(0);
    expect(state.watchers.watchers.size).toBe(0);
    expect(state.surfaces.surfaces.size).toBe(0);

    const serialized = JSON.stringify(state);
    expect(serialized).toContain('"automation"');
    expect(serialized).toContain('"routes"');
    expect(serialized).toContain('"controlPlane"');
    expect(serialized).toContain('"deliveries"');
    expect(serialized).toContain('"watchers"');
    expect(serialized).toContain('"surfaces"');
  });
});

import { expect, test } from 'bun:test';
import { graphNodeStateLabel, graphNodeStateTone, isKnownGraphNodeState } from './fleet-graph';
test('unresolved repository condition is displayed as held, never done or a merge candidate', () => {
  expect(isKnownGraphNodeState('blocked-bookkeeping')).toBe(true);
  expect(graphNodeStateLabel('blocked-bookkeeping')).toBe('Held (repository condition unresolved)');
  expect(graphNodeStateTone('blocked-bookkeeping')).toBe('warning');
});

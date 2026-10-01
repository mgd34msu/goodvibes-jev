import { expect, test } from 'bun:test';
import { parsePlanningActionTarget, selectedPlanningTarget } from '../../input/commands/planning-action-target.ts';

test('selected command transport preserves opaque planning/source/question IDs and answer text', () => {
  const revision = { sourceId: 'source with spaces', generation: 'a'.repeat(64) };
  const args = [...selectedPlanningTarget('plan with spaces', revision), '2', 'First line\nSecond line'];
  const result = parsePlanningActionTarget(args);
  expect(result).toEqual({ valid: true, selected: true, planningId: 'plan with spaces', expected: { kind: 'revision', revision }, args: ['2', 'First line\nSecond line'] });
  revision.generation = 'b'.repeat(64); args[3] = revision.generation;
  if (!result.valid) throw new Error('Expected selected target');
  expect(result.expected).toEqual({ kind: 'revision', revision: { sourceId: 'source with spaces', generation: 'a'.repeat(64) } });
  expect(Object.isFrozen(result.expected)).toBe(true);
});

test('incomplete or malformed selected preconditions cannot become manual current actions', () => {
  for (const args of [[], ['plan'], ['plan', 'source'], ['plan', 'source', 'bad'], ['', 'source', 'a'.repeat(64)]]) {
    expect(parsePlanningActionTarget(['--selected-revision', ...args])).toEqual({ valid: false });
  }
});

test('explicit manual arguments choose current mode and retain the index/text tokens', () => {
  expect(parsePlanningActionTarget(['1', 'A manual answer'])).toEqual({ valid: true, selected: false, expected: { kind: 'current' }, args: ['1', 'A manual answer'] });
  expect(parsePlanningActionTarget([])).toEqual({ valid: true, selected: false, expected: { kind: 'current' }, args: [] });
});

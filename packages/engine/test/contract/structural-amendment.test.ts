import { expect, test } from 'bun:test';
import { amendedCriteria, parseAmendment } from '../../sdk/src/platform/contract/amendment.js';
import { deserializeContract, serializeContract } from '../../sdk/src/platform/contract/store.js';
import { makeContract, makeCriterion } from './fixtures.js';

test('repeating an unchanged structural root in an amendment preserves it exactly once', () => {
  const structural = makeCriterion({ id: 'c4', disposition: 'met-by-structure', status: 'met' });
  const judged = makeCriterion({ id: 'c1' });
  const target = { title: 'Review', goal: 'Review', criteria: [structural, judged], serves: false };
  const text = '```json\n' + JSON.stringify({ criteria: target.criteria.map(({ id, text }) => ({ id, text })) }) + '\n```';
  const parsed = parseAmendment(text, target, new Set());
  expect(parsed.problems).toEqual([]);
  const result = amendedCriteria(target, parsed.amendment!, '', new Set(['c4', 'c1']));
  expect(result.criteria).toEqual([structural, judged]);
  expect(result.criteria[0]).toBe(structural);
  expect(result.notes).toEqual([]);
  const changed = parseAmendment(text.replace(structural.text, 'Discard the structural obligation'), target, new Set());
  expect(changed.problems.join()).toContain('retained by structure');
});

test('loading an identical structural duplicate retains its original requirement and history', () => {
  const original = makeCriterion({ id: 'c4', disposition: 'met-by-structure', status: 'met' });
  const contract = makeContract({ criteria: [original, structuredClone(original)] });
  const loaded = deserializeContract(serializeContract(contract, 1)!)!;
  expect(loaded.criteria).toEqual([original]);
  expect(loaded.decisions.at(-1)!.reason).toContain('identical repeated structural');
  expect(deserializeContract(serializeContract(loaded, 2)!)).toEqual(loaded);
});

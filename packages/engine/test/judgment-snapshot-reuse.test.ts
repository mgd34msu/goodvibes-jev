import { expect, test } from 'bun:test';
import { captureOwnedJson, retainOwnedJson, judgmentInputProblem, JudgmentInputError } from '../sdk/src/platform/gate/judgment-input.js';
import { knowledgeRecordVersion } from '../sdk/src/platform/knowledge/store-record-representation.js';

test('only native immutable snapshots can be reused without recapture', () => {
  const source = Object.freeze({ nested: { value: 'before' } });
  const first = captureOwnedJson(source) as { nested: { value: string } };
  expect(captureOwnedJson(first)).toBe(first);
  expect(Object.isFrozen(first.nested)).toBe(true);
  source.nested.value = 'after';
  expect(captureOwnedJson(source)).toEqual({ nested: { value: 'after' } });
  expect(first.nested.value).toBe('before');
});

test('reused snapshots still receive caller restrictions and complete privacy checks', () => {
  const snapshot = captureOwnedJson({ text: ['OPENAI_API', 'KEY=synthetic-private-value'].join('_') });
  expect(() => captureOwnedJson(snapshot, () => true)).toThrow(JudgmentInputError);
  expect(judgmentInputProblem(snapshot)).toBe('credential-material');
  expect(() => retainOwnedJson(snapshot, () => true)).toThrow(JudgmentInputError);
  const retained = retainOwnedJson(snapshot);
  retained.assertCurrent();
  expect(judgmentInputProblem(retained.snapshot)).toBe('credential-material');
});

test('retention never treats a caller-frozen root as a native immutable tree', () => {
  const value = Object.freeze({ child: { text: 'before' } });
  const retained = retainOwnedJson(value);
  value.child.text = 'after';
  expect(() => retained.assertCurrent()).toThrow(JudgmentInputError);
  expect(retained.snapshot).toEqual({ child: { text: 'before' } });
});

test('combining captured roots cannot bypass the aggregate admission budget', () => {
  const left = captureOwnedJson({ text: 'a'.repeat(600_000) });
  const right = captureOwnedJson({ text: 'b'.repeat(600_000) });
  expect(() => captureOwnedJson({ left, right })).toThrow(JudgmentInputError);
});

test('record-version reuse never conceals mutable live record corrections', () => {
  const live = { metadata: { text: 'original' }, updatedAt: 1 };
  const original = captureOwnedJson(live);
  const before = knowledgeRecordVersion(original);
  expect(knowledgeRecordVersion(live)).toBe(before);
  live.metadata.text = 'corrected';
  expect(knowledgeRecordVersion(live)).not.toBe(before);
  expect(knowledgeRecordVersion(original)).toBe(before);
});

import { captureOwnedJson } from '../../gate/judgment-input.js';

/** Preserve complete evidence. Privacy admission remains the calling owner's job. */
export function completeJudgmentView<T extends object>(value: T): T {
  const snapshot = captureOwnedJson(value) as T;
  if (JSON.stringify(snapshot).length > 160_000) throw new RangeError('Complete judgment evidence exceeds the input budget.');
  return snapshot;
}

import { captureOwnedJson } from '../../gate/judgment-input.js';

/** Preserve complete evidence. Privacy admission remains the calling owner's job. */
export function completeJudgmentView<T extends object>(value: T): T {
  const snapshot = captureOwnedJson(value) as T;
  return snapshot;
}

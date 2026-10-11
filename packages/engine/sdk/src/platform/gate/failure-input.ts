import { isProxy } from 'node:util/types';
import { captureJudgmentFailureInput } from './failure-input-snapshot.js';

/** Complete, immutable failure admission with Node's proxy rejection. */
export function captureJudgmentFailure(input: unknown): unknown {
  return captureJudgmentFailureInput(input, isProxy);
}

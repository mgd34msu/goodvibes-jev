import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Completed proof logs and explicitly retained failed projects are evidence, not abandoned scratch. */
export const PROOF_RETAINED_MARKER = '.keep-proof-output';
/** Longer than the live proof deadlines, so a healthy concurrent proof stays untouched. */
export const STALE_PROOF_TMP_MS = 7 * 24 * 60 * 60 * 1000;

export function retainProofOutput(directory: string): void {
  writeFileSync(join(directory, PROOF_RETAINED_MARKER), 'This proof output was kept intentionally. Remove it when it is no longer needed.\n');
}

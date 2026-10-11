import { createHash } from 'node:crypto';
import { JudgmentInputError, snapshotJudgmentInput } from '../../gate/judgment-input.js';

/** Derivation alone grants nothing; each native owner must resolve its exact stored record. */
export function channelDraftWireReference(id: string): string {
  try {
    snapshotJudgmentInput({ draftId: id });
    return id;
  } catch (error) {
    if (!(error instanceof JudgmentInputError) || error.problem !== 'card-material') throw error;
    const digest = createHash('sha256').update(JSON.stringify(['channel-draft-reference', id])).digest('hex').slice(0, 32);
    return `draft-reference-${Array.from(digest, nibble => String.fromCharCode(97 + Number.parseInt(nibble, 16))).join('')}`;
  }
}

export function isNativeDraftWireReference(id: string): boolean {
  return /^draft-reference-[a-p]{32}$/.test(id);
}

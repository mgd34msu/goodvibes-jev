import type { EvidenceItem } from '../answer-common.js';
import type { LocalAnswerExcerptSpan } from './prepare.js';

// Only a completed local excerpt pass can mark an evidence item. The marker is
// not a caller-controlled property, a serialized store key, or a source mutation.
const selections = new WeakMap<object, readonly LocalAnswerExcerptSpan[]>();
export function registerAnswerExcerptSelection(item: EvidenceItem, spans: readonly LocalAnswerExcerptSpan[]): void {
  selections.set(item, spans);
}
export function hasAnswerExcerptSelection(item: object): boolean { return selections.has(item); }
export function answerExcerptProvenance(item: EvidenceItem): readonly LocalAnswerExcerptSpan[] { return selections.get(item) ?? []; }

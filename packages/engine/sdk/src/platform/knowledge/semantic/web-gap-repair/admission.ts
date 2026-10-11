import { checkAnswers, type JudgmentResult, type Questions } from '@goodvibes-jev/judgment';
import { sameKnowledgeRecord } from '../../store-record-representation.js';
import { assertJudgmentInput, captureOwnedJson } from '../../../gate/judgment-input.js';
import { KnowledgeWebGapRepairHeldError as Held } from './types.js';
/** Like the repair-usefulness reader, refuse hidden/lossy trees. Inspect the
 * original descriptors, not a JSON clone which has already lost those fields. */
export function captureStrictRepairJson<T>(value: T): T {
  // Reject cycles, proxies supplied by unsupported runtimes, accessors and exotic
  // prototypes before the recursive descriptor walk. No original getter is read.
  const snapshot = captureOwnedJson(value);
  const visit = (entry: unknown): void => {
    if (entry === undefined || entry === null || typeof entry !== 'object') return;
    const descriptors = Object.getOwnPropertyDescriptors(entry);
    if (Object.getOwnPropertySymbols(entry).length) throw new Held('malformed');
    if (Array.isArray(entry)) {
      if (Object.keys(entry).length !== entry.length) throw new Held('malformed');
      for (let index = 0; index < entry.length; index++) if (!Object.hasOwn(descriptors, String(index))) throw new Held('malformed');
    }
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(entry) && key === 'length') continue;
      if (!descriptor.enumerable || descriptor.get || descriptor.set) throw new Held('malformed');
      if (Array.isArray(entry) && (!Number.isInteger(Number(key)) || Number(key) < 0 || String(Number(key)) !== key || Number(key) >= entry.length)) throw new Held('malformed');
      visit(descriptor.value);
    }
  };
  visit(value); return snapshot as T;
}
export function admitRepairJson<T>(value: T): T {
  const snapshot = captureStrictRepairJson(value);
  assertJudgmentInput(snapshot); return snapshot;
}

/** Bind protocol-number admission to the complete original question schema.
 * Unknown answers/fields and every original key remain ordinary privacy data.
 * A validated unit probability is not text containing its decimal digit run.
 * The screening view marks only these exact slots as present; consumers receive
 * the original, unrounded, deeply frozen envelope, never the screening view. */
export function prepareRepairJudgmentResult(questions: Questions) {
  const schema = admitRepairJson(questions);
  const assertCurrent = () => {
    if (!sameKnowledgeRecord(captureStrictRepairJson(questions), schema)) throw new Held('stale');
  };
  return { questions: schema, assertCurrent, capture<T extends JudgmentResult<Questions>>(original: T): T {
    assertCurrent();
    const snapshot = captureStrictRepairJson(original);
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Held('malformed');
    // Use the same finite-range, offered-choice, argmax and IEEE-754 sum rules
    // as the canonical transport. Confidence is an independent statistic.
    try { checkAnswers(schema, snapshot.answers); } catch { throw new Held('malformed'); }
    const slots = new WeakMap<object, Set<string>>();
    for (const [name, question] of Object.entries(schema)) {
      const answer = snapshot.answers[name]!;
      if (question.type === 'noul') slots.set(answer, new Set(['noul']));
      else {
        slots.set(answer, new Set(['confidence']));
        const keys = question.type === 'choice' ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index));
        slots.set((answer as { probabilities: Readonly<Record<string, number>> }).probabilities, new Set(keys));
      }
    }
    const screeningView = (entry: unknown): unknown => {
      if (!entry || typeof entry !== 'object') return entry;
      if (Array.isArray(entry)) return entry.map(screeningView);
      return Object.fromEntries(Object.entries(entry).map(([key, value]) => [key,
        slots.get(entry)?.has(key) ? true : screeningView(value)]));
    };
    assertJudgmentInput(screeningView(snapshot));
    assertCurrent(); return snapshot;
  } };
}

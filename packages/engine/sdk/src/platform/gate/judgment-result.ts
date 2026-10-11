import { types as nodeTypes } from 'node:util';
import { checkAnswers, type JudgmentResult, type Questions } from '@goodvibes-jev/judgment';
import { assertJudgmentInput, captureOwnedJson, retainOwnedJson } from './judgment-input.js';

export type JudgmentResultAdmissionProblem = 'malformed' | 'stale';
export class JudgmentResultAdmissionError extends Error {
  constructor(readonly problem: JudgmentResultAdmissionProblem) {
    super(`Judgment response admission ${problem}.`); this.name = 'JudgmentResultAdmissionError';
  }
}
export type JudgmentResultAdmissionFailure = (problem: JudgmentResultAdmissionProblem) => Error;
const admissionError: JudgmentResultAdmissionFailure = problem => new JudgmentResultAdmissionError(problem);

/** Capture the complete original JSON tree without evaluating borrowed accessors. */
export function captureStrictJudgmentJson<T>(value: T, failure: JudgmentResultAdmissionFailure = admissionError): T {
  let snapshot: unknown;
  try { snapshot = captureOwnedJson(value, nodeTypes.isProxy); } catch { throw failure('malformed'); }
  assertStrictJsonShape(value, failure);
  // captureOwnedJson checked and detached every node while preserving its type.
  return snapshot as T;
}

function assertStrictJsonShape(value: unknown, failure: JudgmentResultAdmissionFailure): void {
  const visit = (entry: unknown): void => {
    if (entry === undefined || entry === null || typeof entry !== 'object') return;
    const descriptors = Object.getOwnPropertyDescriptors(entry);
    if (Object.getOwnPropertySymbols(entry).length) throw failure('malformed');
    if (Array.isArray(entry)) {
      if (Object.keys(entry).length !== entry.length) throw failure('malformed');
      for (let index = 0; index < entry.length; index++) if (!Object.hasOwn(descriptors, String(index))) throw failure('malformed');
    }
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(entry) && key === 'length') continue;
      if (!descriptor.enumerable || !('value' in descriptor)) throw failure('malformed');
      if (Array.isArray(entry) && (!Number.isInteger(Number(key)) || Number(key) < 0 || String(Number(key)) !== key || Number(key) >= entry.length)) throw failure('malformed');
      visit(descriptor.value);
    }
  };
  try { visit(value); } catch (error) {
    if (error instanceof JudgmentResultAdmissionError) throw error;
    throw failure('malformed');
  }
}

export interface RetainedStrictJudgmentJson<T> {
  readonly snapshot: T;
  readonly assertCurrent: () => void;
}

/** Complete strict admission once, followed by exact original-slot currentness. */
export function retainStrictJudgmentJson<T>(value: T, failure: JudgmentResultAdmissionFailure = admissionError): RetainedStrictJudgmentJson<T> {
  let source: ReturnType<typeof retainOwnedJson>;
  try { source = retainOwnedJson(value, nodeTypes.isProxy); }
  catch { throw failure('malformed'); }
  assertStrictJsonShape(value, failure);
  const assertCurrent = () => { try { source.assertCurrent(); } catch { throw failure('stale'); } };
  assertCurrent();
  return Object.freeze({ snapshot: source.snapshot as T, assertCurrent });
}
export function admitJudgmentJson<T>(value: T, failure: JudgmentResultAdmissionFailure = admissionError): T {
  const snapshot = captureStrictJudgmentJson(value, failure);
  assertJudgmentInput(snapshot); return snapshot;
}

/** Plain JSON equality also compares present undefined fields and array shape. */
function sameJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left), rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  const leftDescriptors = Object.getOwnPropertyDescriptors(left), rightDescriptors = Object.getOwnPropertyDescriptors(right);
  return leftKeys.every(key => Object.hasOwn(rightDescriptors, key) && sameJson(leftDescriptors[key]?.value, rightDescriptors[key]?.value));
}

/**
 * Bind admission to the untouched request schema. Only validated protocol
 * probabilities are exempt from text screening. Unknown fields remain privacy
 * data. Consumers receive the complete unrounded frozen original response.
 */
export function prepareJudgmentResult(questions: Questions, failure: JudgmentResultAdmissionFailure = admissionError) {
  const schema = admitJudgmentJson(questions, failure);
  const assertCurrent = () => {
    if (!sameJson(captureStrictJudgmentJson(questions, failure), schema)) throw failure('stale');
  };
  return { questions: schema, assertCurrent, capture<T extends JudgmentResult<Questions>>(original: T): T {
    assertCurrent();
    const snapshot = captureStrictJudgmentJson(original, failure);
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw failure('malformed');
    try { checkAnswers(schema, snapshot.answers); } catch { throw failure('malformed'); }
    const slots = new WeakMap<object, Set<string>>();
    for (const [name, question] of Object.entries(schema)) {
      const answer = snapshot.answers[name];
      if (!answer) throw failure('malformed');
      if (question.type === 'noul') slots.set(answer, new Set(['noul']));
      else {
        slots.set(answer, new Set(['confidence']));
        const probabilities = 'probabilities' in answer ? answer.probabilities : undefined;
        if (!probabilities) throw failure('malformed');
        const keys = question.type === 'choice' ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index));
        slots.set(probabilities, new Set(keys));
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

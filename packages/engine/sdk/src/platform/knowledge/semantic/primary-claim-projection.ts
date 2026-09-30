import { assertJudgmentInput, JudgmentInputError } from '../../gate/judgment-input.js';
import type { SemanticPrimaryClaim } from './primary-source-plan.js';

function fields(value: unknown): PropertyDescriptorMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new JudgmentInputError('unsupported-input');
  return Object.getOwnPropertyDescriptors(value);
}
function own(input: PropertyDescriptorMap, key: string): unknown {
  const descriptor = input[key];
  if (descriptor?.get || descriptor?.set) throw new JudgmentInputError('unsupported-input');
  return descriptor?.value;
}
function string(input: PropertyDescriptorMap, key: string, required = false): string | undefined {
  const value = own(input, key);
  if ((required && (typeof value !== 'string' || !value.trim())) || (value !== undefined && typeof value !== 'string')) throw new JudgmentInputError('unsupported-input');
  return value as string | undefined;
}
function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new JudgmentInputError('unsupported-input');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || descriptor.get || descriptor.set) throw new JudgmentInputError('unsupported-input');
    result.push(descriptor.value);
  }
  return result;
}
function subject(value: unknown) {
  const input = fields(value);
  return { id: string(input, 'id', true)!, kind: string(input, 'kind', true)!, title: string(input, 'title', true)! };
}

/** Honor the declared DTO even when structurally typed callers supply a whole record. */
export function projectSemanticPrimaryClaim(claim: SemanticPrimaryClaim) {
  const input = fields(claim);
  const hints = own(input, 'targetHints');
  const projected = {
    kind: string(input, 'kind', true)!, title: string(input, 'title', true)!,
    summary: string(input, 'summary'), value: own(input, 'value'), evidence: own(input, 'evidence'),
    subject: string(input, 'subject'),
    targetHints: hints === undefined ? undefined : array(hints).map((hint) => typeof hint === 'string' ? hint : subject(hint)),
    subjects: array(own(input, 'subjects')).map(subject),
  };
  // Scan the complete selected fields BEFORE JSON conversion, not a serialized
  // full node carrying metadata, timestamps, authority stamps or callbacks.
  assertJudgmentInput(projected);
  return structuredClone(projected);
}

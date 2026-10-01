import { KnowledgeAnswerGapHeldError as Held } from './types.js';
/** Structural IDs are exact database keys: never trim, case-fold or tokenize. */
export function exactReferences(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry)) throw new Held('malformed');
  return value as string[];
}
export function exactReference(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !value) throw new Held('malformed');
  return value;
}
export function exactIds(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => value !== undefined))];
}
export function originalText(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }

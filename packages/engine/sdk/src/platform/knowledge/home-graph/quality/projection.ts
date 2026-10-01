import type { JsonValue } from '@goodvibes-jev/judgment';
import { assertJudgmentInput, JudgmentInputError } from '../../../gate/judgment-input.js';
import type { KnowledgeNodeRecord } from '../../types.js';
import { HomeGraphQualityHeldError as Held, type HomeGraphQualityInput, type HomeGraphQualityQuestion } from './types.js';

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
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new Held('malformed');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || descriptor.get || descriptor.set) throw new JudgmentInputError('unsupported-input');
    if (typeof descriptor.value !== 'string') throw new Held('malformed');
    result.push(descriptor.value);
  }
  return result;
}
function copyStrings(target: Record<string, JsonValue>, input: PropertyDescriptorMap, keys: readonly string[]): void {
  for (const key of keys) {
    const value = own(input, key);
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') throw new Held('malformed');
    target[key] = value;
  }
}
function subject(node: KnowledgeNodeRecord): Record<string, JsonValue> {
  const input = fields(node), metadata = fields(own(input, 'metadata'));
  const result: Record<string, JsonValue> = {};
  copyStrings(result, input, ['kind', 'title', 'summary']);
  result.aliases = strings(own(input, 'aliases'));
  copyStrings(result, metadata, ['manufacturer', 'model', 'entryType', 'entry_type']);
  for (const [key, selected] of [
    ['homeAssistant', ['objectKind', 'objectId', 'entityId', 'deviceId', 'integrationId', 'domain']],
    ['attributes', ['device_class', 'friendly_name']],
  ] as const) {
    const value = own(metadata, key);
    if (value === undefined || value === null) continue;
    const projected: Record<string, JsonValue> = {};
    copyStrings(projected, fields(value), selected);
    if (Object.keys(projected).length) result[key] = projected;
  }
  return result;
}
function fact(node: KnowledgeNodeRecord, index: number): Record<string, JsonValue> {
  const input = fields(node), metadata = fields(own(input, 'metadata'));
  const result: Record<string, JsonValue> = { reference: `fact-${index + 1}` };
  copyStrings(result, input, ['title', 'summary']);
  for (const key of ['value', 'evidence']) {
    const value = own(metadata, key);
    if (value === undefined) continue;
    if (value !== null && typeof value !== 'string' && typeof value !== 'boolean'
      && !(typeof value === 'number' && Number.isFinite(value))) throw new Held('malformed');
    result[key] = value;
  }
  const labels = own(metadata, 'labels');
  if (labels !== undefined) result.labels = strings(labels);
  return result;
}
/** Declared spellings only; an unknown declaration is never silently treated as false. */
export function readHomeGraphDeclaredBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const label = value.trim().toLowerCase();
    if (['true', 'yes', '1'].includes(label)) return true;
    if (['false', 'no', '0', 'none', 'not_applicable', 'not applicable'].includes(label)) return false;
  }
  throw new Held('malformed');
}
/** Only selected meaning-bearing fields leave the process; database IDs and review metadata stay local. */
export function projectHomeGraphQualityInput(reference: string, device: KnowledgeNodeRecord,
  entities: readonly KnowledgeNodeRecord[], facts: readonly KnowledgeNodeRecord[], questions: readonly HomeGraphQualityQuestion[]): HomeGraphQualityInput {
  const projected = { reference, subject: subject(device), entities: entities.map((node, index) => ({ reference: `entity-${index + 1}`, ...subject(node) })),
    facts: facts.map(fact), questions: [...questions] };
  assertJudgmentInput(projected);
  return structuredClone(projected);
}

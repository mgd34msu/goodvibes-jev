/** Structural MCP form checks. No defaults, coercion, field invention or unchecked keywords. */
import { fromJSONSchema } from 'zod/v4';
import { snapshotJudgmentInput } from '../gate/judgment-input.js';
const rootKeys = new Set(['type', 'properties', 'required', 'additionalProperties', 'title', 'description', '$schema']);
const fieldKeys = new Set(['type', 'title', 'description', 'enum', 'enumNames', 'oneOf', 'const', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'format', 'items', 'minItems', 'maxItems', 'uniqueItems']);
const formats = new Set(['email', 'uri', 'uuid', 'date-time', 'date', 'ipv4', 'ipv6']);
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function scalar(value: unknown): boolean { return typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)); }
function inspectField(value: unknown): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).some(key => !fieldKeys.has(key))) throw new Error('Unsupported elicitation field');
  if (value.type !== undefined && !['string', 'number', 'integer', 'boolean', 'array'].includes(String(value.type))) throw new Error('Unsupported elicitation field type');
  if (value.type === undefined && value.enum === undefined && value.oneOf === undefined && !Object.hasOwn(value, 'const')) throw new Error('Unspecified elicitation field type');
  if (value.type === undefined && ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'format', 'minItems', 'maxItems', 'uniqueItems', 'items'].some(key => Object.hasOwn(value, key))) throw new Error('Constraints require an explicit field type');
  if (value.format !== undefined && (typeof value.format !== 'string' || !formats.has(value.format))) throw new Error('Unsupported elicitation format');
  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']) {
    if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || (key === 'multipleOf' && (value[key] as number) <= 0))) throw new Error('Invalid numeric constraint');
  }
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems']) {
    if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isInteger(value[key]) || (value[key] as number) < 0)) throw new Error('Invalid length constraint');
  }
  if (value.uniqueItems !== undefined && typeof value.uniqueItems !== 'boolean') throw new Error('Invalid uniqueness constraint');
  if (value.enum !== undefined && (!Array.isArray(value.enum) || value.enum.length === 0 || !value.enum.every(scalar))) throw new Error('Invalid choices');
  if (Object.hasOwn(value, 'const') && !scalar(value.const)) throw new Error('Invalid fixed choice');
  if (value.oneOf !== undefined) {
    if (!Array.isArray(value.oneOf) || value.oneOf.length === 0) throw new Error('Invalid elicitation choices');
    for (const choice of value.oneOf) inspectField(choice);
  }
  if (value.type === 'array') inspectField(value.items);
}
function matchesField(schema: Record<string, unknown>, value: unknown): boolean {
  const { enum: choices, const: fixed, oneOf, items, uniqueItems, minLength, maxLength, ...base } = schema;
  // Zod's converter handles primitive bounds but shortcuts enum/const. Apply
  // those independently so a choice can never bypass sibling constraints.
  if (!fromJSONSchema(base).safeParse(value).success) return false;
  if (typeof value === 'string') {
    const length = Array.from(value).length;
    if (typeof minLength === 'number' && length < minLength) return false;
    if (typeof maxLength === 'number' && length > maxLength) return false;
  }
  if (Array.isArray(choices) && !choices.some(choice => Object.is(choice, value))) return false;
  if (Object.hasOwn(schema, 'const') && !Object.is(fixed, value)) return false;
  if (Array.isArray(oneOf) && oneOf.filter(branch => matchesField(branch as Record<string, unknown>, value)).length !== 1) return false;
  if (Array.isArray(value)) {
    if (!object(items) || !value.every(item => matchesField(items, item))) return false;
    if (uniqueItems === true && new Set(value.map(item => JSON.stringify(item))).size !== value.length) return false;
  }
  return true;
}
export function elicitationContent(schemaInput: unknown, input: unknown): Record<string, unknown> | null {
  try {
    const schema = snapshotJudgmentInput(schemaInput);
    const content = snapshotJudgmentInput(input);
    if (!object(schema) || schema.type !== 'object' || Object.keys(schema).some(key => !rootKeys.has(key))
      || !object(schema.properties) || !object(content)) return null;
    if (Object.keys(content).some(key => !Object.hasOwn(schema.properties as object, key))) return null;
    for (const field of Object.values(schema.properties)) inspectField(field);
    if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== 'string'
      || !Object.hasOwn(schema.properties as object, key) || !Object.hasOwn(content, key)))) return null;
    for (const [key, value] of Object.entries(content)) if (!matchesField(schema.properties[key] as Record<string, unknown>, value)) return null;
    return content;
  } catch { return null; }
}

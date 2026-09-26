/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * Shared primitives for runtime event contract validation.
 */
export interface ContractResult {
  readonly valid: boolean;
  readonly violations: readonly string[];
}

const OK: ContractResult = { valid: true, violations: [] };

function fail(...messages: string[]): ContractResult {
  return { valid: false, violations: messages };
}

export function isString(v: unknown): v is string {
  return typeof v === 'string';
}

export function isNumber(v: unknown): v is number {
  return typeof v === 'number';
}

export function isBoolean(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export type FieldKind =
  | 'string'
  | 'number'
  | 'boolean'
  | 'string[]'
  | 'enum'
  | 'enum[]'
  | 'object'
  | 'object[]'
  | 'string|null';

export interface FieldSpec {
  readonly key: string;
  readonly kind: FieldKind;
  /** The allowed strings, for 'enum' and 'enum[]'. */
  readonly values?: readonly string[] | undefined;
  /** The fields of the nested object, for 'object' and each element of 'object[]'. */
  readonly fields?: readonly FieldSpec[] | undefined;
  /** When true, an absent (undefined) value passes; a present value is still checked. */
  readonly optional?: boolean | undefined;
}

function isAllowed(value: unknown, values: readonly string[] | undefined): boolean {
  return isString(value) && (values ?? []).includes(value);
}

/** Checks one object against its field specs, prefixing violations with `path`. */
function checkFields(v: Record<string, unknown>, fields: readonly FieldSpec[], path: string, violations: string[]): void {
  for (const field of fields) {
    const name = `${path}${field.key}`;
    const value = v[field.key];
    if (value === undefined && field.optional === true) continue;
    switch (field.kind) {
      case 'string':
        if (!isString(value)) violations.push(`${name} must be a string`);
        break;
      case 'number':
        if (!isNumber(value)) violations.push(`${name} must be a number`);
        break;
      case 'boolean':
        if (!isBoolean(value)) violations.push(`${name} must be a boolean`);
        break;
      case 'string[]':
        if (!Array.isArray(value) || value.some((item) => !isString(item))) {
          violations.push(`${name} must be an array of strings`);
        }
        break;
      case 'enum':
        if (!isAllowed(value, field.values)) violations.push(`${name} must be one of: ${(field.values ?? []).join(', ')}`);
        break;
      case 'enum[]':
        if (!Array.isArray(value) || value.some((item) => !isAllowed(item, field.values))) {
          violations.push(`${name} must be an array of: ${(field.values ?? []).join(', ')}`);
        }
        break;
      case 'object':
        if (!isObject(value)) violations.push(`${name} must be an object`);
        else if (field.fields) checkFields(value, field.fields, `${name}.`, violations);
        break;
      case 'object[]':
        if (!Array.isArray(value)) {
          violations.push(`${name} must be an array of objects`);
          break;
        }
        value.forEach((item, index) => {
          if (!isObject(item)) violations.push(`${name}[${index}] must be an object`);
          else if (field.fields) checkFields(item, field.fields, `${name}[${index}].`, violations);
        });
        break;
      case 'string|null':
        if (value !== null && !isString(value)) violations.push(`${name} must be a string or null`);
        break;
    }
  }
}

export function validateEventFields(type: string, v: unknown, fields: readonly FieldSpec[]): ContractResult {
  if (!isObject(v)) return fail('event must be an object');
  if (v['type'] !== type) return fail(`type must be '${type}', got ${String(v['type'])}`);

  const violations: string[] = [];
  checkFields(v, fields, '', violations);
  return violations.length ? { valid: false, violations } : OK;
}

export interface EventEnvelopeShape {
  readonly traceId: string;
  readonly sessionId: string;
  readonly timestamp: number;
  readonly source: string;
  readonly event: Record<string, unknown>;
}

export function validateEnvelope(v: unknown): ContractResult {
  if (!isObject(v)) return fail('envelope must be an object');
  const violations: string[] = [];
  if (!isString(v['traceId'])) violations.push('traceId must be a string');
  if (!isString(v['sessionId'])) violations.push('sessionId must be a string');
  if (!isNumber(v['timestamp'])) violations.push('timestamp must be a number');
  if (!isString(v['source'])) violations.push('source must be a string');
  if (!isObject(v['event'])) violations.push('event must be an object');
  return violations.length ? { valid: false, violations } : OK;
}

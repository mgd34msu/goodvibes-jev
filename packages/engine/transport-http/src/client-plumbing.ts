import type { OmitNamed, RequiredNamedKeys } from '@goodvibes-jev/engine/contracts';
import { ContractError, admitRegex, compileLegacyRegex, type RegexAdmissionOptions } from '@goodvibes-jev/engine/errors';

const MAX_SCHEMA_PATTERN_CHARS = 512;
const MAX_SCHEMA_PATTERN_INPUT_CHARS = 50_000;

/**
 * The required keys of a contract input.
 *
 * Delegates to `RequiredNamedKeys` rather than mapping over `keyof T` directly.
 * A contract input whose schema sets `additionalProperties: true` renders as
 * `Base & { readonly [key: string]: unknown }`, and `keyof` that intersection is
 * `string | number`, so a direct mapped type iterates the index keys instead of
 * the declared ones and yields `never`. That made `MethodArgs` below conclude
 * "no required fields", and hand the caller an OPTIONAL input argument, for
 * every open-envelope verb: 139 of the 443 operator methods.
 */
export type RequiredKeys<T extends object> = RequiredNamedKeys<T>;

/**
 * Maps a contract input object to the public client method argument tuple.
 * Required input fields make the first argument required; fully optional input
 * shapes keep it optional; `undefined` inputs expose only the options argument.
 */
export type MethodArgs<TInput, TOptions> =
  [TInput] extends [undefined]
    ? [input?: undefined, options?: TOptions]
    // `[TInput] extends [object]` rather than `TInput extends object`: the bare
    // form is a DISTRIBUTIVE conditional, so a union input is split and the
    // whole tail, including `RequiredKeys`, a mapped type doing one `Pick` per
    // property, is evaluated once per member. A method whose input is
    // `Base & (A | B | C)` (see method-catalog-shared.ts `branchedSchema`, used
    // by the verbs whose required set is conditional) therefore cost three full
    // passes over a thirty-property object, and with several such methods in
    // one map the operator client stopped compiling: TS2590, "union type too
    // complex to represent", at the `OperatorRemoteClient` literal.
    //
    // Nothing here wanted per-member behaviour. The question being asked is
    // "is this input an object at all", and the answer for a union is the same
    // for every member. Wrapping in a tuple asks it once, and yields one
    // argument tuple instead of a union of them, which is also the more usable
    // signature for a caller.
    : [TInput] extends [object]
      ? [RequiredKeys<TInput>] extends [never]
        ? [input?: TInput, options?: TOptions]
        : [input: TInput, options?: TOptions]
      : [input: TInput, options?: TOptions];

/**
 * Remove path-bound keys from a contract input before exposing method helpers.
 *
 * `OmitNamed` rather than `Omit<TInput, Extract<keyof TInput, TKeys>>` for the
 * same reason as `RequiredKeys` above: against an open envelope, `keyof TInput`
 * is `string | number`, so the omit removed nothing recognisable and the result
 * collapsed to the bare index signature, every remaining field, and its
 * requiredness, silently dropped from the helper's argument type.
 */
export type WithoutKeys<TInput, TKeys extends PropertyKey> =
  [TInput] extends [undefined]
    ? undefined
    : TInput extends object
      ? OmitNamed<TInput, TKeys>
      : TInput;

/**
 * Splits a generated client helper's rest tuple into input and options.
 * The tuple type already proves the argument shape; runtime work is only the
 * array-position split used by generated path helpers.
 */
export function splitClientArgs<TInput, TOptions>(
  args: readonly unknown[],
): readonly [TInput | undefined, TOptions | undefined] {
  if (args.length > 2) {
    throw new ContractError(`Contract client helper expected at most 2 arguments but received ${args.length}.`);
  }
  // drop misleading non-null assertions, args[0]/args[1] may be undefined.
  return [args[0] as TInput | undefined, args[1] as TOptions | undefined];
}

/** Convert a typed client input object into the record shape required by contract route helpers. */
export function clientInputRecord<TInput>(input: TInput | undefined): Record<string, unknown> | undefined {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined;
}

/**
 * Merge fixed path fields with the optional typed client input record.
 *
 * Fixed path fields are spread LAST so the explicit positional path parameter the
 * caller named always wins over a same-named field on the input object. The public
 * `WithoutKeys` type already strips path keys from the input for TypeScript callers,
 * but JS consumers get no such protection, without this ordering a stray
 * `{ sessionId: 'other' }` could redirect the request to a different resource id
 * than the caller positionally specified.
 */
export function mergeClientInput<TInput>(
  fixed: Record<string, unknown>,
  input: TInput | undefined,
): Record<string, unknown> {
  return {
    ...(clientInputRecord(input) ?? {}),
    ...fixed,
  };
}

export interface JsonSchemaValidationFailure {
  readonly path: string;
  readonly expected: string;
  readonly received: string;
}

/** Exact checked-in wire grammars, not a trusted-schema or safe-pattern heuristic.
 * These literals have fixed bounded repeats or a single-character linear scan.
 * Native literal evaluation preserves ECMAScript anchor/Unicode semantics.
 */
function fixedSchemaGrammar(source: string, value: string): boolean | undefined {
  if (source === '\\S') return value.trim().length > 0;
  if (source !== '^[a-f0-9]{64}$' && source !== '^[!-~][ -~]{0,255}$' && source !== '[^!-~]') return undefined;
  if (value.length > MAX_SCHEMA_PATTERN_INPUT_CHARS) throw new ContractError(`Contract schema pattern input exceeds ${MAX_SCHEMA_PATTERN_INPUT_CHARS} characters.`);
  switch (source) {
    case '^[a-f0-9]{64}$': return /^[a-f0-9]{64}$/.test(value);
    case '^[!-~][ -~]{0,255}$': return /^[!-~][ -~]{0,255}$/.test(value);
    case '[^!-~]': return /[^!-~]/.test(value);
  }
}

const MAX_SCHEMA_WALK_DEPTH = 32;

/** @deprecated Synchronous compatibility only. Production callers use firstJsonSchemaFailureAsync. */
export function firstJsonSchemaFailure(
  schema: Record<string, unknown>, value: unknown, path = '$', root: Record<string, unknown> = schema, _depth = 0,
): JsonSchemaValidationFailure | undefined {
  const walk = walkJsonSchema(schema, value, path, root, _depth);
  let next = walk.next();
  while (!next.done) next = walk.next(contractPatternMatches(compileContractPattern(next.value.source), next.value.value));
  return next.value;
}

/** One owned schema/value snapshot; no result or admission escapes this call. */
export async function firstJsonSchemaFailureAsync(
  schema: Record<string, unknown>, value: unknown,
  options: Omit<RegexAdmissionOptions, 'operation'> = {},
): Promise<JsonSchemaValidationFailure | undefined> {
  const original = JSON.stringify([schema, value]);
  const [capturedSchema, capturedValue] = structuredClone([schema, value]) as [Record<string, unknown>, unknown];
  const current = () => {
    options.signal?.throwIfAborted(); options.assertCurrent?.();
    if (JSON.stringify([schema, value]) !== original) throw new ContractError('Contract schema validation source changed while reading.');
  };
  current();
  const walk = walkJsonSchema(capturedSchema, capturedValue);
  let next = walk.next();
  // Reuse only within this exact invocation, not by source across requests.
  const handles = new Map<string, Awaited<ReturnType<typeof admitRegex>>>();
  try {
    while (!next.done) {
      current();
      const { source, value: input } = next.value;
      if (input.length > MAX_SCHEMA_PATTERN_INPUT_CHARS) throw new ContractError(`Contract schema pattern input exceeds ${MAX_SCHEMA_PATTERN_INPUT_CHARS} characters.`);
      let handle = handles.get(source);
      if (!handle) {
        handle = await admitRegex(source, '', { ...options, operation: 'contract schema pattern', maxInputChars: MAX_SCHEMA_PATTERN_INPUT_CHARS, assertCurrent: current });
        handles.set(source, handle);
      }
      const matches = await handle.test(input);
      current();
      next = walk.next(matches);
    }
    current();
    for (const handle of handles.values()) handle.assertCurrent();
    return next.value;
  } finally {
    for (const handle of handles.values()) await handle[Symbol.asyncDispose]();
  }
}

function* walkJsonSchema(
  schema: Record<string, unknown>,
  value: unknown,
  path = '$',
  root: Record<string, unknown> = schema,
  _depth = 0,
): Generator<{ source: string; value: string }, JsonSchemaValidationFailure | undefined, boolean> {
  // Guard against cyclic $ref chains.
  if (_depth >= MAX_SCHEMA_WALK_DEPTH) return undefined;
  if (typeof schema.$ref === 'string') {
    const resolved = resolveLocalSchemaRef(root, schema.$ref);
    return resolved ? yield* walkJsonSchema(resolved, value, path, root, _depth + 1) : undefined;
  }
  const excluded = schema.not;
  if (excluded === true || (excluded !== null && typeof excluded === 'object' && !Array.isArray(excluded)
    && (yield* walkJsonSchema(excluded as Record<string, unknown>, value, path, root, _depth + 1)) === undefined)) {
    return { path, expected: 'not to match the excluded schema', received: typeOfJsonValue(value) };
  }
  const allOf = readSchemaList(schema.allOf);
  for (const child of allOf) {
    const failure = yield* walkJsonSchema(child, value, path, root, _depth + 1);
    if (failure) return failure;
  }
  const anyOf = readSchemaList(schema.anyOf);
  if (anyOf.length > 0) {
    const failures: (JsonSchemaValidationFailure | undefined)[] = [];
    for (const child of anyOf) failures.push(yield* walkJsonSchema(child, value, path, root, _depth + 1));
    if (failures.every(Boolean)) return bestSchemaFailure(failures) ?? { path, expected: 'one matching schema', received: typeOfJsonValue(value) };
  }
  const oneOf = readSchemaList(schema.oneOf);
  if (oneOf.length > 0) {
    let matches = 0;
    for (const child of oneOf) if (!(yield* walkJsonSchema(child, value, path, root, _depth + 1))) matches++;
    if (matches !== 1) return { path, expected: 'exactly one matching schema', received: `${matches} matches` };
  }
  const enumValues = schema.enum;
  if (Array.isArray(enumValues) && !enumValues.some((candidate) => Object.is(candidate, value))) {
    return { path, expected: `one of ${enumValues.map(String).join(', ')}`, received: typeOfJsonValue(value) };
  }
  if ('const' in schema && !Object.is(schema.const, value)) {
    return { path, expected: JSON.stringify(schema.const), received: typeOfJsonValue(value) };
  }
  const types = readSchemaTypes(schema.type);
  if (types.length > 0 && !types.some((type) => valueMatchesJsonType(value, type))) {
    return { path, expected: types.join(' | '), received: typeOfJsonValue(value) };
  }
  const minimum = typeof schema.minimum === 'number' ? schema.minimum : undefined;
  if (typeof value === 'number' && minimum !== undefined && value < minimum) {
    return { path, expected: `>= ${minimum}`, received: String(value) };
  }
  const maximum = typeof schema.maximum === 'number' ? schema.maximum : undefined;
  if (typeof value === 'number' && maximum !== undefined && value > maximum) {
    return { path, expected: `<= ${maximum}`, received: String(value) };
  }
  const minLength = typeof schema.minLength === 'number' ? schema.minLength : undefined;
  const maxLength = typeof schema.maxLength === 'number' ? schema.maxLength : undefined;
  // JSON Schema lengths count Unicode code points, as the canonical Jev parser
  // does for summaries, rather than UTF-16 code units.
  let stringLength = 0;
  if (typeof value === 'string' && (minLength !== undefined || maxLength !== undefined)) {
    for (const _character of value) stringLength += 1;
  }
  if (typeof value === 'string' && minLength !== undefined && stringLength < minLength) {
    return { path, expected: `length >= ${minLength}`, received: `length ${stringLength}` };
  }
  if (typeof value === 'string' && maxLength !== undefined && stringLength > maxLength) {
    return { path, expected: `length <= ${maxLength}`, received: `length ${stringLength}` };
  }
  if (typeof value === 'string' && typeof schema.pattern === 'string') {
    // The canonical nonblank-text pattern has a bounded linear equivalent.
    // Native goals have no length ceiling; do not send them through the generic
    // regex input guard or relax that guard for arbitrary expressions.
    const matches = fixedSchemaGrammar(schema.pattern, value) ?? (yield { source: schema.pattern, value });
    if (!matches) return { path, expected: `pattern ${schema.pattern}`, received: 'non-matching string' };
  }
  if (typeof value === 'string' && typeof schema.format === 'string' && !stringMatchesJsonSchemaFormat(value, schema.format)) {
    return { path, expected: `format ${schema.format}`, received: 'non-matching string' };
  }
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    const itemSchema = schema.items;
    if (itemSchema && typeof itemSchema === 'object' && !Array.isArray(itemSchema)) {
      for (let index = 0; index < value.length; index++) {
        // pass _depth + 1 so depth-reset through array items is prevented.
        const failure = yield* walkJsonSchema(itemSchema as Record<string, unknown>, value[index], `${path}[${index}]`, root, _depth + 1);
        if (failure) return failure;
      }
    }
    const minItems = typeof schema.minItems === 'number' ? schema.minItems : undefined;
    if (minItems !== undefined && value.length < minItems) return { path, expected: `items >= ${minItems}`, received: `${value.length} items` };
    const maxItems = typeof schema.maxItems === 'number' ? schema.maxItems : undefined;
    if (maxItems !== undefined && value.length > maxItems) return { path, expected: `items <= ${maxItems}`, received: `${value.length} items` };
    if (schema.uniqueItems === true) {
      const seen = new Set<string>();
      for (const item of value) {
        let key: string | undefined;
        try {
          // JSON object member order is irrelevant; array order and primitive
          // types remain significant. Wire values are JSON, never live objects.
          key = JSON.stringify(item, (_key: string, current: unknown) => current !== null
            && typeof current === 'object' && !Array.isArray(current)
            ? Object.fromEntries(Object.entries(current).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
            : current);
        } catch {
          return { path, expected: 'JSON values for unique items', received: 'unserializable value' };
        }
        if (key === undefined) return { path, expected: 'JSON values for unique items', received: typeOfJsonValue(item) };
        if (seen.has(key)) return { path, expected: 'unique items', received: 'duplicate item' };
        seen.add(key);
      }
    }
    return undefined;
  }
  if (typeof value === 'object') {
    const objectValue = value as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? schema.required.filter((entry): entry is string => typeof entry === 'string') : [];
    for (const key of required) {
      if (!(key in objectValue)) return { path: `${path}.${key}`, expected: 'required field', received: 'missing' };
    }
    const properties = schema.properties;
    if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
      for (const [key, propertySchema] of Object.entries(properties as Record<string, unknown>)) {
        if (!(key in objectValue)) continue;
        if (!propertySchema || typeof propertySchema !== 'object' || Array.isArray(propertySchema)) continue;
        // pass _depth + 1 so nested property recursion respects the walk depth limit.
        const failure = yield* walkJsonSchema(propertySchema as Record<string, unknown>, objectValue[key], `${path}.${key}`, root, _depth + 1);
        if (failure) return failure;
      }
    }
    const additional = schema.additionalProperties;
    const declared = properties !== null && typeof properties === 'object' && !Array.isArray(properties)
      ? new Set(Object.keys(properties)) : new Set<string>();
    for (const key of Object.keys(objectValue)) {
      if (declared.has(key)) continue;
      if (additional === false) return { path: `${path}.${key}`, expected: 'no additional property', received: 'present' };
      if (additional !== null && typeof additional === 'object' && !Array.isArray(additional)) {
        const failure = yield* walkJsonSchema(additional as Record<string, unknown>, objectValue[key], `${path}.${key}`, root, _depth + 1);
        if (failure) return failure;
      }
    }
  }
  return undefined;
}

function resolveLocalSchemaRef(root: Record<string, unknown>, ref: string): Record<string, unknown> | undefined {
  if (!ref.startsWith('#/')) return undefined;
  let current: unknown = root;
  for (const token of ref.slice(2).split('/')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
    current = (current as Record<string, unknown>)[key];
  }
  return current && typeof current === 'object' && !Array.isArray(current)
    ? current as Record<string, unknown>
    : undefined;
}

function bestSchemaFailure(failures: readonly (JsonSchemaValidationFailure | undefined)[]): JsonSchemaValidationFailure | undefined {
  return failures
    .filter((failure): failure is JsonSchemaValidationFailure => Boolean(failure))
    .sort((left, right) => right.path.length - left.path.length)[0];
}

function readSchemaList(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)));
}

function readSchemaTypes(type: unknown): string[] {
  if (typeof type === 'string') return [type];
  if (Array.isArray(type)) return type.filter((entry): entry is string => typeof entry === 'string');
  return [];
}

function compileContractPattern(source: string): RegExp {
  if (source.length > MAX_SCHEMA_PATTERN_CHARS) {
    throw new ContractError(`Contract schema pattern exceeds ${MAX_SCHEMA_PATTERN_CHARS} characters.`);
  }
  try { return compileLegacyRegex(source, '', { operation: 'contract schema pattern' }, true); }
  catch (error) { if (error instanceof SyntaxError) throw error; throw new ContractError('Contract schema pattern is too expensive to evaluate safely.'); }
}

function contractPatternMatches(pattern: RegExp, value: string): boolean {
  if (value.length > MAX_SCHEMA_PATTERN_INPUT_CHARS) {
    throw new ContractError(`Contract schema pattern input exceeds ${MAX_SCHEMA_PATTERN_INPUT_CHARS} characters.`);
  }
  pattern.lastIndex = 0;
  return pattern.test(value);
}

function valueMatchesJsonType(value: unknown, type: string): boolean {
  switch (type) {
    case 'null': return value === null;
    case 'array': return Array.isArray(value);
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'integer': return Number.isInteger(value);
    case 'number': return typeof value === 'number';
    case 'string': return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    default: return true;
  }
}

function stringMatchesJsonSchemaFormat(value: string, format: string): boolean {
  switch (format) {
    case 'date-time':
      // JSON Schema date-time requires a full date/time separator; Date.parse
      // alone accepts date-only strings in some runtimes.
      return /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)
        && !Number.isNaN(Date.parse(value));
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`));
    case 'time':
      return /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/.test(value);
    case 'duration':
      return /^P(?!$)(?:\d+Y)?(?:\d+M)?(?:\d+W)?(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$/.test(value);
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    case 'hostname':
      return isValidHostname(value);
    case 'ipv4':
      return isValidIpv4(value);
    case 'ipv6':
      return isValidIpv6(value);
    case 'uri':
    case 'url':
      return isValidUrl(value);
    case 'uuid':
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
    default:
      return true;
  }
}

function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function isValidHostname(value: string): boolean {
  if (value.length === 0 || value.length > 253) return false;
  return value.split('.').every((label) => (
    label.length > 0
    && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
  ));
}

function isValidIpv4(value: string): boolean {
  const parts = value.split('.');
  return parts.length === 4 && parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    if (part.length > 1 && part.startsWith('0')) return false;
    const value = Number(part);
    return value >= 0 && value <= 255;
  });
}

function isValidIpv6(value: string): boolean {
  try {
    new URL(`http://[${value}]`);
    return true;
  } catch {
    return false;
  }
}

function typeOfJsonValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

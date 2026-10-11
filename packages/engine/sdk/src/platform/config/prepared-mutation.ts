/** Data-only substrate for ConfigManager's same-owner settings mutation. No grants. */
import { ConfigError } from '../types/errors.js';
import type { ConfigKey, ConfigSetting } from './schema.js';
import { coerceSchemaValue } from './manager-bootstrap.js';

declare const mutationBrand: unique symbol;
declare const transitionBrand: unique symbol;
export interface PreparedConfigMutation { readonly [mutationBrand]: true; }
export interface PreparedConfigMutationTransition { readonly [transitionBrand]: true; }
export type PreparedConfigMutationRequest =
  | { readonly operation: 'set'; readonly key: ConfigKey; readonly value: unknown }
  | { readonly operation: 'reset'; readonly key: ConfigKey; readonly value?: never };
export interface PreparedConfigMutationDestination {
  readonly path: string;
  readonly operation: 'set' | 'remove';
  readonly tier: 'global' | 'project' | 'daemon' | 'shared';
}
/** Values are private substrate data, not automatically safe journal/judgment evidence. */
export interface PreparedConfigMutationFacts {
  readonly operation: 'set' | 'reset';
  readonly key: ConfigKey;
  readonly value: unknown;
  /** Ordered possible setting-file effects; absent tier removals remain no-ops. */
  readonly destinations: readonly PreparedConfigMutationDestination[];
  readonly incarnation: number;
  /** Full ordered plan, present only for a same-owner compound mutation. */
  readonly effects?: readonly PreparedConfigMutationFacts[];
}
export interface PreparedConfigMutationTransitionFacts {
  readonly beforeIncarnation: number;
  readonly afterIncarnation: number;
}
export interface PreparedConfigMutationReceipt {
  readonly status: 'committed' | 'partial' | 'unknown';
  /** Setting files whose atomic replacement completed, in publication order. */
  readonly completedPaths: readonly string[];
  /** The failed publication, whose effect is not claimed to have rolled back. */
  readonly uncertainPath?: string;
}

export interface PreparedMutationRecord {
  readonly facts: PreparedConfigMutationFacts;
  readonly schemaIdentity: object;
  readonly schemaSignature: string;
  readonly validator: ConfigSetting['validate'];
  readonly normalizedJson: string;
  readonly steps?: readonly PreparedConfigMutation[];
  phase: 'prepared' | 'beginning' | 'begun' | 'committing' | 'spent';
  transition?: PreparedConfigMutationTransition;
}

/** Only JSON-shaped detached values reach the callback-free publication tail. */
export function freezePreparedData<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezePreparedData(child);
    Object.freeze(value);
  }
  return value;
}

export function preparedSchemaSignature(schema: Omit<ConfigSetting, 'key'>): string {
  return JSON.stringify({ type: schema.type, default: schema.default, description: schema.description,
    enumValues: schema.enumValues, validationHint: schema.validationHint, unit: schema.unit });
}

/** Validate against the captured schema, without ever giving a callback our stored value. */
export function normalizePreparedValue(key: ConfigKey, schema: Omit<ConfigSetting, 'key'>, value: unknown): unknown {
  try {
    const coerced = structuredClone(coerceSchemaValue(key, schema, value));
    const serialized = JSON.stringify(coerced);
    if (serialized === undefined) throw new Error('Value is not JSON');
    const next: unknown = JSON.parse(serialized);
    const validType = schema.type === 'enum' ? typeof next === 'string' && schema.enumValues?.includes(next)
      : schema.type === 'object' ? next !== null && typeof next === 'object'
        : typeof next === schema.type && (schema.type !== 'number' || (typeof next === 'number' && Number.isFinite(next)));
    if (!validType) throw new Error('Invalid setting type');
    if (schema.validate && !schema.validate(freezePreparedData(structuredClone(next)))) throw new Error('Invalid setting value');
    return freezePreparedData(next);
  } catch {
    // Never include the proposed value or borrowed validator error in a refusal.
    throw new ConfigError(`Invalid prepared value for setting ${key}.`);
  }
}

import { validEndpointURL } from '@goodvibes-jev/judgment/decisions';
import type { JudgmentFallbackSettings } from './schema-types-judgment.js';

const FIELDS = ['endpoint', 'model', 'keySource', 'keyName'];

function isFallback(value: unknown): value is JudgmentFallbackSettings {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== FIELDS.length || keys.some(key => typeof key !== 'string' || !FIELDS.includes(key))) return false;
  if (keys.some(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !descriptor?.enumerable || !('value' in descriptor);
  })) return false;
  if (!('endpoint' in value) || typeof value.endpoint !== 'string' || !validEndpointURL(value.endpoint)
    || !('model' in value) || typeof value.model !== 'string' || !value.model.trim() || value.model.length > 200 || /\s/.test(value.model)
    || !('keySource' in value) || (value.keySource !== 'env' && value.keySource !== 'secret')
    || !('keyName' in value) || typeof value.keyName !== 'string') return false;
  return value.keySource === 'env'
    ? /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value.keyName)
    : /^[A-Za-z0-9][A-Za-z0-9_./:-]{0,255}$/.test(value.keyName);
}

/** Validate and detach persisted inputs without invoking accessors or toJSON. */
export function captureJudgmentFallbackSettings(value: unknown): readonly JudgmentFallbackSettings[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || Reflect.ownKeys(value).length !== value.length + 1) throw new Error('Invalid judgment fallback settings');
  const result: JudgmentFallbackSettings[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    const entry: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined;
    if (!descriptor?.enumerable || !isFallback(entry)) throw new Error('Invalid judgment fallback settings');
    result.push(Object.freeze({ endpoint: entry.endpoint, model: entry.model, keySource: entry.keySource, keyName: entry.keyName }));
  }
  return Object.freeze(result);
}

export function validJudgmentFallbackSettings(value: unknown): boolean {
  if (value === undefined) return false;
  try { captureJudgmentFallbackSettings(value); return true; }
  catch { return false; }
}

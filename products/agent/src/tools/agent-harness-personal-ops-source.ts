import { isDeepStrictEqual } from 'node:util';
import { redactStructuredDataAsync } from '@goodvibes-jev/engine/sdk/platform/utils';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { captureCatalogData, captureCatalogMethods, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import type { EntryType, JsonValue } from '@goodvibes-jev/judgment/decisions';

/** Hidden producer data is still semantic source; serialization cannot omit it. */
export function capturePersonalOpsData(value: unknown): unknown {
  const captured = captureCatalogData(value);
  let nodes = 0, characters = 0;
  const visit = (entry: unknown): unknown => {
    if (++nodes > 20_000) throw new ToolInputProjectionError('invalid');
    if (typeof entry === 'string') { characters += entry.length; if (characters > 1_000_000) throw new ToolInputProjectionError('invalid'); }
    if (!entry || typeof entry !== 'object') return entry;
    const descriptors = Object.getOwnPropertyDescriptors(entry);
    if (Array.isArray(entry)) {
      if (Object.keys(descriptors).length !== entry.length + 1 || Object.keys(descriptors).some(key => key !== 'length'
        && (!Number.isSafeInteger(Number(key)) || String(Number(key)) !== key || Number(key) < 0 || Number(key) >= entry.length))) throw new ToolInputProjectionError('invalid');
      return entry.map(visit);
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      characters += key.length; if (characters > 1_000_000) throw new ToolInputProjectionError('invalid');
      Object.defineProperty(result, key, { value: visit(descriptor.value), enumerable: true });
    }
    return result;
  };
  return visit(captured);
}

export function assertPersonalOpsDataCurrent(value: unknown, captured: unknown): void {
  if (!isDeepStrictEqual(capturePersonalOpsData(value), captured)) throw new ToolInputProjectionError('held');
}

/** JSON normalization follows serialization grammar after descriptor-safe capture. */
export function personalOpsJson(value: unknown): JsonValue {
  const captured = capturePersonalOpsData(value);
  const visit = (entry: unknown): JsonValue => {
    if (entry === undefined || entry === null) return null;
    if (typeof entry === 'string' || typeof entry === 'boolean' || typeof entry === 'number') return entry;
    if (Array.isArray(entry)) return entry.map(visit);
    if (typeof entry !== 'object') throw new ToolInputProjectionError('invalid');
    const result: Record<string, JsonValue> = Object.create(null);
    for (const [key, child] of Object.entries(entry)) {
      if (child === undefined) continue;
      Object.defineProperty(result, key, { value: visit(child), enumerable: true });
    }
    return result;
  };
  return visit(captured);
}

/** Entry grammar excludes bare numeric and boolean roots. */
export function personalOpsEntry(value: unknown): EntryType {
  const entry = personalOpsJson(value);
  return typeof entry === 'boolean' || typeof entry === 'number' ? { value: entry } : entry;
}

/** Native producer facts remain local until the complete DTO is protected. */
export async function protectPersonalOpsData(value: unknown, options: CatalogRankingOptions = {}): Promise<unknown> {
  const captured = capturePersonalOpsData(value);
  const optionsCurrent = captureCatalogMethods(options, ['signal', 'sourceOwner', 'assertCurrent', 'retainCurrent']);
  const signal = options.signal, callerCurrent = options.assertCurrent, retainCurrent = options.retainCurrent;
  const assertSource = () => {
    optionsCurrent();
    if (options.signal !== signal || options.assertCurrent !== callerCurrent || options.retainCurrent !== retainCurrent) throw new ToolInputProjectionError('held');
    signal?.throwIfAborted();
    assertPersonalOpsDataCurrent(value, captured);
  };
  const assertCurrent = () => {
    assertSource();
    const result: unknown = callerCurrent?.();
    if (result !== undefined) { void Promise.resolve(result).catch(() => {}); throw new ToolInputProjectionError('held'); }
    assertSource();
  };
  assertCurrent();
  const result = await redactStructuredDataAsync(captured, { signal: options.signal, assertCurrent });
  const preserveFacts = (original: unknown, protectedValue: unknown): void => {
    if (typeof original === 'boolean' || typeof original === 'number' || original === null) {
      if (original !== protectedValue) throw new ToolInputProjectionError('held');
      return;
    }
    if (!original || typeof original !== 'object') return;
    if (!protectedValue || typeof protectedValue !== 'object' || Array.isArray(original) !== Array.isArray(protectedValue)) throw new ToolInputProjectionError('held');
    const descriptors = Object.getOwnPropertyDescriptors(protectedValue);
    for (const [key, child] of Object.entries(original)) {
      const descriptor = descriptors[key];
      // Opaque private object keys cannot establish a native producer fact.
      if (!descriptor || !('value' in descriptor)) throw new ToolInputProjectionError('held');
      preserveFacts(child, descriptor.value);
    }
  };
  preserveFacts(captured, result);
  assertCurrent(); retainCurrent?.(assertSource); assertCurrent(); return result;
}

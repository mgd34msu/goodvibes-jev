import { captureOwnedJson, JudgmentInputError } from '../gate/judgment-input.js';

/** Representation evidence only, never permission to publish. Entries are issued
 * by actual writers/SQL decoders and bind complete object values. JSON copies,
 * replacements and caller-created lookalikes cannot mint this evidence. */
const representations = new WeakMap<object, { readonly version: string; readonly raw: unknown }>();
function version(value: unknown): string {
  const encode = (item: unknown): unknown => {
    if (item === undefined) return ['undefined'];
    if (item === null) return ['null'];
    if (typeof item !== 'object') return [typeof item, typeof item === 'number' && Object.is(item, -0) ? '-0' : item];
    const entries = Object.entries(Object.getOwnPropertyDescriptors(item))
      .filter(([key]) => !Array.isArray(item) || key !== 'length')
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, descriptor]) => [key, encode(descriptor.value)]);
    return Array.isArray(item) ? ['array', item.length, entries] : ['object', entries];
  };
  return JSON.stringify(encode(captureOwnedJson(value)));
}
export function sameKnowledgeRecord(left: unknown, right: unknown): boolean { return version(left) === version(right); }
function known(value: unknown): unknown | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const entry = representations.get(value);
  if (!entry) return undefined;
  try { return entry.version === version(value) ? entry.raw : undefined; } catch { return undefined; }
}
/** Bind decoder/writer-created numeric views to their exact canonical originals.
 * This is internal transport; callers of public replacement APIs never use it. */
export function retainKnowledgeRepresentation<T>(view: T, raw: unknown): T {
  if (view && typeof view === 'object') representations.delete(view);
  let captured: unknown;
  // A legacy hydration may contain malformed numbers. Do not broaden at-rest
  // rejection; it receives no representation proof and semantic admission holds.
  try { captured = captureOwnedJson(raw); version(view); } catch { return view; }
  const bind = (value: unknown, original: unknown): void => {
    if (!value || typeof value !== 'object') return;
    representations.set(value, { version: version(value), raw: original });
    if (original && typeof original === 'object') for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if ((Array.isArray(value) ? key !== 'length' : descriptor.enumerable) && Object.hasOwn(original, key)) bind(descriptor.value, (original as Record<string, unknown>)[key]);
    }
  };
  bind(view, captured);
  return view;
}
/** Never converts a primitive based on its name, type, magnitude or value. */
export function knowledgeRawRepresentation<T>(value: T): T {
  // Ordinary persistence is not a new privacy admission point. Inspect only data
  // descriptors; preserve unsupported subtrees (including their old toJSON/getter
  // serialization behavior) without evaluating them or acquiring proof.
  const copied = new WeakMap<object, object>();
  const visit = (item: unknown, depth: number): unknown => {
    const saved = known(item);
    if (saved !== undefined) return captureOwnedJson(saved);
    if (!item || typeof item !== 'object' || depth > 64) return item;
    if (copied.has(item)) return copied.get(item);
    const array = Array.isArray(item), prototype = Object.getPrototypeOf(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if ((array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
      || Object.getOwnPropertySymbols(descriptors).length
      || Object.values(descriptors).some(descriptor => !('value' in descriptor) || typeof descriptor.value === 'function')) return item;
    const result: object = array ? new Array(descriptors.length!.value as number) : Object.create(null);
    copied.set(item, result);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (array ? key === 'length' : !descriptor.enumerable) continue;
      Object.defineProperty(result, key, { value: visit(descriptor.value, depth + 1), enumerable: true, configurable: true, writable: true });
    }
    return result;
  };
  return visit(value, 0) as T;
}
/** Existing node retention has JSON-value normalization (unset object fields and
 * empty array slots). Keep it without discarding named array data. The complete
 * newly retained value, rather than its pre-normalized caller, gets a pair. */
export function normalizeKnowledgeStoredView<T>(value: T): T {
  let captured: unknown;
  try { captured = captureOwnedJson(value); } catch { return JSON.parse(JSON.stringify(value)) as T; }
  const visit = (item: unknown): unknown => {
    if (!item || typeof item !== 'object') return item;
    const array = Array.isArray(item), result: object = array ? new Array(item.length).fill(null) : {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
      if (array && key === 'length') continue;
      const index = Number(key), indexed = array && Number.isInteger(index) && index >= 0 && String(index) === key && index < item.length;
      if (!array && descriptor.value === undefined) continue;
      Object.defineProperty(result, key, { value: indexed && descriptor.value === undefined ? null : visit(descriptor.value), enumerable: true, configurable: true, writable: true });
    }
    return result;
  };
  return visit(captured) as T;
}
/** Normalize the owned fresh/cache view to the existing persisted JSON value
 * semantics while preserving named array data for complete original admission.
 * Unsupported ordinary inputs remain unchanged, without a new proof. */
export function retainKnowledgePreparedRecord<T>(record: T): T {
  try { captureOwnedJson(record); } catch { return record; }
  return retainKnowledgeRepresentation(normalizeKnowledgeStoredView(record), normalizeKnowledgeStoredView(knowledgeRawRepresentation(record)));
}
/** Lossless successor to the import path's old snapshotNodeInput clone. Keep its
 * nonfinite-number preservation for downstream existing checks, but visit every
 * own array field rather than dropping caller extras with Array.map. */
export function captureKnowledgeStoreInput<T>(input: T): T {
  let nodes = 0, chars = 0;
  const ancestors = new Set<object>();
  const fail = (): never => { throw new JudgmentInputError('unsupported-input'); };
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > 20_000 || depth > 64) return fail();
    if (typeof value === 'string') { chars += value.length; return chars > 1_000_000 ? fail() : value; }
    if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value !== 'object' || ancestors.has(value)) return fail();
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value), descriptors = Object.getOwnPropertyDescriptors(value);
    if ((array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
      || Object.getOwnPropertySymbols(descriptors).length || Object.values(descriptors).some(item => !('value' in item))) return fail();
    const length = array ? descriptors.length!.value as number : 0;
    if (length > 20_000) return fail();
    if (array) for (let index = 0; index < length; index++) if (!Object.hasOwn(descriptors, String(index))) return fail();
    const output: object = array ? new Array(length) : {};
    ancestors.add(value);
    try {
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (array ? key === 'length' : !descriptor.enumerable) continue;
        Object.defineProperty(output, key, { value: visit(descriptor.value, depth + 1), enumerable: true });
      }
      return Object.freeze(output);
    } finally { ancestors.delete(value); }
  };
  return visit(input, 0) as T;
}
export function copyKnowledgeRepresentation<T>(original: T, copy: T): T {
  let unchanged: boolean;
  try { unchanged = sameKnowledgeRecord(original, copy); } catch { return copy; }
  if (!unchanged) throw new TypeError('Knowledge representation copy changed');
  return retainKnowledgeRepresentation(copy, knowledgeRawRepresentation(original));
}
export function knowledgeClockIso(value: number): string {
  if (!Number.isSafeInteger(value) || Math.abs(value) > 8_640_000_000_000_000) throw new TypeError('Invalid knowledge clock');
  return new Date(value).toISOString();
}
export function isKnowledgeClock(value: unknown): boolean {
  if (typeof value === 'number') return Number.isSafeInteger(value) && Math.abs(value) <= 8_640_000_000_000_000;
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && Math.abs(parsed) <= 8_640_000_000_000_000 && new Date(parsed).toISOString() === value;
}
/** General hydration stays compatible. Semantic admission validates originals. */
export function knowledgeClockNumber(value: unknown): number {
  return typeof value === 'string' && isKnowledgeClock(value) ? Date.parse(value) : Number(value);
}
/** Only an actual prepare operation invokes this at fresh clock creation. */
export function prepareKnowledgeOwnedClocks<T extends { readonly createdAt: number; readonly updatedAt: number }>(record: T, existing: T | null | undefined, now: number): T {
  if (record.updatedAt !== now || (existing ? !Object.is(record.createdAt, existing.createdAt) : record.createdAt !== now)) throw new TypeError('Owned knowledge clocks do not match their writer');
  const raw = knowledgeRawRepresentation(record);
  const old = existing ? knowledgeRawRepresentation(existing) : undefined;
  return retainKnowledgeRepresentation(record, { ...raw,
    createdAt: existing ? old!.createdAt : knowledgeClockIso(now), updatedAt: knowledgeClockIso(now) });
}
/** Carry already-owned top-level clocks over a producer's explicit record edit.
 * New content, including unknown metadata, is retained in full. */
export function carryKnowledgeRecordClocks<T extends { readonly createdAt: number; readonly updatedAt: number }>(origin: T, record: T): T {
  const prior = known(origin) as T | undefined;
  const raw = knowledgeRawRepresentation(record);
  return retainKnowledgeRepresentation(record, prior ? { ...raw,
    createdAt: record.createdAt === origin.createdAt ? prior.createdAt : raw.createdAt,
    updatedAt: record.updatedAt === origin.updatedAt ? prior.updatedAt : raw.updatedAt } : raw);
}
/** These constructors own the stamps; existing/caller numeric metadata is never
 * rewritten merely because it uses these same property names. */
export function knowledgeDecisionStamp<T extends Record<string, unknown>>(now: number, fields: T): T & { decidedAt: number } {
  const view = { ...fields, decidedAt: now };
  return retainKnowledgeRepresentation(view, { ...fields, decidedAt: knowledgeClockIso(now) });
}
export function knowledgeReviewStamp<T extends Record<string, unknown>>(now: number, fields: T): T & { reviewedAt: number } {
  const view = { ...fields, reviewedAt: now };
  return retainKnowledgeRepresentation(view, { ...fields, reviewedAt: knowledgeClockIso(now) });
}
/** Exact canonical metadata is decoded only for the compatibility view. Raw SQL
 * remains the admission source; arbitrary numeric metadata stays numeric. */
function metadataClockView(raw: Record<string, unknown>, container: string | undefined, field: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const descriptors = Object.getOwnPropertyDescriptors(raw), child = container === undefined ? raw : descriptors[container]?.value;
  if (!child || typeof child !== 'object' || Array.isArray(child)) return raw;
  const fields = Object.getOwnPropertyDescriptors(child), clock = fields[field]?.value;
  // Decoder-only immutable projection. Do not invoke accessors or impose the
  // semantic capture budget on ordinary legacy hydration/writes.
  if ([...Object.values(descriptors), ...Object.values(fields)].some(item => !('value' in item))
    || typeof clock !== 'string' || !isKnowledgeClock(clock)) return raw;
  const view = retainKnowledgeRepresentation(container === undefined
    ? { ...raw, [field]: knowledgeClockNumber(clock) }
    : { ...raw, [container]: { ...child, [field]: knowledgeClockNumber(clock) } }, raw);
  return known(view) === undefined ? raw : view;
}
export function knowledgeNodeMetadataView(raw: Record<string, unknown>): Record<string, unknown> {
  const decision = metadataClockView(raw, 'reviewProvenance', 'decidedAt');
  let view = metadataClockView(decision, 'review', 'reviewedAt');
  // Actual repair/supersession writers emit canonical strings before snapshotting. Decode
  // only those strings; a caller's numeric lookalike remains an original number.
  for (const field of ['lastRepairAttemptAt', 'nextRepairAttemptAt', 'repairedAt', 'supersededAt', 'sourceDetachedAt']) view = metadataClockView(view, undefined, field);
  return retainKnowledgeRepresentation(view, raw);
}
export function knowledgeSourceMetadataView(raw: Record<string, unknown>): Record<string, unknown> {
  return metadataClockView(raw, 'sourceDiscovery', 'searchedAt');
}
/** The search producer emits canonical data immediately, so intervening ingest
 * copies never need to infer provenance from a caller's numeric searchedAt. */
export function knowledgeSearchStamp<T extends Record<string, unknown>>(fields: T): T & { searchedAt: string } {
  return { ...fields, searchedAt: knowledgeClockIso(Date.now()) };
}
/** Source crawl clock minted here; this does not normalize an input clock. */
export function knowledgeSourceCrawledNow<T extends object>(input: T): T & { lastCrawledAt: number } {
  captureOwnedJson(input);
  if (Object.hasOwn(input, 'lastCrawledAt')) throw new TypeError('Owned crawl input must not supply lastCrawledAt');
  const view = { ...input, lastCrawledAt: Date.now() };
  return retainKnowledgeRepresentation(view, { ...knowledgeRawRepresentation(input), lastCrawledAt: knowledgeClockIso(view.lastCrawledAt) });
}

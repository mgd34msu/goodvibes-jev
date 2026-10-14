import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { snapshotJudgmentInput } from '@goodvibes-jev/engine/sdk/platform/gate';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { SOURCE_SCREENING_LIMITS } from '@goodvibes-jev/engine/sdk/platform/security';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { captureCatalogData } from '../../tools/agent-harness-catalog-ranking.ts';
import { captureModelReadingInput, captureModelReadingSnapshotGuard, assertModelReadingInputCurrent, withModelReadingSource } from '../../tools/agent-harness-model-reading-source.ts';
import { cleanupResearchScreeningFixtures, researchScreeningFixture } from '../helpers/research-screening.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => {
  const readings = fakePort((name, question) => {
    if (name === 'kind' && question.type === 'choice' && Object.hasOwn(question.criteria, 'owner_profile'))
      return choiceAnswer(question, 'other', 0.999);
    if (['lineHasCredential', 'spanIsCredential', 'credentialRemains', 'identifying'].includes(name) && question.type === 'noul')
      return noulAnswer(0.001);
    throw new Error('Unscripted complete-input question');
  });
  previous = installJudgmentPort(readings.port);
});
afterEach(async () => { await cleanupResearchScreeningFixtures(); installJudgmentPort(previous); });

test('many small fields retain every original path and value within native screening quotas', async () => {
  const source = { fields: Array.from({ length: 1_100 }, (_, index) => ({
    path: ['rows', String(index)], kind: 'text', parts: [{ kind: 'text', text: `Complete native row ${index}` }],
  })) };
  const parts: string[] = [];
  const screening = researchScreeningFixture({ beforeProposal: async proposal => {
    expect(proposal.parts.length).toBeLessThanOrEqual(SOURCE_SCREENING_LIMITS.parts);
    expect(proposal.parts.reduce((size, part) => size + part.length, 0)).toBeLessThanOrEqual(SOURCE_SCREENING_LIMITS.characters);
    parts.push(...proposal.parts);
  } });
  const result = await withModelReadingSource(source, { sourceOwner: screening.owner }, async captured => captured);
  expect(result).toEqual(source);
  const fragments: unknown[] = parts.flatMap(part => {
    const value: unknown = JSON.parse(part);
    return Array.isArray(value) ? value : [value];
  });
  expect(fragments).toEqual(source.fields.map((value, index) => ({ path: ['fields', String(index)], value })));
  expect(parts.length).toBeLessThan(SOURCE_SCREENING_LIMITS.sources);
});

/** Exact pre-fusion structural transform, retained only as the differential oracle. */
function originalReadingData<T>(value: T): T {
  const captured = captureCatalogData(value);
  // Complete source includes hidden data properties. JSON's enumerability
  // convention is not permission to omit a semantic field from screening.
  const copies = new WeakMap<object, object>();
  const enumerable = (entry: unknown): unknown => {
    if (entry === null || typeof entry !== 'object') return entry;
    const existing = copies.get(entry); if (existing) return existing;
    const array = Array.isArray(entry);
    const descriptors = Object.getOwnPropertyDescriptors(entry);
    if (array && (Object.keys(descriptors).length !== entry.length + 1 || Object.keys(descriptors).some(key => key !== 'length'
      && (!Number.isSafeInteger(Number(key)) || String(Number(key)) !== key || Number(key) < 0 || Number(key) >= entry.length))))
      throw new ToolInputProjectionError('invalid');
    const result: object = array ? new Array(entry.length) : Object.create(null) as object;
    copies.set(entry, result);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (array && key === 'length') continue;
      Object.defineProperty(result, key, { value: enumerable(descriptor.value), enumerable: true });
    }
    return Object.freeze(result);
  };
  const data = enumerable(captured);
  // Bound expanded JSON work as well as unique DAG nodes. An alias added during
  // a late mutation cannot make equality checking expand exponentially.
  let nodes = 0, characters = 0;
  const bound = (entry: unknown): void => {
    if (++nodes > 20_000) throw new ToolInputProjectionError('invalid');
    if (typeof entry === 'string') characters += entry.length;
    else if (entry !== null && typeof entry === 'object') for (const [key, child] of Object.entries(entry)) { characters += key.length; bound(child); }
    if (characters > 1_000_000) throw new ToolInputProjectionError('invalid');
  };
  bound(data);
  return data as T;
}


function originalReadingInput(value: unknown): unknown { return snapshotJudgmentInput(originalReadingData(value)); }
type CaptureOutcome = { readonly kind: 'accepted'; readonly value: unknown }
  | { readonly kind: 'held'; readonly name: string; readonly problem: unknown };
function outcome(read: (value: unknown) => unknown, value: unknown): CaptureOutcome {
  try { return { kind: 'accepted', value: read(value) }; }
  catch (error) {
    if (!(error instanceof Error)) throw error;
    return { kind: 'held', name: error.name, problem: error instanceof ToolInputProjectionError ? error.problem : undefined };
  }
}
function compare(value: unknown): CaptureOutcome {
  const old = outcome(originalReadingInput, value), fresh = outcome(captureModelReadingInput, value);
  expect(fresh).toEqual(old);
  return fresh;
}
function nested(levels: number): unknown {
  let value: unknown = 'Native leaf';
  for (let level = 0; level < levels; level++) value = { child: value };
  return value;
}
function aliased(levels: number): unknown {
  let value: unknown = { text: 'Native leaf' };
  for (let level = 0; level < levels; level++) value = { a: value, b: value, c: value, d: value };
  return value;
}

const accepted: readonly { readonly name: string; readonly value: () => unknown }[] = [
  { name: 'primitives', value: () => ({ string: 'Native text', number: 1.25, flag: true, empty: null }) },
  { name: 'null prototypes', value: () => Object.assign(Object.create(null), { text: 'Native text' }) },
  { name: 'hidden object fields', value: () => Object.defineProperty({ visible: 'Native visible' }, 'hidden', { value: { text: 'Native hidden' } }) },
  { name: 'hidden array indices', value: () => Object.defineProperty(['Native text'], '0', { value: 'Native text', enumerable: false }) },
  { name: 'shared descendants', value: () => { const shared = { text: 'Native text' }; return { left: shared, right: shared }; } },
  { name: 'equal separate descendants', value: () => ({ left: { text: 'Native text' }, right: { text: 'Native text' } }) },
  { name: 'maximum structural depth', value: () => nested(64) },
  { name: 'small expanded aliases', value: () => aliased(4) },
];
for (const entry of accepted) test(`fused complete capture preserves ${entry.name}`, () => {
  expect(compare(entry.value()).kind).toBe('accepted');
});

const refused: readonly { readonly name: string; readonly value: () => unknown }[] = [
  { name: 'hidden accessor', value: () => Object.defineProperty({ visible: 'Native text' }, 'hidden', { get() { throw new Error('Accessor invoked'); } }) },
  { name: 'proxy', value: () => new Proxy({ visible: 'Native text' }, { ownKeys() { throw new Error('Proxy invoked'); } }) },
  { name: 'symbol slot', value: () => Object.defineProperty({ text: 'Native text' }, Symbol('hidden'), { value: 'Hidden text' }) },
  { name: 'hidden function', value: () => Object.defineProperty({ text: 'Native text' }, 'hidden', { value: () => 'Native text' }) },
  { name: 'own serializer', value: () => ({ text: 'Native text', toJSON: () => ({ text: 'Different text' }) }) },
  { name: 'nonfinite primitive', value: () => ({ number: Number.POSITIVE_INFINITY }) },
  { name: 'unsupported prototype', value: () => Object.assign(Object.create({ inherited: 'Native data' }), { text: 'Native text' }) },
  { name: 'cycle', value: () => { const value: { child: unknown } = { child: null }; value.child = value; return value; } },
  { name: 'excess structural depth', value: () => nested(65) },
  { name: 'array constructor', value: () => Object.defineProperty(['Native text'], 'constructor', { value: Array }) },
  { name: 'array hole', value: () => new Array<unknown>(1) },
  { name: 'array noncanonical index', value: () => Object.defineProperty(['Native text'], '01', { value: 'Other text' }) },
  { name: 'array extra key replacing missing index', value: () => { const value = ['Native first', 'Native second']; Reflect.deleteProperty(value, '1'); Object.defineProperty(value, 'other', { value: 'Other text' }); return value; } },
  { name: 'unique node budget', value: () => Object.fromEntries(Array.from({ length: 100_000 }, (_, index) => [`n${index}`, null])) },
  { name: 'unique character budget', value: () => ({ text: 'x'.repeat(1_000_001) }) },
  { name: 'unique array-slot budget', value: () => Array.from({ length: 6 }, () => Array.from({ length: 20_000 }, () => null)) },
  { name: 'expanded alias-node budget', value: () => aliased(8) },
  { name: 'expanded alias-character budget', value: () => { const shared = { text: 'x'.repeat(600) }; return Array.from({ length: 3_000 }, () => shared); } },
  { name: 'hidden protected value', value: () => Object.defineProperty({ visible: 'Native text' }, 'hidden', { value: '4111111111111111' }) },
];
for (const entry of refused) test(`fused complete capture retains refusal for ${entry.name}`, () => {
  expect(compare(entry.value()).kind).toBe('held');
});

test('capture detaches the complete final tree without changing caller flags or aliases', () => {
  const shared = { text: 'Native hidden' }, source = { visible: shared };
  Object.defineProperty(source, 'hidden', { value: shared, enumerable: false, configurable: true });
  const old = originalReadingInput(source), fresh = captureModelReadingInput(source);
  expect<unknown>(fresh).toEqual(old);
  expect(Object.getOwnPropertyDescriptor(source, 'hidden')?.enumerable).toBe(false);
  expect(Object.isFrozen(source)).toBe(false); expect(Object.isFrozen(shared)).toBe(false);
  shared.text = 'Changed source';
  expect<unknown>(fresh).toEqual(old);
  expect(() => assertModelReadingInputCurrent(source, JSON.stringify(fresh))).toThrow();
  shared.text = 'Native hidden';
  expect(() => assertModelReadingInputCurrent(source, JSON.stringify(fresh))).not.toThrow();
});

test('one structural copy removes detached-tree descriptor traversal while complete privacy still runs', () => {
  const source = { catalog: Array.from({ length: 8 }, (_, index) => ({ name: `Native item ${index}`, data: { text: 'Native description' } })) };
  const nativeDescriptors = Object.getOwnPropertyDescriptors;
  let calls = 0;
  try {
    Object.getOwnPropertyDescriptors = value => { calls++; return nativeDescriptors(value); };
    const old = originalReadingInput(source), oldCalls = calls;
    calls = 0;
    const fresh = captureModelReadingInput(source), freshCalls = calls;
    expect<unknown>(fresh).toEqual(old);
    expect(freshCalls).toBeLessThan(oldCalls);
  } finally { Object.getOwnPropertyDescriptors = nativeDescriptors; }
});

test('fresh source guards observe a hidden mutation before screened data is consumed', async () => {
  const child = { text: 'Native hidden' }, source = { visible: 'Native visible' };
  Object.defineProperty(source, 'child', { value: child, enumerable: false });
  let consumed = false, callbacks = 0;
  const screening = researchScreeningFixture({ beforeProposal: async () => { child.text = 'Changed hidden'; } });
  await expect(withModelReadingSource(source, { sourceOwner: screening.owner, assertCurrent() { callbacks++; } }, async () => { consumed = true; }))
    .rejects.toThrow();
  expect(consumed).toBe(false); expect(callbacks).toBeGreaterThan(0); expect(screening.calls.length).toBeGreaterThan(0);
});

test('late accessors are refused without invocation and cancellation still prevents consumption', async () => {
  const child = { text: 'Native hidden' }, source = { child };
  let touched = 0, consumed = false;
  const screening = researchScreeningFixture({ beforeProposal: async () => {
    Object.defineProperty(child, 'text', { get() { touched++; return 'Native hidden'; } });
  } });
  await expect(withModelReadingSource(source, { sourceOwner: screening.owner }, async () => { consumed = true; })).rejects.toThrow();
  expect(touched).toBe(0); expect(consumed).toBe(false);
  const controller = new AbortController(), cancelled = researchScreeningFixture({ beforeProposal: async () => { controller.abort(); } });
  await expect(withModelReadingSource({ text: 'Native visible' }, { sourceOwner: cancelled.owner, signal: controller.signal }, async () => { consumed = true; })).rejects.toThrow();
  expect(consumed).toBe(false);
});


test('a replaced memo lookup cannot approve an altered complete model snapshot', () => {
  const guard = captureModelReadingSnapshotGuard({ text: 'Original model evidence' });
  const current = Object.freeze({ text: 'Changed model evidence' });
  const get = WeakMap.prototype.get;
  let dispatched = false;
  WeakMap.prototype.get = function () { dispatched = true; return { has: () => true }; };
  let failure: unknown;
  try { guard(current); } catch (error) { failure = error; }
  finally { WeakMap.prototype.get = get; }
  expect(failure).toBeInstanceOf(ToolInputProjectionError);
  expect(dispatched).toBe(false);
});

test('a forged frozen predicate cannot cache a mutable hidden model descendant', () => {
  const child = { text: 'Original hidden evidence' }, current = Object.freeze(Object.defineProperty({}, 'hidden', { value: child }));
  const guard = captureModelReadingSnapshotGuard(current), isFrozen = Object.isFrozen;
  Object.isFrozen = () => true;
  try {
    guard(current);
    child.text = 'Changed hidden evidence';
    expect(() => guard(current)).toThrow();
  } finally { Object.isFrozen = isFrozen; }
});
